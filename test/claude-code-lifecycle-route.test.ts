import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprintTree } from '../src/fingerprint';
import { createFrozenPackageSnapshot, createLifecyclePlanCoverage, createRecordedOwnedActivation, createResolvedLifecyclePins } from '../src/lifecycle-runtime';
import type { LifecycleHostAdapter, TargetInstallationData } from '../src/lifecycle-host';
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
  const snapshot = updateSnapshot(root, attemptId, input.version, input.revision ?? '2'.repeat(40));
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
    });
  });
});

function updateSnapshot(root: string, attemptId: string, version: string, revision: string) {
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
    requiredSemantics: [],
  };
  return createFrozenPackageSnapshot({
    operationId: `op-${attemptId}`,
    attemptId,
    scopeId: 'scope-demo',
    target: claudeTarget,
    action: 'update',
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
