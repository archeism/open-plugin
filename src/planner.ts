import type { DeploymentScopeIdentity } from './deployment-scope';
import { unknownErrorDiagnostic } from './error-diagnostic';
import type { LifecycleHostAdapter, LifecycleTargetIdentity } from './lifecycle-host';
import {
  createLifecycleReason,
  parseLifecycleReport,
  type LifecycleCommandName,
  type LifecyclePlanOperation,
  type LifecycleReason,
  type LifecycleReport,
} from './lifecycle-report';
import { resolveSource, type PluginSource } from './source';
import type { SourceBinding } from './source-reference';
import { readLifecycleState, type DesiredGenerationRecord, type JournalAction } from './state';
import {
  deploymentScopeForSyncManifestEntry,
  selectManifestPackages,
  SyncManifestValidationError,
  type SyncManifest,
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
}

export async function planLifecycle(input: PlanLifecycleInput): Promise<LifecyclePlan> {
  const command = commandName(input.manifest);
  try {
    readLifecycleState();
  } catch (error) {
    return zeroWrite(command, input.dryRun, createLifecycleReason(
      'internal',
      'internal.corrupt-state',
      `state could not be loaded: ${unknownErrorDiagnostic(error)}`,
    ));
  }
  const bound = new Set<string>();
  for (const host of input.hosts) {
    for (const kind of host.kinds) {
      if (bound.has(kind)) {
        return zeroWrite(command, input.dryRun, createLifecycleReason(
          'internal',
          'internal.invariant',
          `target kind '${kind}' is bound more than once`,
        ));
      }
      bound.add(kind);
    }
  }
  for (const entry of input.manifest.entries) {
    switch (entry.operation) {
      case 'sync': {
        const reason = await preflightSync(entry, input.hosts);
        if (reason !== null) return zeroWrite(command, input.dryRun, reason);
        break;
      }
      case 'retire-source':
        throw new Error('retire-source planning is not implemented');
      default: {
        const unreachable: never = entry;
        throw new Error(`unknown manifest operation ${String(unreachable)}`);
      }
    }
  }
  throw new Error('frozen planning is not implemented');
}

async function preflightSync(entry: SyncManifestSyncEntry, hosts: readonly PlannerHost[]): Promise<LifecycleReason | null> {
  let plugins: PluginSource[];
  try {
    plugins = resolveSource(sourceArgument(entry.source)).plugins;
  } catch (error) {
    return createLifecycleReason('usage', 'usage.invalid-argument', unknownErrorDiagnostic(error));
  }
  let selected: ReturnType<typeof selectManifestPackages<PluginSource>>;
  try {
    selected = selectManifestPackages(entry, plugins);
  } catch (error) {
    if (error instanceof SyncManifestValidationError) return error.reason;
    throw error;
  }
  const host = hosts.find((candidate) => candidate.kinds.includes(entry.target.kind));
  if (host === undefined) return null;
  const scope = deploymentScopeForSyncManifestEntry(entry);
  let observation: Awaited<ReturnType<LifecycleHostAdapter['observeTarget']>>;
  try {
    observation = await host.adapter.observeTarget(lifecycleTarget(entry.target));
  } catch (error) {
    return createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error));
  }
  for (const installation of observation.installations) {
    if (installation.ownership.kind === 'ambiguous') {
      return createLifecycleReason(
        'internal',
        'internal.ambiguous-ownership',
        `package '${installation.nativeId}' on ${entry.target.kind}/${entry.target.instance} has ambiguous ownership`,
      );
    }
  }
  for (const item of selected) {
    let nativeId: string;
    try {
      nativeId = host.plannedNativeId(item.plugin);
    } catch (error) {
      return createLifecycleReason('internal', 'internal.defect', unknownErrorDiagnostic(error));
    }
    const installation = observation.installations.find((row) => row.nativeId === nativeId);
    if (installation === undefined || installation.ownership.kind !== 'owned') continue;
    if (installation.ownership.scopeId !== scope.id) {
      return createLifecycleReason(
        'internal',
        'internal.ambiguous-ownership',
        `package '${nativeId}' on ${entry.target.kind}/${entry.target.instance} is owned by scope '${installation.ownership.scopeId}'`,
      );
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

function lifecycleTarget(target: PersistedTargetIdentity): LifecycleTargetIdentity {
  if (target.context === undefined) return { kind: target.kind, instance: target.instance };
  return { kind: target.kind, instance: target.instance, context: target.context };
}
