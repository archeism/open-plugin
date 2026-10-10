import { unknownErrorDiagnostic } from './error-diagnostic';
import type { FrozenPackageSnapshot, LifecycleTargetIdentity, SelectedLifecycleRoute, SelectedRouteDecision } from './lifecycle-host';
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
import type { LifecyclePlan, PlannerHost } from './planner';
import { inventoryPackageSemantics, type PackageSemanticInventory } from './semantic-inventory';
import { CryptoHasher } from './runtime';
import { resolveSource, type FrozenSource, type PluginSource } from './source';
import type { SourceBinding } from './source-reference';
import { readLifecycleState, type ActivationRecord, type DeploymentScopeRecord, type JournalEntryRecord, type JournalState, type LifecycleAttemptRecord, type LifecycleStateV2 } from './state';
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
      return runInstall(plan, operation, hosts, ledger);
    case 'update':
    case 'unchanged':
    case 'route-migrate':
    case 'disable-nonconforming':
    case 'retain-prior':
    case 'retire-orphan':
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

async function runInstall(
  plan: FrozenPlan,
  operation: LifecyclePlanOperation,
  hosts: readonly PlannerHost[],
  ledger: Ledger,
): Promise<OperationStep> {
  if (ledger.journalState(plan.attemptId, operation.operationId) === 'completed') return succeeded(operation, false);
  const nativeId = operation.nativeId;
  if (nativeId === null) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `install '${operation.operationId}' has no native identity`));
  }
  const host = hosts.find((candidate) => candidate.kinds.includes(operation.scope.target.kind));
  if (host === undefined) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `install '${operation.package}' has no host adapter`));
  }
  let prepared: Awaited<ReturnType<typeof prepareInstall>>;
  try {
    prepared = await prepareInstall(plan, operation, host, nativeId);
  } catch (error) {
    return stop(operation, thrownReason(error));
  }
  if (prepared.kind === 'refused') return stop(operation, prepared.reason);
  try {
    ledger.acceptInstall(plan, operation);
  } catch (error) {
    return stop(operation, thrownReason(error));
  }
  let receipt: Awaited<ReturnType<PlannerHost['adapter']['apply']>> | undefined;
  let verified: ReturnType<PlannerHost['adapter']['verify']> | undefined;
  try {
    const staged = await host.adapter.stageActivation({
      selection: prepared.selection,
      snapshot: prepared.snapshot,
      pins: prepared.pins,
    });
    const directed = await host.adapter.applyLifecycleDirectives(staged);
    const pinned = await host.adapter.applyPins(directed);
    const sealed = await host.adapter.sealActivation(pinned);
    ledger.markApplying(plan, operation);
    receipt = await host.adapter.apply(sealed);
    const observation = await host.adapter.readback(receipt.handle);
    verified = host.adapter.verify(receipt.handle, observation);
    const projected = verified.handle.projectedFingerprint;
    const installed = verified.observation.installedFingerprint;
    if (projected === null || installed === null) {
      return stop(operation, createLifecycleReason('internal', 'internal.invariant', `install '${operation.operationId}' readback has no fingerprint`));
    }
    ledger.confirmActivation(plan, operation, {
      scopeId: operation.scope.id,
      packageId: operation.package,
      nativeId,
      sourceRelativeDir: sourceRelativeDir(plan, operation),
      sourceRevision: verified.handle.sourceRevision,
      route: { kind: verified.handle.route, evidenceKey: { kind: 'capability-profile', key: verified.handle.evidenceId } },
      ownership: {
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
      pins: [],
      activatedAt: ledger.timestamp(),
      readbackAt: ledger.timestamp(),
      createdAt: ledger.timestamp(),
      updatedAt: ledger.timestamp(),
    });
  } catch (error) {
    return stop(operation, thrownReason(error));
  }
  if (receipt === undefined || verified === undefined) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `install '${operation.operationId}' produced no verified activation`));
  }
  try {
    await host.adapter.cleanup(verified.handle, 'verified-commit');
  } catch {
    ledger.markCleanupPending(plan, operation);
    return pendingCleanup(operation);
  }
  ledger.markCompleted(plan, operation);
  return succeeded(operation, receipt.changed);
}

async function prepareInstall(
  plan: FrozenPlan,
  operation: LifecyclePlanOperation,
  host: PlannerHost,
  nativeId: string,
): Promise<
  | {
      readonly kind: 'ready';
      readonly selection: SelectedRouteDecision<SelectedLifecycleRoute, 'install'>;
      readonly snapshot: FrozenPackageSnapshot & { readonly action: 'install' };
      readonly pins: ReturnType<typeof createResolvedLifecyclePins>;
    }
  | { readonly kind: 'refused'; readonly reason: LifecycleReason }
> {
  const context = plan.report.command.sourceSnapshots.find((snapshot) => snapshot.id === operation.sourceSnapshotId);
  if (context === undefined) {
    return refused(createLifecycleReason('internal', 'internal.invariant', `install '${operation.package}' has no frozen source snapshot`));
  }
  const frozen = resolveSource(sourceArgument(operation.scope.source));
  if (frozen.snapshot.fingerprint !== context.reference.fingerprint || frozen.snapshot.revision !== context.reference.revision) {
    return refused(createLifecycleReason('internal', 'internal.invariant', `install '${operation.package}' source bytes drifted from the frozen snapshot`));
  }
  const plugin = frozen.plugins.find((candidate) => candidate.name === operation.package);
  const packageFingerprint = plugin?.contentFingerprint;
  if (plugin === undefined || packageFingerprint === undefined) {
    return refused(createLifecycleReason('internal', 'internal.invariant', `install '${operation.package}' is missing from the frozen source`));
  }
  const target = lifecycleTarget(operation);
  const observation = await host.adapter.observeTarget(target);
  const version = await host.adapter.probeVersion(observation.target);
  if (version.kind !== 'detected') {
    return refused(createLifecycleReason('runtime', 'runtime.operation-failed', `install '${operation.package}' lost its detected target version`));
  }
  const inventory = inventoryPackageSemantics(plugin);
  const pins = createResolvedLifecyclePins([]);
  const snapshot = sealInstallSnapshot(operation, plan.attemptId, nativeId, frozen, plugin, packageFingerprint, inventory, observation.target);
  if (!isInstallSnapshot(snapshot)) throw new Error(`frozen snapshot action '${snapshot.action}' is not install`);
  const planCoverage = createLifecyclePlanCoverage(observation, [{
    nativeId,
    operationId: operation.operationId,
    operation: 'install',
    mutationGroupId: operation.operationId,
    authorization: 'planned-create',
  }]);
  const sourceType = operation.scope.source.kind;
  const nativeScope = await host.adapter.observeNativeMutationScope({
    targetObservation: observation,
    operation: 'install',
    packageName: plugin.name,
    nativeId,
    sourceType,
  });
  const nativeProjection = await host.adapter.observeNativeProjection({
    targetObservation: observation,
    operation: 'install',
    snapshot,
    pins,
  });
  const decision = host.adapter.decideRoute({
    target: observation.target,
    operation: 'install',
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
  if (decision.kind !== 'selected' || decision.operation !== 'install' || decision.route !== operation.route) {
    return refused(createLifecycleReason(
      'runtime',
      'runtime.operation-failed',
      `install '${operation.package}' kept frozen route '${operation.route}'`,
    ));
  }
  return { kind: 'ready', selection: decision, snapshot, pins };
}

function sealInstallSnapshot(
  operation: LifecyclePlanOperation,
  attemptId: string,
  nativeId: string,
  frozen: FrozenSource,
  plugin: PluginSource,
  packageFingerprint: string,
  inventory: PackageSemanticInventory,
  target: LifecycleTargetIdentity,
) {
  const relativePackagePath = plugin.relativeDir !== undefined && plugin.relativeDir.length > 0 ? plugin.relativeDir : '.';
  return createFrozenPackageSnapshot({
    operationId: operation.operationId,
    attemptId,
    scopeId: operation.scope.id,
    target,
    action: 'install',
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
}

function isInstallSnapshot(snapshot: FrozenPackageSnapshot): snapshot is FrozenPackageSnapshot & { readonly action: 'install' } {
  return snapshot.action === 'install';
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
    if (this.state.attempts.some((attempt) => attempt.id === plan.attemptId)) return null;
    if (attemptIdForGeneration(plan, this.baselineGeneration) === plan.attemptId) return null;
    return createLifecycleReason(
      'internal',
      'internal.invariant',
      `plan '${plan.attemptId}' does not match state generation ${this.baselineGeneration}`,
    );
  }

  acceptInstall(plan: FrozenPlan, operation: LifecyclePlanOperation): void {
    const entry: JournalEntryRecord = {
      operationId: operation.operationId,
      scopeId: operation.scope.id,
      packageId: operation.package,
      ...(operation.nativeId === null ? {} : { nativeId: operation.nativeId }),
      action: 'install',
      state: 'pending',
      startedAt: this.now,
      updatedAt: this.now,
    };
    const existing = this.state.attempts.find((attempt) => attempt.id === plan.attemptId);
    const attempt: LifecycleAttemptRecord = {
      id: plan.attemptId,
      command: plan.report.command.name,
      phase: 'accepted',
      mutationStarted: false,
      scopeIds: plan.scopes.map((scope) => scope.scope.id),
      journal: existing === undefined ? [entry] : [...existing.journal.filter((row) => row.operationId !== entry.operationId), entry],
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

  markApplying(plan: FrozenPlan, operation: LifecyclePlanOperation): void {
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'applying', 'applying', true));
  }

  confirmActivation(plan: FrozenPlan, operation: LifecyclePlanOperation, activation: ActivationRecord): void {
    this.state = {
      ...this.state,
      activations: [...this.state.activations.filter((row) => activationKey(row) !== activationKey(activation)), activation],
    };
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'readback-verified', 'readback', true));
  }

  markCleanupPending(plan: FrozenPlan, operation: LifecyclePlanOperation): void {
    this.state = {
      ...this.state,
      activations: this.state.activations.map((row) => row.packageId === operation.package && row.scopeId === operation.scope.id
        ? {
          ...row,
          pending: { operation: 'install', phase: 'cleanup', attemptId: plan.attemptId, startedAt: this.now },
          updatedAt: this.now,
        }
        : row),
    };
    this.replaceAttempt(plan, (attempt) => this.journaled(attempt, operation.operationId, 'cleanup-pending', 'finalizing', true));
  }

  markCompleted(plan: FrozenPlan, operation: LifecyclePlanOperation): void {
    this.state = {
      ...this.state,
      scopes: this.state.scopes.map((scope) => scope.id === operation.scope.id && scope.desired !== undefined
        ? { ...scope, lastConverged: scope.desired, updatedAt: this.now }
        : scope),
    };
    this.replaceAttempt(plan, (attempt) => ({
      ...this.journaled(attempt, operation.operationId, 'completed', 'completed', true),
      completedAt: this.now,
    }));
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

function succeeded(operation: LifecyclePlanOperation, changed: boolean): OperationStep {
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

function attemptIdForGeneration(plan: FrozenPlan, generation: number): string {
  return `attempt-v1-${digest([String(generation), ...plan.scopes.flatMap((planned) => scopeIdentity(planned))])}`;
}

function scopeIdentity(planned: FrozenPlan['scopes'][number]): readonly string[] {
  if (planned.desired === null || planned.selectorMode === 'retired') return ['retire-source', planned.scope.id];
  return ['sync', planned.scope.id, planned.desired.sourceFingerprint, ...planned.desired.packages.map((pkg) => pkg.packageId)];
}

function digest(parts: readonly string[]): string {
  const hash = new CryptoHasher('sha256');
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update('\0');
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function summaryFor(outcomes: readonly LifecycleOperationOutcome[]): LifecycleReport['summary'] {
  const failed = outcomes.find((outcome) => outcome.result !== 'succeeded');
  const changed = outcomes.some((outcome) => outcome.changed);
  const pending = outcomes.find((outcome) => outcome.result === 'pending');
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
    terminalPhase: pending === undefined ? 'apply' : 'finalize',
    mutationStarted,
    changed,
    failureCategory: failed.reason?.category ?? 'internal',
    reason: null,
    recoveryId: pending?.operationId ?? null,
    readbackId: null,
  };
}
