import { createDeploymentScopeIdentity, type DeploymentScopeIdentity } from './deployment-scope';
import type { TargetIdentity } from './deployment-scope';
import { targetProfiles } from './hosts';
import { createLifecycleReason, type LifecycleReason } from './lifecycle-report';
import { validateSourceBinding, type SourceBinding } from './source-reference';
import {
  canonicalTargetContextBytes,
  TargetIdentityValidationError,
  type PersistedTargetIdentity,
} from './target-identity';
import { TargetProfileValidationError, type TargetProfile } from './target-profile';

export const SYNC_MANIFEST_SCHEMA_VERSION = 1 as const;

export const SYNC_MANIFEST_TARGET_KINDS = Object.freeze(targetProfiles.map(profile => profile.kind));

export type SyncManifestTargetKind = (typeof targetProfiles)[number]['kind'];

export interface SyncManifestPackageSelector {
  package: string;
  adoptExisting: boolean;
}

export type SyncManifestTarget = PersistedTargetIdentity;
export type SyncManifestTargetIdentity = TargetIdentity;

export interface SyncManifestSyncEntry {
  operation: 'sync';
  source: SourceBinding;
  target: SyncManifestTarget;
  /** Absent selects every package in the frozen Source; present is the complete Desired set. */
  selectors?: SyncManifestPackageSelector[];
}

export interface SyncManifestRetireSourceEntry {
  operation: 'retire-source';
  scopeId: string;
  /** Context is loaded from the recorded scope so retirement cannot be retargeted. */
  target: SyncManifestTargetIdentity;
}

export type SyncManifestEntry = SyncManifestSyncEntry | SyncManifestRetireSourceEntry;

export interface SyncManifest {
  schemaVersion: typeof SYNC_MANIFEST_SCHEMA_VERSION;
  entries: SyncManifestEntry[];
}

export interface SelectedManifestPackage<T> {
  plugin: T;
  adoptionRequested: boolean;
}

type UsageReason = Extract<LifecycleReason, { category: 'usage' }>;

export class SyncManifestValidationError extends Error {
  constructor(readonly reason: UsageReason) {
    super(reason.diagnostic);
    this.name = 'SyncManifestValidationError';
  }
}

/** Parse and canonicalize the versioned, non-mutating batch lifecycle boundary. */
export function parseSyncManifest(value: unknown): SyncManifest {
  const manifest = object(value, 'sync manifest');
  exactFields(manifest, ['schemaVersion', 'entries'], 'sync manifest');
  if (manifest['schemaVersion'] !== SYNC_MANIFEST_SCHEMA_VERSION) invalidArgument('sync manifest schemaVersion must be 1');
  if (!Array.isArray(manifest['entries']) || manifest['entries'].length === 0) invalidArgument('sync manifest entries must be a non-empty array');

  const entries = manifest['entries'].map((entry, index) => parseEntry(entry, index));
  assertUniqueScopes(entries);
  return { schemaVersion: SYNC_MANIFEST_SCHEMA_VERSION, entries };
}

/** Canonical identity shared by manifests, lifecycle reports, and durable state. */
export function deploymentScopeForSyncManifestEntry(entry: SyncManifestSyncEntry): DeploymentScopeIdentity {
  return createDeploymentScopeIdentity(entry.source, { kind: entry.target.kind, instance: entry.target.instance });
}

/** Apply one parsed sync entry to an already frozen Source inventory without I/O. */
export function selectManifestPackages<T extends { name: string }>(
  entry: SyncManifestSyncEntry,
  discovered: readonly T[],
): SelectedManifestPackage<T>[] {
  if (discovered.length === 0) invalidSelection('Source resolved to zero packages; retire the scope explicitly');
  const discoveredNames = new Set<string>();
  for (const plugin of discovered) {
    if (discoveredNames.has(plugin.name)) invalidSelection(`Source resolved duplicate package name '${plugin.name}'`);
    discoveredNames.add(plugin.name);
  }
  if (entry.selectors === undefined) {
    return discovered.map((plugin) => ({ plugin, adoptionRequested: false }));
  }
  const byName = new Map(discovered.map((plugin) => [plugin.name, plugin]));
  return entry.selectors.map((selector) => {
    const plugin = byName.get(selector.package);
    if (plugin === undefined) invalidSelection(`unknown package selector '${selector.package}'`);
    return { plugin, adoptionRequested: selector.adoptExisting };
  });
}

function parseEntry(value: unknown, index: number): SyncManifestEntry {
  const entry = object(value, `sync manifest entry ${index}`);
  if (entry['operation'] === 'sync') {
    exactFields(entry, ['operation', 'source', 'target', 'selectors'], `sync manifest entry ${index}`);
    const source = parseSourceBinding(entry['source'], `sync manifest entry ${index} source`);
    const target = parseTarget(entry['target'], `sync manifest entry ${index} target`);
    if (entry['selectors'] === undefined) return { operation: 'sync', source, target };
    if (!Array.isArray(entry['selectors'])) invalidArgument(`sync manifest entry ${index} selectors must be an array`);
    if (entry['selectors'].length === 0) {
      invalidSelection(`sync manifest entry ${index} selectors must be omitted or contain at least one package; retire the scope explicitly`);
    }
    const selectors = entry['selectors'].map((selector, selectorIndex) => parseSelector(selector, index, selectorIndex));
    const seen = new Set<string>();
    for (const selector of selectors) {
      if (seen.has(selector.package)) invalidSelection(`sync manifest entry ${index} has duplicate package selector '${selector.package}'`);
      seen.add(selector.package);
    }
    return { operation: 'sync', source, target, selectors };
  }
  if (entry['operation'] === 'retire-source') {
    exactFields(entry, ['operation', 'scopeId', 'target'], `sync manifest entry ${index}`);
    if (typeof entry['scopeId'] !== 'string' || !/^scope-v1-[0-9a-f]{64}$/u.test(entry['scopeId'])) {
      invalidArgument(`sync manifest entry ${index} scopeId must be a recorded scope-v1 identifier`);
    }
    return {
      operation: 'retire-source',
      scopeId: entry['scopeId'],
      target: parseRetirementTarget(entry['target'], `sync manifest entry ${index} target`),
    };
  }
  invalidArgument(`sync manifest entry ${index} has an unknown operation`);
}

function parseRetirementTarget(value: unknown, label: string): SyncManifestTargetIdentity {
  const profile = targetProfile(value, label);
  return invokeTargetProfile(() => profile.parseRetirementTarget(value, label));
}

function assertUniqueScopes(entries: readonly SyncManifestEntry[]): void {
  const scopes = new Map<string, { entry: SyncManifestEntry; index: number }>();
  const contexts = new Map<string, { bytes: string; index: number }>();
  const physicalTargets = new Map<string, Array<{
    target: PersistedTargetIdentity;
    physicalKey: string;
    index: number;
  }>>();
  for (const [index, entry] of entries.entries()) {
    const scopeId = entry.operation === 'sync'
      ? deploymentScopeForSyncManifestEntry(entry).id
      : entry.scopeId;
    const previous = scopes.get(scopeId);
    if (previous === undefined) {
      scopes.set(scopeId, { entry, index });
    } else {
      const relation = JSON.stringify(previous.entry) === JSON.stringify(entry) ? 'duplicate' : 'overlapping or contradictory';
      invalidSelection(`sync manifest entries ${previous.index} and ${index} are ${relation} requests for scope '${scopeId}'`);
    }
    if (entry.operation !== 'sync') continue;

    const profile = targetProfileForKind(entry.target.kind, `sync manifest entry ${index} target`);
    const identityKey = JSON.stringify([entry.target.kind, entry.target.instance]);
    const context = invokeTargetProfile(() => profile.canonicalContext(entry.target));
    const contextBytes = canonicalTargetContextBytes(context);
    const priorContext = contexts.get(identityKey);
    if (priorContext !== undefined && priorContext.bytes !== contextBytes) {
      invalidSelection(`sync manifest entries ${priorContext.index} and ${index} bind contradictory contexts to target '${entry.target.kind}/${entry.target.instance}'`);
    }
    if (priorContext === undefined) contexts.set(identityKey, { bytes: contextBytes, index });

    const physicalKey = invokeTargetProfile(() => profile.physicalKey(entry.target));
    const priorPhysicalTargets = physicalTargets.get(profile.kind) ?? [];
    for (const prior of priorPhysicalTargets) {
      if (prior.target.instance === entry.target.instance) continue;
      const overlaps = invokeTargetProfile(() => profile.overlaps(prior.target, entry.target));
      if (prior.physicalKey === physicalKey || overlaps) {
        invalidSelection(`sync manifest entries ${prior.index} and ${index} assign overlapping physical target '${profile.kind}' to instances '${prior.target.instance}' and '${entry.target.instance}'`);
      }
    }
    priorPhysicalTargets.push({ target: entry.target, physicalKey, index });
    physicalTargets.set(profile.kind, priorPhysicalTargets);
  }
}

function parseSourceBinding(value: unknown, label: string): SourceBinding {
  const binding = object(value, label);
  if (binding['kind'] === 'local') {
    exactFields(binding, ['kind', 'locator'], label);
    if (typeof binding['locator'] !== 'string') invalidArgument(`${label} local locator must be a string`);
    const source: SourceBinding = { kind: 'local', locator: binding['locator'] };
    validateBinding(source, label);
    return source;
  }
  if (binding['kind'] === 'git') {
    exactFields(binding, ['kind', 'locator', 'ref'], label);
    if (typeof binding['locator'] !== 'string' || typeof binding['ref'] !== 'string') {
      invalidArgument(`${label} git binding needs string locator and ref fields`);
    }
    const source: SourceBinding = { kind: 'git', locator: binding['locator'], ref: binding['ref'] };
    validateBinding(source, label);
    return source;
  }
  invalidArgument(`${label} kind must be local or git`);
}

function parseTarget(value: unknown, label: string): SyncManifestTarget {
  const profile = targetProfile(value, label);
  return invokeTargetProfile(() => profile.parseSyncTarget(value, label));
}

function parseSelector(value: unknown, entryIndex: number, selectorIndex: number): SyncManifestPackageSelector {
  const label = `sync manifest entry ${entryIndex} selector ${selectorIndex}`;
  const selector = object(value, label);
  exactFields(selector, ['package', 'adoptExisting'], label);
  if (typeof selector['package'] !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/iu.test(selector['package'])) {
    invalidArgument(`${label} package must be a valid package name`);
  }
  if (selector['adoptExisting'] !== undefined && typeof selector['adoptExisting'] !== 'boolean') {
    invalidArgument(`${label} adoptExisting must be a boolean`);
  }
  return { package: selector['package'], adoptExisting: selector['adoptExisting'] === true };
}

function validateBinding(source: SourceBinding, label: string): void {
  try {
    validateSourceBinding(source);
  } catch (error) {
    invalidArgument(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function targetProfile(value: unknown, label: string): TargetProfile {
  const target = object(value, label);
  if (typeof target['kind'] !== 'string') invalidArgument(`${label} kind must be a string`);
  return targetProfileForKind(target['kind'], label);
}

function targetProfileForKind(kind: string, label: string): TargetProfile {
  const profile = targetProfiles.find(candidate => candidate.kind === kind);
  if (profile === undefined) invalidSelection(`${label} kind is not a supported lifecycle target`);
  return profile;
}

function invokeTargetProfile<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof TargetProfileValidationError) {
      if (error.kind === 'invalid-selection') invalidSelection(error.message);
      invalidArgument(error.message);
    }
    if (error instanceof TargetIdentityValidationError) invalidArgument(error.message);
    throw error;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidArgument(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown !== undefined) invalidArgument(`${label} has unsupported field '${unknown}'`);
}

function invalidArgument(diagnostic: string): never {
  throw new SyncManifestValidationError(createLifecycleReason('usage', 'usage.invalid-argument', diagnostic));
}

function invalidSelection(diagnostic: string): never {
  throw new SyncManifestValidationError(createLifecycleReason('usage', 'usage.invalid-selection', diagnostic));
}
