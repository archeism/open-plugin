/**
 * The write side of the install ledger (src/state.ts) — `add`, `pin` and
 * `update` write through this; doctor imports only the readers, and a module
 * is evaluated whole, so keeping `writeState` out of src/state.ts keeps
 * writer code out of doctor's import graph (AGENTS.md;
 * test/doctor-imports.test.ts pins it).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { createDeploymentScopeIdentity } from './deployment-scope';
import { stateFile } from './paths';
import { CryptoHasher } from './runtime';
import type { SourceBinding } from './source-reference';
import {
  readLifecycleState,
  validateLegacyInstallRecords,
  validateLifecycleState,
  type ActivationRecord,
  type InstallRecord,
  type LifecycleAttemptRecord,
  type LifecycleStateV2,
} from './state';

export interface LifecycleStateWriteAuthorization {
  /** Callers may persist accepted intent only after command-global preflight. */
  globalPreflight: 'succeeded';
}

export function writeState(records: InstallRecord[], file: string = stateFile()): void {
  const existing = readLifecycleState(file);
  if (existing.sourceVersion === 2) throw new Error('refusing to downgrade state.json version 2 through the legacy writer');
  validateLegacyInstallRecords(records);
  atomicWrite(file, JSON.stringify({ version: 1, installs: records }, null, 2));
}

/**
 * Record one writer install on an existing v2 ledger. The activation stays
 * legacy-unverified, so a writer-only host can join a planner ledger without
 * a lifecycle adapter and without rewriting the document as version 1.
 */
export function withLegacyWriterRecord(state: LifecycleStateV2, record: InstallRecord, binding: SourceBinding): LifecycleStateV2 {
  const source = persistedSource(binding);
  const scope = createDeploymentScopeIdentity(source, { kind: record.host, instance: 'default' });
  const relativeDir = legacyRelativeDir(record);
  const previous = state.activations.find((row) => row.scopeId === scope.id && row.packageId === record.id && row.nativeId === record.id);
  const retiredAttemptId = record.pending === undefined ? previous?.pending?.attemptId : undefined;
  const attemptId = record.pending === undefined ? undefined : legacyAttemptId(scope.id, record.id, record.pending);
  const pins = [...new Set(record.pins ?? [])].sort();
  const createdAt = previous?.createdAt ?? record.installedAt;
  const activation: ActivationRecord = {
    scopeId: scope.id,
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
    ...(attemptId === undefined || record.pending === undefined ? {} : {
      pending: {
        operation: record.pending === 'remove' ? 'remove' : 'install',
        phase: 'applying',
        attemptId,
        ...(record.installedAt === undefined ? {} : { startedAt: record.installedAt }),
      },
    }),
    pins,
    ...(record.installedAt === undefined ? {} : { activatedAt: record.installedAt, updatedAt: record.installedAt }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
  const droppedAttempts = new Set([retiredAttemptId, attemptId].filter((id): id is string => id !== undefined));
  const attempts = state.attempts.filter((attempt) => !droppedAttempts.has(attempt.id));
  if (attemptId !== undefined && record.pending !== undefined) attempts.push(legacyAttempt(attemptId, scope.id, record));
  return {
    ...state,
    stateGeneration: state.stateGeneration + 1,
    scopes: legacyScopes(state, scope.id, source, record.host, attemptId, retiredAttemptId),
    activations: [...state.activations.filter((row) => row !== previous), activation],
    attempts,
  };
}

/**
 * Validate the complete v2 document before creating a temporary file, then
 * atomically replace state.json on its own filesystem.
 */
export function writeLifecycleState(
  state: LifecycleStateV2,
  authorization: LifecycleStateWriteAuthorization,
  file: string = stateFile(),
): void {
  if (authorization.globalPreflight !== 'succeeded') {
    throw new Error('state v2 writes require successful global preflight');
  }
  validateLifecycleState(state);
  const previous = readLifecycleState(file);
  if (previous.sourceVersion === 2 && previous.state.stateGeneration === Number.MAX_SAFE_INTEGER) {
    throw new Error('stateGeneration cannot advance beyond the maximum safe integer');
  }
  const expectedGeneration = previous.sourceVersion === 2 ? previous.state.stateGeneration + 1 : 1;
  if (state.stateGeneration !== expectedGeneration) {
    throw new Error(`stateGeneration must advance from ${previous.state.stateGeneration} to ${expectedGeneration}`);
  }
  atomicWrite(file, JSON.stringify(state, null, 2));
}

function persistedSource(binding: SourceBinding): SourceBinding {
  switch (binding.kind) {
    case 'local':
      return { kind: 'local', locator: binding.locator };
    case 'git':
      return { kind: 'git', locator: binding.locator, ref: binding.ref };
    default: {
      const unreachable: never = binding;
      return unreachable;
    }
  }
}

function legacyRelativeDir(record: InstallRecord): string | undefined {
  if (record.sourceDir === undefined || !isAbsolute(record.source) || !isAbsolute(record.sourceDir)) return undefined;
  const candidate = relative(record.source, record.sourceDir).replaceAll('\\', '/');
  if (candidate === '') return '.';
  if (candidate === '..' || candidate.startsWith('../') || isAbsolute(candidate)) return undefined;
  return candidate;
}

function legacyAttemptId(scopeId: string, nativeId: string, pending: 'install' | 'remove'): string {
  const hash = new CryptoHasher('sha256');
  hash.update(`${scopeId}\u0000${nativeId}\u0000${pending}`);
  return `legacy-attempt-${hash.digest('hex').slice(0, 24)}`;
}

function legacyAttempt(attemptId: string, scopeId: string, record: InstallRecord): LifecycleAttemptRecord {
  const pending = record.pending === 'remove' ? 'remove' : 'install';
  return {
    id: attemptId,
    command: 'legacy-recovery',
    phase: pending === 'remove' ? 'pruning' : 'applying',
    mutationStarted: true,
    scopeIds: [scopeId],
    journal: [{
      operationId: `legacy-operation-${attemptId}`,
      scopeId,
      packageId: record.id,
      nativeId: record.id,
      action: pending,
      state: 'applying',
      route: { kind: 'legacy-unverified' },
      ...(record.installedAt === undefined ? {} : { startedAt: record.installedAt, updatedAt: record.installedAt }),
    }],
    ...(record.installedAt === undefined ? {} : { startedAt: record.installedAt, updatedAt: record.installedAt }),
  };
}

function legacyScopes(
  state: LifecycleStateV2,
  scopeId: string,
  source: SourceBinding,
  host: string,
  attemptId: string | undefined,
  retiredAttemptId: string | undefined,
): LifecycleStateV2['scopes'] {
  const existing = state.scopes.find((scope) => scope.id === scopeId);
  if (existing === undefined) {
    return [...state.scopes, {
      id: scopeId,
      source,
      target: { kind: host, instance: 'default' },
      authority: 'legacy-import',
      lifecycle: 'active',
      selectorMode: 'legacy-unknown',
      ...(attemptId === undefined ? {} : { lastAttemptId: attemptId }),
    }];
  }
  if (existing.authority !== 'legacy-import') return state.scopes;
  const lastAttemptId = attemptId ?? (existing.lastAttemptId === retiredAttemptId ? undefined : existing.lastAttemptId);
  return state.scopes.map((scope) => {
    if (scope.id !== scopeId) return scope;
    if (lastAttemptId === undefined) {
      const rest = { ...scope };
      delete rest.lastAttemptId;
      return rest;
    }
    return { ...scope, lastAttemptId };
  });
}

function atomicWrite(file: string, contents: string): void {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${basename(file)}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temporary, contents);
    (fs as unknown as { renameSync(from: string, to: string): void }).renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
