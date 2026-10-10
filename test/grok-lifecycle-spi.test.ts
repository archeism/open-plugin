import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintTree } from '../src/fingerprint';
import { grok } from '../src/hosts/grok';
import { createGrokLifecycleAdapter } from '../src/hosts/grok-writer';
import type {
  FrozenPackageSnapshot,
  LifecycleHostAdapter,
  LifecycleTargetIdentity,
  PreparedActivationMutation,
} from '../src/lifecycle-host';
import {
  LifecycleHostPhaseError,
  createFrozenPackageSnapshot,
  createLifecyclePlanCoverage,
  createResolvedLifecyclePins,
} from '../src/lifecycle-runtime';
import type { PackageSemanticInventory } from '../src/semantic-inventory';
import { writeFiles } from './util';

const grokTarget: LifecycleTargetIdentity = { kind: 'grok', instance: 'default' };

function writeFakeGrok(root: string): string {
  const program = join(root, 'fake-grok.mjs');
  const binary = join(root, 'fake-grok');
  writeFileSync(program, String.raw`
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = join(process.env.HOME, '.grok');
const state = join(home, 'fake-marketplaces.json');
const registry = join(home, 'installed-plugins', 'registry.json');
const log = join(home, 'command-log.txt');
const read = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const write = (path, value) => { mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
mkdirSync(home, { recursive: true });
appendFileSync(log, process.argv.slice(2).join(' ') + '\n');
const markets = () => read(state, []);
const registryValue = () => read(registry, { version: 1, repos: {} });
const saveRegistry = value => write(registry, value);
const args = process.argv.slice(2);
if (args[0] === '--version') {
  const version = process.env.GROK_FAKE_VERSION ?? '1.0.41';
  if (version === 'unknown') process.exit(1);
  if (version === 'unparseable') { console.log('grok not-a-version'); process.exit(0); }
  console.log('grok ' + version + ' (' + (process.env.GROK_FAKE_BUILD ?? 'fixturebuild') + ')');
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'validate') {
  const source = args[2];
  const name = source.split('/').filter(Boolean).at(-1);
  const value = registryValue();
  const current = name === undefined ? undefined : value.repos[name];
  const occupied = current && current.plugins && Object.keys(current.plugins).length > 0;
  if (name && !occupied) {
    value.repos[name] = { path: join(home, 'installed-plugins', 'cache', name), plugins: {}, kind: { type: 'Local', source_path: source } };
    saveRegistry(value);
  }
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list') { console.log(JSON.stringify(markets())); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') { const root = args[3]; write(state, [...markets(), { name: root.split('/').at(-1), kind: 'local', source: { path: root } }]); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') { const root = args[3]; write(state, markets().filter(row => row.source.path !== root)); const value = registryValue(); for (const [key, repo] of Object.entries(value.repos)) if (repo.marketplace?.source_url_or_path === root) delete value.repos[key]; saveRegistry(value); process.exit(0); }
const install = name => { const row = markets().find(item => item.name === args[2].split('@local/')[1]); if (!row) process.exit(2); const source = join(row.source.path, 'plugins', name); if (!existsSync(source)) process.exit(3); const value = registryValue(); const prior = value.repos[name]; const target = typeof prior?.path === 'string' ? prior.path : join(home, 'installed-plugins', 'cache', name); rmSync(target, { recursive: true, force: true }); cpSync(source, target, { recursive: true }); value.repos[name] = { path: target, plugins: { [name]: {} }, kind: { type: 'Local', source_path: source }, marketplace: { source_url_or_path: row.source.path, source_display_name: row.name, plugin_subdir: 'plugins/' + name } }; saveRegistry(value); };
if (args[0] === 'plugin' && args[1] === 'install') { install(args[2].split('@')[0]); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'update') {
  const value = registryValue();
  const repo = value.repos[args[2]];
  if (!repo || !existsSync(repo.kind.source_path)) process.exit(4);
  rmSync(repo.path, { recursive: true, force: true });
  cpSync(repo.kind.source_path, repo.path, { recursive: true });
  saveRegistry(value);
  if (process.env.GROK_FAKE_FAIL_AFTER_WRITE === '1') process.exit(1);
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'enable') process.exit(0);
if (args[0] === 'inspect' && args[1] === '--json') {
  if (process.env.GROK_FAKE_FAIL_INSPECT === '1') { console.log(JSON.stringify({ plugins: [] })); process.exit(0); }
  const value = registryValue();
  console.log(JSON.stringify({ plugins: Object.entries(value.repos).filter(([, repo]) => repo.plugins && Object.keys(repo.plugins).length > 0).map(([name, repo]) => ({ name, path: repo.path, enabled: true })) }));
  process.exit(0);
}
process.exit(9);
`);
  writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`);
  chmodSync(binary, 0o755);
  return binary;
}

function isolated<T>(run: (home: string, root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-grok-spi-'));
  const home = join(root, 'home');
  const previous = {
    OPEN_PLUGIN_HOME: process.env.OPEN_PLUGIN_HOME,
    OPEN_PLUGIN_GROK_ROOT: process.env.OPEN_PLUGIN_GROK_ROOT,
    OPEN_PLUGIN_GROK_BIN: process.env.OPEN_PLUGIN_GROK_BIN,
    GROK_FAKE_VERSION: process.env.GROK_FAKE_VERSION,
    GROK_FAKE_BUILD: process.env.GROK_FAKE_BUILD,
    GROK_FAKE_FAIL_AFTER_WRITE: process.env.GROK_FAKE_FAIL_AFTER_WRITE,
    GROK_FAKE_FAIL_INSPECT: process.env.GROK_FAKE_FAIL_INSPECT,
  };
  process.env.OPEN_PLUGIN_HOME = home;
  process.env.OPEN_PLUGIN_GROK_ROOT = join(home, '.grok');
  process.env.OPEN_PLUGIN_GROK_BIN = writeFakeGrok(root);
  process.env.GROK_FAKE_VERSION = '1.0.41';
  process.env.GROK_FAKE_BUILD = 'fixturebuild';
  delete process.env.GROK_FAKE_FAIL_AFTER_WRITE;
  delete process.env.GROK_FAKE_FAIL_INSPECT;
  return run(home, root).finally(() => {
    for (const [key, prior] of Object.entries(previous)) {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    rmSync(root, { recursive: true, force: true });
  });
}

function inventory(packageName: string, packageFingerprint: string): PackageSemanticInventory {
  return {
    schemaVersion: 1,
    package: { name: packageName, version: '1.0.0', fingerprint: packageFingerprint },
    components: { skills: [], mcp: [], hooks: [], commands: [], agents: [], resources: [], permissionsPreprocessing: [] },
    componentDefinitions: [],
    invocationPolicies: [],
    componentInvocationPolicies: [],
    autoUpdate: [],
    manifestPaths: [],
    hookDeclarations: [],
    requiredSemantics: [],
  };
}

function snapshot(root: string, input: {
  operationId: string;
  attemptId: string;
  action: 'install' | 'update';
  bytes: string;
}): FrozenPackageSnapshot & { readonly action: 'install' | 'update' } {
  const snapshotRoot = join(root, input.attemptId);
  const packageRoot = join(snapshotRoot, 'demo');
  writeFiles(packageRoot, {
    'plugin.json': '{"name":"demo","version":"1.0.0","description":"Demo"}\n',
    'resources/value.txt': input.bytes,
  });
  const packageFingerprint = fingerprintTree(packageRoot);
  return createFrozenPackageSnapshot({
    operationId: input.operationId,
    attemptId: input.attemptId,
    scopeId: 'scope-demo',
    target: grokTarget,
    action: input.action,
    packageName: 'demo',
    nativeId: 'demo@catalog',
    sourceType: 'local',
    immutableRevision: `revision-${input.attemptId}`,
    snapshotRoot,
    packageRoot,
    relativePackagePath: 'demo',
    snapshotFingerprint: fingerprintTree(snapshotRoot),
    packageFingerprint,
    inventory: inventory('demo', packageFingerprint),
  }) as FrozenPackageSnapshot & { readonly action: 'install' | 'update' };
}

async function prepare(
  adapter: LifecycleHostAdapter,
  packaged: FrozenPackageSnapshot & { readonly action: 'install' | 'update' },
): Promise<PreparedActivationMutation> {
  const operation = packaged.action === 'install' ? 'install' : 'update';
  const version = await adapter.probeVersion(grokTarget);
  const observed = await adapter.observeTarget(grokTarget);
  const pins = createResolvedLifecyclePins([]);
  const nativeScope = await adapter.observeNativeMutationScope({
    targetObservation: observed,
    operation,
    packageName: packaged.packageName,
    nativeId: packaged.nativeId,
    sourceType: packaged.sourceType,
  });
  const nativeProjection = await adapter.observeNativeProjection({
    targetObservation: observed,
    operation,
    snapshot: packaged,
    pins,
  });
  const existing = observed.installations.find((item) => item.nativeId === packaged.nativeId);
  const decision = adapter.decideRoute({
    target: grokTarget,
    operationId: packaged.operationId,
    attemptId: packaged.attemptId,
    scopeId: packaged.scopeId,
    packageName: packaged.packageName,
    nativeId: packaged.nativeId,
    version,
    sourceType: packaged.sourceType,
    targetObservation: observed,
    nativeScope,
    nativeProjection,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId: packaged.nativeId,
      operationId: packaged.operationId,
      operation,
      mutationGroupId: `group:${packaged.operationId}`,
      authorization: existing?.ownership.kind === 'owned' ? 'observed-owned' : 'planned-create',
    }]),
    snapshot: packaged,
    pins,
    operation,
  });
  if (decision.kind !== 'selected' || decision.route !== 'native') {
    throw new Error(`expected a native ${operation} route`);
  }
  const staged = await adapter.stageActivation({ selection: decision, snapshot: packaged, pins });
  const directed = await adapter.applyLifecycleDirectives(staged);
  const pinned = await adapter.applyPins(directed);
  return adapter.sealActivation(pinned);
}

function registryDocument(home: string): { repos: Record<string, { path?: string; note?: string; plugins?: Record<string, unknown> }> } {
  return JSON.parse(readFileSync(join(home, '.grok', 'installed-plugins', 'registry.json'), 'utf8')) as { repos: Record<string, { path?: string; note?: string; plugins?: Record<string, unknown> }> };
}

function registryInstallPath(home: string, name: string): string {
  const path = registryDocument(home).repos[name]?.path;
  if (path === undefined) throw new Error(`missing registry path for ${name}`);
  return path;
}

function marketplaceRoot(home: string): string {
  const rows = JSON.parse(readFileSync(join(home, '.grok', 'fake-marketplaces.json'), 'utf8')) as Array<{ source: { path: string } }>;
  const path = rows[0]?.source.path;
  if (path === undefined) throw new Error('missing marketplace');
  return path;
}

function stageNames(home: string): string[] {
  const root = join(home, '.grok', 'plgnz-marketplaces');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith('.plgnz-grok-stage-'));
}

async function failure(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Grok lifecycle SPI', () => {
  test('reads the grok binary version and rolls a failed native update back without another route', async () => {
    await isolated(async (home, root) => {
      const adapter = createGrokLifecycleAdapter();
      expect(await adapter.probeVersion(grokTarget)).toEqual({
        kind: 'detected',
        version: '1.0.41',
        probeId: 'grok:1.0.41:fixturebuild',
      });
      process.env.GROK_FAKE_VERSION = '1.0.24';
      process.env.GROK_FAKE_BUILD = 'olderbuild';
      expect(await adapter.probeVersion(grokTarget)).toEqual({
        kind: 'detected',
        version: '1.0.24',
        probeId: 'grok:1.0.24:olderbuild',
      });
      process.env.GROK_FAKE_VERSION = 'unparseable';
      expect(await adapter.probeVersion(grokTarget)).toEqual({ kind: 'unparseable' });
      process.env.GROK_FAKE_VERSION = 'unknown';
      expect(await adapter.probeVersion(grokTarget)).toEqual({ kind: 'unknown' });

      process.env.GROK_FAKE_VERSION = '1.0.41';
      process.env.GROK_FAKE_BUILD = 'fixturebuild';
      const installed = await prepare(adapter, snapshot(root, {
        operationId: 'op-install',
        attemptId: 'attempt-install',
        action: 'install',
        bytes: 'one\n',
      }));
      expect(installed.handle.route).toBe('native');
      expect(installed.handle.detectedVersion).toBe('1.0.41');
      await adapter.apply(installed);
      const registryPath = registryInstallPath(home, 'demo');
      expect(registryPath.endsWith('/cache/demo')).toBe(true);
      const active = join(registryPath, 'resources', 'value.txt');
      expect(readFileSync(active, 'utf8')).toBe('one\n');
      const installedReadback = await adapter.readback(installed.handle);
      adapter.verify(installed.handle, installedReadback);
      expect(installedReadback.contentRoots[0]?.path).toBe(registryPath);
      expect(installedReadback.transition).toEqual({ requirement: 'reload', status: 'effective' });
      expect(readFileSync(join(home, '.grok', 'config.toml'), 'utf8')).toContain('plugin_auto_update = false');
      expect(existsSync(join(marketplaceRoot(home), '.plgnz-lifecycle.json'))).toBe(false);
      expect(stageNames(home)).toEqual([]);
      const inspect = spawnSync(process.env.OPEN_PLUGIN_GROK_BIN ?? '', ['inspect', '--json'], {
        env: { ...process.env, HOME: home, GROK_HOME: join(home, '.grok') },
        encoding: 'utf8',
      });
      expect(inspect.status).toBe(0);
      expect(JSON.parse(inspect.stdout)).toEqual({
        plugins: [{ name: 'demo', path: registryPath, enabled: true }],
      });

      const marker = join(marketplaceRoot(home), '.plgnz-install.json');
      const markerBefore = readFileSync(marker, 'utf8');
      const sibling = join(home, '.grok', 'installed-plugins', 'other-native');
      writeFiles(sibling, { 'keep.txt': 'sibling\n' });
      const beforeUpdate = registryDocument(home);
      beforeUpdate.repos.other = { path: sibling, note: 'before', plugins: { other: {} } };
      writeFileSync(join(home, '.grok', 'installed-plugins', 'registry.json'), JSON.stringify({ version: 1, repos: beforeUpdate.repos }));
      const logBefore = readFileSync(join(home, '.grok', 'command-log.txt'), 'utf8');
      process.env.GROK_FAKE_FAIL_AFTER_WRITE = '1';
      const update = await prepare(adapter, snapshot(root, {
        operationId: 'op-update',
        attemptId: 'attempt-update',
        action: 'update',
        bytes: 'two\n',
      }));
      const duringUpdate = registryDocument(home);
      duringUpdate.repos.other = { ...duringUpdate.repos.other, note: 'after' };
      writeFileSync(join(home, '.grok', 'installed-plugins', 'registry.json'), JSON.stringify({ version: 1, repos: duringUpdate.repos }));
      const error = await failure(adapter.apply(update));
      expect(error instanceof LifecycleHostPhaseError).toBe(true);
      if (!(error instanceof LifecycleHostPhaseError)) return;
      expect(error.phase).toBe('apply');
      expect(error.mutationStarted).toBe(true);
      expect(readFileSync(active, 'utf8')).toBe('two\n');
      delete process.env.GROK_FAKE_FAIL_AFTER_WRITE;
      await adapter.rollback(update.handle);
      adapter.verifyRollback(update.handle, await adapter.readback(update.handle));
      expect(readFileSync(active, 'utf8')).toBe('one\n');
      expect(readFileSync(marker, 'utf8')).toBe(markerBefore);
      const added = readFileSync(join(home, '.grok', 'command-log.txt'), 'utf8').slice(logBefore.length);
      expect(added).toContain('plugin update demo');
      expect(added.includes('plugin install')).toBe(false);
      expect(registryDocument(home).repos.other?.note).toBe('after');
      expect(grok.listInstalled().map((plugin) => plugin.id).sort()).toEqual(['demo@catalog', 'other']);
      expect(stageNames(home)).toEqual([]);
    });
  });

  test('rolls a failed fresh install back to an absent plugin', async () => {
    await isolated(async (home, root) => {
      const sibling = join(home, '.grok', 'installed-plugins', 'other-native');
      writeFiles(sibling, { 'keep.txt': 'sibling\n' });
      writeFiles(join(home, '.grok'), {
        'config.toml': '[plugins]\ndisabled = ["kept"]\n',
        'installed-plugins/registry.json': JSON.stringify({
          version: 1,
          repos: { other: { path: sibling, note: 'before', plugins: { other: {} }, kind: { type: 'Local', source_path: sibling } } },
        }),
      });
      const adapter = createGrokLifecycleAdapter();
      const prepared = await prepare(adapter, snapshot(root, {
        operationId: 'op-fresh',
        attemptId: 'attempt-fresh',
        action: 'install',
        bytes: 'fresh\n',
      }));
      const during = registryDocument(home);
      during.repos.other = { ...during.repos.other, note: 'after' };
      writeFileSync(join(home, '.grok', 'installed-plugins', 'registry.json'), JSON.stringify({ version: 1, repos: during.repos }));
      const logBefore = readFileSync(join(home, '.grok', 'command-log.txt'), 'utf8');
      process.env.GROK_FAKE_FAIL_INSPECT = '1';
      const error = await failure(adapter.apply(prepared));
      expect(error instanceof LifecycleHostPhaseError).toBe(true);
      if (!(error instanceof LifecycleHostPhaseError)) return;
      expect(error.phase).toBe('apply');
      expect(error.mutationStarted).toBe(true);
      const cache = registryInstallPath(home, 'demo');
      expect(readFileSync(join(cache, 'resources', 'value.txt'), 'utf8')).toBe('fresh\n');
      expect(existsSync(join(home, '.grok', 'plugins', 'demo'))).toBe(true);
      expect(JSON.parse(readFileSync(join(home, '.grok', 'fake-marketplaces.json'), 'utf8'))).toHaveLength(1);
      delete process.env.GROK_FAKE_FAIL_INSPECT;
      await adapter.rollback(prepared.handle);
      adapter.verifyRollback(prepared.handle, await adapter.readback(prepared.handle));
      expect(existsSync(cache)).toBe(false);
      expect(existsSync(join(home, '.grok', 'plugins', 'demo'))).toBe(false);
      expect(JSON.parse(readFileSync(join(home, '.grok', 'fake-marketplaces.json'), 'utf8'))).toEqual([]);
      expect(registryDocument(home).repos.demo).toBeUndefined();
      expect(registryDocument(home).repos.other?.note).toBe('after');
      expect(grok.listInstalled().map((plugin) => plugin.id)).toEqual(['other']);
      const inspect = spawnSync(process.env.OPEN_PLUGIN_GROK_BIN ?? '', ['inspect', '--json'], {
        env: { ...process.env, HOME: home, GROK_HOME: join(home, '.grok') },
        encoding: 'utf8',
      });
      expect(JSON.parse(inspect.stdout)).toEqual({ plugins: [{ name: 'other', path: sibling, enabled: true }] });
      const added = readFileSync(join(home, '.grok', 'command-log.txt'), 'utf8').slice(logBefore.length);
      expect(added).toContain('plugin marketplace remove');
      expect(added.includes('plugin update')).toBe(false);
      expect(added.includes('plugin install')).toBe(true);
      expect(stageNames(home)).toEqual([]);
      const config = readFileSync(join(home, '.grok', 'config.toml'), 'utf8');
      expect(config).toContain('plugin_auto_update = false');
      expect(config).toContain('disabled = ["kept"]');
    });
  });

  test('leaves a stale direct-local install unmanaged and unchanged', async () => {
    await isolated(async (home, root) => {
      const installed = join(home, '.grok', 'installed-plugins', 'legacy-demo');
      const source = join(root, 'legacy-source');
      writeFiles(installed, {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
        'resources/value.txt': 'stale-installed\n',
      });
      writeFiles(source, {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
        'resources/value.txt': 'stale-source\n',
      });
      writeFiles(join(home, '.grok'), {
        'installed-plugins/registry.json': JSON.stringify({
          version: 1,
          repos: {
            demo: {
              path: installed,
              plugins: { demo: {} },
              kind: { type: 'Local', source_path: source },
            },
          },
        }),
      });
      const adapter = createGrokLifecycleAdapter();
      const observed = await adapter.observeTarget(grokTarget);
      expect(observed.installations.map((item) => ({ nativeId: item.nativeId, ownership: item.ownership.kind }))).toEqual([
        { nativeId: 'demo', ownership: 'unmanaged' },
      ]);
      const prepared = await prepare(adapter, snapshot(root, {
        operationId: 'op-stale',
        attemptId: 'attempt-stale',
        action: 'install',
        bytes: 'fresh\n',
      }));
      const error = await failure(adapter.apply(prepared));
      expect(error instanceof LifecycleHostPhaseError).toBe(true);
      expect(readFileSync(join(installed, 'resources', 'value.txt'), 'utf8')).toBe('stale-installed\n');
      expect(readFileSync(join(source, 'resources', 'value.txt'), 'utf8')).toBe('stale-source\n');
      expect(grok.listInstalled().map((plugin) => plugin.id)).toEqual(['demo']);
      expect(readFileSync(join(home, '.grok', 'command-log.txt'), 'utf8').includes('plugin install')).toBe(false);
    });
  });
});
