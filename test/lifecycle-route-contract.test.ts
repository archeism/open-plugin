import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLifecyclePlanCoverage,
  createRecordedOwnedActivation,
  createResolvedLifecyclePins,
} from '../src/lifecycle-runtime';
import type { SelectedRouteDecision } from '../src/lifecycle-host';
import { FakeLifecycleHost } from './fake-lifecycle-adapter';
import { fixtureProfile, fixtureSnapshot, fixtureTarget } from './lifecycle-fixtures';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `plgnz-${label}-`));
  roots.push(root);
  return root;
}

describe('lifecycle Native route proof', () => {
  test('rejects a mutable Git ref before it can become a frozen lifecycle input', () => {
    const root = tempRoot('mutable-git-ref');
    let error: unknown;
    try {
      fixtureSnapshot(root, {
        operationId: 'op-mutable',
        attemptId: 'attempt-mutable',
        action: 'install',
        revision: 'main',
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(String(error)).toContain('full lowercase SHA-1 or SHA-256');
  });

  test('admits a fresh exact-package Native install only with a collision-free planned-create proof', async () => {
    const root = tempRoot('native-create');
    const fake = new FakeLifecycleHost(join(root, 'host'), [
      fixtureProfile({ route: 'native', operations: ['install'] }),
      fixtureProfile({ route: 'managed', operations: ['install'] }),
    ]);
    fake.nativeScope = { kind: 'bounded', mode: 'exact-package', affectedNativeIds: ['demo@market'] };
    const snapshot = fixtureSnapshot(root, {
      operationId: 'op-install-demo',
      attemptId: 'attempt-install-demo',
      action: 'install',
    });
    const pins = createResolvedLifecyclePins([]);
    const version = await fake.adapter.probeVersion(fixtureTarget);
    const observed = await fake.adapter.observeTarget(fixtureTarget);
    const scope = await fake.adapter.observeNativeMutationScope({
      targetObservation: observed,
      operation: 'install',
      packageName: snapshot.packageName,
      nativeId: snapshot.nativeId,
      sourceType: snapshot.sourceType,
    });
    const projection = await fake.adapter.observeNativeProjection({
      targetObservation: observed,
      operation: 'install',
      snapshot,
      pins,
    });
    const coverage = createLifecyclePlanCoverage(observed, [{
      nativeId: snapshot.nativeId,
      operationId: snapshot.operationId,
      operation: 'install',
      mutationGroupId: 'group-install-demo',
      authorization: 'planned-create',
    }]);
    const decision = fake.adapter.decideRoute({
      target: snapshot.target,
      operationId: snapshot.operationId,
      attemptId: snapshot.attemptId,
      scopeId: snapshot.scopeId,
      packageName: snapshot.packageName,
      nativeId: snapshot.nativeId,
      version,
      sourceType: snapshot.sourceType,
      targetObservation: observed,
      nativeScope: scope,
      nativeProjection: projection,
      planCoverage: coverage,
      operation: 'install',
      snapshot,
      pins,
    });

    expect(decision.kind).toBe('selected');
    expect(decision.kind === 'selected' && decision.route).toBe('native');
    expect(decision.kind === 'selected' && decision.mutationGroupId).toBe('group-install-demo');

    const colliding = new FakeLifecycleHost(join(root, 'collision-host'), []);
    colliding.seedActivation({ nativeId: 'demo@market', scopeId: 'other-scope', packageName: 'demo' });
    const collisionObservation = await colliding.adapter.observeTarget(fixtureTarget);
    let collisionError: unknown;
    try {
      createLifecyclePlanCoverage(collisionObservation, [{
        nativeId: 'demo@market',
        operationId: 'op-install-demo',
        operation: 'install',
        mutationGroupId: 'group-install-demo',
        authorization: 'planned-create',
      }]);
    } catch (error) {
      collisionError = error;
    }
    expect(String(collisionError)).toContain('collides');
  });

  test('binds conditional Native eligibility to installed source/version, frozen Git SHA, pins, and projection proof', async () => {
    const root = tempRoot('native-conditional');
    const profiles = [
      fixtureProfile({ route: 'native', operations: ['update'] }),
      fixtureProfile({ route: 'managed', operations: ['update'] }),
    ];
    const fake = new FakeLifecycleHost(join(root, 'host'), profiles);
    fake.seedActivation({
      nativeId: 'demo@market',
      scopeId: 'scope-demo',
      packageName: 'demo',
      installedVersion: '1.0.0',
      sourceRevision: '0'.repeat(40),
      sourceLocator: 'https://github.com/example/plugins.git',
    });
    fake.nativeScope = { kind: 'bounded', mode: 'exact-package', affectedNativeIds: ['demo@market'] };
    fake.nativeProjectionFor = (request) => {
      if (!('snapshot' in request)) return { kind: 'unverified', reasonId: 'not-activation' };
      const installed = request.targetObservation.installations.find(({ nativeId }) => nativeId === request.snapshot.nativeId);
      if (installed?.source?.locator !== request.snapshot.nativeGit?.locator) {
        return { kind: 'unverified', reasonId: 'source-mismatch' };
      }
      if (installed === undefined) return { kind: 'unverified', reasonId: 'missing-installation' };
      if (installed.installedVersion === request.snapshot.inventory.package.version) {
        return { kind: 'requires-managed', reasonId: 'same-version-drift' };
      }
      if (request.pins.length > 0) return { kind: 'requires-managed', reasonId: 'pin-rewrites-projection' };
      return { kind: 'equivalent', proofId: `exact-git:${request.snapshot.nativeGit!.resolvedRevision}` };
    };
    const observed = await fake.adapter.observeTarget(fixtureTarget);
    const version = await fake.adapter.probeVersion(fixtureTarget);
    const scope = await fake.adapter.observeNativeMutationScope({
      targetObservation: observed,
      operation: 'update',
      packageName: 'demo',
      nativeId: 'demo@market',
      sourceType: 'git',
    });

    async function decide(attemptId: string, versionName: string, pin: boolean) {
      const operationId = `op-${attemptId}`;
      const snapshot = fixtureSnapshot(root, {
        operationId,
        attemptId,
        action: 'update',
        version: versionName,
        revision: (pin ? '3' : versionName === '1.0.0' ? '1' : '2').repeat(40),
      });
      const pins = createResolvedLifecyclePins(pin ? [{ server: 'fixture', executable: '/opt/bin/fixture' }] : []);
      const projection = await fake.adapter.observeNativeProjection({
        targetObservation: observed,
        operation: 'update',
        snapshot,
        pins,
      });
      return fake.adapter.decideRoute({
        target: snapshot.target,
        operationId,
        attemptId,
        scopeId: snapshot.scopeId,
        packageName: snapshot.packageName,
        nativeId: snapshot.nativeId,
        version,
        sourceType: snapshot.sourceType,
        targetObservation: observed,
        nativeScope: scope,
        nativeProjection: projection,
        planCoverage: createLifecyclePlanCoverage(observed, [{
          nativeId: snapshot.nativeId,
          operationId,
          operation: 'update',
          mutationGroupId: `group-${attemptId}`,
          authorization: 'observed-owned',
        }]),
        operation: 'update',
        snapshot,
        pins,
      });
    }

    const sameVersion = await decide('same-version', '1.0.0', false);
    const exactUpgrade = await decide('exact-upgrade', '1.1.0', false);
    const pinnedUpgrade = await decide('pinned-upgrade', '1.1.0', true);

    expect(sameVersion.kind === 'selected' && sameVersion.route).toBe('managed');
    expect(exactUpgrade.kind === 'selected' && exactUpgrade.route).toBe('native');
    expect(pinnedUpgrade.kind === 'selected' && pinnedUpgrade.route).toBe('managed');
    expect(exactUpgrade.kind === 'selected' && exactUpgrade.versionProbeId).toBe('fixture-runtime-1');
  });

  test('selects install, update, disable, and retire independently and never infers disable support', async () => {
    const root = tempRoot('route-matrix');
    const fake = new FakeLifecycleHost(join(root, 'host'), [
      fixtureProfile({ route: 'native', operations: ['install'] }),
      fixtureProfile({ route: 'managed', operations: ['update', 'disable'] }),
    ]);
    const priorFingerprint = fake.seedActivation({
      nativeId: 'demo@market',
      scopeId: 'scope-demo',
      packageName: 'demo',
    });
    fake.nativeScope = { kind: 'bounded', mode: 'exact-package', affectedNativeIds: ['demo@market'] };
    const observed = await fake.adapter.observeTarget(fixtureTarget);
    const installed = observed.installations[0]!;
    const activation = createRecordedOwnedActivation({
      scopeId: 'scope-demo',
      target: fixtureTarget,
      packageName: 'demo',
      nativeId: 'demo@market',
      sourceType: 'git',
      sourceRevision: installed.source!.immutableRevision,
      sourceLocator: installed.source!.locator,
      installedVersion: installed.installedVersion,
      route: 'managed',
      evidenceId: 'recorded-evidence',
      ownership: { kind: 'created', proofId: 'proof:demo@market' },
      activation: 'nonconforming',
      enablement: 'enabled',
      installedFingerprint: priorFingerprint,
      contentRoots: installed.contentRoots,
    });
    const targetVersion = await fake.adapter.probeVersion(fixtureTarget);
    const scopeFor = (operation: 'update' | 'disable' | 'retire') => fake.adapter.observeNativeMutationScope({
      targetObservation: observed,
      operation,
      packageName: 'demo',
      nativeId: 'demo@market',
      sourceType: 'git',
    });

    const updateSnapshot = fixtureSnapshot(root, {
      operationId: 'op-update',
      attemptId: 'attempt-update',
      action: 'update',
      version: '1.1.0',
    });
    const noPins = createResolvedLifecyclePins([]);
    const updateProjection = await fake.adapter.observeNativeProjection({
      targetObservation: observed,
      operation: 'update',
      snapshot: updateSnapshot,
      pins: noPins,
    });
    const update = fake.adapter.decideRoute({
      target: fixtureTarget,
      operationId: 'op-update',
      attemptId: 'attempt-update',
      scopeId: 'scope-demo',
      packageName: 'demo',
      nativeId: 'demo@market',
      version: targetVersion,
      sourceType: 'git',
      targetObservation: observed,
      nativeScope: await scopeFor('update'),
      nativeProjection: updateProjection,
      planCoverage: createLifecyclePlanCoverage(observed, [{
        nativeId: 'demo@market', operationId: 'op-update', operation: 'update',
        mutationGroupId: 'group-update', authorization: 'observed-owned',
      }]),
      operation: 'update',
      snapshot: updateSnapshot,
      pins: noPins,
    });

    async function recordedDecision(operation: 'disable' | 'retire', operationId: string) {
      const attemptId = `attempt-${operation}`;
      const projection = await fake.adapter.observeNativeProjection({
        targetObservation: observed,
        operation,
        operationId,
        attemptId,
        activation,
      });
      return fake.adapter.decideRoute({
        target: fixtureTarget,
        operationId,
        attemptId,
        scopeId: 'scope-demo',
        packageName: 'demo',
        nativeId: 'demo@market',
        version: targetVersion,
        sourceType: 'git',
        targetObservation: observed,
        nativeScope: await scopeFor(operation),
        nativeProjection: projection,
        planCoverage: createLifecyclePlanCoverage(observed, [{
          nativeId: 'demo@market', operationId, operation,
          mutationGroupId: `group-${operation}`, authorization: 'observed-owned',
        }]),
        operation,
        activation,
      });
    }

    const disable = await recordedDecision('disable', 'op-disable');
    const retire = await recordedDecision('retire', 'op-retire');
    const unparseable = fake.adapter.decideRoute({
      target: fixtureTarget,
      operationId: 'op-update',
      attemptId: 'attempt-update',
      scopeId: 'scope-demo',
      packageName: 'demo',
      nativeId: 'demo@market',
      version: { kind: 'unparseable' },
      sourceType: 'git',
      targetObservation: observed,
      nativeScope: await scopeFor('update'),
      nativeProjection: updateProjection,
      planCoverage: createLifecyclePlanCoverage(observed, [{
        nativeId: 'demo@market', operationId: 'op-update', operation: 'update',
        mutationGroupId: 'group-update', authorization: 'observed-owned',
      }]),
      operation: 'update',
      snapshot: updateSnapshot,
      pins: noPins,
    });

    expect(update.kind === 'selected' && update.route).toBe('managed');
    expect(disable.kind === 'selected' && disable.route).toBe('managed');
    expect(retire.kind).toBe('capability-gap');
    expect(retire.kind === 'capability-gap' && retire.status).toBe('unverified');
    expect(unparseable.kind).toBe('capability-gap');
    expect(unparseable.kind === 'capability-gap' && unparseable.gaps.every(({ category }) => category === 'capability')).toBe(true);

    if (false) {
      const managedOnly = null as unknown as SelectedRouteDecision<'managed', 'install'>;
      const acceptsNative = (_route: SelectedRouteDecision<'native', 'install'>) => undefined;
      // @ts-expect-error a Managed decision cannot cross the Native mutation boundary.
      acceptsNative(managedOnly);
    }
  });
});
