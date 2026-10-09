/**
 * CLI entrypoint. Verbs: add, doctor, pin, update, list, remove, targets
 * (AGENTS.md verbs list).
 */
import { runDoctor, formatFinding, type DoctorFinding } from './doctor';
import { hosts } from './hosts';
import { cleanupWriters, writers } from './hosts/writers';
import { resolveSource } from './source';
import { findRecord, readLifecycleState, readState, type LifecycleStateV2 } from './state';
import { writeState } from './state-write';
import type { InstallRecord } from './state';
import { runPin } from './pin';
import { runUpdate, type UpdateFinding } from './update';
import { fingerprintInstallation } from './fingerprint';
import type { HostReader } from './host';
import { consumerProfiles, findConsumerProfile, type ConsumerProfile } from './consumer-profiles';
import { CompatibilityError, compatibilityEvidenceId, requireCompatible } from './compatibility';
import {
  createLifecycleReason as reason,
  exitCodeForLifecycleReport,
  LifecycleReportValidationError,
  parseLifecycleReport,
  type LifecycleCommandName,
  type LifecycleOperationOutcome,
  type LifecyclePlanAction,
  type LifecycleReason,
  type LifecycleReasonCode,
  type LifecycleReport,
  type LifecycleSourceSnapshotContext,
  type LifecycleTerminalPhase,
} from './lifecycle-report';
import { serializeLegacyInstallOutcomes } from './legacy-install-outcome';
import { createDeploymentScopeIdentity, type DeploymentScopeIdentity } from './deployment-scope';
import { unknownErrorDiagnostic } from './error-diagnostic';
import packageJson from '../package.json' with { type: 'json' };

const USAGE = `plugnz — install, diagnose and update agent plugins and MCP configs

usage: plugnz <verb> [options]

verbs:
  add <source> [--target <host>…] [--adopt-existing] install a plugin into each host's native store
  doctor [--json]                   dead commands, shadowed entries, stale installs (read-only)
  pin [--target <host>] [--all]     rewrite bare commands to absolute paths for GUI hosts
                                    (default targets: the GUI hosts; --all for every host)
  update [name] [--dry-run]         idempotent re-add from state.json; re-materializes
                                    copy-based hosts and re-applies recorded pins
  list                              list installed plugins per host
  remove <plugin>                   remove an installed plugin
  targets [--all]                   list detected agent hosts; --all includes frozen consumer profiles

mutation output:
  --json                            schema-v1 lifecycle report
  --legacy-json                     one-release InstallOutcome[] compatibility output
`;

/** Flags shared by `pin` and `update`. */
interface VerbFlags {
  positionals: string[];
  targets: string[];
  plugins: string[];
  all: boolean;
  dryRun: boolean;
  adoptExisting: boolean;
  errors: string[];
}

function parseFlags(args: string[]): VerbFlags {
  const flags: VerbFlags = { positionals: [], targets: [], plugins: [], all: false, dryRun: false, adoptExisting: false, errors: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target' || arg === '-t') {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith('-')) {
        flags.targets.push(value);
        i++;
      } else flags.errors.push(`${arg} requires a value`);
    } else if (arg === '--plugin') {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith('-')) {
        flags.plugins.push(value);
        i++;
      } else flags.errors.push('--plugin requires a value');
    } else if (arg === '--all') {
      flags.all = true;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--adopt-existing') {
      flags.adoptExisting = true;
    } else if (arg !== undefined && arg.startsWith('-')) {
      flags.errors.push(`unknown option '${arg}'`);
    } else if (arg !== undefined) {
      flags.positionals.push(arg);
    }
  }
  return flags;
}

function selectPlugins<T extends { name: string }>(plugins: readonly T[], requested: readonly string[]): { selected: T[]; error?: string } {
  const duplicate = requested.find((name, index) => requested.indexOf(name) !== index);
  if (duplicate !== undefined) return { selected: [], error: `duplicate plugin selector '${duplicate}'` };
  const known = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  for (const name of requested) if (!known.has(name)) return { selected: [], error: `unknown plugin '${name}' (available: ${[...known.keys()].join(', ')})` };
  return { selected: requested.length === 0 ? [...plugins] : requested.map((name) => known.get(name)!) };
}

function rejectDisallowed(flags: VerbFlags, allowed: ReadonlySet<'target' | 'plugin' | 'all' | 'dryRun' | 'adoptExisting'>): string | undefined {
  if (flags.errors.length > 0) return flags.errors.join('; ');
  if (flags.targets.length > 0 && !allowed.has('target')) return '--target is not supported by this verb';
  if (flags.plugins.length > 0 && !allowed.has('plugin')) return '--plugin is only supported by add';
  if (flags.all && !allowed.has('all')) return '--all is not supported by this verb';
  if (flags.dryRun && !allowed.has('dryRun')) return '--dry-run is not supported by this verb';
  if (flags.adoptExisting && !allowed.has('adoptExisting')) return '--adopt-existing is only supported by add';
  return undefined;
}

/** Findings print the same way doctor's do: `<host>  <mark>  <message>`. */
function printFindings(findings: readonly DoctorFinding[], json: boolean): void {
  if (json) console.log(JSON.stringify(findings, null, 2));
  else for (const f of findings) console.log(formatFinding(f));
}

function printReadSelectionErrors(targets: readonly string[], diagnostic: string, json: boolean): void {
  const rows = targets.map((target) => ({ plugin: '*', target, status: 'failed', dryRun: false, diagnostic }));
  if (json) console.log(JSON.stringify(rows, null, 2));
  else console.error(diagnostic);
}

type MutationOutputMode = 'human' | 'json' | 'legacy-json';

interface ReportOptions {
  terminalPhase?: LifecycleTerminalPhase;
  mutationStarted?: boolean;
  reason?: LifecycleReason | null;
  result?: LifecycleReport['summary']['result'];
  sourceSnapshots?: readonly LifecycleSourceSnapshotContext[];
}

function outcome(input: {
  command: LifecycleCommandName;
  scope: DeploymentScopeIdentity;
  sourceSnapshotId?: string | null;
  package: string;
  action: LifecyclePlanAction;
  result: LifecycleOperationOutcome['result'];
  changed: boolean;
  reason?: LifecycleReason | null;
  nativeId?: string | null;
  route?: LifecycleOperationOutcome['route'];
  coverage?: LifecycleOperationOutcome['coverage'];
  resourceState?: LifecycleOperationOutcome['resourceState'];
  activationState?: LifecycleOperationOutcome['activationState'];
  discriminator?: string;
}): LifecycleOperationOutcome {
  const coverage = input.coverage ?? (input.command === 'remove' || input.command === 'retire-source' ? 'retirement' : 'desired-pair');
  const operationId = [input.command, coverage, input.scope.id, input.package, input.discriminator]
    .filter((part): part is string => part !== undefined)
    .map(encodeURIComponent)
    .join(':');
  const successfulRemoval = input.result === 'succeeded' && coverage === 'retirement';
  const successfulDesired = input.result === 'succeeded' && coverage === 'desired-pair';
  return {
    operationId,
    coverage,
    scope: input.scope,
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    package: input.package,
    nativeId: input.nativeId ?? null,
    action: input.action,
    route: input.route ?? (input.result === 'not-attempted' ? 'none' : 'managed'),
    result: input.result,
    resourceState: input.resourceState ?? (successfulRemoval ? 'absent' : successfulDesired ? 'present' : 'unknown'),
    activationState: input.activationState ?? (successfulRemoval ? 'inactive' : successfulDesired ? 'active-conforming' : 'unknown'),
    changed: input.changed,
    reason: input.reason ?? null,
  };
}

class LifecycleCommandError extends Error {
  constructor(readonly lifecycleReason: LifecycleReason) {
    super(lifecycleReason.diagnostic);
    this.name = 'LifecycleCommandError';
  }
}

function reasonForError(error: unknown): LifecycleReason {
  if (error instanceof LifecycleCommandError) return error.lifecycleReason;
  if (error instanceof LifecycleReportValidationError) return error.reason;
  if (error instanceof CompatibilityError) {
    return reason(
      'capability',
      error.status === 'unsupported' ? 'capability.unsupported' : 'capability.unverified',
      error.message,
      error.capability,
      compatibilityEvidenceId(error.evidence),
    );
  }
  return reason('internal', 'internal.defect', unknownErrorDiagnostic(error));
}

function printDetectionDefect(
  command: LifecycleCommandName,
  dryRun: boolean,
  error: unknown,
  mode: MutationOutputMode,
  sourceSnapshots: readonly LifecycleSourceSnapshotContext[] = [],
): number {
  const failure = reason('internal', 'internal.defect', unknownErrorDiagnostic(error));
  const report = reportFor(command, dryRun, [], {
    terminalPhase: 'preflight',
    mutationStarted: false,
    reason: failure,
    sourceSnapshots,
  });
  printReport(report, mode);
  return exitCodeForLifecycleReport(report);
}

function reportScopeForActivation(state: LifecycleStateV2, target: string, nativeId: string): DeploymentScopeIdentity | undefined {
  const activation = state.activations.find((candidate) => candidate.nativeId === nativeId &&
    state.scopes.some((scope) => scope.id === candidate.scopeId && scope.target.kind === target));
  if (activation === undefined) return undefined;
  const stored = state.scopes.find((scope) => scope.id === activation.scopeId);
  if (stored === undefined) return undefined;
  return createDeploymentScopeIdentity(stored.source, { kind: stored.target.kind, instance: stored.target.instance });
}

function reportFor(command: LifecycleCommandName, dryRun: boolean, outcomes: readonly LifecycleOperationOutcome[], options: ReportOptions = {}): LifecycleReport {
  const failure = options.reason ?? outcomes.find((candidate) => candidate.result !== 'succeeded')?.reason ?? null;
  const result = options.result ?? (failure === null && outcomes.every((candidate) => candidate.result === 'succeeded') ? 'converged' : 'incomplete');
  const plan = outcomes.map(({ result: _result, resourceState: _resourceState, activationState: _activationState, changed: _changed, reason: _reason, ...operation }) => operation);
  return parseLifecycleReport({
    schemaVersion: 1,
    command: { name: command, dryRun, sourceSnapshots: [...(options.sourceSnapshots ?? [])] },
    plan,
    outcomes: [...outcomes],
    summary: {
      result,
      terminalPhase: options.terminalPhase ?? (result === 'converged' ? 'complete' : 'apply'),
      mutationStarted: options.mutationStarted ?? (!dryRun && outcomes.some((candidate) => candidate.route !== 'none' && candidate.result !== 'not-attempted')),
      changed: outcomes.some((candidate) => candidate.changed),
      failureCategory: failure?.category ?? null,
      reason: failure,
      recoveryId: null,
      readbackId: null,
    },
  });
}

function usageReport(command: LifecycleCommandName, dryRun: boolean, diagnostic: string, code: Extract<LifecycleReasonCode, `usage.${string}`> = 'usage.invalid-argument'): LifecycleReport {
  const failure = reason('usage', code, diagnostic);
  return reportFor(command, dryRun, [], { result: 'usage-error', terminalPhase: 'parse', mutationStarted: false, reason: failure });
}

function printReport(report: LifecycleReport, mode: MutationOutputMode): void {
  if (mode === 'json') console.log(JSON.stringify(report, null, 2));
  else if (mode === 'legacy-json') console.log(JSON.stringify(serializeLegacyInstallOutcomes(report), null, 2));
  else {
    if (report.outcomes.length === 0 && report.summary.reason !== null) {
      console.error(report.summary.reason.diagnostic);
      return;
    }
    const legacy = serializeLegacyInstallOutcomes(report);
    for (const item of legacy) console.log(`${item.target}\t${item.status}\t${item.plugin}${item.diagnostic ? `\t${item.diagnostic}` : ''}`);
  }
}

function select<T extends HostReader>(available: readonly T[], targets: readonly string[]): { selected: T[]; error?: string } {
  const known = new Map(available.map((host) => [host.id, host]));
  const duplicate = targets.find((target, index) => targets.indexOf(target) !== index);
  if (duplicate !== undefined) return { selected: [], error: `duplicate target '${duplicate}'` };
  for (const target of targets) if (!known.has(target)) return { selected: [], error: `unknown target '${target}' (known: ${[...known.keys()].join(', ')})` };
  const selected = targets.length === 0 ? [...available] : targets.map((target) => known.get(target)!);
  const absent = selected.find((host) => !host.detect());
  if (absent !== undefined && targets.length > 0) return { selected: [], error: `requested target '${absent.id}' is not present on this machine` };
  return { selected: selected.filter((host) => host.detect()) };
}

function selectProfiles(targets: readonly string[]): { selected: ConsumerProfile[]; error?: string } {
  const duplicate = targets.find((target, index) => targets.indexOf(target) !== index);
  if (duplicate !== undefined) return { selected: [], error: `duplicate target '${duplicate}'` };
  const selected = targets.length === 0
    ? writers.filter((writer) => writer.detect()).map((writer) => findConsumerProfile(writer.id)!).filter((profile): profile is ConsumerProfile => profile !== undefined)
    : targets.map(findConsumerProfile);
  const unknownIndex = selected.findIndex((profile) => profile === undefined);
  if (unknownIndex !== -1) return { selected: [], error: `unknown target '${targets[unknownIndex]}' (known: ${consumerProfiles.map((profile) => profile.id).join(', ')})` };
  return { selected: selected as ConsumerProfile[] };
}

function compatibilityOutcomes(
  profiles: readonly ConsumerProfile[],
  plugins: readonly string[],
  action: 'install' | 'update',
  source: LifecycleSourceSnapshotContext['reference']['binding'],
  sourceSnapshotId: string | null,
): LifecycleOperationOutcome[] | undefined {
  const refusals = new Map<string, CompatibilityError>();
  for (const profile of profiles) {
    try { requireCompatible(profile, action); }
    catch (error) { if (error instanceof CompatibilityError) refusals.set(profile.id, error); else throw error; }
  }
  if (refusals.size === 0) return undefined;
  const blocked = reason('runtime', 'runtime.operation-failed', 'not attempted because another selected target could not be admitted');
  return profiles.flatMap((profile) => plugins.map((plugin) => {
    const refusal = refusals.get(profile.id);
    const refusalReason = refusal === undefined ? blocked : reason(
      'capability',
      refusal.status === 'unsupported' ? 'capability.unsupported' : 'capability.unverified',
      refusal.message,
      refusal.capability,
      refusal.evidence,
    );
    return outcome({
      command: action === 'install' ? 'add' : 'update',
      scope: createDeploymentScopeIdentity(source, { kind: profile.id, instance: 'default' }),
      sourceSnapshotId,
      package: plugin,
      action,
      result: refusal === undefined ? 'not-attempted' : 'failed',
      changed: false,
      route: 'none',
      reason: refusalReason,
    });
  }));
}

async function withLogsOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try { return await fn(); } finally { console.log = original; }
}

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

export async function main(argv: string[]): Promise<number> {
  const wantsJson = argv.includes('--json');
  const wantsLegacyJson = argv.includes('--legacy-json');
  const args = argv.filter((a) => a !== '--json' && a !== '--legacy-json');
  const json = wantsJson || wantsLegacyJson;
  const verb = args[0];
  const mutationVerb = verb === 'add' || verb === 'update' || verb === 'remove';
  const mutationOutput: MutationOutputMode = wantsLegacyJson ? 'legacy-json' : wantsJson ? 'json' : 'human';

  if (wantsJson && wantsLegacyJson) {
    if (mutationVerb) {
      const report = usageReport(verb, false, '--json and --legacy-json are mutually exclusive');
      printReport(report, 'json');
      return exitCodeForLifecycleReport(report);
    }
    fail('plugnz: --json and --legacy-json are mutually exclusive', 2);
  }
  if (wantsLegacyJson && !mutationVerb) fail('plugnz: --legacy-json is only supported by add, update, and remove', 2);

  if (verb === '--version' || verb === '-v' || verb === 'version') {
    if (args.length > 1) fail('plugnz version: unexpected argument', 2);
    console.log(json ? JSON.stringify({ name: 'plugnz', version: packageJson.version }) : packageJson.version);
    return 0;
  }

  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') {
    console.log(USAGE);
    return verb === undefined ? 2 : 0;
  }
  if (verb === 'doctor') {
    const flags = parseFlags(args.slice(1));
    if (rejectDisallowed(flags, new Set(['target'])) || flags.positionals.length > 0) fail(`plugnz doctor: unexpected argument`, 2);
    const selection = select(hosts, flags.targets);
    if (selection.error) {
      printReadSelectionErrors(flags.targets, selection.error, json);
      return 2;
    }
    const { findings, exitCode } = runDoctor(selection.selected);
    if (json) console.log(JSON.stringify(findings, null, 2));
    else for (const f of findings) console.log(formatFinding(f));
    return exitCode;
  }
  
  if (verb === 'targets') {
    const flags = parseFlags(args.slice(1));
    const disallowed = rejectDisallowed(flags, new Set(['all']));
    if (disallowed || flags.positionals.length > 0) fail(`plugnz targets: ${disallowed ?? 'unexpected argument'}`, 2);
    const present = hosts.filter(h => h.detect());
    if (json) {
      console.log(JSON.stringify(flags.all ? consumerProfiles : present.map(h => h.id), null, 2));
    } else {
      for (const h of flags.all ? consumerProfiles : present) console.log(h.id);
    }
    return 0;
  }
  if (verb === 'list') {
    const flags = parseFlags(args.slice(1));
    if (rejectDisallowed(flags, new Set(['target'])) || flags.positionals.length > 0) fail(`plugnz list: unexpected argument`, 2);
    const selection = select(hosts, flags.targets);
    if (selection.error) {
      printReadSelectionErrors(flags.targets, selection.error, json);
      return 2;
    }
    const state = readState();
    const all: any[] = [];
    for (const h of selection.selected) {
      const installed = h.listInstalled();
      const pending = state.filter((record) => record.host === h.id && record.pending !== undefined)
        .map((record) => ({ id: record.id, action: record.pending }));
      if (json) {
        all.push({ host: h.id, plugins: installed, ...(pending.length > 0 ? { pending } : {}) });
      } else {
        for (const p of installed) {
          console.log(`${h.id}\t${p.id}\t${p.version || p.sha || 'unknown'}`);
        }
        for (const record of pending) console.log(`${h.id}\t${record.id}\tpending:${record.action}`);
      }
    }
    if (json) console.log(JSON.stringify(all, null, 2));
    return 0;
  }
  if (verb === 'remove') {
    const flags = parseFlags(args.slice(1));
    const target = flags.positionals[0];
    const disallowed = rejectDisallowed(flags, new Set(['target', 'dryRun']));
    if (disallowed || !target || flags.positionals.length > 1) {
      const report = usageReport('remove', flags.dryRun, disallowed ?? 'missing or unexpected plugin id');
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    let selection: { selected: (typeof cleanupWriters)[number][]; error?: string };
    try {
      selection = select(cleanupWriters, flags.targets);
    } catch (error) {
      return printDetectionDefect('remove', flags.dryRun, error, mutationOutput);
    }
    if (selection.error) {
      const report = usageReport('remove', flags.dryRun, selection.error, 'usage.invalid-selection');
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    if (selection.selected.length === 0) {
      const failure = reason('runtime', 'runtime.operation-failed', 'No detected writer targets');
      const report = reportFor('remove', flags.dryRun, [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    let state: InstallRecord[];
    let lifecycleState: LifecycleStateV2;
    try {
      state = readState();
      lifecycleState = readLifecycleState().state;
    }
    catch (error) {
      const failure = reason('internal', 'internal.corrupt-state', unknownErrorDiagnostic(error));
      const report = reportFor('remove', flags.dryRun, [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    const outcomes: LifecycleOperationOutcome[] = [];
    let commandFailure: LifecycleReason | null = null;
    let commandTerminalPhase: LifecycleTerminalPhase | undefined;
    for (const w of selection.selected) {
      const record = findRecord(state, w.id, target);
      if (record === undefined) {
        commandFailure ??= reason('internal', 'internal.ambiguous-ownership', `no owned install record for '${target}' on ${w.id}; refusing removal`);
        commandTerminalPhase ??= 'preflight';
        continue;
      }
      const scope = reportScopeForActivation(lifecycleState, w.id, record.id);
      if (scope === undefined) {
        commandFailure ??= reason('internal', 'internal.invariant', `install record '${record.id}' on ${w.id} has no deployment scope identity`);
        commandTerminalPhase ??= 'preflight';
        continue;
      }
      const owned = record !== undefined && (record.ownership === 'plgnz' || record.ownership === undefined);
      if (!owned || record?.pending === 'install') {
        const failure = record.pending === 'install'
          ? reason('internal', 'internal.invariant', 'install is pending; refusing removal')
          : reason('internal', 'internal.ambiguous-ownership', 'install ownership is not proven; refusing removal');
        outcomes.push(outcome({ command: 'remove', scope, package: target, nativeId: record.id, action: 'retire-orphan', result: 'failed', changed: false, route: 'none', reason: failure }));
        commandTerminalPhase ??= 'preflight';
        continue;
      }
      if (flags.dryRun) {
        outcomes.push(outcome({ command: 'remove', scope, package: target, nativeId: record.id, action: 'retire-orphan', result: 'succeeded', changed: false }));
        continue;
      }
      let pairMutationStarted = false;
      let pairChanged = false;
      let pairTerminalPhase: LifecycleTerminalPhase = 'apply';
      try {
        const pending = { ...record, pending: 'remove' as const };
        const pendingState = state.map((candidate) => candidate === record ? pending : candidate);
        writeState(pendingState);
        pairMutationStarted = true;
        state = pendingState;
        if (json) await withLogsOnStderr(() => w.remove(target));
        else await w.remove(target);
        pairChanged = true;
        const finalized = state.filter((candidate) => candidate !== pending);
        pairTerminalPhase = 'finalize';
        writeState(finalized);
        state = finalized;
        outcomes.push(outcome({ command: 'remove', scope, package: target, nativeId: record.id, action: 'retire-orphan', result: 'succeeded', changed: true }));
      } catch (error) {
        commandTerminalPhase ??= pairTerminalPhase;
        const failure = reason('runtime', 'runtime.operation-failed', unknownErrorDiagnostic(error));
        outcomes.push(outcome({
          command: 'remove',
          scope,
          package: target,
          nativeId: record.id,
          action: 'retire-orphan',
          result: pairMutationStarted ? 'failed' : 'not-attempted',
          changed: pairChanged,
          route: pairMutationStarted ? 'managed' : 'none',
          resourceState: pairMutationStarted ? 'potentially-changed' : 'unknown',
          reason: failure,
        }));
      }
    }
    const report = reportFor('remove', flags.dryRun, outcomes, { terminalPhase: commandTerminalPhase, reason: commandFailure });
    printReport(report, mutationOutput);
    return exitCodeForLifecycleReport(report);
  }
  if (verb === 'add') {
    const flags = parseFlags(args.slice(1));
    const outcomes: LifecycleOperationOutcome[] = [];
    let activeScope: DeploymentScopeIdentity | undefined;
    let activePlugin = '*';
    let activePairMutationStarted = false;
    let activePairChanged = false;
    let activeTerminalPhase: LifecycleTerminalPhase = 'apply';
    let mutationStarted = false;
    let sourceSnapshots: LifecycleSourceSnapshotContext[] = [];
    let expected: Array<{ plugin: string; nativeId: string; scope: DeploymentScopeIdentity }> = [];
    const disallowed = rejectDisallowed(flags, new Set(['target', 'plugin', 'dryRun', 'adoptExisting']));
    if (disallowed) {
      const report = usageReport('add', flags.dryRun, disallowed);
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    if (flags.positionals.length > 1) {
      const report = usageReport('add', flags.dryRun, `unexpected argument: ${flags.positionals[1]}`);
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    const sourceArg = flags.positionals[0];
    if (sourceArg === undefined) {
      const report = usageReport('add', flags.dryRun, 'missing source');
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }

    try {
      let profileSelection: ReturnType<typeof selectProfiles>;
      try {
        profileSelection = selectProfiles(flags.targets);
      } catch (error) {
        return printDetectionDefect('add', flags.dryRun, error, mutationOutput);
      }
      if (profileSelection.error) {
        const report = usageReport('add', flags.dryRun, profileSelection.error, 'usage.invalid-selection');
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      if (profileSelection.selected.some((profile) => profile.scope === 'excluded-standalone')) {
        const excluded = profileSelection.selected.find((profile) => profile.scope === 'excluded-standalone')!;
        let failure: LifecycleReason;
        try {
          requireCompatible(excluded, 'install');
          failure = reason('internal', 'internal.invariant', `excluded target '${excluded.id}' was unexpectedly admitted`);
        } catch (error) {
          failure = reasonForError(error);
        }
        const report = reportFor('add', flags.dryRun, [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      let state: InstallRecord[];
      try {
        state = readState();
      } catch (error) {
        const failure = reason('internal', 'internal.corrupt-state', unknownErrorDiagnostic(error));
        const report = reportFor('add', flags.dryRun, [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      let resolved;
      try { resolved = resolveSource(sourceArg); }
      catch (error) {
        const failure = reason('runtime', 'runtime.operation-failed', unknownErrorDiagnostic(error));
        const report = reportFor('add', flags.dryRun, [], { terminalPhase: 'resolve', mutationStarted: false, reason: failure });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      const sourceSnapshotId = 'source-0';
      sourceSnapshots = [{ id: sourceSnapshotId, reference: resolved.snapshot }];
      const pluginSelection = selectPlugins(resolved.plugins, flags.plugins);
      if (pluginSelection.error) {
        const report = usageReport('add', flags.dryRun, pluginSelection.error, 'usage.invalid-selection');
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      const incompatible = compatibilityOutcomes(
        profileSelection.selected,
        pluginSelection.selected.map((plugin) => plugin.name),
        'install',
        resolved.snapshot.binding,
        sourceSnapshotId,
      );
      if (incompatible !== undefined) {
        const report = reportFor('add', flags.dryRun, incompatible, { terminalPhase: 'preflight', mutationStarted: false, sourceSnapshots });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      let selection: { selected: (typeof writers)[number][]; error?: string };
      try {
        selection = flags.targets.length === 0
          ? select(writers, [])
          : select(writers, profileSelection.selected.map((profile) => profile.id));
      } catch (error) {
        return printDetectionDefect('add', flags.dryRun, error, mutationOutput, sourceSnapshots);
      }
      if (selection.error) {
        const report = usageReport('add', flags.dryRun, selection.error, 'usage.invalid-selection');
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      if (selection.selected.length === 0) {
        const failure = reason('runtime', 'runtime.operation-failed', 'No detected writer targets');
        const report = reportFor('add', flags.dryRun, [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure, sourceSnapshots });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      if (flags.adoptExisting && selection.selected.some((writer) => writer.supportsAdoption !== true)) {
        const blocked = reason('runtime', 'runtime.operation-failed', 'not attempted because another selected target does not support adoption');
        const adoptionOutcomes = selection.selected.flatMap((writer) => pluginSelection.selected.map((plugin) => {
          const supported = writer.supportsAdoption === true;
          const diagnostic = `target '${writer.id}' does not support --adopt-existing`;
          return outcome({
            command: 'add',
            scope: createDeploymentScopeIdentity(resolved.snapshot.binding, { kind: writer.id, instance: 'default' }),
            sourceSnapshotId,
            package: plugin.name,
            nativeId: plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name,
            action: 'install',
            result: supported ? 'not-attempted' : 'failed',
            changed: false,
            route: 'none',
            reason: supported ? blocked : reason('capability', 'capability.unsupported', diagnostic, 'adoption', 'writer.supportsAdoption'),
          });
        }));
        const report = reportFor('add', flags.dryRun, adoptionOutcomes, { terminalPhase: 'preflight', mutationStarted: false, sourceSnapshots });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      expected = selection.selected.flatMap((writer) => pluginSelection.selected.map((plugin) => ({
        plugin: plugin.name,
        nativeId: plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name,
        scope: createDeploymentScopeIdentity(resolved.snapshot.binding, { kind: writer.id, instance: 'default' }),
      })));
      activeScope = expected[0]?.scope;
      activePlugin = expected[0]?.plugin ?? '*';
      for (const w of selection.selected) {
        const writerScope = createDeploymentScopeIdentity(resolved.snapshot.binding, { kind: w.id, instance: 'default' });
        activeScope = writerScope;
        for (const plugin of pluginSelection.selected) {
          activePlugin = plugin.name;
          activePairMutationStarted = false;
          activePairChanged = false;
          activeTerminalPhase = 'apply';
          const nativeId = plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name;
          if (flags.dryRun) {
            const writerResult = json
              ? await withLogsOnStderr(() => w.add(plugin, resolved, { dryRun: true, adoptExisting: flags.adoptExisting }))
              : await w.add(plugin, resolved, { dryRun: true, adoptExisting: flags.adoptExisting });
            outcomes.push(outcome({
              command: 'add',
              scope: writerScope,
              sourceSnapshotId,
              package: plugin.name,
              action: writerResult === 'unchanged' ? 'unchanged' : 'install',
              result: 'succeeded',
              changed: false,
              nativeId,
            }));
          } else {
            const expectedIds = new Set([nativeId, plugin.name, `${plugin.name}@${plugin.marketplace ?? 'local'}`]);
            const idx = state.findIndex(r => r.host === w.id && expectedIds.has(r.id));
            const previous = idx !== -1 ? state[idx] : undefined;
            const rec: InstallRecord = {
              ...(previous ?? {
              host: w.id,
              id: nativeId,
              }),
              source: resolved.sourceUri,
              sourceSha: resolved.sha,
              ownership: previous?.ownership ?? 'plgnz',
              pending: 'install',
            };
            const pendingState = idx === -1 ? [...state, rec] : state.map((candidate) => candidate === previous ? rec : candidate);
            try {
              writeState(pendingState);
            } catch (error) {
              throw new LifecycleCommandError(reason('runtime', 'runtime.operation-failed', unknownErrorDiagnostic(error)));
            }
            activePairMutationStarted = true;
            mutationStarted = true;
            state = pendingState;
            let writerResult: void | 'unchanged';
            try {
              writerResult = json
                ? await withLogsOnStderr(() => w.add(plugin, resolved, { dryRun: false, adoptExisting: flags.adoptExisting }))
                : await w.add(plugin, resolved, { dryRun: false, adoptExisting: flags.adoptExisting });
              activePairChanged = writerResult !== 'unchanged';
            } catch (error) {
              if (error instanceof CompatibilityError) throw error;
              throw new LifecycleCommandError(reason('runtime', 'runtime.operation-failed', unknownErrorDiagnostic(error)));
            }
            activeTerminalPhase = 'readback';
            let match;
            let installedFingerprint: string;
            try {
              const installed = w.listInstalled();
              const expectedMarketplace = plugin.marketplace ?? 'local';
              match = installed.find(p => expectedIds.has(p.id) && p.name === plugin.name &&
                (p.marketplace === expectedMarketplace || (expectedMarketplace === 'local' && p.marketplace === undefined)) && p.enabled !== false);
              if (match?.path === undefined) throw new LifecycleCommandError(reason('readback', 'readback.mismatch', `native install readback is missing ${nativeId}`));
              installedFingerprint = fingerprintInstallation(match);
            } catch (error) {
              if (error instanceof LifecycleCommandError) throw error;
              throw new LifecycleCommandError(reason('readback', 'readback.failed', unknownErrorDiagnostic(error)));
            }
            const finalized: InstallRecord = {
              ...rec,
              id: match?.id ?? nativeId,
              source: resolved.sourceUri,
              sourceSha: resolved.sha,
              installedAt: new Date().toISOString(),
              sourceDir: plugin.sourceDir ?? plugin.dir,
              installedFingerprint,
              ...(plugin.contentFingerprint !== undefined ? { fingerprint: plugin.contentFingerprint } : {}),
            };
            delete finalized.pending;
            const finalizedState = state.map((candidate) => candidate === rec ? finalized : candidate);
            activeTerminalPhase = 'finalize';
            try {
              writeState(finalizedState);
            } catch (error) {
              throw new LifecycleCommandError(reason('runtime', 'runtime.operation-failed', unknownErrorDiagnostic(error)));
            }
            state = finalizedState;
            outcomes.push(outcome({
              command: 'add',
              scope: writerScope,
              sourceSnapshotId,
              package: plugin.name,
              action: writerResult === 'unchanged' ? 'unchanged' : 'install',
              result: 'succeeded',
              changed: activePairChanged,
              nativeId: match.id,
            }));
          }
        }
      }
      const report = reportFor('add', flags.dryRun, outcomes, { mutationStarted, sourceSnapshots });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    } catch (error: unknown) {
      const failureReason = reasonForError(error);
      const reported = new Set(outcomes.map((candidate) => `${candidate.package}\u0000${candidate.scope.id}`));
      const failures: LifecycleOperationOutcome[] = [];
      if (expected.length > 0) {
        for (const pair of expected) {
          const key = `${pair.plugin}\u0000${pair.scope.id}`;
          if (reported.has(key)) continue;
          const active = pair.plugin === activePlugin && pair.scope.id === activeScope?.id;
          const attempted = active && (flags.dryRun || activePairMutationStarted);
          failures.push(outcome({
            command: 'add',
            scope: pair.scope,
            sourceSnapshotId: sourceSnapshots[0]?.id ?? null,
            package: pair.plugin,
            nativeId: pair.nativeId,
            action: 'install',
            result: attempted ? 'failed' : 'not-attempted',
            changed: active && activePairChanged,
            route: active && activePairMutationStarted ? 'managed' : 'none',
            resourceState: active && activePairMutationStarted ? 'potentially-changed' : 'unknown',
            reason: active ? failureReason : reason('runtime', 'runtime.operation-failed', 'not attempted after an earlier install failure'),
          }));
        }
      }
      const report = reportFor('add', flags.dryRun, [...outcomes, ...failures], {
        terminalPhase: activeTerminalPhase,
        mutationStarted,
        reason: failureReason,
        sourceSnapshots,
      });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
  }
  if (verb === 'pin') {
    const flags = parseFlags(args.slice(1));
    if (rejectDisallowed(flags, new Set(['target', 'all', 'dryRun'])) || flags.positionals.length > 0) fail(`plugnz pin: unexpected argument: ${flags.positionals[0]}`, 2);
    const known = new Set(writers.map((w) => w.id));
    for (const target of flags.targets) {
      if (!known.has(target)) {
        fail(`plugnz pin: unknown target '${target}' (known: ${[...known].join(', ')})`, 2);
      }
    }
    const candidates = flags.targets.length > 0
      ? writers.filter((writer) => flags.targets.includes(writer.id))
      : flags.all ? [...writers] : writers.filter((writer) => writer.gui);
    const detected = candidates.filter((writer) => writer.detect());
    if (detected.length === 0) {
      console.error('plugnz pin: No detected writer targets');
      return 1;
    }
    const result = await runPin({ targets: flags.targets, all: flags.all, dryRun: flags.dryRun, writers: detected });
    printFindings(result.findings, json);
    return result.exitCode;
  }
  if (verb === 'update') {
    const flags = parseFlags(args.slice(1));
    const disallowed = rejectDisallowed(flags, new Set(['target', 'dryRun']));
    if (disallowed || flags.positionals.length > 1) {
      const report = usageReport('update', flags.dryRun, disallowed ?? `unexpected argument: ${flags.positionals[1]}`);
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    let profileSelection: ReturnType<typeof selectProfiles>;
    try {
      profileSelection = selectProfiles(flags.targets);
    } catch (error) {
      return printDetectionDefect('update', flags.dryRun, error, mutationOutput);
    }
    if (profileSelection.error) {
      const report = usageReport('update', flags.dryRun, profileSelection.error, 'usage.invalid-selection');
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    const incompatibleProfile = profileSelection.selected.find((profile) => {
      try { requireCompatible(profile, 'update'); return false; }
      catch (error) { if (error instanceof CompatibilityError) return true; throw error; }
    });
    if (incompatibleProfile !== undefined) {
      let failure: LifecycleReason;
      try {
        requireCompatible(incompatibleProfile, 'update');
        failure = reason('internal', 'internal.invariant', `incompatible target '${incompatibleProfile.id}' was unexpectedly admitted`);
      } catch (error) {
        failure = reasonForError(error);
      }
      const report = reportFor('update', flags.dryRun, [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    let selection: { selected: (typeof writers)[number][]; error?: string };
    try {
      selection = flags.targets.length === 0
        ? select(writers, [])
        : select(writers, profileSelection.selected.map((profile) => profile.id));
    } catch (error) {
      return printDetectionDefect('update', flags.dryRun, error, mutationOutput);
    }
    if (selection.error) {
      const report = usageReport('update', flags.dryRun, selection.error, 'usage.invalid-selection');
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    if (selection.selected.length === 0) {
      const failure = reason('runtime', 'runtime.operation-failed', 'No detected writer targets');
      const report = reportFor('update', flags.dryRun, [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    let lifecycleState: LifecycleStateV2;
    let updateState: InstallRecord[];
    try {
      lifecycleState = readLifecycleState().state;
      updateState = readState();
    } catch (error) {
      const failure = reason('internal', 'internal.corrupt-state', unknownErrorDiagnostic(error));
      const report = reportFor('update', flags.dryRun, [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    let updateMutationStarted = false;
    let updateCompleted = false;
    try {
      const result = json
        ? await withLogsOnStderr(() => runUpdate(flags.positionals[0], { dryRun: flags.dryRun, state: updateState, writers: selection.selected }))
        : await runUpdate(flags.positionals[0], { dryRun: flags.dryRun, state: updateState, writers: selection.selected });
      updateMutationStarted = result.mutationStarted;
      updateCompleted = true;
      const groups = new Map<string, { scope: DeploymentScopeIdentity; package: string; nativeId: string; findings: UpdateFinding[] }>();
      let commandFailure: LifecycleReason | null = null;
      let commandTerminalPhase: LifecycleTerminalPhase | undefined;
      for (const finding of result.findings) {
        if (finding.package === undefined || finding.nativeId === undefined) {
          if (finding.reasonCode === 'internal.ambiguous-ownership') {
            commandFailure ??= reason('internal', finding.reasonCode, finding.message);
            commandTerminalPhase ??= 'preflight';
          } else if (finding.mark === '✗' || finding.status !== undefined) {
            commandFailure ??= reason('internal', 'internal.invariant', finding.message);
          }
          continue;
        }
        const scope = reportScopeForActivation(lifecycleState, finding.host, finding.nativeId);
        if (scope === undefined) {
          commandFailure ??= reason('internal', 'internal.invariant', `update result for '${finding.nativeId}' on ${finding.host} has no deployment scope identity`);
          continue;
        }
        const key = `${scope.id}\u0000${finding.nativeId}`;
        const group = groups.get(key) ?? { scope, package: finding.package, nativeId: finding.nativeId, findings: [] };
        group.findings.push(finding);
        groups.set(key, group);
      }
      const updateOutcomes = [...groups.values()].map((group) => {
        const failed = group.findings.find((finding) => finding.mark !== '✓' || finding.status !== undefined);
        const capability = failed?.status === 'unsupported' || failed?.status === 'unverified';
        const succeeded = failed === undefined;
        if (!succeeded) commandTerminalPhase ??= failed?.terminalPhase;
        const pairMutationStarted = group.findings.some((finding) => finding.mutationStarted === true);
        const pairChanged = group.findings.some((finding) => finding.changed === true);
        const notAttempted = !succeeded && !capability && !pairMutationStarted;
        const successfulAction = group.findings.find((finding) => finding.action !== undefined)?.action;
        const failure = succeeded ? null : capability
          ? reason(
              'capability',
              failed.status === 'unsupported' ? 'capability.unsupported' : 'capability.unverified',
              failed.message,
              failed.capabilityId ?? 'update',
              failed.evidenceId ?? null,
            )
          : failed.reasonCode === 'readback.failed' || failed.reasonCode === 'readback.mismatch'
            ? reason('readback', failed.reasonCode, failed.message)
            : reason('runtime', 'runtime.operation-failed', failed.message);
        return outcome({
          command: 'update',
          scope: group.scope,
          package: group.package,
          nativeId: group.nativeId,
          action: succeeded ? successfulAction ?? 'unchanged' : 'update',
          result: succeeded ? 'succeeded' : notAttempted ? 'not-attempted' : 'failed',
          changed: pairChanged,
          route: capability || (!succeeded && !pairMutationStarted) ? 'none' : 'managed',
          resourceState: !succeeded && pairMutationStarted ? 'potentially-changed' : !succeeded ? 'unknown' : undefined,
          activationState: !succeeded ? 'unknown' : undefined,
          reason: failure,
        });
      });
      if (result.exitCode !== 0 && commandFailure === null && updateOutcomes.every((candidate) => candidate.result === 'succeeded')) {
        commandFailure = reason('internal', 'internal.invariant', 'update exited nonzero without a failed pair result');
      }
      const report = reportFor('update', flags.dryRun, updateOutcomes, {
        terminalPhase: commandTerminalPhase,
        mutationStarted: result.mutationStarted,
        reason: commandFailure,
      });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    } catch (error) {
      const failure = reasonForError(error);
      const report = reportFor('update', flags.dryRun, [], {
        terminalPhase: updateCompleted ? 'finalize' : 'apply',
        mutationStarted: updateMutationStarted,
        reason: failure,
      });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
  }

  fail(`plugnz: unknown verb '${verb}'\n\n${USAGE}`, 2);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('cli.ts')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
