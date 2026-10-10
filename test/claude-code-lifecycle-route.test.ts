import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprintTree } from '../src/fingerprint';
import type { FrozenPackageSnapshot, LifecycleHostAdapter, TargetInstallationData } from '../src/lifecycle-host';
import { createFrozenPackageSnapshot, createLifecyclePlanCoverage, createRecordedOwnedActivation, createResolvedLifecyclePins } from '../src/lifecycle-runtime';
import type { PackageSemanticInventory } from '../src/semantic-inventory';
import { createClaudeCodeLifecycleHost, type ClaudeNativeRemoteUpdateContract } from '../src/hosts/claude-code-writer';

const claudeTarget = { kind: 'claude-code', instance: 'default' } as const;
const locator = 'https://github.com/example/plugins.git';
const installedRevision = '1'.repeat(40);

const passingContract: ClaudeNativeRemoteUpdateContract = {
  version: '2.1.295',
  source: 'git',
  action: 'update',
  consumesExactSnapshot: true,
  forcesSameVersionBytes: true,
  rollbackProven: true,
  readbackProven: true,
};

function binary(root: string, output: string): string {
  const path = join(root, 'claude');
  writeFileSync(path, `#!/bin/sh\nprintf '%b' ${JSON.stringify(output)}\n`);
  chmodSync(path, 0o755);
  return path;
}

function seedInstall(root: string, source: string, version: string): string {
  const install = resolve(root, 'plugins/cache/market/demo', version);
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, 'plugin.json'), `${JSON.stringify({ name: 'demo', version })}\n`);
  writeFileSync(join(install, '.plgnz-install.json'), `${JSON.stringify({
    source,
    pluginId: 'demo@market',
    fingerprint: 'seeded-fingerprint',
  })}\n`);
  mkdirSync(join(root, 'plugins'), { recursive: true });
  writeFileSync(join(root, 'plugins/installed_plugins.json'), `${JSON.stringify({
    version: 2,
    plugins: {
      'demo@market': [{
        scope: 'user',
        installPath: install,
        version,
        gitCommitSha: installedRevision,
      }],
    },
  }, null, 2)}\n`);
  writeFileSync(join(root, 'settings.json'), `${JSON.stringify({ enabledPlugins: { 'demo@market': true } })}\n`);
  return install;
}

async function withClaude(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-claude-route-'));
  const savedRoot = process.env['OPEN_PLUGIN_CLAUDE_CODE_ROOT'];
  const savedBin = process.env['OPEN_PLUGIN_CLAUDE_CODE_BIN'];
  process.env['OPEN_PLUGIN_CLAUDE_CODE_ROOT'] = root;
  process.env['OPEN_PLUGIN_CLAUDE_CODE_BIN'] = binary(root, '2.1.295 (Claude Code)\n');
  try {
    await run(root);
  } finally {
    if (savedRoot === undefined) delete process.env['OPEN_PLUGIN_CLAUDE_CODE_ROOT'];
    else process.env['OPEN_PLUGIN_CLAUDE_CODE_ROOT'] = savedRoot;
    if (savedBin === undefined) delete process.env['OPEN_PLUGIN_CLAUDE_CODE_BIN'];
    else process.env['OPEN_PLUGIN_CLAUDE_CODE_BIN'] = savedBin;
    rmSync(root, { recursive: true, force: true });
  }
}

async function route(host: LifecycleHostAdapter, root: string, input: {
  attemptId: string;
  version: string;
  revision?: string;
  locator?: string;
  pin?: boolean;
  operation?: 'update' | 'retire';
  requiredSemantics?: PackageSemanticInventory['requiredSemantics'];
}): Promise<string> {
  seedInstall(root, input.locator ?? locator, '1.0.0');
  const version = await host.probeVersion(claudeTarget);
  const observed = await host.observeTarget(claudeTarget);
  const installed = observed.installations.find((row) => row.nativeId === 'demo@market');
  if (installed === undefined) throw new Error('seeded Claude install was not observed');
  const operation = input.operation ?? 'update';
  const scope = await host.observeNativeMutationScope({
    targetObservation: observed,
    operation,
    packageName: 'demo',
    nativeId: 'demo@market',
    sourceType: 'git',
  });
  const attemptId = input.attemptId;
  const operationId = `op-${attemptId}`;
  const coverage = createLifecyclePlanCoverage(observed, [{
    nativeId: 'demo@market',
    operationId,
    operation,
    mutationGroupId: `group-${attemptId}`,
    authorization: 'observed-owned',
  }]);
  if (operation === 'retire') {
    const projection = await host.observeNativeProjection({
      targetObservation: observed,
      operation: 'retire',
      operationId,
      attemptId,
      activation: recorded(installed),
    });
    const decision = host.decideRoute({
      target: claudeTarget,
      operationId,
      attemptId,
      scopeId: 'scope-demo',
      packageName: 'demo',
      nativeId: 'demo@market',
      version,
      sourceType: 'git',
      targetObservation: observed,
      nativeScope: scope,
      nativeProjection: projection,
      planCoverage: coverage,
      operation: 'retire',
      activation: recorded(installed),
    });
    return decision.kind === 'selected' ? decision.route : decision.kind;
  }
  const snapshot = updateSnapshot(root, attemptId, input.version, input.revision ?? '2'.repeat(40), 'update', input.requiredSemantics);
  const pins = createResolvedLifecyclePins(input.pin ? [{ server: 'fixture', executable: '/opt/bin/fixture' }] : []);
  const projection = await host.observeNativeProjection({
    targetObservation: observed,
    operation: 'update',
    snapshot,
    pins,
  });
  const decision = host.decideRoute({
    target: snapshot.target,
    operationId,
    attemptId,
    scopeId: snapshot.scopeId,
    packageName: 'demo',
    nativeId: 'demo@market',
    version,
    sourceType: 'git',
    targetObservation: observed,
    nativeScope: scope,
    nativeProjection: projection,
    planCoverage: coverage,
    operation: 'update',
    snapshot,
    pins,
  });
  return decision.kind === 'selected' ? decision.route : decision.kind;
}

function recorded(installed: TargetInstallationData) {
  if (installed.ownership.kind !== 'owned' || installed.source === null || installed.installedFingerprint === null) {
    throw new Error('seeded Claude install is not an owned git activation');
  }
  return createRecordedOwnedActivation({
    scopeId: 'scope-demo',
    target: claudeTarget,
    packageName: 'demo',
    nativeId: 'demo@market',
    sourceType: 'git',
    sourceRevision: installed.source.immutableRevision,
    sourceLocator: installed.source.locator,
    installedVersion: installed.installedVersion,
    route: 'managed',
    evidenceId: 'recorded-evidence',
    ownership: { kind: 'created', proofId: installed.ownership.proofId },
    activation: 'active',
    enablement: 'enabled',
    installedFingerprint: installed.installedFingerprint,
    contentRoots: installed.contentRoots,
  });
}

describe('claude-code lifecycle route', () => {
  test('keeps Managed unless a pinned version, git source, and update pass the sandbox contract', async () => {
    await withClaude(async (root) => {
      const blocked = createClaudeCodeLifecycleHost();
      const partial = createClaudeCodeLifecycleHost({
        contracts: [{ ...passingContract, rollbackProven: false }],
      });
      const proven = createClaudeCodeLifecycleHost({ contracts: [passingContract] });
      const sameVersionBlocked = createClaudeCodeLifecycleHost({
        contracts: [{ ...passingContract, forcesSameVersionBytes: false }],
      });

      expect(await blocked.probeVersion(claudeTarget)).toEqual({
        kind: 'detected',
        version: '2.1.295',
        probeId: 'claude-code-cli-2.1.295',
      });
      expect(await route(blocked, root, { attemptId: 'no-contract', version: '1.1.0' })).toBe('managed');
      expect(await route(partial, root, { attemptId: 'no-rollback', version: '1.1.0' })).toBe('managed');
      expect(await route(sameVersionBlocked, root, { attemptId: 'same-version', version: '1.0.0' })).toBe('managed');
      expect(await route(proven, root, {
        attemptId: 'other-source',
        version: '1.1.0',
        locator: 'https://github.com/example/other.git',
      })).toBe('managed');
      expect(await route(proven, root, { attemptId: 'pinned-bytes', version: '1.1.0', pin: true })).toBe('managed');
      expect(await route(proven, root, { attemptId: 'retire', version: '1.1.0', operation: 'retire' })).toBe('managed');
      expect(await route(proven, root, { attemptId: 'exact-update', version: '1.1.0' })).toBe('native');
      expect(await route(blocked, root, { attemptId: 'hooks', version: '1.1.0', requiredSemantics: ['hooks'] })).toBe('capability-gap');
      expect(await route(blocked, root, {
        attemptId: 'permissions',
        version: '1.1.0',
        requiredSemantics: ['permissions-preprocessing'],
      })).toBe('capability-gap');
    });
  });

  test('probes the default claude on PATH and keeps that observation on the route profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-claude-path-'));
    const saved = {
      root: process.env['OPEN_PLUGIN_CLAUDE_CODE_ROOT'],
      bin: process.env['OPEN_PLUGIN_CLAUDE_CODE_BIN'],
      path: process.env['PATH'],
    };
    process.env['OPEN_PLUGIN_CLAUDE_CODE_ROOT'] = root;
    delete process.env['OPEN_PLUGIN_CLAUDE_CODE_BIN'];
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    process.env['PATH'] = binDir;
    binary(binDir, '2.1.295 (Claude Code)\n');
    try {
      const host = createClaudeCodeLifecycleHost();
      expect(await host.probeVersion(claudeTarget)).toEqual({
        kind: 'detected',
        version: '2.1.295',
        probeId: 'claude-code-cli-2.1.295',
      });
      binary(binDir, '9.9.9 (Claude Code)\n');
      expect(await host.probeVersion(claudeTarget)).toEqual({
        kind: 'detected',
        version: '2.1.295',
        probeId: 'claude-code-cli-2.1.295',
      });
      expect(await route(host, root, { attemptId: 'path-managed', version: '1.1.0' })).toBe('managed');
    } finally {
      if (saved.root === undefined) delete process.env['OPEN_PLUGIN_CLAUDE_CODE_ROOT'];
      else process.env['OPEN_PLUGIN_CLAUDE_CODE_ROOT'] = saved.root;
      if (saved.bin === undefined) delete process.env['OPEN_PLUGIN_CLAUDE_CODE_BIN'];
      else process.env['OPEN_PLUGIN_CLAUDE_CODE_BIN'] = saved.bin;
      if (saved.path === undefined) delete process.env['PATH'];
      else process.env['PATH'] = saved.path;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('managed install readback rolls back, and retire keeps plugin data', async () => {
    await withClaude(async (root) => {
      const host = createClaudeCodeLifecycleHost();
      const snapshot = updateSnapshot(root, 'install', '1.2.0', '3'.repeat(40), 'install');
      const installed = await activate(host, snapshot);
      expect(installed.directiveIds.includes('claude-code.auto-update')).toBe(false);
      const readback = await host.readback(installed.handle);
      host.verify(installed.handle, readback);
      expect(readback.transition).toEqual({ requirement: 'restart', status: 'effective' });
      expect(readFileSync(join(readback.contentRoots[0]!.path, 'plugin.json'), 'utf8')).toContain('"version":"1.2.0"');

      const rolled = await host.rollback(installed.handle);
      const restored = await host.readback(installed.handle);
      host.verifyRollback(installed.handle, restored);
      expect(rolled.changed).toBe(true);
      expect(existsSync(readback.contentRoots[0]!.path)).toBe(false);
      await host.cleanup(installed.handle, 'verified-rollback');

      const again = await activate(host, updateSnapshot(root, 'reinstall', '1.2.0', '3'.repeat(40), 'install'));
      const active = await host.readback(again.handle);
      host.verify(again.handle, active);
      const dataDir = join(root, 'plugins/plugin-data/demo@market');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'state.txt'), 'kept\n');
      const observed = await host.observeTarget(claudeTarget);
      const row = observed.installations.find((item) => item.nativeId === 'demo@market');
      if (row === undefined) throw new Error('reinstalled Claude package was not observed');
      const retired = await retire(host, observed, row);
      const after = await host.readback(retired.handle);
      host.verify(retired.handle, after);
      expect(after.presence).toBe('absent');
      expect(after.retention.pluginData).toEqual({ state: 'present', fingerprint: fingerprintTree(dataDir) });
      expect(readFileSync(join(dataDir, 'state.txt'), 'utf8')).toBe('kept\n');
      expect(existsSync(active.contentRoots[0]!.path)).toBe(false);
      expect(after.transition).toEqual({ requirement: 'none', status: 'effective' });
    });
  });

  test('update rollback removes the new cache slot and restores the previous one', async () => {
    await withClaude(async (root) => {
      const previous = seedInstall(root, locator, '1.0.0');
      const host = createClaudeCodeLifecycleHost();
      const snapshot = updateSnapshot(root, 'bump', '1.1.0', '4'.repeat(40), 'update');
      const updated = await activate(host, snapshot, 'update');
      const readback = await host.readback(updated.handle);
      host.verify(updated.handle, readback);
      const next = join(root, 'plugins/cache/market/demo/1.1.0');
      expect(existsSync(next)).toBe(true);
      expect(readback.transition).toEqual({ requirement: 'restart', status: 'effective' });

      const rolled = await host.rollback(updated.handle);
      const restored = await host.readback(updated.handle);
      host.verifyRollback(updated.handle, restored);
      expect(rolled.changed).toBe(true);
      expect(existsSync(next)).toBe(false);
      expect(readFileSync(join(previous, 'plugin.json'), 'utf8')).toContain('"version":"1.0.0"');
    });
  });

  test('update rollback fails when the new cache slot is already gone', async () => {
    await withClaude(async (root) => {
      seedInstall(root, locator, '1.0.0');
      const host = createClaudeCodeLifecycleHost();
      const snapshot = updateSnapshot(root, 'missing-slot', '1.1.0', '5'.repeat(40), 'update');
      const updated = await activate(host, snapshot, 'update');
      rmSync(join(root, 'plugins/cache/market/demo/1.1.0'), { recursive: true, force: true });
      let message = '';
      try {
        await host.rollback(updated.handle);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.includes('cannot remove the updated cache slot')).toBe(true);
    });
  });

  test('writes Claude marketplace autoUpdate and does not claim a private marker', async () => {
    await withClaude(async (root) => {
      mkdirSync(join(root, 'plugins'), { recursive: true });
      writeFileSync(join(root, 'plugins/known_marketplaces.json'), `${JSON.stringify({
        market: { source: { source: 'github', repo: 'example/plugins' }, installLocation: '/tmp/market' },
      })}\n`);
      writeFileSync(join(root, 'settings.json'), `${JSON.stringify({
        extraKnownMarketplaces: { market: { source: { source: 'github', repo: 'example/plugins' } } },
      })}\n`);
      const host = createClaudeCodeLifecycleHost();
      const installed = await activate(host, updateSnapshot(root, 'autoupdate', '1.2.0', '6'.repeat(40), 'install'));
      const marketplaces = JSON.parse(readFileSync(join(root, 'plugins/known_marketplaces.json'), 'utf8')) as {
        market: { autoUpdate?: boolean };
      };
      const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')) as {
        extraKnownMarketplaces: { market: { autoUpdate?: boolean } };
      };
      expect(marketplaces.market.autoUpdate).toBe(false);
      expect(settings.extraKnownMarketplaces.market.autoUpdate).toBe(false);
      const readback = await host.readback(installed.handle);
      const marker = JSON.parse(readFileSync(join(readback.contentRoots[0]!.path, '.plgnz-lifecycle.json'), 'utf8')) as {
        autoUpdate?: boolean;
        route: string;
      };
      expect(marker).toEqual({ route: 'managed' });
      expect(installed.directiveIds).toContain('claude-code.auto-update');
    });
  });
});

async function activate(host: LifecycleHostAdapter, snapshot: FrozenPackageSnapshot, operation: 'install' | 'update' = 'install') {
  const version = await host.probeVersion(claudeTarget);
  const observed = await host.observeTarget(claudeTarget);
  const pins = createResolvedLifecyclePins([]);
  const projection = await host.observeNativeProjection({
    targetObservation: observed,
    operation,
    snapshot,
    pins,
  });
  const decision = host.decideRoute({
    target: claudeTarget,
    operationId: snapshot.operationId,
    attemptId: snapshot.attemptId,
    scopeId: snapshot.scopeId,
    packageName: snapshot.packageName,
    nativeId: snapshot.nativeId,
    version,
    sourceType: 'git',
    targetObservation: observed,
    nativeScope: await host.observeNativeMutationScope({
      targetObservation: observed,
      operation,
      packageName: snapshot.packageName,
      nativeId: snapshot.nativeId,
      sourceType: 'git',
    }),
    nativeProjection: projection,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId: snapshot.nativeId,
      operationId: snapshot.operationId,
      operation,
      mutationGroupId: `group-${snapshot.attemptId}`,
      authorization: operation === 'install' ? 'planned-create' : 'observed-owned',
    }]),
    operation,
    snapshot,
    pins,
  });
  if (decision.kind !== 'selected' || decision.route !== 'managed') {
    throw new Error(`expected managed ${operation}, got ${decision.kind}`);
  }
  const staged = await host.stageActivation({ selection: decision, snapshot, pins });
  const directed = await host.applyLifecycleDirectives(staged);
  const pinned = await host.applyPins(directed);
  const prepared = await host.sealActivation(pinned);
  const receipt = await host.apply(prepared);
  return { ...receipt, directiveIds: directed.directiveIds };
}

async function retire(
  host: LifecycleHostAdapter,
  observed: Awaited<ReturnType<LifecycleHostAdapter['observeTarget']>>,
  installed: TargetInstallationData,
) {
  if (installed.ownership.kind !== 'owned' || installed.installedFingerprint === null || installed.source === null) {
    throw new Error('installed Claude package is not owned');
  }
  const version = await host.probeVersion(claudeTarget);
  const operationId = 'op-retire-data';
  const attemptId = 'retire-data';
  const activation = recorded(installed);
  const projection = await host.observeNativeProjection({
    targetObservation: observed,
    operation: 'retire',
    operationId,
    attemptId,
    activation,
  });
  const decision = host.decideRoute({
    target: claudeTarget,
    operationId,
    attemptId,
    scopeId: 'scope-demo',
    packageName: 'demo',
    nativeId: 'demo@market',
    version,
    sourceType: 'git',
    targetObservation: observed,
    nativeScope: await host.observeNativeMutationScope({
      targetObservation: observed,
      operation: 'retire',
      packageName: 'demo',
      nativeId: 'demo@market',
      sourceType: 'git',
    }),
    nativeProjection: projection,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId: 'demo@market',
      operationId,
      operation: 'retire',
      mutationGroupId: 'group-retire-data',
      authorization: 'observed-owned',
    }]),
    operation: 'retire',
    activation,
  });
  if (decision.kind !== 'selected' || decision.route !== 'managed') {
    throw new Error(`expected managed retire, got ${decision.kind}`);
  }
  const prepared = await host.prepareRetirement({
    operationId,
    attemptId,
    action: 'remove',
    selection: decision,
    activation,
  });
  return host.retire(prepared);
}

function updateSnapshot(
  root: string,
  attemptId: string,
  version: string,
  revision: string,
  action: 'install' | 'update' = 'update',
  requiredSemantics: PackageSemanticInventory['requiredSemantics'] = [],
) {
  const snapshotRoot = join(root, `snapshot-${attemptId}`);
  const packageRoot = join(snapshotRoot, 'packages/demo');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'plugin.json'), `${JSON.stringify({ name: 'demo', version })}\n`);
  const packageFingerprint = fingerprintTree(packageRoot);
  const inventory: PackageSemanticInventory = {
    schemaVersion: 1,
    package: { name: 'demo', version, fingerprint: packageFingerprint },
    components: { skills: [], mcp: [], hooks: [], commands: [], agents: [], resources: [], permissionsPreprocessing: [] },
    componentDefinitions: [],
    invocationPolicies: [],
    componentInvocationPolicies: [],
    autoUpdate: [],
    manifestPaths: [],
    hookDeclarations: [],
    requiredSemantics,
  };
  return createFrozenPackageSnapshot({
    operationId: `op-${attemptId}`,
    attemptId,
    scopeId: 'scope-demo',
    target: claudeTarget,
    action,
    packageName: 'demo',
    nativeId: 'demo@market',
    sourceType: 'git',
    immutableRevision: revision,
    snapshotRoot,
    packageRoot,
    relativePackagePath: 'packages/demo',
    snapshotFingerprint: fingerprintTree(snapshotRoot),
    packageFingerprint,
    nativeGit: { locator, resolvedRevision: revision },
    inventory,
  });
}
