/**
 * `plgnz pin` — make plugin-provided MCP servers launchable from a GUI
 * host.
 *
 * A GUI-launched host (cursor) has no shell PATH, so a bare `command` in a
 * plugin's `mcp.json` may resolve to nothing at launch even though it resolves
 * fine in this shell. Spec §7.2.1 leaves PATH participation client-defined and
 * tells plugins not to depend on it; `pin` is the repair: resolve every *bare*
 * stdio command on this process's PATH right now and write the absolute path
 * into the host's copy of the plugin.
 *
 *   - Default targets are the GUI hosts (`HostReader.gui`); `--all` covers
 *     every host, `--target <host>` picks explicitly.
 *   - Only plugin-provided servers are touched. A host's *user-level* MCP
 *     config is hand-written and stays hand-written — `pin` never edits it.
 *   - A bare command that does not resolve is refused (✗, exit 1) and left
 *     bare: a wrong absolute path would be worse than a bare one.
 *   - What was pinned is recorded in the install ledger (`state.json`), so
 *     `update` can re-apply it after re-adding a copy that restores the
 *     source's bare command. Plugins plgnz did not install have no
 *     record to write to; that is reported (`!`), not invented.
 *
 * The absolute-path form is not one of the two spec §7.2.1 allows in a
 * `command` (a bare name or a `./`-relative path); it is a host-native repair
 * for a client with no shell PATH, and it keeps the field a single executable
 * token, which is what §7.2.1 is protecting.
 */
import type { HostWriter } from './host';
import type { Mark } from './doctor';
import { writers as allWriters } from './hosts/writers';
import { findRecord, readLifecycleState, readState, type InstallRecord, type LifecycleStateV2 } from './state';
import { writeLifecycleState, writeState } from './state-write';
import { fingerprintTree } from './fingerprint';

export interface PinFinding {
  host: string;
  mark: Mark;
  message: string;
}

export interface PinRunResult {
  findings: PinFinding[];
  exitCode: number;
}

export interface PinRunOptions {
  /** Host ids to pin; empty/absent falls back to the GUI hosts (or all with `all`). */
  targets?: readonly string[];
  /** Every host, not just the GUI ones. */
  all?: boolean;
  /** Report changes without writing them (and without touching the ledger). */
  dryRun?: boolean;
  /** Ledger to read/update; defaults to the real `state.json`. */
  state?: InstallRecord[];
  /** Hosts to consider; defaults to the registry. */
  writers?: readonly HostWriter[];
}

/** The hosts `pin` targets when nothing was asked for: the GUI ones. */
export function defaultPinTargets(all: readonly HostWriter[] = allWriters): HostWriter[] {
  return all.filter((w) => w.gui);
}

export async function runPin(options: PinRunOptions = {}): Promise<PinRunResult> {
  const candidates = options.writers ?? allWriters;
  const state = options.state ?? readState();
  const selected = selectTargets(candidates, options);
  const findings: PinFinding[] = [];
  let ledgerChanged = false;

  for (const host of selected) {
    if (!host.detect()) continue;
    for (const plugin of host.listInstalled()) {
      if (plugin.path === undefined) continue;
      const outcome = await host.pin(plugin, { dryRun: options.dryRun });
      const prefix = options.dryRun === true ? '[dry-run] ' : '';
      for (const change of outcome.changes) {
        findings.push({
          host: host.id,
          mark: '✓',
          message: `${prefix}server '${change.server}': pinned '${change.from}' → ${change.to} (plugin ${plugin.id})`,
        });
      }
      for (const refusal of outcome.refusals) {
        findings.push({
          host: host.id,
          mark: '✗',
          message:
            `${prefix}server '${refusal.server}': bare command '${refusal.command}' not found on PATH — not pinned ` +
            `(plugin ${plugin.id})`,
        });
      }
      if (outcome.changes.length === 0) continue;

      const record = findRecord(state, host.id, plugin.id);
      if (record === undefined) {
        findings.push({
          host: host.id,
          mark: '!',
          message:
            `plugin '${plugin.id}' has no record in state.json — pinned, but plgnz did not install it, ` +
            `so update will not restore the pin`,
        });
        continue;
      }
      if (options.dryRun === true) continue;
      const pins = new Set(record.pins ?? []);
      for (const change of outcome.changes) pins.add(change.server);
      const next = [...pins].sort();
      if (next.length !== (record.pins ?? []).length) {
        record.pins = next;
        ledgerChanged = true;
      }
      try {
        record.installedFingerprint = fingerprintTree(plugin.path);
        ledgerChanged = true;
      } catch (error) {
        findings.push({ host: host.id, mark: '✗', message: `plugin '${plugin.id}' was pinned but its installed bytes could not be recorded — ${(error as Error).message}` });
      }
    }
  }

  if (ledgerChanged) persistRecordedPins(state, options.state !== undefined);
  return { findings, exitCode: findings.some((f) => f.mark === '✗') ? 1 : 0 };
}

function persistRecordedPins(records: InstallRecord[], legacyLedger: boolean): void {
  const loaded = legacyLedger ? null : readLifecycleState();
  if (loaded === null || loaded.sourceVersion !== 2) {
    writeState(records);
    return;
  }
  const scopes = new Map(loaded.state.scopes.map((scope) => [scope.id, scope]));
  const next: LifecycleStateV2 = {
    ...loaded.state,
    stateGeneration: loaded.state.stateGeneration + 1,
    activations: loaded.state.activations.map((activation) => {
      const scope = scopes.get(activation.scopeId);
      const record = records.find((candidate) => candidate.host === scope?.target.kind && candidate.id === activation.nativeId);
      if (record === undefined) return activation;
      return {
        ...activation,
        pins: [...(record.pins ?? [])].sort(),
        fingerprints: {
          ...activation.fingerprints,
          ...(record.installedFingerprint === undefined ? {} : { installed: record.installedFingerprint }),
        },
      };
    }),
  };
  writeLifecycleState(next, { globalPreflight: 'succeeded' });
}

function selectTargets(all: readonly HostWriter[], options: PinRunOptions): HostWriter[] {
  const targets = options.targets;
  if (targets !== undefined && targets.length > 0) {
    const wanted = new Set(targets);
    return all.filter((w) => wanted.has(w.id));
  }
  if (options.all === true) return [...all];
  return defaultPinTargets(all);
}
