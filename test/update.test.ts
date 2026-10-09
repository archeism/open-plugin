/**
 * `update` fixture tests.
 *
 * The recorded source in `state.json` is the whole input: each test builds a
 * real git repo (the stand-in for a marketplace checkout), records it, then
 * moves the repo on and checks that `update` re-materializes the host's copy,
 * refreshes the ledger and re-applies recorded pins.
 *
 * Tests never touch the real home (AGENTS.md): every path comes from a
 * materialized fixture home via `OPEN_PLUGIN_HOME`.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runUpdate } from '../src/update';
import { main } from '../src/cli';
import { readState } from '../src/state';
import { kimiWriter } from '../src/hosts/kimi-writer';
import type { HostWriter } from '../src/host';
import type { InstallRecord } from '../src/state';
import { CompatibilityError } from '../src/compatibility';
import { commitAll, fakeBin, initGitRepo, materialize, materializeInto, repoRoot, withHostEnvAsync, withPathPrefix, writeFiles, writeLedger } from './util';
import { kimiNativeEnv, resetKimiNativeStore, withKimiNative } from './kimi-fixture';
import { parseLifecycleReport } from '../src/lifecycle-report';
import { writers } from '../src/hosts/writers';

const plannedNativeId: HostWriter['plannedNativeId'] = (plugin) => plugin.name;

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

function mcpJson(servers: Record<string, { type: string; command: string }>): string {
  return JSON.stringify({ $schema: SCHEMA, mcpServers: servers }, null, 2);
}

/** A source repo holding one plugin (`<plugin>/plugin.json` + `mcp.json`). */
function sourceRepo(dir: string, plugin: string, servers: Record<string, { type: string; command: string }>): string {
  return initGitRepo(dir, {
    [`${plugin}/plugin.json`]: JSON.stringify({ $schema: SCHEMA, name: plugin, version: '1.0.0' }, null, 2),
    [`${plugin}/mcp.json`]: mcpJson(servers),
  });
}

function kimiManaged(home: string, plugin = 'demo-plugin'): string {
  return join(home, '.kimi-code', 'plugins', 'managed', plugin);
}

describe('update · re-add from the recorded source', () => {
  test('reports a target detection exception as a preflight defect', async () => {
    await withHostEnvAsync('codex', async () => {
      const originalWriters = [...writers];
      const exploding: HostWriter = {
        id: 'codex',
        gui: false, plannedNativeId,
        detect: () => { throw ''; },
        stores: () => [],
        listInstalled: () => [],
        mcpEntries: () => [],
        add: async () => {},
        remove: async () => {},
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const output: string[] = [];
      const originalLog = console.log;
      writers.splice(0, writers.length, exploding);
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['update', '--target', 'codex', '--json'])).toBe(1);
      } finally {
        writers.splice(0, writers.length, ...originalWriters);
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect(report.outcomes).toEqual([]);
      expect(report.summary).toEqual({
        result: 'incomplete',
        terminalPhase: 'preflight',
        mutationStarted: false,
        changed: false,
        failureCategory: 'internal',
        reason: {
          category: 'internal',
          code: 'internal.defect',
          diagnostic: 'unknown thrown value',
          capabilityId: null,
          evidenceId: null,
        },
        recoveryId: null,
        readbackId: null,
      });
    });
  });

  test('rejects a name outside the frozen target inventory before reading the ledger', async () => {
    await withHostEnvAsync('kimi', async () => {
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['update', '--target', 'not-a-target', '--json'])).toBe(2);
      } finally { console.log = originalLog; }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect(report.summary.result).toBe('usage-error');
      expect(report.summary.reason?.code).toBe('usage.invalid-selection');
      expect(report.summary.reason?.diagnostic).toContain("unknown target 'not-a-target'");
      expect(readState()).toEqual([]);
    });
  });

  test('accepts the active Hermes adapter and reports an empty ledger without mutation', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      writeFiles(join(home, '.hermes'), { 'plugins/.keep': '' });
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['update', '--target', 'hermes', '--json'])).toBe(0);
      } finally { console.log = originalLog; }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect(report.outcomes).toEqual([]);
      expect(report.summary.result).toBe('converged');
      expect(report.command.dryRun).toBe(false);
      expect(readState()).toEqual([]);
    });
  });

  test('refuses cleanup-only Pi updates without reading or changing its recorded install', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      writeLedger(home, [{ host: 'pi', id: 'demo-plugin', source: '/must-not-read', sourceSha: 'old', ownership: 'plgnz' }]);
      const before = readFileSync(join(home, 'state.json'), 'utf8');
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['update', '--target', 'pi', '--json'])).toBe(1);
      } finally { console.log = originalLog; }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect(report.outcomes).toEqual([]);
      expect(report.summary.reason?.code).toBe('capability.unsupported');
      expect(report.summary.reason?.diagnostic).toContain('unsupported for update');
      expect(readFileSync(join(home, 'state.json'), 'utf8')).toBe(before);
    });
  });

  test('selected writers leave records for other hosts untouched', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      await withKimiNative(home, async () => {
      const repo = join(home, 'src-repo');
      const sha = sourceRepo(repo, 'demo-plugin', { tool: { type: 'stdio', command: '/bin/echo' } });
      writeLedger(home, [
        { host: 'kimi', id: 'demo-plugin', source: repo, sourceSha: sha },
        { host: 'cursor', id: 'demo-plugin', source: repo, sourceSha: sha },
      ]);
      const result = await runUpdate(undefined, { writers: [kimiWriter] });
      expect(result.exitCode).toBe(0);
      expect(result.findings.some((finding) => finding.host === 'cursor')).toBe(false);
      expect(readState().find((record) => record.host === 'cursor')?.sourceSha).toBe(sha);
      });
    });
  });

  test('finalizes each successful target and leaves a durable pending intent for a later failure', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      const repo = join(home, 'src-repo');
      const sha = initGitRepo(repo, {
        'good/plugin.json': JSON.stringify({ name: 'good' }),
        'bad/plugin.json': JSON.stringify({ name: 'bad' }),
      });
      writeLedger(home, [
        { host: 'good-host', id: 'good', source: repo, sourceSha: sha },
        { host: 'bad-host', id: 'bad', source: repo, sourceSha: sha },
      ]);
      const base = {
        gui: false, plannedNativeId,
        detect: () => true,
        stores: () => [],
        listInstalled: () => [],
        mcpEntries: () => [],
        remove: async () => {},
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const good = { ...base, id: 'good-host', listInstalled: () => [{ id: 'good', name: 'good', enabled: true, path: join(repo, 'good') }], add: async () => {} } as HostWriter;
      const bad = { ...base, id: 'bad-host', add: async () => { throw new Error('later target failed'); } } as HostWriter;

      const result = await runUpdate(undefined, { writers: [good, bad] });
      expect(result.exitCode).toBe(1);
      const state = readState();
      expect(state.find((record) => record.host === 'good-host')?.pending).toBeUndefined();
      expect(state.find((record) => record.host === 'bad-host')?.pending).toBe('install');
    });
  });

  test('reclassifies a post-intent writer refusal as recovery-required', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      const repo = join(home, 'src-repo');
      const sha = sourceRepo(repo, 'demo-plugin', { tool: { type: 'stdio', command: '/bin/echo' } });
      const writer: HostWriter = {
        id: 'compat-host', gui: false, plannedNativeId, detect: () => true, stores: () => [], listInstalled: () => [], mcpEntries: () => [],
        add: async () => { throw new CompatibilityError('compat-host', 'update', 'unverified', 'test evidence'); },
        remove: async () => {}, pin: async () => ({ changes: [], refusals: [] }),
      };
      const result = await runUpdate(undefined, {
        state: [{ host: 'compat-host', id: 'demo-plugin', source: repo, sourceSha: sha }],
        writers: [writer],
        writeState: () => {},
      });
      expect({
        exitCode: result.exitCode,
        mutationStarted: result.mutationStarted,
        reasonCode: result.findings[0]?.reasonCode,
        terminalPhase: result.findings[0]?.terminalPhase,
        findingMutationStarted: result.findings[0]?.mutationStarted,
        message: result.findings[0]?.message,
      }).toEqual({
        exitCode: 1,
        mutationStarted: true,
        reasonCode: 'recovery.required',
        terminalPhase: 'apply',
        findingMutationStarted: true,
        message: "re-add of 'demo-plugin' refused after pending intent was persisted — target 'compat-host' is unverified for update; evidence: test evidence",
      });
    });
  });

  test('stops later updates and preserves their frozen plan rows after a post-intent refusal', async () => {
    await withHostEnvAsync('cursor', async (home) => {
      const repo = join(home, 'src-public-compatibility-refusal');
      const sha = sourceRepo(repo, 'demo-plugin', { tool: { type: 'stdio', command: '/bin/echo' } });
      writeLedger(home, [
        { host: 'cursor', id: 'demo-plugin', source: repo, sourceSha: sha },
        { host: 'kimi', id: 'demo-plugin', source: repo, sourceSha: sha },
      ]);
      let laterAddCalls = 0;
      const refusing: HostWriter = {
        id: 'cursor', gui: false, plannedNativeId, detect: () => true, stores: () => [], listInstalled: () => [], mcpEntries: () => [],
        add: async () => { throw new CompatibilityError('cursor', 'update', 'unverified', 'test evidence'); },
        remove: async () => {}, pin: async () => ({ changes: [], refusals: [] }),
      };
      const later: HostWriter = {
        id: 'kimi', gui: false, plannedNativeId, detect: () => true, stores: () => [],
        listInstalled: () => [{ id: 'demo-plugin', name: 'demo-plugin', enabled: true, path: join(repo, 'demo-plugin') }],
        mcpEntries: () => [],
        add: async () => { laterAddCalls += 1; },
        remove: async () => {}, pin: async () => ({ changes: [], refusals: [] }),
      };
      const originalWriters = [...writers];
      const output: string[] = [];
      const originalLog = console.log;
      writers.splice(0, writers.length, refusing, later);
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['update', 'demo-plugin', '--target', 'cursor', '--target', 'kimi', '--json'])).toBe(1);
      } finally {
        writers.splice(0, writers.length, ...originalWriters);
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect({
        laterAddCalls,
        plan: report.plan.map(({ action, route }) => ({ action, route })),
        outcomes: report.outcomes.map(({ result, action, route, resourceState, reason }) => ({
          result,
          action,
          route,
          resourceState,
          reason,
        })),
        summary: report.summary,
        pending: readState().map(({ host, pending }) => ({ host, pending })),
      }).toEqual({
        laterAddCalls: 0,
        plan: [
          { action: 'update', route: 'managed' },
          { action: 'update', route: 'managed' },
        ],
        outcomes: [{
          result: 'pending',
          action: 'update',
          route: 'managed',
          resourceState: 'potentially-changed',
          reason: {
            category: 'recovery',
            code: 'recovery.required',
            diagnostic: "re-add of 'demo-plugin' refused after pending intent was persisted — target 'cursor' is unverified for update; evidence: test evidence",
            capabilityId: null,
            evidenceId: null,
          },
        }, {
          result: 'not-attempted',
          action: 'update',
          route: 'managed',
          resourceState: 'unknown',
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: 'not attempted after an earlier update failure',
            capabilityId: null,
            evidenceId: null,
          },
        }],
        summary: {
          result: 'incomplete',
          terminalPhase: 'apply',
          mutationStarted: true,
          changed: false,
          failureCategory: 'recovery',
          reason: {
            category: 'recovery',
            code: 'recovery.required',
            diagnostic: "re-add of 'demo-plugin' refused after pending intent was persisted — target 'cursor' is unverified for update; evidence: test evidence",
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: report.plan[0]!.operationId,
          readbackId: null,
        },
        pending: [
          { host: 'cursor', pending: 'install' },
          { host: 'kimi', pending: undefined },
        ],
      });
    });
  });

  test('classifies a pin inventory exception as a readback failure', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      const repo = join(home, 'src-pin-readback-failure');
      const sha = sourceRepo(repo, 'demo-plugin', { tool: { type: 'stdio', command: '/bin/echo' } });
      const writer: HostWriter = {
        id: 'pin-host',
        gui: false, plannedNativeId,
        detect: () => true,
        stores: () => [],
        listInstalled: () => { throw new Error('forced pin inventory failure'); },
        mcpEntries: () => [],
        add: async () => {},
        remove: async () => {},
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const result = await runUpdate(undefined, {
        state: [{ host: 'pin-host', id: 'demo-plugin', source: repo, sourceSha: sha, pins: ['tool'] }],
        writers: [writer],
        writeState: () => {},
      });
      expect({
        exitCode: result.exitCode,
        reasonCode: result.findings[0]?.reasonCode,
        terminalPhase: result.findings[0]?.terminalPhase,
        changed: result.findings[0]?.changed,
        message: result.findings[0]?.message,
      }).toEqual({
        exitCode: 1,
        reasonCode: 'readback.failed',
        terminalPhase: 'readback',
        changed: true,
        message: "cannot inspect 'demo-plugin' before re-applying pins — forced pin inventory failure",
      });
    });
  });

  test('does not flush a failed finalization as complete while finalizing a later record', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      const repo = join(home, 'src-repo');
      const sha = initGitRepo(repo, {
        'first/plugin.json': JSON.stringify({ name: 'first' }),
        'second/plugin.json': JSON.stringify({ name: 'second' }),
      });
      const initial: InstallRecord[] = [
        { host: 'first-host', id: 'first', source: repo, sourceSha: sha },
        { host: 'second-host', id: 'second', source: repo, sourceSha: sha },
      ];
      const copy = (records: InstallRecord[]): InstallRecord[] => JSON.parse(JSON.stringify(records)) as InstallRecord[];
      let durable = copy(initial);
      let writes = 0;
      const writer = (id: string): HostWriter => ({
        id, gui: false, plannedNativeId, detect: () => true, stores: () => [], listInstalled: () => [{ id: id.replace('-host', ''), name: id.replace('-host', ''), enabled: true, path: join(repo, id.replace('-host', '')) }], mcpEntries: () => [],
        add: async () => {}, remove: async () => {}, pin: async () => ({ changes: [], refusals: [] }),
      });
      const result = await runUpdate(undefined, {
        state: copy(initial),
        writers: [writer('first-host'), writer('second-host')],
        writeState: (records) => {
          writes += 1;
          if (writes === 2) throw new Error('forced first finalization write failure');
          durable = copy(records);
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.findings.find((finding) => finding.host === 'first-host')?.terminalPhase).toBe('finalize');
      expect(result.findings.find((finding) => finding.host === 'first-host')?.changed).toBe(true);
      expect(result.findings.find((finding) => finding.host === 'first-host')?.reasonCode).toBe('recovery.required');
      expect(durable.find((record) => record.host === 'first-host')?.pending).toBe('install');
      expect(durable.find((record) => record.host === 'second-host')?.pending).toBeUndefined();
    });
  });

  test('reports update readback and final-ledger failures in their exact terminal phases', async () => {
    for (const scenario of ['readback', 'finalize'] as const) {
      await withHostEnvAsync('cursor', async (home) => {
        const repo = join(home, `src-${scenario}`);
        const sha = sourceRepo(repo, 'demo-plugin', { tool: { type: 'stdio', command: '/bin/echo' } });
        writeLedger(home, [{ host: 'cursor', id: 'demo-plugin', source: repo, sourceSha: sha }]);
        const originalWriters = [...writers];
        const writer: HostWriter = {
          id: 'cursor',
          gui: false, plannedNativeId,
          detect: () => true,
          stores: () => [],
          listInstalled: () => {
            if (scenario === 'readback') throw new Error('forced update inventory failure');
            chmodSync(home, 0o555);
            return [{ id: 'demo-plugin', name: 'demo-plugin', enabled: true, path: join(repo, 'demo-plugin') }];
          },
          mcpEntries: () => [],
          add: async () => {},
          remove: async () => {},
          pin: async () => ({ changes: [], refusals: [] }),
        };
        const output: string[] = [];
        const originalLog = console.log;
        writers.splice(0, writers.length, writer);
        console.log = (value: string) => output.push(value);
        let code: number;
        try {
          code = await main(['update', 'demo-plugin', '--target', 'cursor', '--json']);
        } finally {
          chmodSync(home, 0o755);
          writers.splice(0, writers.length, ...originalWriters);
          console.log = originalLog;
        }
        const report = parseLifecycleReport(JSON.parse(output.join('')));
        expect({
          code,
          result: report.outcomes[0]?.result,
          changed: report.outcomes[0]?.changed,
          resourceState: report.outcomes[0]?.resourceState,
          activationState: report.outcomes[0]?.activationState,
          reasonCode: report.outcomes[0]?.reason?.code,
          terminalPhase: report.summary.terminalPhase,
          mutationStarted: report.summary.mutationStarted,
          recoveryId: report.summary.recoveryId,
          readbackId: report.summary.readbackId,
        }).toEqual({
          code: 1,
          result: 'pending',
          changed: true,
          resourceState: scenario === 'readback' ? 'potentially-changed' : 'present',
          activationState: scenario === 'readback' ? 'unknown' : 'active-conforming',
          reasonCode: scenario === 'readback' ? 'readback.failed' : 'recovery.required',
          terminalPhase: scenario,
          mutationStarted: true,
          recoveryId: report.plan[0]!.operationId,
          readbackId: scenario === 'readback' ? report.plan[0]!.operationId : null,
        });
      });
    }
  });

  test('preserves completed outcomes when a later host probe fails', async () => {
    await withHostEnvAsync('cursor', async (home) => {
      const repo = join(home, 'src-late-probe-failure');
      const sha = initGitRepo(repo, {
        'first/plugin.json': JSON.stringify({ name: 'first', version: '1.0.0' }),
        'second/plugin.json': JSON.stringify({ name: 'second', version: '1.0.0' }),
      });
      writeLedger(home, [
        { host: 'cursor', id: 'first', source: repo, sourceSha: sha },
        { host: 'kimi', id: 'second', source: repo, sourceSha: sha },
      ]);
      const originalWriters = [...writers];
      const writer = (id: 'cursor' | 'kimi', plugin: 'first' | 'second', failThirdProbe = false): HostWriter => {
        let probes = 0;
        return {
          id,
          gui: false, plannedNativeId,
          detect: () => {
            probes += 1;
            if (failThirdProbe && probes === 3) throw new Error('forced late host probe failure');
            return true;
          },
          stores: () => [],
          listInstalled: () => [{ id: plugin, name: plugin, enabled: true, path: join(repo, plugin) }],
          mcpEntries: () => [],
          add: async () => {},
          remove: async () => {},
          pin: async () => ({ changes: [], refusals: [] }),
        };
      };
      const output: string[] = [];
      const originalLog = console.log;
      writers.splice(0, writers.length, writer('cursor', 'first'), writer('kimi', 'second', true));
      console.log = (value: string) => output.push(value);
      let code: number;
      try {
        code = await main(['update', '--target', 'cursor', '--target', 'kimi', '--json']);
      } finally {
        writers.splice(0, writers.length, ...originalWriters);
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect({
        code,
        outcomes: report.outcomes.map((outcome) => ({
          package: outcome.package,
          result: outcome.result,
          changed: outcome.changed,
          resourceState: outcome.resourceState,
        })),
        summary: report.summary,
      }).toEqual({
        code: 1,
        outcomes: [
          { package: 'first', result: 'succeeded', changed: true, resourceState: 'present' },
          { package: 'second', result: 'failed', changed: false, resourceState: 'unknown' },
        ],
        summary: {
          result: 'incomplete',
          terminalPhase: 'apply',
          mutationStarted: true,
          changed: true,
          failureCategory: 'runtime',
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: "host detection for 'second' failed — forced late host probe failure",
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
      });
    });
  });

  test('preserves a later completed outcome when an earlier source cannot resolve', async () => {
    await withHostEnvAsync('cursor', async (home) => {
      const repo = join(home, 'src-after-resolve-failure');
      const sha = initGitRepo(repo, {
        'plugin.json': JSON.stringify({ name: 'second', version: '1.0.0' }),
      });
      writeLedger(home, [
        { host: 'cursor', id: 'first', source: join(home, 'missing-source'), sourceSha: 'missing' },
        { host: 'kimi', id: 'second', source: repo, sourceSha: sha },
      ]);
      const originalWriters = [...writers];
      const writer = (id: 'cursor' | 'kimi', plugin: 'first' | 'second'): HostWriter => ({
        id,
        gui: false, plannedNativeId,
        detect: () => true,
        stores: () => [],
        listInstalled: () => [{ id: plugin, name: plugin, enabled: true, path: repo }],
        mcpEntries: () => [],
        add: async () => {},
        remove: async () => {},
        pin: async () => ({ changes: [], refusals: [] }),
      });
      const output: string[] = [];
      const originalLog = console.log;
      writers.splice(0, writers.length, writer('cursor', 'first'), writer('kimi', 'second'));
      console.log = (value: string) => output.push(value);
      let code: number;
      try {
        code = await main(['update', '--target', 'cursor', '--target', 'kimi', '--json']);
      } finally {
        writers.splice(0, writers.length, ...originalWriters);
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect({
        code,
        outcomes: report.outcomes.map(({ package: packageName, result, changed, reason }) => ({ package: packageName, result, changed, reasonCode: reason?.code })),
        summary: report.summary,
      }).toEqual({
        code: 1,
        outcomes: [
          { package: 'first', result: 'failed', changed: false, reasonCode: 'runtime.operation-failed' },
          { package: 'second', result: 'succeeded', changed: true, reasonCode: undefined },
        ],
        summary: {
          result: 'incomplete',
          terminalPhase: 'apply',
          mutationStarted: true,
          changed: true,
          failureCategory: 'runtime',
          reason: report.outcomes[0]!.reason,
          recoveryId: null,
          readbackId: null,
        },
      });
    });
  });

  test('keeps distinct legacy package identities when native ids share one logical name', async () => {
    await withHostEnvAsync('cursor', async (home) => {
      const repo = join(home, 'src-distinct-legacy-identities');
      const sha = initGitRepo(repo, {
        'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      });
      writeLedger(home, [
        { host: 'cursor', id: 'demo@one', source: repo, sourceSha: sha },
        { host: 'cursor', id: 'demo@two', source: repo, sourceSha: sha },
      ]);
      const originalWriters = [...writers];
      let addCalls = 0;
      const writer: HostWriter = {
        id: 'cursor',
        gui: false, plannedNativeId,
        detect: () => true,
        stores: () => [],
        listInstalled: () => [
          { id: 'demo@one', name: 'demo', marketplace: 'one', enabled: true, path: repo },
          { id: 'demo@two', name: 'demo', marketplace: 'two', enabled: true, path: repo },
        ],
        mcpEntries: () => [],
        add: async () => { addCalls += 1; },
        remove: async () => {},
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const output: string[] = [];
      const originalLog = console.log;
      writers.splice(0, writers.length, writer);
      console.log = (value: string) => output.push(value);
      let code: number;
      try {
        code = await main(['update', '--target', 'cursor', '--json']);
      } finally {
        writers.splice(0, writers.length, ...originalWriters);
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect({
        code,
        addCalls,
        packages: report.outcomes.map((outcome) => outcome.package),
        nativeIds: report.outcomes.map((outcome) => outcome.nativeId),
        results: report.outcomes.map((outcome) => outcome.result),
        summary: report.summary,
      }).toEqual({
        code: 0,
        addCalls: 2,
        packages: ['demo@one', 'demo@two'],
        nativeIds: ['demo@one', 'demo@two'],
        results: ['succeeded', 'succeeded'],
        summary: {
          result: 'converged',
          terminalPhase: 'complete',
          mutationStarted: true,
          changed: true,
          failureCategory: null,
          reason: null,
          recoveryId: null,
          readbackId: null,
        },
      });
    });
  });

  test('reports pin rewrites independently from native unchanged and pin refusal', async () => {
    for (const scenario of [
      { name: 'applied', dryRun: false, refusal: false, result: 'succeeded', changed: true, mutationStarted: true, terminalPhase: 'complete' },
      { name: 'planned', dryRun: true, refusal: false, result: 'succeeded', changed: false, mutationStarted: false, terminalPhase: 'complete' },
      { name: 'partial', dryRun: false, refusal: true, result: 'pending', changed: true, mutationStarted: true, terminalPhase: 'finalize' },
    ] as const) {
      await withHostEnvAsync('cursor', async (home) => {
        const repo = join(home, `src-pin-${scenario.name}`);
        const sha = initGitRepo(repo, { 'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }) });
        writeLedger(home, [{ host: 'cursor', id: 'demo', source: repo, sourceSha: sha, pins: ['tool'] }]);
        const originalWriters = [...writers];
        const observedDryRuns: Array<boolean | undefined> = [];
        const writer: HostWriter = {
          id: 'cursor',
          gui: false, plannedNativeId,
          detect: () => true,
          stores: () => [],
          listInstalled: () => [{ id: 'demo', name: 'demo', enabled: true, path: repo }],
          mcpEntries: () => [],
          add: async (): Promise<'unchanged'> => 'unchanged',
          remove: async () => {},
          pin: async (_plugin, options) => {
            observedDryRuns.push(options?.dryRun);
            return {
              changes: [{ server: 'tool', from: 'tool', to: '/fixture/tool', file: join(repo, 'mcp.json') }],
              refusals: scenario.refusal ? [{ server: 'other', command: 'missing', file: join(repo, 'mcp.json') }] : [],
            };
          },
        };
        const output: string[] = [];
        const originalLog = console.log;
        writers.splice(0, writers.length, writer);
        console.log = (value: string) => output.push(value);
        let code: number;
        try {
          code = await main([
            'update',
            'demo',
            '--target',
            'cursor',
            ...(scenario.dryRun ? ['--dry-run'] : []),
            '--json',
          ]);
        } finally {
          writers.splice(0, writers.length, ...originalWriters);
          console.log = originalLog;
        }
        const report = parseLifecycleReport(JSON.parse(output.join('')));
        expect({
          code,
          observedDryRuns,
          action: report.outcomes[0]?.action,
          result: report.outcomes[0]?.result,
          changed: report.outcomes[0]?.changed,
          resourceState: report.outcomes[0]?.resourceState,
          reasonCode: report.outcomes[0]?.reason?.code,
          terminalPhase: report.summary.terminalPhase,
          mutationStarted: report.summary.mutationStarted,
          summaryChanged: report.summary.changed,
          recoveryId: report.summary.recoveryId,
        }).toEqual({
          code: scenario.refusal ? 1 : 0,
          observedDryRuns: [scenario.dryRun],
          action: 'update',
          result: scenario.result,
          changed: scenario.changed,
          resourceState: scenario.refusal ? 'potentially-changed' : 'present',
          reasonCode: scenario.refusal ? 'recovery.required' : undefined,
          terminalPhase: scenario.terminalPhase,
          mutationStarted: scenario.mutationStarted,
          summaryChanged: scenario.changed,
          recoveryId: scenario.refusal ? report.plan[0]!.operationId : null,
        });
      });
    }
  });

  test('actual CLI emits clean JSON for update dry-run', () => {
    const { home, env } = materialize('kimi');
    resetKimiNativeStore(home);
    const repo = join(home, 'src-repo');
    const sha = sourceRepo(repo, 'demo-plugin', { tool: { type: 'stdio', command: '/bin/echo' } });
    writeLedger(home, [{ host: 'kimi', id: 'demo-plugin', source: repo, sourceSha: sha }]);
    const result = spawnSync('bun', [join(repoRoot, 'bin', 'plgnz.mjs'), 'update', '--target', 'kimi', '--dry-run', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, ...env, ...kimiNativeEnv(home) },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(parseLifecycleReport(JSON.parse(result.stdout)).summary.result).toBe('converged');
  });

  test('actual CLI reports corrupt state with its dedicated JSON reason code', () => {
    const { home, env } = materialize('kimi');
    writeFileSync(join(home, 'state.json'), '{not json');
    const result = spawnSync('bun', [join(repoRoot, 'bin', 'plgnz.mjs'), 'update', '--target', 'kimi', '--json'], {
      cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const report = parseLifecycleReport(JSON.parse(result.stdout));
    expect(report.outcomes).toEqual([]);
    expect(report.summary.reason?.code).toBe('internal.corrupt-state');
    expect(report.summary.reason?.diagnostic).toContain('Invalid state.json');
  });

  test('public update canonicalizes a Kimi marketplace ledger and historical bare marker', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      await withKimiNative(home, async () => {
        const repo = join(home, 'kimi-marketplace-source');
        const sha = initGitRepo(repo, {
          '.claude-plugin/marketplace.json': JSON.stringify({
            name: 'personal',
            plugins: [{ name: 'demo', source: './plugins/demo' }],
          }),
          'plugins/demo/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
        });
        expect(await main(['add', repo, '--target', 'kimi'])).toBe(0);
        const marker = join(home, '.kimi-code', 'plugins', 'managed', 'demo', '.plgnz-install.json');
        const ownership = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
        writeFileSync(marker, JSON.stringify({ ...ownership, pluginId: 'demo' }));
        writeLedger(home, [{ host: 'kimi', id: 'demo', source: repo, sourceSha: sha }]);

        const output: string[] = [];
        const originalLog = console.log;
        console.log = (value: string) => output.push(value);
        let exitCode: number;
        try {
          exitCode = await main(['update', 'demo', '--target', 'kimi', '--json']);
        } finally {
          console.log = originalLog;
        }
        const report = parseLifecycleReport(JSON.parse(output.join('')));
        expect({
          exitCode,
          plan: report.plan.map(({ nativeId }) => nativeId),
          outcomes: report.outcomes.map(({ nativeId, result }) => ({ nativeId, result })),
          records: readState().map(({ id, pending }) => ({ id, pending })),
          markerId: (JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>).pluginId,
        }).toEqual({
          exitCode: 0,
          plan: ['demo@personal'],
          outcomes: [{ nativeId: 'demo@personal', result: 'succeeded' }],
          records: [{ id: 'demo@personal', pending: undefined }],
          markerId: 'demo@personal',
        });
      });
    });
  });

  test('kimi: re-materializes the copy and advances the recorded sha', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      await withKimiNative(home, async () => {
      const repo = join(home, 'src-repo');
      const sha1 = sourceRepo(repo, 'demo-plugin', { 'from-repo-v1': { type: 'stdio', command: '/bin/echo' } });
      const managed = kimiManaged(home);
      expect(await main(['add', repo, '--target', 'kimi'])).toBe(0);
      writeFileSync(join(managed, 'stale.txt'), 'left by the previous install\n');
      writeLedger(home, [{ host: 'kimi', id: 'demo-plugin', source: repo, sourceSha: sha1 }]);

      writeFiles(repo, { 'demo-plugin/mcp.json': mcpJson({ 'from-repo-v2': { type: 'stdio', command: '/bin/echo' } }) });
      const sha2 = commitAll(repo, 'v2');

      const result = await runUpdate('demo-plugin');

      expect(result.exitCode).toBe(0);
      expect(result.findings.some((f) => f.mark === '✓' && f.message.includes('updated'))).toBe(true);
      expect(readFileSync(join(managed, 'mcp.json'), 'utf8')).toContain('from-repo-v2');
      // a copy-based store is replaced, not merged into
      expect(existsSync(join(managed, 'stale.txt'))).toBe(false);
      const record = readState(join(home, 'state.json')).find((r) => r.host === 'kimi');
      expect(record?.sourceSha).toBe(sha2);
      expect(record?.sourceDir?.endsWith('/src-repo/demo-plugin')).toBe(true);
      expect(record?.installedFingerprint === undefined).toBe(false);
      });
    });
  });

  test('without a name every recorded install is updated', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      await withKimiNative(home, async () => {
      materializeInto(home, 'cursor');
      const repo = join(home, 'src-repo');
      const sha = sourceRepo(repo, 'demo-plugin', { 'from-repo': { type: 'stdio', command: '/bin/echo' } });
      // The materialized Cursor fixture is deliberately unowned. Adopt it
      // through the public route before asking `update` to re-materialize it.
      expect(await main(['add', repo, '--target', 'cursor', '--adopt-existing'])).toBe(0);
      writeLedger(home, [
        { host: 'kimi', id: 'demo-plugin', source: repo, sourceSha: sha },
        { host: 'cursor', id: 'demo-plugin', source: repo, sourceSha: sha },
      ]);

      const result = await runUpdate();

      expect(result.exitCode).toBe(0);
      expect(result.findings.filter((f) => f.mark === '✓').map((f) => f.host).sort()).toEqual(['cursor', 'kimi']);
      expect(readFileSync(join(home, '.cursor', 'plugins', 'local', 'demo-plugin', 'mcp.json'), 'utf8')).toContain('from-repo');
      });
    });
  });

  test('--dry-run reports the update and writes nothing', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      await withKimiNative(home, async () => {
      const repo = join(home, 'src-repo');
      const sha = sourceRepo(repo, 'demo-plugin', { 'from-repo': { type: 'stdio', command: '/bin/echo' } });
      const managed = kimiManaged(home);
      expect(await main(['add', repo, '--target', 'kimi'])).toBe(0);
      const before = readFileSync(join(managed, 'mcp.json'), 'utf8');
      writeLedger(home, [{ host: 'kimi', id: 'demo-plugin', source: repo, sourceSha: sha }]);

      const result = await runUpdate('demo-plugin', { dryRun: true });

      expect(result.exitCode).toBe(0);
      expect(result.findings.some((f) => f.message.startsWith('[dry-run] '))).toBe(true);
      expect(readFileSync(join(managed, 'mcp.json'), 'utf8')).toBe(before);
      expect(readState(join(home, 'state.json'))[0]?.sourceSha).toBe(sha);
      });
    });
  });
});

describe('update · pins', () => {
  test('re-applies a recorded pin to the fresh copy', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      await withKimiNative(home, async () => {
      const repo = join(home, 'src-repo');
      const sha = sourceRepo(repo, 'demo-plugin', { 'local-tool': { type: 'stdio', command: 'fixture-mcp' } });
      expect(await main(['add', repo, '--target', 'kimi'])).toBe(0);
      writeLedger(home, [
        { host: 'kimi', id: 'demo-plugin', source: repo, sourceSha: sha, pins: ['local-tool'] },
      ]);

      const bin = fakeBin(home, 'fixture-mcp');
      const result = await withPathPrefix(bin, () => runUpdate('demo-plugin'));

      expect(result.exitCode).toBe(0);
      expect(result.findings.some((f) => f.message.includes("re-pinned 'local-tool'"))).toBe(true);
      const copies = ['mcp.json', '.mcp.json'].map((f) => join(kimiManaged(home), f)).filter((f) => existsSync(f));
      expect(copies.length).toBeGreaterThan(0);
      const pinned = JSON.parse(readFileSync(join(kimiManaged(home), 'mcp.json'), 'utf8')) as {
        mcpServers: Record<string, { command: string }>;
      };
      expect(pinned.mcpServers['local-tool']?.command).toBe(join(bin, 'fixture-mcp'));
      });
    });
  });

  test('a pin that no longer resolves is refused, not guessed', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      await withKimiNative(home, async () => {
      const repo = join(home, 'src-repo');
      const sha = sourceRepo(repo, 'demo-plugin', { 'local-tool': { type: 'stdio', command: 'fixture-mcp' } });
      expect(await main(['add', repo, '--target', 'kimi'])).toBe(0);
      writeLedger(home, [
        { host: 'kimi', id: 'demo-plugin', source: repo, sourceSha: sha, pins: ['local-tool'] },
      ]);

      const result = await runUpdate('demo-plugin');

      expect(result.exitCode).toBe(1);
      expect(result.findings.some((f) => f.mark === '✗' && f.message.includes('re-apply the pin'))).toBe(true);
      const copy = JSON.parse(readFileSync(join(kimiManaged(home), 'mcp.json'), 'utf8')) as {
        mcpServers: Record<string, { command: string }>;
      };
      expect(copy.mcpServers['local-tool']?.command).toBe('fixture-mcp');
      });
    });
  });
});

describe('update · refuses what it did not install', () => {
  test('a name with no ledger record is reported, never modified', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      const registry = join(home, '.kimi-code', 'plugins', 'installed.json');
      const before = readFileSync(registry, 'utf8');
      writeLedger(home, []);

      const result = await runUpdate('demo-plugin');

      expect(result.exitCode).toBe(1);
      expect(result.findings[0]?.message).toContain('refusing to modify');
      expect(readFileSync(registry, 'utf8')).toBe(before);
    });
  });

  test('an empty ledger is reported as nothing to do, not as an error', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      const result = await runUpdate();
      expect(result.exitCode).toBe(0);
      expect(result.findings[0]?.message).toContain('nothing to update');
    });
  });

  test('a host that is not on this machine is skipped', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      const repo = join(home, 'src-repo');
      const sha = sourceRepo(repo, 'demo-plugin', { 'from-repo': { type: 'stdio', command: '/bin/echo' } });
      writeLedger(home, [{ host: 'omp', id: 'demo-plugin', source: repo, sourceSha: sha }]);

      const result = await runUpdate('demo-plugin');

      expect(result.exitCode).toBe(0);
      expect(result.findings[0]?.mark).toBe('!');
      expect(result.findings[0]?.message).toContain('not present on this machine');
    });
  });

  test('a source that no longer provides the plugin is reported', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      const repo = join(home, 'src-repo');
      const sha = sourceRepo(repo, 'other-plugin', { tool: { type: 'stdio', command: '/bin/echo' } });
      writeLedger(home, [{ host: 'kimi', id: 'demo-plugin', source: repo, sourceSha: sha }]);

      const result = await runUpdate('demo-plugin');

      expect(result.exitCode).toBe(1);
      expect(result.findings[0]?.message).toContain("no longer provides 'demo-plugin'");
    });
  });
});
