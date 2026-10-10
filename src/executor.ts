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
import { resolveSource, type FrozenSource, type PluginSource } from './source';
import type { SourceBinding } from './source-reference';
import { readLifecycleState, type DeploymentScopeRecord, type JournalEntryRecord, type LifecycleAttemptRecord, type LifecycleStateV2 } from './state';
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
  const outcomes: LifecycleOperationOutcome[] = [];
  let stopped: LifecycleReason | null = null;
  for (const row of plan.operations) {
    if (stopped !== null) {
      outcomes.push(notAttempted(row.operation, stopped));
      continue;
    }
    const result = await runOperation(plan, row.operation, hosts, ledger);
    outcomes.push(result.outcome);
    if (result.stop) stopped = result.reason;
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
): Promise<{ readonly outcome: LifecycleOperationOutcome; readonly stop: boolean; readonly reason: LifecycleReason }> {
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
): Promise<{ readonly outcome: LifecycleOperationOutcome; readonly stop: boolean; readonly reason: LifecycleReason }> {
  const nativeId = operation.nativeId;
  if (nativeId === null) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `install '${operation.operationId}' has no native identity`));
  }
  const host = hosts.find((candidate) => candidate.kinds.includes(operation.scope.target.kind));
  if (host === undefined) {
    return stop(operation, createLifecycleReason('internal', 'internal.invariant', `install '${operation.package}' has no host adapter`));
  }
  const prepared = await prepareInstall(plan, operation, host, nativeId);
  if (prepared.kind === 'refused') return stop(operation, prepared.reason);
  ledger.acceptInstall(plan, operation);
  try {
    await host.adapter.stageActivation({
      selection: prepared.selection,
      snapshot: prepared.snapshot,
      pins: prepared.pins,
    });
  } catch (error) {
    const reason = error instanceof LifecycleHostPhaseError
      ? error.reason
      : createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error));
    return stop(operation, reason);
  }
  return stop(operation, createLifecycleReason(
    'internal',
    'internal.invariant',
    `install '${operation.operationId}' was staged and not activated`,
  ));
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

  constructor(private readonly now: string) {
    this.state = readLifecycleState().state;
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
      scopes: plan.scopes.map((planned) => this.scope(planned, plan.attemptId)),
      attempts: existing === undefined
        ? [...this.state.attempts, attempt]
        : this.state.attempts.map((row) => row.id === attempt.id ? attempt : row),
    };
    this.save();
  }

  private scope(planned: FrozenPlan['scopes'][number], attemptId: string): DeploymentScopeRecord {
    if (planned.desired === null || planned.selectorMode === 'retired') {
      throw new Error(`scope '${planned.scope.id}' is not an active desired scope`);
    }
    const selectorMode = planned.selectorMode;
    return {
      id: planned.scope.id,
      source: planned.scope.source,
      target: { kind: planned.scope.target.kind, instance: planned.scope.target.instance },
      authority: 'authoritative',
      lifecycle: 'active',
      selectorMode,
      desired: planned.desired,
      lastAttemptId: attemptId,
      createdAt: this.now,
      updatedAt: this.now,
    };
  }

  private save(): void {
    const previous = readLifecycleState();
    const stateGeneration = previous.sourceVersion === 2 ? previous.state.stateGeneration + 1 : 1;
    const next = { ...this.state, stateGeneration };
    writeLifecycleState(next, { globalPreflight: 'succeeded' });
    this.state = next;
  }
}

function finish(report: LifecycleReport): ExecuteLifecycleResult {
  return { report, exitCode: exitCodeForLifecycleReport(report) };
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

function summaryFor(outcomes: readonly LifecycleOperationOutcome[]): LifecycleReport['summary'] {
  const failed = outcomes.find((outcome) => outcome.result !== 'succeeded');
  const changed = outcomes.some((outcome) => outcome.changed);
  if (failed === undefined) {
    return {
      result: 'converged',
      terminalPhase: 'complete',
      mutationStarted: false,
      changed,
      failureCategory: null,
      reason: null,
      recoveryId: null,
      readbackId: null,
    };
  }
  return {
    result: 'incomplete',
    terminalPhase: 'apply',
    mutationStarted: false,
    changed,
    failureCategory: failed.reason?.category ?? 'internal',
    reason: null,
    recoveryId: null,
    readbackId: null,
  };
}
