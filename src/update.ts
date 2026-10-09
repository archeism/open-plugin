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
import { CompatibilityError } from './compatibility';

export interface UpdateFinding {
  host: string;
  mark: Mark;
  /** A typed adapter refusal keeps its public InstallOutcome status. */
  status?: 'unsupported' | 'unverified';
  message: string;
}

export interface UpdateResult {
  findings: UpdateFinding[];
  exitCode: number;
}

export interface UpdateOptions {
  dryRun?: boolean;
  /** Ledger to read/update; defaults to the real `state.json`. */
  state?: InstallRecord[];
  /** Hosts to consider; defaults to the registry. */
  writers?: readonly HostWriter[];
  /** Test seam for ledger persistence failure regressions. */
  writeState?: (records: InstallRecord[]) => void;
}

/** The plugin name part of a host-native id (`name@marketplace` or bare name). */
function idName(id: string): string {
  const at = id.indexOf('@');
  return at === -1 ? id : id.slice(0, at);
}

function idOf(plugin: PluginSource): string {
  return plugin.marketplace === undefined ? plugin.name : `${plugin.name}@${plugin.marketplace}`;
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

  const selectedHosts = new Set(hosts.map((host) => host.id));
  const records = state.filter((record) => selectedHosts.has(record.host)).filter((record) => name === undefined || record.id === name || idName(record.id) === name);
  if (name !== undefined && records.length === 0) {
    findings.push({
      host: 'plgnz',
      mark: '✗',
      message: `no install record for '${name}' in state.json — not installed by plgnz; refusing to modify it`,
    });
    return { findings, exitCode: 1 };
  }
  if (records.length === 0) {
    findings.push({
      host: 'plgnz',
      mark: '!',
      message: 'nothing to update — state.json has no install records',
    });
    return { findings, exitCode: 0 };
  }

  for (const initialRecord of records) {
    const found = state.find((candidate) => candidate.host === initialRecord.host && candidate.id === initialRecord.id);
    if (found === undefined) continue;
    let record: InstallRecord = found;
    const host = hosts.find((w) => w.id === record.host);
    if (host === undefined) {
      findings.push({
        host: record.host,
        mark: '✗',
        message: `unknown host in state.json for '${record.id}' — no host module owns it`,
      });
      continue;
    }
    if (!host.detect()) {
      findings.push({
        host: host.id,
        mark: '!',
        message: `host not present on this machine — '${record.id}' skipped`,
      });
      continue;
    }
    if (record.pending === 'remove') {
      findings.push({ host: host.id, mark: '✗', message: `removal of '${record.id}' is pending — retry remove before update` });
      continue;
    }

    let resolved;
    try {
      resolved = resolveSource(record.source);
    } catch (e) {
      findings.push({
        host: host.id,
        mark: '✗',
        message: `cannot resolve source of '${record.id}': ${record.source} — ${(e as Error).message}`,
      });
      continue;
    }

    const plugin = resolved.plugins.find((p) => idOf(p) === record.id) ?? resolved.plugins.find((p) => p.name === idName(record.id));
    if (plugin === undefined) {
      findings.push({
        host: host.id,
        mark: '✗',
        message: `source ${record.source} no longer provides '${record.id}' — re-add it by hand`,
      });
      continue;
    }

    try {
      if (options.dryRun !== true) {
        const pending = { ...record, pending: 'install' as const };
        const next = state.map((candidate) => candidate === record ? pending : candidate);
        save(next);
        state = next;
        record = pending;
      }
      await host.add(plugin, resolved, { dryRun: options.dryRun });
    } catch (e) {
      findings.push(e instanceof CompatibilityError
        ? { host: host.id, mark: e.status === 'unverified' ? '!' : '✗', status: e.status, message: `re-add of '${record.id}' refused — ${e.message}` }
        : { host: host.id, mark: '✗', message: `re-add of '${record.id}' failed — ${(e as Error).message}` });
      continue;
    }
    let pinsOk: boolean;
    try {
      pinsOk = await repin(host, record, plugin, options, findings, prefix);
    } catch (error) {
      findings.push({ host: host.id, mark: '✗', message: `updated '${record.id}' but pin finalization failed — ${(error as Error).message}` });
      continue;
    }
    if (!pinsOk) continue;

    if (options.dryRun === true) {
      findings.push({ host: host.id, mark: '✓', message: `${prefix}updated '${record.id}' from ${record.source} → ${shortSha(resolved.sha)}` });
      continue;
    }
    try {
      const installed = host.listInstalled().find((candidate) => candidate.id === record.id);
      if (installed === undefined || installed.enabled === false || installed.path === undefined) throw new Error('updated native representation is not enabled or has no readable path');
      const finalized: InstallRecord = {
        ...record,
        sourceSha: resolved.sha,
        installedAt: new Date().toISOString(),
        ownership: record.ownership ?? 'plgnz',
        sourceDir: plugin.sourceDir ?? plugin.dir,
        installedFingerprint: fingerprintInstallation(installed),
        ...(plugin.contentFingerprint !== undefined ? { fingerprint: plugin.contentFingerprint } : {}),
      };
      delete finalized.pending;
      const next = state.map((candidate) => candidate === record ? finalized : candidate);
      save(next);
      state = next;
      findings.push({ host: host.id, mark: '✓', message: `updated '${record.id}' from ${record.source} → ${shortSha(resolved.sha)}` });
    } catch (error) {
      findings.push({ host: host.id, mark: '✗', message: `updated '${record.id}' but could not finalize its ledger record — ${(error as Error).message}` });
    }
  }

  return { findings, exitCode: findings.some((f) => f.mark === '✗' || f.status === 'unverified') ? 1 : 0 };
}

/** Re-apply the pins recorded for this install onto the freshly added copy. */
async function repin(
  host: HostWriter,
  record: InstallRecord,
  plugin: PluginSource,
  options: UpdateOptions,
  findings: UpdateFinding[],
  prefix: string,
): Promise<boolean> {
  const pins = record.pins ?? [];
  if (pins.length === 0) return true;
  const installed: InstalledPlugin | undefined = host.listInstalled().find((p) => p.id === record.id);
  if (installed === undefined) {
    findings.push({
      host: host.id,
      mark: '!',
      message: `cannot re-apply pins for '${record.id}' — not found in the ${host.id} store after the update`,
    });
    return false;
  }
  const outcome = await host.pin(installed, { only: pins, dryRun: options.dryRun });
  for (const change of outcome.changes) {
    findings.push({
      host: host.id,
      mark: '✓',
      message: `${prefix}re-pinned '${change.server}': '${change.from}' → ${change.to} (plugin ${plugin.name})`,
    });
  }
  for (const refusal of outcome.refusals) {
    findings.push({
      host: host.id,
      mark: '✗',
      message:
        `${prefix}failed to re-apply the pin for '${refusal.server}': bare command '${refusal.command}' ` +
        `not found on PATH (plugin ${plugin.name})`,
    });
  }
  return outcome.refusals.length === 0;
}
