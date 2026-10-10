import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

declare const TextDecoder: { new (): { decode(input?: Uint8Array): string } };
declare const TextEncoder: { new (): { encode(input?: string): Uint8Array } };

const repoRoot = join(import.meta.dir, '..');
const cli = join(repoRoot, 'bin', 'plugnz.mjs');

export const HOST_STORE_PATHS = {
  'claude-code': '.claude',
  codex: '.codex',
  cursor: '.cursor',
  dcode: '.deepagents',
  grok: '.grok',
  hermes: '.hermes',
  kimi: '.kimi-code',
  omp: '.omp',
  opencode: '.config/opencode',
  pi: '.pi/agent',
  'zcode-cli': '.zcode/cli',
} as const;

const BINARY_OVERRIDES = [
  'OPEN_PLUGIN_CLAUDE_CODE_BIN',
  'OPEN_PLUGIN_GROK_BIN',
  'OPEN_PLUGIN_KIMI_BIN',
  'OPEN_PLUGIN_ZCODE_CLI_BIN',
] as const;

const LOCKED_ENV = new Set([
  'HOME',
  'OPEN_PLUGIN_HOME',
  'OPEN_PLUGIN_CLAUDE_CODE_ROOT',
  'OPEN_PLUGIN_CODEX_HOME',
  'OPEN_PLUGIN_CURSOR_ROOT',
  'OPEN_PLUGIN_DCODE_ROOT',
  'OPEN_PLUGIN_GROK_ROOT',
  'OPEN_PLUGIN_HERMES_CONFIG_PATH',
  'OPEN_PLUGIN_HERMES_ROOT',
  'OPEN_PLUGIN_KIMI_ROOT',
  'OPEN_PLUGIN_OMP_ROOT',
  'OPEN_PLUGIN_OPENCODE_ROOT',
  'OPEN_PLUGIN_PI_ROOT',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'ZCODE_STORAGE_DIR',
  'PATH',
]);

export interface StateDocument {
  version: number;
  installs: Array<{ host: string; id: string; source: string; sourceSha: string; sourceDir?: string; pending?: 'install' | 'remove' }>;
}

export interface TreeSnapshot {
  directories: string[];
  files: Record<string, number[]>;
  symlinks: Record<string, string>;
}

export interface SnapshotChange {
  before: TreeSnapshot;
  after: TreeSnapshot;
}

export interface FakeNativeStep {
  /** Exact argument vector expected for this invocation. */
  args: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Absolute fixture paths to write before the process exits. */
  writes?: Record<string, string>;
  /** Write this text into every prepared lifecycle stage so readback bytes differ. */
  divergeStagedReadback?: string;
}

export interface FakeNativeInvocation {
  args: string[];
}

export interface FakeNative {
  path: string;
  invocations(): FakeNativeInvocation[];
  remainingSteps(): number;
}

export interface CliRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  state: { before?: number[]; after?: number[] };
  stores: Record<keyof typeof HOST_STORE_PATHS, SnapshotChange>;
  ambient: SnapshotChange;
  nativeInvocations: Record<string, FakeNativeInvocation[]>;
}

export interface RunOptions {
  /** Boundary controls such as fake native binary paths. Isolation paths are locked. */
  env?: Record<string, string>;
}

export interface LifecycleCliHarness {
  readonly root: string;
  readonly home: string;
  readonly ambientHome: string;
  writeHome(files: Record<string, string>): void;
  writeAmbient(files: Record<string, string>): void;
  source(name: string, files: Record<string, string>): string;
  storePath(host: keyof typeof HOST_STORE_PATHS): string;
  fakeNative(name: string, steps: FakeNativeStep[]): FakeNative;
  run(args: string[], options?: RunOptions): CliRunResult;
}

/** Decode exact captured bytes for a text assertion. */
export function bytesToText(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Encode a literal independently for an exact byte assertion. */
export function textToBytes(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

/** Snapshot every file byte plus directory and symlink shape below `root`. */
export function snapshotTree(root: string): TreeSnapshot {
  const snapshot: TreeSnapshot = { directories: [], files: {}, symlinks: {} };
  if (!existsSync(root)) return snapshot;

  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) snapshot.symlinks[relative] = readlinkSync(path);
      else if (stat.isDirectory()) {
        snapshot.directories.push(relative);
        walk(path, relative);
      } else if (stat.isFile()) snapshot.files[relative] = readBytes(path)!;
    }
  };

  walk(root, '');
  return snapshot;
}

class LifecycleCliHarnessImpl implements LifecycleCliHarness {
  readonly root: string;
  readonly home: string;
  readonly ambientHome: string;
  private readonly sources: string;
  private readonly fakeBin: string;
  private readonly fakeNatives = new Map<string, FakeNative>();

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'plgnz-lifecycle-cli-'));
    this.home = join(this.root, 'managed-home');
    this.ambientHome = join(this.root, 'ambient-home');
    this.sources = join(this.root, 'sources');
    this.fakeBin = join(this.root, 'fake-bin');
    for (const path of [this.home, this.ambientHome, this.sources, this.fakeBin]) mkdirSync(path, { recursive: true });
  }

  writeHome(files: Record<string, string>): void {
    writeTree(this.home, files);
  }

  writeAmbient(files: Record<string, string>): void {
    writeTree(this.ambientHome, files);
  }

  source(name: string, files: Record<string, string>): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(name)) throw new Error(`unsafe fixture source name: ${name}`);
    const root = join(this.sources, name);
    mkdirSync(root, { recursive: true });
    writeTree(root, files);
    return root;
  }

  storePath(host: keyof typeof HOST_STORE_PATHS): string {
    return join(this.home, HOST_STORE_PATHS[host]);
  }

  fakeNative(name: string, steps: FakeNativeStep[]): FakeNative {
    if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(name)) throw new Error(`unsafe fake native name: ${name}`);
    if (this.fakeNatives.has(name)) throw new Error(`fake native already exists: ${name}`);
    for (const step of steps) {
      for (const path of Object.keys(step.writes ?? {})) assertInside(this.root, path, 'fake native write');
    }

    const program = join(this.fakeBin, `${name}.mjs`);
    const binary = join(this.fakeBin, name);
    const scenario = join(this.fakeBin, `${name}.scenario.json`);
    const log = join(this.fakeBin, `${name}.invocations.json`);
    writeFileSync(scenario, JSON.stringify({ cursor: 0, steps }));
    writeFileSync(program, fakeNativeProgram(scenario, log));
    writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`);
    chmodSync(binary, 0o755);

    const fake: FakeNative = {
      path: binary,
      invocations: () => readJsonArray(log) as FakeNativeInvocation[],
      remainingSteps: () => {
        const value: unknown = JSON.parse(readFileSync(scenario, 'utf8'));
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`fake native scenario is not an object: ${scenario}`);
        const document = value as Record<string, unknown>;
        if (!Number.isInteger(document['cursor']) || !Array.isArray(document['steps'])) throw new Error(`fake native scenario is invalid: ${scenario}`);
        return document['steps'].length - (document['cursor'] as number);
      },
    };
    this.fakeNatives.set(name, fake);
    return fake;
  }

  run(args: string[], options: RunOptions = {}): CliRunResult {
    for (const key of Object.keys(options.env ?? {})) {
      if (LOCKED_ENV.has(key)) throw new Error(`lifecycle harness isolation variable is locked: ${key}`);
    }
    const storesBefore = this.storeSnapshots();
    const ambientBefore = snapshotTree(this.ambientHome);
    const stateBefore = readBytes(join(this.home, 'state.json'));
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...this.isolatedEnv(), ...options.env },
    });
    const storesAfter = this.storeSnapshots();
    const stateAfter = readBytes(join(this.home, 'state.json'));
    const stores = {} as Record<keyof typeof HOST_STORE_PATHS, SnapshotChange>;
    for (const host of Object.keys(HOST_STORE_PATHS) as Array<keyof typeof HOST_STORE_PATHS>) stores[host] = { before: storesBefore[host]!, after: storesAfter[host]! };
    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      state: { ...(stateBefore === undefined ? {} : { before: stateBefore }), ...(stateAfter === undefined ? {} : { after: stateAfter }) },
      stores,
      ambient: { before: ambientBefore, after: snapshotTree(this.ambientHome) },
      nativeInvocations: Object.fromEntries([...this.fakeNatives].map(([name, fake]) => [name, fake.invocations()])),
    };
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  private storeSnapshots(): Record<string, TreeSnapshot> {
    return Object.fromEntries(Object.entries(HOST_STORE_PATHS).map(([host, path]) => [host, snapshotTree(join(this.home, path))]));
  }

  private isolatedEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of BINARY_OVERRIDES) delete env[key];
    delete env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE'];
    return {
      ...env,
      HOME: this.ambientHome,
      PATH: `${this.fakeBin}:/usr/bin:/bin`,
      OPEN_PLUGIN_HOME: this.home,
      OPEN_PLUGIN_CLAUDE_CODE_ROOT: this.storePath('claude-code'),
      OPEN_PLUGIN_CODEX_HOME: this.storePath('codex'),
      OPEN_PLUGIN_CURSOR_ROOT: this.storePath('cursor'),
      OPEN_PLUGIN_DCODE_ROOT: this.storePath('dcode'),
      OPEN_PLUGIN_GROK_ROOT: this.storePath('grok'),
      OPEN_PLUGIN_HERMES_ROOT: this.storePath('hermes'),
      OPEN_PLUGIN_HERMES_CONFIG_PATH: join(this.storePath('hermes'), 'config.yaml'),
      OPEN_PLUGIN_KIMI_ROOT: this.storePath('kimi'),
      OPEN_PLUGIN_OMP_ROOT: this.storePath('omp'),
      OPEN_PLUGIN_OPENCODE_ROOT: this.storePath('opencode'),
      OPEN_PLUGIN_PI_ROOT: this.storePath('pi'),
      XDG_CACHE_HOME: join(this.home, '.cache'),
      XDG_CONFIG_HOME: join(this.home, '.config'),
      XDG_DATA_HOME: join(this.home, '.local', 'share'),
      ZCODE_STORAGE_DIR: join(this.home, '.zcode'),
    };
  }
}

/** Own one fixture root and remove it whether the callback succeeds or throws. */
export async function withLifecycleCliHarness<T>(run: (harness: LifecycleCliHarness) => T | Promise<T>): Promise<T> {
  const harness = new LifecycleCliHarnessImpl();
  try {
    return await run(harness);
  } finally {
    harness.cleanup();
  }
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = resolve(root, relative);
    assertInside(root, target, 'fixture file');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function assertInside(root: string, candidate: string, label: string): void {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target === base || !target.startsWith(`${base}/`)) throw new Error(`${label} escapes fixture root: ${candidate}`);
}

function readBytes(path: string): number[] | undefined {
  if (!existsSync(path)) return undefined;
  const read = readFileSync as unknown as (file: string) => Uint8Array;
  return [...read(path)];
}

function readJsonArray(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`fake native invocation log is not an array: ${path}`);
  return value;
}

function fakeNativeProgram(scenario: string, log: string): string {
  return String.raw`import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const scenarioPath = ${JSON.stringify(scenario)};
const logPath = ${JSON.stringify(log)};
const read = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const spec = read(scenarioPath, { cursor: 0, steps: [] });
const args = process.argv.slice(2);
const invocations = read(logPath, []);
invocations.push({ args });
writeFileSync(logPath, JSON.stringify(invocations));
const step = spec.steps[spec.cursor];
if (!step) {
  process.stderr.write('unexpected fake native invocation: ' + JSON.stringify(args) + '\n');
  process.exit(97);
}
spec.cursor += 1;
writeFileSync(scenarioPath, JSON.stringify(spec));
if (JSON.stringify(step.args) !== JSON.stringify(args)) {
  process.stderr.write('fake native expected ' + JSON.stringify(step.args) + ' but received ' + JSON.stringify(args) + '\n');
  process.exit(98);
}
for (const [path, content] of Object.entries(step.writes ?? {})) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
if (typeof step.divergeStagedReadback === 'string') {
  const root = process.env.OPEN_PLUGIN_CURSOR_ROOT;
  const prepare = root === undefined ? '' : join(root, 'plugins', '.plgnz-lifecycle', 'prepare');
  if (prepare !== '' && existsSync(prepare)) {
    for (const key of readdirSync(prepare)) {
      const stage = join(prepare, key, 'stage');
      if (!existsSync(stage)) continue;
      writeFileSync(join(stage, 'readback-extra.txt'), step.divergeStagedReadback);
    }
  }
}
if (step.stdout) process.stdout.write(step.stdout);
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.exitCode ?? 0);
`;
}
