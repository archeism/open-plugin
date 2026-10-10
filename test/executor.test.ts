import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilityEvidenceProfile, type CapabilityStatus } from '../src/capability-evidence';
import { createDeploymentScopeIdentity } from '../src/deployment-scope';
import { executeLifecycle } from '../src/executor';
import { exitCodeForLifecycleReport } from '../src/lifecycle-report';
import { stateFile } from '../src/paths';
import { planLifecycle, type LifecyclePlan, type PlannerHost } from '../src/planner';
import { PACKAGE_SEMANTICS, type CapabilityOperation, type PackageSemantic } from '../src/semantic-inventory';
import type { PluginSource } from '../src/source';
import { readLifecycleState, type DeploymentScopeRecord } from '../src/state';
import { writeLifecycleState } from '../src/state-write';
import { parseSyncManifest, type SyncManifest } from '../src/sync-manifest';
import { FakeLifecycleHost } from './fake-lifecycle-adapter';

const roots: string[] = [];
const now = '2026-10-10T00:00:00.000Z';

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('lifecycle executor', () => {
  test('a frozen plan persists the recovery journal before any host mutation, and a failure stops later mutations', async () => {
    const root = temp('journal-stop');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const beta = writePlugin(join(root, 'sources'), 'beta');
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);
    const cursor = boundHost('cursor', join(root, 'cursor'), ['install', 'update']);
    codex.fake.failPhase = 'stage';

    await withHome(home, async () => {
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex'), syncEntry(beta, 'cursor')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner, cursor.planner],
      }));
      const alphaPlan = plan.operations.find((row) => row.operation.package === 'alpha');
      const betaPlan = plan.operations.find((row) => row.operation.package === 'beta');
      expect(alphaPlan?.operation.action).toBe('install');
      expect(betaPlan?.operation.action).toBe('install');
      expect(alphaPlan?.journal).toEqual({ kind: 'required', action: 'install', mutation: true, readback: true });
      const codexBefore = codex.fake.hostMutationState();
      const cursorBefore = cursor.fake.hostMutationState();
      const cursorEventsBefore = cursor.fake.events.length;

      const executed = await executeLifecycle({ plan, hosts: [codex.planner, cursor.planner], now });

      const loaded = readLifecycleState();
      const attempt = loaded.state.attempts.find((row) => row.id === plan.attemptId);
      expect(loaded.state.stateGeneration).toBe(1);
      expect(loaded.state.scopes.map((scope) => scope.desired?.packages.map((pkg) => pkg.packageId)).sort()).toEqual([['alpha'], ['beta']]);
      expect(attempt).toEqual({
        id: plan.attemptId,
        command: 'sync',
        phase: 'accepted',
        mutationStarted: false,
        scopeIds: plan.scopes.map((scope) => scope.scope.id),
        journal: [{
          operationId: alphaPlan?.operation.operationId,
          scopeId: alphaPlan?.operation.scope.id,
          packageId: 'alpha',
          nativeId: 'alpha',
          action: 'install',
          state: 'pending',
          startedAt: now,
          updatedAt: now,
        }],
        startedAt: now,
        updatedAt: now,
      });
      expect(codex.fake.events).toContain('stage');
      expect(cursor.fake.events.slice(cursorEventsBefore)).toEqual([]);
      expect(codex.fake.hostMutationState()).toBe(codexBefore);
      expect(cursor.fake.hostMutationState()).toBe(cursorBefore);
      if (alphaPlan === undefined || betaPlan === undefined) throw new Error('expected install operations');
      expect(executed.exitCode).toBe(1);
      expect(executed.report.summary).toEqual({
        result: 'incomplete',
        terminalPhase: 'apply',
        mutationStarted: false,
        changed: false,
        failureCategory: 'internal',
        reason: null,
        recoveryId: null,
        readbackId: null,
      });
      expect(executed.report.outcomes).toEqual([
        {
          ...alphaPlan.operation,
          result: 'failed',
          resourceState: 'unknown',
          activationState: 'unknown',
          changed: false,
          reason: {
            category: 'internal',
            code: 'internal.defect',
            diagnostic: 'stage: injected fake lifecycle failure',
            capabilityId: null,
            evidenceId: null,
          },
        },
        {
          ...betaPlan.operation,
          result: 'not-attempted',
          resourceState: 'unknown',
          activationState: 'unknown',
          changed: false,
          reason: {
            category: 'internal',
            code: 'internal.invariant',
            diagnostic: 'stopped after internal.defect',
            capabilityId: null,
            evidenceId: null,
          },
        },
      ]);
      expect(exitCodeForLifecycleReport(executed.report)).toBe(1);
      expect(stateFile().startsWith(home)).toBe(true);
    });
  });

  test('an install journal keeps an unrelated scope already on disk', async () => {
    const root = temp('unrelated-scope');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const unrelatedRoot = realpathSync(mkdirTemp(join(root, 'unrelated')));
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);
    codex.fake.failPhase = 'stage';
    const createdAt = '2020-01-01T00:00:00.000Z';
    const source = { kind: 'local' as const, locator: unrelatedRoot };
    const target = { kind: 'hermes', instance: 'default' };
    const unrelated: DeploymentScopeRecord = {
      id: createDeploymentScopeIdentity(source, target).id,
      source,
      target,
      authority: 'legacy-import',
      lifecycle: 'active',
      selectorMode: 'legacy-unknown',
      createdAt,
      updatedAt: createdAt,
    };

    await withHome(home, async () => {
      writeLifecycleState({
        version: 2,
        stateGeneration: 1,
        scopes: [unrelated],
        activations: [],
        attempts: [],
        tombstones: [],
      }, { globalPreflight: 'succeeded' });
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner],
      }));

      await executeLifecycle({ plan, hosts: [codex.planner], now });

      const loaded = readLifecycleState();
      const kept = loaded.state.scopes.find((scope) => scope.id === unrelated.id);
      expect(kept).toEqual(unrelated);
      expect(kept?.createdAt).toBe(createdAt);
      expect(kept?.authority).toBe('legacy-import');
      expect(loaded.state.attempts.some((attempt) => attempt.id === plan.attemptId)).toBe(true);
    });
  });

  test('a retire-source scope mixed with an install returns a report', async () => {
    const root = temp('mixed-retire');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const retiredRoot = realpathSync(mkdirTemp(join(root, 'retired')));
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);
    const createdAt = '2020-01-01T00:00:00.000Z';
    const source = { kind: 'local' as const, locator: retiredRoot };
    const target = { kind: 'hermes', instance: 'default' };
    const retired: DeploymentScopeRecord = {
      id: createDeploymentScopeIdentity(source, target).id,
      source,
      target,
      authority: 'legacy-import',
      lifecycle: 'active',
      selectorMode: 'legacy-unknown',
      createdAt,
      updatedAt: createdAt,
    };

    await withHome(home, async () => {
      writeLifecycleState({
        version: 2,
        stateGeneration: 1,
        scopes: [retired],
        activations: [],
        attempts: [],
        tombstones: [],
      }, { globalPreflight: 'succeeded' });
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([
          { operation: 'retire-source', scopeId: retired.id, target },
          syncEntry(alpha, 'codex'),
        ]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner],
      }));
      codex.fake.failPhase = 'stage';

      const executed = await executeLifecycle({ plan, hosts: [codex.planner], now });

      const loaded = readLifecycleState();
      expect(executed.exitCode).toBe(1);
      expect(loaded.state.scopes.find((scope) => scope.id === retired.id)).toEqual(retired);
      expect(loaded.state.attempts.some((attempt) => attempt.id === plan.attemptId)).toBe(true);
    });
  });

  test('a prepare failure becomes a failed outcome and does not journal', async () => {
    const root = temp('prepare-throw');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);

    await withHome(home, async () => {
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner],
      }));
      const eventsBefore = codex.fake.events.length;
      codex.fake.failPhase = 'inventory';

      const executed = await executeLifecycle({ plan, hosts: [codex.planner], now });

      const loaded = readLifecycleState();
      expect(loaded.state.stateGeneration).toBe(0);
      expect(loaded.state.attempts).toEqual([]);
      expect(codex.fake.events.slice(eventsBefore).includes('stage')).toBe(false);
      expect(executed.exitCode).toBe(1);
      expect(executed.report.outcomes[0]?.reason).toEqual({
        category: 'internal',
        code: 'internal.defect',
        diagnostic: 'inventory: injected fake lifecycle failure',
        capabilityId: null,
        evidenceId: null,
      });
    });
  });

  test('source drift is refused before a journal write', async () => {
    const root = temp('drift');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);

    await withHome(home, async () => {
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner],
      }));
      const eventsBefore = codex.fake.events.length;
      writeFileSync(join(alpha, 'skills', 'a', 'SKILL.md'), '# changed\n');

      const executed = await executeLifecycle({ plan, hosts: [codex.planner], now });

      const loaded = readLifecycleState();
      expect(loaded.state.stateGeneration).toBe(0);
      expect(loaded.state.attempts).toEqual([]);
      expect(codex.fake.events.slice(eventsBefore).includes('stage')).toBe(false);
      expect(executed.exitCode).toBe(1);
      expect(executed.report.outcomes[0]?.reason?.diagnostic).toBe("install 'alpha' source bytes drifted from the frozen snapshot");
    });
  });

  test('a route change is refused before a journal write', async () => {
    const root = temp('route-change');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);

    await withHome(home, async () => {
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner],
      }));
      const eventsBefore = codex.fake.events.length;
      codex.fake.version = '9.9.9';

      const executed = await executeLifecycle({ plan, hosts: [codex.planner], now });

      const loaded = readLifecycleState();
      expect(loaded.state.stateGeneration).toBe(0);
      expect(loaded.state.attempts).toEqual([]);
      expect(codex.fake.events.slice(eventsBefore).includes('stage')).toBe(false);
      expect(executed.exitCode).toBe(1);
      expect(executed.report.outcomes[0]?.reason?.diagnostic).toBe("install 'alpha' kept frozen route 'managed'");
    });
  });

  test('a changed state generation is refused and does not write', async () => {
    const root = temp('generation');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const unrelatedRoot = realpathSync(mkdirTemp(join(root, 'unrelated')));
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);
    const createdAt = '2020-01-01T00:00:00.000Z';
    const source = { kind: 'local' as const, locator: unrelatedRoot };
    const target = { kind: 'hermes', instance: 'default' };
    const unrelated: DeploymentScopeRecord = {
      id: createDeploymentScopeIdentity(source, target).id,
      source,
      target,
      authority: 'legacy-import',
      lifecycle: 'active',
      selectorMode: 'legacy-unknown',
      createdAt,
      updatedAt: createdAt,
    };

    await withHome(home, async () => {
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner],
      }));
      writeLifecycleState({
        version: 2,
        stateGeneration: 1,
        scopes: [unrelated],
        activations: [],
        attempts: [],
        tombstones: [],
      }, { globalPreflight: 'succeeded' });

      const executed = await executeLifecycle({ plan, hosts: [codex.planner], now });

      const loaded = readLifecycleState();
      expect(loaded.state.stateGeneration).toBe(1);
      expect(loaded.state.attempts).toEqual([]);
      expect(loaded.state.scopes).toEqual([unrelated]);
      expect(executed.exitCode).toBe(1);
      expect(executed.report.outcomes[0]?.reason?.diagnostic).toBe(
        `plan '${plan.attemptId}' does not match state generation 1`,
      );
    });
  });

  test('a staged install does not leave a pending journal, and the same attempt can run again', async () => {
    const root = temp('stage-success');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);

    await withHome(home, async () => {
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner],
      }));
      const install = plan.operations.find((row) => row.operation.package === 'alpha');
      if (install === undefined) throw new Error('expected an install operation');
      const before = codex.fake.hostMutationState();

      const executed = await executeLifecycle({ plan, hosts: [codex.planner], now });

      const loaded = readLifecycleState();
      const attempt = loaded.state.attempts.find((row) => row.id === plan.attemptId);
      const hostAfter = codex.fake.hostMutationState();
      expect(loaded.state.attempts).toHaveLength(1);
      expect(attempt?.phase).toBe('completed');
      expect(attempt?.mutationStarted).toBe(true);
      expect(attempt?.journal[0]?.state).toBe('completed');
      expect(codex.fake.events.filter((event) => event === 'managed:apply')).toHaveLength(1);
      expect(hostAfter === before).toBe(false);
      expect(executed.exitCode).toBe(0);

      const again = await executeLifecycle({ plan, hosts: [codex.planner], now });
      const reloaded = readLifecycleState();
      const replayed = reloaded.state.attempts.filter((row) => row.id === plan.attemptId);
      expect(replayed).toHaveLength(1);
      expect(replayed[0]?.journal).toHaveLength(1);
      expect(replayed[0]?.journal[0]?.state).toBe('completed');
      expect(codex.fake.events.filter((event) => event === 'managed:apply')).toHaveLength(1);
      expect(codex.fake.hostMutationState()).toBe(hostAfter);
      expect(again.exitCode).toBe(0);
    });
  });

  test('a dry-run of a fully executable convergent plan exits 0 and writes no journal, and a capability plan exits 1', async () => {
    const root = temp('dry-run');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const beta = writePlugin(join(root, 'sources'), 'beta');
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);
    const unverified = boundHost('kimi', join(root, 'kimi'), []);

    await withHome(home, async () => {
      const convergent = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: true,
        validatedAt: now,
        hosts: [codex.planner],
      }));
      const before = codex.fake.hostMutationState();
      const executed = await executeLifecycle({ plan: convergent, hosts: [codex.planner], now });
      expect(executed.exitCode).toBe(0);
      expect(readLifecycleState().state.attempts).toEqual([]);
      expect(readLifecycleState().state.stateGeneration).toBe(0);
      expect(codex.fake.hostMutationState()).toBe(before);

      const capability = await planLifecycle({
        manifest: manifest([syncEntry(beta, 'kimi')]),
        dryRun: true,
        validatedAt: now,
        hosts: [unverified.planner],
      });
      const unverifiedBefore = unverified.fake.hostMutationState();
      const gap = await executeLifecycle({ plan: capability, hosts: [unverified.planner], now });
      expect(gap.exitCode).toBe(1);
      expect(readLifecycleState().state.attempts).toEqual([]);
      expect(unverified.fake.hostMutationState()).toBe(unverifiedBefore);
    });
  });

  test('a second run of the same attempt continues from the journal instead of repeating a finished mutation', async () => {
    const root = temp('retry');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);

    await withHome(home, async () => {
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner],
      }));
      const applies = () => codex.fake.events.filter((event) => event === 'managed:apply').length;

      const first = await executeLifecycle({ plan, hosts: [codex.planner], now });
      const hostAfter = codex.fake.hostMutationState();
      const loaded = readLifecycleState();
      expect(first.exitCode).toBe(0);
      expect(applies()).toBe(1);
      expect(loaded.state.attempts).toHaveLength(1);
      expect(loaded.state.attempts[0]?.journal[0]?.state).toBe('completed');
      expect(loaded.state.activations.some((row) => row.packageId === 'alpha' && row.activationState === 'active')).toBe(true);

      const second = await executeLifecycle({ plan, hosts: [codex.planner], now });
      expect(second.exitCode).toBe(0);
      expect(applies()).toBe(1);
      expect(codex.fake.hostMutationState()).toBe(hostAfter);
      expect(readLifecycleState().state.attempts.filter((row) => row.id === plan.attemptId)).toHaveLength(1);
    });
  });

  test('cleanup failure after a confirmed activation keeps that activation and records pending cleanup', async () => {
    const root = temp('cleanup');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const codex = boundHost('codex', join(root, 'codex'), ['install', 'update']);

    await withHome(home, async () => {
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner],
      }));
      const before = codex.fake.hostMutationState();
      codex.fake.failPhase = 'cleanup:verified-commit';

      const executed = await executeLifecycle({ plan, hosts: [codex.planner], now });

      const loaded = readLifecycleState();
      const activation = loaded.state.activations.find((row) => row.packageId === 'alpha');
      const attempt = loaded.state.attempts.find((row) => row.id === plan.attemptId);
      expect(executed.exitCode).toBe(1);
      expect(codex.fake.events.includes('managed:apply')).toBe(true);
      expect(codex.fake.hostMutationState() === before).toBe(false);
      expect(activation?.activationState).toBe('active');
      expect(activation?.readbackState).toBe('verified');
      expect(activation?.pending).toEqual({
        operation: 'install',
        phase: 'cleanup',
        attemptId: plan.attemptId,
        startedAt: now,
      });
      expect(attempt?.mutationStarted).toBe(true);
      expect(attempt?.phase).toBe('finalizing');
      expect(attempt?.journal[0]?.state).toBe('cleanup-pending');
    });
  });
});

function temp(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `plgnz-executor-${label}-`));
  roots.push(root);
  return root;
}

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env['OPEN_PLUGIN_HOME'];
  process.env['OPEN_PLUGIN_HOME'] = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env['OPEN_PLUGIN_HOME'];
    else process.env['OPEN_PLUGIN_HOME'] = previous;
  }
}

function boundHost(kind: string, root: string, operations: readonly CapabilityOperation[]): { fake: FakeLifecycleHost; planner: PlannerHost } {
  const fake = new FakeLifecycleHost(realpathSync(mkdirTemp(root)), operations.length === 0 ? [] : [managedProfile(operations)]);
  return {
    fake,
    planner: { kinds: [kind], adapter: fake.adapter, plannedNativeId: (plugin: PluginSource) => plugin.name },
  };
}

function managedProfile(operations: readonly CapabilityOperation[]) {
  const semantics = Object.fromEntries(PACKAGE_SEMANTICS.map((semantic) => [semantic, 'supported'])) as Record<PackageSemantic, CapabilityStatus>;
  return createCapabilityEvidenceProfile({
    host: 'fixture',
    detectedVersion: '1.0.0',
    sourceTypes: ['local', 'git'],
    operations,
    route: 'managed',
    operationStatus: 'supported',
    semantics,
    evidence: ['docs/adr/0002-preflight-before-native-activation.md'],
  });
}

function manifest(entries: SyncManifest['entries']): SyncManifest {
  return parseSyncManifest({ schemaVersion: 1, entries });
}

function syncEntry(locator: string, kind: string) {
  return {
    operation: 'sync' as const,
    source: { kind: 'local' as const, locator },
    target: { kind, instance: 'default' },
  };
}

function expectFrozen(plan: LifecyclePlan): Extract<LifecyclePlan, { kind: 'frozen' }> {
  expect(plan.kind).toBe('frozen');
  if (plan.kind !== 'frozen') throw new Error('expected a frozen lifecycle plan');
  return plan;
}

function mkdirTemp(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function writePlugin(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'skills', 'a'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(join(dir, 'skills', 'a', 'SKILL.md'), '# skill\n');
  return realpathSync(dir);
}
