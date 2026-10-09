import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { withHostEnvAsync, initGitRepo, writeFiles, writeLedger } from './util';
import { main } from '../src/cli';
import { claudeCode } from '../src/hosts/claude-code';
import { codex } from '../src/hosts/codex';
import { cursor } from '../src/hosts/cursor';
import { kimi } from '../src/hosts/kimi';
import { omp } from '../src/hosts/omp';
import { pi } from '../src/hosts/pi';
import { piWriter } from '../src/hosts/pi-writer';
import { hermes } from '../src/hosts/hermes';
import { readState } from '../src/state';
import { withKimiNative } from './kimi-fixture';
import { cleanupWriters } from '../src/hosts/writers';
import type { HostWriter } from '../src/host';
import { parseLifecycleReport } from '../src/lifecycle-report';
import { createDeploymentScopeIdentity } from '../src/deployment-scope';
import type { LifecycleStateV2 } from '../src/state';

const plannedNativeId: HostWriter['plannedNativeId'] = (plugin) => plugin.name;

const pluginsMap = {
  'plugin.json': JSON.stringify({ name: "demo-plugin", mcpServers: { demo: { command: "demo" } } }, null, 2),
  'mcp.json': JSON.stringify({ mcpServers: { demo: { command: "demo" } } }, null, 2)
};

function scopedRemoveState(entries: ReadonlyArray<{ target: string; source: string }>): LifecycleStateV2 {
  const timestamp = '2026-10-09T00:00:00.000Z';
  const rows = entries.map(({ target, source: locator }) => {
    const source = { kind: 'local', locator } as const;
    const identity = createDeploymentScopeIdentity(source, { kind: target, instance: 'default' });
    return {
      scope: {
        ...identity,
        authority: 'authoritative' as const,
        lifecycle: 'active' as const,
        selectorMode: 'explicit' as const,
        desired: {
          generation: 1,
          revision: 'revision-1',
          sourceFingerprint: 'source-fingerprint',
          packages: [{ packageId: 'demo-plugin', nativeId: 'demo-plugin', sourceRelativeDir: 'demo-plugin', requiredCapabilities: [], adoptionRequested: false }],
          validatedAt: timestamp,
        },
      },
      activation: {
        scopeId: identity.id,
        packageId: 'demo-plugin',
        nativeId: 'demo-plugin',
        sourceRevision: 'revision-1',
        route: { kind: 'managed' as const, evidenceKey: { kind: 'capability-profile' as const, key: `sha256:${'a'.repeat(64)}` } },
        ownership: { kind: 'created' as const, proofKey: { kind: 'managed-marker' as const, key: `sha256:${'b'.repeat(64)}` }, verifiedAt: timestamp },
        fingerprints: { source: 'source', projected: 'projected', installed: 'installed' },
        activationState: 'active' as const,
        readbackState: 'verified' as const,
        pins: [],
      },
    };
  });
  return {
    version: 2,
    stateGeneration: 1,
    scopes: rows.map(({ scope }) => scope),
    activations: rows.map(({ activation }) => activation),
    attempts: [],
    tombstones: [],
  };
}

describe('remove', () => {
  test('captures canonical and legacy native identity exactly once before dry or applied remove', async () => {
    for (const dryRun of [true, false]) {
      for (const failingHook of ['planned', 'legacy'] as const) {
        for (const throwOn of [1, 2, 3]) {
          await withHostEnvAsync('cursor', async (home) => {
            const source = join(home, `remove-identity-${failingHook}-${throwOn}-${String(dryRun)}`);
            const sha = initGitRepo(source, {
              'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
            });
            writeLedger(home, [{ host: 'cursor', id: 'demo', source, sourceSha: sha }]);
            const before = JSON.stringify(readState());
            let plannedCalls = 0;
            let legacyCalls = 0;
            let removeCalls = 0;
            const writer: HostWriter = {
              id: 'cursor',
              gui: false,
              plannedNativeId: (plugin) => {
                plannedCalls += 1;
                if (failingHook === 'planned' && plannedCalls === throwOn) throw new Error(`planned identity failure ${throwOn}`);
                return plugin.name;
              },
              legacyNativeIds: () => {
                legacyCalls += 1;
                if (failingHook === 'legacy' && legacyCalls === throwOn) throw new Error(`legacy identity failure ${throwOn}`);
                return [];
              },
              detect: () => true,
              stores: () => [],
              listInstalled: () => [],
              mcpEntries: () => [],
              add: async () => {},
              remove: async () => { removeCalls += 1; },
              pin: async () => ({ changes: [], refusals: [] }),
            };
            const originalWriters = [...cleanupWriters];
            const output: string[] = [];
            const originalLog = console.log;
            cleanupWriters.splice(0, cleanupWriters.length, writer);
            console.log = (value: string) => output.push(value);
            let code: number;
            try {
              code = await main(['remove', 'demo', '--target', 'cursor', ...(dryRun ? ['--dry-run'] : []), '--json']);
            } finally {
              cleanupWriters.splice(0, cleanupWriters.length, ...originalWriters);
              console.log = originalLog;
            }
            const report = parseLifecycleReport(JSON.parse(output.join('')));
            const failsOnOnlyAllowedCall = throwOn === 1;

            expect({
              code,
              plannedCalls,
              legacyCalls,
              removeCalls,
              planLength: report.plan.length,
              outcomeLength: report.outcomes.length,
              nativeId: report.plan[0]?.nativeId,
              action: report.plan[0]?.action,
              route: report.plan[0]?.route,
              result: report.outcomes[0]?.result,
              reasonCode: report.outcomes[0]?.reason?.code,
              terminalPhase: report.summary.terminalPhase,
              mutationStarted: report.summary.mutationStarted,
              stateUnchanged: JSON.stringify(readState()) === before,
            }).toEqual({
              code: failsOnOnlyAllowedCall ? 1 : 0,
              plannedCalls: 1,
              legacyCalls: 1,
              removeCalls: failsOnOnlyAllowedCall || dryRun ? 0 : 1,
              planLength: 1,
              outcomeLength: 1,
              nativeId: failsOnOnlyAllowedCall && failingHook === 'planned' ? null : 'demo',
              action: failsOnOnlyAllowedCall ? 'not-attempted' : 'retire-orphan',
              route: failsOnOnlyAllowedCall ? 'none' : 'managed',
              result: failsOnOnlyAllowedCall ? 'failed' : 'succeeded',
              reasonCode: failsOnOnlyAllowedCall ? 'internal.defect' : undefined,
              terminalPhase: failsOnOnlyAllowedCall ? 'preflight' : 'complete',
              mutationStarted: failsOnOnlyAllowedCall ? false : !dryRun,
              stateUnchanged: failsOnOnlyAllowedCall || dryRun,
            });
          });
        }
      }
    }
  });

  test('rejects ambiguity across all selected scopes before removing an earlier valid pair', async () => {
    await withHostEnvAsync('codex', async (home) => {
      writeFileSync(join(home, 'state.json'), JSON.stringify(scopedRemoveState([
        { target: 'codex', source: '/codex-source' },
        { target: 'cursor', source: '/cursor-source-one' },
        { target: 'cursor', source: '/cursor-source-two' },
      ])));
      let removeCalls = 0;
      const writer = (id: 'codex' | 'cursor'): HostWriter => ({
        id, gui: false, plannedNativeId, detect: () => true, stores: () => [], listInstalled: () => [], mcpEntries: () => [],
        add: async () => {}, remove: async () => { removeCalls += 1; },
        pin: async () => ({ changes: [], refusals: [] }),
      });
      const original = [...cleanupWriters];
      const output: string[] = [];
      const originalLog = console.log;
      const before = readState();
      cleanupWriters.splice(0, cleanupWriters.length, writer('codex'), writer('cursor'));
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['remove', 'demo-plugin', '--target', 'codex', '--target', 'cursor', '--json'])).toBe(1);
      } finally {
        cleanupWriters.splice(0, cleanupWriters.length, ...original);
        console.log = originalLog;
      }

      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect({ removeCalls, state: readState(), plan: report.plan, outcomes: report.outcomes, summary: report.summary }).toEqual({
        removeCalls: 0,
        state: before,
        plan: [],
        outcomes: [],
        summary: {
          result: 'incomplete',
          terminalPhase: 'preflight',
          mutationStarted: false,
          changed: false,
          failureCategory: 'internal',
          reason: {
            category: 'internal',
            code: 'internal.ambiguous-ownership',
            diagnostic: "multiple cursor/default deployment scopes own native package 'demo-plugin'",
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
      });
    });
  });

  test('reclassifies a post-intent adapter refusal and stops later removals', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-remove-refusal-'));
      const sha = initGitRepo(sourceDir, pluginsMap);
      writeLedger(home, [
        { host: 'codex', id: 'demo-plugin', source: sourceDir, sourceSha: sha, ownership: 'plgnz' },
        { host: 'cursor', id: 'demo-plugin', source: sourceDir, sourceSha: sha, ownership: 'plgnz' },
      ]);
      let laterRemoveCalls = 0;
      const refusing: HostWriter = {
        id: 'codex', gui: false, plannedNativeId, detect: () => true, stores: () => [], listInstalled: () => [], mcpEntries: () => [],
        add: async () => {},
        remove: async () => { throw new Error('late remove refusal'); },
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const later: HostWriter = {
        id: 'cursor', gui: false, plannedNativeId, detect: () => true, stores: () => [], listInstalled: () => [], mcpEntries: () => [],
        add: async () => {}, remove: async () => { laterRemoveCalls += 1; },
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const original = [...cleanupWriters];
      const output: string[] = [];
      const originalLog = console.log;
      cleanupWriters.splice(0, cleanupWriters.length, refusing, later);
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['remove', 'demo-plugin', '--target', 'codex', '--target', 'cursor', '--json'])).toBe(1);
      } finally {
        cleanupWriters.splice(0, cleanupWriters.length, ...original);
        console.log = originalLog;
      }

      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect({
        laterRemoveCalls,
        plan: report.plan.map(({ action, route }) => ({ action, route })),
        outcomes: report.outcomes.map(({ result, action, route, resourceState, reason }) => ({ result, action, route, resourceState, reason })),
        summary: report.summary,
        pending: readState().map(({ host, pending }) => ({ host, pending })),
      }).toEqual({
        laterRemoveCalls: 0,
        plan: [
          { action: 'retire-orphan', route: 'managed' },
          { action: 'retire-orphan', route: 'managed' },
        ],
        outcomes: [{
          result: 'pending',
          action: 'retire-orphan',
          route: 'managed',
          resourceState: 'potentially-changed',
          reason: {
            category: 'recovery',
            code: 'recovery.required',
            diagnostic: "removal of 'demo-plugin' requires recovery after pending intent was persisted — late remove refusal",
            capabilityId: null,
            evidenceId: null,
          },
        }, {
          result: 'not-attempted',
          action: 'retire-orphan',
          route: 'managed',
          resourceState: 'unknown',
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: 'not attempted after an earlier remove failure',
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
          reason: report.outcomes[0]!.reason,
          recoveryId: report.plan[0]!.operationId,
          readbackId: null,
        },
        pending: [
          { host: 'codex', pending: 'remove' },
          { host: 'cursor', pending: undefined },
        ],
      });
    });
  });

  test('reports a target detection exception as a preflight defect', async () => {
    await withHostEnvAsync('codex', async () => {
      const originalWriters = [...cleanupWriters];
      const exploding: HostWriter = {
        id: 'codex',
        gui: false, plannedNativeId,
        detect: () => { throw new Error(); },
        stores: () => [],
        listInstalled: () => [],
        mcpEntries: () => [],
        add: async () => {},
        remove: async () => {},
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const output: string[] = [];
      const originalLog = console.log;
      cleanupWriters.splice(0, cleanupWriters.length, exploding);
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['remove', 'demo', '--target', 'codex', '--json'])).toBe(1);
      } finally {
        cleanupWriters.splice(0, cleanupWriters.length, ...originalWriters);
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
          diagnostic: 'Error',
          capabilityId: null,
          evidenceId: null,
        },
        recoveryId: null,
        readbackId: null,
      });
    });
  });

  test('--target removes only that host record', async () => {
    await withHostEnvAsync('codex', async (home) => {
      writeLedger(home, [
        { host: 'codex', id: 'demo-plugin@local', source: '/codex-source', sourceSha: 'one' },
        { host: 'cursor', id: 'demo-plugin@local', source: '/cursor-source', sourceSha: 'two' },
      ]);
      expect(await main(['remove', 'demo-plugin@local', '--target', 'codex'])).toBe(0);
      expect(readState().find((record) => record.host === 'codex')).toBeUndefined();
      expect(readState().find((record) => record.host === 'cursor')?.source).toBe('/cursor-source');
    });
  });

  test('refuses an unrecorded native install', async () => {
    await withHostEnvAsync('codex', async () => {
      expect(codex.listInstalled().some((plugin) => plugin.id === 'demo-plugin@demo-market')).toBe(true);
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['remove', 'demo-plugin@demo-market', '--target', 'codex', '--json'])).toBe(1);
      } finally {
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect({
        outcomes: report.outcomes,
        terminalPhase: report.summary.terminalPhase,
        reasonCode: report.summary.reason?.code,
      }).toEqual({
        outcomes: [],
        terminalPhase: 'preflight',
        reasonCode: 'internal.ambiguous-ownership',
      });
      expect(codex.listInstalled().some((plugin) => plugin.id === 'demo-plugin@demo-market')).toBe(true);
    });
  });

  test('removes an old plgnz-owned Pi installation through the cleanup-only public route', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-pi-cleanup-source-'));
      writeFiles(sourceDir, {
        'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
        'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\n---\nbody\n',
      });
      await piWriter.add(
        { dir: sourceDir, name: 'demo', marketplace: 'market', contentFingerprint: 'fixture' },
        { sourceUri: sourceDir, sha: 'fixture', isGit: false, plugins: [] },
      );
      writeLedger(home, [{ host: 'pi', id: 'demo@market', source: sourceDir, sourceSha: 'fixture', ownership: 'plgnz' }]);

      expect(pi.listInstalled().some((plugin) => plugin.id === 'demo@market')).toBe(true);
      expect(await main(['remove', 'demo@market', '--target', 'pi'])).toBe(0);
      expect(pi.listInstalled().some((plugin) => plugin.id === 'demo@market')).toBe(false);
      expect(existsSync(join(home, '.pi', 'agent', 'skills', 'market___demo'))).toBe(false);
      expect(readState().find((record) => record.host === 'pi')).toBeUndefined();
    });
  });

  test('removes a marketplace-qualified Hermes install through the public route', async () => {
    await withHostEnvAsync('codex', async (home) => {
      writeFiles(home, { '.hermes/config.yaml': '', '.hermes/plugins/.keep': '' });
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-hermes-marketplace-'));
      initGitRepo(sourceDir, {
        '.claude-plugin/marketplace.json': JSON.stringify({ name: 'personal', plugins: [{ source: 'plugins/demo-plugin' }] }),
        'plugins/demo-plugin/plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'demo-plugin', version: '1.0.0' }),
        'plugins/demo-plugin/commands/run.toml': 'description = "Run"\nprompt = "body $ARGUMENTS"\n',
      });
      expect(await main(['add', sourceDir, '--target', 'hermes'])).toBe(0);
      expect(hermes.listInstalled().some((plugin) => plugin.id === 'demo-plugin@personal')).toBe(true);

      expect(await main(['remove', 'demo-plugin@personal', '--target', 'hermes'])).toBe(0);
      expect(hermes.listInstalled().some((plugin) => plugin.name === 'demo-plugin')).toBe(false);
      expect(existsSync(join(home, '.hermes/plugins/demo-plugin.plgnz-commands'))).toBe(false);
      expect(readState().find((record) => record.host === 'hermes')).toBeUndefined();
    });
  });

  test('reports a post-remove ledger failure in the finalize phase', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-remove-finalize-'));
      writeLedger(home, [{ host: 'codex', id: 'demo-plugin', source: sourceDir, sourceSha: 'fixture' }]);
      const originalWriters = [...cleanupWriters];
      const writer: HostWriter = {
        id: 'codex',
        gui: false, plannedNativeId,
        detect: () => true,
        stores: () => [],
        listInstalled: () => [],
        mcpEntries: () => [],
        add: async () => {},
        remove: async () => { chmodSync(home, 0o555); },
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const output: string[] = [];
      const originalLog = console.log;
      cleanupWriters.splice(0, cleanupWriters.length, writer);
      console.log = (value: string) => output.push(value);
      let code: number;
      try {
        code = await main(['remove', 'demo-plugin', '--target', 'codex', '--json']);
      } finally {
        chmodSync(home, 0o755);
        cleanupWriters.splice(0, cleanupWriters.length, ...originalWriters);
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
      }).toEqual({
        code: 1,
        result: 'pending',
        changed: true,
        resourceState: 'absent',
        activationState: 'inactive',
        reasonCode: 'recovery.required',
        terminalPhase: 'finalize',
        mutationStarted: true,
        recoveryId: report.plan[0]!.operationId,
      });
    });
  });

  test('keeps post-remove readback failures pending with both recovery identities', async () => {
    for (const scenario of [
      {
        listInstalled: (): ReturnType<HostWriter['listInstalled']> => [{ id: 'demo-plugin', name: 'demo-plugin', enabled: true }],
        reasonCode: 'readback.mismatch',
      },
      {
        listInstalled: (): ReturnType<HostWriter['listInstalled']> => { throw new Error('forced remove inventory failure'); },
        reasonCode: 'readback.failed',
      },
    ] as const) {
      await withHostEnvAsync('codex', async (home) => {
        writeLedger(home, [{ host: 'codex', id: 'demo-plugin', source: '/source', sourceSha: 'fixture' }]);
        const originalWriters = [...cleanupWriters];
        const writer: HostWriter = {
          id: 'codex',
          gui: false,
          plannedNativeId,
          detect: () => true,
          stores: () => [],
          listInstalled: scenario.listInstalled,
          mcpEntries: () => [],
          add: async () => {},
          remove: async () => {},
          pin: async () => ({ changes: [], refusals: [] }),
        };
        const output: string[] = [];
        const originalLog = console.log;
        cleanupWriters.splice(0, cleanupWriters.length, writer);
        console.log = (value: string) => output.push(value);
        try {
          expect(await main(['remove', 'demo-plugin', '--target', 'codex', '--json'])).toBe(1);
        } finally {
          cleanupWriters.splice(0, cleanupWriters.length, ...originalWriters);
          console.log = originalLog;
        }

        const report = parseLifecycleReport(JSON.parse(output.join('')));
        expect({
          result: report.outcomes[0]?.result,
          resourceState: report.outcomes[0]?.resourceState,
          activationState: report.outcomes[0]?.activationState,
          reasonCode: report.outcomes[0]?.reason?.code,
          terminalPhase: report.summary.terminalPhase,
          mutationStarted: report.summary.mutationStarted,
          recoveryId: report.summary.recoveryId,
          readbackId: report.summary.readbackId,
          pending: readState()[0]?.pending,
        }).toEqual({
          result: 'pending',
          resourceState: 'potentially-changed',
          activationState: 'unknown',
          reasonCode: scenario.reasonCode,
          terminalPhase: 'readback',
          mutationStarted: true,
          recoveryId: report.plan[0]!.operationId,
          readbackId: report.plan[0]!.operationId,
          pending: 'remove',
        });
      });
    }
  });

  test('allows inactive retained native metadata after removal readback', async () => {
    await withHostEnvAsync('codex', async (home) => {
      writeLedger(home, [{ host: 'codex', id: 'demo-plugin', source: '/source', sourceSha: 'fixture' }]);
      const originalWriters = [...cleanupWriters];
      const writer: HostWriter = {
        id: 'codex', gui: false, plannedNativeId,
        detect: () => true,
        stores: () => [],
        listInstalled: () => [{ id: 'demo-plugin', name: 'demo-plugin', enabled: false }],
        mcpEntries: () => [],
        add: async () => {}, remove: async () => {},
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const output: string[] = [];
      const originalLog = console.log;
      cleanupWriters.splice(0, cleanupWriters.length, writer);
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['remove', 'demo-plugin', '--target', 'codex', '--json'])).toBe(0);
      } finally {
        cleanupWriters.splice(0, cleanupWriters.length, ...originalWriters);
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect({
        result: report.outcomes[0]?.result,
        resourceState: report.outcomes[0]?.resourceState,
        activationState: report.outcomes[0]?.activationState,
        state: readState(),
      }).toEqual({
        result: 'succeeded',
        resourceState: 'absent',
        activationState: 'inactive',
        state: [],
      });
    });
  });

  test('claude-code > removes plugin from registry', async () => {
    await withHostEnvAsync('claude-code', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      await main(['add', sourceDir, '--target', 'claude-code']);
      
      const code = await main(['remove', 'demo-plugin@local']);
      expect(code).toBe(0);

      const installed = claudeCode.listInstalled();
      expect(installed.find(p => p.id === 'demo-plugin@local')).toBeUndefined();
      
      const state = readState();
      expect(state.find(r => r.id === 'demo-plugin@local')).toBeUndefined();
    });
  });

  test('codex > removes plugin from config', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      await main(['add', sourceDir, '--target', 'codex']);
      
      const code = await main(['remove', 'demo-plugin@local']);
      expect(code).toBe(0);

      const installed = codex.listInstalled();
      expect(installed.find(p => p.id === 'demo-plugin@local')).toBeUndefined();
    });
  });

  test('kimi > removes plugin from the active registry through native lifecycle', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      await withKimiNative(home, async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      await main(['add', sourceDir, '--target', 'kimi']);
      
      const code = await main(['remove', 'demo-plugin']);
      expect(code).toBe(0);

      const installed = kimi.listInstalled();
      expect(installed.find(p => p.id === 'demo-plugin')).toBeUndefined();
      });
    });
  });

  test('cursor > removes directory', async () => {
    await withHostEnvAsync('cursor', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, {
        ...pluginsMap,
        'plugin.json': JSON.stringify({ name: 'demo-plugin', version: '1.0.0', mcpServers: { demo: { command: 'demo' } } }, null, 2),
      });
      // The Cursor fixture already has a same-name local plugin. The lifecycle
      // requires an explicit adoption before this test may remove it as owned.
      expect(await main(['add', sourceDir, '--target', 'cursor', '--adopt-existing'])).toBe(0);
      
      const code = await main(['remove', 'demo-plugin']);
      expect(code).toBe(0);

      const installed = cursor.listInstalled();
      expect(installed.find(p => p.id === 'demo-plugin')).toBeUndefined();
    });
  });

  test('omp > removes from registry and lockfile', async () => {
    await withHostEnvAsync('omp', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      await main(['add', sourceDir, '--target', 'omp']);
      
      const code = await main(['remove', 'demo-plugin@local']);
      expect(code).toBe(0);

      const installed = omp.listInstalled();
      expect(installed.find(p => p.id === 'demo-plugin@local')).toBeUndefined();
    });
  });
});
