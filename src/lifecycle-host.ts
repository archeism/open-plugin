import type { CapabilityEvidenceProfile } from './capability-evidence';
import type { LifecycleReason } from './lifecycle-report';
import type {
  CapabilityOperation,
  PackageSemanticInventory,
  SourceType,
} from './semantic-inventory';
import type { PersistedTargetContextValue } from './target-identity';

declare const routeDecisionBrand: unique symbol;
declare const targetObservationBrand: unique symbol;
declare const nativeScopeBrand: unique symbol;
declare const nativeProjectionBrand: unique symbol;
declare const planCoverageBrand: unique symbol;
declare const frozenPackageBrand: unique symbol;
declare const ownedActivationBrand: unique symbol;
declare const projectionPhaseBrand: unique symbol;
declare const durableOperationBrand: unique symbol;
declare const readbackObservationBrand: unique symbol;
declare const verifiedMutationBrand: unique symbol;

export type SelectedLifecycleRoute = 'native' | 'managed';
export type ActivationMutationAction = 'install' | 'update' | 'route-migrate';
export type RetirementMutationAction = 'retire-orphan' | 'remove';
export type LifecycleMutationAction = ActivationMutationAction | 'disable-nonconforming' | RetirementMutationAction;
export type CapabilityGapReason = Extract<LifecycleReason, { category: 'capability' }>;
export type NonEmptyCapabilityGaps = readonly [CapabilityGapReason, ...CapabilityGapReason[]];

/** Credential-free target identity copied into every lifecycle phase token. */
export interface LifecycleTargetIdentity {
  readonly kind: string;
  readonly instance: string;
  readonly context?: Readonly<Record<string, PersistedTargetContextValue>>;
}

/** Live target version evidence. Static consumer-profile metadata is not a target probe. */
export type TargetVersionObservation =
  | { readonly kind: 'detected'; readonly version: string; readonly probeId: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unparseable' };

export interface ContentRootObservation {
  readonly label: string;
  readonly path: string;
  readonly fingerprint: string;
}

export type TargetOwnershipObservation =
  | { readonly kind: 'owned'; readonly proof: 'created' | 'adopted'; readonly scopeId: string; readonly proofId: string }
  | { readonly kind: 'unmanaged' }
  | { readonly kind: 'ambiguous'; readonly proofIds: readonly string[] };

export interface TargetInstallationData {
  readonly nativeId: string;
  readonly packageName: string | null;
  readonly ownership: TargetOwnershipObservation;
  readonly presence: 'present' | 'absent';
  readonly enablement: 'enabled' | 'disabled' | 'unknown';
  readonly activation: 'active' | 'inactive' | 'nonconforming' | 'unknown';
  readonly installedFingerprint: string | null;
  readonly installedVersion: string | null;
  readonly source: {
    readonly type: SourceType;
    readonly immutableRevision: string;
    readonly locator: string | null;
  } | null;
  readonly contentRoots: readonly ContentRootObservation[];
}

export interface TargetInventoryData {
  readonly target: LifecycleTargetIdentity;
  readonly installations: readonly TargetInstallationData[];
}

/** Immutable, content-addressed host inventory consumed by the planner before action choice. */
export interface TargetInventoryObservation extends TargetInventoryData {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly observationId: string;
  readonly [targetObservationBrand]: true;
}

export interface NativeMutationScopeRequest {
  readonly targetObservation: TargetInventoryObservation;
  readonly operation: CapabilityOperation;
  readonly packageName: string;
  readonly nativeId: string;
  readonly sourceType: SourceType;
}

export type NativeMutationScopeData =
  | {
      readonly kind: 'bounded';
      readonly mode: 'exact-package' | 'marketplace-wide';
      readonly affectedNativeIds: readonly [string, ...string[]];
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unbounded' };

/** Adapter-observed native blast radius, bound to one immutable target inventory. */
export type NativeMutationScopeObservation = NativeMutationScopeData & {
  readonly targetObservationId: string;
  readonly [nativeScopeBrand]: true;
};

export type NativeProjectionData =
  | { readonly kind: 'equivalent'; readonly proofId: string }
  | { readonly kind: 'requires-managed'; readonly reasonId: string }
  | { readonly kind: 'unverified'; readonly reasonId: string };

export interface ActivationNativeProjectionRequest {
  readonly targetObservation: TargetInventoryObservation;
  readonly operation: 'install' | 'update';
  readonly snapshot: FrozenPackageSnapshot;
  readonly pins: readonly ResolvedLifecyclePin[];
}

export interface RecordedNativeProjectionRequest {
  readonly targetObservation: TargetInventoryObservation;
  readonly operation: 'disable' | 'retire';
  readonly operationId: string;
  readonly attemptId: string;
  readonly activation: RecordedOwnedActivation;
}

export type NativeProjectionRequest = ActivationNativeProjectionRequest | RecordedNativeProjectionRequest;

/** Adapter proof that Native produces the same frozen projection as Managed for this exact operation input. */
export type NativeProjectionObservation = NativeProjectionData & {
  readonly targetObservationId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly inputId: string;
  readonly [nativeProjectionBrand]: true;
};

/** Ownership-proven plan coverage supplied before Native route selection. */
export interface LifecyclePlanCoverage {
  readonly targetObservationId: string;
  readonly operations: readonly {
    readonly nativeId: string;
    readonly operationId: string;
    readonly operation: CapabilityOperation;
    readonly mutationGroupId: string;
    readonly authorization: 'observed-owned' | 'planned-create';
  }[];
  readonly [planCoverageBrand]: true;
}

interface LifecycleRouteRequestBase {
  readonly target: LifecycleTargetIdentity;
  readonly operationId: string;
  readonly attemptId: string;
  readonly scopeId: string;
  readonly packageName: string;
  readonly nativeId: string;
  readonly version: TargetVersionObservation;
  readonly sourceType: SourceType;
  readonly targetObservation: TargetInventoryObservation;
  readonly nativeScope: NativeMutationScopeObservation;
  readonly nativeProjection: NativeProjectionObservation;
  readonly planCoverage: LifecyclePlanCoverage;
}

export type LifecycleRouteRequest<Operation extends CapabilityOperation = CapabilityOperation> =
  Operation extends 'install' | 'update'
    ? (LifecycleRouteRequestBase & {
      readonly operation: Operation;
      readonly snapshot: FrozenPackageSnapshot;
      readonly pins: readonly ResolvedLifecyclePin[];
    })
    : (LifecycleRouteRequestBase & {
      readonly operation: Operation;
      readonly activation: RecordedOwnedActivation;
      readonly inventory?: never;
    });

export interface SelectedRouteDecision<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Operation extends CapabilityOperation = CapabilityOperation,
> {
  readonly kind: 'selected';
  readonly adapterId: string;
  readonly target: LifecycleTargetIdentity;
  readonly targetObservationId: string;
  readonly operation: Operation;
  readonly operationId: string;
  readonly attemptId: string;
  readonly scopeId: string;
  readonly packageName: string;
  readonly nativeId: string;
  readonly sourceType: SourceType;
  readonly route: Route;
  readonly detectedVersion: string;
  readonly versionProbeId: string;
  readonly evidenceId: string;
  readonly mutationGroupId: string;
  readonly mutationInvocationOperationId: string;
  readonly affectedNativeIds: readonly string[];
  readonly affectedOperationIds: readonly string[];
  readonly [routeDecisionBrand]: true;
}

export interface CapabilityGapRouteDecision<Operation extends CapabilityOperation = CapabilityOperation> {
  readonly kind: 'capability-gap';
  readonly adapterId: string;
  readonly target: LifecycleTargetIdentity;
  readonly targetObservationId: string;
  readonly operation: Operation;
  readonly operationId: string;
  readonly attemptId: string;
  readonly scopeId: string;
  readonly packageName: string;
  readonly nativeId: string;
  readonly sourceType: SourceType;
  readonly status: 'unsupported' | 'unverified';
  readonly gaps: NonEmptyCapabilityGaps;
  readonly [routeDecisionBrand]: true;
}

export type LifecycleRouteDecision<Operation extends CapabilityOperation = CapabilityOperation> =
  | SelectedRouteDecision<SelectedLifecycleRoute, Operation>
  | CapabilityGapRouteDecision<Operation>;

export interface NativeGitSnapshotDescriptor {
  /** Credential-free canonical locator; the requested mutable ref is deliberately absent. */
  readonly locator: string;
  readonly resolvedRevision: string;
}

export interface FrozenPackageSnapshotInput {
  readonly operationId: string;
  readonly attemptId: string;
  readonly scopeId: string;
  readonly target: LifecycleTargetIdentity;
  readonly action: ActivationMutationAction;
  readonly packageName: string;
  readonly nativeId: string;
  readonly sourceType: SourceType;
  readonly immutableRevision: string;
  readonly snapshotRoot: string;
  readonly packageRoot: string;
  readonly relativePackagePath: string;
  readonly snapshotFingerprint: string;
  readonly packageFingerprint: string;
  readonly nativeGit?: NativeGitSnapshotDescriptor;
  readonly inventory: PackageSemanticInventory;
}

/** Narrow immutable package handle derived from a frozen Source; never a resolver input. */
export interface FrozenPackageSnapshot extends FrozenPackageSnapshotInput {
  readonly schemaVersion: 1;
  readonly [frozenPackageBrand]: true;
}

export interface ResolvedLifecyclePin {
  readonly server: string;
  readonly executable: string;
}

export interface RecordedOwnedActivationInput {
  readonly scopeId: string;
  readonly target: LifecycleTargetIdentity;
  readonly packageName: string;
  readonly nativeId: string;
  readonly sourceType: SourceType;
  readonly sourceRevision: string;
  readonly sourceLocator: string | null;
  readonly installedVersion: string | null;
  readonly route: SelectedLifecycleRoute;
  readonly evidenceId: string;
  readonly ownership: {
    readonly kind: 'created' | 'adopted';
    readonly proofId: string;
  };
  readonly activation: 'active' | 'inactive' | 'nonconforming';
  readonly enablement: 'enabled' | 'disabled';
  readonly installedFingerprint: string;
  readonly contentRoots: readonly ContentRootObservation[];
}

/** Source-free retirement/disablement input backed by verified ownership. */
export interface RecordedOwnedActivation extends RecordedOwnedActivationInput {
  readonly schemaVersion: 1;
  readonly [ownedActivationBrand]: true;
}

export interface ActivationPreparationRequest<
  Route extends SelectedLifecycleRoute,
  Action extends ActivationMutationAction = ActivationMutationAction,
> {
  readonly selection: SelectedRouteDecision<Route, Action extends 'install' ? 'install' : 'update'>;
  readonly snapshot: FrozenPackageSnapshot & { readonly action: Action };
  readonly pins: readonly ResolvedLifecyclePin[];
}

export interface DisablePreparationRequest<Route extends SelectedLifecycleRoute> {
  readonly operationId: string;
  readonly attemptId: string;
  readonly selection: SelectedRouteDecision<Route, 'disable'>;
  readonly activation: RecordedOwnedActivation;
}

export interface RetirementPreparationRequest<
  Route extends SelectedLifecycleRoute,
  Action extends RetirementMutationAction = RetirementMutationAction,
> {
  readonly operationId: string;
  readonly attemptId: string;
  readonly action: Action;
  readonly selection: SelectedRouteDecision<Route, 'retire'>;
  readonly activation: RecordedOwnedActivation;
}

interface ProjectionBinding<
  Route extends SelectedLifecycleRoute,
  Action extends ActivationMutationAction,
> {
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
  readonly action: Action;
  readonly route: Route;
  readonly detectedVersion: string;
  readonly versionProbeId: string;
  readonly evidenceId: string;
  readonly mutationGroupId: string;
  readonly mutationInvocationOperationId: string;
  readonly affectedNativeIds: readonly string[];
  readonly affectedOperationIds: readonly string[];
  readonly stagingId: string;
  readonly stagingRoot: string;
  readonly pins: readonly ResolvedLifecyclePin[];
  readonly snapshot: FrozenPackageSnapshot;
}

export interface StagedProjection<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends ActivationMutationAction = ActivationMutationAction,
> extends ProjectionBinding<Route, Action> {
  readonly phase: 'staged';
  readonly [projectionPhaseBrand]: 'staged';
}

export interface DirectivesAppliedProjection<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends ActivationMutationAction = ActivationMutationAction,
> extends ProjectionBinding<Route, Action> {
  readonly phase: 'directives-applied';
  readonly directiveIds: readonly string[];
  readonly [projectionPhaseBrand]: 'directives-applied';
}

export interface PinsAppliedProjection<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends ActivationMutationAction = ActivationMutationAction,
> extends ProjectionBinding<Route, Action> {
  readonly phase: 'pins-applied';
  readonly directiveIds: readonly string[];
  readonly appliedPinServers: readonly string[];
  readonly [projectionPhaseBrand]: 'pins-applied';
}

/** Reload/restart is retained as adapter evidence, separate from public report activation vocabulary. */
export interface ActivationTransitionObservation {
  readonly requirement: 'none' | 'reload' | 'restart' | 'unknown';
  readonly status: 'effective' | 'pending' | 'unknown';
}

export type RetainedResourceObservation =
  | { readonly state: 'present'; readonly fingerprint: string }
  | { readonly state: 'absent' | 'missing' | 'not-observed'; readonly fingerprint: null };

/** Exact non-active bytes observed independently before and after retirement. */
export interface RetentionObservation {
  readonly pluginData: RetainedResourceObservation;
  readonly inactiveMetadata: RetainedResourceObservation;
}

export interface LifecycleReadbackData {
  readonly adapterId: string;
  readonly target: LifecycleTargetIdentity;
  readonly scopeId: string;
  readonly packageName: string;
  readonly nativeId: string;
  readonly route: SelectedLifecycleRoute | 'none';
  readonly presence: 'present' | 'absent';
  readonly enablement: 'enabled' | 'disabled' | 'not-applicable' | 'unknown';
  readonly activation: 'active' | 'inactive' | 'unknown';
  readonly transition: ActivationTransitionObservation;
  readonly installedFingerprint: string | null;
  readonly contentRoots: readonly ContentRootObservation[];
  readonly retention: RetentionObservation;
}

export interface LifecycleReadbackObservation extends LifecycleReadbackData {
  readonly phase: 'observed';
  readonly [readbackObservationBrand]: true;
}

export interface ActivationPreparationCapture {
  readonly prior: LifecycleReadbackData;
  readonly expected: LifecycleReadbackData;
  readonly rollbackReference: string;
  /** Exact grouped operations restored by one leader rollback invocation. */
  readonly rollbackCoverageOperationIds: readonly string[];
}

export interface DisablePreparationCapture {
  readonly prior: LifecycleReadbackData;
  readonly rollbackReference: string;
  readonly rollbackCoverageOperationIds: readonly string[];
  readonly transition: ActivationTransitionObservation;
}

export interface RetirementPreparationCapture {
  readonly prior: LifecycleReadbackData;
  readonly rollbackReference: string;
  readonly rollbackCoverageOperationIds: readonly string[];
  readonly transition: ActivationTransitionObservation;
}

export interface DurableLifecycleOperation<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends LifecycleMutationAction = LifecycleMutationAction,
> {
  readonly schemaVersion: 1;
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
  readonly action: Action;
  readonly route: Route;
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
  readonly [durableOperationBrand]: true;
}

export interface PreparedActivationMutation<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends ActivationMutationAction = ActivationMutationAction,
> {
  readonly phase: 'prepared';
  readonly kind: 'activation';
  readonly handle: DurableLifecycleOperation<Route, Action>;
  readonly stagingRoot: string;
  readonly [projectionPhaseBrand]: 'prepared-activation';
}

export interface PreparedDisableMutation<Route extends SelectedLifecycleRoute = SelectedLifecycleRoute> {
  readonly phase: 'prepared';
  readonly kind: 'disable';
  readonly handle: DurableLifecycleOperation<Route, 'disable-nonconforming'>;
  readonly [projectionPhaseBrand]: 'prepared-disable';
}

export interface PreparedRetirementMutation<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends RetirementMutationAction = RetirementMutationAction,
> {
  readonly phase: 'prepared';
  readonly kind: 'retirement';
  readonly handle: DurableLifecycleOperation<Route, Action>;
  readonly [projectionPhaseBrand]: 'prepared-retirement';
}

export type PreparedLifecycleMutation =
  | PreparedActivationMutation
  | PreparedDisableMutation
  | PreparedRetirementMutation;

export interface MutationReceipt<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends LifecycleMutationAction = LifecycleMutationAction,
> {
  readonly phase: 'mutated';
  readonly handle: DurableLifecycleOperation<Route, Action>;
  readonly receiptId: string;
  readonly changed: boolean;
  readonly [projectionPhaseBrand]: 'mutated';
}

export interface VerifiedMutation<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends LifecycleMutationAction = LifecycleMutationAction,
> {
  readonly phase: 'verified';
  readonly handle: DurableLifecycleOperation<Route, Action>;
  readonly observation: LifecycleReadbackObservation;
  readonly [verifiedMutationBrand]: 'commit';
}

export interface RollbackReceipt<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends LifecycleMutationAction = LifecycleMutationAction,
> {
  readonly phase: 'rolled-back';
  readonly handle: DurableLifecycleOperation<Route, Action>;
  readonly receiptId: string;
  readonly changed: boolean;
  readonly [projectionPhaseBrand]: 'rolled-back';
}

export interface VerifiedRollback<
  Route extends SelectedLifecycleRoute = SelectedLifecycleRoute,
  Action extends LifecycleMutationAction = LifecycleMutationAction,
> {
  readonly phase: 'rollback-verified';
  readonly handle: DurableLifecycleOperation<Route, Action>;
  readonly observation: LifecycleReadbackObservation;
  readonly [verifiedMutationBrand]: 'rollback';
}

export type CleanupDisposition = 'aborted-preparation' | 'verified-commit' | 'verified-rollback';

export interface CleanupReference {
  readonly adapterId: string;
  readonly target: LifecycleTargetIdentity;
  readonly operationId: string;
  readonly attemptId: string;
  readonly artifactId: string | null;
}

export interface MutationResultData {
  readonly receiptId: string;
  readonly changed: boolean;
}

export interface CleanupResultData {
  readonly cleanupId: string;
  readonly completed: true;
}

export interface LifecycleHostDefinition {
  readonly id: string;
  readonly evidenceProfiles: readonly CapabilityEvidenceProfile[];
  probeVersion(target: LifecycleTargetIdentity): Promise<TargetVersionObservation>;
  observeTarget(target: LifecycleTargetIdentity): Promise<TargetInventoryData>;
  observeNativeMutationScope(request: NativeMutationScopeRequest): Promise<NativeMutationScopeData>;
  observeNativeProjection(request: NativeProjectionRequest): Promise<NativeProjectionData>;
  /** Read-only compare-and-swap precondition checked immediately before the first host mutation. */
  revalidateTargetPrecondition(handle: DurableLifecycleOperation): Promise<{
    readonly version: TargetVersionObservation;
    readonly targetObservationId: string;
  }>;
  stageActivation(request: ActivationPreparationRequest<SelectedLifecycleRoute>): Promise<{
    readonly stagingId: string;
    readonly stagingRoot: string;
  }>;
  applyLifecycleDirectives(projection: StagedProjection): Promise<readonly string[]>;
  applyPins(projection: DirectivesAppliedProjection): Promise<readonly string[]>;
  captureActivationPreparation(
    projection: PinsAppliedProjection,
    projectedFingerprint: string,
  ): Promise<ActivationPreparationCapture>;
  captureDisablePreparation(request: DisablePreparationRequest<SelectedLifecycleRoute>): Promise<DisablePreparationCapture>;
  captureRetirementPreparation(request: RetirementPreparationRequest<SelectedLifecycleRoute>): Promise<RetirementPreparationCapture>;
  apply(prepared: PreparedActivationMutation): Promise<MutationResultData>;
  disable(prepared: PreparedDisableMutation): Promise<MutationResultData>;
  retire(prepared: PreparedRetirementMutation): Promise<MutationResultData>;
  readback(handle: DurableLifecycleOperation): Promise<LifecycleReadbackData>;
  rollback(handle: DurableLifecycleOperation): Promise<MutationResultData>;
  cleanup(reference: CleanupReference, disposition: CleanupDisposition): Promise<CleanupResultData>;
}

export interface LifecycleHostAdapter {
  readonly id: string;
  probeVersion(target: LifecycleTargetIdentity): Promise<TargetVersionObservation>;
  observeTarget(target: LifecycleTargetIdentity): Promise<TargetInventoryObservation>;
  observeNativeMutationScope(request: NativeMutationScopeRequest): Promise<NativeMutationScopeObservation>;
  observeNativeProjection(request: NativeProjectionRequest): Promise<NativeProjectionObservation>;
  decideRoute<Operation extends CapabilityOperation>(
    request: LifecycleRouteRequest<Operation>,
  ): LifecycleRouteDecision<Operation>;
  stageActivation<Route extends SelectedLifecycleRoute, Action extends ActivationMutationAction>(
    request: ActivationPreparationRequest<Route, Action>,
  ): Promise<StagedProjection<Route, Action>>;
  applyLifecycleDirectives<Route extends SelectedLifecycleRoute, Action extends ActivationMutationAction>(
    projection: StagedProjection<Route, Action>,
  ): Promise<DirectivesAppliedProjection<Route, Action>>;
  applyPins<Route extends SelectedLifecycleRoute, Action extends ActivationMutationAction>(
    projection: DirectivesAppliedProjection<Route, Action>,
  ): Promise<PinsAppliedProjection<Route, Action>>;
  sealActivation<Route extends SelectedLifecycleRoute, Action extends ActivationMutationAction>(
    projection: PinsAppliedProjection<Route, Action>,
  ): Promise<PreparedActivationMutation<Route, Action>>;
  prepareDisable<Route extends SelectedLifecycleRoute>(request: DisablePreparationRequest<Route>): Promise<PreparedDisableMutation<Route>>;
  prepareRetirement<Route extends SelectedLifecycleRoute, Action extends RetirementMutationAction>(
    request: RetirementPreparationRequest<Route, Action>,
  ): Promise<PreparedRetirementMutation<Route, Action>>;
  apply<Route extends SelectedLifecycleRoute, Action extends ActivationMutationAction>(
    prepared: PreparedActivationMutation<Route, Action>,
  ): Promise<MutationReceipt<Route, Action>>;
  disable<Route extends SelectedLifecycleRoute>(prepared: PreparedDisableMutation<Route>): Promise<MutationReceipt<Route, 'disable-nonconforming'>>;
  retire<Route extends SelectedLifecycleRoute, Action extends RetirementMutationAction>(
    prepared: PreparedRetirementMutation<Route, Action>,
  ): Promise<MutationReceipt<Route, Action>>;
  readback<Route extends SelectedLifecycleRoute, Action extends LifecycleMutationAction>(
    handle: DurableLifecycleOperation<Route, Action>,
  ): Promise<LifecycleReadbackObservation>;
  verify<Route extends SelectedLifecycleRoute, Action extends LifecycleMutationAction>(
    handle: DurableLifecycleOperation<Route, Action>,
    observation: LifecycleReadbackObservation,
  ): VerifiedMutation<Route, Action>;
  rollback<Route extends SelectedLifecycleRoute, Action extends LifecycleMutationAction>(
    handle: DurableLifecycleOperation<Route, Action>,
  ): Promise<RollbackReceipt<Route, Action>>;
  verifyRollback<Route extends SelectedLifecycleRoute, Action extends LifecycleMutationAction>(
    handle: DurableLifecycleOperation<Route, Action>,
    observation: LifecycleReadbackObservation,
  ): VerifiedRollback<Route, Action>;
  cleanup(
    target: StagedProjection | DirectivesAppliedProjection | PinsAppliedProjection | PreparedLifecycleMutation | DurableLifecycleOperation,
    disposition: CleanupDisposition,
  ): Promise<CleanupResultData>;
}
