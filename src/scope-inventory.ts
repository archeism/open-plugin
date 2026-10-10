import type { SourceBinding } from './source-reference';
import type {
  ActivationRecord,
  DeploymentScopeRecord,
  LifecycleAttemptRecord,
  LifecycleStateV2,
  TombstoneRecord,
} from './state';

export interface ScopeInventoryQuery {
  readonly scopeId?: string;
  readonly source?: SourceBinding;
  readonly targetKinds: readonly string[];
  readonly instance?: string;
}

export interface ScopeInventoryRow {
  readonly id: string;
  readonly source: DeploymentScopeRecord['source'];
  readonly target: DeploymentScopeRecord['target'];
  readonly authority: DeploymentScopeRecord['authority'];
  readonly lifecycle: DeploymentScopeRecord['lifecycle'];
  readonly selectorMode: DeploymentScopeRecord['selectorMode'];
  readonly desired: DeploymentScopeRecord['desired'] | null;
  readonly lastConverged: DeploymentScopeRecord['lastConverged'] | null;
  readonly lastAttemptId: string | null;
  readonly activations: readonly ActivationRecord[];
  readonly tombstones: readonly TombstoneRecord[];
  readonly attempt: LifecycleAttemptRecord | null;
}

export interface ScopeInventory {
  readonly stateGeneration: number;
  readonly scopes: readonly ScopeInventoryRow[];
}

const SCOPE_ID = /^scope-v1-[0-9a-f]{64}$/u;

export function projectScopeInventory(state: LifecycleStateV2, query: ScopeInventoryQuery): ScopeInventory {
  const scopes = state.scopes.filter((scope) => matchesQuery(scope, query));
  return {
    stateGeneration: state.stateGeneration,
    scopes: scopes.map((scope) => ({
      id: scope.id,
      source: scope.source,
      target: scope.target,
      authority: scope.authority,
      lifecycle: scope.lifecycle,
      selectorMode: scope.selectorMode,
      desired: scope.desired ?? null,
      lastConverged: scope.lastConverged ?? null,
      lastAttemptId: scope.lastAttemptId ?? null,
      activations: state.activations.filter((activation) => activation.scopeId === scope.id),
      tombstones: state.tombstones.filter((tombstone) => tombstone.scopeId === scope.id),
      attempt: state.attempts.find((attempt) => attempt.id === scope.lastAttemptId) ?? null,
    })),
  };
}

export function renderScopeInventory(inventory: ScopeInventory): string {
  const rows = inventory.scopes.map((scope) =>
    [scope.id, `${scope.target.kind}/${scope.target.instance}`, scope.lifecycle, `activations=${scope.activations.length}`].join('\t'),
  );
  return [`stateGeneration\t${inventory.stateGeneration}`, ...rows].join('\n');
}

function matchesQuery(scope: DeploymentScopeRecord, query: ScopeInventoryQuery): boolean {
  if (query.targetKinds.length > 0 && !query.targetKinds.includes(scope.target.kind)) return false;
  if (query.instance !== undefined && scope.target.instance !== query.instance) return false;
  if (query.scopeId !== undefined && scope.id !== query.scopeId) return false;
  if (query.source !== undefined && !sameSourceBinding(scope.source, query.source)) return false;
  return true;
}

export function isScopeId(value: string): boolean {
  return SCOPE_ID.test(value);
}

export function sameSourceBinding(left: SourceBinding, right: SourceBinding): boolean {
  switch (left.kind) {
    case 'local':
      return right.kind === 'local' && left.locator === right.locator;
    case 'git':
      return right.kind === 'git' && left.locator === right.locator && left.ref === right.ref;
    default: {
      const unreachable: never = left;
      throw new Error(`unknown source ${String(unreachable)}`);
    }
  }
}
