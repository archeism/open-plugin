import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LifecycleHostPhaseError,
  LifecycleReadbackMismatchError,
  createLifecyclePlanCoverage,
  createRecordedOwnedActivation,
  createResolvedLifecyclePins,
  hydrateDurableLifecycleOperation,
} from '../src/lifecycle-runtime';
import type {
  FrozenPackageSnapshot,
  PreparedActivationMutation,
  RecordedOwnedActivation,
  ResolvedLifecyclePin,
  SelectedLifecycleRoute,
  SelectedRouteDecision,
} from '../src/lifecycle-host';
import { FakeLifecycleHost } from './fake-lifecycle-adapter';
import { fixtureProfile, fixtureSnapshot, fixtureTarget } from './lifecycle-fixtures';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `plgnz-${label}-`));
  roots.push(root);
  return root;
}

async function selectedActivationRoute(
  fake: FakeLifecycleHost,
  snapshot: FrozenPackageSnapshot,
  operation: 'install',
  pins: readonly ResolvedLifecyclePin[],
): Promise<SelectedRouteDecision<SelectedLifecycleRoute, 'install'>>;
async function selectedActivationRoute(
  fake: FakeLifecycleHost,
  snapshot: FrozenPackageSnapshot,
  operation: 'update',
  pins: readonly ResolvedLifecyclePin[],
): Promise<SelectedRouteDecision<SelectedLifecycleRoute, 'update'>>;
async function selectedActivationRoute(
  fake: FakeLifecycleHost,
  snapshot: FrozenPackageSnapshot,
  operation: 'install' | 'update',
  pins: readonly ResolvedLifecyclePin[],
): Promise<SelectedRouteDecision<SelectedLifecycleRoute, 'install' | 'update'>> {
  const version = await fake.adapter.probeVersion(snapshot.target);
  const observed = await fake.adapter.observeTarget(snapshot.target);
  const nativeScope = await fake.adapter.observeNativeMutationScope({
    targetObservation: observed,
    operation,
    packageName: snapshot.packageName,
    nativeId: snapshot.nativeId,
    sourceType: snapshot.sourceType,
  });
  const nativeProjection = await fake.adapter.observeNativeProjection({
    targetObservation: observed,
    operation,
    snapshot,
    pins,
  });
  const existing = observed.installations.find(({ nativeId }) => nativeId === snapshot.nativeId);
  const common = {
    target: snapshot.target,
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
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId: snapshot.nativeId,
      operationId: snapshot.operationId,
      operation,
      mutationGroupId: `group:${snapshot.operationId}`,
      authorization: existing?.ownership.kind === 'owned' ? 'observed-owned' : 'planned-create',
    }]),
    snapshot,
    pins,
  };
  const decision = operation === 'install'
    ? fake.adapter.decideRoute({ ...common, operation: 'install' })
    : fake.adapter.decideRoute({ ...common, operation: 'update' });
  if (decision.kind !== 'selected') throw new Error(`fixture ${operation} route was not selected`);
  return decision;
}

async function prepareInstall(
  fake: FakeLifecycleHost,
  snapshot: FrozenPackageSnapshot & { readonly action: 'install' },
  pins: readonly ResolvedLifecyclePin[] = createResolvedLifecyclePins([]),
): Promise<PreparedActivationMutation> {
  const selection = await selectedActivationRoute(fake, snapshot, 'install', pins);
  const staged = await fake.adapter.stageActivation({ selection, snapshot, pins });
  const directed = await fake.adapter.applyLifecycleDirectives(staged);
  const pinned = await fake.adapter.applyPins(directed);
  return fake.adapter.sealActivation(pinned);
}

async function prepareUpdate(
  fake: FakeLifecycleHost,
  snapshot: FrozenPackageSnapshot & { readonly action: 'update' },
  pins: readonly ResolvedLifecyclePin[] = createResolvedLifecyclePins([]),
): Promise<PreparedActivationMutation> {
  const selection = await selectedActivationRoute(fake, snapshot, 'update', pins);
  const staged = await fake.adapter.stageActivation({ selection, snapshot, pins });
  const directed = await fake.adapter.applyLifecycleDirectives(staged);
  const pinned = await fake.adapter.applyPins(directed);
  return fake.adapter.sealActivation(pinned);
}

async function failure(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectPhaseError(
  error: unknown,
  phase: LifecycleHostPhaseError['phase'],
  category: LifecycleHostPhaseError['reason']['category'],
  mutationStarted: boolean,
): void {
  expect(error instanceof LifecycleHostPhaseError).toBe(true);
  if (!(error instanceof LifecycleHostPhaseError)) return;
  expect(error.phase).toBe(phase);
  expect(error.reason.category).toBe(category);
  expect(error.mutationStarted).toBe(mutationStarted);
}

function recordedActivation(fake: FakeLifecycleHost, fingerprint: string, nonconforming = false): Promise<RecordedOwnedActivation> {
  return fake.adapter.observeTarget(fixtureTarget).then((observed) => {
    const installed = observed.installations[0];
    if (installed === undefined || installed.source === null) throw new Error('fixture activation is missing');
    return createRecordedOwnedActivation({
      scopeId: installed.ownership.kind === 'owned' ? installed.ownership.scopeId : 'scope-demo',
      target: fixtureTarget,
      packageName: installed.packageName ?? 'demo',
      nativeId: installed.nativeId,
      sourceType: installed.source.type,
      sourceRevision: installed.source.immutableRevision,
      sourceLocator: installed.source.locator,
      installedVersion: installed.installedVersion,
      route: 'managed',
      evidenceId: 'recorded-fixture-evidence',
      ownership: { kind: 'created', proofId: 'proof:demo@market' },
      activation: nonconforming ? 'nonconforming' : 'active',
      enablement: 'enabled',
      installedFingerprint: fingerprint,
      contentRoots: installed.contentRoots,
    });
  });
}

async function selectedRecordedRoute(
  fake: FakeLifecycleHost,
  activation: RecordedOwnedActivation,
  operation: 'disable',
  operationId: string,
  attemptId: string,
): Promise<SelectedRouteDecision<SelectedLifecycleRoute, 'disable'>>;
async function selectedRecordedRoute(
  fake: FakeLifecycleHost,
  activation: RecordedOwnedActivation,
  operation: 'retire',
  operationId: string,
  attemptId: string,
): Promise<SelectedRouteDecision<SelectedLifecycleRoute, 'retire'>>;
async function selectedRecordedRoute(
  fake: FakeLifecycleHost,
  activation: RecordedOwnedActivation,
  operation: 'disable' | 'retire',
  operationId: string,
  attemptId: string,
): Promise<SelectedRouteDecision<SelectedLifecycleRoute, 'disable' | 'retire'>> {
  const version = await fake.adapter.probeVersion(activation.target);
  const observed = await fake.adapter.observeTarget(activation.target);
  const nativeScope = await fake.adapter.observeNativeMutationScope({
    targetObservation: observed,
    operation,
    packageName: activation.packageName,
    nativeId: activation.nativeId,
    sourceType: activation.sourceType,
  });
  const nativeProjection = await fake.adapter.observeNativeProjection({
    targetObservation: observed,
    operation,
    operationId,
    attemptId,
    activation,
  });
  const common = {
    target: activation.target,
    operationId,
    attemptId,
    scopeId: activation.scopeId,
    packageName: activation.packageName,
    nativeId: activation.nativeId,
    version,
    sourceType: activation.sourceType,
    targetObservation: observed,
    nativeScope,
    nativeProjection,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId: activation.nativeId,
      operationId,
      operation,
      mutationGroupId: `group:${operationId}`,
      authorization: 'observed-owned',
    }]),
    activation,
  };
  const decision = operation === 'disable'
    ? fake.adapter.decideRoute({ ...common, operation: 'disable' })
    : fake.adapter.decideRoute({ ...common, operation: 'retire' });
  if (decision.kind !== 'selected') throw new Error(`fixture ${operation} route was not selected`);
  return decision;
}

describe('lifecycle mutation boundary', () => {
  test('rejects inactive activation expectations and corrupt durable recovery identities', async () => {
    const badSealRoot = tempRoot('inactive-expectation');
    const profiles = [fixtureProfile({ route: 'managed', operations: ['install'] })];
    const badSeal = new FakeLifecycleHost(join(badSealRoot, 'host'), profiles);
    badSeal.activationExpectation = { enablement: 'disabled', activation: 'inactive' };
    const sealError = await failure(prepareInstall(badSeal, fixtureSnapshot(badSealRoot, {
      operationId: 'op-inactive', attemptId: 'attempt-inactive', action: 'install',
    })));
    expectPhaseError(sealError, 'seal', 'internal', false);
    expect(badSeal.events.some((event) => event.endsWith(':apply'))).toBe(false);

    const root = tempRoot('corrupt-handle');
    const fake = new FakeLifecycleHost(join(root, 'host'), profiles);
    const prepared = await prepareInstall(fake, fixtureSnapshot(root, {
      operationId: 'op-durable', attemptId: 'attempt-durable', action: 'install',
    }));
    const base = JSON.parse(JSON.stringify(prepared.handle)) as Record<string, unknown>;
    const corruptions: Array<(value: Record<string, any>) => void> = [
      (value) => { value.expected.nativeId = 'other@market'; },
      (value) => { value.expected.enablement = 'invalid'; },
      (value) => { value.expected.activation = 'inactive'; },
      (value) => {
        value.affectedNativeIds = ['other@market'];
        value.affectedOperationIds = ['op-durable'];
      },
    ];
    for (const corrupt of corruptions) {
      const value = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      corrupt(value);
      let error: unknown;
      try {
        hydrateDurableLifecycleOperation(value);
      } catch (thrown) {
        error = thrown;
      }
      expect(error instanceof LifecycleHostPhaseError).toBe(true);
    }
  });

  test('rejects stage tampering and live runtime or inventory drift before the first host mutation', async () => {
    for (const mode of ['tamper', 'version', 'inventory'] as const) {
      const root = tempRoot(`precondition-${mode}`);
      const fake = new FakeLifecycleHost(join(root, 'host'), [fixtureProfile({ route: 'managed', operations: ['install'] })]);
      const snapshot = fixtureSnapshot(root, {
        operationId: `op-${mode}`,
        attemptId: `attempt-${mode}`,
        action: 'install',
      });
      const prepared = await prepareInstall(fake, snapshot);
      const before = fake.hostMutationState();
      if (mode === 'tamper') writeFileSync(join(prepared.stagingRoot, 'tampered.txt'), 'changed after seal\n');
      if (mode === 'version') fake.version = '1.0.1';
      if (mode === 'inventory') fake.seedActivation({ nativeId: 'intruder@market', scopeId: 'other', packageName: 'intruder' });

      const error = await failure(fake.adapter.apply(prepared));
      expectPhaseError(error, mode === 'tamper' ? 'apply-integrity' : 'apply-precondition', mode === 'tamper' ? 'internal' : 'runtime', false);
      expect(fake.events.some((event) => event.endsWith(':apply'))).toBe(false);
      if (mode !== 'inventory') expect(fake.hostMutationState()).toBe(before);
    }
  });

  test('never falls back after a Native mutation failure or independent readback mismatch', async () => {
    const profiles = [
      fixtureProfile({ route: 'native', operations: ['install'] }),
      fixtureProfile({ route: 'managed', operations: ['install'] }),
    ];
    const failedRoot = tempRoot('native-failure');
    const failed = new FakeLifecycleHost(join(failedRoot, 'host'), profiles);
    failed.nativeScope = { kind: 'bounded', mode: 'exact-package', affectedNativeIds: ['demo@market'] };
    const failedPrepared = await prepareInstall(failed, fixtureSnapshot(failedRoot, {
      operationId: 'op-native-fail', attemptId: 'attempt-native-fail', action: 'install',
    }));
    expect(failedPrepared.handle.route).toBe('native');
    failed.failPhase = 'native:apply';
    const applyError = await failure(failed.adapter.apply(failedPrepared));
    expectPhaseError(applyError, 'apply', 'runtime', true);
    expect(failed.events.some((event) => event.startsWith('managed:'))).toBe(false);

    const mismatchRoot = tempRoot('native-mismatch');
    const mismatch = new FakeLifecycleHost(join(mismatchRoot, 'host'), profiles);
    mismatch.nativeScope = { kind: 'bounded', mode: 'exact-package', affectedNativeIds: ['demo@market'] };
    const mismatchPrepared = await prepareInstall(mismatch, fixtureSnapshot(mismatchRoot, {
      operationId: 'op-native-mismatch', attemptId: 'attempt-native-mismatch', action: 'install',
    }));
    await mismatch.adapter.apply(mismatchPrepared);
    mismatch.readbackFingerprintOverride = 'f'.repeat(64);
    const observation = await mismatch.adapter.readback(mismatchPrepared.handle);
    let mismatchError: unknown;
    try {
      mismatch.adapter.verify(mismatchPrepared.handle, observation);
    } catch (error) {
      mismatchError = error;
    }
    expect(mismatchError instanceof LifecycleReadbackMismatchError).toBe(true);
    expectPhaseError(mismatchError, 'readback', 'readback', true);
    expect(mismatch.events.some((event) => event.startsWith('managed:'))).toBe(false);
  });

  test('permits exactly one invocation leader for a grouped Native mutation', async () => {
    const root = tempRoot('native-group-leader');
    const fake = new FakeLifecycleHost(join(root, 'host'), [fixtureProfile({ route: 'native', operations: ['update'] })]);
    fake.seedActivation({ nativeId: 'alpha@market', scopeId: 'scope-alpha', packageName: 'alpha' });
    fake.seedActivation({ nativeId: 'demo@market', scopeId: 'scope-demo', packageName: 'demo' });
    fake.nativeScope = {
      kind: 'bounded',
      mode: 'marketplace-wide',
      affectedNativeIds: ['alpha@market', 'demo@market'],
    };
    const snapshot = fixtureSnapshot(root, {
      operationId: 'op-demo', attemptId: 'attempt-demo-follower', action: 'update', version: '1.1.0',
    });
    const pins = createResolvedLifecyclePins([]);
    const version = await fake.adapter.probeVersion(fixtureTarget);
    const observed = await fake.adapter.observeTarget(fixtureTarget);
    const nativeScope = await fake.adapter.observeNativeMutationScope({
      targetObservation: observed,
      operation: 'update',
      packageName: 'demo',
      nativeId: 'demo@market',
      sourceType: 'git',
    });
    const nativeProjection = await fake.adapter.observeNativeProjection({
      targetObservation: observed,
      operation: 'update',
      snapshot,
      pins,
    });
    const decision = fake.adapter.decideRoute({
      target: fixtureTarget,
      operationId: 'op-demo',
      attemptId: 'attempt-demo-follower',
      scopeId: 'scope-demo',
      packageName: 'demo',
      nativeId: 'demo@market',
      version,
      sourceType: 'git',
      targetObservation: observed,
      nativeScope,
      nativeProjection,
      planCoverage: createLifecyclePlanCoverage(observed, [
        {
          nativeId: 'alpha@market', operationId: 'op-alpha', operation: 'update',
          mutationGroupId: 'group-market', authorization: 'observed-owned',
        },
        {
          nativeId: 'demo@market', operationId: 'op-demo', operation: 'update',
          mutationGroupId: 'group-market', authorization: 'observed-owned',
        },
      ]),
      operation: 'update',
      snapshot,
      pins,
    });
    if (decision.kind !== 'selected') throw new Error('grouped fixture route was not selected');
    expect(decision.route).toBe('native');
    expect(decision.mutationInvocationOperationId).toBe('op-alpha');
    const staged = await fake.adapter.stageActivation({ selection: decision, snapshot, pins });
    const directed = await fake.adapter.applyLifecycleDirectives(staged);
    const pinned = await fake.adapter.applyPins(directed);
    const prepared = await fake.adapter.sealActivation(pinned);
    const error = await failure(fake.adapter.apply(prepared));
    expectPhaseError(error, 'apply-precondition', 'internal', false);
    expect(fake.events).toContain('fingerprint');
    expect(fake.events.some((event) => event.endsWith(':apply'))).toBe(false);
  });

  test('rehydrates exact rollback evidence in a fresh adapter process and permits recovery retry', async () => {
    const root = tempRoot('rollback');
    const profiles = [fixtureProfile({ route: 'managed', operations: ['update'] })];
    const fake = new FakeLifecycleHost(join(root, 'host'), profiles);
    const priorFingerprint = fake.seedActivation({ nativeId: 'demo@market', scopeId: 'scope-demo', packageName: 'demo' });
    const prepared = await prepareUpdate(fake, fixtureSnapshot(root, {
      operationId: 'op-update-demo', attemptId: 'attempt-update-demo', action: 'update', version: '1.1.0',
    }));
    await fake.adapter.apply(prepared);
    fake.readbackFingerprintOverride = 'f'.repeat(64);
    const mismatched = await fake.adapter.readback(prepared.handle);
    let mismatch: unknown;
    try {
      fake.adapter.verify(prepared.handle, mismatched);
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch instanceof LifecycleReadbackMismatchError).toBe(true);

    const serialized = JSON.stringify(prepared.handle);
    const hydrated = hydrateDurableLifecycleOperation(JSON.parse(serialized));
    const restarted = new FakeLifecycleHost(join(root, 'host'), profiles);
    restarted.failPhase = 'rollback';
    const rollbackFailure = await failure(restarted.adapter.rollback(hydrated));
    expectPhaseError(rollbackFailure, 'rollback', 'recovery', true);
    expect(existsSync(hydrated.rollbackReference)).toBe(true);
    expect(hydrateDurableLifecycleOperation(JSON.parse(serialized)).operationId).toBe('op-update-demo');

    restarted.failPhase = null;
    const rollbackReceipt = await restarted.adapter.rollback(hydrated);
    expect(rollbackReceipt.phase).toBe('rolled-back');
    const restored = await restarted.adapter.readback(hydrated);
    const verified = restarted.adapter.verifyRollback(hydrated, restored);
    expect(verified.phase).toBe('rollback-verified');
    expect(restored.installedFingerprint).toBe(priorFingerprint);
    expect(restored.enablement).toBe('enabled');
    await restarted.adapter.cleanup(hydrated, 'verified-rollback');
    expect(existsSync(hydrated.rollbackReference)).toBe(false);
  });

  test('disables reversibly, retires owned activation while retaining data, and reports transition evidence', async () => {
    const root = tempRoot('disable-retire');
    const profiles = [fixtureProfile({ route: 'managed', operations: ['disable', 'retire'] })];
    const fake = new FakeLifecycleHost(join(root, 'host'), profiles);
    fake.expectedTransition = { requirement: 'restart', status: 'effective' };
    const initialPluginData = 'plugin-created-data\n';
    const initialMetadata = '{"disabledReason":"policy"}\n';
    const fingerprint = fake.seedActivation({
      nativeId: 'demo@market', scopeId: 'scope-demo', packageName: 'demo',
      pluginData: initialPluginData, inactiveMetadata: initialMetadata,
    });
    const activation = await recordedActivation(fake, fingerprint, true);
    const disableSelection = await selectedRecordedRoute(fake, activation, 'disable', 'op-disable', 'attempt-disable');
    const beforeDisable = fake.hostMutationState();
    const preparedDisable = await fake.adapter.prepareDisable({
      operationId: 'op-disable', attemptId: 'attempt-disable', selection: disableSelection, activation,
    });
    expect(fake.hostMutationState()).toBe(beforeDisable);
    await fake.adapter.disable(preparedDisable);
    fake.transition = { requirement: 'restart', status: 'pending' };
    const pendingDisable = await fake.adapter.readback(preparedDisable.handle);
    let pendingError: unknown;
    try {
      fake.adapter.verify(preparedDisable.handle, pendingDisable);
    } catch (error) {
      pendingError = error;
    }
    expect(pendingError instanceof LifecycleReadbackMismatchError).toBe(true);
    expect(pendingDisable.transition).toEqual({ requirement: 'restart', status: 'pending' });
    fake.transition = { requirement: 'restart', status: 'effective' };
    const disabled = await fake.adapter.readback(preparedDisable.handle);
    fake.adapter.verify(preparedDisable.handle, disabled);
    expect(disabled.installedFingerprint).toBe(fingerprint);
    expect(disabled.activation).toBe('inactive');
    await fake.adapter.rollback(preparedDisable.handle);
    fake.transition = { requirement: 'none', status: 'effective' };
    fake.adapter.verifyRollback(preparedDisable.handle, await fake.adapter.readback(preparedDisable.handle));

    const retirementActivation = await recordedActivation(fake, fingerprint);
    fake.expectedTransition = { requirement: 'none', status: 'effective' };
    const retireSelection = await selectedRecordedRoute(fake, retirementActivation, 'retire', 'op-retire', 'attempt-retire');
    const preparedRetirement = await fake.adapter.prepareRetirement({
      operationId: 'op-retire',
      attemptId: 'attempt-retire',
      action: 'retire-orphan',
      selection: retireSelection,
      activation: retirementActivation,
    });
    await fake.adapter.retire(preparedRetirement);
    const retired = await fake.adapter.readback(preparedRetirement.handle);
    fake.adapter.verify(preparedRetirement.handle, retired);
    expect(retired.presence).toBe('absent');
    expect(retired.retention.pluginData.state).toBe('present');
    expect(retired.retention.inactiveMetadata.state).toBe('present');
    expect(retired.retention).toEqual(preparedRetirement.handle.prior.retention);
    expect(fake.pluginData('demo@market')).toBe(initialPluginData);
    expect(fake.inactiveMetadata('demo@market')).toBe(initialMetadata);
  });

  test('keeps a verified activation and durable recovery evidence when cleanup fails, then resumes cleanup', async () => {
    const root = tempRoot('cleanup');
    const profiles = [fixtureProfile({ route: 'managed', operations: ['install'] })];
    const fake = new FakeLifecycleHost(join(root, 'host'), profiles);
    const prepared = await prepareInstall(fake, fixtureSnapshot(root, {
      operationId: 'op-cleanup', attemptId: 'attempt-cleanup', action: 'install',
    }));
    await fake.adapter.apply(prepared);
    fake.adapter.verify(prepared.handle, await fake.adapter.readback(prepared.handle));
    fake.failPhase = 'cleanup:verified-commit';
    const cleanupError = await failure(fake.adapter.cleanup(prepared.handle, 'verified-commit'));
    expectPhaseError(cleanupError, 'cleanup', 'recovery', true);
    expect(fake.installedFingerprint('demo@market')).toBe(prepared.handle.projectedFingerprint);
    expect(existsSync(prepared.handle.rollbackReference)).toBe(true);

    const restarted = new FakeLifecycleHost(join(root, 'host'), profiles);
    const hydrated = hydrateDurableLifecycleOperation(JSON.parse(JSON.stringify(prepared.handle)));
    await restarted.adapter.cleanup(hydrated, 'verified-commit');
    expect(restarted.installedFingerprint('demo@market')).toBe(prepared.handle.projectedFingerprint);
    expect(existsSync(hydrated.rollbackReference)).toBe(false);
  });

  test('classifies arbitrary thrown values by phase and never manufactures a capability gap', async () => {
    const root = tempRoot('taxonomy');
    const profiles = [fixtureProfile({ route: 'managed', operations: ['install'] })];
    const fake = new FakeLifecycleHost(join(root, 'host'), profiles);
    const hostile = new Proxy({}, {
      getPrototypeOf() { throw new Error('hostile prototype'); },
      get() { throw new Error('hostile conversion'); },
    });
    fake.failPhase = 'version';
    fake.failureValue = hostile;
    const versionError = await failure(fake.adapter.probeVersion(fixtureTarget));
    expectPhaseError(versionError, 'version', 'internal', false);

    fake.failPhase = null;
    const snapshot = fixtureSnapshot(root, {
      operationId: 'op-taxonomy', attemptId: 'attempt-taxonomy', action: 'install',
    });
    const selection = await selectedActivationRoute(fake, snapshot, 'install', createResolvedLifecyclePins([]));
    fake.failPhase = 'stage';
    fake.failureValue = 'stage exploded';
    const stageError = await failure(fake.adapter.stageActivation({ selection, snapshot, pins: [] }));
    expectPhaseError(stageError, 'stage', 'internal', false);

    fake.failPhase = null;
    const prepared = await prepareInstall(fake, fixtureSnapshot(root, {
      operationId: 'op-taxonomy-apply', attemptId: 'attempt-taxonomy-apply', action: 'install',
    }));
    fake.failPhase = 'managed:apply';
    fake.failureValue = new Error('apply exploded');
    const applyError = await failure(fake.adapter.apply(prepared));
    expectPhaseError(applyError, 'apply', 'runtime', true);

    fake.failPhase = null;
    await fake.adapter.apply(prepared);
    fake.failPhase = 'readback';
    const readbackError = await failure(fake.adapter.readback(prepared.handle));
    expectPhaseError(readbackError, 'readback', 'readback', true);
  });
});
