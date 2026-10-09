/**
 * CLI entrypoint. Verbs: add, doctor, pin, update, list, remove, targets
 * (AGENTS.md verbs list).
 */
import { runDoctor, formatFinding, type DoctorFinding } from './doctor';
import { hosts } from './hosts';
import { cleanupWriters, writers } from './hosts/writers';
import { resolveSource } from './source';
import { findRecord, readState } from './state';
import { writeState } from './state-write';
import type { InstallRecord } from './state';
import { runPin } from './pin';
import { runUpdate } from './update';
import { fingerprintInstallation } from './fingerprint';
import type { HostReader, InstallOutcome } from './host';
import { consumerProfiles, findConsumerProfile, type ConsumerProfile } from './consumer-profiles';
import { CompatibilityError, requireCompatible } from './compatibility';
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

function printOutcomes(outcomes: readonly InstallOutcome[], json: boolean): void {
  if (json) console.log(JSON.stringify(outcomes, null, 2));
  else for (const outcome of outcomes) console.log(`${outcome.target}\t${outcome.status}\t${outcome.plugin}${outcome.diagnostic ? `\t${outcome.diagnostic}` : ''}`);
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

function compatibilityOutcomes(profiles: readonly ConsumerProfile[], plugins: readonly string[], action: 'install' | 'update', dryRun: boolean): InstallOutcome[] | undefined {
  const refusals = new Map<string, CompatibilityError>();
  for (const profile of profiles) {
    try { requireCompatible(profile, action); }
    catch (error) { if (error instanceof CompatibilityError) refusals.set(profile.id, error); else throw error; }
  }
  if (refusals.size === 0) return undefined;
  const diagnostic = 'not attempted because another selected target could not be admitted';
  return profiles.flatMap((profile) => plugins.map((plugin) => {
    const refusal = refusals.get(profile.id);
    return {
      plugin,
      target: profile.id,
      status: refusal?.status ?? 'failed',
      action,
      dryRun,
      diagnostic: refusal?.message ?? diagnostic,
    } satisfies InstallOutcome;
  }));
}

async function withoutConsole<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = original; }
}

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.filter((a) => a !== '--json');
  const json = argv.length !== args.length;
  const verb = args[0];

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
      if (json) printOutcomes(flags.targets.map((target) => ({ plugin: '*', target, status: 'failed', dryRun: false, diagnostic: selection.error })), true);
      else console.error(`plugnz doctor: ${selection.error}`);
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
      if (json) printOutcomes(flags.targets.map((target) => ({ plugin: '*', target, status: 'failed', dryRun: false, diagnostic: selection.error })), true);
      else console.error(`plugnz list: ${selection.error}`);
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
    if (rejectDisallowed(flags, new Set(['target', 'dryRun'])) || !target || flags.positionals.length > 1) fail(`plugnz remove: missing or unexpected plugin id`, 2);
    const selection = select(cleanupWriters, flags.targets);
    if (selection.error) {
      printOutcomes(flags.targets.map((host) => ({ plugin: target, target: host, status: 'failed', dryRun: flags.dryRun, diagnostic: selection.error })), json);
      return 2;
    }
    if (selection.selected.length === 0) {
      printOutcomes([{ plugin: target, target: '*', status: 'failed', action: 'remove', dryRun: flags.dryRun, diagnostic: 'No detected writer targets' }], json);
      return 1;
    }
    let state: InstallRecord[];
    try { state = readState(); }
    catch (error) {
      printOutcomes([{ plugin: target, target: '*', status: 'failed', action: 'remove', dryRun: flags.dryRun, diagnostic: (error as Error).message }], json);
      return 1;
    }
    const outcomes: InstallOutcome[] = [];
    for (const w of selection.selected) {
      const record = findRecord(state, w.id, target);
      const owned = record !== undefined && (record.ownership === 'plgnz' || record.ownership === undefined);
      if (!owned || record?.pending === 'install') {
        outcomes.push({ plugin: target, target: w.id, status: 'failed', action: 'remove', dryRun: flags.dryRun, diagnostic: record?.pending === 'install' ? 'install is pending; refusing removal' : 'no owned install record; refusing removal' });
        continue;
      }
      if (flags.dryRun) {
        outcomes.push({ plugin: target, target: w.id, status: 'installed', action: 'remove', dryRun: true });
        continue;
      }
      try {
        const pending = { ...record, pending: 'remove' as const };
        const pendingState = state.map((candidate) => candidate === record ? pending : candidate);
        writeState(pendingState);
        state = pendingState;
        await w.remove(target);
        const finalized = state.filter((candidate) => candidate !== pending);
        writeState(finalized);
        state = finalized;
        outcomes.push({ plugin: target, target: w.id, status: 'installed', action: 'remove', dryRun: false });
      } catch (error) {
        outcomes.push({ plugin: target, target: w.id, status: 'failed', action: 'remove', dryRun: false, diagnostic: (error as Error).message });
      }
    }
    printOutcomes(outcomes, json);
    return outcomes.some((outcome) => outcome.status === 'failed') ? 1 : 0;
  }
  if (verb === 'add') {
    const flags = parseFlags(args.slice(1));
    const outcomes: InstallOutcome[] = [];
    let activeTarget = '*';
    let activePlugin = '*';
    let expected: Array<{ plugin: string; target: string }> = [];
    const disallowed = rejectDisallowed(flags, new Set(['target', 'plugin', 'dryRun', 'adoptExisting']));
    if (disallowed) {
      if (json) printOutcomes([{ plugin: '*', target: '*', status: 'failed', dryRun: flags.dryRun, diagnostic: disallowed }], true);
      else console.error(`plugnz add: ${disallowed}`);
      return 2;
    }
    if (flags.positionals.length > 1) fail(`plugnz add: unexpected argument: ${flags.positionals[1]}`, 2);
    const sourceArg = flags.positionals[0];
    if (sourceArg === undefined) fail(`plugnz add: missing source`, 2);

    try {
      const profileSelection = selectProfiles(flags.targets);
      if (profileSelection.error) {
        printOutcomes(flags.targets.map((target) => ({ plugin: '*', target, status: 'failed', dryRun: flags.dryRun, diagnostic: profileSelection.error })), json);
        return 2;
      }
      if (profileSelection.selected.some((profile) => profile.scope === 'excluded-standalone')) {
        const incompatible = compatibilityOutcomes(profileSelection.selected, ['*'], 'install', flags.dryRun)!;
        printOutcomes(incompatible, json);
        return 1;
      }
      if (flags.adoptExisting) {
        const incompatible = compatibilityOutcomes(profileSelection.selected, ['*'], 'install', flags.dryRun);
        if (incompatible !== undefined) {
          printOutcomes(incompatible, json);
          return 1;
        }
        const adoptionSelection = flags.targets.length === 0
          ? select(writers, [])
          : select(writers, profileSelection.selected.map((profile) => profile.id));
        if (adoptionSelection.error) {
          printOutcomes(profileSelection.selected.map((profile) => ({ plugin: '*', target: profile.id, status: 'failed', dryRun: flags.dryRun, diagnostic: adoptionSelection.error })), json);
          return 2;
        }
        const unsupported = adoptionSelection.selected.find((writer) => writer.supportsAdoption !== true);
        if (unsupported !== undefined) {
          const diagnostic = `target '${unsupported.id}' does not support --adopt-existing`;
          printOutcomes(adoptionSelection.selected.map((writer) => ({ plugin: '*', target: writer.id, status: 'unsupported' as const, action: 'install' as const, dryRun: flags.dryRun, diagnostic })), json);
          return 2;
        }
      }
      const resolved = resolveSource(sourceArg);
      const pluginSelection = selectPlugins(resolved.plugins, flags.plugins);
      if (pluginSelection.error) {
        printOutcomes([{ plugin: '*', target: '*', status: 'failed', dryRun: flags.dryRun, diagnostic: pluginSelection.error }], json);
        return 2;
      }
      const incompatible = compatibilityOutcomes(profileSelection.selected, pluginSelection.selected.map((plugin) => plugin.name), 'install', flags.dryRun);
      if (incompatible !== undefined) {
        printOutcomes(incompatible, json);
        return 1;
      }
      const selection = flags.targets.length === 0
        ? select(writers, [])
        : select(writers, profileSelection.selected.map((profile) => profile.id));
      if (selection.error) {
        printOutcomes(profileSelection.selected.map((profile) => ({ plugin: '*', target: profile.id, status: 'failed', dryRun: flags.dryRun, diagnostic: selection.error })), json);
        return 2;
      }
      if (selection.selected.length === 0) throw new Error('No detected writer targets');
      expected = selection.selected.flatMap((writer) => pluginSelection.selected.map((plugin) => ({ plugin: plugin.name, target: writer.id })));
      activeTarget = expected[0]?.target ?? '*';
      activePlugin = expected[0]?.plugin ?? '*';
      let state = readState();
      for (const w of selection.selected) {
        activeTarget = w.id;
        for (const plugin of pluginSelection.selected) {
          activePlugin = plugin.name;
          const nativeId = plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name;
          if (flags.dryRun) {
            if (json) await withoutConsole(() => w.add(plugin, resolved, { dryRun: true, adoptExisting: flags.adoptExisting }));
            else await w.add(plugin, resolved, { dryRun: true, adoptExisting: flags.adoptExisting });
            outcomes.push({ plugin: plugin.name, target: w.id, status: 'installed', action: 'install', dryRun: true, nativeId });
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
            writeState(pendingState);
            state = pendingState;
            const writerResult = await w.add(plugin, resolved, { dryRun: false, adoptExisting: flags.adoptExisting });
            const installed = w.listInstalled();
            const expectedMarketplace = plugin.marketplace ?? 'local';
            const match = installed.find(p => expectedIds.has(p.id) && p.name === plugin.name &&
              (p.marketplace === expectedMarketplace || (expectedMarketplace === 'local' && p.marketplace === undefined)) && p.enabled !== false);
            if (match?.path === undefined) throw new Error(`native install readback is missing ${nativeId}`);
            const finalized: InstallRecord = {
              ...rec,
              id: match?.id ?? nativeId,
              source: resolved.sourceUri,
              sourceSha: resolved.sha,
              installedAt: new Date().toISOString(),
              sourceDir: plugin.sourceDir ?? plugin.dir,
              installedFingerprint: fingerprintInstallation(match),
              ...(plugin.contentFingerprint !== undefined ? { fingerprint: plugin.contentFingerprint } : {}),
            };
            delete finalized.pending;
            const finalizedState = state.map((candidate) => candidate === rec ? finalized : candidate);
            writeState(finalizedState);
            state = finalizedState;
            outcomes.push({ plugin: plugin.name, target: w.id, status: writerResult === 'unchanged' ? 'unchanged' : 'installed', action: 'install', dryRun: false, nativeId: match.id });
          }
        }
      }
      printOutcomes(outcomes, json);
    } catch (e: any) {
      const reported = new Set(outcomes.map((outcome) => `${outcome.plugin}\u0000${outcome.target}`));
      const failures: InstallOutcome[] = [];
      if (expected.length === 0) {
          failures.push({ plugin: '*', target: e instanceof CompatibilityError ? e.target : activeTarget, status: e instanceof CompatibilityError ? e.status : 'failed', action: 'install', dryRun: flags.dryRun, diagnostic: e.message });
      } else {
        for (const pair of expected) {
          const key = `${pair.plugin}\u0000${pair.target}`;
          if (reported.has(key)) continue;
          failures.push({
            plugin: pair.plugin,
            target: pair.target,
            status: e instanceof CompatibilityError && pair.target === e.target ? e.status : 'failed',
            action: 'install',
            dryRun: flags.dryRun,
            diagnostic: pair.plugin === activePlugin && pair.target === activeTarget ? e.message : 'not attempted after an earlier install failure',
          });
        }
      }
      if (json) printOutcomes([...outcomes, ...failures], true);
      else console.error(e.message);
      return 1;
    }
    return 0;
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
    if (rejectDisallowed(flags, new Set(['target', 'dryRun'])) || flags.positionals.length > 1) fail(`plugnz update: unexpected argument: ${flags.positionals[1]}`, 2);
    const profileSelection = selectProfiles(flags.targets);
    if (profileSelection.error) {
      printOutcomes(flags.targets.map((target) => ({ plugin: flags.positionals[0] ?? '*', target, status: 'failed', dryRun: flags.dryRun, diagnostic: profileSelection.error })), json);
      return 2;
    }
    const incompatible = compatibilityOutcomes(profileSelection.selected, [flags.positionals[0] ?? '*'], 'update', flags.dryRun);
    if (incompatible !== undefined) {
      printOutcomes(incompatible, json);
      return 1;
    }
    const selection = flags.targets.length === 0
      ? select(writers, [])
      : select(writers, profileSelection.selected.map((profile) => profile.id));
    if (selection.error) {
      printOutcomes(profileSelection.selected.map((profile) => ({ plugin: flags.positionals[0] ?? '*', target: profile.id, status: 'failed', dryRun: flags.dryRun, diagnostic: selection.error })), json);
      return 2;
    }
    if (selection.selected.length === 0) {
      printOutcomes([{ plugin: flags.positionals[0] ?? '*', target: '*', status: 'failed', dryRun: flags.dryRun, diagnostic: 'No detected writer targets' }], json);
      return 1;
    }
    try {
      const result = json && flags.dryRun
        ? await withoutConsole(() => runUpdate(flags.positionals[0], { dryRun: true, writers: selection.selected }))
        : await runUpdate(flags.positionals[0], { dryRun: flags.dryRun, writers: selection.selected });
      if (json) printOutcomes(result.findings.map((finding) => ({ plugin: flags.positionals[0] ?? '*', target: finding.host, status: finding.status ?? (finding.mark === '✓' ? 'installed' : finding.mark === '!' ? 'unverified' : 'failed'), action: 'update', dryRun: flags.dryRun, diagnostic: finding.message })), true);
      else printFindings(result.findings, false);
      return result.exitCode;
    } catch (error) {
      printOutcomes([{ plugin: flags.positionals[0] ?? '*', target: '*', status: 'failed', action: 'update', dryRun: flags.dryRun, diagnostic: (error as Error).message }], json);
      return 1;
    }
  }

  fail(`plugnz: unknown verb '${verb}'\n\n${USAGE}`, 2);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('cli.ts')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
