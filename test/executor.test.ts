import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilityEvidenceProfile, type CapabilityStatus } from '../src/capability-evidence';
import { executeLifecycle } from '../src/executor';
import { exitCodeForLifecycleReport } from '../src/lifecycle-report';
import { stateFile } from '../src/paths';
import { planLifecycle, type LifecyclePlan, type PlannerHost } from '../src/planner';
import { PACKAGE_SEMANTICS, type CapabilityOperation, type PackageSemantic } from '../src/semantic-inventory';
import type { PluginSource } from '../src/source';
import { readLifecycleState } from '../src/state';
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
