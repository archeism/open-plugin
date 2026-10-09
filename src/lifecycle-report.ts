import type { SourceSnapshotReference } from './source-reference';
import {
  createDeploymentScopeIdentity,
  validateSourceBinding,
  type DeploymentScopeIdentity,
} from './deployment-scope';
import { unknownErrorDiagnostic } from './error-diagnostic';

export const LIFECYCLE_REPORT_SCHEMA_VERSION = 1 as const;

export const LIFECYCLE_PLAN_ACTIONS = [
  'install',
  'update',
  'unchanged',
  'route-migrate',
  'disable-nonconforming',
  'retain-prior',
  'retire-orphan',
] as const;

export const LIFECYCLE_OPERATION_RESULTS = ['succeeded', 'failed', 'pending', 'not-attempted'] as const;
export const LIFECYCLE_RESOURCE_STATES = ['present', 'absent', 'retained', 'unknown', 'potentially-changed'] as const;
export const LIFECYCLE_ACTIVATION_STATES = ['active-conforming', 'active-nonconforming', 'inactive', 'retained-prior', 'unknown'] as const;
export const LIFECYCLE_ROUTES = ['native', 'managed', 'none'] as const;
export const LIFECYCLE_COVERAGE_KINDS = ['desired-pair', 'retirement'] as const;
export const LIFECYCLE_COMMANDS = ['add', 'update', 'remove', 'sync', 'retire-source'] as const;
export const LIFECYCLE_COMMAND_RESULTS = ['converged', 'incomplete', 'usage-error'] as const;
export const LIFECYCLE_TERMINAL_PHASES = ['parse', 'resolve', 'freeze', 'preflight', 'apply', 'readback', 'prune', 'finalize', 'complete'] as const;
export const LIFECYCLE_REASON_CATEGORIES = ['capability', 'internal', 'protocol', 'runtime', 'readback', 'recovery', 'usage'] as const;
export const LIFECYCLE_REASON_CODES = [
  'capability.unsupported',
  'capability.unverified',
  'internal.defect',
  'internal.invariant',
  'internal.corrupt-state',
  'internal.ambiguous-ownership',
  'protocol.invalid-report',
  'protocol.missing-outcome',
  'protocol.duplicate-outcome',
  'protocol.unexpected-outcome',
  'protocol.contradictory-outcome',
  'runtime.operation-failed',
  'readback.failed',
  'readback.mismatch',
  'recovery.required',
  'recovery.failed',
  'usage.invalid-argument',
  'usage.invalid-selection',
] as const;
export const LIFECYCLE_EXIT_CODES = { success: 0, incomplete: 1, usage: 2 } as const;

export type LifecyclePlanAction = (typeof LIFECYCLE_PLAN_ACTIONS)[number];
export type LifecycleOperationResult = (typeof LIFECYCLE_OPERATION_RESULTS)[number];
export type LifecycleResourceState = (typeof LIFECYCLE_RESOURCE_STATES)[number];
export type LifecycleActivationState = (typeof LIFECYCLE_ACTIVATION_STATES)[number];
export type LifecycleRoute = (typeof LIFECYCLE_ROUTES)[number];
export type LifecycleCoverageKind = (typeof LIFECYCLE_COVERAGE_KINDS)[number];
export type LifecycleCommandName = (typeof LIFECYCLE_COMMANDS)[number];
export type LifecycleCommandResult = (typeof LIFECYCLE_COMMAND_RESULTS)[number];
export type LifecycleTerminalPhase = (typeof LIFECYCLE_TERMINAL_PHASES)[number];
export type LifecycleExitCode = (typeof LIFECYCLE_EXIT_CODES)[keyof typeof LIFECYCLE_EXIT_CODES];

export type LifecycleReasonCategory = (typeof LIFECYCLE_REASON_CATEGORIES)[number];
export type LifecycleReasonCode = (typeof LIFECYCLE_REASON_CODES)[number];

export type LifecycleReason = {
  [Category in LifecycleReasonCategory]: {
    category: Category;
    code: Extract<LifecycleReasonCode, `${Category}.${string}`>;
    diagnostic: string;
  } & (Category extends 'capability'
    ? { capabilityId: string; evidenceId: string | null }
    : { capabilityId: null; evidenceId: null });
}[LifecycleReasonCategory];

type NonCapabilityReasonCategory = Exclude<LifecycleReasonCategory, 'capability'>;

/** Construct a reason only when its stable code and capability fields match its category. */
export function createLifecycleReason(
  category: 'capability',
  code: Extract<LifecycleReasonCode, `capability.${string}`>,
  diagnostic: string,
  capabilityId: string,
  evidenceId?: string | null,
): Extract<LifecycleReason, { category: 'capability' }>;
export function createLifecycleReason<Category extends NonCapabilityReasonCategory>(
  category: Category,
  code: Extract<LifecycleReasonCode, `${NoInfer<Category>}.${string}`>,
  diagnostic: string,
): Extract<LifecycleReason, { category: Category }>;
export function createLifecycleReason(
  category: LifecycleReasonCategory,
  code: LifecycleReasonCode,
  diagnostic: string,
  capabilityId?: string,
  evidenceId: string | null = null,
): LifecycleReason {
  if (!code.startsWith(`${category}.`)) throw new Error(`reason code '${code}' does not belong to category '${category}'`);
  if (diagnostic.trim().length === 0) throw new Error('reason diagnostic must contain non-whitespace text');
  if (category === 'capability') {
    if (capabilityId === undefined || capabilityId.length === 0) throw new Error('capability reason needs a capabilityId');
    return {
      category,
      code: code as Extract<LifecycleReasonCode, `capability.${string}`>,
      diagnostic,
      capabilityId,
      evidenceId,
    };
  }
  return { category, code, diagnostic, capabilityId: null, evidenceId: null } as LifecycleReason;
}

export interface LifecycleSourceSnapshotContext {
  id: string;
  reference: SourceSnapshotReference;
}

export interface LifecyclePlanOperation {
  operationId: string;
  coverage: LifecycleCoverageKind;
  scope: DeploymentScopeIdentity;
  sourceSnapshotId: string | null;
  package: string;
  nativeId: string | null;
  action: LifecyclePlanAction;
  route: LifecycleRoute;
}

export interface LifecycleOperationOutcome extends LifecyclePlanOperation {
  result: LifecycleOperationResult;
  resourceState: LifecycleResourceState;
  activationState: LifecycleActivationState;
  changed: boolean;
  reason: LifecycleReason | null;
}

export interface LifecycleReportSummary {
  result: LifecycleCommandResult;
  terminalPhase: LifecycleTerminalPhase;
  mutationStarted: boolean;
  changed: boolean;
  failureCategory: LifecycleReasonCategory | null;
  reason: LifecycleReason | null;
  recoveryId: string | null;
  readbackId: string | null;
}

export interface LifecycleReport {
  schemaVersion: typeof LIFECYCLE_REPORT_SCHEMA_VERSION;
  command: {
    name: LifecycleCommandName;
    dryRun: boolean;
    sourceSnapshots: LifecycleSourceSnapshotContext[];
  };
  plan: LifecyclePlanOperation[];
  outcomes: LifecycleOperationOutcome[];
  summary: LifecycleReportSummary;
}

export class LifecycleReportValidationError extends Error {
  constructor(readonly reason: LifecycleReason) {
    super(reason.diagnostic);
    this.name = 'LifecycleReportValidationError';
  }
}

export function exitCodeForLifecycleReport(report: LifecycleReport): LifecycleExitCode {
  if (report.summary.result === 'converged') return LIFECYCLE_EXIT_CODES.success;
  if (report.summary.result === 'usage-error') return LIFECYCLE_EXIT_CODES.usage;
  return LIFECYCLE_EXIT_CODES.incomplete;
}

/** Parse the public lifecycle boundary. Structural and cross-row checks are intentionally centralized here. */
export function parseLifecycleReport(value: unknown): LifecycleReport {
  if (!isObject(value)) {
    throw invalid('lifecycle report must be an object');
  }
  exactFields(value, ['schemaVersion', 'command', 'plan', 'outcomes', 'summary'], 'lifecycle report');
  if (value['schemaVersion'] !== LIFECYCLE_REPORT_SCHEMA_VERSION) {
    throw invalid('lifecycle report schemaVersion must be 1');
  }
  if (!isObject(value['command']) || !Array.isArray(value['plan']) || !Array.isArray(value['outcomes']) || !isObject(value['summary'])) {
    throw invalid('lifecycle report must contain command, plan, outcomes, and summary');
  }
  const command = value['command'];
  const plan = value['plan'];
  const outcomes = value['outcomes'];
  const summary = value['summary'];
  assertCommand(command);
  const commandName = command['name'] as LifecycleCommandName;
  if (!plan.every(isObject) || !outcomes.every(isObject)) throw invalid('lifecycle plan and outcomes must contain objects');

  const planned = new Map<string, Record<string, unknown>>();
  const plannedPairs = new Set<string>();
  for (const operation of plan) {
    assertPlanOperation(operation, command['sourceSnapshots'] as LifecycleSourceSnapshotContext[], commandName);
    const operationId = operation['operationId'];
    if (typeof operationId !== 'string' || operationId.length === 0) throw invalid('every planned operation needs a nonempty operationId');
    if (planned.has(operationId)) throw invalid(`duplicate planned operation '${operationId}'`);
    const pair = JSON.stringify([(operation['scope'] as DeploymentScopeIdentity).id, operation['package']]);
    if (plannedPairs.has(pair)) throw invalid(`duplicate planned package pair for '${operation['package']}'`);
    plannedPairs.add(pair);
    planned.set(operationId, operation);
  }

  const seen = new Set<string>();
  for (const outcome of outcomes) {
    assertOutcome(outcome, command['sourceSnapshots'] as LifecycleSourceSnapshotContext[], command['dryRun'] as boolean, commandName);
    const operationId = outcome['operationId'];
    if (typeof operationId !== 'string' || operationId.length === 0) throw invalid('every outcome needs a nonempty operationId');
    if (seen.has(operationId)) throw protocol('protocol.duplicate-outcome', `duplicate outcome for planned operation '${operationId}'`);
    seen.add(operationId);
    const operation = planned.get(operationId);
    if (operation === undefined) throw protocol('protocol.unexpected-outcome', `outcome '${operationId}' is not in the frozen plan`);
    if (!sameScope(outcome['scope'] as DeploymentScopeIdentity, operation['scope'] as DeploymentScopeIdentity)) {
      throw protocol('protocol.contradictory-outcome', `outcome '${operationId}' contradicts planned scope`);
    }
    for (const field of PLAN_IDENTITY_FIELDS) {
      if (outcome[field] !== operation[field]) {
        throw protocol('protocol.contradictory-outcome', `outcome '${operationId}' contradicts planned ${field}`);
      }
    }
  }

  for (const operationId of planned.keys()) {
    if (!seen.has(operationId)) throw protocol('protocol.missing-outcome', `planned operation '${operationId}' has no outcome`);
  }

  assertSummary(summary, outcomes, command['dryRun'] as boolean);

  return value as unknown as LifecycleReport;
}

const PLAN_IDENTITY_FIELDS = [
  'coverage',
  'sourceSnapshotId',
  'package',
  'nativeId',
  'action',
  'route',
] as const;

function invalid(diagnostic: string): LifecycleReportValidationError {
  return protocol('protocol.invalid-report', diagnostic);
}

function contradiction(diagnostic: string): LifecycleReportValidationError {
  return protocol('protocol.contradictory-outcome', diagnostic);
}

function protocol(code: Extract<LifecycleReasonCode, `protocol.${string}`>, diagnostic: string): LifecycleReportValidationError {
  return new LifecycleReportValidationError({ category: 'protocol', code, diagnostic, capabilityId: null, evidenceId: null });
}

function assertCommand(command: Record<string, unknown>): void {
  exactFields(command, ['name', 'dryRun', 'sourceSnapshots'], 'lifecycle command');
  if (!oneOf(LIFECYCLE_COMMANDS, command['name']) || typeof command['dryRun'] !== 'boolean' || !Array.isArray(command['sourceSnapshots'])) {
    throw invalid('lifecycle command must contain a known name, dryRun boolean, and sourceSnapshots array');
  }
  const ids = new Set<string>();
  for (const context of command['sourceSnapshots']) {
    if (!isObject(context) || !nonempty(context['id']) || !isObject(context['reference'])) throw invalid('source snapshot context is malformed');
    exactFields(context, ['id', 'reference'], 'source snapshot context');
    if (ids.has(context['id'])) throw invalid(`duplicate source snapshot '${context['id']}'`);
    ids.add(context['id']);
    const reference = context['reference'];
    exactFields(reference, ['binding', 'revision', 'fingerprint'], `source snapshot '${context['id']}' reference`);
    if (!isObject(reference['binding']) || !nonempty(reference['revision']) || !nonempty(reference['fingerprint'])) throw invalid(`source snapshot '${context['id']}' is malformed`);
    const binding = reference['binding'];
    assertSourceBinding(binding, `source snapshot '${context['id']}'`);
  }
}

const PLAN_OPERATION_FIELDS = [
  'operationId',
  'coverage',
  'scope',
  'sourceSnapshotId',
  'package',
  'nativeId',
  'action',
  'route',
] as const;

const OUTCOME_FIELDS = [
  ...PLAN_OPERATION_FIELDS,
  'result',
  'resourceState',
  'activationState',
  'changed',
  'reason',
] as const;

function assertPlanOperation(
  operation: Record<string, unknown>,
  snapshots: readonly LifecycleSourceSnapshotContext[],
  command: LifecycleCommandName,
  shape: 'plan' | 'outcome' = 'plan',
): void {
  exactFields(operation, shape === 'plan' ? PLAN_OPERATION_FIELDS : OUTCOME_FIELDS, `lifecycle ${shape}`);
  if (!nonempty(operation['operationId']) || !oneOf(LIFECYCLE_COVERAGE_KINDS, operation['coverage']) ||
      !isObject(operation['scope']) || !nullableString(operation['sourceSnapshotId']) ||
      !nonempty(operation['package']) ||
      !nullableString(operation['nativeId']) || !oneOf(LIFECYCLE_PLAN_ACTIONS, operation['action']) || !oneOf(LIFECYCLE_ROUTES, operation['route'])) {
    throw invalid('planned operation contains a missing or invalid field');
  }
  assertScope(operation['scope']);
  if (operation['sourceSnapshotId'] !== null && !snapshots.some((snapshot) => snapshot.id === operation['sourceSnapshotId'])) {
    throw invalid(`planned operation '${operation['operationId']}' references an unknown source snapshot`);
  }
  const snapshot = snapshots.find((candidate) => candidate.id === operation['sourceSnapshotId']);
  if (snapshot !== undefined && !sameSourceBinding(snapshot.reference.binding, (operation['scope'] as unknown as DeploymentScopeIdentity).source)) {
    throw invalid(`planned operation '${operation['operationId']}' scope contradicts its source snapshot`);
  }
  if (operation['coverage'] === 'retirement' && operation['action'] !== 'retire-orphan') {
    throw invalid(`orphan retirement '${operation['operationId']}' has a non-retirement action`);
  }
  if (operation['coverage'] === 'desired-pair' && operation['action'] === 'retire-orphan') {
    throw invalid(`Desired pair '${operation['operationId']}' has a retirement action`);
  }
  if ((command === 'add' || command === 'update') && operation['coverage'] !== 'desired-pair') {
    throw invalid(`${command} cannot contain retirement coverage`);
  }
  if ((command === 'remove' || command === 'retire-source') && operation['coverage'] !== 'retirement') {
    throw invalid(`${command} cannot contain desired-pair coverage`);
  }
}

function assertOutcome(
  outcome: Record<string, unknown>,
  snapshots: readonly LifecycleSourceSnapshotContext[],
  dryRun: boolean,
  command: LifecycleCommandName,
): void {
  assertPlanOperation(outcome, snapshots, command, 'outcome');
  if (!oneOf(LIFECYCLE_OPERATION_RESULTS, outcome['result']) || !oneOf(LIFECYCLE_RESOURCE_STATES, outcome['resourceState']) ||
      !oneOf(LIFECYCLE_ACTIVATION_STATES, outcome['activationState']) || typeof outcome['changed'] !== 'boolean' ||
      !(outcome['reason'] === null || isObject(outcome['reason']))) {
    throw invalid(`outcome '${outcome['operationId']}' contains a missing or invalid field`);
  }
  const reason = outcome['reason'];
  if (reason !== null) assertReason(reason as Record<string, unknown>);
  if (reason !== null && (reason as Record<string, unknown>)['category'] === 'usage') {
    throw contradiction(`usage reason cannot belong to pair outcome '${outcome['operationId']}'`);
  }
  if (outcome['result'] === 'succeeded' && reason !== null) throw contradiction(`successful outcome '${outcome['operationId']}' cannot have a failure reason`);
  if (outcome['result'] !== 'succeeded' && reason === null) throw contradiction(`non-success outcome '${outcome['operationId']}' needs a reason`);
  const containment = outcome['action'] === 'retain-prior' || outcome['action'] === 'disable-nonconforming';
  if (containment) {
    const expectedResourceState = 'retained';
    const expectedActivationState = outcome['action'] === 'retain-prior' ? 'retained-prior' : 'inactive';
    if (outcome['result'] !== 'failed' || outcome['resourceState'] !== expectedResourceState || outcome['activationState'] !== expectedActivationState) {
      throw contradiction(`containment outcome '${outcome['operationId']}' must fail the desired operation while reporting its retained terminal state`);
    }
  }
  if (outcome['result'] === 'succeeded') {
    const terminalStateMatches = outcome['coverage'] === 'retirement'
      ? outcome['resourceState'] === 'absent' && outcome['activationState'] === 'inactive'
      : outcome['resourceState'] === 'present' && outcome['activationState'] === 'active-conforming';
    if (!terminalStateMatches) throw contradiction(`successful outcome '${outcome['operationId']}' contradicts its terminal resource or activation state`);
  }
  if (outcome['result'] === 'not-attempted' && outcome['resourceState'] === 'potentially-changed') {
    throw contradiction(`not-attempted outcome '${outcome['operationId']}' cannot be potentially changed`);
  }
  if ((dryRun || outcome['result'] === 'not-attempted' || outcome['action'] === 'unchanged' || outcome['action'] === 'retain-prior' || outcome['route'] === 'none') && outcome['changed'] === true) {
    throw contradiction(`outcome '${outcome['operationId']}' cannot report changed=true`);
  }
}

function assertSummary(summary: Record<string, unknown>, outcomes: readonly Record<string, unknown>[], dryRun: boolean): void {
  exactFields(summary, ['result', 'terminalPhase', 'mutationStarted', 'changed', 'failureCategory', 'reason', 'recoveryId', 'readbackId'], 'lifecycle summary');
  if (!oneOf(LIFECYCLE_COMMAND_RESULTS, summary['result']) || !oneOf(LIFECYCLE_TERMINAL_PHASES, summary['terminalPhase']) ||
      typeof summary['mutationStarted'] !== 'boolean' || typeof summary['changed'] !== 'boolean' ||
      !(summary['failureCategory'] === null || oneOf(LIFECYCLE_REASON_CATEGORIES, summary['failureCategory'])) ||
      !(summary['reason'] === null || isObject(summary['reason'])) || !nullableString(summary['recoveryId']) || !nullableString(summary['readbackId'])) {
    throw invalid('lifecycle summary contains a missing or invalid field');
  }
  const reason = summary['reason'];
  if (reason !== null) assertReason(reason as Record<string, unknown>);
  if (reason !== null && (reason as Record<string, unknown>)['category'] !== summary['failureCategory']) {
    throw contradiction('summary failureCategory contradicts its reason');
  }
  const nonSuccess = outcomes.some((outcome) => outcome['result'] !== 'succeeded');
  const anyChanged = outcomes.some((outcome) => outcome['changed'] === true);
  const potentiallyChanged = outcomes.some((outcome) => outcome['resourceState'] === 'potentially-changed');
  const pairFailureCategories = new Set(outcomes
    .filter((outcome) => outcome['result'] !== 'succeeded')
    .map((outcome) => (outcome['reason'] as Record<string, unknown>)['category']));
  if (summary['changed'] !== anyChanged) throw contradiction('summary changed flag contradicts its outcomes');
  if ((dryRun || summary['mutationStarted'] === false) && summary['changed'] === true) throw contradiction('summary cannot report changed=true before mutation');
  if (potentiallyChanged && summary['mutationStarted'] === false) throw contradiction('potentially changed work requires mutationStarted=true');
  if (dryRun && summary['mutationStarted'] === true) throw contradiction('dry-run summary cannot report mutationStarted=true');
  if (summary['result'] === 'converged' && (nonSuccess || summary['failureCategory'] !== null || reason !== null)) {
    throw contradiction('converged summary contradicts a failure outcome or reason');
  }
  if (summary['result'] === 'converged' && summary['terminalPhase'] !== 'complete') {
    throw contradiction('converged summary must reach the complete phase');
  }
  if (summary['result'] === 'incomplete' && summary['failureCategory'] === null) throw contradiction('incomplete summary needs a failureCategory');
  if (summary['result'] === 'incomplete' && !nonSuccess && reason === null) throw contradiction('command-global incomplete summary needs a reason');
  if (summary['result'] === 'incomplete' && reason === null && !pairFailureCategories.has(summary['failureCategory'])) {
    throw contradiction('summary failureCategory does not match any failed pair');
  }
  if (reason !== null && (reason as Record<string, unknown>)['category'] === 'usage' && summary['result'] !== 'usage-error') {
    throw contradiction('usage reason requires a usage-error summary');
  }
  if (summary['result'] === 'usage-error' && (summary['failureCategory'] !== 'usage' || reason === null || outcomes.length > 0 ||
      summary['mutationStarted'] !== false || summary['terminalPhase'] !== 'parse')) {
    throw contradiction('usage-error summary must be a non-mutating, outcome-free parse failure carrying a usage reason');
  }
}

function assertReason(reason: Record<string, unknown>): void {
  exactFields(reason, ['category', 'code', 'diagnostic', 'capabilityId', 'evidenceId'], 'lifecycle reason');
  if (!oneOf(LIFECYCLE_REASON_CATEGORIES, reason['category']) || !oneOf(LIFECYCLE_REASON_CODES, reason['code']) ||
      !hasText(reason['diagnostic']) || !nullableText(reason['capabilityId']) || !nullableText(reason['evidenceId'])) {
    throw invalid('lifecycle reason contains a missing or invalid field');
  }
  if ((reason['code'] as string).slice(0, (reason['code'] as string).indexOf('.')) !== reason['category']) {
    throw invalid(`reason code '${reason['code']}' does not belong to category '${reason['category']}'`);
  }
  if (reason['category'] === 'capability' && reason['capabilityId'] === null) throw invalid('capability reason needs a capabilityId');
  if (reason['category'] !== 'capability' && (reason['capabilityId'] !== null || reason['evidenceId'] !== null)) {
    throw invalid('only capability reasons may carry capability or evidence identifiers');
  }
}

function assertScope(scope: Record<string, unknown>): void {
  exactFields(scope, ['id', 'source', 'target'], 'deployment scope');
  if (!nonempty(scope['id']) || !isObject(scope['source']) || !isObject(scope['target'])) {
    throw invalid('planned operation has a malformed deployment scope');
  }
  assertSourceBinding(scope['source'], 'planned operation deployment scope');
  exactFields(scope['target'], ['kind', 'instance'], 'deployment scope target');
  let canonical: DeploymentScopeIdentity;
  try {
    canonical = createDeploymentScopeIdentity(
      scope['source'] as unknown as DeploymentScopeIdentity['source'],
      scope['target'] as unknown as DeploymentScopeIdentity['target'],
    );
  } catch (error) {
    throw invalid(`planned operation has an invalid deployment scope: ${unknownErrorDiagnostic(error)}`);
  }
  if (!sameScope(scope as unknown as DeploymentScopeIdentity, canonical)) {
    throw invalid('planned operation deployment scope id contradicts its Source and target identity');
  }
}

function assertSourceBinding(binding: Record<string, unknown>, label: string): void {
  if (binding['kind'] === 'local') {
    exactFields(binding, ['kind', 'locator'], `${label} Source binding`);
    if (!nonempty(binding['locator'])) throw invalid(`${label} local Source binding needs a locator`);
  } else if (binding['kind'] === 'git') {
    exactFields(binding, ['kind', 'locator', 'ref'], `${label} Source binding`);
    if (!nonempty(binding['locator']) || !nonempty(binding['ref'])) throw invalid(`${label} git Source binding needs a locator and ref`);
  } else {
    throw invalid(`${label} Source binding has an unknown kind`);
  }
  try {
    validateSourceBinding(binding as unknown as DeploymentScopeIdentity['source']);
  } catch (error) {
    throw invalid(`${label} has an invalid Source binding: ${unknownErrorDiagnostic(error)}`);
  }
}

function sameScope(left: DeploymentScopeIdentity, right: DeploymentScopeIdentity): boolean {
  return left.id === right.id && sameSourceBinding(left.source, right.source) &&
    left.target.kind === right.target.kind && left.target.instance === right.target.instance;
}

function sameSourceBinding(left: DeploymentScopeIdentity['source'], right: DeploymentScopeIdentity['source']): boolean {
  return left.kind === right.kind && left.locator === right.locator &&
    (left.kind === 'local' || (right.kind === 'git' && left.ref === right.ref));
}

function oneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || nonempty(value);
}

function nullableText(value: unknown): value is string | null {
  return value === null || hasText(value);
}

function exactFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !fields.has(key));
  if (unknown !== undefined) throw invalid(`${label} has unsupported field '${unknown}'`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
