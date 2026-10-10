import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zcodeCliEvidenceProfiles, zcodeCliLifecycle, zcodeCliWriter } from '../src/hosts/zcode-cli-writer';
import { fingerprintTree } from '../src/fingerprint';
import { createFrozenPackageSnapshot, createLifecyclePlanCoverage, createResolvedLifecyclePins } from '../src/lifecycle-runtime';
import { inventoryPackageSemantics } from '../src/semantic-inventory';
import type { PluginSource } from '../src/source';

const NATIVE = 'demo@plgnz-activation01';

function officialFake(path: string): void {
  writeFileSync(path, `#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const storage = process.env.ZCODE_STORAGE_DIR;
if (storage === undefined || storage.length === 0) throw new Error('ZCODE_STORAGE_DIR required');
const root = join(storage, 'cli');
const args = process.argv.slice(2);
mkdirSync(root, { recursive: true });
const logPath = join(root, 'cli-invocations.log');
const prior = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
writeFileSync(logPath, prior + args.join(' ') + String.fromCharCode(10));
const marketsPath = join(root, 'plugins', 'known_marketplaces.json');
const registryPath = join(root, 'plugins', 'installed_plugins.json');
const configPath = join(root, 'config.json');

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
if (args[0] === '--version') {
  console.log('0.16.9');
  process.exit(0);
}
if (args[0] === 'doctor' && args[1] === '--json') {
  console.log(JSON.stringify({ cli: { name: 'zcode', processName: 'zcode-cli' } }));
  process.exit(0);
}
if (args[0] === 'plugins' && args[1] === 'marketplace' && args[2] === 'add') {
  const marketPath = args[3];
  const manifest = JSON.parse(readFileSync(join(marketPath, 'marketplace.json'), 'utf8'));
  const markets = readJson(marketsPath, {});
  markets[manifest.name] = marketPath;
  writeJson(marketsPath, markets);
  process.exit(0);
}
if (args[0] === 'plugins' && args[1] === 'marketplace' && args[2] === 'update') {
  const markets = readJson(marketsPath, {});
  if (typeof markets[args[3]] !== 'string') process.exit(92);
  process.exit(0);
}
if (args[0] === 'plugins' && (args[1] === 'install' || args[1] === 'update')) {
  const id = args[2];
  const at = id.indexOf('@');
  const name = id.slice(0, at);
  const market = id.slice(at + 1);
  const markets = readJson(marketsPath, {});
  const marketPath = markets[market];
  if (typeof marketPath !== 'string') process.exit(93);
  if (args[1] === 'update' && existsSync(join(marketPath, 'FAIL_UPDATE'))) {
    console.error('plugin update failed');
    process.exit(1);
  }
  const plugin = join(marketPath, 'plugins', name);
  const manifest = JSON.parse(readFileSync(join(plugin, '.zcode-plugin', 'plugin.json'), 'utf8'));
  const version = manifest.version;
  const cache = join(root, 'plugins', 'cache', market, name, version.replaceAll('+', '-'));
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(dirname(cache), { recursive: true });
  cpSync(plugin, cache, { recursive: true });
  const registry = readJson(registryPath, { version: 1, plugins: [] });
  registry.plugins = registry.plugins.filter((row) => row.id !== id);
  registry.plugins.push({ id, name, marketplace: market, version, installPath: cache, scope: 'user' });
  writeJson(registryPath, registry);
  const config = readJson(configPath, { plugins: { enabledPlugins: {}, options: {} } });
  config.plugins.enabledPlugins[id] = true;
  writeJson(configPath, config);
  process.exit(0);
}
if (args[0] === 'plugins' && args[1] === 'uninstall') {
  const id = args[2];
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const row = registry.plugins.find((plugin) => plugin.id === id);
  registry.plugins = registry.plugins.filter((plugin) => plugin.id !== id);
  writeFileSync(registryPath, JSON.stringify(registry));
  if (typeof row?.installPath === 'string') rmSync(row.installPath, { recursive: true, force: true });
  if (!args.includes('--keep-data')) rmSync(join(root, 'plugins', 'data', id), { recursive: true, force: true });
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.plugins?.enabledPlugins?.[id];
    delete config.plugins?.options?.[id];
    writeFileSync(configPath, JSON.stringify(config));
  }
  process.exit(0);
}
process.exit(91);
`);
  chmodSync(path, 0o755);
}

function writePackage(root: string): void {
  mkdirSync(join(root, 'commands'), { recursive: true });
  mkdirSync(join(root, 'skills', 'manual'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), '{"name":"demo","version":"1.0.0","description":"Demo"}\n');
  writeFileSync(join(root, 'commands', 'report.md'), '---\ndescription: Report\nargument-hint: topic\n---\nReport $ARGUMENTS\n');
  writeFileSync(join(root, 'skills', 'manual', 'SKILL.md'), '---\nname: manual\ndescription: Manual\ndisable-model-invocation: true\n---\nSee [notes](notes.txt)\n');
  writeFileSync(join(root, 'skills', 'manual', 'notes.txt'), 'kept-notes\n');
}

async function withHome(run: (home: string, cliRoot: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'plgnz-zcode-activate-'));
  const cliRoot = join(home, '.zcode', 'cli');
  const binary = join(home, 'zcode');
  const keys = ['OPEN_PLUGIN_HOME', 'OPEN_PLUGIN_ZCODE_CLI_BIN', 'ZCODE_STORAGE_DIR'] as const;
  const prior = keys.map((key) => process.env[key]);
  const originalCwd = process.cwd();
  process.env.OPEN_PLUGIN_HOME = home;
  process.env.OPEN_PLUGIN_ZCODE_CLI_BIN = binary;
  process.env.ZCODE_STORAGE_DIR = join(home, '.zcode');
  try {
    process.chdir(home);
    mkdirSync(cliRoot, { recursive: true });
    officialFake(binary);
    await run(home, cliRoot);
  } finally {
    process.chdir(originalCwd);
    keys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
    rmSync(home, { recursive: true, force: true });
  }
}

async function activate(home: string, action: 'install' | 'update', operationId: string, attemptId: string) {
  const packageRoot = join(home, 'package');
  const target = { kind: 'zcode-cli', instance: 'default' } as const;
  const plugin: PluginSource = {
    name: 'demo',
    dir: packageRoot,
    version: '1.0.0',
    contentFingerprint: fingerprintTree(packageRoot),
  };
  const snapshot = createFrozenPackageSnapshot({
    operationId,
    attemptId,
    scopeId: 'scope-demo',
    target,
    action,
    packageName: 'demo',
    nativeId: NATIVE,
    sourceType: 'local',
    immutableRevision: 'local-demo-revision',
    snapshotRoot: packageRoot,
    packageRoot,
    relativePackagePath: '.',
    snapshotFingerprint: plugin.contentFingerprint ?? '',
    packageFingerprint: plugin.contentFingerprint ?? '',
    inventory: inventoryPackageSemantics(plugin),
  });
  const version = await zcodeCliLifecycle.probeVersion(target);
  const observed = await zcodeCliLifecycle.observeTarget(target);
  const nativeScope = await zcodeCliLifecycle.observeNativeMutationScope({
    targetObservation: observed,
    operation: action,
    packageName: 'demo',
    nativeId: NATIVE,
    sourceType: 'local',
  });
  const pins = createResolvedLifecyclePins([]);
  const nativeProjection = await zcodeCliLifecycle.observeNativeProjection({
    targetObservation: observed,
    operation: action,
    snapshot,
    pins,
  });
  const decision = zcodeCliLifecycle.decideRoute({
    target,
    operation: action,
    operationId,
    attemptId,
    scopeId: 'scope-demo',
    packageName: 'demo',
    nativeId: NATIVE,
    version,
    sourceType: 'local',
    targetObservation: observed,
    nativeScope,
    nativeProjection,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId: NATIVE,
      operationId,
      operation: action,
      mutationGroupId: `group-${operationId}`,
      authorization: action === 'install' ? 'planned-create' : 'observed-owned',
    }]),
    snapshot,
    pins,
  });
  if (decision.kind !== 'selected') throw new Error(`expected a selected ${action} route, got ${decision.kind}`);
  const staged = await zcodeCliLifecycle.stageActivation({ selection: decision, snapshot, pins });
  const directed = await zcodeCliLifecycle.applyLifecycleDirectives(staged);
  const pinned = await zcodeCliLifecycle.applyPins(directed);
  const prepared = await zcodeCliLifecycle.sealActivation(pinned);
  return { decision, prepared, packageRoot };
}

describe('ZCode CLI native activation', () => {
  test('installs a projected command and user-only skill, then reads the same bytes back', async () => {
    await withHome(async (home, cliRoot) => {
      const packageRoot = join(home, 'package');
      writePackage(packageRoot);
      const first = await activate(home, 'install', 'op-install-demo', 'attempt-install-demo');
      const profile = zcodeCliEvidenceProfiles.find((item) => item.route === 'native' && item.operations.includes('install'));
      expect(first.decision.route).toBe('native');
      expect(first.decision.evidenceId).toBe(profile?.evidenceId);
      expect(first.prepared.handle.expected.transition).toEqual({ requirement: 'restart', status: 'effective' });
      const applied = await zcodeCliLifecycle.apply(first.prepared);
      expect(applied.changed).toBe(true);
      const observation = await zcodeCliLifecycle.readback(first.prepared.handle);
      zcodeCliLifecycle.verify(first.prepared.handle, observation);

      const registry = JSON.parse(readFileSync(join(cliRoot, 'plugins', 'installed_plugins.json'), 'utf8'));
      const row = registry.plugins.find((item: { id: string }) => item.id === NATIVE);
      expect(row.version).toContain('+plgnz.');
      expect(row.installPath.includes(row.version.replaceAll('+', '-'))).toBe(true);
      expect(row.installPath.includes('+')).toBe(false);
      expect(existsSync(join(row.installPath, 'commands', 'demo', 'report.md'))).toBe(true);
      expect(readFileSync(join(row.installPath, 'commands', 'demo', 'report.md'), 'utf8')).toContain('$ARGUMENTS');
      expect(existsSync(join(row.installPath, 'skills', 'manual', 'SKILL.md'))).toBe(false);
      const manual = readFileSync(join(row.installPath, 'commands', 'demo', 'manual.md'), 'utf8');
      expect(manual).toContain('notes.txt');
      expect(manual).toContain('plgnz-resources');
      expect(existsSync(join(cliRoot, 'plgnz-resources', 'plgnz-activation01'))).toBe(true);

      const again = await activate(home, 'update', 'op-install-again', 'attempt-install-again');
      const repeat = await zcodeCliLifecycle.apply(again.prepared);
      expect(repeat.changed).toBe(false);
      zcodeCliLifecycle.verify(again.prepared.handle, await zcodeCliLifecycle.readback(again.prepared.handle));
    });
  });

  test('updates and rolls back without dropping retained plugin data', async () => {
    await withHome(async (home, cliRoot) => {
      const packageRoot = join(home, 'package');
      writePackage(packageRoot);
      const installed = await activate(home, 'install', 'op-install-demo', 'attempt-install-demo');
      await zcodeCliLifecycle.apply(installed.prepared);
      const data = join(cliRoot, 'plugins', 'data', NATIVE, 'session.txt');
      mkdirSync(join(cliRoot, 'plugins', 'data', NATIVE), { recursive: true });
      writeFileSync(data, 'kept-session\n');
      const configPath = join(cliRoot, 'config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.plugins.options[NATIVE] = { theme: 'kept' };
      writeFileSync(configPath, JSON.stringify(config));
      const before = JSON.parse(readFileSync(join(cliRoot, 'plugins', 'installed_plugins.json'), 'utf8'));
      const priorPath = before.plugins.find((item: { id: string }) => item.id === NATIVE).installPath as string;
      const priorCommand = readFileSync(join(priorPath, 'commands', 'demo', 'report.md'), 'utf8');

      writeFileSync(join(packageRoot, 'commands', 'report.md'), '---\ndescription: Report\nargument-hint: topic\n---\nReport $ARGUMENTS updated\n');
      const updated = await activate(home, 'update', 'op-update-demo', 'attempt-update-demo');
      const applied = await zcodeCliLifecycle.apply(updated.prepared);
      expect(applied.changed).toBe(true);
      zcodeCliLifecycle.verify(updated.prepared.handle, await zcodeCliLifecycle.readback(updated.prepared.handle));
      const after = JSON.parse(readFileSync(join(cliRoot, 'plugins', 'installed_plugins.json'), 'utf8'));
      const nextPath = after.plugins.find((item: { id: string }) => item.id === NATIVE).installPath as string;
      expect(nextPath === priorPath).toBe(false);
      expect(readFileSync(join(nextPath, 'commands', 'demo', 'report.md'), 'utf8')).toContain('updated');
      expect(readFileSync(data, 'utf8')).toBe('kept-session\n');
      expect(JSON.parse(readFileSync(configPath, 'utf8')).plugins.options[NATIVE]).toEqual({ theme: 'kept' });

      const rolled = await zcodeCliLifecycle.rollback(updated.prepared.handle);
      expect(rolled.changed).toBe(true);
      zcodeCliLifecycle.verifyRollback(updated.prepared.handle, await zcodeCliLifecycle.readback(updated.prepared.handle));
      expect(readFileSync(join(priorPath, 'commands', 'demo', 'report.md'), 'utf8')).toBe(priorCommand);
      expect(readFileSync(data, 'utf8')).toBe('kept-session\n');
      expect(JSON.parse(readFileSync(configPath, 'utf8')).plugins.options[NATIVE]).toEqual({ theme: 'kept' });

      await zcodeCliWriter.remove(NATIVE);
      expect(JSON.parse(readFileSync(join(cliRoot, 'plugins', 'installed_plugins.json'), 'utf8')).plugins.some((item: { id: string }) => item.id === NATIVE)).toBe(false);
      expect(readFileSync(data, 'utf8')).toBe('kept-session\n');
      expect(JSON.parse(readFileSync(configPath, 'utf8')).plugins.options[NATIVE]).toEqual({ theme: 'kept' });
      const uninstalls = readFileSync(join(cliRoot, 'cli-invocations.log'), 'utf8').split('\n').filter((line) => line.startsWith('plugins uninstall'));
      expect(uninstalls).toEqual([]);
    });
  });

  test('a failed update rolls back to the previous activation', async () => {
    await withHome(async (home) => {
      const packageRoot = join(home, 'package');
      writePackage(packageRoot);
      const installed = await activate(home, 'install', 'op-install-demo', 'attempt-install-demo');
      await zcodeCliLifecycle.apply(installed.prepared);
      writeFileSync(join(packageRoot, 'commands', 'report.md'), '---\ndescription: Report\nargument-hint: topic\n---\nReport $ARGUMENTS failed\n');
      const updated = await activate(home, 'update', 'op-update-fail', 'attempt-update-fail');
      writeFileSync(join(updated.prepared.stagingRoot, '..', '..', 'FAIL_UPDATE'), '1\n');
      let failure: Error | undefined;
      try {
        await zcodeCliLifecycle.apply(updated.prepared);
      } catch (error) {
        failure = error as Error;
      }
      expect(failure?.message ?? '').toContain('plugins update');
      await zcodeCliLifecycle.rollback(updated.prepared.handle);
      zcodeCliLifecycle.verifyRollback(updated.prepared.handle, await zcodeCliLifecycle.readback(updated.prepared.handle));
    });
  });
});
