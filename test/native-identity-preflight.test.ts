import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { main } from '../src/cli';
import type { HostWriter } from '../src/host';
import { cleanupWriters, writers } from '../src/hosts/writers';
import { cursorWriter } from '../src/hosts/cursor-writer';
import { kimiWriter } from '../src/hosts/kimi-writer';
import { parseLifecycleReport } from '../src/lifecycle-report';
import { readState } from '../src/state';
import { initGitRepo, withHostEnvAsync, writeLedger } from './util';

type Command = 'add' | 'update' | 'remove';

describe('native identity preflight coverage', () => {
  test('update selects a historical root alias before its adapter identity fails', async () => {
    for (const dryRun of [true, false]) {
      await withHostEnvAsync('codex', async (home) => {
        const source = join(home, `update-selected-alias-${String(dryRun)}`);
        const sha = initGitRepo(source, {
          'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
        });
        writeLedger(home, [{ host: 'codex', id: 'demo', source, sourceSha: sha }]);
        const before = JSON.stringify(readState());
        let plannedCalls = 0;
        let legacyCalls = 0;
        let addCalls = 0;
        const writer: HostWriter = {
          id: 'codex',
          gui: false,
          plannedNativeId: () => {
            plannedCalls += 1;
            throw new Error('selected Codex identity failed');
          },
          legacyNativeIds: () => {
            legacyCalls += 1;
            return ['demo'];
          },
          persistedNativeIdMayAlias: (persisted, requested) =>
            !persisted.includes('@') && requested === `${persisted}@local`,
          detect: () => true,
          stores: () => [],
          listInstalled: () => [],
          mcpEntries: () => [],
          add: async () => { addCalls += 1; },
          remove: async () => {},
          pin: async () => ({ changes: [], refusals: [] }),
        };
        const original = [...writers];
        const output: string[] = [];
        const originalLog = console.log;
        writers.splice(0, writers.length, writer);
        console.log = (value: string) => output.push(value);
        let code: number;
        try {
          code = await main(['update', 'demo@local', '--target', 'codex', ...(dryRun ? ['--dry-run'] : []), '--json']);
        } finally {
          writers.splice(0, writers.length, ...original);
          console.log = originalLog;
        }
        const report = parseLifecycleReport(JSON.parse(output.join('')));

        expect({
          code,
          plannedCalls,
          legacyCalls,
          addCalls,
          plan: report.plan.map(({ nativeId, action, route }) => ({ nativeId, action, route })),
          outcomes: report.outcomes.map(({ result, reason }) => ({ result, reasonCode: reason?.code })),
          terminalPhase: report.summary.terminalPhase,
          mutationStarted: report.summary.mutationStarted,
          stateUnchanged: JSON.stringify(readState()) === before,
        }).toEqual({
          code: 1,
          plannedCalls: 1,
          legacyCalls: 1,
          addCalls: 0,
          plan: [{ nativeId: null, action: 'not-attempted', route: 'none' }],
          outcomes: [{ result: 'failed', reasonCode: 'internal.defect' }],
          terminalPhase: 'preflight',
          mutationStarted: false,
          stateUnchanged: true,
        });
      });
    }
  });

  test('remove selects a historical root alias before its adapter identity fails', async () => {
    for (const dryRun of [true, false]) {
      await withHostEnvAsync('codex', async (home) => {
        const source = join(home, `remove-selected-alias-${String(dryRun)}`);
        const sha = initGitRepo(source, {
          'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
        });
        writeLedger(home, [{ host: 'codex', id: 'demo', source, sourceSha: sha }]);
        const before = JSON.stringify(readState());
        let plannedCalls = 0;
        let legacyCalls = 0;
        let removeCalls = 0;
        const writer: HostWriter = {
          id: 'codex',
          gui: false,
          plannedNativeId: () => {
            plannedCalls += 1;
            throw new Error('selected Codex identity failed');
          },
          legacyNativeIds: () => {
            legacyCalls += 1;
            return ['demo'];
          },
          persistedNativeIdMayAlias: (persisted, requested) =>
            !persisted.includes('@') && requested === `${persisted}@local`,
          detect: () => true,
          stores: () => [],
          listInstalled: () => [],
          mcpEntries: () => [],
          add: async () => {},
          remove: async () => { removeCalls += 1; },
          pin: async () => ({ changes: [], refusals: [] }),
        };
        const original = [...cleanupWriters];
        const output: string[] = [];
        const originalLog = console.log;
        cleanupWriters.splice(0, cleanupWriters.length, writer);
        console.log = (value: string) => output.push(value);
        let code: number;
        try {
          code = await main(['remove', 'demo@local', '--target', 'codex', ...(dryRun ? ['--dry-run'] : []), '--json']);
        } finally {
          cleanupWriters.splice(0, cleanupWriters.length, ...original);
          console.log = originalLog;
        }
        const report = parseLifecycleReport(JSON.parse(output.join('')));

        expect({
          code,
          plannedCalls,
          legacyCalls,
          removeCalls,
          plan: report.plan.map(({ nativeId, action, route }) => ({ nativeId, action, route })),
          outcomes: report.outcomes.map(({ result, reason }) => ({ result, reasonCode: reason?.code })),
          terminalPhase: report.summary.terminalPhase,
          mutationStarted: report.summary.mutationStarted,
          stateUnchanged: JSON.stringify(readState()) === before,
        }).toEqual({
          code: 1,
          plannedCalls: 1,
          legacyCalls: 1,
          removeCalls: 0,
          plan: [{ nativeId: null, action: 'not-attempted', route: 'none' }],
          outcomes: [{ result: 'failed', reasonCode: 'internal.defect' }],
          terminalPhase: 'preflight',
          mutationStarted: false,
          stateUnchanged: true,
        });
      });
    }
  });

  test('update and remove never probe an unselected hostile package', async () => {
    for (const command of ['update', 'remove'] as const) {
      for (const dryRun of [true, false]) {
        await withHostEnvAsync('codex', async (home) => {
          const targetSource = join(home, `${command}-selected-target-${String(dryRun)}`);
          const otherSource = join(home, `${command}-unselected-other-${String(dryRun)}`);
          const targetSha = initGitRepo(targetSource, {
            'plugin.json': JSON.stringify({ name: 'target', version: '1.0.0' }),
          });
          const otherSha = initGitRepo(otherSource, {
            'plugin.json': JSON.stringify({ name: 'other', version: '1.0.0' }),
          });
          writeLedger(home, [
            { host: 'codex', id: 'target', source: targetSource, sourceSha: targetSha },
            { host: 'codex', id: 'other', source: otherSource, sourceSha: otherSha },
          ]);
          const before = JSON.stringify(readState());
          const seen: string[] = [];
          let addCalls = 0;
          let removeCalls = 0;
          const writer: HostWriter = {
            id: 'codex',
            gui: false,
            plannedNativeId: (plugin) => {
              seen.push(`planned:${plugin.name}`);
              if (plugin.name === 'other') throw new Error('unselected identity must not run');
              return `${plugin.name}@local`;
            },
            legacyNativeIds: (plugin) => {
              seen.push(`legacy:${plugin.name}`);
              if (plugin.name === 'other') throw new Error('unselected alias must not run');
              return [plugin.name];
            },
            persistedNativeIdMayAlias: (persisted, requested) =>
              !persisted.includes('@') && (requested === persisted || requested === `${persisted}@local`),
            detect: () => true,
            stores: () => [],
            listInstalled: () => command === 'update'
              ? [{ id: 'target@local', name: 'target', enabled: true, path: targetSource }]
              : [],
            mcpEntries: () => [],
            add: async () => { addCalls += 1; },
            remove: async () => { removeCalls += 1; },
            pin: async () => ({ changes: [], refusals: [] }),
          };
          const registry = command === 'remove' ? cleanupWriters : writers;
          const original = [...registry];
          const output: string[] = [];
          const originalLog = console.log;
          registry.splice(0, registry.length, writer);
          console.log = (value: string) => output.push(value);
          let code: number;
          try {
            code = await main([command, 'target@local', '--target', 'codex', ...(dryRun ? ['--dry-run'] : []), '--json']);
          } finally {
            registry.splice(0, registry.length, ...original);
            console.log = originalLog;
          }
          const report = parseLifecycleReport(JSON.parse(output.join('')));

          expect({
            code,
            seen,
            addCalls,
            removeCalls,
            plan: report.plan.map(({ package: packageName, nativeId, action }) => ({ packageName, nativeId, action })),
            outcomes: report.outcomes.map(({ result }) => result),
            mutationStarted: report.summary.mutationStarted,
            stateIds: readState().map(({ id }) => id),
            stateUnchanged: JSON.stringify(readState()) === before,
          }).toEqual({
            code: 0,
            seen: ['planned:target', 'legacy:target'],
            addCalls: command === 'update' ? 1 : 0,
            removeCalls: command === 'remove' && !dryRun ? 1 : 0,
            plan: [{ packageName: 'target', nativeId: 'target@local', action: command === 'update' ? 'update' : 'retire-orphan' }],
            outcomes: ['succeeded'],
            mutationStarted: !dryRun,
            stateIds: dryRun ? ['target', 'other'] : command === 'update' ? ['target@local', 'other'] : ['other'],
            stateUnchanged: dryRun,
          });
        });
      }
    }
  });

  test('a selected Codex identity defect stops a selected OMP pair before any mutation', async () => {
    for (const command of ['update', 'remove'] as const) {
      for (const dryRun of [true, false]) {
        await withHostEnvAsync('codex', async (home) => {
          const source = join(home, `${command}-multi-host-selected-alias-${String(dryRun)}`);
          const sha = initGitRepo(source, {
            'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
          });
          writeLedger(home, [
            { host: 'codex', id: 'demo', source, sourceSha: sha },
            { host: 'omp', id: 'demo', source, sourceSha: sha },
          ]);
          const before = JSON.stringify(readState());
          const seen: string[] = [];
          let addCalls = 0;
          let removeCalls = 0;
          const makeWriter = (id: 'codex' | 'omp'): HostWriter => ({
            id,
            gui: false,
            plannedNativeId: (plugin) => {
              seen.push(`planned:${id}`);
              if (id === 'codex') throw new Error('selected Codex identity failed');
              return `${plugin.name}@local`;
            },
            legacyNativeIds: (plugin) => {
              seen.push(`legacy:${id}`);
              return [plugin.name];
            },
            persistedNativeIdMayAlias: (persisted, requested) =>
              !persisted.includes('@') && (requested === persisted || requested === `${persisted}@local`),
            detect: () => true,
            stores: () => [],
            listInstalled: () => id === 'omp' && command === 'update'
              ? [{ id: 'demo@local', name: 'demo', enabled: true, path: source }]
              : [],
            mcpEntries: () => [],
            add: async () => { addCalls += 1; },
            remove: async () => { removeCalls += 1; },
            pin: async () => ({ changes: [], refusals: [] }),
          });
          const registry = command === 'remove' ? cleanupWriters : writers;
          const original = [...registry];
          const output: string[] = [];
          const originalLog = console.log;
          registry.splice(0, registry.length, makeWriter('codex'), makeWriter('omp'));
          console.log = (value: string) => output.push(value);
          let code: number;
          try {
            code = await main([
              command,
              'demo@local',
              '--target', 'codex',
              '--target', 'omp',
              ...(dryRun ? ['--dry-run'] : []),
              '--json',
            ]);
          } finally {
            registry.splice(0, registry.length, ...original);
            console.log = originalLog;
          }
          const report = parseLifecycleReport(JSON.parse(output.join('')));

          expect({
            code,
            seen,
            addCalls,
            removeCalls,
            plan: report.plan.map(({ scope, nativeId, action, route }) => ({ target: scope.target.kind, nativeId, action, route })),
            outcomes: report.outcomes.map(({ scope, result, reason }) => ({ target: scope.target.kind, result, reasonCode: reason?.code })),
            terminalPhase: report.summary.terminalPhase,
            mutationStarted: report.summary.mutationStarted,
            stateUnchanged: JSON.stringify(readState()) === before,
          }).toEqual({
            code: 1,
            seen: ['planned:codex', 'legacy:codex', 'planned:omp', 'legacy:omp'],
            addCalls: 0,
            removeCalls: 0,
            plan: [
              { target: 'codex', nativeId: null, action: 'not-attempted', route: 'none' },
              { target: 'omp', nativeId: 'demo@local', action: command === 'update' ? 'update' : 'retire-orphan', route: 'managed' },
            ],
            outcomes: [
              { target: 'codex', result: 'failed', reasonCode: 'internal.defect' },
              { target: 'omp', result: 'not-attempted', reasonCode: 'runtime.operation-failed' },
            ],
            terminalPhase: 'preflight',
            mutationStarted: false,
            stateUnchanged: true,
          });
        });
      }
    }
  });

  test('Cursor rejects a cross-Source canonical collision selected by the historical identity', async () => {
    for (const command of ['update', 'remove'] as const) {
      for (const dryRun of [true, false]) {
        await withHostEnvAsync('cursor', async (home) => {
          const rootSource = join(home, `${command}-cursor-root-${String(dryRun)}`);
          const marketplaceSource = join(home, `${command}-cursor-marketplace-${String(dryRun)}`);
          const otherSource = join(home, `${command}-cursor-other-${String(dryRun)}`);
          const rootSha = initGitRepo(rootSource, {
            'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
          });
          const marketplaceSha = initGitRepo(marketplaceSource, {
            'marketplace.json': JSON.stringify({
              name: 'personal',
              plugins: [{ name: 'demo', source: './plugins/demo' }],
            }),
            'plugins/demo/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
          });
          const otherSha = initGitRepo(otherSource, {
            'plugin.json': JSON.stringify({ name: 'other', version: '1.0.0' }),
          });
          writeLedger(home, [
            { host: 'cursor', id: 'demo', source: rootSource, sourceSha: rootSha },
            { host: 'cursor', id: 'demo@personal', source: marketplaceSource, sourceSha: marketplaceSha },
            { host: 'cursor', id: 'other', source: otherSource, sourceSha: otherSha },
          ]);
          const before = JSON.stringify(readState());
          let plannedCalls = 0;
          let legacyCalls = 0;
          let addCalls = 0;
          let removeCalls = 0;
          const writer: HostWriter = {
            id: 'cursor',
            gui: true,
            plannedNativeId: (plugin) => {
              plannedCalls += 1;
              if (plugin.name === 'other') throw new Error('unselected identity must not run');
              return plugin.name;
            },
            legacyNativeIds: (plugin) => {
              legacyCalls += 1;
              if (plugin.name === 'other') throw new Error('unselected alias must not run');
              return plugin.marketplace === undefined ? [] : [`${plugin.name}@${plugin.marketplace}`];
            },
            persistedNativeIdMayAlias: (persisted, requested) =>
              cursorWriter.persistedNativeIdMayAlias?.(persisted, requested) === true,
            detect: () => true,
            stores: () => [],
            listInstalled: () => [{ id: 'demo', name: 'demo', marketplace: 'personal', enabled: true, path: join(marketplaceSource, 'plugins', 'demo') }],
            mcpEntries: () => [],
            add: async () => { addCalls += 1; },
            remove: async () => { removeCalls += 1; },
            pin: async () => ({ changes: [], refusals: [] }),
          };
          const registry = command === 'remove' ? cleanupWriters : writers;
          const original = [...registry];
          const output: string[] = [];
          const originalLog = console.log;
          registry.splice(0, registry.length, writer);
          console.log = (value: string) => output.push(value);
          let code: number;
          try {
            code = await main([command, 'demo@personal', '--target', 'cursor', ...(dryRun ? ['--dry-run'] : []), '--json']);
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
            plan: report.plan.map(({ package: packageName, nativeId, action, route }) => ({ packageName, nativeId, action, route })),
            outcomes: report.outcomes.map(({ result, reason }) => ({ result, reasonCode: reason?.code })),
            terminalPhase: report.summary.terminalPhase,
            mutationStarted: report.summary.mutationStarted,
            reasonCode: report.summary.reason?.code,
            stateUnchanged: JSON.stringify(readState()) === before,
          }).toEqual({
            code: 1,
            plannedCalls: 2,
            legacyCalls: 2,
            addCalls: 0,
            removeCalls: 0,
            plan: [{ packageName: 'demo', nativeId: 'demo', action: 'not-attempted', route: 'none' }],
            outcomes: [{ result: 'failed', reasonCode: 'internal.ambiguous-ownership' }],
            terminalPhase: 'preflight',
            mutationStarted: false,
            reasonCode: 'internal.ambiguous-ownership',
            stateUnchanged: true,
          });
        });
      }
    }
  });

  test('Kimi does not treat an unrelated root row as the requested marketplace package', async () => {
    for (const command of ['update', 'remove'] as const) {
      for (const dryRun of [true, false]) {
        await withHostEnvAsync('kimi', async (home) => {
          const source = join(home, `${command}-kimi-distinct-root-${String(dryRun)}`);
          const sha = initGitRepo(source, {
            'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
          });
          writeLedger(home, [{ host: 'kimi', id: 'demo', source, sourceSha: sha }]);
          const before = JSON.stringify(readState());
          let plannedCalls = 0;
          let legacyCalls = 0;
          let addCalls = 0;
          let removeCalls = 0;
          const writer: HostWriter = {
            id: 'kimi',
            gui: false,
            plannedNativeId: (plugin) => {
              plannedCalls += 1;
              return plugin.name;
            },
            legacyNativeIds: () => {
              legacyCalls += 1;
              return [];
            },
            persistedNativeIdMayAlias: (persisted, requested) =>
              kimiWriter.persistedNativeIdMayAlias?.(persisted, requested) === true,
            detect: () => true,
            stores: () => [],
            listInstalled: () => [{ id: 'demo', name: 'demo', enabled: true, path: source }],
            mcpEntries: () => [],
            add: async () => { addCalls += 1; },
            remove: async () => { removeCalls += 1; },
            pin: async () => ({ changes: [], refusals: [] }),
          };
          const registry = command === 'remove' ? cleanupWriters : writers;
          const original = [...registry];
          const output: string[] = [];
          const originalLog = console.log;
          registry.splice(0, registry.length, writer);
          console.log = (value: string) => output.push(value);
          let code: number;
          try {
            code = await main([command, 'demo@personal', '--target', 'kimi', ...(dryRun ? ['--dry-run'] : []), '--json']);
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
            plan: report.plan,
            outcomes: report.outcomes,
            terminalPhase: report.summary.terminalPhase,
            mutationStarted: report.summary.mutationStarted,
            reasonCode: report.summary.reason?.code,
            stateUnchanged: JSON.stringify(readState()) === before,
          }).toEqual({
            code: 1,
            plannedCalls: 1,
            legacyCalls: 1,
            addCalls: 0,
            removeCalls: 0,
            plan: [],
            outcomes: [],
            terminalPhase: 'preflight',
            mutationStarted: false,
            reasonCode: 'internal.ambiguous-ownership',
            stateUnchanged: true,
          });
        });
      }
    }
  });

  test('Kimi keeps distinct root and marketplace native identities during collision preflight', async () => {
    for (const command of ['update', 'remove'] as const) {
      for (const dryRun of [true, false]) {
        await withHostEnvAsync('kimi', async (home) => {
          const rootSource = join(home, `${command}-kimi-root-${String(dryRun)}`);
          const marketplaceSource = join(home, `${command}-kimi-marketplace-${String(dryRun)}`);
          const rootSha = initGitRepo(rootSource, {
            'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
          });
          const marketplaceSha = initGitRepo(marketplaceSource, {
            'marketplace.json': JSON.stringify({
              name: 'personal',
              plugins: [{ name: 'demo', source: './plugins/demo' }],
            }),
            'plugins/demo/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
          });
          writeLedger(home, [
            { host: 'kimi', id: 'demo', source: rootSource, sourceSha: rootSha },
            { host: 'kimi', id: 'demo@personal', source: marketplaceSource, sourceSha: marketplaceSha },
          ]);
          let plannedCalls = 0;
          let legacyCalls = 0;
          let addCalls = 0;
          let removeCalls = 0;
          let marketplaceRemoved = false;
          const writer: HostWriter = {
            id: 'kimi',
            gui: false,
            plannedNativeId: (plugin) => {
              plannedCalls += 1;
              return plugin.marketplace === undefined ? plugin.name : `${plugin.name}@${plugin.marketplace}`;
            },
            legacyNativeIds: (plugin) => {
              legacyCalls += 1;
              return plugin.marketplace === undefined ? [] : [plugin.name];
            },
            persistedNativeIdMayAlias: (persisted, requested) =>
              kimiWriter.persistedNativeIdMayAlias?.(persisted, requested) === true,
            detect: () => true,
            stores: () => [],
            listInstalled: () => [
              { id: 'demo', name: 'demo', enabled: true, path: rootSource },
              ...(marketplaceRemoved ? [] : [{ id: 'demo@personal', name: 'demo', marketplace: 'personal', enabled: true, path: join(marketplaceSource, 'plugins', 'demo') }]),
            ],
            mcpEntries: () => [],
            add: async () => { addCalls += 1; },
            remove: async () => { removeCalls += 1; marketplaceRemoved = true; },
            pin: async () => ({ changes: [], refusals: [] }),
          };
          const registry = command === 'remove' ? cleanupWriters : writers;
          const original = [...registry];
          const output: string[] = [];
          const originalLog = console.log;
          registry.splice(0, registry.length, writer);
          console.log = (value: string) => output.push(value);
          let code: number;
          try {
            code = await main([command, 'demo@personal', '--target', 'kimi', ...(dryRun ? ['--dry-run'] : []), '--json']);
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
            plan: report.plan.map(({ package: packageName, nativeId, action, route }) => ({ packageName, nativeId, action, route })),
            outcomes: report.outcomes.map(({ result, reason }) => ({ result, reasonCode: reason?.code })),
            terminalPhase: report.summary.terminalPhase,
            mutationStarted: report.summary.mutationStarted,
            stateIds: readState().map(({ id }) => id),
          }).toEqual({
            code: 0,
            plannedCalls: 2,
            legacyCalls: 2,
            addCalls: command === 'update' ? 1 : 0,
            removeCalls: command === 'remove' && !dryRun ? 1 : 0,
            plan: [{ packageName: 'demo', nativeId: 'demo@personal', action: command === 'update' ? 'update' : 'retire-orphan', route: 'managed' }],
            outcomes: [{ result: 'succeeded', reasonCode: undefined }],
            terminalPhase: 'complete',
            mutationStarted: !dryRun,
            stateIds: dryRun || command === 'update' ? ['demo', 'demo@personal'] : ['demo'],
          });
        });
      }
    }
  });

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
