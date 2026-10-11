import type { DeploymentScopeIdentity } from './deployment-scope';
import { unknownErrorDiagnostic } from './error-diagnostic';
import type {
  LifecycleHostAdapter,
  LifecycleTargetIdentity,
  RecordedOwnedActivation,
  TargetInstallationData,
  TargetInventoryObservation,
  TargetVersionObservation,
} from './lifecycle-host';
import {
  createLifecycleReason,
  parseLifecycleReport,
  type LifecycleCommandName,
  type LifecyclePlanAction,
  type LifecyclePlanOperation,
  type LifecycleReason,
  type LifecycleReport,
  type LifecycleRoute,
  type LifecycleSourceSnapshotContext,
} from './lifecycle-report';
import {
  createFrozenPackageSnapshot,
  createLifecyclePlanCoverage,
  createResolvedLifecyclePins,
} from './lifecycle-runtime';
import { ownedActivation } from './owned-activation';
import { CryptoHasher } from './runtime';
import {
  inventoryPackageSemantics,
  requiredSemanticsForOperation,
  SemanticInventoryError,
  type PackageSemanticInventory,
  type SourceType,
} from './semantic-inventory';
import { resolveSource, type FrozenSource, type PluginSource } from './source';
import type { SourceBinding } from './source-reference';
import {
  hasRetirementAuthority,
  readLifecycleState,
  type ActivationRecord,
  type DeploymentScopeRecord,
  type DesiredGenerationRecord,
  type DesiredPackageRecord,
  type JournalAction,
  type LifecycleStateV2,
  type LoadedLifecycleState,
} from './state';
import {
  deploymentScopeForSyncManifestEntry,
  selectManifestPackages,
  SyncManifestValidationError,
  type SelectedManifestPackage,
  type SyncManifest,
  type SyncManifestEntry,
  type SyncManifestRetireSourceEntry,
  type SyncManifestSyncEntry,
} from './sync-manifest';
import type { PersistedTargetIdentity } from './target-identity';

export type LifecyclePlan =
  | {
      readonly kind: 'zero-write-failure';
      readonly report: LifecycleReport;
    }
  | {
      readonly kind: 'frozen';
      readonly requestedDryRun: boolean;
      readonly attemptId: string;
      readonly report: LifecycleReport;
      readonly scopes: readonly {
        readonly scope: DeploymentScopeIdentity;
        readonly selectorMode: 'all' | 'explicit' | 'retired';
        readonly desired: DesiredGenerationRecord | null;
        readonly prune: 'planned' | 'blocked';
      }[];
      readonly operations: readonly {
        readonly operation: LifecyclePlanOperation;
        readonly reason: LifecycleReason | null;
        readonly journal:
          | { readonly kind: 'none' }
          | {
              readonly kind: 'required';
              readonly action: JournalAction;
              readonly mutation: boolean;
              readonly readback: boolean;
            };
      }[];
    };

export interface PlannerHost {
  readonly kinds: readonly string[];
  readonly adapter: LifecycleHostAdapter;
  readonly plannedNativeId: (plugin: PluginSource) => string;
}

export interface PlanLifecycleInput {
  readonly manifest: SyncManifest;
  readonly dryRun: boolean;
  readonly validatedAt: string;
  readonly hosts: readonly PlannerHost[];
  readonly command?: 'add' | 'update' | 'remove';
}

type FrozenOperation = Extract<LifecyclePlan, { kind: 'frozen' }>['operations'][number];
type PlannedScope = Extract<LifecyclePlan, { kind: 'frozen' }>['scopes'][number];
type Defect = { readonly kind: 'defect'; readonly reason: LifecycleReason };
type Classified = { readonly kind: 'classified'; readonly operation: FrozenOperation; readonly blocksPrune: boolean };
type Omissions = { readonly kind: 'omissions'; readonly operations: readonly FrozenOperation[] };

type PreparedSync = {
  readonly kind: 'sync';
  readonly entry: SyncManifestSyncEntry;
  readonly frozen: FrozenSource;
  readonly selected: readonly SelectedManifestPackage<PluginSource>[];
  readonly host: PlannerHost | null;
  readonly observation: TargetInventoryObservation | null;
  readonly scope: DeploymentScopeIdentity;
  readonly identity: readonly string[];
};

type PreparedRetire = {
  readonly kind: 'retire-source';
  readonly entry: SyncManifestRetireSourceEntry;
  readonly recorded: DeploymentScopeRecord;
  readonly host: PlannerHost | null;
  readonly observation: TargetInventoryObservation | null;
  readonly scope: DeploymentScopeIdentity;
  readonly identity: readonly string[];
};

type Prepared = PreparedSync | PreparedRetire;

export async function planLifecycle(input: PlanLifecycleInput): Promise<LifecyclePlan> {
  const command = input.command ?? commandName(input.manifest);
  let loaded: LoadedLifecycleState;
  try {
    loaded = readLifecycleState();
  } catch (error) {
    return zeroWrite(command, input.dryRun, createLifecycleReason(
      'internal',
      'internal.corrupt-state',
      `state could not be loaded: ${unknownErrorDiagnostic(error)}`,
    ));
  }
  const duplicate = duplicateHostKind(input.hosts);
  if (duplicate !== null) return zeroWrite(command, input.dryRun, duplicate);

  const prepared: Prepared[] = [];
  for (const entry of input.manifest.entries) {
    const result = await prepareEntry(entry, input.hosts, loaded.state);
    if (result.kind === 'defect') return zeroWrite(command, input.dryRun, result.reason);
    prepared.push(result);
  }

  const attemptId = lifecycleAttemptId(loaded.state.stateGeneration, prepared.map((item) => item.identity));
  const scopes: PlannedScope[] = [];
  const operations: FrozenOperation[] = [];
  for (const item of prepared) {
    const planned = await planPrepared(item, attemptId, input.validatedAt, loaded.state, command);
    if (planned.kind === 'defect') return zeroWrite(command, input.dryRun, planned.reason);
    scopes.push(planned.scope);
    operations.push(...planned.operations);
  }
  return frozenPlan(input, command, attemptId, scopes, operations, prepared);
}

async function prepareEntry(
  entry: SyncManifestEntry,
  hosts: readonly PlannerHost[],
  state: LifecycleStateV2,
): Promise<Prepared | Defect> {
  switch (entry.operation) {
    case 'sync':
      return prepareSync(entry, hosts, state);
    case 'retire-source':
      return prepareRetire(entry, hosts, state);
    default: {
      const unreachable: never = entry;
      throw new Error(`unknown manifest operation ${String(unreachable)}`);
    }
  }
}

async function prepareSync(
  entry: SyncManifestSyncEntry,
  hosts: readonly PlannerHost[],
  state: LifecycleStateV2,
): Promise<PreparedSync | Defect> {
  let frozen: FrozenSource;
  try {
    frozen = resolveSource(sourceArgument(entry.source));
  } catch (error) {
    return defect(createLifecycleReason('usage', 'usage.invalid-argument', unknownErrorDiagnostic(error)));
  }
  let selected: SelectedManifestPackage<PluginSource>[];
  try {
    selected = selectManifestPackages(entry, frozen.plugins);
  } catch (error) {
    if (error instanceof SyncManifestValidationError) return defect(error.reason);
    throw error;
  }
  const scope = deploymentScopeForSyncManifestEntry(entry);
  const pending = pendingDefect(state, scope.id);
  if (pending !== null) return defect(pending);
  const host = hosts.find((candidate) => candidate.kinds.includes(entry.target.kind)) ?? null;
  if (host === null) {
    return {
      kind: 'sync',
      entry,
      frozen,
      selected,
      host,
      observation: null,
      scope,
      identity: plannedAttemptIdentity(scope.id, frozen.snapshot.fingerprint, selected.map((item) => item.plugin.name)),
    };
  }
  let observation: TargetInventoryObservation;
  try {
    observation = await host.adapter.observeTarget(lifecycleTarget(entry.target));
  } catch (error) {
    return defect(createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error)));
  }
  for (const installation of observation.installations) {
    if (installation.ownership.kind === 'ambiguous') {
      return defect(createLifecycleReason(
        'internal',
        'internal.ambiguous-ownership',
        `package '${installation.nativeId}' on ${entry.target.kind}/${entry.target.instance} has ambiguous ownership`,
      ));
    }
  }
  for (const item of selected) {
    let nativeId: string;
    try {
      nativeId = host.plannedNativeId(item.plugin);
    } catch (error) {
      return defect(createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error)));
    }
    const ownedByOther = foreignOwnership(observation, nativeId, scope.id, entry.target);
    if (ownedByOther !== null) return defect(ownedByOther);
  }
  const nativeIds = selected.map((item) => host.plannedNativeId(item.plugin));
  if (new Set(nativeIds).size !== nativeIds.length) {
    return defect(createLifecycleReason('usage', 'usage.invalid-selection', `sync scope '${scope.id}' resolved duplicate native identities`));
  }
  return {
    kind: 'sync',
    entry,
    frozen,
    selected,
    host,
    observation,
    scope,
    identity: plannedAttemptIdentity(scope.id, frozen.snapshot.fingerprint, selected.map((item) => item.plugin.name)),
  };
}

async function prepareRetire(
  entry: SyncManifestRetireSourceEntry,
  hosts: readonly PlannerHost[],
  state: LifecycleStateV2,
): Promise<PreparedRetire | Defect> {
  const recorded = state.scopes.find((scope) => scope.id === entry.scopeId);
  if (recorded === undefined) {
    return defect(createLifecycleReason('usage', 'usage.invalid-selection', `unknown deployment scope '${entry.scopeId}'`));
  }
  if (recorded.target.kind !== entry.target.kind || recorded.target.instance !== entry.target.instance) {
    return defect(createLifecycleReason(
      'usage',
      'usage.invalid-selection',
      `retire-source cannot retarget scope '${entry.scopeId}'`,
    ));
  }
  const pending = pendingDefect(state, recorded.id);
  if (pending !== null) return defect(pending);
  const host = hosts.find((candidate) => candidate.kinds.includes(entry.target.kind)) ?? null;
  let observation: TargetInventoryObservation | null = null;
  if (host !== null) {
    try {
      observation = await host.adapter.observeTarget(lifecycleTarget(recorded.target));
    } catch (error) {
      return defect(createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error)));
    }
    for (const installation of observation.installations) {
      if (installation.ownership.kind === 'ambiguous') {
        return defect(createLifecycleReason(
          'internal',
          'internal.ambiguous-ownership',
          `package '${installation.nativeId}' on ${entry.target.kind}/${entry.target.instance} has ambiguous ownership`,
        ));
      }
    }
  }
  return {
    kind: 'retire-source',
    entry,
    recorded,
    host,
    observation,
    scope: { id: recorded.id, source: recorded.source, target: { kind: recorded.target.kind, instance: recorded.target.instance } },
    identity: plannedAttemptIdentity(recorded.id),
  };
}

async function planPrepared(
  item: Prepared,
  attemptId: string,
  validatedAt: string,
  state: LifecycleStateV2,
  command: LifecycleCommandName,
): Promise<{ readonly kind: 'planned'; readonly scope: PlannedScope; readonly operations: readonly FrozenOperation[] } | Defect> {
  switch (item.kind) {
    case 'sync':
      return planSync(item, attemptId, validatedAt, state, command);
    case 'retire-source':
      return planRetire(item, attemptId, state);
    default: {
      const unreachable: never = item;
      throw new Error(`unknown prepared entry ${String(unreachable)}`);
    }
  }
}

async function planSync(
  item: PreparedSync,
  attemptId: string,
  validatedAt: string,
  state: LifecycleStateV2,
  command: LifecycleCommandName,
): Promise<{ readonly kind: 'planned'; readonly scope: PlannedScope; readonly operations: readonly FrozenOperation[] } | Defect> {
  const existing = state.scopes.find((scope) => scope.id === item.scope.id);
  const packages: DesiredPackageRecord[] = [];
  const classified: Classified[] = [];
  for (const selected of item.selected) {
    let inventory: PackageSemanticInventory;
    try {
      inventory = inventoryPackageSemantics(selected.plugin);
    } catch (error) {
      if (error instanceof SemanticInventoryError) return defect(error.reason);
      return defect(createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error)));
    }
    const nativeId = item.host === null ? selected.plugin.name : item.host.plannedNativeId(selected.plugin);
    packages.push({
      packageId: selected.plugin.name,
      nativeId,
      sourceRelativeDir: selected.plugin.relativeDir && selected.plugin.relativeDir.length > 0 ? selected.plugin.relativeDir : '.',
      requiredCapabilities: [...requiredSemanticsForOperation(inventory, 'install')].sort(),
      adoptionRequested: selected.adoptionRequested,
    });
    const row = await classifyDesired(item, selected, inventory, nativeId, attemptId, state, command === 'add' || command === 'update');
    if (row.kind === 'defect') return row;
    classified.push(row);
  }
  const blocks = command === 'add' || command === 'update' || classified.some((row) => row.blocksPrune) || !canPruneOmissions(existing);
  const retirements = blocks ? { kind: 'omissions' as const, operations: [] } : await planOmissions(item, attemptId, state, packages);
  if (retirements.kind === 'defect') return retirements;
  return {
    kind: 'planned',
    scope: {
      scope: item.scope,
      selectorMode: item.entry.selectors === undefined ? 'all' : 'explicit',
      desired: desiredGeneration(existing, item.frozen.snapshot.revision, item.frozen.snapshot.fingerprint, packages, validatedAt),
      prune: blocks || retirements.operations.some((row) => row.operation.action !== 'retire-orphan') ? 'blocked' : 'planned',
    },
    operations: [...classified.map((row) => row.operation), ...retirements.operations],
  };
}

async function classifyDesired(
  item: PreparedSync,
  selected: SelectedManifestPackage<PluginSource>,
  inventory: PackageSemanticInventory,
  nativeId: string,
  attemptId: string,
  state: LifecycleStateV2,
  applyUpdates: boolean,
): Promise<Classified | Defect> {
  const operationId = operationIdentity('desired-pair', item.scope.id, selected.plugin.name, nativeId, item.frozen.snapshot.fingerprint);
  const snapshotId = sourceSnapshotId(item.frozen);
  const activation = findActivation(state, item.scope.id, selected.plugin.name, nativeId);
  if (item.host === null || item.observation === null) {
    return classified(operationId, 'desired-pair', item.scope, snapshotId, selected.plugin.name, nativeId, 'not-attempted', 'none', createLifecycleReason(
      'capability',
      'capability.unverified',
      `target '${item.entry.target.kind}' has no lifecycle adapter`,
      'lifecycle-adapter',
    ));
  }
  const installation = item.observation.installations.find((row) => row.nativeId === nativeId);
  const collision = foreignOwnership(item.observation, nativeId, item.scope.id, item.entry.target);
  if (collision !== null) return defect(collision);
  if (installation?.presence === 'present' && installation.ownership.kind === 'unmanaged') {
    return defect(createLifecycleReason(
      'internal',
      'internal.ambiguous-ownership',
      `package '${nativeId}' on ${item.entry.target.kind}/${item.entry.target.instance} is not ownership-proven`,
    ));
  }
  const replacing = installation?.presence === 'present' && installation.ownership.kind === 'owned';
  const capabilityOperation = replacing ? 'update' : 'install';
  let version: TargetVersionObservation;
  try {
    version = await item.host.adapter.probeVersion(item.observation.target);
  } catch (error) {
    return defect(createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error)));
  }
  const decision = await selectPairRoute(item, selected.plugin, inventory, nativeId, operationId, attemptId, capabilityOperation, version);
  if (decision.kind === 'defect') return decision;
  if (decision.kind === 'gap') {
    const prior = priorKind(activation);
    if (prior === 'nonconforming') {
      const disabled = await selectDisable(item, nativeId, operationId, attemptId, version, activation, installation);
      if (disabled.kind === 'defect') return disabled;
      if (disabled.kind === 'selected') {
        return classified(operationId, 'desired-pair', item.scope, snapshotId, selected.plugin.name, nativeId, 'disable-nonconforming', disabled.route, decision.reason);
      }
    }
    if (prior === 'conforming' && activation !== undefined && (activation.route.kind === 'managed' || activation.route.kind === 'native')) {
      return classified(operationId, 'desired-pair', item.scope, snapshotId, selected.plugin.name, nativeId, 'retain-prior', activation.route.kind, decision.reason);
    }
    return classified(operationId, 'desired-pair', item.scope, snapshotId, selected.plugin.name, nativeId, 'not-attempted', 'none', decision.reason);
  }
  const recordedRoute = activation?.route.kind === 'managed' || activation?.route.kind === 'native' ? activation.route.kind : null;
  const action = chosenAction(replacing, recordedRoute, decision.route, sameBytes(activation, installation, selected.plugin));
  if (action === 'route-migrate' || (action === 'update' && !applyUpdates)) {
    return classified(
      operationId,
      'desired-pair',
      item.scope,
      snapshotId,
      selected.plugin.name,
      nativeId,
      'retain-prior',
      recordedRoute ?? decision.route,
      createLifecycleReason(
        'capability',
        'capability.unsupported',
        `${action} of '${selected.plugin.name}' is not applied by this execution slice`,
        action,
      ),
    );
  }
  return classified(operationId, 'desired-pair', item.scope, snapshotId, selected.plugin.name, nativeId, action, decision.route, null);
}

async function planOmissions(
  item: PreparedSync,
  attemptId: string,
  state: LifecycleStateV2,
  desired: readonly DesiredPackageRecord[],
): Promise<Omissions | Defect> {
  const packageIds = new Set(desired.map((row) => row.packageId));
  const nativeIds = new Set(desired.map((row) => row.nativeId));
  const omissions = state.activations
    .filter((activation) => activation.scopeId === item.scope.id && !packageIds.has(activation.packageId) && !nativeIds.has(activation.nativeId))
    .sort((left, right) => left.packageId < right.packageId ? -1 : left.packageId > right.packageId ? 1 : 0);
  const operations: FrozenOperation[] = [];
  for (const activation of omissions) {
    if (!hasRetirementAuthority(activation)) continue;
    const installation = item.observation?.installations.find((row) => row.nativeId === activation.nativeId);
    if (installation?.ownership.kind === 'owned' && installation.ownership.scopeId !== item.scope.id) {
      return defect(createLifecycleReason(
        'internal',
        'internal.ambiguous-ownership',
        `package '${activation.nativeId}' on ${item.entry.target.kind}/${item.entry.target.instance} is owned by scope '${installation.ownership.scopeId}'`,
      ));
    }
    if (!hostRevalidated(installation, item.scope.id) || item.host === null || item.observation === null) {
      operations.push(notAttemptedRetirement(
        operationIdentity('retirement', item.scope.id, activation.packageId, activation.nativeId, activation.sourceRevision ?? 'unrecorded'),
        item.scope,
        activation,
        `ownership of '${activation.packageId}' was not revalidated`,
      ));
      continue;
    }
    const retired = await selectRetirement(item.host, item.observation, item.scope, activation, attemptId, null);
    if (retired.kind === 'defect') return retired;
    operations.push(retired.operation);
  }
  return { kind: 'omissions', operations };
}

async function planRetire(
  item: PreparedRetire,
  attemptId: string,
  state: LifecycleStateV2,
): Promise<{ readonly kind: 'planned'; readonly scope: PlannedScope; readonly operations: readonly FrozenOperation[] } | Defect> {
  const activations = state.activations
    .filter((activation) => activation.scopeId === item.recorded.id)
    .sort((left, right) => left.packageId < right.packageId ? -1 : left.packageId > right.packageId ? 1 : 0);
  const operations: FrozenOperation[] = [];
  for (const activation of activations) {
    const installation = item.observation?.installations.find((row) => row.nativeId === activation.nativeId);
    if (installation?.ownership.kind === 'owned' && installation.ownership.scopeId !== item.scope.id) {
      return defect(createLifecycleReason(
        'internal',
        'internal.ambiguous-ownership',
        `package '${activation.nativeId}' on ${item.entry.target.kind}/${item.entry.target.instance} is owned by scope '${installation.ownership.scopeId}'`,
      ));
    }
    if (!hasRetirementAuthority(activation) || !hostRevalidated(installation, item.scope.id) || item.host === null || item.observation === null) {
      operations.push(classified(
        operationIdentity('retirement', item.scope.id, activation.packageId, activation.nativeId, activation.sourceRevision ?? 'unrecorded'),
        'retirement',
        item.scope,
        null,
        activation.packageId,
        activation.nativeId,
        'not-attempted',
        'none',
        createLifecycleReason('internal', 'internal.invariant', `ownership of '${activation.packageId}' was not revalidated`),
      ).operation);
      continue;
    }
    const retired = await selectRetirement(item.host, item.observation, item.scope, activation, attemptId, item.recorded.source);
    if (retired.kind === 'defect') return retired;
    operations.push(retired.operation);
  }
  return {
    kind: 'planned',
    scope: {
      scope: item.scope,
      selectorMode: 'retired',
      desired: null,
      prune: operations.length > 0 && operations.every((row) => row.operation.action === 'retire-orphan') ? 'planned' : 'blocked',
    },
    operations,
  };
}

async function selectPairRoute(
  item: PreparedSync,
  plugin: PluginSource,
  inventory: PackageSemanticInventory,
  nativeId: string,
  operationId: string,
  attemptId: string,
  operation: 'install' | 'update',
  version: TargetVersionObservation,
): Promise<{ readonly kind: 'selected'; readonly route: 'native' | 'managed' } | { readonly kind: 'gap'; readonly reason: LifecycleReason } | Defect> {
  if (item.host === null || item.observation === null) {
    return { kind: 'gap', reason: createLifecycleReason('capability', 'capability.unverified', 'missing lifecycle adapter', 'lifecycle-adapter') };
  }
  if (plugin.contentFingerprint === undefined) {
    return defect(createLifecycleReason('internal', 'internal.invariant', `package '${plugin.name}' has no content fingerprint`));
  }
  try {
    const pins = createResolvedLifecyclePins([]);
    const snapshot = createFrozenPackageSnapshot({
      operationId,
      attemptId,
      scopeId: item.scope.id,
      target: item.observation.target,
      action: operation,
      packageName: plugin.name,
      nativeId,
      sourceType: sourceTypeOf(item.entry.source),
      immutableRevision: item.frozen.snapshot.revision,
      snapshotRoot: item.frozen.snapshotDir,
      packageRoot: plugin.dir,
      relativePackagePath: plugin.relativeDir && plugin.relativeDir.length > 0 ? plugin.relativeDir : '.',
      snapshotFingerprint: item.frozen.snapshot.fingerprint,
      packageFingerprint: plugin.contentFingerprint,
      inventory,
    });
    const planCoverage = createLifecyclePlanCoverage(item.observation, [{
      nativeId,
      operationId,
      operation,
      mutationGroupId: operationId,
      authorization: operation === 'update' ? 'observed-owned' : 'planned-create',
    }]);
    const nativeScope = await item.host.adapter.observeNativeMutationScope({
      targetObservation: item.observation,
      operation,
      packageName: plugin.name,
      nativeId,
      sourceType: sourceTypeOf(item.entry.source),
    });
    const nativeProjection = await item.host.adapter.observeNativeProjection({
      targetObservation: item.observation,
      operation,
      snapshot,
      pins,
    });
    const decision = item.host.adapter.decideRoute({
      target: item.observation.target,
      operation,
      operationId,
      attemptId,
      scopeId: item.scope.id,
      packageName: plugin.name,
      nativeId,
      version,
      sourceType: sourceTypeOf(item.entry.source),
      targetObservation: item.observation,
      nativeScope,
      nativeProjection,
      planCoverage,
      snapshot,
      pins,
    });
    if (decision.kind === 'capability-gap') return { kind: 'gap', reason: decision.gaps[0] };
    return { kind: 'selected', route: decision.route };
  } catch (error) {
    return defect(createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error)));
  }
}

async function selectDisable(
  item: PreparedSync,
  nativeId: string,
  operationId: string,
  attemptId: string,
  version: TargetVersionObservation,
  activation: ActivationRecord | undefined,
  installation: TargetInstallationData | undefined,
): Promise<{ readonly kind: 'selected'; readonly route: 'native' | 'managed' } | { readonly kind: 'gap' } | Defect> {
  if (item.host === null || item.observation === null || activation === undefined || installation === undefined) return { kind: 'gap' };
  const recorded = recordedActivation(item.scope, item.entry.source, activation, installation, item.observation.target);
  if (recorded === null) return { kind: 'gap' };
  const decision = await decideRecordedRoute(item.host, item.observation, recorded, operationId, attemptId, 'disable', version);
  if (decision.kind === 'defect') return decision;
  if (decision.kind === 'gap') return { kind: 'gap' };
  return decision;
}

async function selectRetirement(
  host: PlannerHost,
  observation: TargetInventoryObservation,
  scope: DeploymentScopeIdentity,
  activation: ActivationRecord,
  attemptId: string,
  source: SourceBinding | null,
): Promise<{ readonly kind: 'planned'; readonly operation: FrozenOperation } | Defect> {
  const operationId = operationIdentity('retirement', scope.id, activation.packageId, activation.nativeId, activation.sourceRevision ?? 'unrecorded');
  const installation = observation.installations.find((row) => row.nativeId === activation.nativeId);
  if (installation === undefined) {
    return { kind: 'planned', operation: notAttemptedRetirement(operationId, scope, activation, 'ownership was not revalidated') };
  }
  let version: TargetVersionObservation;
  try {
    version = await host.adapter.probeVersion(observation.target);
  } catch (error) {
    return defect(createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error)));
  }
  const recorded = recordedActivation(scope, source ?? scope.source, activation, installation, observation.target);
  if (recorded === null) {
    return { kind: 'planned', operation: notAttemptedRetirement(operationId, scope, activation, 'ownership was not revalidated') };
  }
  const decision = await decideRecordedRoute(host, observation, recorded, operationId, attemptId, 'retire', version);
  if (decision.kind === 'defect') return decision;
  if (decision.kind === 'gap') {
    const reason = decision.reason;
    return {
      kind: 'planned',
      operation: {
        operation: planOperation(operationId, 'retirement', scope, null, activation.packageId, activation.nativeId, 'not-attempted', 'none'),
        reason,
        journal: { kind: 'none' },
      },
    };
  }
  return {
    kind: 'planned',
    operation: classified(operationId, 'retirement', scope, null, activation.packageId, activation.nativeId, 'retire-orphan', decision.route, null).operation,
  };
}

async function decideRecordedRoute(
  host: PlannerHost,
  observation: TargetInventoryObservation,
  recorded: RecordedOwnedActivation,
  operationId: string,
  attemptId: string,
  operation: 'disable' | 'retire',
  version: TargetVersionObservation,
): Promise<{ readonly kind: 'selected'; readonly route: 'native' | 'managed' } | { readonly kind: 'gap'; readonly reason: LifecycleReason } | Defect> {
  try {
    const planCoverage = createLifecyclePlanCoverage(observation, [{
      nativeId: recorded.nativeId,
      operationId,
      operation,
      mutationGroupId: operationId,
      authorization: 'observed-owned',
    }]);
    const nativeScope = await host.adapter.observeNativeMutationScope({
      targetObservation: observation,
      operation,
      packageName: recorded.packageName,
      nativeId: recorded.nativeId,
      sourceType: recorded.sourceType,
    });
    const nativeProjection = await host.adapter.observeNativeProjection({
      targetObservation: observation,
      operation,
      operationId,
      attemptId,
      activation: recorded,
    });
    const decision = host.adapter.decideRoute({
      target: observation.target,
      operation,
      operationId,
      attemptId,
      scopeId: recorded.scopeId,
      packageName: recorded.packageName,
      nativeId: recorded.nativeId,
      version,
      sourceType: recorded.sourceType,
      targetObservation: observation,
      nativeScope,
      nativeProjection,
      planCoverage,
      activation: recorded,
    });
    if (decision.kind === 'capability-gap') return { kind: 'gap', reason: decision.gaps[0] };
    return { kind: 'selected', route: decision.route };
  } catch (error) {
    return defect(createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error)));
  }
}

function recordedActivation(
  scope: DeploymentScopeIdentity,
  source: SourceBinding,
  activation: ActivationRecord,
  installation: TargetInstallationData,
  target: LifecycleTargetIdentity,
): RecordedOwnedActivation | null {
  return ownedActivation(scope, source, activation, installation, target);
}

function frozenPlan(
  input: PlanLifecycleInput,
  command: LifecycleCommandName,
  attemptId: string,
  scopes: readonly PlannedScope[],
  operations: readonly FrozenOperation[],
  prepared: readonly Prepared[],
): LifecyclePlan {
  const snapshots: LifecycleSourceSnapshotContext[] = [];
  const seen = new Set<string>();
  for (const item of prepared) {
    if (item.kind !== 'sync') continue;
    const id = sourceSnapshotId(item.frozen);
    if (seen.has(id)) continue;
    seen.add(id);
    snapshots.push({ id, reference: item.frozen.snapshot });
  }
  const outcomes = operations.map((row) => outcomeFor(row));
  const failed = outcomes.filter((outcome) => outcome.result !== 'succeeded');
  const converged = failed.length === 0;
  const failureCategory = converged ? null : failed[0]?.reason?.category ?? 'internal';
  const report = parseLifecycleReport({
    schemaVersion: 1,
    command: { name: command, dryRun: input.dryRun, sourceSnapshots: snapshots },
    plan: operations.map((row) => row.operation),
    outcomes,
    summary: {
      result: converged ? 'converged' : 'incomplete',
      terminalPhase: converged ? 'complete' : 'preflight',
      mutationStarted: false,
      changed: false,
      failureCategory,
      reason: null,
      recoveryId: null,
      readbackId: null,
    },
  });
  return { kind: 'frozen', requestedDryRun: input.dryRun, attemptId, report, scopes, operations };
}

function outcomeFor(row: FrozenOperation): LifecycleReport['outcomes'][number] {
  const operation = row.operation;
  switch (operation.action) {
    case 'not-attempted':
      return { ...operation, result: 'failed', resourceState: 'unknown', activationState: 'unknown', changed: false, reason: row.reason };
    case 'retain-prior':
      return { ...operation, result: 'failed', resourceState: 'retained', activationState: 'retained-prior', changed: false, reason: row.reason };
    case 'disable-nonconforming':
      return {
        ...operation,
        result: 'failed',
        resourceState: 'retained',
        activationState: 'active-nonconforming',
        changed: false,
        reason: row.reason,
      };
    case 'retire-orphan':
      return { ...operation, result: 'succeeded', resourceState: 'absent', activationState: 'inactive', changed: false, reason: null };
    case 'install':
    case 'update':
    case 'unchanged':
    case 'route-migrate':
      return { ...operation, result: 'succeeded', resourceState: 'present', activationState: 'active-conforming', changed: false, reason: null };
    default: {
      const unreachable: never = operation.action;
      throw new Error(`unknown plan action ${String(unreachable)}`);
    }
  }
}

function classified(
  operationId: string,
  coverage: LifecyclePlanOperation['coverage'],
  scope: DeploymentScopeIdentity,
  sourceSnapshotId: string | null,
  packageName: string,
  nativeId: string | null,
  action: LifecyclePlanAction,
  route: LifecycleRoute,
  reason: LifecycleReason | null,
): Classified {
  return {
    kind: 'classified',
    blocksPrune: blocksPrune(action),
    operation: {
      operation: planOperation(operationId, coverage, scope, sourceSnapshotId, packageName, nativeId, action, route),
      reason,
      journal: journalFor(action),
    },
  };
}

function planOperation(
  operationId: string,
  coverage: LifecyclePlanOperation['coverage'],
  scope: DeploymentScopeIdentity,
  sourceSnapshotId: string | null,
  packageName: string,
  nativeId: string | null,
  action: LifecyclePlanAction,
  route: LifecycleRoute,
): LifecyclePlanOperation {
  return { operationId, coverage, scope, sourceSnapshotId, package: packageName, nativeId, action, route };
}

function notAttemptedRetirement(operationId: string, scope: DeploymentScopeIdentity, activation: ActivationRecord, diagnostic: string): FrozenOperation {
  return classified(
    operationId,
    'retirement',
    scope,
    null,
    activation.packageId,
    activation.nativeId,
    'not-attempted',
    'none',
    createLifecycleReason('internal', 'internal.invariant', diagnostic),
  ).operation;
}

function chosenAction(
  replacing: boolean,
  recordedRoute: 'native' | 'managed' | null,
  selectedRoute: 'native' | 'managed',
  bytesMatch: boolean,
): LifecyclePlanAction {
  if (!replacing) return 'install';
  if (recordedRoute !== null && recordedRoute !== selectedRoute) return 'route-migrate';
  if (bytesMatch && recordedRoute === selectedRoute) return 'unchanged';
  return 'update';
}

function sameBytes(activation: ActivationRecord | undefined, installation: TargetInstallationData | undefined, plugin: PluginSource): boolean {
  if (activation === undefined || installation?.installedFingerprint === undefined || installation.installedFingerprint === null) return false;
  return activation.fingerprints.source === plugin.contentFingerprint && activation.fingerprints.installed === installation.installedFingerprint;
}

function priorKind(activation: ActivationRecord | undefined): 'none' | 'conforming' | 'nonconforming' | 'unverified' {
  if (activation === undefined) return 'none';
  if (activation.route.kind !== 'managed' && activation.route.kind !== 'native') return 'unverified';
  if (activation.ownership.kind !== 'created' && activation.ownership.kind !== 'adopted') return 'unverified';
  if (activation.activationState === 'nonconforming') return 'nonconforming';
  if (activation.activationState === 'active' && activation.readbackState === 'verified') return 'conforming';
  return 'unverified';
}

function journalFor(action: LifecyclePlanAction): FrozenOperation['journal'] {
  switch (action) {
    case 'not-attempted':
      return { kind: 'none' };
    case 'unchanged':
    case 'retain-prior':
      return { kind: 'required', action, mutation: false, readback: false };
    case 'install':
    case 'update':
    case 'route-migrate':
    case 'disable-nonconforming':
    case 'retire-orphan':
      return { kind: 'required', action, mutation: true, readback: true };
    default: {
      const unreachable: never = action;
      throw new Error(`unknown plan action ${String(unreachable)}`);
    }
  }
}

function blocksPrune(action: LifecyclePlanAction): boolean {
  switch (action) {
    case 'not-attempted':
    case 'retain-prior':
    case 'disable-nonconforming':
      return true;
    case 'install':
    case 'update':
    case 'unchanged':
    case 'route-migrate':
    case 'retire-orphan':
      return false;
    default: {
      const unreachable: never = action;
      throw new Error(`unknown plan action ${String(unreachable)}`);
    }
  }
}

function canPruneOmissions(scope: DeploymentScopeRecord | undefined): boolean {
  return scope?.authority === 'authoritative' && scope.lastConverged !== undefined;
}

function desiredGeneration(
  existing: DeploymentScopeRecord | undefined,
  revision: string,
  sourceFingerprint: string,
  packages: readonly DesiredPackageRecord[],
  validatedAt: string,
): DesiredGenerationRecord {
  if (existing?.desired !== undefined
    && existing.desired.revision === revision
    && existing.desired.sourceFingerprint === sourceFingerprint
    && JSON.stringify(existing.desired.packages) === JSON.stringify(packages)) {
    return existing.desired;
  }
  return {
    generation: existing?.desired === undefined ? 1 : existing.desired.generation + 1,
    revision,
    sourceFingerprint,
    packages: [...packages],
    validatedAt,
  };
}

function findActivation(state: LifecycleStateV2, scopeId: string, packageName: string, nativeId: string): ActivationRecord | undefined {
  return state.activations.find((activation) => activation.scopeId === scopeId && (activation.packageId === packageName || activation.nativeId === nativeId));
}

function hostRevalidated(installation: TargetInstallationData | undefined, scopeId: string): boolean {
  return installation?.presence === 'present'
    && installation.ownership.kind === 'owned'
    && installation.ownership.scopeId === scopeId
    && (installation.ownership.proof === 'created' || installation.ownership.proof === 'adopted');
}

function foreignOwnership(
  observation: TargetInventoryObservation,
  nativeId: string,
  scopeId: string,
  target: { readonly kind: string; readonly instance: string },
): LifecycleReason | null {
  const installation = observation.installations.find((row) => row.nativeId === nativeId);
  if (installation?.ownership.kind !== 'owned' || installation.ownership.scopeId === scopeId) return null;
  return createLifecycleReason(
    'internal',
    'internal.ambiguous-ownership',
    `package '${nativeId}' on ${target.kind}/${target.instance} is owned by scope '${installation.ownership.scopeId}'`,
  );
}

function pendingDefect(state: LifecycleStateV2, scopeId: string): LifecycleReason | null {
  const activation = state.activations.find((row) => row.scopeId === scopeId && row.pending !== undefined);
  if (activation?.pending === undefined) return null;
  return createLifecycleReason(
    'internal',
    'internal.invariant',
    `package '${activation.packageId}' has pending ${activation.pending.operation} work that requires recovery before planning`,
  );
}

function duplicateHostKind(hosts: readonly PlannerHost[]): LifecycleReason | null {
  const bound = new Set<string>();
  for (const host of hosts) {
    for (const kind of host.kinds) {
      if (bound.has(kind)) {
        return createLifecycleReason('internal', 'internal.invariant', `target kind '${kind}' is bound more than once`);
      }
      bound.add(kind);
    }
  }
  return null;
}

function zeroWrite(command: LifecycleCommandName, dryRun: boolean, reason: LifecycleReason): LifecyclePlan {
  const usage = reason.category === 'usage';
  return {
    kind: 'zero-write-failure',
    report: parseLifecycleReport({
      schemaVersion: 1,
      command: { name: command, dryRun, sourceSnapshots: [] },
      plan: [],
      outcomes: [],
      summary: {
        result: usage ? 'usage-error' : 'incomplete',
        terminalPhase: usage ? 'parse' : 'preflight',
        mutationStarted: false,
        changed: false,
        failureCategory: reason.category,
        reason,
        recoveryId: null,
        readbackId: null,
      },
    }),
  };
}

function commandName(manifest: SyncManifest): LifecycleCommandName {
  return manifest.entries.every((entry) => entry.operation === 'retire-source') ? 'retire-source' : 'sync';
}

function sourceArgument(source: SourceBinding): string {
  if (source.kind === 'local') return source.locator;
  return source.ref === 'HEAD' ? source.locator : `${source.locator}#${source.ref}`;
}

function sourceTypeOf(source: SourceBinding): SourceType {
  switch (source.kind) {
    case 'local':
    case 'git':
      return source.kind;
    default: {
      const unreachable: never = source;
      throw new Error(`unknown source ${String(unreachable)}`);
    }
  }
}

function lifecycleTarget(target: PersistedTargetIdentity): LifecycleTargetIdentity {
  if (target.context === undefined) return { kind: target.kind, instance: target.instance };
  return { kind: target.kind, instance: target.instance, context: target.context };
}

function sourceSnapshotId(frozen: FrozenSource): string {
  const binding = frozen.snapshot.binding;
  return `snapshot-v1-${digest([
    binding.kind,
    binding.locator,
    binding.kind === 'git' ? binding.ref : '',
    frozen.snapshot.fingerprint,
  ])}`;
}

function operationIdentity(coverage: string, scopeId: string, packageName: string, nativeId: string, fingerprint: string): string {
  return `operation-v1-${digest([coverage, scopeId, packageName, nativeId, fingerprint])}`;
}

function lifecycleAttemptId(stateGeneration: number, identities: readonly (readonly string[])[]): string {
  return `attempt-v1-${digest([String(stateGeneration), ...identities.flat()])}`;
}

export function lifecycleAttemptIdForPlannedScopes(
  stateGeneration: number,
  scopes: readonly PlannedAttemptScope[],
): string {
  return lifecycleAttemptId(stateGeneration, scopes.map((planned) => plannedAttemptIdentity(
    planned.scope.id,
    planned.desired?.sourceFingerprint,
    planned.desired?.packages.map((pkg) => pkg.packageId),
    planned.selectorMode === 'retired' || planned.desired === null,
  )));
}

type PlannedAttemptScope = {
  readonly scope: { readonly id: string };
  readonly selectorMode: 'all' | 'explicit' | 'retired';
  readonly desired: { readonly sourceFingerprint: string; readonly packages: readonly { readonly packageId: string }[] } | null;
};

function plannedAttemptIdentity(
  scopeId: string,
  sourceFingerprint?: string,
  packageIds?: readonly string[],
  retired = false,
): readonly string[] {
  if (retired || sourceFingerprint === undefined || packageIds === undefined) return ['retire-source', scopeId];
  return ['sync', scopeId, sourceFingerprint, ...packageIds];
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

function defect(reason: LifecycleReason): Defect {
  return { kind: 'defect', reason };
}
