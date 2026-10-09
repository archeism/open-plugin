import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { main } from '../src/cli';
import type { HostWriter } from '../src/host';
import { cleanupWriters, writers } from '../src/hosts/writers';
import { parseLifecycleReport } from '../src/lifecycle-report';
import { readState } from '../src/state';
import { initGitRepo, withHostEnvAsync, writeLedger } from './util';

type Command = 'add' | 'update' | 'remove';

describe('native identity preflight coverage', () => {
  for (const command of ['add', 'update', 'remove'] as const) {
    test(`${command} preserves all selected pairs when identity call 1, 2, or 3 fails`, async () => {
      for (const dryRun of [true, false]) {
        for (const failingHook of ['planned', 'legacy'] as const) {
          for (const throwOn of [1, 2, 3]) {
            await withHostEnvAsync('cursor', async (home) => {
              const source = join(home, `${command}-${failingHook}-${throwOn}-${String(dryRun)}`);
              const sha = initGitRepo(source, {
                'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
              });
              if (command !== 'add') {
                writeLedger(home, ['cursor', 'codex', 'kimi'].map((host) => ({ host, id: 'demo', source, sourceSha: sha })));
              }
              const before = JSON.stringify(readState());
              let plannedCalls = 0;
              let legacyCalls = 0;
              let addCalls = 0;
              let removeCalls = 0;
              const makeWriter = (id: 'cursor' | 'codex' | 'kimi'): HostWriter => ({
                id,
                gui: false,
                plannedNativeId: (plugin) => {
                  plannedCalls += 1;
                  if (failingHook === 'planned' && plannedCalls === throwOn) {
                    if (throwOn === 1) throw undefined;
                    throw new Error(`planned identity failure ${throwOn}`);
                  }
                  return plugin.name;
                },
                legacyNativeIds: () => {
                  legacyCalls += 1;
                  if (failingHook === 'legacy' && legacyCalls === throwOn) {
                    if (throwOn === 1) throw undefined;
                    throw new Error(`legacy identity failure ${throwOn}`);
                  }
                  return [];
                },
                detect: () => true,
                stores: () => [],
                listInstalled: () => [],
                mcpEntries: () => [],
                add: async () => { addCalls += 1; },
                remove: async () => { removeCalls += 1; },
                pin: async () => ({ changes: [], refusals: [] }),
              });
              const injected = [makeWriter('cursor'), makeWriter('codex'), makeWriter('kimi')];
              const registry = command === 'remove' ? cleanupWriters : writers;
              const original = [...registry];
              const output: string[] = [];
              const originalLog = console.log;
              registry.splice(0, registry.length, ...injected);
              console.log = (value: string) => output.push(value);
              let code: number;
              try {
                const targets = ['--target', 'cursor', '--target', 'codex', '--target', 'kimi'];
                const subject = command === 'add' ? source : 'demo';
                code = await main([command, subject, ...targets, ...(dryRun ? ['--dry-run'] : []), '--json']);
              } finally {
                registry.splice(0, registry.length, ...original);
                console.log = originalLog;
              }
              const report = parseLifecycleReport(JSON.parse(output.join('')));

              expect({
                code,
                plannedCalls,
                legacyCalls,
                addCalls,
                removeCalls,
                planLength: report.plan.length,
                outcomeLength: report.outcomes.length,
                failed: report.outcomes.filter((outcome) => outcome.result === 'failed').length,
                notAttempted: report.outcomes.filter((outcome) => outcome.result === 'not-attempted').length,
                refusedActions: report.plan.filter((operation) => operation.action === 'not-attempted' && operation.route === 'none').length,
                nullNativeIds: report.plan.filter((operation) => operation.nativeId === null).length,
                failureCodes: report.outcomes.filter((outcome) => outcome.result === 'failed').map((outcome) => outcome.reason?.code),
                terminalPhase: report.summary.terminalPhase,
                mutationStarted: report.summary.mutationStarted,
                stateUnchanged: JSON.stringify(readState()) === before,
              }).toEqual({
                code: 1,
                plannedCalls: 3,
                legacyCalls: 3,
                addCalls: 0,
                removeCalls: 0,
                planLength: 3,
                outcomeLength: 3,
                failed: 1,
                notAttempted: 2,
                refusedActions: 1,
                nullNativeIds: failingHook === 'planned' ? 1 : 0,
                failureCodes: ['internal.defect'],
                terminalPhase: 'preflight',
                mutationStarted: false,
                stateUnchanged: true,
              });
            });
          }
        }
      }
    });
  }
});
