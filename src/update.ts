/**
 * `plgnz update [name]` — bring installed plugins up to their source.
 *
 * The ledger (`state.json`) is the whole authority here. `update` walks the
 * records *this tool wrote* — never the host stores — and for each one:
 *
 *   1. re-resolves the recorded source (a git source is re-read at its head),
 *   2. re-runs the host's `add` against that source, which is idempotent:
 *      version-addressed stores (claude-code, codex, omp) land in a fresh
 *      slot, and the copy-based stores (kimi, cursor) replace the copy —
 *      re-materializing it rather than keeping the first one,
 *   3. re-applies the pins `pin` recorded, because the fresh copy carries the
 *      source's bare `command` again.
 *
 * A plugin with no record — one another tool installed — is reported, never
 * modified: plgnz has no basis for saying what "up to date" means for it,
 * and a re-add would silently take ownership of someone else's install.
 */
import type { HostWriter, InstalledPlugin } from './host';
import type { Mark } from './doctor';
import { writers as allWriters } from './hosts/writers';
import { resolveSource, type PluginSource } from './source';
import { readState, type InstallRecord } from './state';
import { writeState } from './state-write';
import { fingerprintInstallation } from './fingerprint';
import { CompatibilityError, compatibilityEvidenceId } from './compatibility';
import type { LifecycleActivationState, LifecycleResourceState, LifecycleTerminalPhase } from './lifecycle-report';
import { unknownErrorDiagnostic } from './error-diagnostic';
import { captureNativeIdentity, type NativeIdentitySnapshot } from './native-identity';

export interface UpdateFinding {
  host: string;
  /** Present when the finding belongs to one lifecycle package pair. */
  package?: string;
  nativeId?: string;
  mark: Mark;
  /** A typed adapter refusal keeps its public lifecycle capability status. */
  status?: 'unsupported' | 'unverified';
  /** Exact capability refused by a typed adapter boundary. */
  capabilityId?: string;
  /** Exact evidence reference supplied by a typed adapter boundary. */
  evidenceId?: string | null;
  /** Terminal action reported only by a successfully read-back update. */
  action?: 'update' | 'unchanged';
  /** Stable lifecycle reason when the finding needs more than the runtime default. */
  reasonCode?: 'internal.ambiguous-ownership' | 'readback.failed' | 'readback.mismatch' | 'recovery.required';
  /** Exact phase in which this finding prevented convergence. */
  terminalPhase?: LifecycleTerminalPhase;
  /** Present only after this package's durable mutation boundary was crossed. */
  mutationStarted?: true;
  /** Present only when a native mutation is known to have completed. */
  changed?: true;
  /** Known native resource state when readback completed before ledger finalization failed. */
  resourceState?: LifecycleResourceState;
  /** Known native activation state when readback completed before ledger finalization failed. */
  activationState?: LifecycleActivationState;
  message: string;
}

export interface UpdateResult {
  findings: UpdateFinding[];
  exitCode: number;
  mutationStarted: boolean;
}

export interface UpdateOptions {
  dryRun?: boolean;
  /** Ledger to read/update; defaults to the real `state.json`. */
  state?: InstallRecord[];
  /** Hosts to consider; defaults to the registry. */
  writers?: readonly HostWriter[];
  /** Test seam for ledger persistence failure regressions. */
  writeState?: (records: InstallRecord[]) => void;
  /** Exact preflight-selected records. The full `state` is still preserved on writes. */
  records?: readonly InstallRecord[];
  /** Complete adapter-owned identity frozen by the public command before apply. */
  nativeIdentitySnapshots?: ReadonlyMap<InstallRecord, NativeIdentitySnapshot>;
}

/** The plugin name part of a host-native id (`name@marketplace` or bare name). */
function idName(id: string): string {
  const at = id.indexOf('@');
  return at === -1 ? id : id.slice(0, at);
}

function idOf(plugin: PluginSource): string {
  return plugin.marketplace === undefined ? plugin.name : `${plugin.name}@${plugin.marketplace}`;
}

function findingFor(
  record: InstallRecord,
  details: Omit<UpdateFinding, 'host' | 'package' | 'nativeId' | 'mutationStarted'>,
  mutationStarted = false,
): UpdateFinding {
  return {
    host: record.host,
    package: record.id,
    nativeId: record.id,
    ...details,
    ...(mutationStarted ? { mutationStarted: true as const } : {}),
  };
}

function shortSha(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}

export async function runUpdate(name?: string, options: UpdateOptions = {}): Promise<UpdateResult> {
  const hosts = options.writers ?? allWriters;
  let state = options.state ?? readState();
  const save = options.writeState ?? writeState;
  const prefix = options.dryRun === true ? '[dry-run] ' : '';
  const findings: UpdateFinding[] = [];
  let mutationStarted = false;

  const selectedHosts = new Set(hosts.map((host) => host.id));
  const records = options.records === undefined
    ? state.filter((record) => selectedHosts.has(record.host)).filter((record) => name === undefined || record.id === name || idName(record.id) === name)
    : [...options.records];
  if (name !== undefined && records.length === 0) {
    findings.push({
      host: 'plgnz',
      mark: '✗',
      reasonCode: 'internal.ambiguous-ownership',
      message: `no install record for '${name}' in state.json — not installed by plgnz; refusing to modify it`,
    });
    return { findings, exitCode: 1, mutationStarted };
  }
  if (records.length === 0) {
    findings.push({
      host: 'plgnz',
      mark: '!',
      message: 'nothing to update — state.json has no install records',
    });
    return { findings, exitCode: 0, mutationStarted };
  }

  for (const initialRecord of records) {
    const found = options.records === undefined
      ? state.find((candidate) => candidate.host === initialRecord.host && candidate.id === initialRecord.id)
      : state.find((candidate) => candidate === initialRecord);
    if (found === undefined) continue;
    let record: InstallRecord = found;
    let recordMutationStarted = false;
    const host = hosts.find((w) => w.id === record.host);
    if (host === undefined) {
      findings.push(findingFor(record, {
        mark: '✗',
        terminalPhase: 'preflight',
        message: `unknown host in state.json for '${record.id}' — no host module owns it`,
      }));
      continue;
    }
    let detected: boolean;
    try {
      detected = host.detect();
    } catch (error) {
      findings.push(findingFor(record, {
        mark: '✗',
        terminalPhase: 'preflight',
        message: `host detection for '${record.id}' failed — ${unknownErrorDiagnostic(error)}`,
      }));
      continue;
    }
    if (!detected) {
      findings.push(findingFor(record, {
        mark: '!',
        terminalPhase: 'preflight',
        message: `host not present on this machine — '${record.id}' skipped`,
      }));
      continue;
    }
    if (record.pending === 'remove') {
      findings.push(findingFor(record, { mark: '✗', terminalPhase: 'preflight', message: `removal of '${record.id}' is pending — retry remove before update` }));
      continue;
    }

    let resolved;
    let writerResult: void | 'unchanged';
    let nativeChanged = false;
    try {
      resolved = resolveSource(record.source);
    } catch (e) {
      findings.push(findingFor(record, {
        mark: '✗',
        terminalPhase: 'resolve',
        message: `cannot resolve source of '${record.id}': ${record.source} — ${unknownErrorDiagnostic(e)}`,
      }));
      continue;
    }

    const plugin = resolved.plugins.find((p) => idOf(p) === record.id) ?? resolved.plugins.find((p) => p.name === idName(record.id));
    if (plugin === undefined) {
      findings.push(findingFor(record, {
        mark: '✗',
        terminalPhase: 'resolve',
        message: `source ${record.source} no longer provides '${record.id}' — re-add it by hand`,
      }));
      continue;
    }

    let identity = options.nativeIdentitySnapshots?.get(initialRecord);
    if (identity === undefined) {
      const captured = captureNativeIdentity(host, plugin);
      if (!captured.ok) {
        findings.push(findingFor(record, {
          mark: '✗',
          terminalPhase: 'preflight',
          message: `native identity preflight for '${record.id}' failed — ${unknownErrorDiagnostic(captured.error)}`,
        }));
        continue;
      }
      identity = captured.identity;
    }
    const adapterCanonicalNativeId = identity.nativeId;
    const adapterNativeIds = new Set(identity.equivalentNativeIds);
    const carriedIdentity = options.nativeIdentitySnapshots?.has(initialRecord) === true;
    const canonicalNativeId = carriedIdentity ? adapterCanonicalNativeId : adapterNativeIds.has(record.id) ? adapterCanonicalNativeId : record.id;
    const equivalentNativeIds = carriedIdentity || adapterNativeIds.has(record.id)
      ? adapterNativeIds
      : new Set([record.id]);
    const equivalentRecords = records.filter((candidate) => candidate.host === record.host && equivalentNativeIds.has(candidate.id));
    if (!equivalentNativeIds.has(record.id) || equivalentRecords.length !== 1 || equivalentRecords[0] !== record) {
      findings.push(findingFor({ ...record, id: canonicalNativeId }, {
        mark: '✗',
        reasonCode: 'internal.ambiguous-ownership',
        terminalPhase: 'preflight',
        message: `multiple ${record.host} ledger records match native identity '${canonicalNativeId}'`,
      }));
      continue;
    }
    const persistedRecord = record;
    record = { ...persistedRecord, id: canonicalNativeId };

    try {
      if (options.dryRun !== true) {
        const pending = { ...record, pending: 'install' as const };
        record = pending;
        const next = state.map((candidate) => candidate === persistedRecord ? pending : candidate);
        save(next);
        state = next;
        recordMutationStarted = true;
        mutationStarted = true;
      }
      writerResult = await host.add(plugin, resolved, { dryRun: options.dryRun });
      nativeChanged = options.dryRun !== true && writerResult !== 'unchanged';
    } catch (e) {
      findings.push(findingFor(record, e instanceof CompatibilityError && !recordMutationStarted
        ? {
            mark: e.status === 'unverified' ? '!' : '✗',
            status: e.status,
            capabilityId: e.capability,
            evidenceId: compatibilityEvidenceId(e.evidence),
            terminalPhase: 'preflight',
            message: `re-add of '${record.id}' refused — ${e.message}`,
          }
        : {
            mark: '✗',
            terminalPhase: 'apply',
            ...(recordMutationStarted ? { reasonCode: 'recovery.required' as const } : {}),
            message: recordMutationStarted
              ? `re-add of '${record.id}' refused after pending intent was persisted — ${unknownErrorDiagnostic(e)}`
              : `re-add of '${record.id}' failed — ${unknownErrorDiagnostic(e)}`,
          }, recordMutationStarted));
      if (recordMutationStarted) break;
      continue;
    }
    let pins: { ok: boolean; changePlanned: boolean };
    try {
      pins = await repin(host, record, plugin, options, findings, prefix, recordMutationStarted, nativeChanged);
    } catch (error) {
      findings.push(findingFor(record, {
        mark: '✗',
        terminalPhase: 'finalize',
        ...(recordMutationStarted ? { reasonCode: 'recovery.required' as const } : {}),
        ...(nativeChanged ? { changed: true as const } : {}),
        message: `updated '${record.id}' but pin finalization failed — ${unknownErrorDiagnostic(error)}`,
      }, recordMutationStarted));
      if (recordMutationStarted) break;
      continue;
    }
    if (!pins.ok) {
      if (recordMutationStarted) break;
      continue;
    }

    const action = writerResult === 'unchanged' && !pins.changePlanned ? 'unchanged' : 'update';
    const changed = nativeChanged || (options.dryRun !== true && pins.changePlanned);

    if (options.dryRun === true) {
      findings.push(findingFor(record, { mark: '✓', action, message: `${prefix}${action === 'unchanged' ? 'unchanged' : 'updated'} '${record.id}' from ${record.source} → ${shortSha(resolved.sha)}` }, recordMutationStarted));
      continue;
    }
    let installedFingerprint: string;
    try {
      const installed = host.listInstalled().find((candidate) => candidate.id === record.id);
      if (installed === undefined || installed.enabled === false || installed.path === undefined) {
        findings.push(findingFor(record, {
          mark: '✗',
          reasonCode: 'readback.mismatch',
          terminalPhase: 'readback',
          ...(changed ? { changed: true as const } : {}),
          message: `updated native representation for '${record.id}' is not enabled or has no readable path`,
        }, recordMutationStarted));
        break;
      }
      installedFingerprint = fingerprintInstallation(installed);
    } catch (error) {
      findings.push(findingFor(record, {
        mark: '✗',
        reasonCode: 'readback.failed',
        terminalPhase: 'readback',
        ...(changed ? { changed: true as const } : {}),
        message: `updated native representation for '${record.id}' could not be inspected — ${unknownErrorDiagnostic(error)}`,
      }, recordMutationStarted));
      break;
    }
    const finalized: InstallRecord = {
      ...record,
      sourceSha: resolved.sha,
      installedAt: new Date().toISOString(),
      ownership: record.ownership ?? 'plgnz',
      sourceDir: plugin.sourceDir ?? plugin.dir,
      installedFingerprint,
      ...(plugin.contentFingerprint !== undefined ? { fingerprint: plugin.contentFingerprint } : {}),
    };
    delete finalized.pending;
    const next = state.map((candidate) => candidate === record ? finalized : candidate);
    try {
      save(next);
    } catch (error) {
      findings.push(findingFor(record, {
        mark: '✗',
        reasonCode: 'recovery.required',
        terminalPhase: 'finalize',
        ...(changed ? { changed: true as const } : {}),
        resourceState: 'present',
        activationState: 'active-conforming',
        message: `updated '${record.id}' but could not finalize its ledger record — ${unknownErrorDiagnostic(error)}`,
      }, recordMutationStarted));
      break;
    }
    state = next;
    findings.push(findingFor(record, {
      mark: '✓',
      action,
      ...(changed ? { changed: true as const } : {}),
      message: `${action === 'unchanged' ? 'unchanged' : 'updated'} '${record.id}' from ${record.source} → ${shortSha(resolved.sha)}`,
    }, recordMutationStarted));
  }

  return {
    findings,
    exitCode: findings.some((f) => f.mark === '✗' || f.status === 'unverified') ? 1 : 0,
    mutationStarted,
  };
}

/** Re-apply the pins recorded for this install onto the freshly added copy. */
async function repin(
  host: HostWriter,
  record: InstallRecord,
  plugin: PluginSource,
  options: UpdateOptions,
  findings: UpdateFinding[],
  prefix: string,
  mutationStarted: boolean,
  nativeChanged: boolean,
): Promise<{ ok: boolean; changePlanned: boolean }> {
  const pins = record.pins ?? [];
  if (pins.length === 0) return { ok: true, changePlanned: false };
  let installed: InstalledPlugin | undefined;
  try {
    installed = host.listInstalled().find((p) => p.id === record.id);
  } catch (error) {
    findings.push(findingFor(record, {
      mark: '✗',
      reasonCode: 'readback.failed',
      terminalPhase: 'readback',
      ...(nativeChanged ? { changed: true as const } : {}),
      message: `cannot inspect '${record.id}' before re-applying pins — ${unknownErrorDiagnostic(error)}`,
    }, mutationStarted));
    return { ok: false, changePlanned: false };
  }
  if (installed === undefined) {
    findings.push(findingFor(record, {
      mark: '!',
      reasonCode: 'readback.mismatch',
      terminalPhase: 'readback',
      ...(nativeChanged ? { changed: true as const } : {}),
      message: `cannot re-apply pins for '${record.id}' — not found in the ${host.id} store after the update`,
    }, mutationStarted));
    return { ok: false, changePlanned: false };
  }
  const outcome = await host.pin(installed, { only: pins, dryRun: options.dryRun });
  const changed = nativeChanged || (options.dryRun !== true && outcome.changes.length > 0);
  for (const change of outcome.changes) {
    findings.push(findingFor(record, {
      mark: '✓',
      ...(changed ? { changed: true as const } : {}),
      message: `${prefix}re-pinned '${change.server}': '${change.from}' → ${change.to} (plugin ${plugin.name})`,
    }, mutationStarted));
  }
  for (const refusal of outcome.refusals) {
    findings.push(findingFor(record, {
      mark: '✗',
      terminalPhase: 'finalize',
      ...(mutationStarted ? { reasonCode: 'recovery.required' as const } : {}),
      ...(changed ? { changed: true as const } : {}),
      message:
        `${prefix}failed to re-apply the pin for '${refusal.server}': bare command '${refusal.command}' ` +
        `not found on PATH (plugin ${plugin.name})`,
    }, mutationStarted));
  }
  return { ok: outcome.refusals.length === 0, changePlanned: outcome.changes.length > 0 };
}
