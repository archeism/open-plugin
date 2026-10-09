/**
 * Writer-only lifecycle runtime. Readers and doctor may import declarations
 * from lifecycle-host with `import type`, but must never load this module.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import {
  admitPackageSemanticsFromProfiles,
  type CapabilityEvidenceProfile,
  type PackageAdmission,
  type PackageAdmissionRequest,
} from './capability-evidence';
import { unknownErrorDiagnostic } from './error-diagnostic';
import { fingerprintTree } from './fingerprint';
import { createLifecycleReason, type LifecycleReason } from './lifecycle-report';
import { validateSourceBinding, validateStableIdentityString } from './source-reference';
import { parsePersistedTargetIdentity } from './target-identity';
import type {
  ActivationMutationAction,
  ActivationPreparationCapture,
  ActivationPreparationRequest,
  ActivationTransitionObservation,
  CapabilityGapReason,
  CapabilityGapRouteDecision,
  CleanupDisposition,
  CleanupReference,
  CleanupResultData,
  ContentRootObservation,
  DirectivesAppliedProjection,
  DisablePreparationRequest,
  DurableLifecycleOperation,
  FrozenPackageSnapshot,
  FrozenPackageSnapshotInput,
  LifecycleHostAdapter,
  LifecycleHostDefinition,
  LifecycleMutationAction,
  LifecyclePlanCoverage,
  LifecycleReadbackData,
  LifecycleReadbackObservation,
  LifecycleRouteDecision,
  LifecycleRouteRequest,
  LifecycleTargetIdentity,
  MutationReceipt,
  NativeProjectionData,
  NativeProjectionObservation,
  NativeProjectionRequest,
  NativeMutationScopeData,
  NativeMutationScopeObservation,
  NativeMutationScopeRequest,
  NonEmptyCapabilityGaps,
  PinsAppliedProjection,
  PreparedActivationMutation,
  PreparedDisableMutation,
  PreparedLifecycleMutation,
  PreparedRetirementMutation,
  RecordedOwnedActivation,
  RecordedOwnedActivationInput,
  ResolvedLifecyclePin,
  RetirementMutationAction,
  RetirementPreparationRequest,
  RollbackReceipt,
  SelectedLifecycleRoute,
  SelectedRouteDecision,
  StagedProjection,
  TargetInstallationData,
  TargetInventoryData,
  TargetInventoryObservation,
  TargetVersionObservation,
  VerifiedMutation,
  VerifiedRollback,
} from './lifecycle-host';
import type { CapabilityOperation, PackageSemanticInventory, SourceType } from './semantic-inventory';

import { CryptoHasher } from './runtime';


export type LifecycleHostPhase =
  | 'version'
  | 'inventory'
  | 'native-scope'
  | 'native-projection'
  | 'route'
  | 'stage'
  | 'directives'
  | 'pins'
  | 'seal'
  | 'apply-integrity'
  | 'apply-precondition'
  | 'apply'
  | 'disable'
  | 'retire'
  | 'readback'
  | 'rollback'
  | 'cleanup';

/** Thrown hook values are classified by phase and can never become capability gaps. */
export class LifecycleHostPhaseError extends Error {
  constructor(
    readonly phase: LifecycleHostPhase,
    readonly reason: Exclude<LifecycleReason, { category: 'capability' }>,
    readonly thrown: unknown,
    readonly mutationStarted: boolean,
  ) {
    super(reason.diagnostic);
    this.name = 'LifecycleHostPhaseError';
  }
}

export class LifecycleReadbackMismatchError extends LifecycleHostPhaseError {
  constructor(diagnostic: string) {
    const reason = createLifecycleReason('readback', 'readback.mismatch', diagnostic);
    super('readback', reason, reason, true);
    this.name = 'LifecycleReadbackMismatchError';
  }
}

export function createTargetInventoryObservation(
  adapterId: string,
  input: TargetInventoryData,
): TargetInventoryObservation {
  stable(adapterId, 'lifecycle adapter id');
  const target = frozenTarget(input.target);
  const installations = [...input.installations]
    .map(normalizeInstallation)
    .sort((left, right) => compare(left.nativeId, right.nativeId));
  unique(installations.map(({ nativeId }) => nativeId), 'target inventory native id');
  const addressable = { schemaVersion: 1 as const, adapterId, target, installations };
  return deepFreeze({
    ...addressable,
    observationId: contentAddress(addressable),
  }) as unknown as TargetInventoryObservation;
}

export function createNativeMutationScopeObservation(
  target: TargetInventoryObservation,
  input: NativeMutationScopeData,
): NativeMutationScopeObservation {
  if (input.kind !== 'bounded') {
    return deepFreeze({ kind: input.kind, targetObservationId: target.observationId }) as unknown as NativeMutationScopeObservation;
  }
  const affectedNativeIds = sortedUnique(input.affectedNativeIds, 'native mutation affected id');
  if (affectedNativeIds.length === 0) invariant('native mutation scope must affect at least one native id');
  return deepFreeze({
    kind: 'bounded',
    mode: input.mode,
    affectedNativeIds,
    targetObservationId: target.observationId,
  }) as unknown as NativeMutationScopeObservation;
}

export function createLifecyclePlanCoverage(
  target: TargetInventoryObservation,
  operations: readonly {
    readonly nativeId: string;
    readonly operationId: string;
    readonly operation: CapabilityOperation;
    readonly mutationGroupId: string;
    readonly authorization: 'observed-owned' | 'planned-create';
  }[],
): LifecyclePlanCoverage {
  const normalized = operations.map(({ nativeId, operationId, operation, mutationGroupId, authorization }) => ({
    nativeId: stableCopy(nativeId, 'plan coverage native id'),
    operationId: stableCopy(operationId, 'plan coverage operation id'),
    operation,
    mutationGroupId: stableCopy(mutationGroupId, 'plan coverage mutation group id'),
    authorization,
  })).sort((left, right) => compare(left.nativeId, right.nativeId));
  for (const entry of normalized) {
    if (!['install', 'update', 'disable', 'retire'].includes(entry.operation)) invariant('plan coverage operation is invalid');
  }
  unique(normalized.map(({ nativeId }) => nativeId), 'plan coverage native id');
  unique(normalized.map(({ operationId }) => operationId), 'plan coverage operation id');
  const observed = new Map(target.installations.map((installation) => [installation.nativeId, installation]));
  for (const { nativeId, authorization } of normalized) {
    const installation = observed.get(nativeId);
    if (authorization === 'observed-owned') {
      if (installation === undefined || installation.ownership.kind !== 'owned') {
        invariant(`plan coverage native id '${nativeId}' is not ownership-proven in target observation '${target.observationId}'`);
      }
    } else if (authorization === 'planned-create') {
      if (installation !== undefined && (installation.presence !== 'absent' || installation.ownership.kind === 'ambiguous')) {
        invariant(`planned-create native id '${nativeId}' collides with target observation '${target.observationId}'`);
      }
    } else {
      invariant('plan coverage authorization is invalid');
    }
  }
  return deepFreeze({
    targetObservationId: target.observationId,
    operations: normalized,
  }) as unknown as LifecyclePlanCoverage;
}

export function createNativeProjectionObservation(
  request: NativeProjectionRequest,
  input: NativeProjectionData,
): NativeProjectionObservation {
  const binding = nativeProjectionBinding(request);
  const detail = input.kind === 'equivalent'
    ? { kind: input.kind, proofId: stableCopy(input.proofId, 'native projection proof id') }
    : { kind: input.kind, reasonId: stableCopy(input.reasonId, 'native projection reason id') };
  return deepFreeze({
    ...detail,
    targetObservationId: request.targetObservation.observationId,
    operationId: binding.operationId,
    attemptId: binding.attemptId,
    inputId: contentAddress(binding),
  }) as unknown as NativeProjectionObservation;
}

/**
 * Pure native-first route choice. Unsafe or unbounded native blast radius is
 * refused before preparation; Managed is considered only in this phase.
 */
export function selectLifecycleRoute<Operation extends CapabilityOperation>(
  adapterId: string,
  profiles: readonly CapabilityEvidenceProfile[],
  request: LifecycleRouteRequest<Operation>,
): LifecycleRouteDecision<Operation> {
  try {
    stable(adapterId, 'lifecycle adapter id');
    const target = frozenTarget(request.target);
    stable(request.operationId, 'route operation id');
    stable(request.attemptId, 'route attempt id');
    stable(request.scopeId, 'route scope id');
    stable(request.packageName, 'route package name');
    stable(request.nativeId, 'route native id');
    assertRouteObservationBindings(adapterId, target, request);
    const detectedVersion = request.version.kind === 'detected'
      ? normalizedVersion(request.version.version)
      : undefined;
    const nativeAdmission = admissionFor(request, adapterId, detectedVersion, 'native', profiles);
    const managedAdmission = admissionFor(request, adapterId, detectedVersion, 'managed', profiles);
    const nativeScopeSafe = nativeMutationScopeIsCovered(request);
    const nativeProjectionSafe = nativeProjectionIsProven(request);
    const nativeGaps = nativeAdmission.status === 'refused'
      ? nativeAdmission.gaps
      : nativeScopeSafe && nativeProjectionSafe
        ? []
        : [createLifecycleReason(
            'capability',
            'capability.unverified',
            !nativeScopeSafe
              ? `target '${adapterId}' Native ${request.operation} scope is not bounded by ownership-proven in-plan native identities`
              : `target '${adapterId}' Native ${request.operation} projection is not proven equivalent for the frozen operation input`,
            !nativeScopeSafe ? 'bounded-mutation-scope' : 'native-projection-equivalence',
            nativeAdmission.profile?.evidenceId ?? null,
          )];

    if (detectedVersion !== undefined && nativeAdmission.status === 'admitted' && nativeScopeSafe && nativeProjectionSafe) {
      return selectedDecision(adapterId, target, request, detectedVersion, 'native', nativeAdmission);
    }
    if (detectedVersion !== undefined && managedAdmission.status === 'admitted') {
      return selectedDecision(adapterId, target, request, detectedVersion, 'managed', managedAdmission);
    }

    const gaps = dedupeGaps([...nativeGaps, ...managedAdmission.gaps]);
    if (gaps.length === 0) invariant('a refused route decision must retain at least one capability gap');
    return deepFreeze({
      kind: 'capability-gap',
      adapterId,
      target,
      targetObservationId: request.targetObservation.observationId,
      operation: request.operation,
      operationId: request.operationId,
      attemptId: request.attemptId,
      scopeId: request.scopeId,
      packageName: request.packageName,
      nativeId: request.nativeId,
      sourceType: request.sourceType,
      status: gaps.some(({ code }) => code === 'capability.unverified') ? 'unverified' : 'unsupported',
      gaps,
    }) as unknown as CapabilityGapRouteDecision<Operation>;
  } catch (error) {
    if (isLifecycleHostPhaseError(error)) throw error;
    throw phaseError('route', 'internal.invariant', error);
  }
}

export function createFrozenPackageSnapshot(input: FrozenPackageSnapshotInput): FrozenPackageSnapshot {
  stable(input.operationId, 'lifecycle operation id');
  stable(input.attemptId, 'lifecycle attempt id');
  stable(input.scopeId, 'deployment scope id');
  stable(input.packageName, 'package name');
  stable(input.nativeId, 'native id');
  stable(input.immutableRevision, 'immutable Source revision');
  if (input.sourceType === 'git') immutableGitRevision(input.immutableRevision);
  const target = frozenTarget(input.target);
  const snapshotRoot = canonicalAbsolute(input.snapshotRoot, 'Source snapshot root');
  const packageRoot = canonicalAbsolute(input.packageRoot, 'frozen package root');
  const derivedRelative = relative(snapshotRoot, packageRoot) || '.';
  if (derivedRelative === '..' || derivedRelative.startsWith('../') || isAbsolute(derivedRelative)) {
    invariant('frozen package root escapes its Source snapshot');
  }
  if (input.relativePackagePath !== derivedRelative) {
    invariant(`frozen package relative path must be '${derivedRelative}'`);
  }
  fingerprint(input.snapshotFingerprint, 'Source snapshot fingerprint');
  fingerprint(input.packageFingerprint, 'package fingerprint');
  if (fingerprintTree(snapshotRoot) !== input.snapshotFingerprint) invariant('Source snapshot fingerprint does not match frozen bytes');
  if (fingerprintTree(packageRoot) !== input.packageFingerprint) invariant('package fingerprint does not match frozen bytes');
  if (input.inventory.package.name !== input.packageName || input.inventory.package.fingerprint !== input.packageFingerprint) {
    invariant('semantic inventory identity does not match the frozen package');
  }
  const nativeGit = normalizeNativeGit(input.sourceType, input.immutableRevision, input.nativeGit);
  return deepFreeze({
    schemaVersion: 1,
    ...input,
    target,
    snapshotRoot,
    packageRoot,
    ...(nativeGit === undefined ? { nativeGit: undefined } : { nativeGit }),
    inventory: clonePlain(input.inventory, 'semantic inventory') as PackageSemanticInventory,
  }) as unknown as FrozenPackageSnapshot;
}

export function createResolvedLifecyclePins(input: readonly ResolvedLifecyclePin[]): readonly ResolvedLifecyclePin[] {
  const pins = input.map(({ server, executable }) => {
    stable(server, 'pin server');
    if (!isAbsolute(executable) || resolve(executable) !== executable) invariant(`pin executable must be a canonical absolute path: ${executable}`);
    return Object.freeze({ server, executable });
  });
  const canonical = [...pins].sort((left, right) => compare(left.server, right.server) || compare(left.executable, right.executable));
  if (JSON.stringify(pins) !== JSON.stringify(canonical)) invariant('lifecycle pins must already be persisted in canonical sorted order');
  unique(pins.map(({ server }) => server), 'pin server');
  return Object.freeze(pins);
}

export function createRecordedOwnedActivation(input: RecordedOwnedActivationInput): RecordedOwnedActivation {
  stable(input.scopeId, 'activation scope id');
  stable(input.packageName, 'activation package name');
  stable(input.nativeId, 'activation native id');
  stable(input.sourceRevision, 'activation Source revision');
  if (input.installedVersion !== null) stable(input.installedVersion, 'activation installed version');
  const sourceLocator = normalizeSourceLocator(input.sourceType, input.sourceRevision, input.sourceLocator);
  stable(input.evidenceId, 'activation evidence id');
  stable(input.ownership.proofId, 'activation ownership proof id');
  fingerprint(input.installedFingerprint, 'activation installed fingerprint');
  const contentRoots = normalizeContentRoots(input.contentRoots, true);
  return deepFreeze({
    schemaVersion: 1,
    ...input,
    target: frozenTarget(input.target),
    sourceLocator,
    ownership: { ...input.ownership },
    contentRoots,
  }) as unknown as RecordedOwnedActivation;
}

export function createLifecycleHostAdapter(definition: LifecycleHostDefinition): LifecycleHostAdapter {
  stable(definition.id, 'lifecycle adapter id');
  const profiles = Object.freeze([...definition.evidenceProfiles]);
  for (const profile of profiles) {
    if (profile.host !== definition.id) invariant(`lifecycle adapter '${definition.id}' cannot use evidence for '${profile.host}'`);
  }

  const adapter: LifecycleHostAdapter = {
    id: definition.id,

    async probeVersion(target) {
      const frozen = frozenTarget(target);
      const observation = await invokePhase('version', () => definition.probeVersion(frozen));
      return normalizeVersionObservation(observation);
    },

    async observeTarget(target) {
      const frozen = frozenTarget(target);
      const data = await invokePhase('inventory', () => definition.observeTarget(frozen));
      try {
        if (!sameTarget(frozen, data.target)) invariant('target inventory observation changed target identity');
        return createTargetInventoryObservation(definition.id, data);
      } catch (error) {
        if (isLifecycleHostPhaseError(error)) throw error;
        throw phaseError('inventory', 'internal.invariant', error);
      }
    },

    async observeNativeMutationScope(request) {
      assertAdapterObservation(definition.id, request.targetObservation);
      const frozenRequest = deepFreeze({
        ...request,
        packageName: stableCopy(request.packageName, 'package name'),
        nativeId: stableCopy(request.nativeId, 'native id'),
      }) as NativeMutationScopeRequest;
      const data = await invokePhase('native-scope', () => definition.observeNativeMutationScope(frozenRequest));
      try {
        return createNativeMutationScopeObservation(request.targetObservation, data);
      } catch (error) {
        if (isLifecycleHostPhaseError(error)) throw error;
        throw phaseError('native-scope', 'internal.invariant', error);
      }
    },

    async observeNativeProjection(request) {
      assertAdapterObservation(definition.id, request.targetObservation);
      const frozenRequest = freezeNativeProjectionRequest(request);
      const data = await invokePhase('native-projection', () => definition.observeNativeProjection(frozenRequest));
      try {
        return createNativeProjectionObservation(frozenRequest, data);
      } catch (error) {
        if (isLifecycleHostPhaseError(error)) throw error;
        throw phaseError('native-projection', 'internal.invariant', error);
      }
    },

    decideRoute(request) {
      return selectLifecycleRoute(definition.id, profiles, request);
    },

    async stageActivation(request) {
      assertActivationPreparationRequest(definition.id, request);
      const pins = createResolvedLifecyclePins(request.pins);
      const frozenRequest = deepFreeze({ ...request, pins }) as typeof request;
      const artifact = await invokePhase('stage', () => definition.stageActivation(frozenRequest));
      stable(artifact.stagingId, 'staging id');
      const stagingRoot = canonicalAbsolute(artifact.stagingRoot, 'staging root');
      return deepFreeze({
        phase: 'staged',
        ...projectionBinding(definition.id, frozenRequest, artifact.stagingId, stagingRoot),
      }) as unknown as StagedProjection<any, any>;
    },

    async applyLifecycleDirectives(projection) {
      assertProjection(definition.id, projection, 'staged');
      const directiveIds = sortedStable(await invokePhase('directives', () => definition.applyLifecycleDirectives(projection)), 'directive id');
      return deepFreeze({
        ...projection,
        phase: 'directives-applied',
        directiveIds,
      }) as unknown as DirectivesAppliedProjection<any, any>;
    },

    async applyPins(projection) {
      assertProjection(definition.id, projection, 'directives-applied');
      const appliedPinServers = sortedStable(await invokePhase('pins', () => definition.applyPins(projection)), 'applied pin server');
      const expected = projection.pins.map(({ server }) => server);
      if (JSON.stringify(appliedPinServers) !== JSON.stringify(expected)) {
        throw phaseError('pins', 'internal.invariant', new Error('adapter pin proof does not match the persisted pin set'));
      }
      return deepFreeze({
        ...projection,
        phase: 'pins-applied',
        appliedPinServers,
      }) as unknown as PinsAppliedProjection<any, any>;
    },

    async sealActivation(projection) {
      assertProjection(definition.id, projection, 'pins-applied');
      let projectedFingerprint: string;
      try {
        projectedFingerprint = fingerprintTree(projection.stagingRoot);
      } catch (error) {
        throw phaseError('seal', 'internal.invariant', error);
      }
      const capture = await invokePhase('seal', () => definition.captureActivationPreparation(projection, projectedFingerprint));
      return preparedActivation(definition.id, projection, projectedFingerprint, capture);
    },

    async prepareDisable(request) {
      assertSelected(definition.id, request.selection, 'disable');
      assertActivationSelection(request.activation, request.selection);
      stable(request.operationId, 'lifecycle operation id');
      stable(request.attemptId, 'lifecycle attempt id');
      if (request.operationId !== request.selection.operationId || request.attemptId !== request.selection.attemptId) {
        throw phaseError('seal', 'internal.invariant', new Error('disable preparation identity does not match the selected route'));
      }
      if (request.activation.activation !== 'nonconforming' || request.activation.enablement !== 'enabled') {
        throw phaseError('seal', 'internal.invariant', new Error('disablement requires an enabled, proven nonconforming activation'));
      }
      const frozenRequest = deepFreeze({ ...request }) as typeof request;
      const capture = await invokePhase('seal', () => definition.captureDisablePreparation(frozenRequest));
      assertRollbackCoverage(capture.rollbackCoverageOperationIds, request.selection.affectedOperationIds);
      const prior = normalizeReadback(capture.prior);
      assertPriorMatchesActivation(prior, request.activation);
      const transition = normalizeTransition(capture.transition);
      const expected = normalizeReadback({
        ...prior,
        route: request.selection.route,
        enablement: 'disabled',
        activation: 'inactive',
        transition,
      });
      const handle = durableHandle({
        adapterId: definition.id,
        target: request.activation.target,
        targetObservationId: request.selection.targetObservationId,
        operationId: request.operationId,
        attemptId: request.attemptId,
        scopeId: request.activation.scopeId,
        packageName: request.activation.packageName,
        nativeId: request.activation.nativeId,
        sourceType: request.activation.sourceType,
        sourceRevision: request.activation.sourceRevision,
        sourceLocator: request.activation.sourceLocator,
        packageVersion: request.activation.installedVersion,
        action: 'disable-nonconforming',
        route: request.selection.route,
        detectedVersion: request.selection.detectedVersion,
        versionProbeId: request.selection.versionProbeId,
        evidenceId: request.selection.evidenceId,
        mutationGroupId: request.selection.mutationGroupId,
        mutationInvocationOperationId: request.selection.mutationInvocationOperationId,
        affectedNativeIds: request.selection.affectedNativeIds,
        affectedOperationIds: request.selection.affectedOperationIds,
        artifactId: null,
        projectedFingerprint: null,
        prior,
        expected,
        rollbackReference: capture.rollbackReference,
      });
      return deepFreeze({ phase: 'prepared', kind: 'disable', handle }) as unknown as PreparedDisableMutation<any>;
    },

    async prepareRetirement(request) {
      assertSelected(definition.id, request.selection, 'retire');
      assertActivationSelection(request.activation, request.selection);
      stable(request.operationId, 'lifecycle operation id');
      stable(request.attemptId, 'lifecycle attempt id');
      if (request.operationId !== request.selection.operationId || request.attemptId !== request.selection.attemptId) {
        throw phaseError('seal', 'internal.invariant', new Error('retirement preparation identity does not match the selected route'));
      }
      const frozenRequest = deepFreeze({ ...request }) as typeof request;
      const capture = await invokePhase('seal', () => definition.captureRetirementPreparation(frozenRequest));
      assertRollbackCoverage(capture.rollbackCoverageOperationIds, request.selection.affectedOperationIds);
      const prior = normalizeReadback(capture.prior);
      assertPriorMatchesActivation(prior, request.activation);
      if (!hasExactRetentionObservation(prior.retention)) {
        throw phaseError('seal', 'internal.invariant', new Error('retirement requires exact prior plugin-data and inactive-metadata observations'));
      }
      const expected = normalizeReadback({
        ...prior,
        route: request.selection.route,
        presence: 'absent',
        enablement: 'disabled',
        activation: 'inactive',
        transition: normalizeTransition(capture.transition),
        installedFingerprint: null,
        contentRoots: [],
        retention: prior.retention,
      });
      const handle = durableHandle({
        adapterId: definition.id,
        target: request.activation.target,
        targetObservationId: request.selection.targetObservationId,
        operationId: request.operationId,
        attemptId: request.attemptId,
        scopeId: request.activation.scopeId,
        packageName: request.activation.packageName,
        nativeId: request.activation.nativeId,
        sourceType: request.activation.sourceType,
        sourceRevision: request.activation.sourceRevision,
        sourceLocator: request.activation.sourceLocator,
        packageVersion: request.activation.installedVersion,
        action: request.action,
        route: request.selection.route,
        detectedVersion: request.selection.detectedVersion,
        versionProbeId: request.selection.versionProbeId,
        evidenceId: request.selection.evidenceId,
        mutationGroupId: request.selection.mutationGroupId,
        mutationInvocationOperationId: request.selection.mutationInvocationOperationId,
        affectedNativeIds: request.selection.affectedNativeIds,
        affectedOperationIds: request.selection.affectedOperationIds,
        artifactId: null,
        projectedFingerprint: null,
        prior,
        expected,
        rollbackReference: capture.rollbackReference,
      });
      return deepFreeze({ phase: 'prepared', kind: 'retirement', handle }) as unknown as PreparedRetirementMutation<any, any>;
    },

    async apply(prepared) {
      assertPrepared(definition.id, prepared, 'activation');
      const expectedFingerprint = prepared.handle.projectedFingerprint;
      if (expectedFingerprint === null || fingerprintTree(prepared.stagingRoot) !== expectedFingerprint) {
        throw phaseError('apply-integrity', 'internal.invariant', new Error('sealed staged projection changed before apply'));
      }
      assertMutationLeader(prepared.handle);
      await revalidateTargetPrecondition(definition, prepared.handle);
      const result = await invokePhase('apply', () => definition.apply(prepared));
      return mutationReceipt(prepared.handle, result);
    },

    async disable(prepared) {
      assertPrepared(definition.id, prepared, 'disable');
      assertMutationLeader(prepared.handle);
      await revalidateTargetPrecondition(definition, prepared.handle);
      const result = await invokePhase('disable', () => definition.disable(prepared));
      return mutationReceipt(prepared.handle, result);
    },

    async retire(prepared) {
      assertPrepared(definition.id, prepared, 'retirement');
      assertMutationLeader(prepared.handle);
      await revalidateTargetPrecondition(definition, prepared.handle);
      const result = await invokePhase('retire', () => definition.retire(prepared));
      return mutationReceipt(prepared.handle, result);
    },

    async readback(handle) {
      assertHandle(definition.id, handle);
      const data = await invokePhase('readback', () => definition.readback(handle));
      return deepFreeze({ ...normalizeReadback(data), phase: 'observed' }) as LifecycleReadbackObservation;
    },

    verify(handle, observation) {
      assertHandle(definition.id, handle);
      assertReadbackMatch(handle.expected, observation, 'applied mutation');
      return deepFreeze({ phase: 'verified', handle, observation }) as VerifiedMutation<any, any>;
    },

    async rollback(handle) {
      assertHandle(definition.id, handle);
      assertMutationLeader(handle);
      const result = await invokePhase('rollback', () => definition.rollback(handle));
      const receipt = checkedMutationResult(result);
      return deepFreeze({ phase: 'rolled-back', handle, ...receipt }) as RollbackReceipt<any, any>;
    },

    verifyRollback(handle, observation) {
      assertHandle(definition.id, handle);
      assertReadbackMatch(handle.prior, observation, 'rollback');
      return deepFreeze({ phase: 'rollback-verified', handle, observation }) as VerifiedRollback<any, any>;
    },

    async cleanup(target, disposition) {
      const reference = cleanupReference(definition.id, target);
      if (isPreparationProjection(target) && disposition !== 'aborted-preparation') {
        throw phaseError('cleanup', 'internal.invariant', new Error('unverified preparation can only use aborted-preparation cleanup'));
      }
      const result = await invokePhase('cleanup', () => definition.cleanup(reference, disposition));
      stable(result.cleanupId, 'cleanup receipt id');
      if (result.completed !== true) invariant('cleanup result must be completed');
      return deepFreeze({ cleanupId: result.cleanupId, completed: true });
    },
  };
  return Object.freeze(adapter);
}

async function revalidateTargetPrecondition(
  definition: LifecycleHostDefinition,
  handle: DurableLifecycleOperation,
): Promise<void> {
  const observed = await invokePhase(
    'apply-precondition',
    () => definition.revalidateTargetPrecondition(handle),
  );
  const version = normalizeVersionObservation(observed.version);
  stable(observed.targetObservationId, 'precondition target observation id');
  if (version.kind !== 'detected'
    || version.version !== handle.detectedVersion
    || version.probeId !== handle.versionProbeId
    || observed.targetObservationId !== handle.targetObservationId) {
    throw phaseError(
      'apply-precondition',
      'runtime.operation-failed',
      new Error('live target version/probe or inventory identity changed after route preflight; refusing mutation'),
    );
  }
}

function assertMutationLeader(handle: DurableLifecycleOperation): void {
  if (handle.operationId !== handle.mutationInvocationOperationId) {
    throw phaseError(
      'apply-precondition',
      'internal.invariant',
      new Error(`operation '${handle.operationId}' is a grouped Native follower; '${handle.mutationInvocationOperationId}' owns the single mutation invocation`),
    );
  }
}

/** Rehydrate a serializable operation journal without requiring an apply receipt or closure. */
export function hydrateDurableLifecycleOperation(value: unknown): DurableLifecycleOperation {
  const input = record(value, 'durable lifecycle operation');
  exactFields(input, [
    'schemaVersion', 'adapterId', 'target', 'targetObservationId', 'operationId', 'attemptId', 'scopeId',
    'packageName', 'nativeId', 'sourceType', 'sourceRevision', 'sourceLocator', 'packageVersion',
    'action', 'route', 'detectedVersion', 'versionProbeId', 'evidenceId', 'mutationGroupId',
    'mutationInvocationOperationId', 'artifactId',
    'projectedFingerprint', 'affectedNativeIds', 'affectedOperationIds', 'prior', 'expected', 'rollbackReference',
  ], 'durable lifecycle operation');
  if (input['schemaVersion'] !== 1) invariant('durable lifecycle operation schemaVersion must be 1');
  return durableHandle({
    adapterId: stringField(input, 'adapterId'),
    target: input['target'] as LifecycleTargetIdentity,
    targetObservationId: stringField(input, 'targetObservationId'),
    operationId: stringField(input, 'operationId'),
    attemptId: stringField(input, 'attemptId'),
    scopeId: stringField(input, 'scopeId'),
    packageName: stringField(input, 'packageName'),
    nativeId: stringField(input, 'nativeId'),
    sourceType: sourceTypeField(input['sourceType']),
    sourceRevision: stringField(input, 'sourceRevision'),
    sourceLocator: nullableString(input['sourceLocator'], 'sourceLocator'),
    packageVersion: nullableString(input['packageVersion'], 'packageVersion'),
    action: actionField(input['action']),
    route: routeField(input['route']),
    detectedVersion: stringField(input, 'detectedVersion'),
    versionProbeId: stringField(input, 'versionProbeId'),
    evidenceId: stringField(input, 'evidenceId'),
    mutationGroupId: stringField(input, 'mutationGroupId'),
    mutationInvocationOperationId: stringField(input, 'mutationInvocationOperationId'),
    affectedNativeIds: stringArrayField(input['affectedNativeIds'], 'affectedNativeIds'),
    affectedOperationIds: stringArrayField(input['affectedOperationIds'], 'affectedOperationIds'),
    artifactId: nullableString(input['artifactId'], 'artifactId'),
    projectedFingerprint: nullableString(input['projectedFingerprint'], 'projectedFingerprint'),
    prior: readbackField(input['prior'], 'prior'),
    expected: readbackField(input['expected'], 'expected'),
    rollbackReference: stringField(input, 'rollbackReference'),
  });
}

function freezeNativeProjectionRequest(request: NativeProjectionRequest): NativeProjectionRequest {
  if ('snapshot' in request) {
    const expectedOperation = request.snapshot.action === 'install' ? 'install' : 'update';
    if (request.operation !== expectedOperation) invariant('native projection operation does not match the frozen package action');
    const pins = createResolvedLifecyclePins(request.pins);
    return deepFreeze({
      targetObservation: request.targetObservation,
      operation: request.operation,
      snapshot: request.snapshot,
      pins,
    });
  }
  stable(request.operationId, 'native projection operation id');
  stable(request.attemptId, 'native projection attempt id');
  return deepFreeze({
    targetObservation: request.targetObservation,
    operation: request.operation,
    operationId: request.operationId,
    attemptId: request.attemptId,
    activation: request.activation,
  });
}

function nativeProjectionRequestFromRoute(request: LifecycleRouteRequest): NativeProjectionRequest {
  return request.operation === 'install' || request.operation === 'update'
    ? freezeNativeProjectionRequest({
        targetObservation: request.targetObservation,
        operation: request.operation,
        snapshot: request.snapshot,
        pins: request.pins,
      })
    : freezeNativeProjectionRequest({
        targetObservation: request.targetObservation,
        operation: request.operation,
        operationId: request.operationId,
        attemptId: request.attemptId,
        activation: request.activation,
      });
}

function nativeProjectionBinding(request: NativeProjectionRequest): Record<string, unknown> & {
  readonly operationId: string;
  readonly attemptId: string;
} {
  if ('snapshot' in request) {
    return {
      targetObservationId: request.targetObservation.observationId,
      operation: request.operation,
      operationId: request.snapshot.operationId,
      attemptId: request.snapshot.attemptId,
      scopeId: request.snapshot.scopeId,
      packageName: request.snapshot.packageName,
      nativeId: request.snapshot.nativeId,
      sourceType: request.snapshot.sourceType,
      immutableRevision: request.snapshot.immutableRevision,
      snapshotFingerprint: request.snapshot.snapshotFingerprint,
      packageFingerprint: request.snapshot.packageFingerprint,
      declaredVersion: request.snapshot.inventory.package.version,
      nativeGit: request.snapshot.nativeGit ?? null,
      semanticInventory: request.snapshot.inventory,
      pins: request.pins,
    };
  }
  return {
    targetObservationId: request.targetObservation.observationId,
    operation: request.operation,
    operationId: request.operationId,
    attemptId: request.attemptId,
    scopeId: request.activation.scopeId,
    packageName: request.activation.packageName,
    nativeId: request.activation.nativeId,
    sourceType: request.activation.sourceType,
    sourceRevision: request.activation.sourceRevision,
    installedFingerprint: request.activation.installedFingerprint,
    route: request.activation.route,
    enablement: request.activation.enablement,
    activation: request.activation.activation,
  };
}

function admissionFor(
  request: LifecycleRouteRequest,
  host: string,
  detectedVersion: string | undefined,
  route: SelectedLifecycleRoute,
  profiles: readonly CapabilityEvidenceProfile[],
): PackageAdmission {
  const common = { host, detectedVersion, sourceType: request.sourceType, route };
  const admissionRequest: PackageAdmissionRequest = request.operation === 'install' || request.operation === 'update'
    ? { ...common, operation: request.operation, inventory: request.snapshot.inventory }
    : { ...common, operation: request.operation };
  return admitPackageSemanticsFromProfiles(admissionRequest, profiles);
}

function selectedDecision<Operation extends CapabilityOperation, Route extends SelectedLifecycleRoute>(
  adapterId: string,
  target: LifecycleTargetIdentity,
  request: LifecycleRouteRequest<Operation>,
  detectedVersion: string,
  route: Route,
  admission: PackageAdmission,
): SelectedRouteDecision<Route, Operation> {
  const evidenceId = admission.profile?.evidenceId;
  if (evidenceId === undefined) invariant('an admitted route must retain its evidence id');
  if (request.version.kind !== 'detected') invariant('a selected route needs a detected live target version');
  const mutationGroupId = route === 'native'
    ? mutationGroupForNativeScope(request)
    : request.operationId;
  const affectedOperationIds = route === 'native' && request.nativeScope.kind === 'bounded'
    ? operationIdsForNativeScope(request)
    : [request.operationId];
  return deepFreeze({
    kind: 'selected',
    adapterId,
    target,
    targetObservationId: request.targetObservation.observationId,
    operation: request.operation,
    operationId: request.operationId,
    attemptId: request.attemptId,
    scopeId: request.scopeId,
    packageName: request.packageName,
    nativeId: request.nativeId,
    sourceType: request.sourceType,
    route,
    detectedVersion,
    versionProbeId: stableCopy(request.version.probeId, 'version probe id'),
    evidenceId,
    mutationGroupId,
    mutationInvocationOperationId: [...affectedOperationIds].sort(compare)[0]!,
    affectedNativeIds: route === 'native' && request.nativeScope.kind === 'bounded'
      ? request.nativeScope.affectedNativeIds
      : [request.nativeId],
    affectedOperationIds,
  }) as unknown as SelectedRouteDecision<Route, Operation>;
}

function nativeMutationScopeIsCovered(request: LifecycleRouteRequest): boolean {
  if (request.nativeScope.kind !== 'bounded') return false;
  const allowed = new Map(request.planCoverage.operations.map((entry) => [entry.nativeId, entry]));
  const affected = request.nativeScope.affectedNativeIds.map((id) => allowed.get(id));
  if (affected.some((entry) => entry === undefined || entry.operation !== request.operation)) return false;
  if (allowed.get(request.nativeId)?.operationId !== request.operationId) return false;
  if (affected.some((entry) => entry!.authorization === 'planned-create'
    && (request.operation !== 'install' || entry!.nativeId !== request.nativeId))) return false;
  const groups = new Set(affected.map((entry) => entry!.mutationGroupId));
  if (groups.size !== 1) return false;
  if (!request.nativeScope.affectedNativeIds.includes(request.nativeId)) return false;
  return request.nativeScope.mode !== 'exact-package'
    || (request.nativeScope.affectedNativeIds.length === 1 && request.nativeScope.affectedNativeIds[0] === request.nativeId);
}

function nativeProjectionIsProven(request: LifecycleRouteRequest): boolean {
  if (request.nativeProjection.kind !== 'equivalent') return false;
  if ((request.operation === 'install' || request.operation === 'update')
    && request.sourceType === 'git'
    && request.snapshot.nativeGit === undefined) return false;
  return true;
}

function mutationGroupForNativeScope(request: LifecycleRouteRequest): string {
  if (request.nativeScope.kind !== 'bounded') invariant('selected Native route needs a bounded mutation scope');
  const byNativeId = new Map(request.planCoverage.operations.map(({ nativeId, mutationGroupId }) => [nativeId, mutationGroupId]));
  const groups = new Set(request.nativeScope.affectedNativeIds.map((nativeId) => byNativeId.get(nativeId)));
  if (groups.size !== 1 || groups.has(undefined)) invariant('Native mutation scope does not have one frozen mutation group');
  return [...groups][0]!;
}

function operationIdsForNativeScope(request: LifecycleRouteRequest): string[] {
  if (request.nativeScope.kind !== 'bounded') return [request.operationId];
  const byNativeId = new Map(request.planCoverage.operations.map(({ nativeId, operationId }) => [nativeId, operationId]));
  return request.nativeScope.affectedNativeIds.map((nativeId) => {
    const operationId = byNativeId.get(nativeId);
    if (operationId === undefined) invariant(`native affected id '${nativeId}' has no frozen in-plan operation id`);
    return operationId;
  });
}

function assertRouteObservationBindings(
  adapterId: string,
  target: LifecycleTargetIdentity,
  request: LifecycleRouteRequest,
): void {
  assertAdapterObservation(adapterId, request.targetObservation);
  if (!sameTarget(target, request.targetObservation.target)) invariant('route target does not match target observation');
  if (request.nativeScope.targetObservationId !== request.targetObservation.observationId) invariant('native scope is from a different target observation');
  if (request.planCoverage.targetObservationId !== request.targetObservation.observationId) invariant('plan coverage is from a different target observation');
  if (request.nativeProjection.targetObservationId !== request.targetObservation.observationId) invariant('native projection proof is from a different target observation');
  if (request.nativeProjection.operationId !== request.operationId || request.nativeProjection.attemptId !== request.attemptId) {
    invariant('native projection proof is from a different operation attempt');
  }
  const projectionInput = nativeProjectionRequestFromRoute(request);
  if (request.nativeProjection.inputId !== contentAddress(nativeProjectionBinding(projectionInput))) {
    invariant('native projection proof does not match the frozen route input');
  }
  if (request.operation === 'install' || request.operation === 'update') {
    if (request.snapshot.operationId !== request.operationId
      || request.snapshot.attemptId !== request.attemptId
      || request.snapshot.scopeId !== request.scopeId
      || request.snapshot.packageName !== request.packageName
      || request.snapshot.nativeId !== request.nativeId
      || request.snapshot.sourceType !== request.sourceType
      || !sameTarget(request.snapshot.target, target)) {
      invariant('frozen package does not match the route request identity');
    }
    createResolvedLifecyclePins(request.pins);
  } else if (request.activation.scopeId !== request.scopeId
    || request.activation.packageName !== request.packageName
    || request.activation.nativeId !== request.nativeId
    || request.activation.sourceType !== request.sourceType
    || !sameTarget(request.activation.target, target)) {
    invariant('recorded activation does not match the route request identity');
  }
}

function assertAdapterObservation(adapterId: string, observation: TargetInventoryObservation): void {
  if (observation.adapterId !== adapterId) invariant(`target observation belongs to '${observation.adapterId}', not '${adapterId}'`);
}

function projectionBinding<Route extends SelectedLifecycleRoute, Action extends ActivationMutationAction>(
  adapterId: string,
  request: ActivationPreparationRequest<Route, Action>,
  stagingId: string,
  stagingRoot: string,
) {
  return {
    adapterId,
    target: request.snapshot.target,
    targetObservationId: request.selection.targetObservationId,
    operationId: request.snapshot.operationId,
    attemptId: request.snapshot.attemptId,
    scopeId: request.snapshot.scopeId,
    packageName: request.snapshot.packageName,
    nativeId: request.snapshot.nativeId,
    sourceType: request.snapshot.sourceType,
    sourceRevision: request.snapshot.immutableRevision,
    sourceLocator: request.snapshot.nativeGit?.locator ?? null,
    packageVersion: request.snapshot.inventory.package.version,
    action: request.snapshot.action,
    route: request.selection.route,
    detectedVersion: request.selection.detectedVersion,
    versionProbeId: request.selection.versionProbeId,
    evidenceId: request.selection.evidenceId,
    mutationGroupId: request.selection.mutationGroupId,
    mutationInvocationOperationId: request.selection.mutationInvocationOperationId,
    affectedNativeIds: request.selection.affectedNativeIds,
    affectedOperationIds: request.selection.affectedOperationIds,
    stagingId,
    stagingRoot,
    pins: request.pins,
    snapshot: request.snapshot,
  };
}

function preparedActivation<Route extends SelectedLifecycleRoute, Action extends ActivationMutationAction>(
  adapterId: string,
  projection: PinsAppliedProjection<Route, Action>,
  projectedFingerprint: string,
  capture: ActivationPreparationCapture,
): PreparedActivationMutation<Route, Action> {
  assertRollbackCoverage(capture.rollbackCoverageOperationIds, projection.affectedOperationIds);
  const prior = normalizeReadback(capture.prior);
  const expected = normalizeReadback(capture.expected);
  if (expected.adapterId !== adapterId || !sameTarget(expected.target, projection.target)
    || expected.scopeId !== projection.scopeId || expected.packageName !== projection.packageName
    || expected.nativeId !== projection.nativeId || expected.route !== projection.route
    || expected.presence !== 'present' || expected.enablement !== 'enabled'
    || expected.activation !== 'active' || expected.transition.status !== 'effective'
    || expected.installedFingerprint !== projectedFingerprint) {
    throw phaseError('seal', 'internal.invariant', new Error('activation readback expectation does not match the sealed projection'));
  }
  const handle = durableHandle({
    adapterId,
    target: projection.target,
    targetObservationId: projection.targetObservationId,
    operationId: projection.operationId,
    attemptId: projection.attemptId,
    scopeId: projection.scopeId,
    packageName: projection.packageName,
    nativeId: projection.nativeId,
    sourceType: projection.sourceType,
    sourceRevision: projection.sourceRevision,
    sourceLocator: projection.sourceLocator,
    packageVersion: projection.packageVersion,
    action: projection.action,
    route: projection.route,
    detectedVersion: projection.detectedVersion,
    versionProbeId: projection.versionProbeId,
    evidenceId: projection.evidenceId,
    mutationGroupId: projection.mutationGroupId,
    mutationInvocationOperationId: projection.mutationInvocationOperationId,
    affectedNativeIds: projection.affectedNativeIds,
    affectedOperationIds: projection.affectedOperationIds,
    artifactId: `sha256:${projectedFingerprint}`,
    projectedFingerprint,
    prior,
    expected,
    rollbackReference: capture.rollbackReference,
  });
  return deepFreeze({
    phase: 'prepared',
    kind: 'activation',
    handle,
    stagingRoot: projection.stagingRoot,
  }) as unknown as PreparedActivationMutation<Route, Action>;
}

function assertRollbackCoverage(actual: readonly string[], expected: readonly string[]): void {
  const normalized = sortedUnique(actual, 'rollback coverage operation id');
  const required = [...expected].sort(compare);
  if (JSON.stringify(normalized) !== JSON.stringify(required)) {
    throw phaseError('seal', 'internal.invariant', new Error('rollback coverage must equal the complete affected operation group'));
  }
}

interface DurableHandleInput {
  readonly adapterId: string;
  readonly target: LifecycleTargetIdentity;
  readonly targetObservationId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly scopeId: string;
  readonly packageName: string;
  readonly nativeId: string;
  readonly sourceType: SourceType;
  readonly sourceRevision: string;
  readonly sourceLocator: string | null;
  readonly packageVersion: string | null;
  readonly action: LifecycleMutationAction;
  readonly route: SelectedLifecycleRoute;
  readonly detectedVersion: string;
  readonly versionProbeId: string;
  readonly evidenceId: string;
  readonly mutationGroupId: string;
  readonly mutationInvocationOperationId: string;
  readonly affectedNativeIds: readonly string[];
  readonly affectedOperationIds: readonly string[];
  readonly artifactId: string | null;
  readonly projectedFingerprint: string | null;
  readonly prior: LifecycleReadbackData;
  readonly expected: LifecycleReadbackData;
  readonly rollbackReference: string;
}

function durableHandle(input: DurableHandleInput): DurableLifecycleOperation {
  stable(input.adapterId, 'operation adapter id');
  stable(input.targetObservationId, 'target observation id');
  stable(input.operationId, 'lifecycle operation id');
  stable(input.attemptId, 'lifecycle attempt id');
  stable(input.scopeId, 'operation scope id');
  stable(input.packageName, 'operation package name');
  stable(input.nativeId, 'operation native id');
  stable(input.sourceRevision, 'operation Source revision');
  const sourceLocator = normalizeSourceLocator(input.sourceType, input.sourceRevision, input.sourceLocator);
  if (input.packageVersion !== null) stable(input.packageVersion, 'operation package version');
  normalizedVersion(input.detectedVersion);
  stable(input.versionProbeId, 'version probe id');
  stable(input.evidenceId, 'operation evidence id');
  stable(input.mutationGroupId, 'mutation group id');
  stable(input.mutationInvocationOperationId, 'mutation invocation operation id');
  const affectedNativeIds = sortedUnique(input.affectedNativeIds, 'affected native id');
  const affectedOperationIds = input.affectedOperationIds.map((id) => stableCopy(id, 'affected operation id'));
  unique(affectedOperationIds, 'affected operation id');
  if (affectedNativeIds.length === 0 || affectedNativeIds.length !== affectedOperationIds.length) {
    invariant('durable operation must bind parallel nonempty affected native and operation ids');
  }
  const ownNativeIndex = affectedNativeIds.indexOf(input.nativeId);
  const ownOperationIndex = affectedOperationIds.indexOf(input.operationId);
  if (ownNativeIndex < 0 || ownNativeIndex !== ownOperationIndex) {
    invariant('durable operation affected mapping must contain its own native and operation identity as one pair');
  }
  const canonicalLeader = [...affectedOperationIds].sort(compare)[0]!;
  if (input.mutationInvocationOperationId !== canonicalLeader) {
    invariant('mutation invocation operation id must be the canonical affected-operation leader');
  }
  if (input.route === 'managed' && (affectedNativeIds.length !== 1
    || input.mutationGroupId !== input.operationId
    || input.mutationInvocationOperationId !== input.operationId)) {
    invariant('Managed durable operation must have an exact single-operation mutation group');
  }
  stable(input.rollbackReference, 'rollback reference');
  const activation = input.action === 'install' || input.action === 'update' || input.action === 'route-migrate';
  if (activation) {
    if (input.artifactId === null || input.projectedFingerprint === null) invariant('activation operation needs a sealed artifact');
    fingerprint(input.projectedFingerprint, 'projected fingerprint');
    if (input.artifactId !== `sha256:${input.projectedFingerprint}`) invariant('artifact id must address the projected fingerprint');
  } else if (input.artifactId !== null || input.projectedFingerprint !== null) {
    invariant('disablement and retirement do not accept staged Source artifacts');
  }
  const target = frozenTarget(input.target);
  const prior = normalizeReadback(input.prior);
  const expected = normalizeReadback(input.expected);
  assertDurableReadbackIdentity(input, target, prior, 'prior');
  assertDurableReadbackIdentity(input, target, expected, 'expected');
  assertActionExpectation(input, prior, expected);
  return deepFreeze({
    schemaVersion: 1,
    ...input,
    target,
    sourceLocator,
    affectedNativeIds,
    affectedOperationIds: Object.freeze(affectedOperationIds),
    prior,
    expected,
  }) as unknown as DurableLifecycleOperation;
}

function assertDurableReadbackIdentity(
  input: DurableHandleInput,
  target: LifecycleTargetIdentity,
  observation: LifecycleReadbackData,
  label: 'prior' | 'expected',
): void {
  if (observation.adapterId !== input.adapterId
    || !sameTarget(observation.target, target)
    || observation.scopeId !== input.scopeId
    || observation.packageName !== input.packageName
    || observation.nativeId !== input.nativeId) {
    invariant(`durable operation ${label} readback identity does not match its outer operation`);
  }
  if (label === 'expected' && observation.route !== input.route) {
    invariant('durable operation expected route does not match its selected route');
  }
}

function assertActionExpectation(
  input: DurableHandleInput,
  prior: LifecycleReadbackData,
  expected: LifecycleReadbackData,
): void {
  if (expected.transition.status !== 'effective' || expected.transition.requirement === 'unknown') {
    invariant('terminal mutation expectation must prove an effective known reload/restart requirement');
  }
  if (input.action === 'install' || input.action === 'update' || input.action === 'route-migrate') {
    if (expected.presence !== 'present' || expected.enablement !== 'enabled' || expected.activation !== 'active'
      || expected.installedFingerprint !== input.projectedFingerprint) {
      invariant('activation expectation must be present, enabled, active, and match the sealed projection');
    }
    return;
  }
  if (input.action === 'disable-nonconforming') {
    if (prior.presence !== 'present' || expected.presence !== 'present'
      || expected.enablement !== 'disabled' || expected.activation !== 'inactive'
      || expected.installedFingerprint !== prior.installedFingerprint
      || canonicalJson(expected.contentRoots) !== canonicalJson(prior.contentRoots)
      || canonicalJson(expected.retention) !== canonicalJson(prior.retention)) {
      invariant('disablement expectation must retain exact installed bytes and become disabled/inactive');
    }
    return;
  }
  if (!hasExactRetentionObservation(prior.retention)) {
    invariant('retirement requires exact prior plugin-data and inactive-metadata observations');
  }
  if (expected.presence !== 'absent' || expected.enablement !== 'disabled' || expected.activation !== 'inactive'
    || expected.installedFingerprint !== null || expected.contentRoots.length !== 0
    || canonicalJson(expected.retention) !== canonicalJson(prior.retention)) {
    invariant('retirement expectation must remove activation and preserve exact retained resources');
  }
}

function hasExactRetentionObservation(retention: LifecycleReadbackData['retention']): boolean {
  return retention.pluginData.state !== 'missing'
    && retention.pluginData.state !== 'not-observed'
    && retention.inactiveMetadata.state !== 'missing'
    && retention.inactiveMetadata.state !== 'not-observed';
}

function normalizeReadback(input: LifecycleReadbackData): LifecycleReadbackData {
  stable(input.adapterId, 'readback adapter id');
  stable(input.scopeId, 'readback scope id');
  stable(input.packageName, 'readback package name');
  stable(input.nativeId, 'readback native id');
  if (input.presence !== 'present' && input.presence !== 'absent') invariant('readback presence is invalid');
  if (!['enabled', 'disabled', 'not-applicable', 'unknown'].includes(input.enablement)) invariant('readback enablement is invalid');
  if (!['active', 'inactive', 'unknown'].includes(input.activation)) invariant('readback activation is invalid');
  const target = frozenTarget(input.target);
  const contentRoots = normalizeContentRoots(input.contentRoots, input.presence === 'present');
  if (input.presence === 'present') {
    if (input.installedFingerprint === null) invariant('present readback needs an installed fingerprint');
    fingerprint(input.installedFingerprint, 'installed fingerprint');
  } else if (input.installedFingerprint !== null || contentRoots.length !== 0) {
    invariant('absent readback cannot expose installed content');
  }
  if (input.route !== 'native' && input.route !== 'managed' && input.route !== 'none') invariant('readback route is invalid');
  return deepFreeze({
    adapterId: input.adapterId,
    target,
    scopeId: input.scopeId,
    packageName: input.packageName,
    nativeId: input.nativeId,
    route: input.route,
    presence: input.presence,
    enablement: input.enablement,
    activation: input.activation,
    transition: normalizeTransition(input.transition),
    installedFingerprint: input.installedFingerprint,
    retention: normalizeRetention(input.retention),
    contentRoots,
  });
}

function normalizeTransition(input: ActivationTransitionObservation): ActivationTransitionObservation {
  const value = record(input, 'activation transition observation');
  exactFields(value, ['requirement', 'status'], 'activation transition observation');
  const requirement = value['requirement'];
  const status = value['status'];
  if (typeof requirement !== 'string' || !['none', 'reload', 'restart', 'unknown'].includes(requirement)) invariant('activation transition requirement is invalid');
  if (typeof status !== 'string' || !['effective', 'pending', 'unknown'].includes(status)) invariant('activation transition status is invalid');
  return Object.freeze({
    requirement: requirement as ActivationTransitionObservation['requirement'],
    status: status as ActivationTransitionObservation['status'],
  });
}

function normalizeRetention(input: LifecycleReadbackData['retention']): LifecycleReadbackData['retention'] {
  const retention = record(input, 'retention observation');
  exactFields(retention, ['pluginData', 'inactiveMetadata'], 'retention observation');
  const normalizeResource = (
    resource: LifecycleReadbackData['retention']['pluginData'],
  ): LifecycleReadbackData['retention']['pluginData'] => {
    if (!isRecord(resource)) invariant('retention resource observation must be an object');
    exactFields(resource, ['state', 'fingerprint'], 'retention resource observation');
    const state = resource['state'];
    const digest = resource['fingerprint'];
    if (typeof state !== 'string' || !['present', 'absent', 'missing', 'not-observed'].includes(state)) {
      invariant('retention resource state is invalid');
    }
    if (state === 'present') {
      if (typeof digest !== 'string') invariant('present retained resource needs a fingerprint');
      fingerprint(digest, 'retained resource fingerprint');
      return Object.freeze({ state, fingerprint: digest });
    }
    if (digest !== null) {
      invariant(`${state} retained resource cannot expose a fingerprint`);
    }
    return Object.freeze({ state: state as 'absent' | 'missing' | 'not-observed', fingerprint: null });
  };
  return Object.freeze({
    pluginData: normalizeResource(retention['pluginData'] as LifecycleReadbackData['retention']['pluginData']),
    inactiveMetadata: normalizeResource(retention['inactiveMetadata'] as LifecycleReadbackData['retention']['inactiveMetadata']),
  });
}

function normalizeInstallation(input: TargetInstallationData): TargetInstallationData {
  stable(input.nativeId, 'target inventory native id');
  if (input.packageName !== null) stable(input.packageName, 'target inventory package name');
  if (input.installedVersion !== null) stable(input.installedVersion, 'target installed version');
  const source = input.source === null ? null : normalizeInstalledSource(input.source);
  const contentRoots = normalizeContentRoots(input.contentRoots, input.presence === 'present');
  if (input.presence === 'present') {
    if (input.installedFingerprint === null) invariant(`present target installation '${input.nativeId}' needs an installed fingerprint`);
    fingerprint(input.installedFingerprint, 'target installed fingerprint');
  } else if (input.installedFingerprint !== null || contentRoots.length !== 0) {
    invariant(`absent target installation '${input.nativeId}' cannot expose installed content`);
  }
  const ownership = input.ownership.kind === 'owned'
    ? {
        ...input.ownership,
        scopeId: stableCopy(input.ownership.scopeId, 'ownership scope id'),
        proofId: stableCopy(input.ownership.proofId, 'ownership proof id'),
      }
    : input.ownership.kind === 'ambiguous'
      ? { kind: 'ambiguous' as const, proofIds: sortedStable(input.ownership.proofIds, 'ambiguous ownership proof id') }
      : { kind: 'unmanaged' as const };
  return deepFreeze({ ...input, source, ownership, contentRoots });
}

function normalizeInstalledSource(input: NonNullable<TargetInstallationData['source']>): NonNullable<TargetInstallationData['source']> {
  stable(input.immutableRevision, 'target source revision');
  if (input.type === 'git') {
    immutableGitRevision(input.immutableRevision);
    if (input.locator === null) invariant('installed Git source needs a credential-free locator');
    validateSourceBinding({ kind: 'git', locator: input.locator, ref: input.immutableRevision });
  } else if (input.type === 'local') {
    if (input.locator !== null) invariant('installed local source locator must be omitted');
  } else {
    invariant('installed source type is invalid');
  }
  return Object.freeze({ ...input });
}

function normalizeContentRoots(input: readonly ContentRootObservation[], required: boolean): readonly ContentRootObservation[] {
  const roots = input.map((inputRoot) => {
    const value = record(inputRoot, 'content root observation');
    exactFields(value, ['label', 'path', 'fingerprint'], 'content root observation');
    const label = stringField(value, 'label');
    const path = stringField(value, 'path');
    const digest = stringField(value, 'fingerprint');
    stable(label, 'content root label');
    const canonical = canonicalAbsolute(path, `content root '${label}'`);
    fingerprint(digest, `content root '${label}' fingerprint`);
    return Object.freeze({ label, path: canonical, fingerprint: digest });
  }).sort((left, right) => compare(left.label, right.label));
  unique(roots.map(({ label }) => label), 'content root label');
  if (required && roots.length === 0) invariant('present installed content needs at least one exact content root');
  return Object.freeze(roots);
}

function normalizeNativeGit(
  sourceType: SourceType,
  immutableRevision: string,
  descriptor: FrozenPackageSnapshotInput['nativeGit'],
) {
  if (sourceType === 'local') {
    if (descriptor !== undefined) invariant('local frozen package cannot expose a Native Git descriptor');
    return undefined;
  }
  if (descriptor === undefined) return undefined;
  if (descriptor.resolvedRevision !== immutableRevision) invariant('Native Git descriptor must use the frozen immutable revision');
  validateSourceBinding({ kind: 'git', locator: descriptor.locator, ref: descriptor.resolvedRevision });
  return Object.freeze({ ...descriptor });
}

function normalizeSourceLocator(sourceType: SourceType, revision: string, locator: string | null): string | null {
  if (sourceType === 'local') {
    if (locator !== null) invariant('local Source locator must not cross the lifecycle adapter boundary');
    return null;
  }
  if (sourceType !== 'git') invariant('Source type is invalid');
  immutableGitRevision(revision);
  if (locator !== null) validateSourceBinding({ kind: 'git', locator, ref: revision });
  return locator;
}

function immutableGitRevision(value: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    invariant('Git lifecycle revision must be a full lowercase SHA-1 or SHA-256 object id');
  }
}

function assertActivationPreparationRequest(
  adapterId: string,
  request: ActivationPreparationRequest<SelectedLifecycleRoute>,
): void {
  const operation = request.snapshot.action === 'install' ? 'install' : 'update';
  assertSelected(adapterId, request.selection, operation);
  if (!sameTarget(request.snapshot.target, request.selection.target)) invariant('selected route target does not match frozen package target');
  if (request.snapshot.operationId !== request.selection.operationId
    || request.snapshot.attemptId !== request.selection.attemptId
    || request.snapshot.scopeId !== request.selection.scopeId
    || request.snapshot.packageName !== request.selection.packageName
    || request.snapshot.nativeId !== request.selection.nativeId
    || request.snapshot.sourceType !== request.selection.sourceType) {
    invariant('frozen package identity does not match the selected route');
  }
}

function assertSelected(
  adapterId: string,
  selection: SelectedRouteDecision,
  operation: CapabilityOperation,
): void {
  if (selection.kind !== 'selected' || selection.adapterId !== adapterId || selection.operation !== operation) {
    invariant(`selected ${operation} route is not bound to adapter '${adapterId}'`);
  }
}

function assertActivationSelection(
  activation: RecordedOwnedActivation,
  selection: SelectedRouteDecision,
): void {
  if (!sameTarget(activation.target, selection.target)) invariant('selected route target does not match recorded activation target');
  if (activation.scopeId !== selection.scopeId
    || activation.packageName !== selection.packageName
    || activation.nativeId !== selection.nativeId
    || activation.sourceType !== selection.sourceType) {
    invariant('recorded activation identity does not match the selected route');
  }
}

function assertPriorMatchesActivation(prior: LifecycleReadbackData, activation: RecordedOwnedActivation): void {
  if (prior.scopeId !== activation.scopeId || prior.packageName !== activation.packageName || prior.nativeId !== activation.nativeId
    || prior.presence !== 'present' || prior.installedFingerprint !== activation.installedFingerprint) {
    invariant('captured prior observation does not match the recorded owned activation');
  }
}

function assertProjection(adapterId: string, projection: { readonly adapterId: string; readonly phase: string }, phase: string): void {
  if (projection.adapterId !== adapterId || projection.phase !== phase) invariant(`expected ${phase} projection for adapter '${adapterId}'`);
}

function assertPrepared(
  adapterId: string,
  prepared: PreparedLifecycleMutation,
  kind: PreparedLifecycleMutation['kind'],
): void {
  if (prepared.kind !== kind || prepared.handle.adapterId !== adapterId) invariant(`prepared ${kind} mutation belongs to another adapter`);
  assertHandle(adapterId, prepared.handle);
}

function assertHandle(adapterId: string, handle: DurableLifecycleOperation): void {
  if (handle.adapterId !== adapterId) invariant(`durable operation belongs to '${handle.adapterId}', not '${adapterId}'`);
}

function mutationReceipt<Route extends SelectedLifecycleRoute, Action extends LifecycleMutationAction>(
  handle: DurableLifecycleOperation<Route, Action>,
  result: { readonly receiptId: string; readonly changed: boolean },
): MutationReceipt<Route, Action> {
  return deepFreeze({ phase: 'mutated', handle, ...checkedMutationResult(result) }) as MutationReceipt<Route, Action>;
}

function checkedMutationResult(result: { readonly receiptId: string; readonly changed: boolean }) {
  stable(result.receiptId, 'mutation receipt id');
  if (typeof result.changed !== 'boolean') invariant('mutation receipt changed must be boolean');
  return { receiptId: result.receiptId, changed: result.changed };
}

function assertReadbackMatch(
  expected: LifecycleReadbackData,
  observation: LifecycleReadbackObservation,
  label: string,
): void {
  const normalized = normalizeReadback(observation);
  if (canonicalJson(expected) !== canonicalJson(normalized)) {
    throw new LifecycleReadbackMismatchError(`${label} readback does not match its sealed expectation`);
  }
}

function cleanupReference(
  adapterId: string,
  target: StagedProjection | DirectivesAppliedProjection | PinsAppliedProjection | PreparedLifecycleMutation | DurableLifecycleOperation,
): CleanupReference {
  if ('handle' in target) {
    assertHandle(adapterId, target.handle);
    return deepFreeze({
      adapterId,
      target: target.handle.target,
      operationId: target.handle.operationId,
      attemptId: target.handle.attemptId,
      artifactId: target.handle.artifactId,
    });
  }
  if ('schemaVersion' in target) {
    assertHandle(adapterId, target);
    return deepFreeze({
      adapterId,
      target: target.target,
      operationId: target.operationId,
      attemptId: target.attemptId,
      artifactId: target.artifactId,
    });
  }
  if (target.adapterId !== adapterId) invariant('cleanup projection belongs to another adapter');
  return deepFreeze({
    adapterId,
    target: target.target,
    operationId: target.operationId,
    attemptId: target.attemptId,
    artifactId: target.stagingId,
  });
}

function isPreparationProjection(value: unknown): value is StagedProjection | DirectivesAppliedProjection | PinsAppliedProjection {
  return isRecord(value) && ['staged', 'directives-applied', 'pins-applied'].includes(String(value['phase']));
}

function dedupeGaps(input: readonly CapabilityGapReason[]): CapabilityGapReason[] {
  const seen = new Set<string>();
  const result: CapabilityGapReason[] = [];
  for (const gap of input) {
    const key = canonicalJson(gap);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(gap);
  }
  return result;
}

function normalizedVersion(value: string): string {
  stable(value, 'detected target version');
  if (/\s/u.test(value)) invariant('detected target version must not contain whitespace');
  return value;
}

function normalizeVersionObservation(input: TargetVersionObservation): TargetVersionObservation {
  if (input.kind === 'detected') return Object.freeze({
    kind: 'detected',
    version: normalizedVersion(input.version),
    probeId: stableCopy(input.probeId, 'version probe id'),
  });
  if (input.kind !== 'unknown' && input.kind !== 'unparseable') invariant('target version observation is invalid');
  return Object.freeze({ kind: input.kind });
}

function frozenTarget(input: LifecycleTargetIdentity): LifecycleTargetIdentity {
  const parsed = parsePersistedTargetIdentity(input, 'lifecycle target');
  return deepFreeze(parsed);
}

function sameTarget(left: LifecycleTargetIdentity, right: LifecycleTargetIdentity): boolean {
  return canonicalJson(frozenTarget(left)) === canonicalJson(frozenTarget(right));
}

function canonicalAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) invariant(`${label} must be a canonical absolute path`);
  return path;
}

function fingerprint(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) invariant(`${label} must be a lowercase sha256 digest`);
  return value;
}

function sortedStable(values: readonly string[], label: string): readonly string[] {
  return Object.freeze(sortedUnique(values, label));
}

function sortedUnique(values: readonly string[], label: string): string[] {
  const copy = values.map((value) => stableCopy(value, label)).sort(compare);
  unique(copy, label);
  return copy;
}

function stableCopy(value: string, label: string): string {
  stable(value, label);
  return value;
}

function stable(value: string, label: string): void {
  try {
    validateStableIdentityString(value, label);
  } catch (error) {
    invariant(unknownErrorDiagnostic(error));
  }
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invariant(`duplicate ${label} '${value}'`);
    seen.add(value);
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contentAddress(value: unknown): string {
  const hash = new CryptoHasher('sha256');
  hash.update(canonicalJson(value));
  return `sha256:${hash.digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clonePlain<T>(value: T, label: string): T {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => clonePlain(item, label)) as T;
  if (!isRecord(value)) invariant(`${label} must contain plain serializable data`);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) output[key] = clonePlain(value[key], label);
  return output as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function invokePhase<T>(phase: LifecycleHostPhase, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isLifecycleHostPhaseError(error)) throw error;
    const code = phase === 'apply-precondition' || phase === 'apply' || phase === 'disable' || phase === 'retire'
      ? 'runtime.operation-failed'
      : phase === 'readback'
        ? 'readback.failed'
        : phase === 'rollback' || phase === 'cleanup'
          ? 'recovery.failed'
          : 'internal.defect';
    throw phaseError(phase, code, error);
  }
}

function phaseError(
  phase: LifecycleHostPhase,
  code: 'internal.defect' | 'internal.invariant' | 'runtime.operation-failed' | 'readback.failed' | 'recovery.failed',
  thrown: unknown,
): LifecycleHostPhaseError {
  const diagnostic = `${phase}: ${unknownErrorDiagnostic(thrown)}`;
  const mutationStarted = phase === 'apply' || phase === 'disable' || phase === 'retire'
    || phase === 'readback' || phase === 'rollback' || phase === 'cleanup';
  if (code === 'internal.defect' || code === 'internal.invariant') {
    return new LifecycleHostPhaseError(phase, createLifecycleReason('internal', code, diagnostic), thrown, mutationStarted);
  }
  if (code === 'runtime.operation-failed') {
    return new LifecycleHostPhaseError(phase, createLifecycleReason('runtime', code, diagnostic), thrown, mutationStarted);
  }
  if (code === 'readback.failed') {
    return new LifecycleHostPhaseError(phase, createLifecycleReason('readback', code, diagnostic), thrown, mutationStarted);
  }
  return new LifecycleHostPhaseError(phase, createLifecycleReason('recovery', code, diagnostic), thrown, mutationStarted);
}

function isLifecycleHostPhaseError(value: unknown): value is LifecycleHostPhaseError {
  try {
    return value instanceof LifecycleHostPhaseError;
  } catch {
    return false;
  }
}

function invariant(message: string): never {
  throw phaseError('route', 'internal.invariant', new Error(message));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invariant(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const extra = Object.keys(value).find((field) => !allowed.has(field));
  if (extra !== undefined) invariant(`${label} has unsupported field '${extra}'`);
  const missing = fields.find((field) => !Object.hasOwn(value, field));
  if (missing !== undefined) invariant(`${label} is missing field '${missing}'`);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string') invariant(`${field} must be a string`);
  return result;
}

function readbackField(value: unknown, label: string): LifecycleReadbackData {
  const input = record(value, `${label} lifecycle readback`);
  exactFields(input, [
    'adapterId', 'target', 'scopeId', 'packageName', 'nativeId', 'route', 'presence',
    'enablement', 'activation', 'transition', 'installedFingerprint', 'contentRoots', 'retention',
  ], `${label} lifecycle readback`);
  return input as unknown as LifecycleReadbackData;
}

function nullableString(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== 'string') invariant(`${label} must be a string or null`);
  return value;
}

function stringArrayField(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) invariant(`${label} must be a string array`);
  return [...value] as string[];
}

function actionField(value: unknown): LifecycleMutationAction {
  if (!['install', 'update', 'route-migrate', 'disable-nonconforming', 'retire-orphan', 'remove'].includes(String(value))) {
    invariant('durable lifecycle action is invalid');
  }
  return value as LifecycleMutationAction;
}

function routeField(value: unknown): SelectedLifecycleRoute {
  if (value !== 'native' && value !== 'managed') invariant('durable lifecycle route is invalid');
  return value;
}

function sourceTypeField(value: unknown): SourceType {
  if (value !== 'local' && value !== 'git') invariant('durable lifecycle Source type is invalid');
  return value;
}
