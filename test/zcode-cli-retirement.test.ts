import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifecyclePlanCoverage, createRecordedOwnedActivation } from '../src/lifecycle-runtime';
import { zcodeCliEvidenceProfiles, zcodeCliLifecycle } from '../src/hosts/zcode-cli-writer';

const DEMO = 'demo@plgnz-0123456789abcdef';
const SCRATCH = 'scratch@plgnz-fedcba9876543210';

/**
 * Official ZCode 872ad960 uninstall deletes plugins/data/<id> unless --keep-data,
 * and removePluginFromFileConfig always deletes plugins.options[id].
 */
function officialFake(path: string): void {
  writeFileSync(path, `#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const storage = process.env.ZCODE_STORAGE_DIR;
if (storage === undefined || storage.length === 0) throw new Error('ZCODE_STORAGE_DIR required');
const root = join(storage, 'cli');
const args = process.argv.slice(2);
mkdirSync(root, { recursive: true });
const logPath = join(root, 'cli-invocations.log');
const prior = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
writeFileSync(logPath, prior + args.join(' ') + String.fromCharCode(10));
if (args[0] === '--version') {
  console.log('0.16.9');
  process.exit(0);
}
if (args[0] === 'doctor' && args[1] === '--json') {
  console.log(JSON.stringify({ cli: { name: 'zcode', processName: 'zcode-cli' } }));
  process.exit(0);
}
if (args[0] === 'plugins' && args[1] === 'uninstall') {
  const id = args[2];
  if (id === undefined) process.exit(91);
  const keepData = args.includes('--keep-data');
  const registryPath = join(root, 'plugins', 'installed_plugins.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const row = registry.plugins.find((plugin) => plugin.id === id);
  registry.plugins = registry.plugins.filter((plugin) => plugin.id !== id);
  writeFileSync(registryPath, JSON.stringify(registry));
  if (typeof row?.installPath === 'string') rmSync(row.installPath, { recursive: true, force: true });
  if (!keepData) rmSync(join(root, 'plugins', 'data', id), { recursive: true, force: true });
  const configPath = join(root, 'config.json');
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

function seedPlugin(cliRoot: string, id: string, marketplace: string, session: string, theme: string): void {
  const installPath = join(cliRoot, 'plugins', 'cache', marketplace, 'demo', '1.0.0');
  mkdirSync(installPath, { recursive: true });
  writeFileSync(join(installPath, 'plugin.json'), '{"name":"demo","version":"1.0.0"}\n');
  writeFileSync(join(installPath, '.plgnz-install.json'), `${JSON.stringify({
    owner: 'plgnz',
    schema: 1,
    logicalId: 'demo@personal',
    nativeId: id,
    fingerprint: 'b'.repeat(64),
    source: '/fixture/source',
  })}\n`);
  const dataDir = join(cliRoot, 'plugins', 'data', id);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'session.txt'), session);
  const configPath = join(cliRoot, 'config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : { plugins: { enabledPlugins: {}, options: {} } };
  config.plugins.enabledPlugins[id] = true;
  config.plugins.options[id] = { theme };
  writeFileSync(configPath, JSON.stringify(config));
  const registryPath = join(cliRoot, 'plugins', 'installed_plugins.json');
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : { version: 1, plugins: [] };
  registry.plugins.push({ id, name: 'demo', marketplace, version: '1.0.0', installPath, scope: 'user' });
  writeFileSync(registryPath, JSON.stringify(registry));
}

describe('ZCode CLI retirement route', () => {
  test('native uninstall that drops retained state is not selected, and Managed retirement keeps it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'plgnz-zcode-retire-'));
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
      seedPlugin(cliRoot, DEMO, 'plgnz-0123456789abcdef', 'kept-session\n', 'kept');
      seedPlugin(cliRoot, SCRATCH, 'plgnz-fedcba9876543210', 'scratch-session\n', 'scratch');
      const scratchData = join(cliRoot, 'plugins', 'data', SCRATCH, 'session.txt');
      const demoData = join(cliRoot, 'plugins', 'data', DEMO, 'session.txt');
      expect(readFileSync(scratchData, 'utf8')).toBe('scratch-session\n');

      const uninstall = spawnSync(binary, ['plugins', 'uninstall', SCRATCH, '--force'], {
        env: { ...process.env, HOME: home, ZCODE_STORAGE_DIR: join(home, '.zcode') },
        encoding: 'utf8',
      });
      expect(uninstall.status).toBe(0);
      expect(existsSync(scratchData)).toBe(false);
      const afterNative = JSON.parse(readFileSync(join(cliRoot, 'config.json'), 'utf8'));
      expect(afterNative.plugins.options[SCRATCH]).toBeUndefined();
      expect(afterNative.plugins.options[DEMO]).toEqual({ theme: 'kept' });
      expect(readFileSync(demoData, 'utf8')).toBe('kept-session\n');

      const target = { kind: 'zcode-cli', instance: 'default' } as const;
      const version = await zcodeCliLifecycle.probeVersion(target);
      const observed = await zcodeCliLifecycle.observeTarget(target);
      const installation = observed.installations.find((row) => row.nativeId === DEMO);
      if (installation === undefined || installation.ownership.kind !== 'owned' || installation.installedFingerprint === null || installation.installedVersion === null) {
        throw new Error('seeded ZCode install was not observed as an owned present activation');
      }
      const operationId = 'op-retire-demo';
      const attemptId = 'attempt-retire-demo';
      const activation = createRecordedOwnedActivation({
        scopeId: 'scope-demo',
        target,
        packageName: 'demo',
        nativeId: DEMO,
        sourceType: 'local',
        sourceRevision: 'local-demo-revision',
        sourceLocator: null,
        installedVersion: installation.installedVersion,
        route: 'native',
        evidenceId: 'seed-evidence',
        ownership: { kind: 'created', proofId: installation.ownership.proofId },
        activation: 'active',
        enablement: 'enabled',
        installedFingerprint: installation.installedFingerprint,
        contentRoots: installation.contentRoots,
      });
      const nativeScope = await zcodeCliLifecycle.observeNativeMutationScope({
        targetObservation: observed,
        operation: 'retire',
        packageName: 'demo',
        nativeId: DEMO,
        sourceType: 'local',
      });
      const nativeProjection = await zcodeCliLifecycle.observeNativeProjection({
        targetObservation: observed,
        operation: 'retire',
        operationId,
        attemptId,
        activation,
      });
      const decision = zcodeCliLifecycle.decideRoute({
        target,
        operation: 'retire',
        operationId,
        attemptId,
        scopeId: 'scope-demo',
        packageName: 'demo',
        nativeId: DEMO,
        version,
        sourceType: 'local',
        targetObservation: observed,
        nativeScope,
        nativeProjection,
        planCoverage: createLifecyclePlanCoverage(observed, [{
          nativeId: DEMO,
          operationId,
          operation: 'retire',
          mutationGroupId: 'group-retire-demo',
          authorization: 'observed-owned',
        }]),
        activation,
      });
      expect(decision.kind).toBe('selected');
      if (decision.kind !== 'selected') return;
      const managed = zcodeCliEvidenceProfiles.find((profile) => profile.route === 'managed' && profile.operations.includes('retire'));
      const native = zcodeCliEvidenceProfiles.find((profile) => profile.route === 'native' && profile.operations.includes('retire'));
      expect(decision.route).toBe('managed');
      expect(decision.detectedVersion).toBe('0.16.9');
      expect(decision.evidenceId).toBe(managed?.evidenceId);
      expect(native?.operationStatus).toBe('unsupported');
      expect(native?.semantics['activation-reload']).toBe('unsupported');
      expect(managed?.semantics['activation-reload']).toBe('supported');

      const prepared = await zcodeCliLifecycle.prepareRetirement({
        operationId,
        attemptId,
        action: 'remove',
        selection: decision,
        activation,
      });
      await zcodeCliLifecycle.retire(prepared);
      const observation = await zcodeCliLifecycle.readback(prepared.handle);
      zcodeCliLifecycle.verify(prepared.handle, observation);

      expect(readFileSync(demoData, 'utf8')).toBe('kept-session\n');
      const afterManaged = JSON.parse(readFileSync(join(cliRoot, 'config.json'), 'utf8'));
      expect(afterManaged.plugins.options[DEMO]).toEqual({ theme: 'kept' });
      expect(afterManaged.plugins.enabledPlugins[DEMO]).toBeUndefined();
      const registry = JSON.parse(readFileSync(join(cliRoot, 'plugins', 'installed_plugins.json'), 'utf8'));
      expect(registry.plugins.some((row: { id: string }) => row.id === DEMO)).toBe(false);
      expect(existsSync(installation.contentRoots[0]?.path ?? '')).toBe(false);
      const log = readFileSync(join(cliRoot, 'cli-invocations.log'), 'utf8');
      const uninstalls = log.split('\n').filter((line) => line.startsWith('plugins uninstall'));
      expect(uninstalls).toEqual([`plugins uninstall ${SCRATCH} --force`]);
    } finally {
      process.chdir(originalCwd);
      keys.forEach((key, index) => {
        if (prior[index] === undefined) delete process.env[key];
        else process.env[key] = prior[index];
      });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

const OTHER = 'other@plgnz-aaaaaaaaaaaaaaaa';

async function withLinkedHome(run: (home: string, cliRoot: string) => Promise<void>): Promise<void> {
  const real = mkdtempSync(join(tmpdir(), 'plgnz-zcode-real-'));
  const linkParent = mkdtempSync(join(tmpdir(), 'plgnz-zcode-link-'));
  const home = join(linkParent, 'home');
  symlinkSync(real, home);
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
    seedPlugin(cliRoot, DEMO, 'plgnz-0123456789abcdef', 'kept-session\n', 'kept');
    seedPlugin(cliRoot, SCRATCH, 'plgnz-fedcba9876543210', 'scratch-session\n', 'scratch');
    await run(home, cliRoot);
  } finally {
    process.chdir(originalCwd);
    keys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
    rmSync(real, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  }
}

async function prepareDemoRetirement() {
  const target = { kind: 'zcode-cli', instance: 'default' } as const;
  const version = await zcodeCliLifecycle.probeVersion(target);
  const observed = await zcodeCliLifecycle.observeTarget(target);
  const installation = observed.installations.find((row) => row.nativeId === DEMO);
  if (installation === undefined || installation.ownership.kind !== 'owned' || installation.installedFingerprint === null || installation.installedVersion === null) {
    throw new Error('seeded ZCode install was not observed as an owned present activation');
  }
  const operationId = 'op-retire-demo';
  const attemptId = 'attempt-retire-demo';
  const activation = createRecordedOwnedActivation({
    scopeId: 'scope-demo',
    target,
    packageName: 'demo',
    nativeId: DEMO,
    sourceType: 'local',
    sourceRevision: 'local-demo-revision',
    sourceLocator: null,
    installedVersion: installation.installedVersion,
    route: 'native',
    evidenceId: 'seed-evidence',
    ownership: { kind: 'created', proofId: installation.ownership.proofId },
    activation: 'active',
    enablement: 'enabled',
    installedFingerprint: installation.installedFingerprint,
    contentRoots: installation.contentRoots,
  });
  const nativeScope = await zcodeCliLifecycle.observeNativeMutationScope({
    targetObservation: observed,
    operation: 'retire',
    packageName: 'demo',
    nativeId: DEMO,
    sourceType: 'local',
  });
  const nativeProjection = await zcodeCliLifecycle.observeNativeProjection({
    targetObservation: observed,
    operation: 'retire',
    operationId,
    attemptId,
    activation,
  });
  const decision = zcodeCliLifecycle.decideRoute({
    target,
    operation: 'retire',
    operationId,
    attemptId,
    scopeId: 'scope-demo',
    packageName: 'demo',
    nativeId: DEMO,
    version,
    sourceType: 'local',
    targetObservation: observed,
    nativeScope,
    nativeProjection,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId: DEMO,
      operationId,
      operation: 'retire',
      mutationGroupId: 'group-retire-demo',
      authorization: 'observed-owned',
    }]),
    activation,
  });
  if (decision.kind !== 'selected') throw new Error(`expected a selected retirement route, got ${decision.kind}`);
  const prepared = await zcodeCliLifecycle.prepareRetirement({
    operationId,
    attemptId,
    action: 'remove',
    selection: decision,
    activation,
  });
  return { prepared, installation, decision, activation, operationId, attemptId, observed };
}

describe('ZCode CLI retirement rollback', () => {
  test('restores only this plugin through a symlinked home and keeps a sibling edit', async () => {
    await withLinkedHome(async (_home, cliRoot) => {
      const { prepared, installation } = await prepareDemoRetirement();
      await zcodeCliLifecycle.retire(prepared);
      const configPath = join(cliRoot, 'config.json');
      const registryPath = join(cliRoot, 'plugins', 'installed_plugins.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.plugins.options[SCRATCH] = { theme: 'later' };
      config.plugins.enabledPlugins[SCRATCH] = false;
      config.plugins.options[DEMO] = { theme: 'mutated-after-snapshot' };
      writeFileSync(configPath, JSON.stringify(config));
      const otherPath = join(cliRoot, 'plugins', 'cache', 'plgnz-aaaaaaaaaaaaaaaa', 'other', '1.0.0');
      mkdirSync(otherPath, { recursive: true });
      writeFileSync(join(otherPath, 'plugin.json'), '{"name":"other","version":"1.0.0"}\n');
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      registry.plugins.push({ id: OTHER, name: 'other', marketplace: 'plgnz-aaaaaaaaaaaaaaaa', version: '1.0.0', installPath: otherPath, scope: 'user' });
      writeFileSync(registryPath, JSON.stringify(registry));
      const rolled = await zcodeCliLifecycle.rollback(prepared.handle);
      const observation = await zcodeCliLifecycle.readback(prepared.handle);
      zcodeCliLifecycle.verifyRollback(prepared.handle, observation);
      expect(rolled.changed).toBe(true);

      const installPath = installation.contentRoots[0]?.path ?? '';
      expect(readFileSync(join(installPath, 'plugin.json'), 'utf8')).toBe('{"name":"demo","version":"1.0.0"}\n');
      const after = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(after.plugins.options[DEMO]).toEqual({ theme: 'kept' });
      expect(after.plugins.enabledPlugins[DEMO]).toBe(true);
      expect(after.plugins.options[SCRATCH]).toEqual({ theme: 'later' });
      expect(after.plugins.enabledPlugins[SCRATCH]).toBe(false);
      const rows = JSON.parse(readFileSync(registryPath, 'utf8')).plugins as Array<{ id: string }>;
      expect(rows.some((row) => row.id === DEMO)).toBe(true);
      expect(rows.some((row) => row.id === OTHER)).toBe(true);
      expect(readFileSync(join(cliRoot, 'plugins', 'data', DEMO, 'session.txt'), 'utf8')).toBe('kept-session\n');
    });
  });

  test('fails when the snapshot or its cache copy is missing', async () => {
    await withLinkedHome(async () => {
      const missingSnapshot = await prepareDemoRetirement();
      rmSync(missingSnapshot.prepared.handle.rollbackReference, { recursive: true, force: true });
      let snapshotError: Error | undefined;
      try {
        await zcodeCliLifecycle.rollback(missingSnapshot.prepared.handle);
      } catch (error) {
        snapshotError = error as Error;
      }
      expect(snapshotError?.message ?? '').toContain('ZCode rollback snapshot is missing');

      const missingCache = await prepareDemoRetirement();
      await zcodeCliLifecycle.retire(missingCache.prepared);
      rmSync(join(missingCache.prepared.handle.rollbackReference, 'cache'), { recursive: true, force: true });
      let cacheError: Error | undefined;
      try {
        await zcodeCliLifecycle.rollback(missingCache.prepared.handle);
      } catch (error) {
        cacheError = error as Error;
      }
      expect(cacheError?.message ?? '').toContain('ZCode rollback cache copy is missing');
      const registry = JSON.parse(readFileSync(join(process.env.ZCODE_STORAGE_DIR ?? '', 'cli', 'plugins', 'installed_plugins.json'), 'utf8'));
      expect(registry.plugins.some((row: { id: string }) => row.id === DEMO)).toBe(false);
    });
  });

  test('keeps the first rollback snapshot when retirement is prepared again', async () => {
    await withLinkedHome(async () => {
      const first = await prepareDemoRetirement();
      const sentinel = join(first.prepared.handle.rollbackReference, 'sentinel.txt');
      writeFileSync(sentinel, 'first');
      const second = await zcodeCliLifecycle.prepareRetirement({
        operationId: first.operationId,
        attemptId: first.attemptId,
        action: 'remove',
        selection: first.decision,
        activation: first.activation,
      });
      expect(readFileSync(sentinel, 'utf8')).toBe('first');
      expect(second.handle.rollbackReference).toBe(first.prepared.handle.rollbackReference);
      await zcodeCliLifecycle.retire(second);
      expect(existsSync(join(first.prepared.handle.rollbackReference, 'cache'))).toBe(true);
      const observation = await zcodeCliLifecycle.readback(second.handle);
      zcodeCliLifecycle.verify(second.handle, observation);
    });
  });
});
