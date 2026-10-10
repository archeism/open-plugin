import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintTree } from '../src/fingerprint';
import { codexLifecycle } from '../src/hosts/codex-writer';
import type { FrozenPackageSnapshot, LifecycleRouteDecision, SelectedRouteDecision } from '../src/lifecycle-host';
import {
  createFrozenPackageSnapshot,
  createLifecyclePlanCoverage,
  createResolvedLifecyclePins,
} from '../src/lifecycle-runtime';
import { emptyInventory } from './lifecycle-fixtures';
import { withHostEnvAsync, writeFiles } from './util';

const target = { kind: 'codex', instance: 'default' } as const;
const marketplace = 'demo-market';
const frozenSha = 'a'.repeat(40);
const sourceLocator = 'https://github.com/example/plugins.git';
const demoId = 'demo-plugin@demo-market';
const otherId = 'other-plugin@demo-market';
const foreignId = 'foreign-plugin@other-market';

describe('codex native marketplace upgrade route', () => {
  test('refuses native marketplace upgrade unless the catalog is bound to the frozen SHA and every affected plugin is owned', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const binary = join(home, 'bin', 'codex');
      writeFiles(home, { 'bin/codex': '#!/bin/sh\nprintf "%s\\n" "codex-cli 0.162.0"\n' });
      chmodSync(binary, 0o755);
      process.env['OPEN_PLUGIN_CODEX_BIN'] = binary;
      try {
        const snapshot = frozenSnapshot(home);
        const pins = createResolvedLifecyclePins([]);
        writeCatalog(home, 'main', [demoId]);
        installPlugin(home, 'demo-plugin', demoId, true);
        const unbound = selectedRoute(await selectedUpdate(snapshot, pins));
        expect(unbound.route).toBe('managed');

        writeCatalog(home, frozenSha, [demoId, otherId]);
        installPlugin(home, 'other-plugin', otherId, false);
        const unowned = selectedRoute(await selectedUpdate(snapshot, pins));
        expect(unowned.route).toBe('managed');

        installPlugin(home, 'other-plugin', otherId, true);
        writeCatalog(home, frozenSha, [demoId, otherId, foreignId]);
        installPlugin(home, 'foreign-plugin', foreignId, false);
        const eligible = selectedRoute(await selectedUpdate(snapshot, pins));
        expect(eligible.route).toBe('native');
        expect([...eligible.affectedNativeIds]).toEqual([demoId, otherId]);
      } finally {
        delete process.env['OPEN_PLUGIN_CODEX_BIN'];
      }
    });
  });
});

function selectedRoute(decision: LifecycleRouteDecision<'update'>): SelectedRouteDecision<'native' | 'managed', 'update'> {
  if (decision.kind !== 'selected') throw new Error(`codex update route was not selected: ${decision.status}`);
  return decision;
}

async function selectedUpdate(
  snapshot: FrozenPackageSnapshot,
  pins: ReturnType<typeof createResolvedLifecyclePins>,
): Promise<LifecycleRouteDecision<'update'>> {
  const version = await codexLifecycle.probeVersion(target);
  const observed = await codexLifecycle.observeTarget(target);
  const nativeScope = await codexLifecycle.observeNativeMutationScope({
    targetObservation: observed,
    operation: 'update',
    packageName: snapshot.packageName,
    nativeId: snapshot.nativeId,
    sourceType: snapshot.sourceType,
  });
  const nativeProjection = await codexLifecycle.observeNativeProjection({
    targetObservation: observed,
    operation: 'update',
    snapshot,
    pins,
  });
  const owned = observed.installations.filter((installation) => (
    installation.nativeId.endsWith(`@${marketplace}`) && installation.ownership.kind === 'owned'
  ));
  return codexLifecycle.decideRoute({
    target,
    operation: 'update',
    operationId: snapshot.operationId,
    attemptId: snapshot.attemptId,
    scopeId: snapshot.scopeId,
    packageName: snapshot.packageName,
    nativeId: snapshot.nativeId,
    version,
    sourceType: snapshot.sourceType,
    targetObservation: observed,
    nativeScope,
    nativeProjection,
    planCoverage: createLifecyclePlanCoverage(observed, owned.map((installation) => ({
      nativeId: installation.nativeId,
      operationId: installation.nativeId === demoId ? snapshot.operationId : `update:${installation.nativeId}`,
      operation: 'update',
      mutationGroupId: `marketplace:${marketplace}`,
      authorization: 'observed-owned',
    }))),
    snapshot,
    pins,
  });
}

function frozenSnapshot(home: string): FrozenPackageSnapshot {
  const snapshotRoot = join(home, 'source-snapshot');
  const packageRoot = join(snapshotRoot, 'packages', 'demo-plugin');
  mkdirSync(packageRoot, { recursive: true });
  writeFiles(packageRoot, { 'plugin.json': '{"name":"demo-plugin","version":"1.0.0"}\n' });
  const packageFingerprint = fingerprintTree(packageRoot);
  return createFrozenPackageSnapshot({
    operationId: 'update-demo-plugin',
    attemptId: 'attempt-demo-plugin',
    scopeId: 'scope-demo-plugin',
    target,
    action: 'update',
    packageName: 'demo-plugin',
    nativeId: demoId,
    sourceType: 'git',
    immutableRevision: frozenSha,
    snapshotRoot,
    packageRoot,
    relativePackagePath: 'packages/demo-plugin',
    snapshotFingerprint: fingerprintTree(snapshotRoot),
    packageFingerprint,
    nativeGit: { locator: sourceLocator, resolvedRevision: frozenSha },
    inventory: {
      ...emptyInventory,
      package: { name: 'demo-plugin', version: '1.0.0', fingerprint: packageFingerprint },
    },
  });
}

function writeCatalog(home: string, refName: string, pluginIds: readonly string[]): void {
  const tables = pluginIds.map((id) => `[plugins."${id}"]\nenabled = true\n`).join('\n');
  writeFiles(home, {
    '.codex/config.toml': [
      '[marketplaces.demo-market]',
      'source_type = "git"',
      `source = "${sourceLocator}"`,
      `ref_name = "${refName}"`,
      '',
      tables,
    ].join('\n'),
  });
}

function installPlugin(home: string, name: string, id: string, owned: boolean): void {
  const market = id.slice(id.indexOf('@') + 1);
  const root = join(home, '.codex/plugins/cache', market, name, '1.0.0');
  writeFiles(root, { 'plugin.json': `{"name":"${name}","version":"1.0.0"}\n` });
  if (!owned) return;
  writeFiles(root, {
    '.plgnz-install.json': JSON.stringify({ source: sourceLocator, pluginId: id, fingerprint: 'owned' }),
  });
}
