import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
writeFileSync(logPath, prior + args.join(' ') + '\n');
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
      expect(decision.route).toBe('managed');
      expect(decision.detectedVersion).toBe('0.16.9');
      expect(decision.evidenceId).toBe(managed?.evidenceId);

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
      expect(log).toContain(`plugins uninstall ${SCRATCH} --force`);
      expect(log).not.toContain(`plugins uninstall ${DEMO}`);
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
