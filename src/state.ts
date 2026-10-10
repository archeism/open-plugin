/**
 * Reader-only persistence boundary for `$OPEN_PLUGIN_HOME/state.json`.
 *
 * Doctor imports this module, so filesystem mutation remains isolated in
 * `src/state-write.ts`. Version 1 is parsed strictly and projected both into
 * its compatibility row shape and, for new lifecycle callers, into an
 * in-memory version 2 document whose claims have no retirement authority.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createDeploymentScopeIdentity, validateSourceBinding, type TargetIdentity } from './deployment-scope';
import { stateFile } from './paths';
import type { SourceBinding } from './source-reference';
import {
  parsePersistedTargetIdentity,
  TargetIdentityValidationError,
  type PersistedTargetIdentity,
} from './target-identity';

import { CryptoHasher } from './runtime';

export type { PersistedTargetIdentity } from './target-identity';


export type DeploymentScopeId = string;

/** Public compatibility alias for the canonical Source-domain type. */
export type PersistedSourceBinding = SourceBinding;

export interface DesiredPackageRecord {
  packageId: string;
  nativeId: string;
  sourceRelativeDir: string;
  requiredCapabilities: string[];
  adoptionRequested: boolean;
}

export interface DesiredGenerationRecord {
  generation: number;
  revision: string;
  sourceFingerprint: string;
  packages: DesiredPackageRecord[];
  validatedAt: string;
}

export interface DeploymentScopeRecord {
  id: DeploymentScopeId;
  source: PersistedSourceBinding;
  target: PersistedTargetIdentity;
  /** Legacy imports cannot establish desired-set or prune authority. */
  authority: 'legacy-import' | 'authoritative';
  lifecycle: 'active' | 'retiring' | 'retired';
  selectorMode: 'legacy-unknown' | 'all' | 'explicit' | 'retired';
  desired?: DesiredGenerationRecord;
  lastConverged?: DesiredGenerationRecord;
  lastAttemptId?: string;
  createdAt?: string;
  updatedAt?: string;
  retiredAt?: string;
}

export interface CapabilityEvidenceReferenceRecord {
  kind: 'capability-profile';
  key: string;
}

export type OwnershipProofReferenceRecord =
  | { kind: 'managed-marker'; key: string }
  | { kind: 'native-record'; key: string };

export type LifecycleRouteRecord =
  | { kind: 'legacy-unverified' }
  | { kind: 'managed' | 'native'; evidenceKey: CapabilityEvidenceReferenceRecord };

export type OwnershipProofRecord =
  | { kind: 'legacy-claim' }
  | { kind: 'created'; proofKey: OwnershipProofReferenceRecord; verifiedAt: string }
  | { kind: 'adopted'; proofKey: OwnershipProofReferenceRecord; verifiedAt: string; adoptedAt: string };

export interface FingerprintRecord {
  source?: string;
  projected?: string;
  installed?: string;
}

const PENDING_OPERATIONS = ['install', 'update', 'route-migrate', 'disable-nonconforming', 'retire-orphan', 'remove'] as const;

export type PendingOperation = typeof PENDING_OPERATIONS[number];
export type PendingPhase = 'accepted' | 'applying' | 'readback' | 'cleanup' | 'rollback';

export interface PendingOperationRecord {
  operation: PendingOperation;
  phase: PendingPhase;
  attemptId: string;
  startedAt?: string;
}

export interface ActivationRecord {
  scopeId: DeploymentScopeId;
  packageId: string;
  nativeId: string;
  sourceRelativeDir?: string;
  /** Exact immutable revision represented by this activation, including legacy imports. */
  sourceRevision?: string;
  route: LifecycleRouteRecord;
  ownership: OwnershipProofRecord;
  fingerprints: FingerprintRecord;
  activationState: 'active' | 'inactive' | 'retained' | 'nonconforming' | 'unknown';
  readbackState: 'verified' | 'pending' | 'failed' | 'unverified';
  pending?: PendingOperationRecord;
  pins: string[];
  activatedAt?: string;
  readbackAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

const JOURNAL_ACTIONS = [...PENDING_OPERATIONS, 'unchanged', 'retain-prior'] as const;

export type JournalAction = typeof JOURNAL_ACTIONS[number];
export type JournalState = 'pending' | 'applying' | 'applied' | 'readback-verified' | 'rollback' | 'rolled-back' | 'cleanup-pending' | 'completed' | 'failed' | 'not-attempted';

const MUTATION_STARTED_JOURNAL_STATES = new Set<JournalState>([
  'applying',
  'applied',
  'readback-verified',
  'rollback',
  'rolled-back',
  'cleanup-pending',
  'completed',
  'failed',
]);

export interface JournalEntryRecord {
  operationId: string;
  scopeId: DeploymentScopeId;
  packageId?: string;
  nativeId?: string;
  action: JournalAction;
  state: JournalState;
  route?: LifecycleRouteRecord;
  startedAt?: string;
  updatedAt?: string;
}

export interface LifecycleAttemptRecord {
  id: string;
  command: 'sync' | 'retire-source' | 'add' | 'update' | 'remove' | 'legacy-recovery';
  phase: 'accepted' | 'applying' | 'readback' | 'pruning' | 'finalizing' | 'completed' | 'failed' | 'recovery-required';
  mutationStarted: boolean;
  scopeIds: DeploymentScopeId[];
  journal: JournalEntryRecord[];
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface TombstoneRecord {
  id: string;
  scopeId: DeploymentScopeId;
  packageId: string;
  nativeId: string;
  sourceRelativeDir?: string;
  sourceRevision: string;
  route: Exclude<LifecycleRouteRecord, { kind: 'legacy-unverified' }>;
  ownership: Exclude<OwnershipProofRecord, { kind: 'legacy-claim' }>;
  fingerprints: FingerprintRecord;
  pins: string[];
  retentionState: 'plugin-state-retained';
  activatedAt?: string;
  retiredAt: string;
}

export interface LifecycleStateV2 {
  version: 2;
  /** Monotonic ledger generation, incremented once per atomic replacement. */
  stateGeneration: number;
  scopes: DeploymentScopeRecord[];
  activations: ActivationRecord[];
  attempts: LifecycleAttemptRecord[];
  tombstones: TombstoneRecord[];
}

export interface LoadedLifecycleState {
  /** `null` means no state file existed. */
  sourceVersion: 1 | 2 | null;
  state: LifecycleStateV2;
}

/** Compatibility shape consumed by existing additive verbs and doctor. */
export interface InstallRecord {
  host: string;
  id: string;
  source: string;
  sourceSha: string;
  installedAt?: string;
  /** Server names `pin` rewrote to an absolute path in this host's copy, sorted. */
  pins?: string[];
  /** Source-byte fingerprint (version 1 compatibility name). */
  fingerprint?: string;
  /** Canonical selected package directory (version 1 compatibility name). */
  sourceDir?: string;
  /** Raw-byte fingerprint of the activated host-native representation. */
  installedFingerprint?: string;
  /** Version 1 ownership marker; v2 legacy claims project as `legacy-unverified`. */
  ownership?: string;
  /** Durable version 1 intent. */
  pending?: 'install' | 'remove';
}

const V1_RECORD_FIELDS = new Set(['host', 'id', 'source', 'sourceSha', 'installedAt', 'pins', 'fingerprint', 'sourceDir', 'installedFingerprint', 'ownership', 'pending']);
/** A verified creation or adoption proof is necessary, but not sufficient, for pruning. */
export function hasRetirementAuthority(activation: Pick<ActivationRecord, 'ownership'>): boolean {
  return activation.ownership.kind === 'created' || activation.ownership.kind === 'adopted';
}

/** Strictly read v1 or v2 without ever writing an imported v1 document. */
export function readLifecycleState(file: string = stateFile()): LoadedLifecycleState {
  const parsed = readDocument(file);
  if (parsed === null) return { sourceVersion: null, state: emptyLifecycleState() };
  const root = asObject(parsed, 'root');
  if (root['version'] === 1) return { sourceVersion: 1, state: importV1(parseV1(root)) };
  if (root['version'] === 2) return { sourceVersion: 2, state: validateLifecycleState(root) };
  throw new Error(`Unsupported state.json version: ${String(root['version'])}`);
}

/**
 * Existing additive commands retain their row API during the lifecycle
 * transition. A v2 document is projected read-only; the v1 writer refuses to
 * overwrite it, preventing an automatic downgrade.
 */
export function readState(file: string = stateFile()): InstallRecord[] {
  const parsed = readDocument(file);
  if (parsed === null) return [];
  const root = asObject(parsed, 'root');
  if (root['version'] === 1) return parseV1(root);
  if (root['version'] === 2) return projectV2(validateLifecycleState(root));
  throw new Error(`Unsupported state.json version: ${String(root['version'])}`);
}

/** Pure v1 row validation shared by the compatibility reader and writer. */
export function validateLegacyInstallRecords(value: unknown): InstallRecord[] {
  return parseV1({ version: 1, installs: value });
}

/** Validate and return the exact state value for writer and reader parity. */
export function validateLifecycleState(value: unknown): LifecycleStateV2 {
  return validateLifecycleStateDocument(value, 1);
}

function validateLifecycleStateDocument(value: unknown, minimumStateGeneration: 0 | 1): LifecycleStateV2 {
  const root = asObject(value, 'root');
  exactFields(root, ['version', 'stateGeneration', 'scopes', 'activations', 'attempts', 'tombstones'], 'root');
  if (root['version'] !== 2) throw new Error(`Unsupported state.json version: ${String(root['version'])}`);
  safeInteger(root['stateGeneration'], 'stateGeneration', minimumStateGeneration);
  const scopes = array(root['scopes'], 'scopes').map((item, index) => validateScope(item, `scopes[${index}]`));
  const activations = array(root['activations'], 'activations').map((item, index) => validateActivation(item, `activations[${index}]`));
  const attempts = array(root['attempts'], 'attempts').map((item, index) => validateAttempt(item, `attempts[${index}]`));
  const tombstones = array(root['tombstones'], 'tombstones').map((item, index) => validateTombstone(item, `tombstones[${index}]`));

  unique(scopes.map(scope => scope.id), 'deployment scope id');
  unique(attempts.map(attempt => attempt.id), 'attempt id');
  unique(tombstones.map(tombstone => tombstone.id), 'tombstone id');
  unique(activations.map(activation => activationKey(activation)), 'activation identity');

  const scopeIds = new Set(scopes.map(scope => scope.id));
  const attemptsById = new Map(attempts.map(attempt => [attempt.id, attempt]));
  const operationIds: string[] = [];
  for (const scope of scopes) {
    if (scope.lastAttemptId === undefined) continue;
    const attempt = attemptsById.get(scope.lastAttemptId);
    if (attempt === undefined) invalid(`deployment scope '${scope.id}' references unknown last attempt '${scope.lastAttemptId}'`);
    if (!attempt.scopeIds.includes(scope.id)) invalid(`deployment scope '${scope.id}' last attempt does not include that scope`);
  }
  for (const activation of activations) {
    if (!scopeIds.has(activation.scopeId)) invalid(`activation '${activationKey(activation)}' references unknown scope '${activation.scopeId}'`);
    if (activation.pending === undefined) continue;
    const attempt = attemptsById.get(activation.pending.attemptId);
    if (attempt === undefined) invalid(`activation '${activationKey(activation)}' references unknown pending attempt '${activation.pending.attemptId}'`);
    if (!attempt.scopeIds.includes(activation.scopeId)) invalid(`activation '${activationKey(activation)}' pending attempt does not include its scope`);
    const matchingEntries = attempt.journal.filter(entry =>
      entry.scopeId === activation.scopeId
      && entry.packageId === activation.packageId
      && entry.nativeId === activation.nativeId
    );
    if (matchingEntries.length !== 1) invalid(`activation '${activationKey(activation)}' pending attempt must contain exactly one matching package/native journal entry`);
    validatePendingSemantics(activation, attempt, matchingEntries[0]!);
  }
  for (const attempt of attempts) {
    for (const scopeId of attempt.scopeIds) if (!scopeIds.has(scopeId)) invalid(`attempt '${attempt.id}' references unknown scope '${scopeId}'`);
    for (const entry of attempt.journal) {
      operationIds.push(entry.operationId);
      if (!attempt.scopeIds.includes(entry.scopeId)) invalid(`attempt '${attempt.id}' journal references scope '${entry.scopeId}' outside the attempt`);
    }
  }
  unique(operationIds, 'journal operation id');
  for (const tombstone of tombstones) if (!scopeIds.has(tombstone.scopeId)) invalid(`tombstone '${tombstone.id}' references unknown scope '${tombstone.scopeId}'`);
  return value as LifecycleStateV2;
}

/** Find the compatibility row for one host-native identity. */
export function findRecord(records: InstallRecord[], host: string, id: string): InstallRecord | undefined {
  return records.find(record => record.host === host && record.id === id);
}

function emptyLifecycleState(): LifecycleStateV2 {
  return { version: 2, stateGeneration: 0, scopes: [], activations: [], attempts: [], tombstones: [] };
}

function readDocument(file: string): unknown | null {
  if (!existsSync(file)) return null;
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`Unable to read state.json: ${(error as Error).message}`); }
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new Error(`Invalid state.json: ${(error as Error).message}`); }
}

function parseV1(root: Record<string, unknown>): InstallRecord[] {
  exactFields(root, ['version', 'installs'], 'root');
  const installs = array(root['installs'], 'installs').map((value, index) => parseV1Install(value, index));
  unique(installs.map(record => `${record.host}\u0000${record.id}`), 'version 1 host/plugin identity');
  for (const record of installs) legacySourceBinding(record.source);
  return installs;
}

function parseV1Install(value: unknown, index: number): InstallRecord {
  const rec = asObject(value, 'install record');
  const unknown = Object.keys(rec).find(key => !V1_RECORD_FIELDS.has(key));
  if (unknown !== undefined) invalid(`unsupported install field '${unknown}'`);
  if (typeof rec['host'] !== 'string' || typeof rec['id'] !== 'string' || typeof rec['source'] !== 'string' || typeof rec['sourceSha'] !== 'string') {
    invalid('install record is missing required fields');
  }
  const host = rec['host'];
  const id = rec['id'];
  const source = rec['source'];
  const sourceSha = rec['sourceSha'];
  if (rec['installedAt'] !== undefined) timestamp(rec['installedAt'], 'installedAt');
  const pins = optionalLegacyPins(rec['pins']);
  optionalLegacyString(rec['fingerprint'], 'fingerprint');
  optionalLegacyString(rec['sourceDir'], 'sourceDir');
  optionalLegacyString(rec['installedFingerprint'], 'installedFingerprint');
  optionalLegacyString(rec['ownership'], 'ownership');
  if (rec['pending'] !== undefined && rec['pending'] !== 'install' && rec['pending'] !== 'remove') invalid('pending must be install or remove');
  const record: InstallRecord = { host, id, source, sourceSha };
  if (typeof rec['installedAt'] === 'string') record.installedAt = rec['installedAt'];
  if (pins !== undefined && pins.length > 0) record.pins = pins;
  if (typeof rec['fingerprint'] === 'string') record.fingerprint = rec['fingerprint'];
  if (typeof rec['sourceDir'] === 'string') record.sourceDir = rec['sourceDir'];
  if (typeof rec['installedFingerprint'] === 'string') record.installedFingerprint = rec['installedFingerprint'];
  if (typeof rec['ownership'] === 'string') record.ownership = rec['ownership'];
  if (rec['pending'] === 'install' || rec['pending'] === 'remove') record.pending = rec['pending'];
  return record;
}

function importV1(records: InstallRecord[]): LifecycleStateV2 {
  const state = emptyLifecycleState();
  const scopes = new Map<string, DeploymentScopeRecord>();
  for (const record of records) {
    const source = legacySourceBinding(record.source);
    const scopeId = legacyScopeId(source, record.host, 'default');
    let scope = scopes.get(scopeId);
    if (scope === undefined) {
      scope = {
        id: scopeId,
        source,
        target: { kind: record.host, instance: 'default' },
        authority: 'legacy-import',
        lifecycle: 'active',
        selectorMode: 'legacy-unknown',
      };
      scopes.set(scopeId, scope);
    }
    const relativeDir = legacyRelativeDir(record);
    const attemptId = record.pending === undefined ? undefined : `legacy-attempt-${digest(`${scopeId}\u0000${record.id}\u0000${record.pending}`)}`;
    state.activations.push({
      scopeId,
      packageId: record.id,
      nativeId: record.id,
      ...(relativeDir === undefined ? {} : { sourceRelativeDir: relativeDir }),
      sourceRevision: record.sourceSha,
      route: { kind: 'legacy-unverified' },
      ownership: { kind: 'legacy-claim' },
      fingerprints: {
        ...(record.fingerprint === undefined ? {} : { source: record.fingerprint }),
        ...(record.installedFingerprint === undefined ? {} : { installed: record.installedFingerprint }),
      },
      activationState: 'unknown',
      readbackState: 'unverified',
      ...(attemptId === undefined ? {} : {
        pending: {
          operation: record.pending === 'remove' ? 'remove' : 'install',
          phase: 'applying',
          attemptId,
          ...(validTimestamp(record.installedAt) ? { startedAt: record.installedAt } : {}),
        } satisfies PendingOperationRecord,
      }),
      pins: sortedUnique(record.pins ?? []),
      ...(validTimestamp(record.installedAt) ? { activatedAt: record.installedAt, createdAt: record.installedAt, updatedAt: record.installedAt } : {}),
    });
    if (attemptId !== undefined) {
      const action = record.pending === 'remove' ? 'remove' : 'install';
      state.attempts.push({
        id: attemptId,
        command: 'legacy-recovery',
        phase: record.pending === 'remove' ? 'pruning' : 'applying',
        mutationStarted: true,
        scopeIds: [scopeId],
        journal: [{
          operationId: `legacy-operation-${digest(attemptId)}`,
          scopeId,
          packageId: record.id,
          nativeId: record.id,
          action,
          state: 'applying',
          route: { kind: 'legacy-unverified' },
          ...(validTimestamp(record.installedAt) ? { startedAt: record.installedAt, updatedAt: record.installedAt } : {}),
        }],
        ...(validTimestamp(record.installedAt) ? { startedAt: record.installedAt, updatedAt: record.installedAt } : {}),
      });
      scope.lastAttemptId = attemptId;
    }
  }
  state.scopes = [...scopes.values()];
  return validateLifecycleStateDocument(state, 0);
}

function projectV2(state: LifecycleStateV2): InstallRecord[] {
  const scopes = new Map(state.scopes.map(scope => [scope.id, scope]));
  return state.activations.map(activation => {
    const scope = scopes.get(activation.scopeId)!;
    const revision = activation.sourceRevision ?? scope.lastConverged?.revision ?? scope.desired?.revision ?? 'unknown';
    const record: InstallRecord = {
      host: scope.target.kind,
      id: activation.nativeId,
      source: compatibilitySourceUri(scope.source),
      sourceSha: revision,
      pins: activation.pins.length === 0 ? undefined : [...activation.pins],
      fingerprint: activation.fingerprints.source,
      installedFingerprint: activation.fingerprints.installed,
      ownership: activation.ownership.kind === 'legacy-claim' ? 'legacy-unverified' : 'plgnz',
      installedAt: activation.activatedAt,
      pending: activation.pending === undefined ? undefined : pendingV1(activation.pending.operation),
    };
    if (scope.source.kind === 'local' && activation.sourceRelativeDir !== undefined) record.sourceDir = join(scope.source.locator, activation.sourceRelativeDir);
    return removeUndefined(record);
  });
}

function validateScope(value: unknown, label: string): DeploymentScopeRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['id', 'source', 'target', 'authority', 'lifecycle', 'selectorMode', 'desired', 'lastConverged', 'lastAttemptId', 'createdAt', 'updatedAt', 'retiredAt'], 'deployment scope');
  const id = requiredString(rec['id'], `${label}.id`);
  const source = validateSource(rec['source'], `${label}.source`);
  const target = validateTarget(rec['target'], `${label}.target`);
  const canonicalId = canonicalScopeId(source, target);
  if (id !== canonicalId) invalid(`deployment scope '${id}' does not match canonical Source and target identity '${canonicalId}'`);
  oneOf(rec['authority'], ['legacy-import', 'authoritative'], `${label}.authority`);
  oneOf(rec['lifecycle'], ['active', 'retiring', 'retired'], `${label}.lifecycle`);
  oneOf(rec['selectorMode'], ['legacy-unknown', 'all', 'explicit', 'retired'], `${label}.selectorMode`);
  const desired = rec['desired'] === undefined ? undefined : validateDesired(rec['desired'], `${label}.desired`);
  const lastConverged = rec['lastConverged'] === undefined ? undefined : validateDesired(rec['lastConverged'], `${label}.lastConverged`);
  optionalString(rec['lastAttemptId'], `${label}.lastAttemptId`);
  optionalTimestamp(rec['createdAt'], `${label}.createdAt`);
  optionalTimestamp(rec['updatedAt'], `${label}.updatedAt`);
  optionalTimestamp(rec['retiredAt'], `${label}.retiredAt`);
  if (rec['authority'] === 'legacy-import' && (rec['selectorMode'] !== 'legacy-unknown' || desired !== undefined || lastConverged !== undefined)) invalid(`deployment scope '${id}' legacy import cannot carry desired or converged authority`);
  if (rec['authority'] === 'authoritative' && rec['lifecycle'] !== 'retired' && desired === undefined) invalid(`deployment scope '${id}' authoritative lifecycle requires desired state`);
  if (desired !== undefined && rec['selectorMode'] !== 'all' && rec['selectorMode'] !== 'explicit') invalid(`deployment scope '${id}' desired state requires all or explicit selector mode`);
  if (rec['lifecycle'] === 'retired' && rec['selectorMode'] !== 'retired') invalid(`deployment scope '${id}' retired lifecycle requires retired selector mode`);
  if (lastConverged !== undefined && desired !== undefined && lastConverged.generation > desired.generation) invalid(`deployment scope '${id}' last-converged generation exceeds desired generation`);
  return value as DeploymentScopeRecord;
}

function validateSource(value: unknown, label: string): PersistedSourceBinding {
  const rec = asObject(value, label);
  const kind = oneOf(rec['kind'], ['local', 'git'], `${label}.kind`);
  exactFields(rec, kind === 'git' ? ['kind', 'locator', 'ref'] : ['kind', 'locator'], 'source binding');
  const locator = requiredString(rec['locator'], `${label}.locator`);
  const source: PersistedSourceBinding = kind === 'local'
    ? { kind, locator }
    : { kind, locator, ref: requiredString(rec['ref'], `${label}.ref`) };
  validateCanonicalSourceBinding(source, label);
  return source;
}

function validateTarget(value: unknown, label: string): PersistedTargetIdentity {
  try {
    return parsePersistedTargetIdentity(value, label);
  } catch (error) {
    if (error instanceof TargetIdentityValidationError) invalid(error.message);
    throw error;
  }
}

function validateDesired(value: unknown, label: string): DesiredGenerationRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['generation', 'revision', 'sourceFingerprint', 'packages', 'validatedAt'], 'desired generation');
  safeInteger(rec['generation'], `${label}.generation`, 1);
  requiredString(rec['revision'], `${label}.revision`);
  requiredString(rec['sourceFingerprint'], `${label}.sourceFingerprint`);
  timestamp(rec['validatedAt'], `${label}.validatedAt`);
  const packages = array(rec['packages'], `${label}.packages`).map((item, index) => validateDesiredPackage(item, `${label}.packages[${index}]`));
  if (packages.length === 0) invalid(`${label}.packages must not be empty; retire the scope explicitly`);
  unique(packages.map(item => item.packageId), `${label} package identity`);
  unique(packages.map(item => item.nativeId), `${label} native identity`);
  return value as DesiredGenerationRecord;
}

function validateDesiredPackage(value: unknown, label: string): DesiredPackageRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['packageId', 'nativeId', 'sourceRelativeDir', 'requiredCapabilities', 'adoptionRequested'], 'desired package');
  requiredString(rec['packageId'], `${label}.packageId`);
  requiredString(rec['nativeId'], `${label}.nativeId`);
  relativePath(rec['sourceRelativeDir'], `${label}.sourceRelativeDir`);
  const capabilities = stringArray(rec['requiredCapabilities'], `${label}.requiredCapabilities`);
  sortedUniqueRequired(capabilities, `${label}.requiredCapabilities`, true);
  if (typeof rec['adoptionRequested'] !== 'boolean') invalid(`${label}.adoptionRequested must be a boolean`);
  return value as DesiredPackageRecord;
}

function validateActivation(value: unknown, label: string): ActivationRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['scopeId', 'packageId', 'nativeId', 'sourceRelativeDir', 'sourceRevision', 'route', 'ownership', 'fingerprints', 'activationState', 'readbackState', 'pending', 'pins', 'activatedAt', 'readbackAt', 'createdAt', 'updatedAt'], 'activation');
  requiredString(rec['scopeId'], `${label}.scopeId`);
  requiredString(rec['packageId'], `${label}.packageId`);
  requiredString(rec['nativeId'], `${label}.nativeId`);
  if (rec['sourceRelativeDir'] !== undefined) relativePath(rec['sourceRelativeDir'], `${label}.sourceRelativeDir`);
  optionalString(rec['sourceRevision'], `${label}.sourceRevision`);
  const route = validateRoute(rec['route'], `${label}.route`);
  const ownershipObject = asObject(rec['ownership'], `${label}.ownership`);
  if (route.kind !== 'legacy-unverified' && ownershipObject['kind'] === 'legacy-claim') invalid('legacy ownership cannot use a verified route');
  const ownership = validateOwnership(ownershipObject, `${label}.ownership`);
  const fingerprints = validateFingerprints(rec['fingerprints'], `${label}.fingerprints`);
  oneOf(rec['activationState'], ['active', 'inactive', 'retained', 'nonconforming', 'unknown'], `${label}.activationState`);
  oneOf(rec['readbackState'], ['verified', 'pending', 'failed', 'unverified'], `${label}.readbackState`);
  const pending = rec['pending'] === undefined ? undefined : validatePending(rec['pending'], `${label}.pending`);
  const pins = stringArray(rec['pins'], `${label}.pins`);
  sortedUniqueRequired(pins, `${label}.pins`, true);
  optionalTimestamp(rec['activatedAt'], `${label}.activatedAt`);
  optionalTimestamp(rec['readbackAt'], `${label}.readbackAt`);
  optionalTimestamp(rec['createdAt'], `${label}.createdAt`);
  optionalTimestamp(rec['updatedAt'], `${label}.updatedAt`);
  if ((route.kind === 'legacy-unverified') !== (ownership.kind === 'legacy-claim')) invalid(`${label} legacy route and ownership claim must agree`);
  if (route.kind !== 'legacy-unverified' && (rec['sourceRevision'] === undefined || fingerprints.source === undefined || fingerprints.projected === undefined || fingerprints.installed === undefined)) invalid(`${label} verified route requires source revision plus source, projected, and installed fingerprints`);
  if (rec['readbackState'] === 'verified' && fingerprints.installed === undefined) invalid(`${label} verified readback requires an installed fingerprint`);
  if (pending === undefined && rec['readbackState'] === 'pending') invalid(`${label} pending readback requires a pending operation`);
  return value as ActivationRecord;
}

function validateRoute(value: unknown, label: string): LifecycleRouteRecord {
  const rec = asObject(value, label);
  const kind = oneOf(rec['kind'], ['legacy-unverified', 'managed', 'native'], `${label}.kind`);
  exactFields(rec, kind === 'legacy-unverified' ? ['kind'] : ['kind', 'evidenceKey'], 'route');
  if (kind !== 'legacy-unverified') validateCapabilityEvidenceReference(rec['evidenceKey'], `${label}.evidenceKey`);
  return value as LifecycleRouteRecord;
}

function validateOwnership(value: unknown, label: string): OwnershipProofRecord {
  const rec = asObject(value, label);
  const kind = oneOf(rec['kind'], ['legacy-claim', 'created', 'adopted'], `${label}.kind`);
  exactFields(rec, kind === 'legacy-claim' ? ['kind'] : kind === 'created' ? ['kind', 'proofKey', 'verifiedAt'] : ['kind', 'proofKey', 'verifiedAt', 'adoptedAt'], 'ownership proof');
  if (kind !== 'legacy-claim') {
    validateOwnershipProofReference(rec['proofKey'], `${label}.proofKey`);
    timestamp(rec['verifiedAt'], `${label}.verifiedAt`);
  }
  if (kind === 'adopted') timestamp(rec['adoptedAt'], `${label}.adoptedAt`);
  return value as OwnershipProofRecord;
}

function validateFingerprints(value: unknown, label: string): FingerprintRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['source', 'projected', 'installed'], 'fingerprints');
  optionalString(rec['source'], `${label}.source`);
  optionalString(rec['projected'], `${label}.projected`);
  optionalString(rec['installed'], `${label}.installed`);
  return value as FingerprintRecord;
}

function validateCapabilityEvidenceReference(value: unknown, label: string): CapabilityEvidenceReferenceRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['kind', 'key'], 'capability evidence reference');
  oneOf(rec['kind'], ['capability-profile'], `${label}.kind`);
  contentAddress(rec['key'], `${label}.key`);
  return value as CapabilityEvidenceReferenceRecord;
}

function validateOwnershipProofReference(value: unknown, label: string): OwnershipProofReferenceRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['kind', 'key'], 'ownership proof reference');
  oneOf(rec['kind'], ['managed-marker', 'native-record'], `${label}.kind`);
  contentAddress(rec['key'], `${label}.key`);
  return value as OwnershipProofReferenceRecord;
}

function validatePending(value: unknown, label: string): PendingOperationRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['operation', 'phase', 'attemptId', 'startedAt'], 'pending operation');
  oneOf(rec['operation'], PENDING_OPERATIONS, `${label}.operation`);
  oneOf(rec['phase'], ['accepted', 'applying', 'readback', 'cleanup', 'rollback'], `${label}.phase`);
  requiredString(rec['attemptId'], `${label}.attemptId`);
  optionalTimestamp(rec['startedAt'], `${label}.startedAt`);
  return value as PendingOperationRecord;
}

function validatePendingSemantics(
  activation: ActivationRecord,
  attempt: LifecycleAttemptRecord,
  journal: JournalEntryRecord,
): void {
  const pending = activation.pending!;
  const identity = `activation '${activationKey(activation)}'`;
  if (pending.operation !== journal.action) invalid(`${identity} pending operation must match journal action`);
  const isRetirement = pending.operation === 'retire-orphan' || pending.operation === 'remove';

  let journalState: JournalState;
  let attemptPhases: Array<LifecycleAttemptRecord['phase']>;
  let mutationStarted: boolean;
  switch (pending.phase) {
    case 'accepted':
      journalState = 'pending';
      attemptPhases = ['accepted'];
      mutationStarted = false;
      break;
    case 'applying':
      journalState = 'applying';
      attemptPhases = [isRetirement ? 'pruning' : 'applying'];
      mutationStarted = true;
      break;
    case 'readback':
      journalState = 'applied';
      attemptPhases = [isRetirement ? 'pruning' : 'readback'];
      mutationStarted = true;
      break;
    case 'cleanup':
      journalState = 'cleanup-pending';
      attemptPhases = ['finalizing'];
      mutationStarted = true;
      break;
    case 'rollback':
      journalState = 'rollback';
      attemptPhases = ['recovery-required'];
      mutationStarted = true;
      break;
  }

  if (journal.state !== journalState) invalid(`${identity} pending phase ${pending.phase} requires journal ${journalState}`);
  if (!attemptPhases.includes(attempt.phase)) invalid(`${identity} pending phase ${pending.phase} requires attempt ${attemptPhases.join(' or ')}`);
  if (attempt.mutationStarted !== mutationStarted) invalid(`${identity} ${pending.phase} pending work requires mutationStarted ${String(mutationStarted)}`);
}

function validateAttempt(value: unknown, label: string): LifecycleAttemptRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['id', 'command', 'phase', 'mutationStarted', 'scopeIds', 'journal', 'startedAt', 'updatedAt', 'completedAt'], 'lifecycle attempt');
  requiredString(rec['id'], `${label}.id`);
  const command = oneOf(rec['command'], ['sync', 'retire-source', 'add', 'update', 'remove', 'legacy-recovery'], `${label}.command`);
  oneOf(rec['phase'], ['accepted', 'applying', 'readback', 'pruning', 'finalizing', 'completed', 'failed', 'recovery-required'], `${label}.phase`);
  const mutationStarted = rec['mutationStarted'];
  if (typeof mutationStarted !== 'boolean') invalid(`${label}.mutationStarted must be a boolean`);
  const scopeIds = stringArray(rec['scopeIds'], `${label}.scopeIds`);
  if (scopeIds.length === 0) invalid(`${label}.scopeIds must not be empty`);
  unique(scopeIds, `${label}.scopeIds`);
  const journal = array(rec['journal'], `${label}.journal`).map((item, index) => validateJournal(item, `${label}.journal[${index}]`));
  for (const entry of journal) {
    if (!commandAllowsJournalAction(command, entry.action)) invalid(`${label} command ${command} cannot journal action ${entry.action}`);
  }
  const journalShowsMutation = journal.some(entry => MUTATION_STARTED_JOURNAL_STATES.has(entry.state));
  if (journalShowsMutation && !mutationStarted) invalid(`${label} journal shows mutation began but mutationStarted is false`);
  if (mutationStarted && !journalShowsMutation) invalid(`${label} mutationStarted is true but no journal row shows mutation began`);
  optionalTimestamp(rec['startedAt'], `${label}.startedAt`);
  optionalTimestamp(rec['updatedAt'], `${label}.updatedAt`);
  optionalTimestamp(rec['completedAt'], `${label}.completedAt`);
  if (rec['phase'] === 'completed' && rec['completedAt'] === undefined) invalid(`${label} completed attempt requires completedAt`);
  return value as LifecycleAttemptRecord;
}

function validateJournal(value: unknown, label: string): JournalEntryRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['operationId', 'scopeId', 'packageId', 'nativeId', 'action', 'state', 'route', 'startedAt', 'updatedAt'], 'journal entry');
  requiredString(rec['operationId'], `${label}.operationId`);
  requiredString(rec['scopeId'], `${label}.scopeId`);
  optionalString(rec['packageId'], `${label}.packageId`);
  optionalString(rec['nativeId'], `${label}.nativeId`);
  oneOf(rec['action'], JOURNAL_ACTIONS, `${label}.action`);
  oneOf(rec['state'], ['pending', 'applying', 'applied', 'readback-verified', 'rollback', 'rolled-back', 'cleanup-pending', 'completed', 'failed', 'not-attempted'], `${label}.state`);
  if (rec['route'] !== undefined) validateRoute(rec['route'], `${label}.route`);
  optionalTimestamp(rec['startedAt'], `${label}.startedAt`);
  optionalTimestamp(rec['updatedAt'], `${label}.updatedAt`);
  return value as JournalEntryRecord;
}

function commandAllowsJournalAction(command: LifecycleAttemptRecord['command'], action: JournalAction): boolean {
  switch (command) {
    case 'sync':
      return action !== 'remove';
    case 'retire-source':
      return action === 'retire-orphan';
    case 'add':
    case 'update':
      return action === 'install'
        || action === 'update'
        || action === 'unchanged'
        || action === 'route-migrate'
        || action === 'retain-prior'
        || action === 'disable-nonconforming';
    case 'remove':
      return action === 'remove';
    case 'legacy-recovery':
      return true;
  }
}

function validateTombstone(value: unknown, label: string): TombstoneRecord {
  const rec = asObject(value, label);
  exactFields(rec, ['id', 'scopeId', 'packageId', 'nativeId', 'sourceRelativeDir', 'sourceRevision', 'route', 'ownership', 'fingerprints', 'pins', 'retentionState', 'activatedAt', 'retiredAt'], 'tombstone');
  requiredString(rec['id'], `${label}.id`);
  requiredString(rec['scopeId'], `${label}.scopeId`);
  requiredString(rec['packageId'], `${label}.packageId`);
  requiredString(rec['nativeId'], `${label}.nativeId`);
  if (rec['sourceRelativeDir'] !== undefined) relativePath(rec['sourceRelativeDir'], `${label}.sourceRelativeDir`);
  requiredString(rec['sourceRevision'], `${label}.sourceRevision`);
  const route = validateRoute(rec['route'], `${label}.route`);
  const ownershipObject = asObject(rec['ownership'], `${label}.ownership`);
  if (ownershipObject['kind'] === 'legacy-claim') invalid('tombstone ownership must be revalidated before retirement');
  const ownership = validateOwnership(ownershipObject, `${label}.ownership`);
  const fingerprints = validateFingerprints(rec['fingerprints'], `${label}.fingerprints`);
  const pins = stringArray(rec['pins'], `${label}.pins`);
  sortedUniqueRequired(pins, `${label}.pins`, true);
  if (rec['retentionState'] !== 'plugin-state-retained') invalid(`${label}.retentionState must be plugin-state-retained`);
  optionalTimestamp(rec['activatedAt'], `${label}.activatedAt`);
  timestamp(rec['retiredAt'], `${label}.retiredAt`);
  if (route.kind === 'legacy-unverified' || ownership.kind === 'legacy-claim') invalid('tombstone ownership must be revalidated before retirement');
  if (fingerprints.source === undefined || fingerprints.projected === undefined || fingerprints.installed === undefined) invalid(`${label} requires source, projected, and installed fingerprints`);
  return value as TombstoneRecord;
}

function legacySourceBinding(source: string): PersistedSourceBinding {
  if (isLegacyGitSource(source)) {
    const fragment = source.indexOf('#');
    const binding: PersistedSourceBinding = fragment === -1
      ? { kind: 'git', locator: source, ref: 'HEAD' }
      : { kind: 'git', locator: source.slice(0, fragment), ref: source.slice(fragment + 1) };
    validateCanonicalSourceBinding(binding, 'legacy source');
    return binding;
  }
  if (!isAbsolute(source)) invalid(`legacy local source must be an absolute path: ${source}`);
  const binding: PersistedSourceBinding = { kind: 'local', locator: source };
  validateCanonicalSourceBinding(binding, 'legacy source');
  return binding;
}

function validateCanonicalSourceBinding(source: PersistedSourceBinding, label: string): void {
  try {
    validateSourceBinding(source);
  } catch (error) {
    invalid(`${label}: ${(error as Error).message}`);
  }
}

function compatibilitySourceUri(source: PersistedSourceBinding): string {
  return source.kind === 'git' && source.ref !== 'HEAD' ? `${source.locator}#${source.ref}` : source.locator;
}

function legacyScopeId(source: PersistedSourceBinding, targetKind: string, instance: string): string {
  return canonicalScopeId(source, { kind: targetKind, instance });
}

function canonicalScopeId(source: PersistedSourceBinding, target: TargetIdentity): string {
  try {
    return createDeploymentScopeIdentity(source, target).id;
  } catch (error) {
    invalid((error as Error).message);
  }
}

function legacyRelativeDir(record: InstallRecord): string | undefined {
  if (record.sourceDir === undefined || !isAbsolute(record.source) || !isAbsolute(record.sourceDir)) return undefined;
  const candidate = relative(record.source, record.sourceDir).replaceAll('\\', '/');
  if (candidate === '') return '.';
  if (candidate === '..' || candidate.startsWith('../') || isAbsolute(candidate)) return undefined;
  return candidate;
}

function digest(value: string): string {
  const hash = new CryptoHasher('sha256');
  hash.update(value);
  return hash.digest('hex').slice(0, 24);
}

function isLegacyGitSource(source: string): boolean {
  return /^(?:https?|ssh|git):\/\//iu.test(source) || /^[^@\s]+@[^:\s]+:.+/u.test(source);
}

function activationKey(activation: Pick<ActivationRecord, 'scopeId' | 'packageId' | 'nativeId'>): string {
  return `${activation.scopeId}\u0000${activation.packageId}\u0000${activation.nativeId}`;
}

function pendingV1(operation: PendingOperation): 'install' | 'remove' {
  return operation === 'retire-orphan' || operation === 'remove' ? 'remove' : 'install';
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find(key => !allowedSet.has(key));
  if (unknown !== undefined) invalid(`unsupported ${label} field '${unknown}'`);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) invalid(`${label} must be a non-empty string`);
}

function stringArray(value: unknown, label: string): string[] {
  const values = array(value, label);
  if (values.some(item => typeof item !== 'string' || item.length === 0)) invalid(`${label} must contain non-empty strings`);
  return values as string[];
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  return stringArray(value, label);
}

function optionalLegacyString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') invalid(`${label} must be a string`);
}

function optionalLegacyPins(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(pin => typeof pin !== 'string' || pin.length === 0)) invalid('pins must be non-empty strings');
  return value as string[];
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(`${label} must be a safe integer >= ${minimum}`);
  return value as number;
}

function oneOf<const T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(`${label} must be one of: ${values.join(', ')}`);
  return value as T;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !validTimestamp(value)) invalid(`${label} must be an ISO-8601 UTC timestamp`);
  return value;
}

function optionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined) timestamp(value, label);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function relativePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (path === '.') return path;
  const segments = path.split('/');
  if (
    path.trim() !== path
    || path.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(path)
    || isAbsolute(path)
    || /^[a-z]:\//iu.test(path)
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) invalid(`${label} must be a canonical Source-relative path`);
  return path;
}

function contentAddress(value: unknown, label: string): string {
  const key = requiredString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(key)) invalid(`${label} must be sha256 followed by 64 lowercase hexadecimal characters`);
  return key;
}

function sortedUniqueRequired(values: string[], label: string, allowEmpty = false): void {
  if (!allowEmpty && values.length === 0) invalid(`${label} must not be empty`);
  const sorted = [...new Set(values)].sort();
  if (sorted.length !== values.length || sorted.some((value, index) => value !== values[index])) invalid(`${label} must be sorted and unique`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function removeUndefined(record: InstallRecord): InstallRecord {
  for (const key of Object.keys(record) as Array<keyof InstallRecord>) if (record[key] === undefined) delete record[key];
  return record;
}

function invalid(message: string): never {
  throw new Error(`Invalid state.json: ${message}`);
}
