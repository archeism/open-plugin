import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { which } from './exec';
import { unknownErrorDiagnostic } from './error-diagnostic';
import type { FrozenPackageSnapshot, LifecycleTargetIdentity, RecordedOwnedActivation, SelectedLifecycleRoute, SelectedRouteDecision, TargetInstallationData } from './lifecycle-host';
import {
  exitCodeForLifecycleReport,
  parseLifecycleReport,
  createLifecycleReason,
  type LifecycleOperationOutcome,
  type LifecyclePlanOperation,
  type LifecycleReason,
  type LifecycleReport,
} from './lifecycle-report';
import { LifecycleHostPhaseError, createFrozenPackageSnapshot, createLifecyclePlanCoverage, createResolvedLifecyclePins } from './lifecycle-runtime';
import { ownedActivation, retirementTombstone } from './owned-activation';
import { lifecycleAttemptIdForPlannedScopes, type LifecyclePlan, type PlannerHost } from './planner';
import { inventoryPackageSemantics, type PackageSemanticInventory } from './semantic-inventory';
import { CryptoHasher } from './runtime';
import { resolveSource, type FrozenSource, type PluginSource } from './source';
import type { SourceBinding } from './source-reference';
import { readLifecycleState, type ActivationRecord, type DeploymentScopeRecord, type JournalAction, type JournalEntryRecord, type JournalState, type LifecycleAttemptRecord, type LifecycleStateV2 } from './state';
import { writeLifecycleState } from './state-write';

export interface ExecuteLifecycleInput {
  readonly plan: LifecyclePlan;
  readonly hosts: readonly PlannerHost[];
  readonly now: string;
}

export interface ExecuteLifecycleResult {
  readonly report: LifecycleReport;
  readonly exitCode: ReturnType<typeof exitCodeForLifecycleReport>;
}

type FrozenPlan = Extract<LifecyclePlan, { kind: 'frozen' }>;
type OperationStep = {
  readonly outcome: LifecycleOperationOutcome;
  readonly stop: boolean;
  readonly reason: LifecycleReason | null;
};

export async function executeLifecycle(input: ExecuteLifecycleInput): Promise<ExecuteLifecycleResult> {
  switch (input.plan.kind) {
    case 'zero-write-failure':
      return finish(input.plan.report);
    case 'frozen':
      if (input.plan.requestedDryRun) return finish(input.plan.report);
      return executeFrozen(input.plan, input.hosts, input.now);
    default: {
      const unreachable: never = input.plan;
      throw new Error(`unknown lifecycle plan ${String(unreachable)}`);
    }
  }
}

async function executeFrozen(
  plan: FrozenPlan,
  hosts: readonly PlannerHost[],
  now: string,
): Promise<ExecuteLifecycleResult> {
  const ledger = new Ledger(now);
  const refusal = ledger.generationRefusal(plan);
  if (refusal !== null) return refusalReport(plan, refusal);
  const outcomes: LifecycleOperationOutcome[] = [];
  let stopped: LifecycleReason | null = null;
  for (const row of plan.operations) {
    if (stopped !== null) {
      outcomes.push(notAttempted(row.operation, stopped));
      continue;
    }
    if (row.operation.action === 'retain-prior' || row.operation.action === 'not-attempted') {
      const planned = plan.report.outcomes.find((outcome) => outcome.operationId === row.operation.operationId);
      if (planned !== undefined) {
        outcomes.push(planned);
        continue;
      }
    }
    const result = await runOperation(plan, row.operation, hosts, ledger);
    outcomes.push(result.outcome);
    if (result.stop && result.reason !== null) stopped = result.reason;
  }
  return finish(parseLifecycleReport({
    schemaVersion: 1,
    command: plan.report.command,
    plan: plan.report.plan,
    outcomes,
    summary: summaryFor(outcomes),
  }));
}

async function runOperation(
  plan: FrozenPlan,
  operation: LifecyclePlanOperation,
  hosts: readonly PlannerHost[],
  ledger: Ledger,
): Promise<OperationStep> {
  switch (operation.action) {
    case 'install':
      return runActivation(plan, operation, hosts, ledger, 'install');
    case 'update':
      return runActivation(plan, operation, hosts, ledger, 'update');
    case 'unchanged':
      return succeeded(operation, false);
    case 'retire-orphan':
      return runRetire(plan, operation, hosts, ledger);
    case 'route-migrate':
    case 'disable-nonconforming':
    case 'retain-prior':
    case 'not-attempted':
      return stop(operation, createLifecycleReason(
        'internal',
        'internal.invariant',
        `operation '${operation.operationId}' is not applied by this execution slice`,
      ));
    default: {
      const unreachable: never = operation.action;
      throw new Error(`unknown plan action ${String(unreachable)}`);
    }
  }
}

async function runActivation(
  plan: FrozenPlan,
  operation: LifecyclePlanOperation,
  hosts: readonly PlannerHost[],
  ledger: Ledger,
  action: 'install' | 'update',
): Promise<OperationStep> {
  if (ledger.journalState(plan.attemptId, operation.operationId) === 'completed') return succeeded(operation, false);
  const nativeId = operation.nativeId;
  if (nativeId === null) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `${action} '${operation.operationId}' has no native identity`));
  }
  const host = hosts.find((candidate) => candidate.kinds.includes(operation.scope.target.kind));
  if (host === undefined) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `${action} '${operation.package}' has no host adapter`));
  }
  let prepared: Awaited<ReturnType<typeof prepareActivation>>;
  try {
    const recordedPins = ledger.activation(operation.scope.id, operation.package, nativeId)?.pins ?? [];
    prepared = await prepareActivation(plan, operation, host, nativeId, action, recordedPins);
  } catch (error) {
    return stop(operation, thrownReason(error));
  }
  if (prepared.kind === 'refused') return stop(operation, prepared.reason);
  try {
    ledger.acceptJournal(plan, operation, action);
  } catch (error) {
    return stop(operation, thrownReason(error));
  }
  let preparation: Parameters<PlannerHost['adapter']['cleanup']>[0] | undefined;
  let handle: Parameters<PlannerHost['adapter']['rollback']>[0] | undefined;
  let receipt: Awaited<ReturnType<PlannerHost['adapter']['apply']>> | undefined;
  let verified: ReturnType<PlannerHost['adapter']['verify']> | undefined;
  try {
    const staged = await host.adapter.stageActivation({
      selection: prepared.selection,
      snapshot: prepared.snapshot,
      pins: prepared.pins,
    });
    preparation = staged;
    const directed = await host.adapter.applyLifecycleDirectives(staged);
    preparation = directed;
    const pinned = await host.adapter.applyPins(directed);
    preparation = pinned;
    const sealed = await host.adapter.sealActivation(pinned);
    preparation = sealed;
    handle = sealed.handle;
    ledger.markApplying(plan, operation);
    receipt = await host.adapter.apply(sealed);
    const observation = await host.adapter.readback(receipt.handle);
    verified = host.adapter.verify(receipt.handle, observation);
  } catch (error) {
    const reason = thrownReason(error);
    if (handle !== undefined && ledger.journalState(plan.attemptId, operation.operationId) === 'applying') {
      return recoverApplied(plan, operation, host, ledger, handle, reason);
    }
    if (preparation !== undefined) await abortPreparation(host, preparation);
    return stop(operation, reason);
  }
  if (receipt === undefined || verified === undefined) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `${action} '${operation.operationId}' produced no verified activation`));
  }
  const projected = verified.handle.projectedFingerprint;
  const installed = verified.observation.installedFingerprint;
  if (projected === null || installed === null) {
    return recoverApplied(
      plan,
      operation,
      host,
      ledger,
      verified.handle,
      createLifecycleReason('internal', 'internal.invariant', `${action} '${operation.operationId}' readback has no fingerprint`),
    );
  }
  const recorded = ledger.activation(operation.scope.id, operation.package, nativeId);
  try {
    ledger.confirmActivation(plan, operation, {
      scopeId: operation.scope.id,
      packageId: operation.package,
      nativeId,
      sourceRelativeDir: sourceRelativeDir(plan, operation),
      sourceRevision: verified.handle.sourceRevision,
      route: { kind: verified.handle.route, evidenceKey: { kind: 'capability-profile', key: verified.handle.evidenceId } },
      ownership: recorded?.ownership.kind === 'created' || recorded?.ownership.kind === 'adopted'
        ? recorded.ownership
        : {
          kind: 'created',
          proofKey: { kind: 'managed-marker', key: contentAddress(receipt.receiptId) },
          verifiedAt: ledger.timestamp(),
        },
      fingerprints: {
        source: prepared.snapshot.packageFingerprint,
        projected,
        installed,
      },
      activationState: 'active',
      readbackState: 'verified',
      pins: [...prepared.pinNames],
      activatedAt: recorded?.activatedAt ?? ledger.timestamp(),
      readbackAt: ledger.timestamp(),
      createdAt: recorded?.createdAt ?? ledger.timestamp(),
      updatedAt: ledger.timestamp(),
    });
  } catch (error) {
    return recoverApplied(plan, operation, host, ledger, verified.handle, thrownReason(error));
  }
  try {
    await host.adapter.cleanup(verified.handle, 'verified-commit');
  } catch {
    ledger.markCleanupPending(plan, operation, action);
    return pendingCleanup(operation);
  }
  ledger.markCompleted(plan, operation);
  return succeeded(operation, receipt.changed, prepared.notices);
}

async function prepareActivation(
  plan: FrozenPlan,
  operation: LifecyclePlanOperation,
  host: PlannerHost,
  nativeId: string,
  action: 'install' | 'update',
  recordedPins: readonly string[],
): Promise<
  | {
      readonly kind: 'ready';
      readonly selection: SelectedRouteDecision<SelectedLifecycleRoute, 'install' | 'update'>;
      readonly snapshot: FrozenPackageSnapshot & { readonly action: 'install' | 'update' };
      readonly pins: ReturnType<typeof createResolvedLifecyclePins>;
      readonly pinNames: readonly string[];
      readonly notices: readonly string[];
    }
  | { readonly kind: 'refused'; readonly reason: LifecycleReason }
> {
  const context = plan.report.command.sourceSnapshots.find((snapshot) => snapshot.id === operation.sourceSnapshotId);
  if (context === undefined) {
    return refused(createLifecycleReason('internal', 'internal.invariant', `${action} '${operation.package}' has no frozen source snapshot`));
  }
  const frozen = resolveSource(sourceArgument(operation.scope.source));
  if (frozen.snapshot.fingerprint !== context.reference.fingerprint || frozen.snapshot.revision !== context.reference.revision) {
    return refused(createLifecycleReason('internal', 'internal.invariant', `${action} '${operation.package}' source bytes drifted from the frozen snapshot`));
  }
  const plugin = frozen.plugins.find((candidate) => candidate.name === operation.package);
  const packageFingerprint = plugin?.contentFingerprint;
  if (plugin === undefined || packageFingerprint === undefined) {
    return refused(createLifecycleReason('internal', 'internal.invariant', `${action} '${operation.package}' is missing from the frozen source`));
  }
  const target = lifecycleTarget(operation);
  const observation = await host.adapter.observeTarget(target);
  const version = await host.adapter.probeVersion(observation.target);
  if (version.kind !== 'detected') {
    return refused(createLifecycleReason('runtime', 'runtime.operation-failed', `${action} '${operation.package}' lost its detected target version`));
  }
  const inventory = inventoryPackageSemantics(plugin);
  const resolvedPins = resolveRecordedPinExecutables(plugin.dir, recordedPins);
  if (resolvedPins.kind === 'refused') return refused(resolvedPins.reason);
  const pins = createResolvedLifecyclePins(resolvedPins.pins);
  const pinNames = resolvedPins.pins.map((pin) => pin.server);
  const notices = resolvedPins.dropped.map((server) => `dropped pin '${server}'`);
  const snapshot = sealActivationSnapshot(operation, plan.attemptId, nativeId, frozen, plugin, packageFingerprint, inventory, observation.target, action);
  const planCoverage = createLifecyclePlanCoverage(observation, [{
    nativeId,
    operationId: operation.operationId,
    operation: action,
    mutationGroupId: operation.operationId,
    authorization: action === 'update' ? 'observed-owned' : 'planned-create',
  }]);
  const sourceType = operation.scope.source.kind;
  const nativeScope = await host.adapter.observeNativeMutationScope({
    targetObservation: observation,
    operation: action,
    packageName: plugin.name,
    nativeId,
    sourceType,
  });
  const nativeProjection = await host.adapter.observeNativeProjection({
    targetObservation: observation,
    operation: action,
    snapshot,
    pins,
  });
  const decision = host.adapter.decideRoute({
    target: observation.target,
    operation: action,
    operationId: operation.operationId,
    attemptId: plan.attemptId,
    scopeId: operation.scope.id,
    packageName: plugin.name,
    nativeId,
    version,
    sourceType,
    targetObservation: observation,
    nativeScope,
    nativeProjection,
    planCoverage,
    snapshot,
    pins,
  });
  if (decision.kind !== 'selected' || decision.operation !== action || decision.route !== operation.route) {
    return refused(createLifecycleReason(
      'runtime',
      'runtime.operation-failed',
      `${action} '${operation.package}' kept frozen route '${operation.route}'`,
    ));
  }
  return { kind: 'ready', selection: decision, snapshot, pins, pinNames, notices };
}

function sealActivationSnapshot(
  operation: LifecyclePlanOperation,
  attemptId: string,
  nativeId: string,
  frozen: FrozenSource,
  plugin: PluginSource,
  packageFingerprint: string,
  inventory: PackageSemanticInventory,
  target: LifecycleTargetIdentity,
  action: 'install' | 'update',
): FrozenPackageSnapshot & { readonly action: 'install' | 'update' } {
  const relativePackagePath = plugin.relativeDir !== undefined && plugin.relativeDir.length > 0 ? plugin.relativeDir : '.';
  const snapshot = createFrozenPackageSnapshot({
    operationId: operation.operationId,
    attemptId,
    scopeId: operation.scope.id,
    target,
    action,
    packageName: plugin.name,
    nativeId,
    sourceType: operation.scope.source.kind,
    immutableRevision: frozen.snapshot.revision,
    snapshotRoot: frozen.snapshotDir,
    packageRoot: plugin.dir,
    relativePackagePath,
    snapshotFingerprint: frozen.snapshot.fingerprint,
    packageFingerprint,
    inventory,
  });
  if (snapshot.action !== action) throw new Error(`frozen snapshot action '${snapshot.action}' is not ${action}`);
  return snapshot as FrozenPackageSnapshot & { readonly action: 'install' | 'update' };
}

async function runRetire(
  plan: FrozenPlan,
  operation: LifecyclePlanOperation,
  hosts: readonly PlannerHost[],
  ledger: Ledger,
): Promise<OperationStep> {
  if (ledger.journalState(plan.attemptId, operation.operationId) === 'completed') return retired(operation, false);
  const nativeId = operation.nativeId;
  if (nativeId === null) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `retirement '${operation.operationId}' has no native identity`));
  }
  const planned = plan.scopes.find((scope) => scope.scope.id === operation.scope.id);
  if (planned === undefined || planned.prune !== 'planned') {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `retirement '${operation.package}' is blocked for this scope`));
  }
  const host = hosts.find((candidate) => candidate.kinds.includes(operation.scope.target.kind));
  if (host === undefined) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `retirement '${operation.package}' has no host adapter`));
  }
  let prepared: Awaited<ReturnType<typeof prepareRetirement>>;
  try {
    prepared = await prepareRetirement(plan, operation, host, nativeId, ledger);
  } catch (error) {
    return stop(operation, thrownReason(error));
  }
  if (prepared.kind === 'refused') return stop(operation, prepared.reason);
  try {
    ledger.acceptJournal(plan, operation, 'retire-orphan');
  } catch (error) {
    return stop(operation, thrownReason(error));
  }
  let receipt: Awaited<ReturnType<PlannerHost['adapter']['retire']>> | undefined;
  let verified: ReturnType<PlannerHost['adapter']['verify']> | undefined;
  try {
    const sealed = await host.adapter.prepareRetirement({
      operationId: operation.operationId,
      attemptId: plan.attemptId,
      action: 'retire-orphan',
      selection: prepared.selection,
      activation: prepared.activation,
    });
    ledger.markPruning(plan, operation);
    receipt = await host.adapter.retire(sealed);
    const observation = await host.adapter.readback(receipt.handle);
    verified = host.adapter.verify(receipt.handle, observation);
    ledger.confirmRetirement(plan, operation, prepared.recorded);
  } catch (error) {
    return stop(operation, thrownReason(error));
  }
  if (receipt === undefined || verified === undefined) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `retirement '${operation.operationId}' produced no verified removal`));
  }
  try {
    await host.adapter.cleanup(verified.handle, 'verified-commit');
  } catch {
    ledger.markCleanupPending(plan, operation, 'retire-orphan');
    return pendingCleanup(operation);
  }
  ledger.markCompleted(plan, operation);
  return retired(operation, receipt.changed);
}

async function prepareRetirement(
  plan: FrozenPlan,
  operation: LifecyclePlanOperation,
  host: PlannerHost,
  nativeId: string,
  ledger: Ledger,
): Promise<
  | {
      readonly kind: 'ready';
      readonly selection: SelectedRouteDecision<SelectedLifecycleRoute, 'retire'>;
      readonly activation: RecordedOwnedActivation;
      readonly recorded: ActivationRecord;
    }
  | { readonly kind: 'refused'; readonly reason: LifecycleReason }
> {
  const recorded = ledger.activation(operation.scope.id, operation.package, nativeId);
  if (recorded === undefined || recorded.route.kind === 'legacy-unverified' || recorded.ownership.kind === 'legacy-claim' || recorded.sourceRevision === undefined) {
    return refused(createLifecycleReason('internal', 'internal.invariant', `ownership of '${operation.package}' was not revalidated`));
  }
  const target = lifecycleTarget(operation);
  const observation = await host.adapter.observeTarget(target);
  const installation = observation.installations.find((row) => row.nativeId === nativeId);
  if (installation === undefined || installation.presence !== 'present' || installation.ownership.kind !== 'owned' || installation.ownership.scopeId !== operation.scope.id) {
    return refused(createLifecycleReason('internal', 'internal.ambiguous-ownership', `package '${nativeId}' on ${operation.scope.target.kind}/${operation.scope.target.instance} is not ownership-proven`));
  }
  const version = await host.adapter.probeVersion(observation.target);
  if (version.kind !== 'detected') {
    return refused(createLifecycleReason('runtime', 'runtime.operation-failed', `retirement '${operation.package}' lost its detected target version`));
  }
  if (recorded.fingerprints.installed !== installation.installedFingerprint) {
    return refused(createLifecycleReason('internal', 'internal.invariant', `retirement '${operation.package}' fingerprint does not match the owned install`));
  }
  const owned = ownedActivation(operation.scope, operation.scope.source, recorded, installation, observation.target);
  if (owned === null) {
    return refused(createLifecycleReason('internal', 'internal.invariant', `ownership of '${operation.package}' was not revalidated`));
  }
  const planCoverage = createLifecyclePlanCoverage(observation, [{
    nativeId,
    operationId: operation.operationId,
    operation: 'retire',
    mutationGroupId: operation.operationId,
    authorization: 'observed-owned',
  }]);
  const nativeScope = await host.adapter.observeNativeMutationScope({
    targetObservation: observation,
    operation: 'retire',
    packageName: owned.packageName,
    nativeId,
    sourceType: owned.sourceType,
  });
  const nativeProjection = await host.adapter.observeNativeProjection({
    targetObservation: observation,
    operation: 'retire',
    operationId: operation.operationId,
    attemptId: plan.attemptId,
    activation: owned,
  });
  const decision = host.adapter.decideRoute({
    target: observation.target,
    operation: 'retire',
    operationId: operation.operationId,
    attemptId: plan.attemptId,
    scopeId: operation.scope.id,
    packageName: owned.packageName,
    nativeId,
    version,
    sourceType: owned.sourceType,
    targetObservation: observation,
    nativeScope,
    nativeProjection,
    planCoverage,
    activation: owned,
  });
  if (decision.kind !== 'selected' || decision.operation !== 'retire' || decision.route !== operation.route) {
    return refused(createLifecycleReason('runtime', 'runtime.operation-failed', `retirement '${operation.package}' kept frozen route '${operation.route}'`));
  }
  return { kind: 'ready', selection: decision, activation: owned, recorded };
}

function lifecycleTarget(operation: LifecyclePlanOperation): LifecycleTargetIdentity {
  return { kind: operation.scope.target.kind, instance: operation.scope.target.instance };
}

function sourceArgument(source: SourceBinding): string {
  switch (source.kind) {
    case 'local':
      return source.locator;
    case 'git':
      return source.ref === 'HEAD' ? source.locator : `${source.locator}#${source.ref}`;
    default: {
      const unreachable: never = source;
      throw new Error(`unknown source ${String(unreachable)}`);
    }
  }
}

class Ledger {
  private state: LifecycleStateV2;
  private baselineGeneration: number;

  constructor(private readonly now: string) {
    const loaded = readLifecycleState();
    this.state = loaded.state;
    this.baselineGeneration = loaded.state.stateGeneration;
  }

  generationRefusal(plan: FrozenPlan): LifecycleReason | null {
    const latest = this.state.attempts.at(-1);
    if (latest?.id === plan.attemptId) return null;
    if (lifecycleAttemptIdForPlannedScopes(this.baselineGeneration, plan.scopes) === plan.attemptId) return null;
    return createLifecycleReason(
      'internal',
      'internal.invariant',
      `plan '${plan.attemptId}' does not match state generation ${this.baselineGeneration}`,
    );
  }

  acceptJournal(plan: FrozenPlan, operation: LifecyclePlanOperation, action: Extract<JournalAction, 'install' | 'update' | 'retire-orphan'>): void {
    const entry: JournalEntryRecord = {
      operationId: operation.operationId,
      scopeId: operation.scope.id,
      packageId: operation.package,
      ...(operation.nativeId === null ? {} : { nativeId: operation.nativeId }),
      action,
      state: 'pending',
      startedAt: this.now,
      updatedAt: this.now,
    };
    const existing = this.state.attempts.find((attempt) => attempt.id === plan.attemptId);
    const journal = existing === undefined ? [entry] : [...existing.journal.filter((row) => row.operationId !== entry.operationId), entry];
    const attempt: LifecycleAttemptRecord = {
      id: plan.attemptId,
      command: plan.report.command.name,
      phase: 'accepted',
      mutationStarted: existing?.mutationStarted === true || journal.some((row) => mutationBegan(row.state)),
      scopeIds: plan.scopes.map((scope) => scope.scope.id),
      journal,
      startedAt: existing?.startedAt ?? this.now,
      updatedAt: this.now,
    };
    this.state = {
      ...this.state,
      scopes: this.mergedScopes(plan, plan.attemptId),
      attempts: existing === undefined
        ? [...this.state.attempts, attempt]
        : this.state.attempts.map((row) => row.id === attempt.id ? attempt : row),
    };
    this.save();
  }

  timestamp(): string {
    return this.now;
  }

  journalState(attemptId: string, operationId: string): JournalState | undefined {
    return this.state.attempts.find((attempt) => attempt.id === attemptId)?.journal.find((row) => row.operationId === operationId)?.state;
  }

  activation(scopeId: string, packageId: string, nativeId: string): ActivationRecord | undefined {
    return this.state.activations.find((row) => row.scopeId === scopeId && row.packageId === packageId && row.nativeId === nativeId);
  }

  markApplying(plan: FrozenPlan, operation: LifecyclePlanOperation): void {
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'applying', 'applying', true));
  }

  markPruning(plan: FrozenPlan, operation: LifecyclePlanOperation): void {
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'applying', 'pruning', true));
  }

  confirmRetirement(plan: FrozenPlan, operation: LifecyclePlanOperation, recorded: ActivationRecord): void {
    const current = this.activation(recorded.scopeId, recorded.packageId, recorded.nativeId) ?? recorded;
    const tombstone = retirementTombstone(current, this.now);
    if (tombstone === null) throw new Error(`retirement '${operation.operationId}' cannot retain a tombstone`);
    this.state = {
      ...this.state,
      activations: this.state.activations.filter((row) => activationKey(row) !== activationKey(current)),
      tombstones: this.state.tombstones.some((row) => row.id === tombstone.id) ? this.state.tombstones : [...this.state.tombstones, tombstone],
    };
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'readback-verified', 'pruning', true));
  }

  confirmActivation(plan: FrozenPlan, operation: LifecyclePlanOperation, activation: ActivationRecord): void {
    this.state = {
      ...this.state,
      activations: [...this.state.activations.filter((row) => activationKey(row) !== activationKey(activation)), activation],
    };
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'readback-verified', 'readback', true));
  }

  markCleanupPending(plan: FrozenPlan, operation: LifecyclePlanOperation, action: 'install' | 'update' | 'retire-orphan'): void {
    this.state = {
      ...this.state,
      activations: this.state.activations.map((row) => row.packageId === operation.package && row.scopeId === operation.scope.id
        ? {
          ...row,
          pending: { operation: action, phase: 'cleanup', attemptId: plan.attemptId, startedAt: this.now },
          updatedAt: this.now,
        }
        : row),
    };
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'cleanup-pending', 'finalizing', true));
  }

  markRolledBack(plan: FrozenPlan, operation: LifecyclePlanOperation): void {
    this.adoptMovedGeneration();
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'rolled-back', 'failed', true));
  }

  markRollbackRequired(plan: FrozenPlan, operation: LifecyclePlanOperation): void {
    this.adoptMovedGeneration();
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'rollback', 'recovery-required', true));
  }

  markCompleted(plan: FrozenPlan, operation: LifecyclePlanOperation): void {
    const desiredPairs = plan.operations.filter((row) => row.operation.scope.id === operation.scope.id && row.operation.coverage === 'desired-pair');
    const converged = desiredPairs.every((row) =>
      row.operation.operationId === operation.operationId
      || this.journalState(plan.attemptId, row.operation.operationId) === 'completed');
    this.state = {
      ...this.state,
      scopes: this.state.scopes.map((scope) => this.completedScope(plan, operation, scope, converged)),
    };
    this.replaceAttempt(plan, (attempt) => ({
      ...this.journaled(attempt, operation.operationId, 'completed', 'completed', true),
      completedAt: this.now,
    }));
  }

  private completedScope(plan: FrozenPlan, operation: LifecyclePlanOperation, scope: DeploymentScopeRecord, converged: boolean): DeploymentScopeRecord {
    if (scope.id !== operation.scope.id) return scope;
    const planned = plan.scopes.find((row) => row.scope.id === scope.id);
    if (planned?.selectorMode === 'retired') {
      const { desired: _desired, lastConverged: _converged, ...kept } = scope;
      return {
        ...kept,
        lifecycle: 'retired',
        selectorMode: 'retired',
        updatedAt: this.now,
        retiredAt: this.now,
      };
    }
    if (!converged || scope.desired === undefined) return scope;
    return { ...scope, lastConverged: scope.desired, updatedAt: this.now };
  }

  private replaceAttempt(plan: FrozenPlan, update: (attempt: LifecycleAttemptRecord) => LifecycleAttemptRecord): void {
    const existing = this.state.attempts.find((attempt) => attempt.id === plan.attemptId);
    if (existing === undefined) return;
    const attempt = update(existing);
    this.state = {
      ...this.state,
      attempts: this.state.attempts.map((row) => row.id === attempt.id ? attempt : row),
    };
    this.save();
  }

  private journaled(
    attempt: LifecycleAttemptRecord,
    operationId: string,
    state: JournalState,
    phase: LifecycleAttemptRecord['phase'],
    mutationStarted: boolean,
  ): LifecycleAttemptRecord {
    return {
      ...attempt,
      phase,
      mutationStarted,
      journal: attempt.journal.map((row) => row.operationId === operationId ? { ...row, state, updatedAt: this.now } : row),
      updatedAt: this.now,
    };
  }

  private mergedScopes(plan: FrozenPlan, attemptId: string): DeploymentScopeRecord[] {
    const replacements = new Map<string, DeploymentScopeRecord>();
    for (const planned of plan.scopes) {
      const next = this.recordedScope(planned, attemptId);
      if (next !== null) replacements.set(planned.scope.id, next);
    }
    const merged: DeploymentScopeRecord[] = [];
    const replaced = new Set<string>();
    for (const existing of this.state.scopes) {
      const next = replacements.get(existing.id);
      if (next === undefined) {
        merged.push(existing);
        continue;
      }
      merged.push(next);
      replaced.add(existing.id);
    }
    for (const planned of plan.scopes) {
      if (replaced.has(planned.scope.id)) continue;
      const created = replacements.get(planned.scope.id);
      if (created !== undefined) merged.push(created);
    }
    return merged;
  }

  private recordedScope(planned: FrozenPlan['scopes'][number], attemptId: string): DeploymentScopeRecord | null {
    if (planned.desired === null || planned.selectorMode === 'retired') return null;
    const existing = this.state.scopes.find((scope) => scope.id === planned.scope.id);
    if (existing !== undefined && existing.authority !== 'authoritative') return existing;
    const selectorMode = planned.selectorMode;
    const target = { kind: planned.scope.target.kind, instance: planned.scope.target.instance };
    if (existing === undefined) {
      return {
        id: planned.scope.id,
        source: planned.scope.source,
        target,
        authority: 'authoritative',
        lifecycle: 'active',
        selectorMode,
        desired: planned.desired,
        lastAttemptId: attemptId,
        createdAt: this.now,
        updatedAt: this.now,
      };
    }
    return {
      ...existing,
      source: planned.scope.source,
      target,
      authority: existing.authority,
      lifecycle: 'active',
      selectorMode,
      desired: planned.desired,
      lastAttemptId: attemptId,
      createdAt: existing.createdAt,
      updatedAt: this.now,
    };
  }

  private adoptMovedGeneration(): void {
    const loaded = readLifecycleState();
    if (loaded.state.stateGeneration === this.baselineGeneration) return;
    this.state = loaded.state;
    this.baselineGeneration = loaded.state.stateGeneration;
  }

  private save(): void {
    const previous = readLifecycleState();
    if (previous.state.stateGeneration !== this.baselineGeneration) {
      throw new Error(`state generation moved from ${this.baselineGeneration} to ${previous.state.stateGeneration}`);
    }
    const stateGeneration = previous.sourceVersion === 2 ? previous.state.stateGeneration + 1 : 1;
    const next = { ...this.state, stateGeneration };
    writeLifecycleState(next, { globalPreflight: 'succeeded' });
    this.baselineGeneration = stateGeneration;
    this.state = next;
  }
}

function finish(report: LifecycleReport): ExecuteLifecycleResult {
  return { report, exitCode: exitCodeForLifecycleReport(report) };
}

function activationKey(activation: ActivationRecord): string {
  return `${activation.scopeId}\0${activation.packageId}\0${activation.nativeId}`;
}

function sourceRelativeDir(plan: FrozenPlan, operation: LifecyclePlanOperation): string {
  const desired = plan.scopes.find((scope) => scope.scope.id === operation.scope.id)?.desired;
  return desired?.packages.find((pkg) => pkg.packageId === operation.package)?.sourceRelativeDir ?? '.';
}

function contentAddress(value: string): string {
  const hash = new CryptoHasher('sha256');
  hash.update(value);
  return `sha256:${hash.digest('hex')}`;
}

function retired(operation: LifecyclePlanOperation, changed: boolean): OperationStep {
  return {
    stop: false,
    reason: null,
    outcome: {
      ...operation,
      result: 'succeeded',
      resourceState: 'absent',
      activationState: 'inactive',
      changed,
      reason: null,
    },
  };
}

function mutationBegan(state: JournalState): boolean {
  switch (state) {
    case 'applying':
    case 'applied':
    case 'readback-verified':
    case 'rollback':
    case 'rolled-back':
    case 'cleanup-pending':
    case 'completed':
    case 'failed':
      return true;
    case 'pending':
    case 'not-attempted':
      return false;
    default: {
      const unreachable: never = state;
      throw new Error(`unknown journal state ${String(unreachable)}`);
    }
  }
}

function succeeded(operation: LifecyclePlanOperation, changed: boolean, notices: readonly string[] = []): OperationStep {
  return {
    stop: false,
    reason: null,
    outcome: {
      ...operation,
      result: 'succeeded',
      resourceState: 'present',
      activationState: 'active-conforming',
      changed,
      reason: null,
      ...(notices.length === 0 ? {} : { notices: [...notices] }),
    },
  };
}

async function recoverApplied(
  plan: FrozenPlan,
  operation: LifecyclePlanOperation,
  host: PlannerHost,
  ledger: Ledger,
  handle: Parameters<PlannerHost['adapter']['rollback']>[0],
  reason: LifecycleReason,
): Promise<OperationStep> {
  try {
    await host.adapter.rollback(handle);
    const observation = await host.adapter.readback(handle);
    host.adapter.verifyRollback(handle, observation);
  } catch {
    ledger.markRollbackRequired(plan, operation);
    return pendingRecovery(operation);
  }
  ledger.markRolledBack(plan, operation);
  try {
    await host.adapter.cleanup(handle, 'verified-rollback');
  } catch {}
  return reportedRollback(operation, reason);
}

async function abortPreparation(
  host: PlannerHost,
  preparation: Parameters<PlannerHost['adapter']['cleanup']>[0],
): Promise<void> {
  try {
    await host.adapter.cleanup(preparation, 'aborted-preparation');
  } catch {
    return;
  }
}

function reportedRollback(operation: LifecyclePlanOperation, reason: LifecycleReason): OperationStep {
  if (reason.category === 'readback') return pendingReadback(operation, reason);
  return mutatedFailure(operation, reason);
}

function pendingReadback(operation: LifecyclePlanOperation, reason: LifecycleReason): OperationStep {
  return {
    stop: true,
    reason,
    outcome: {
      ...operation,
      result: 'pending',
      resourceState: 'potentially-changed',
      activationState: 'unknown',
      changed: true,
      reason,
    },
  };
}

function pendingRecovery(operation: LifecyclePlanOperation): OperationStep {
  const reason = createLifecycleReason('recovery', 'recovery.required', `rollback for '${operation.operationId}' did not verify`);
  return {
    stop: true,
    reason,
    outcome: {
      ...operation,
      result: 'pending',
      resourceState: 'potentially-changed',
      activationState: 'unknown',
      changed: true,
      reason,
    },
  };
}

function mutatedFailure(operation: LifecyclePlanOperation, reason: LifecycleReason): OperationStep {
  return {
    stop: true,
    reason,
    outcome: {
      ...operation,
      result: 'failed',
      resourceState: 'potentially-changed',
      activationState: 'unknown',
      changed: true,
      reason,
    },
  };
}

function pendingCleanup(operation: LifecyclePlanOperation): OperationStep {
  const reason = createLifecycleReason('recovery', 'recovery.required', `cleanup for '${operation.operationId}' is still pending after the confirmed activation`);
  return {
    stop: true,
    reason,
    outcome: {
      ...operation,
      result: 'pending',
      resourceState: 'present',
      activationState: 'active-conforming',
      changed: true,
      reason,
    },
  };
}

function stop(
  operation: LifecyclePlanOperation,
  reason: LifecycleReason,
): { readonly outcome: LifecycleOperationOutcome; readonly stop: boolean; readonly reason: LifecycleReason } {
  return {
    stop: true,
    reason,
    outcome: {
      ...operation,
      result: 'failed',
      resourceState: 'unknown',
      activationState: 'unknown',
      changed: false,
      reason,
    },
  };
}

function notAttempted(operation: LifecyclePlanOperation, stopped: LifecycleReason): LifecycleOperationOutcome {
  return {
    ...operation,
    result: 'not-attempted',
    resourceState: 'unknown',
    activationState: 'unknown',
    changed: false,
    reason: createLifecycleReason('internal', 'internal.invariant', `stopped after ${stopped.code}`),
  };
}

function refused(reason: LifecycleReason): { readonly kind: 'refused'; readonly reason: LifecycleReason } {
  return { kind: 'refused', reason };
}

function thrownReason(error: unknown): LifecycleReason {
  if (error instanceof LifecycleHostPhaseError) return error.reason;
  return createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error));
}

function refusalReport(plan: FrozenPlan, reason: LifecycleReason): ExecuteLifecycleResult {
  const [first, ...rest] = plan.operations;
  if (first === undefined) {
    return finish(parseLifecycleReport({
      schemaVersion: 1,
      command: plan.report.command,
      plan: plan.report.plan,
      outcomes: [],
      summary: {
        result: 'incomplete',
        terminalPhase: 'apply',
        mutationStarted: false,
        changed: false,
        failureCategory: reason.category,
        reason,
        recoveryId: null,
        readbackId: null,
      },
    }));
  }
  const outcomes = [stop(first.operation, reason).outcome, ...rest.map((row) => notAttempted(row.operation, reason))];
  return finish(parseLifecycleReport({
    schemaVersion: 1,
    command: plan.report.command,
    plan: plan.report.plan,
    outcomes,
    summary: summaryFor(outcomes),
  }));
}

function summaryFor(outcomes: readonly LifecycleOperationOutcome[]): LifecycleReport['summary'] {
  const failed = outcomes.find((outcome) => outcome.result !== 'succeeded');
  const changed = outcomes.some((outcome) => outcome.changed);
  const pending = outcomes.find((outcome) => outcome.result === 'pending');
  const readback = outcomes.find((outcome) => outcome.reason?.category === 'readback');
  const mutationStarted = changed || pending !== undefined;
  if (failed === undefined) {
    return {
      result: 'converged',
      terminalPhase: 'complete',
      mutationStarted,
      changed,
      failureCategory: null,
      reason: null,
      recoveryId: null,
      readbackId: null,
    };
  }
  return {
    result: 'incomplete',
    terminalPhase: readback !== undefined ? 'readback' : pending === undefined ? 'apply' : 'finalize',
    mutationStarted,
    changed,
    failureCategory: failed.reason?.category ?? 'internal',
    reason: null,
    recoveryId: pending?.operationId ?? null,
    readbackId: readback?.operationId ?? null,
  };
}

function resolveRecordedPinExecutables(
  packageRoot: string,
  servers: readonly string[],
): { kind: 'ready'; pins: { server: string; executable: string }[]; dropped: string[] } | { kind: 'refused'; reason: LifecycleReason } {
  const pins: { server: string; executable: string }[] = [];
  const dropped: string[] = [];
  for (const server of servers) {
    const command = recordedPinCommand(packageRoot, server);
    if (command === null) {
      dropped.push(server);
      continue;
    }
    const executable = absolutePinExecutable(command);
    if (executable === null) {
      return {
        kind: 'refused',
        reason: createLifecycleReason('runtime', 'runtime.operation-failed', `pin server '${server}' command '${command}' does not resolve`),
      };
    }
    pins.push({ server, executable });
  }
  pins.sort((left, right) => left.server < right.server ? -1 : left.server > right.server ? 1 : left.executable < right.executable ? -1 : left.executable > right.executable ? 1 : 0);
  dropped.sort();
  return { kind: 'ready', pins, dropped };
}

function recordedPinCommand(packageRoot: string, server: string): string | null {
  for (const name of ['.mcp.json', 'mcp.json']) {
    const file = join(packageRoot, name);
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const definitions = (parsed as Record<string, unknown>)['mcpServers'];
    if (typeof definitions !== 'object' || definitions === null || Array.isArray(definitions)) continue;
    const definition = (definitions as Record<string, unknown>)[server];
    if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) continue;
    const command = (definition as Record<string, unknown>)['command'];
    if (typeof command === 'string' && command.length > 0) return command;
  }
  return null;
}

function absolutePinExecutable(command: string): string | null {
  if (command.includes('/')) {
    if (!isAbsolute(command)) return null;
    const canonical = resolve(command);
    return canonical === command ? command : null;
  }
  const found = which(command);
  if (found === null) return null;
  return resolve(found);
}
