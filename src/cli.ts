/**
 * CLI entrypoint. Verbs: add, doctor, pin, update, list, remove, targets
 * (AGENTS.md verbs list).
 */
import { runDoctor, formatFinding, type DoctorFinding } from './doctor';
import { hosts } from './hosts';
import { cleanupWriters, writers } from './hosts/writers';
import { resolveSource, type PluginSource } from './source';
import { readLifecycleState, readState, type LifecycleStateV2 } from './state';
import { writeState } from './state-write';
import type { InstallRecord } from './state';
import { runPin } from './pin';
import { runUpdate, type UpdateFinding } from './update';
import { fingerprintInstallation } from './fingerprint';
import type { HostReader, HostWriter } from './host';
import { consumerProfiles, findConsumerProfile, type ConsumerProfile } from './consumer-profiles';
import { CompatibilityError, compatibilityEvidenceId, requireCompatible } from './compatibility';
import {
  createLifecycleReason as reason,
  exitCodeForLifecycleReport,
  LifecycleReportValidationError,
  parseLifecycleReport,
  type LifecycleCommandName,
  type LifecycleOperationOutcome,
  type LifecyclePlanOperation,
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
import { captureNativeIdentity, type NativeIdentitySnapshot } from './native-identity';
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
  recoveryId?: string | null;
  readbackId?: string | null;
}

function planOperation(input: {
  command: LifecycleCommandName;
  scope: DeploymentScopeIdentity;
  sourceSnapshotId?: string | null;
  package: string;
  action: LifecyclePlanAction;
  nativeId?: string | null;
  route: LifecycleOperationOutcome['route'];
  coverage?: LifecycleOperationOutcome['coverage'];
  discriminator?: string;
}): LifecyclePlanOperation {
  const coverage = input.coverage ?? (input.command === 'remove' || input.command === 'retire-source' ? 'retirement' : 'desired-pair');
  const operationId = [input.command, coverage, input.scope.id, input.package, input.discriminator]
    .filter((part): part is string => part !== undefined)
    .map(encodeURIComponent)
    .join(':');
  return {
    operationId,
    coverage,
    scope: input.scope,
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    package: input.package,
    nativeId: input.nativeId ?? null,
    action: input.action,
    route: input.route,
  };
}

function outcomeFor(operation: LifecyclePlanOperation, input: {
  result: LifecycleOperationOutcome['result'];
  changed: boolean;
  reason?: LifecycleReason | null;
  resourceState?: LifecycleOperationOutcome['resourceState'];
  activationState?: LifecycleOperationOutcome['activationState'];
}): LifecycleOperationOutcome {
  const successfulRemoval = input.result === 'succeeded' && operation.coverage === 'retirement';
  const successfulDesired = input.result === 'succeeded' && operation.coverage === 'desired-pair';
  return {
    ...operation,
    result: input.result,
    resourceState: input.resourceState ?? (successfulRemoval ? 'absent' : successfulDesired ? 'present' : 'unknown'),
    activationState: input.activationState ?? (successfulRemoval ? 'inactive' : successfulDesired ? 'active-conforming' : 'unknown'),
    changed: input.changed,
    reason: input.reason ?? null,
  };
}

function freezePlan(operations: readonly LifecyclePlanOperation[]): readonly LifecyclePlanOperation[] {
  return Object.freeze(operations.map((operation) => Object.freeze({
    ...operation,
    scope: Object.freeze({
      ...operation.scope,
      source: Object.freeze({ ...operation.scope.source }),
      target: Object.freeze({ ...operation.scope.target }),
    }),
  })));
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
  const report = reportFor(command, dryRun, [], [], {
    terminalPhase: 'preflight',
    mutationStarted: false,
    reason: failure,
    sourceSnapshots,
  });
  printReport(report, mode);
  return exitCodeForLifecycleReport(report);
}

interface ResolvedActivationScope {
  activationIndex: number;
  activation: LifecycleStateV2['activations'][number];
  scope: DeploymentScopeIdentity;
}

function reportScopesForTarget(
  state: LifecycleStateV2,
  target: string,
  instance: string,
): ResolvedActivationScope[] {
  const scopes = new Map(state.scopes.map((scope) => [scope.id, scope]));
  const matches: ResolvedActivationScope[] = [];
  state.activations.forEach((activation, activationIndex) => {
    const stored = scopes.get(activation.scopeId);
    if (stored === undefined || stored.target.kind !== target || stored.target.instance !== instance) return;
    matches.push({
      activationIndex,
      activation,
      scope: createDeploymentScopeIdentity(stored.source, { kind: stored.target.kind, instance: stored.target.instance }),
    });
  });
  return matches;
}

function reportFor(
  command: LifecycleCommandName,
  dryRun: boolean,
  plan: readonly LifecyclePlanOperation[],
  outcomes: readonly LifecycleOperationOutcome[],
  options: ReportOptions = {},
): LifecycleReport {
  const failure = options.reason ?? outcomes.find((candidate) => candidate.result !== 'succeeded')?.reason ?? null;
  const result = options.result ?? (failure === null && outcomes.every((candidate) => candidate.result === 'succeeded') ? 'converged' : 'incomplete');
  const recoveryOutcome = outcomes.find((candidate) => candidate.result === 'pending' || candidate.reason?.category === 'recovery');
  const readbackOutcome = outcomes.find((candidate) =>
    candidate.reason?.category === 'readback' || (!dryRun && candidate.action === 'disable-nonconforming'));
  return parseLifecycleReport({
    schemaVersion: 1,
    command: { name: command, dryRun, sourceSnapshots: [...(options.sourceSnapshots ?? [])] },
    plan: [...plan],
    outcomes: [...outcomes],
    summary: {
      result,
      terminalPhase: options.terminalPhase ?? (result === 'converged' ? 'complete' : 'apply'),
      mutationStarted: options.mutationStarted ?? (!dryRun && outcomes.some((candidate) => candidate.route !== 'none' && candidate.result !== 'not-attempted')),
      changed: outcomes.some((candidate) => candidate.changed),
      failureCategory: failure?.category ?? null,
      reason: failure,
      recoveryId: options.recoveryId ?? recoveryOutcome?.operationId ?? null,
      readbackId: options.readbackId ?? readbackOutcome?.operationId ?? null,
    },
  });
}

interface PreparedNativeIdentity {
  package: string;
  nativeId: string | null;
  legacyNativeIds: readonly string[];
  equivalentNativeIds: ReadonlySet<string>;
  adapterResolved: boolean;
  failure: LifecycleReason | null;
}

function exactPersistedIdentity(record: InstallRecord, packageHint: string): PreparedNativeIdentity {
  return {
    package: packageHint,
    nativeId: record.id,
    legacyNativeIds: Object.freeze([]),
    equivalentNativeIds: new Set([record.id]),
    adapterResolved: false,
    failure: null,
  };
}

function sourceLogicalId(plugin: PluginSource): string {
  return plugin.marketplace === undefined ? plugin.name : `${plugin.name}@${plugin.marketplace}`;
}

function uniquePlugin(matches: readonly PluginSource[]): PluginSource | undefined {
  return matches.length === 1 ? matches[0] : undefined;
}

function pluginForPersistedIdentity(
  plugins: readonly PluginSource[],
  record: InstallRecord,
  packageHint: string,
  sourceRelativeDir?: string,
): PluginSource | undefined {
  if (sourceRelativeDir !== undefined) {
    const byRelativeDir = uniquePlugin(plugins.filter((plugin) => plugin.relativeDir === sourceRelativeDir));
    if (byRelativeDir !== undefined) return byRelativeDir;
  }
  if (record.sourceDir !== undefined) {
    const bySourceDir = uniquePlugin(plugins.filter((plugin) => plugin.sourceDir === record.sourceDir));
    if (bySourceDir !== undefined) return bySourceDir;
  }
  const authoredIds = new Set([packageHint, record.id]);
  const byAuthoredId = uniquePlugin(plugins.filter((plugin) => authoredIds.has(sourceLogicalId(plugin))));
  if (byAuthoredId !== undefined) return byAuthoredId;
  const logicalNames = new Set([logicalNativeName(packageHint), logicalNativeName(record.id)]);
  return uniquePlugin(plugins.filter((plugin) => logicalNames.has(plugin.name)));
}

/** Resolve one persisted row, then capture its adapter-owned identity exactly once. */
function preparedNativeIdentity(
  writer: HostWriter,
  record: InstallRecord,
  packageHint: string,
  sourceRelativeDir?: string,
): PreparedNativeIdentity {
  const exact = exactPersistedIdentity(record, packageHint);
  let resolved;
  try {
    resolved = resolveSource(record.source);
  } catch {
    return exact;
  }
  const plugin = pluginForPersistedIdentity(resolved.plugins, record, packageHint, sourceRelativeDir);
  if (plugin === undefined) return exact;
  const captured = captureNativeIdentity(writer, plugin);
  if (!captured.ok) {
    return {
      package: plugin.name,
      nativeId: captured.nativeId,
      legacyNativeIds: Object.freeze([]),
      equivalentNativeIds: new Set(),
      adapterResolved: false,
      failure: reason('internal', 'internal.defect', unknownErrorDiagnostic(captured.error)),
    };
  }
  const equivalentNativeIds = new Set(captured.identity.equivalentNativeIds);
  if (!equivalentNativeIds.has(record.id)) return exact;
  return {
    package: plugin.name,
    nativeId: captured.identity.nativeId,
    legacyNativeIds: captured.identity.legacyNativeIds,
    equivalentNativeIds,
    adapterResolved: true,
    failure: null,
  };
}

function logicalNativeName(nativeId: string): string {
  return nativeId.includes('@') ? nativeId.slice(0, nativeId.indexOf('@')) : nativeId;
}

function requestedIdentityMatches(identity: PreparedNativeIdentity, persistedId: string, requested: string | undefined): boolean {
  const logicalPersistedId = logicalNativeName(persistedId);
  return requested === undefined || requested === identity.package || requested === identity.nativeId ||
    requested === persistedId || requested === logicalPersistedId || identity.equivalentNativeIds.has(requested);
}

function usageReport(command: LifecycleCommandName, dryRun: boolean, diagnostic: string, code: Extract<LifecycleReasonCode, `usage.${string}`> = 'usage.invalid-argument'): LifecycleReport {
  const failure = reason('usage', code, diagnostic);
  return reportFor(command, dryRun, [], [], { result: 'usage-error', terminalPhase: 'parse', mutationStarted: false, reason: failure });
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
): { plan: readonly LifecyclePlanOperation[]; outcomes: LifecycleOperationOutcome[] } | undefined {
  const refusals = new Map<string, CompatibilityError>();
  for (const profile of profiles) {
    try { requireCompatible(profile, action); }
    catch (error) { if (error instanceof CompatibilityError) refusals.set(profile.id, error); else throw error; }
  }
  if (refusals.size === 0) return undefined;
  const blocked = reason('runtime', 'runtime.operation-failed', 'not attempted because another selected target could not be admitted');
  const rows = profiles.flatMap((profile) => plugins.map((plugin) => {
    const refusal = refusals.get(profile.id);
    const refusalReason = refusal === undefined ? blocked : reason(
      'capability',
      refusal.status === 'unsupported' ? 'capability.unsupported' : 'capability.unverified',
      refusal.message,
      refusal.capability,
      refusal.evidence,
    );
    const operation = planOperation({
      command: action === 'install' ? 'add' : 'update',
      scope: createDeploymentScopeIdentity(source, { kind: profile.id, instance: 'default' }),
      sourceSnapshotId,
      package: plugin,
      action: 'not-attempted',
      route: 'none',
    });
    return { operation, outcome: outcomeFor(operation, {
      result: refusal === undefined ? 'not-attempted' : 'failed',
      changed: false,
      reason: refusalReason,
    }) };
  }));
  const plan = freezePlan(rows.map(({ operation }) => operation));
  return { plan, outcomes: rows.map(({ outcome }) => outcome) };
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
      const report = reportFor('remove', flags.dryRun, [], [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
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
      const report = reportFor('remove', flags.dryRun, [], [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    const pairs: Array<{
      writer: (typeof cleanupWriters)[number];
      record: InstallRecord;
      nativeId: string | null;
      legacyNativeIds: readonly string[];
      failure: LifecycleReason | null;
      operation: LifecyclePlanOperation;
    }> = [];
    let preflightFailure: LifecycleReason | null = null;
    for (const writer of selection.selected) {
      const candidates = reportScopesForTarget(lifecycleState, writer.id, 'default').flatMap((match) => {
        const record = state[match.activationIndex];
        if (record === undefined || record.host !== writer.id || record.id !== match.activation.nativeId) {
          preflightFailure = reason('internal', 'internal.invariant', `install record '${match.activation.nativeId}' on ${writer.id} has no exact deployment scope identity`);
          return [];
        }
        const identity = preparedNativeIdentity(writer, record, match.activation.packageId, match.activation.sourceRelativeDir);
        return [{
          match,
          record,
          identity,
        }];
      });
      if (preflightFailure !== null) break;
      const matches = candidates.filter(({ identity, record }) => requestedIdentityMatches(identity, record.id, target));
      if (matches.length > 1) {
        preflightFailure = reason('internal', 'internal.ambiguous-ownership', `multiple ${writer.id}/default deployment scopes own native package '${target}'`);
        break;
      }
      if (matches.length === 0) {
        preflightFailure = reason('internal', 'internal.ambiguous-ownership', `no owned install record for '${target}' on ${writer.id}; refusing removal`);
        break;
      }
      const { match, record, identity } = matches[0]!;
      if (identity.failure !== null) {
        pairs.push({
          writer,
          record,
          nativeId: identity.nativeId,
          legacyNativeIds: Object.freeze([]),
          failure: identity.failure,
          operation: planOperation({
            command: 'remove',
            scope: match.scope,
            package: identity.package,
            nativeId: identity.nativeId,
            action: 'not-attempted',
            route: 'none',
          }),
        });
        continue;
      }
      if (candidates.some(({ record: candidateRecord, identity: candidateIdentity }) =>
        candidateIdentity.failure === null &&
        !candidateIdentity.adapterResolved && writer.unresolvedLegacyNativeIdConflicts?.(candidateRecord.id, target) === true)) {
        preflightFailure = reason(
          'internal',
          'internal.ambiguous-ownership',
          `cannot prove the canonical ${writer.id} identity for historical ledger package '${target}' without its Source`,
        );
        break;
      }
      const equivalentMatches = candidates.filter((candidate) => identity.equivalentNativeIds.has(candidate.record.id));
      if (equivalentMatches.length > 1) {
        preflightFailure = reason(
          'internal',
          'internal.ambiguous-ownership',
          `multiple ${writer.id} ledger records match native identity '${identity.nativeId}'`,
        );
        break;
      }
      if (record.ownership !== 'plgnz' && record.ownership !== undefined) {
        preflightFailure = reason('internal', 'internal.ambiguous-ownership', 'install ownership is not proven; refusing removal');
        break;
      }
      if (record.pending === 'install') {
        preflightFailure = reason('internal', 'internal.invariant', 'install is pending; refusing removal');
        break;
      }
      pairs.push({
        writer,
        record,
        nativeId: identity.nativeId,
        legacyNativeIds: identity.legacyNativeIds,
        failure: null,
        operation: planOperation({
          command: 'remove',
          scope: match.scope,
          package: identity.package,
          nativeId: identity.nativeId,
          action: 'retire-orphan',
          route: 'managed',
        }),
      });
    }
    if (preflightFailure !== null) {
      const report = reportFor('remove', flags.dryRun, [], [], {
        terminalPhase: 'preflight',
        mutationStarted: false,
        reason: preflightFailure,
      });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }

    const plan = freezePlan(pairs.map(({ operation }) => operation));
    const identityFailure = pairs.find((pair) => pair.failure !== null)?.failure ?? null;
    if (identityFailure !== null) {
      const blocked = reason('runtime', 'runtime.operation-failed', 'not attempted after an adapter identity preflight failure');
      const identityOutcomes = plan.map((operation, index) => outcomeFor(operation, {
        result: pairs[index]!.failure === null ? 'not-attempted' : 'failed',
        changed: false,
        reason: pairs[index]!.failure ?? blocked,
      }));
      const report = reportFor('remove', flags.dryRun, plan, identityOutcomes, {
        terminalPhase: 'preflight',
        mutationStarted: false,
        reason: identityFailure,
      });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    const outcomes: LifecycleOperationOutcome[] = [];
    let commandFailure: LifecycleReason | null = null;
    let commandTerminalPhase: LifecycleTerminalPhase | undefined;
    let mutationStarted = false;
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[index]!;
      const operation = plan[index]!;
      if (flags.dryRun) {
        outcomes.push(outcomeFor(operation, { result: 'succeeded', changed: false }));
        continue;
      }
      const nativeId = pair.nativeId!;
      let pairMutationStarted = false;
      let pairChanged = false;
      let pairTerminalPhase: LifecycleTerminalPhase = 'apply';
      try {
        const current = state.find((candidate) => candidate.host === pair.record.host && candidate.id === pair.record.id);
        if (current === undefined) throw new Error(`install record '${pair.record.id}' disappeared before apply`);
        const pending = { ...current, id: nativeId, pending: 'remove' as const };
        const pendingState = state.map((candidate) => candidate === current ? pending : candidate);
        writeState(pendingState);
        pairMutationStarted = true;
        mutationStarted = true;
        state = pendingState;
        const removeOptions = { source: pair.record.source, legacyNativeIds: pair.legacyNativeIds };
        if (json) await withLogsOnStderr(() => pair.writer.remove(nativeId, removeOptions));
        else await pair.writer.remove(nativeId, removeOptions);
        pairChanged = true;
        pairTerminalPhase = 'readback';
        try {
          const installed = pair.writer.listInstalled();
          if (installed.some((candidate) => candidate.id === nativeId && candidate.enabled !== false)) {
            throw new LifecycleCommandError(reason('readback', 'readback.mismatch', `native removal readback still contains ${nativeId}`));
          }
        } catch (error) {
          if (error instanceof LifecycleCommandError) throw error;
          throw new LifecycleCommandError(reason('readback', 'readback.failed', unknownErrorDiagnostic(error)));
        }
        const finalized = state.filter((candidate) => candidate !== pending);
        pairTerminalPhase = 'finalize';
        writeState(finalized);
        state = finalized;
        outcomes.push(outcomeFor(operation, { result: 'succeeded', changed: true }));
      } catch (error) {
        commandTerminalPhase = pairTerminalPhase;
        const failure = error instanceof LifecycleCommandError
          ? error.lifecycleReason
          : pairMutationStarted
            ? reason('recovery', 'recovery.required', `removal of '${target}' requires recovery after pending intent was persisted — ${unknownErrorDiagnostic(error)}`)
            : reason('runtime', 'runtime.operation-failed', unknownErrorDiagnostic(error));
        commandFailure = failure;
        outcomes.push(outcomeFor(operation, {
          result: pairMutationStarted ? 'pending' : 'failed',
          changed: pairChanged,
          resourceState: failure.category === 'readback'
            ? 'potentially-changed'
            : pairChanged ? 'absent' : pairMutationStarted ? 'potentially-changed' : 'unknown',
          activationState: failure.category === 'readback' ? 'unknown' : pairChanged ? 'inactive' : 'unknown',
          reason: failure,
        }));
        const skipped = reason('runtime', 'runtime.operation-failed', 'not attempted after an earlier remove failure');
        for (let later = index + 1; later < plan.length; later++) {
          outcomes.push(outcomeFor(plan[later]!, {
            result: 'not-attempted',
            changed: false,
            resourceState: 'unknown',
            activationState: 'unknown',
            reason: skipped,
          }));
        }
        break;
      }
    }
    const report = reportFor('remove', flags.dryRun, plan, outcomes, {
      terminalPhase: commandTerminalPhase,
      mutationStarted,
      reason: commandFailure,
    });
    printReport(report, mutationOutput);
    return exitCodeForLifecycleReport(report);
  }
  if (verb === 'add') {
    const flags = parseFlags(args.slice(1));
    const outcomes: LifecycleOperationOutcome[] = [];
    let plan: readonly LifecyclePlanOperation[] = Object.freeze([]);
    let activeOperationId: string | undefined;
    let activePairMutationStarted = false;
    let activePairChanged = false;
    let activeReadbackConfirmed = false;
    let activeTerminalPhase: LifecycleTerminalPhase = 'apply';
    let mutationStarted = false;
    let sourceSnapshots: LifecycleSourceSnapshotContext[] = [];
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
        const report = reportFor('add', flags.dryRun, [], [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      let state: InstallRecord[];
      try {
        state = readState();
      } catch (error) {
        const failure = reason('internal', 'internal.corrupt-state', unknownErrorDiagnostic(error));
        const report = reportFor('add', flags.dryRun, [], [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      let resolved;
      try { resolved = resolveSource(sourceArg); }
      catch (error) {
        const failure = reason('runtime', 'runtime.operation-failed', unknownErrorDiagnostic(error));
        const report = reportFor('add', flags.dryRun, [], [], { terminalPhase: 'resolve', mutationStarted: false, reason: failure });
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
        const report = reportFor('add', flags.dryRun, incompatible.plan, incompatible.outcomes, { terminalPhase: 'preflight', mutationStarted: false, sourceSnapshots });
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
        const report = reportFor('add', flags.dryRun, [], [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure, sourceSnapshots });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      const capturedAddPairs = selection.selected.flatMap((writer) => pluginSelection.selected.map((plugin) => {
        const scope = createDeploymentScopeIdentity(resolved.snapshot.binding, { kind: writer.id, instance: 'default' });
        const captured = captureNativeIdentity(writer, plugin);
        return captured.ok
          ? { writer, plugin, scope, identity: captured.identity, nativeId: captured.identity.nativeId, failure: null }
          : {
              writer,
              plugin,
              scope,
              identity: null,
              nativeId: captured.nativeId,
              failure: reason('internal', 'internal.defect', unknownErrorDiagnostic(captured.error)),
            };
      }));
      const identityFailure = capturedAddPairs.find((pair) => pair.failure !== null)?.failure ?? null;
      if (identityFailure !== null) {
        const identityPlan = freezePlan(capturedAddPairs.map((pair) => planOperation({
          command: 'add',
          scope: pair.scope,
          sourceSnapshotId,
          package: pair.plugin.name,
          nativeId: pair.nativeId,
          action: pair.failure === null ? 'install' : 'not-attempted',
          route: pair.failure === null ? 'managed' : 'none',
        })));
        const blocked = reason('runtime', 'runtime.operation-failed', 'not attempted after an adapter identity preflight failure');
        const identityOutcomes = identityPlan.map((operation, index) => outcomeFor(operation, {
          result: capturedAddPairs[index]!.failure === null ? 'not-attempted' : 'failed',
          changed: false,
          reason: capturedAddPairs[index]!.failure ?? blocked,
        }));
        const report = reportFor('add', flags.dryRun, identityPlan, identityOutcomes, {
          terminalPhase: 'preflight',
          mutationStarted: false,
          reason: identityFailure,
          sourceSnapshots,
        });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }
      const addPairs = capturedAddPairs.map((pair) => ({ ...pair, identity: pair.identity! }));
      if (flags.adoptExisting && selection.selected.some((writer) => writer.supportsAdoption !== true)) {
        const blocked = reason('runtime', 'runtime.operation-failed', 'not attempted because another selected target does not support adoption');
        const adoptionRows = addPairs.map(({ writer, plugin, scope, identity }) => {
          const supported = writer.supportsAdoption === true;
          const diagnostic = `target '${writer.id}' does not support --adopt-existing`;
          const operation = planOperation({
            command: 'add',
            scope,
            sourceSnapshotId,
            package: plugin.name,
            nativeId: identity.nativeId,
            action: 'not-attempted',
            route: 'none',
          });
          return { operation, outcome: outcomeFor(operation, {
            result: supported ? 'not-attempted' : 'failed',
            changed: false,
            reason: supported ? blocked : reason('capability', 'capability.unsupported', diagnostic, 'adoption', 'writer.supportsAdoption'),
          }) };
        });
        const adoptionPlan = freezePlan(adoptionRows.map(({ operation }) => operation));
        const report = reportFor('add', flags.dryRun, adoptionPlan, adoptionRows.map(({ outcome }) => outcome), {
          terminalPhase: 'preflight',
          mutationStarted: false,
          sourceSnapshots,
        });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }

      for (const { writer, identity } of addPairs) {
        const stateIds = new Set(identity.equivalentNativeIds);
        if (state.filter((record) => record.host === writer.id && stateIds.has(record.id)).length > 1) {
          const failure = reason(
            'internal',
            'internal.ambiguous-ownership',
            `multiple ${writer.id} ledger records match native identity '${identity.nativeId}'`,
          );
          const report = reportFor('add', flags.dryRun, [], [], {
            terminalPhase: 'preflight',
            mutationStarted: false,
            reason: failure,
            sourceSnapshots,
          });
          printReport(report, mutationOutput);
          return exitCodeForLifecycleReport(report);
        }
      }

      if (flags.dryRun) {
        const dryRunPairs = Object.freeze(addPairs);
        const rows: Array<{ operation: LifecyclePlanOperation; outcome: LifecycleOperationOutcome }> = [];
        let stopped = false;
        for (const pair of dryRunPairs) {
          if (stopped) {
            const operation = planOperation({
              command: 'add', scope: pair.scope, sourceSnapshotId, package: pair.plugin.name, nativeId: pair.identity.nativeId,
              action: 'install', route: 'managed',
            });
            rows.push({ operation, outcome: outcomeFor(operation, {
              result: 'not-attempted',
              changed: false,
              reason: reason('runtime', 'runtime.operation-failed', 'not attempted after an earlier install preflight failure'),
            }) });
            continue;
          }
          try {
            const writerResult = json
              ? await withLogsOnStderr(() => pair.writer.add(pair.plugin, resolved, { dryRun: true, adoptExisting: flags.adoptExisting }))
              : await pair.writer.add(pair.plugin, resolved, { dryRun: true, adoptExisting: flags.adoptExisting });
            const operation = planOperation({
              command: 'add', scope: pair.scope, sourceSnapshotId, package: pair.plugin.name, nativeId: pair.identity.nativeId,
              action: writerResult === 'unchanged' ? 'unchanged' : 'install', route: 'managed',
            });
            rows.push({ operation, outcome: outcomeFor(operation, { result: 'succeeded', changed: false }) });
          } catch (error) {
            const capability = error instanceof CompatibilityError;
            const operation = planOperation({
              command: 'add', scope: pair.scope, sourceSnapshotId, package: pair.plugin.name, nativeId: pair.identity.nativeId,
              action: capability ? 'not-attempted' : 'install', route: capability ? 'none' : 'managed',
            });
            rows.push({ operation, outcome: outcomeFor(operation, {
              result: 'failed',
              changed: false,
              reason: reasonForError(error),
            }) });
            stopped = !capability;
          }
        }
        plan = freezePlan(rows.map(({ operation }) => operation));
        const report = reportFor('add', true, plan, rows.map(({ outcome }) => outcome), {
          terminalPhase: rows.some(({ outcome }) => outcome.result !== 'succeeded') ? 'preflight' : undefined,
          mutationStarted: false,
          sourceSnapshots,
        });
        printReport(report, mutationOutput);
        return exitCodeForLifecycleReport(report);
      }

      activeTerminalPhase = 'preflight';
      const executionPairs = addPairs.map((pair) => ({
        ...pair,
        operation: planOperation({
          command: 'add',
          scope: pair.scope,
          sourceSnapshotId,
          package: pair.plugin.name,
          nativeId: pair.identity.nativeId,
          action: 'install',
          route: 'managed',
        }),
      }));
      activeTerminalPhase = 'apply';
      plan = freezePlan(executionPairs.map(({ operation }) => operation));
      for (let operationIndex = 0; operationIndex < executionPairs.length; operationIndex++) {
        const { writer: w, plugin, identity } = executionPairs[operationIndex]!;
        const operation = plan[operationIndex]!;
        activeOperationId = operation.operationId;
        activePairMutationStarted = false;
        activePairChanged = false;
        activeReadbackConfirmed = false;
        activeTerminalPhase = 'apply';
        const nativeId = identity.nativeId;
        const stateIds = new Set(identity.equivalentNativeIds);
        const idx = state.findIndex(r => r.host === w.id && stateIds.has(r.id));
        const previous = idx !== -1 ? state[idx] : undefined;
        const rec: InstallRecord = {
          ...(previous ?? {
            host: w.id,
            id: nativeId,
          }),
          host: w.id,
          id: nativeId,
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
          const diagnostic = error instanceof CompatibilityError
            ? `target '${w.id}' refused install after pending intent was persisted — ${error.message}`
            : `install of '${plugin.name}' requires recovery after pending intent was persisted — ${unknownErrorDiagnostic(error)}`;
          throw new LifecycleCommandError(reason('recovery', 'recovery.required', diagnostic));
        }
        activeTerminalPhase = 'readback';
        let match;
        let installedFingerprint: string;
        try {
          const installed = w.listInstalled();
          const expectedMarketplace = plugin.marketplace ?? 'local';
          match = installed.find(p => p.id === nativeId && p.name === plugin.name &&
            (p.marketplace === expectedMarketplace || (expectedMarketplace === 'local' && p.marketplace === undefined)) && p.enabled !== false);
          if (match?.path === undefined) throw new LifecycleCommandError(reason('readback', 'readback.mismatch', `native install readback is missing ${nativeId}`));
          installedFingerprint = fingerprintInstallation(match);
          activeReadbackConfirmed = true;
        } catch (error) {
          if (error instanceof LifecycleCommandError) throw error;
          throw new LifecycleCommandError(reason('readback', 'readback.failed', unknownErrorDiagnostic(error)));
        }
        const finalized: InstallRecord = {
          ...rec,
          id: nativeId,
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
          throw new LifecycleCommandError(reason('recovery', 'recovery.required', `install of '${plugin.name}' requires recovery after finalization failed — ${unknownErrorDiagnostic(error)}`));
        }
        state = finalizedState;
        outcomes.push(outcomeFor(operation, { result: 'succeeded', changed: activePairChanged }));
      }
      const report = reportFor('add', false, plan, outcomes, { mutationStarted, sourceSnapshots });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    } catch (error: unknown) {
      const failureReason = reasonForError(error);
      const reported = new Set(outcomes.map((candidate) => candidate.operationId));
      const failures: LifecycleOperationOutcome[] = [];
      for (const operation of plan) {
        if (reported.has(operation.operationId)) continue;
        const active = operation.operationId === activeOperationId;
        const activeResult = failureReason.category === 'recovery' ||
          (activePairMutationStarted && failureReason.category === 'readback')
          ? 'pending'
          : 'failed';
        failures.push(outcomeFor(operation, {
          result: active ? activeResult : 'not-attempted',
          changed: active && activePairChanged,
          resourceState: active && activeReadbackConfirmed ? 'present' : active && activePairMutationStarted ? 'potentially-changed' : 'unknown',
          activationState: active && activeReadbackConfirmed ? 'active-conforming' : 'unknown',
          reason: active ? failureReason : reason('runtime', 'runtime.operation-failed', 'not attempted after an earlier install failure'),
        }));
      }
      const report = reportFor('add', flags.dryRun, plan, [...outcomes, ...failures], {
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
      const report = reportFor('update', flags.dryRun, [], [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
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
      const report = reportFor('update', flags.dryRun, [], [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
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
      const report = reportFor('update', flags.dryRun, [], [], { terminalPhase: 'preflight', mutationStarted: false, reason: failure });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    const selectedTargetKinds = new Set(selection.selected.map((writer) => writer.id));
    const scopesById = new Map(lifecycleState.scopes.map((scope) => [scope.id, scope]));
    const requestedName = flags.positionals[0];
    const candidatePairs: Array<{
      record: InstallRecord;
      scope: DeploymentScopeIdentity;
      package: string;
      nativeId: string | null;
      host: string;
      legacyNativeIds: readonly string[];
      equivalentNativeIds: ReadonlySet<string>;
      adapterResolved: boolean;
      failure: LifecycleReason | null;
    }> = [];
    const nativeIdentitySnapshots = new Map<InstallRecord, NativeIdentitySnapshot>();
    let scopeFailure: LifecycleReason | null = null;
    lifecycleState.activations.forEach((activation, activationIndex) => {
      if (scopeFailure !== null) return;
      const stored = scopesById.get(activation.scopeId);
      if (stored === undefined || stored.target.instance !== 'default' || !selectedTargetKinds.has(stored.target.kind)) return;
      const record = updateState[activationIndex];
      if (record === undefined || record.host !== stored.target.kind || record.id !== activation.nativeId) {
        scopeFailure = reason('internal', 'internal.invariant', `install record '${activation.nativeId}' on ${stored.target.kind} has no exact deployment scope identity`);
        return;
      }
      const writer = selection.selected.find((candidate) => candidate.id === stored.target.kind);
      if (writer === undefined) {
        scopeFailure = reason('internal', 'internal.invariant', `selected update target '${stored.target.kind}' has no writer`);
        return;
      }
      const identity = preparedNativeIdentity(writer, record, activation.packageId, activation.sourceRelativeDir);
      candidatePairs.push({
        record,
        scope: createDeploymentScopeIdentity(stored.source, { kind: stored.target.kind, instance: stored.target.instance }),
        package: identity.package,
        nativeId: identity.nativeId,
        host: stored.target.kind,
        legacyNativeIds: identity.legacyNativeIds,
        equivalentNativeIds: identity.equivalentNativeIds,
        adapterResolved: identity.adapterResolved,
        failure: identity.failure,
      });
    });
    const selectedPairs = candidatePairs.filter((pair) => requestedIdentityMatches(pair, pair.record.id, requestedName));
    if (scopeFailure === null) {
      for (const pair of selectedPairs) {
        if (pair.failure !== null) continue;
        const equivalentRecords = candidatePairs.filter((candidate) =>
          candidate.host === pair.host &&
          candidate.scope.target.instance === pair.scope.target.instance &&
          pair.equivalentNativeIds.has(candidate.record.id));
        if (equivalentRecords.length > 1) {
          const diagnostic = equivalentRecords.every((candidate) => candidate.record.id === pair.record.id)
            ? `multiple ${pair.host}/${pair.scope.target.instance} deployment scopes own native package '${pair.record.id}'`
            : `multiple ${pair.host} ledger records match native identity '${pair.nativeId}'`;
          scopeFailure = reason(
            'internal',
            'internal.ambiguous-ownership',
            diagnostic,
          );
          break;
        }
      }
    }
    if (scopeFailure !== null || (requestedName !== undefined && selectedPairs.length === 0)) {
      const failure = scopeFailure ?? reason('internal', 'internal.ambiguous-ownership', `no install record for '${requestedName}' in state.json — not installed by plgnz; refusing to modify it`);
      const report = reportFor('update', flags.dryRun, [], [], {
        terminalPhase: 'preflight',
        mutationStarted: false,
        reason: failure,
      });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    if (selectedPairs.length === 0) {
      const report = reportFor('update', flags.dryRun, [], [], { mutationStarted: false });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }

    const baseOperations = selectedPairs.map((pair) => planOperation({
      command: 'update',
      scope: pair.scope,
      package: pair.package,
      nativeId: pair.nativeId,
      action: pair.failure === null ? 'update' : 'not-attempted',
      route: pair.failure === null ? 'managed' : 'none',
    }));
    let updatePlan: readonly LifecyclePlanOperation[] = freezePlan(baseOperations);
    const identityFailure = selectedPairs.find((pair) => pair.failure !== null)?.failure ?? null;
    if (identityFailure !== null) {
      const blocked = reason('runtime', 'runtime.operation-failed', 'not attempted after an adapter identity preflight failure');
      const identityOutcomes = updatePlan.map((operation, index) => outcomeFor(operation, {
        result: selectedPairs[index]!.failure === null ? 'not-attempted' : 'failed',
        changed: false,
        reason: selectedPairs[index]!.failure ?? blocked,
      }));
      const report = reportFor('update', flags.dryRun, updatePlan, identityOutcomes, {
        terminalPhase: 'preflight',
        mutationStarted: false,
        reason: identityFailure,
      });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    }
    selectedPairs.forEach((pair, index) => {
      const nativeId = updatePlan[index]?.nativeId;
      if (nativeId === null || nativeId === undefined) return;
      nativeIdentitySnapshots.set(pair.record, Object.freeze({
        nativeId,
        legacyNativeIds: Object.freeze([...pair.legacyNativeIds]),
        equivalentNativeIds: Object.freeze([...pair.equivalentNativeIds]),
      }));
    });
    let updateMutationStarted = false;
    try {
      const result = json
        ? await withLogsOnStderr(() => runUpdate(undefined, { dryRun: flags.dryRun, state: updateState, records: selectedPairs.map(({ record }) => record), writers: selection.selected, nativeIdentitySnapshots }))
        : await runUpdate(undefined, { dryRun: flags.dryRun, state: updateState, records: selectedPairs.map(({ record }) => record), writers: selection.selected, nativeIdentitySnapshots });
      updateMutationStarted = result.mutationStarted;
      const groups = new Map<string, UpdateFinding[]>();
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
        const pair = selectedPairs.find((candidate) => candidate.host === finding.host && candidate.nativeId === finding.nativeId);
        if (pair === undefined) {
          commandFailure ??= reason('internal', 'internal.invariant', `update result for '${finding.nativeId}' on ${finding.host} has no deployment scope identity`);
          continue;
        }
        const key = `${pair.scope.id}\u0000${pair.nativeId}`;
        const group = groups.get(key) ?? [];
        group.push(finding);
        groups.set(key, group);
      }
      if (flags.dryRun) {
        updatePlan = freezePlan(selectedPairs.map((pair, index) => {
          const findings = groups.get(`${pair.scope.id}\u0000${pair.nativeId}`) ?? [];
          const failed = findings.find((finding) => finding.mark !== '✓' || finding.status !== undefined);
          const successfulAction = findings.find((finding) => finding.action !== undefined)?.action;
          return planOperation({
            command: 'update',
            scope: pair.scope,
            package: pair.package,
            nativeId: pair.nativeId,
            action: failed !== undefined ? 'not-attempted' : successfulAction ?? baseOperations[index]!.action,
            route: failed !== undefined ? 'none' : 'managed',
          });
        }));
      }
      const updateOutcomes = updatePlan.map((operation) => {
        const findings = groups.get(`${operation.scope.id}\u0000${operation.nativeId}`) ?? [];
        if (findings.length === 0) {
          return outcomeFor(operation, {
            result: 'not-attempted',
            changed: false,
            resourceState: 'unknown',
            activationState: 'unknown',
            reason: reason('runtime', 'runtime.operation-failed', 'not attempted after an earlier update failure'),
          });
        }
        const failed = findings.find((finding) => finding.mark !== '✓' || finding.status !== undefined);
        const capabilityStatus = failed?.status === 'unsupported' || failed?.status === 'unverified';
        const succeeded = failed === undefined;
        const pairMutationStarted = findings.some((finding) => finding.mutationStarted === true);
        const pairChanged = findings.some((finding) => finding.changed === true);
        const failureBeforeApply = failed?.terminalPhase === 'parse' || failed?.terminalPhase === 'resolve' ||
          failed?.terminalPhase === 'freeze' || failed?.terminalPhase === 'preflight';
        const earlyFailureAlongsideMutation = !succeeded && result.mutationStarted && !pairMutationStarted && failureBeforeApply;
        const capability = capabilityStatus && !pairMutationStarted && !pairChanged && failureBeforeApply && failed?.resourceState !== 'potentially-changed';
        if (!succeeded) commandTerminalPhase = earlyFailureAlongsideMutation ? 'apply' : failed.terminalPhase;
        const failure = succeeded ? null : capability
          ? reason(
              'capability',
              failed.status === 'unsupported' ? 'capability.unsupported' : 'capability.unverified',
              failed.message,
              failed.capabilityId ?? 'update',
              failed.evidenceId ?? null,
            )
          : failed.reasonCode === 'recovery.required'
            ? reason('recovery', 'recovery.required', failed.message)
          : failed.reasonCode === 'readback.failed' || failed.reasonCode === 'readback.mismatch'
            ? reason('readback', failed.reasonCode, failed.message)
            : reason('runtime', 'runtime.operation-failed', failed.message);
        return outcomeFor(operation, {
          result: succeeded
            ? 'succeeded'
            : failure?.category === 'recovery' || (pairMutationStarted && failure?.category === 'readback')
              ? 'pending'
              : 'failed',
          changed: pairChanged,
          resourceState: !succeeded ? failed.resourceState ?? (pairMutationStarted ? 'potentially-changed' : 'unknown') : undefined,
          activationState: !succeeded ? failed.activationState ?? 'unknown' : undefined,
          reason: failure,
        });
      });
      if (result.exitCode !== 0 && commandFailure === null && updateOutcomes.every((candidate) => candidate.result === 'succeeded')) {
        commandFailure = reason('internal', 'internal.invariant', 'update exited nonzero without a failed pair result');
      }
      const report = reportFor('update', flags.dryRun, updatePlan, updateOutcomes, {
        terminalPhase: commandTerminalPhase,
        mutationStarted: result.mutationStarted,
        reason: commandFailure,
      });
      printReport(report, mutationOutput);
      return exitCodeForLifecycleReport(report);
    } catch (error) {
      const failure = reasonForError(error);
      const skipped = updatePlan.map((operation) => outcomeFor(operation, {
        result: 'not-attempted',
        changed: false,
        resourceState: 'unknown',
        activationState: 'unknown',
        reason: failure,
      }));
      const report = reportFor('update', flags.dryRun, updatePlan, skipped, {
        terminalPhase: flags.dryRun ? 'preflight' : 'apply',
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
