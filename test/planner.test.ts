import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilityEvidenceProfile, type CapabilityStatus } from '../src/capability-evidence';
import { createDeploymentScopeIdentity } from '../src/deployment-scope';
import { fingerprintTree } from '../src/fingerprint';
import { exitCodeForLifecycleReport } from '../src/lifecycle-report';
import { stateFile } from '../src/paths';
import { planLifecycle, type LifecyclePlan, type PlannerHost } from '../src/planner';
import { PACKAGE_SEMANTICS, type CapabilityOperation, type PackageSemantic } from '../src/semantic-inventory';
import type { PluginSource } from '../src/source';
import type { SourceBinding } from '../src/source-reference';
import { writeLifecycleState, writeState } from '../src/state-write';
import type { ActivationRecord, DesiredGenerationRecord, LifecycleStateV2 } from '../src/state';
import { parseSyncManifest, type SyncManifest, type SyncManifestPackageSelector } from '../src/sync-manifest';
import { FakeLifecycleHost } from './fake-lifecycle-adapter';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('lifecycle planner', () => {
  test('a deterministic ownership defect in the last scope plans nothing and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-planner-'));
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const beta = writePlugin(join(root, 'sources'), 'beta');
    const codex = new FakeLifecycleHost(join(root, 'codex'), []);
    const cursor = new FakeLifecycleHost(join(root, 'cursor'), []);
    cursor.seedActivation({
      nativeId: 'beta',
      scopeId: 'foreign-scope',
      packageName: 'beta',
      files: { 'payload.txt': 'beta-bytes\n' },
    });
    const codexBefore = codex.hostMutationState();
    const cursorBefore = cursor.hostMutationState();
    const manifest = parseSyncManifest({
      schemaVersion: 1,
      entries: [
        { operation: 'sync', source: { kind: 'local', locator: alpha }, target: { kind: 'codex', instance: 'default' } },
        { operation: 'sync', source: { kind: 'local', locator: beta }, target: { kind: 'cursor', instance: 'default' } },
      ],
    });
    const previousHome = process.env['OPEN_PLUGIN_HOME'];
    process.env['OPEN_PLUGIN_HOME'] = home;
    try {
      expect(existsSync(stateFile())).toBe(false);
      const plan = await planLifecycle({
        manifest,
        dryRun: true,
        validatedAt: '2026-10-10T00:00:00.000Z',
        hosts: [
          { kinds: ['codex'], adapter: codex.adapter, plannedNativeId: (plugin) => plugin.name },
          { kinds: ['cursor'], adapter: cursor.adapter, plannedNativeId: (plugin) => plugin.name },
        ],
      });
      expect(plan.kind).toBe('zero-write-failure');
      if (plan.kind !== 'zero-write-failure') return;
      expect(plan.report.plan).toEqual([]);
      expect(plan.report.outcomes).toEqual([]);
      expect(plan.report.summary).toEqual({
        result: 'incomplete',
        terminalPhase: 'preflight',
        mutationStarted: false,
        changed: false,
        failureCategory: 'internal',
        reason: {
          category: 'internal',
          code: 'internal.ambiguous-ownership',
          diagnostic: "package 'beta' on cursor/default is owned by scope 'foreign-scope'",
          capabilityId: null,
          evidenceId: null,
        },
        recoveryId: null,
        readbackId: null,
      });
      expect(plan.report.command).toEqual({ name: 'sync', dryRun: true, sourceSnapshots: [] });
      expect(exitCodeForLifecycleReport(plan.report)).toBe(1);
      expect(existsSync(stateFile())).toBe(false);
      expect(codex.hostMutationState()).toBe(codexBefore);
      expect(cursor.hostMutationState()).toBe(cursorBefore);
      expect(codex.events).toContain('inventory');
      expect(cursor.events).toContain('inventory');
      expect(codex.events.some(mutatingEvent)).toBe(false);
      expect(cursor.events.some(mutatingEvent)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env['OPEN_PLUGIN_HOME'];
      else process.env['OPEN_PLUGIN_HOME'] = previousHome;
    }
  });

  test('a capability gap stays with its pair, blocks that prune, and leaves another pair executable', async () => {
    const root = temp('gap');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const beta = writePlugin(join(root, 'sources'), 'beta');
    const gamma = writePlugin(join(root, 'sources'), 'gamma');
    const codex = boundHost('codex', join(root, 'codex'), []);
    const cursor = boundHost('cursor', join(root, 'cursor'), ['install', 'update']);
    const scopeId = createDeploymentScopeIdentity({ kind: 'local', locator: alpha }, { kind: 'codex', instance: 'default' }).id;
    codex.fake.seedActivation({ nativeId: 'stale', scopeId, packageName: 'stale' });
    await withHome(home, async () => {
      writeAuthoritative(alpha, 'codex', 'alpha', '.', [
        ownedActivation({ scopeId, packageId: 'stale', sourceRelativeDir: 'stale' }),
      ]);
      const before = readFileSync(stateFile(), 'utf8');
      const codexBefore = codex.fake.hostMutationState();
      const cursorBefore = cursor.fake.hostMutationState();
      const plan = await planLifecycle({
        manifest: manifest([
          syncEntry(alpha, 'codex'),
          syncEntry(beta, 'cursor'),
          syncEntry(gamma, 'kimi'),
        ]),
        dryRun: true,
        validatedAt: now,
        hosts: [codex.planner, cursor.planner],
      });
      const frozen = expectFrozen(plan);
      expect(actionOf(frozen, 'alpha')).toBe('not-attempted');
      expect(actionOf(frozen, 'beta')).toBe('install');
      expect(actionOf(frozen, 'gamma')).toBe('not-attempted');
      expect(frozen.operations.some((row) => row.operation.action === 'retire-orphan' || row.operation.package === 'stale')).toBe(false);
      expect(frozen.scopes.find((scope) => scope.scope.target.kind === 'codex')?.prune).toBe('blocked');
      expect(frozen.scopes.find((scope) => scope.scope.target.kind === 'codex')?.desired?.packages.map((row) => row.packageId)).toEqual(['alpha']);
      expect(reasonOf(frozen, 'alpha')?.code).toBe('capability.unverified');
      expect(reasonOf(frozen, 'gamma')?.capabilityId).toBe('lifecycle-adapter');
      expect(journalOf(frozen, 'alpha')).toEqual({ kind: 'none' });
      expect(journalOf(frozen, 'beta')).toEqual({ kind: 'required', action: 'install', mutation: true, readback: true });
      expect(frozen.report.summary.result).toBe('incomplete');
      expect(frozen.report.summary.failureCategory).toBe('capability');
      expect(frozen.report.summary.reason).toEqual(null);
      expect(frozen.report.summary.mutationStarted).toBe(false);
      expect(frozen.report.summary.changed).toBe(false);
      expect(exitCodeForLifecycleReport(frozen.report)).toBe(1);
      expect(readFileSync(stateFile(), 'utf8')).toBe(before);
      expect(codex.fake.hostMutationState()).toBe(codexBefore);
      expect(cursor.fake.hostMutationState()).toBe(cursorBefore);
      expect(codex.fake.events.some(mutatingEvent)).toBe(false);
      expect(cursor.fake.events.some(mutatingEvent)).toBe(false);
    });
  });

  test('a conforming owned prior is retained when the route is unverified, and that scope is not pruned', async () => {
    const root = temp('retain');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const host = boundHost('codex', join(root, 'codex'), []);
    const scopeId = createDeploymentScopeIdentity({ kind: 'local', locator: alpha }, { kind: 'codex', instance: 'default' }).id;
    host.fake.seedActivation({ nativeId: 'alpha', scopeId, packageName: 'alpha', sourceType: 'local', sourceLocator: null });
    host.fake.seedActivation({ nativeId: 'stale', scopeId, packageName: 'stale', sourceType: 'local', sourceLocator: null });
    await withHome(home, async () => {
      writeAuthoritative(alpha, 'codex', 'alpha', '.', [
        ownedActivation({ scopeId, packageId: 'alpha', activationState: 'active', readbackState: 'verified' }),
        ownedActivation({ scopeId, packageId: 'stale', sourceRelativeDir: 'stale' }),
      ]);
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: true,
        validatedAt: now,
        hosts: [host.planner],
      }));
      expect(actionOf(plan, 'alpha')).toBe('retain-prior');
      expect(plan.operations.find((row) => row.operation.package === 'alpha')?.operation.route).toBe('managed');
      expect(journalOf(plan, 'alpha')).toEqual({ kind: 'required', action: 'retain-prior', mutation: false, readback: false });
      const retained = plan.report.outcomes.find((row) => row.package === 'alpha');
      expect(retained?.result).toBe('failed');
      expect(retained?.resourceState).toBe('retained');
      expect(retained?.activationState).toBe('retained-prior');
      expect(retained?.changed).toBe(false);
      expect(plan.operations.some((row) => row.operation.action === 'retire-orphan')).toBe(false);
      expect(plan.scopes[0]?.prune).toBe('blocked');
      expect(plan.report.summary.result).toBe('incomplete');
      expect(exitCodeForLifecycleReport(plan.report)).toBe(1);
    });
  });

  test('disable-nonconforming is a journaled dry-run containment and blocks orphan prune', async () => {
    const root = temp('disable');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const beta = writePlugin(join(root, 'sources'), 'beta');
    const codex = boundHost('codex', join(root, 'codex'), ['disable']);
    const cursor = boundHost('cursor', join(root, 'cursor'), ['install', 'update']);
    const scopeId = createDeploymentScopeIdentity({ kind: 'local', locator: alpha }, { kind: 'codex', instance: 'default' }).id;
    codex.fake.seedActivation({ nativeId: 'alpha', scopeId, packageName: 'alpha', sourceType: 'local', sourceLocator: null });
    codex.fake.seedActivation({ nativeId: 'stale', scopeId, packageName: 'stale', sourceType: 'local', sourceLocator: null });
    await withHome(home, async () => {
      writeAuthoritative(alpha, 'codex', 'alpha', '.', [
        ownedActivation({ scopeId, packageId: 'alpha', activationState: 'nonconforming', readbackState: 'unverified' }),
        ownedActivation({ scopeId, packageId: 'stale', sourceRelativeDir: 'stale' }),
      ]);
      const before = readFileSync(stateFile(), 'utf8');
      const codexBefore = codex.fake.hostMutationState();
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex'), syncEntry(beta, 'cursor')]),
        dryRun: true,
        validatedAt: now,
        hosts: [codex.planner, cursor.planner],
      }));
      expect(actionOf(plan, 'alpha')).toBe('disable-nonconforming');
      expect(actionOf(plan, 'beta')).toBe('install');
      expect(journalOf(plan, 'alpha')).toEqual({ kind: 'required', action: 'disable-nonconforming', mutation: true, readback: true });
      const contained = plan.report.outcomes.find((row) => row.package === 'alpha');
      expect(contained?.result).toBe('failed');
      expect(contained?.resourceState).toBe('retained');
      expect(contained?.activationState).toBe('active-nonconforming');
      expect(contained?.changed).toBe(false);
      expect(plan.operations.some((row) => row.operation.action === 'retire-orphan')).toBe(false);
      expect(plan.scopes.find((scope) => scope.scope.id === scopeId)?.prune).toBe('blocked');
      expect(plan.report.command.dryRun).toBe(true);
      expect(plan.report.summary.mutationStarted).toBe(false);
      expect(plan.report.summary.changed).toBe(false);
      expect(plan.report.plan).toEqual(plan.operations.map((row) => row.operation));
      expect(readFileSync(stateFile(), 'utf8')).toBe(before);
      expect(codex.fake.hostMutationState()).toBe(codexBefore);
      expect(codex.fake.events.some(mutatingEvent)).toBe(false);
    });
  });

  test('a live disable-nonconforming plan describes containment and does not throw', async () => {
    const root = temp('disable-live');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const beta = writePlugin(join(root, 'sources'), 'beta');
    const codex = boundHost('codex', join(root, 'codex'), ['disable']);
    const cursor = boundHost('cursor', join(root, 'cursor'), ['install', 'update']);
    const scopeId = createDeploymentScopeIdentity({ kind: 'local', locator: alpha }, { kind: 'codex', instance: 'default' }).id;
    codex.fake.seedActivation({ nativeId: 'alpha', scopeId, packageName: 'alpha', sourceType: 'local', sourceLocator: null });
    await withHome(home, async () => {
      writeAuthoritative(alpha, 'codex', 'alpha', '.', [
        ownedActivation({ scopeId, packageId: 'alpha', activationState: 'nonconforming', readbackState: 'unverified' }),
      ]);
      const before = readFileSync(stateFile(), 'utf8');
      const codexBefore = codex.fake.hostMutationState();
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex'), syncEntry(beta, 'cursor')]),
        dryRun: false,
        validatedAt: now,
        hosts: [codex.planner, cursor.planner],
      }));
      expect(plan.requestedDryRun).toBe(false);
      expect(actionOf(plan, 'alpha')).toBe('disable-nonconforming');
      expect(journalOf(plan, 'alpha')).toEqual({ kind: 'required', action: 'disable-nonconforming', mutation: true, readback: true });
      const contained = plan.report.outcomes.find((row) => row.package === 'alpha');
      expect(contained?.result).toBe('failed');
      expect(contained?.resourceState).toBe('retained');
      expect(contained?.activationState).toBe('active-nonconforming');
      expect(contained?.changed).toBe(false);
      expect(plan.report.command.dryRun).toBe(false);
      expect(plan.report.summary.mutationStarted).toBe(false);
      expect(plan.report.summary.changed).toBe(false);
      expect(plan.report.summary.terminalPhase).toBe('preflight');
      expect(plan.report.plan).toEqual(plan.operations.map((row) => row.operation));
      expect(readFileSync(stateFile(), 'utf8')).toBe(before);
      expect(codex.fake.hostMutationState()).toBe(codexBefore);
      expect(codex.fake.events.some(mutatingEvent)).toBe(false);
    });
  });

  test('explicit selectors omit unselected siblings and an unfiltered sync enrolls every sibling', async () => {
    const root = temp('select');
    const home = join(root, 'home');
    mkdirSync(home);
    const collection = writeCollection(root, ['alpha', 'beta']);
    const host = boundHost('codex', join(root, 'codex'), ['install', 'update']);
    await withHome(home, async () => {
      const explicit = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(collection.source, 'codex', [{ package: 'alpha', adoptExisting: false }])]),
        dryRun: true,
        validatedAt: now,
        hosts: [host.planner],
      }));
      const open = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(collection.source, 'codex')]),
        dryRun: true,
        validatedAt: now,
        hosts: [host.planner],
      }));
      expect(explicit.scopes[0]?.selectorMode).toBe('explicit');
      expect(explicit.operations.map((row) => row.operation.package)).toEqual(['alpha']);
      expect(open.scopes[0]?.selectorMode).toBe('all');
      expect(open.operations.map((row) => row.operation.package).sort()).toEqual(['alpha', 'beta']);
      expect(open.scopes[0]?.desired?.packages.map((row) => row.packageId).sort()).toEqual(['alpha', 'beta']);
    });
  });

  test('a dry-run returns the executable plan, stable operation ids, and writes nothing', async () => {
    const root = temp('actions');
    const home = join(root, 'home');
    mkdirSync(home);
    const collection = writeCollection(root, ['alpha', 'beta', 'gamma', 'delta']);
    const host = boundHost('codex', join(root, 'codex'), ['install', 'update']);
    const source = { kind: 'local' as const, locator: collection.source };
    const target = { kind: 'codex', instance: 'default' };
    const scopeId = createDeploymentScopeIdentity(source, target).id;
    const betaInstalled = host.fake.seedActivation({ nativeId: 'beta', scopeId, packageName: 'beta', sourceType: 'local', sourceLocator: null });
    const gammaInstalled = host.fake.seedActivation({ nativeId: 'gamma', scopeId, packageName: 'gamma', sourceType: 'local', sourceLocator: null });
    host.fake.seedActivation({ nativeId: 'delta', scopeId, packageName: 'delta', sourceType: 'local', sourceLocator: null });
    await withHome(home, async () => {
      writeAuthoritative(collection.source, 'codex', 'alpha', 'alpha', [
        ownedActivation({
          scopeId,
          packageId: 'beta',
          sourceRelativeDir: 'beta',
          sourceFingerprint: 'not-the-source',
          installedFingerprint: betaInstalled,
        }),
        ownedActivation({
          scopeId,
          packageId: 'gamma',
          sourceRelativeDir: 'gamma',
          sourceFingerprint: fingerprintTree(collection.plugins['gamma'] ?? ''),
          installedFingerprint: gammaInstalled,
        }),
        ownedActivation({
          scopeId,
          packageId: 'delta',
          sourceRelativeDir: 'delta',
          route: 'native',
          sourceFingerprint: 'not-the-source',
          installedFingerprint: 'not-the-install',
        }),
      ]);
      const before = readFileSync(stateFile(), 'utf8');
      const hostBefore = host.fake.hostMutationState();
      const input = {
        manifest: manifest([syncEntry(collection.source, 'codex')]),
        validatedAt: now,
        hosts: [host.planner],
      };
      const dry = expectFrozen(await planLifecycle({ ...input, dryRun: true }));
      const live = expectFrozen(await planLifecycle({ ...input, dryRun: false }));
      expect(actionMap(dry)).toEqual({ alpha: 'install', beta: 'retain-prior', gamma: 'unchanged', delta: 'retain-prior' });
      expect(dry.operations.map((row) => row.operation.operationId)).toEqual(live.operations.map((row) => row.operation.operationId));
      expect(dry.attemptId).toBe(live.attemptId);
      expect(new Set(dry.operations.map((row) => row.operation.operationId)).size).toBe(4);
      expect(dry.operations.every((row) => /^operation-v1-[0-9a-f]{64}$/u.test(row.operation.operationId))).toBe(true);
      expect(dry.attemptId).toMatch(/^attempt-v1-[0-9a-f]{64}$/u);
      expect(journalOf(dry, 'gamma')).toEqual({ kind: 'required', action: 'unchanged', mutation: false, readback: false });
      expect(journalOf(dry, 'delta')).toEqual({ kind: 'required', action: 'retain-prior', mutation: false, readback: false });
      expect(dry.operations.filter((row) => row.operation.package === 'beta' || row.operation.package === 'delta').map((row) => row.reason?.code)).toEqual(['capability.unsupported', 'capability.unsupported']);
      expect(dry.report.plan).toEqual(dry.operations.map((row) => row.operation));
      expect(dry.report.command.name).toBe('sync');
      expect(dry.report.command.dryRun).toBe(true);
      expect(dry.report.summary.result).toBe('incomplete');
      expect(dry.report.summary.terminalPhase).toBe('preflight');
      expect(dry.report.summary.mutationStarted).toBe(false);
      expect(dry.report.summary.changed).toBe(false);
      expect(dry.report.summary.failureCategory).toEqual('capability');
      expect(dry.report.summary.reason).toEqual(null);
      expect(live.report.command.dryRun).toBe(false);
      expect(live.report.summary.changed).toBe(false);
      expect(live.report.summary.mutationStarted).toBe(false);
      expect(exitCodeForLifecycleReport(dry.report)).toBe(1);
      expect(readFileSync(stateFile(), 'utf8')).toBe(before);
      expect(host.fake.hostMutationState()).toBe(hostBefore);
      expect(host.fake.events.some(mutatingEvent)).toBe(false);
      const again = expectFrozen(await planLifecycle({ ...input, dryRun: true }));
      expect(again.operations.map((row) => row.operation.operationId)).toEqual(dry.operations.map((row) => row.operation.operationId));
    });
  });

  test('a v1 omission stays unpruned even when the host calls it owned', async () => {
    const root = temp('v1');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const host = boundHost('codex', join(root, 'codex'), ['install', 'update', 'retire']);
    const scopeId = createDeploymentScopeIdentity({ kind: 'local', locator: alpha }, { kind: 'codex', instance: 'default' }).id;
    host.fake.seedActivation({ nativeId: 'stale', scopeId, packageName: 'stale', sourceType: 'local', sourceLocator: null });
    await withHome(home, async () => {
      writeState([{ host: 'codex', id: 'stale', source: alpha, sourceSha: 'v1' }]);
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: true,
        validatedAt: now,
        hosts: [host.planner],
      }));
      expect(actionOf(plan, 'alpha')).toBe('install');
      expect(plan.operations.some((row) => row.operation.action === 'retire-orphan' || row.operation.package === 'stale')).toBe(false);
      expect(plan.scopes[0]?.prune).toBe('blocked');
    });
  });

  test('an authoritative converged scope plans a revalidated orphan retirement', async () => {
    const root = temp('prune');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const host = boundHost('codex', join(root, 'codex'), ['install', 'update', 'retire']);
    const scopeId = createDeploymentScopeIdentity({ kind: 'local', locator: alpha }, { kind: 'codex', instance: 'default' }).id;
    const installed = host.fake.seedActivation({ nativeId: 'stale', scopeId, packageName: 'stale', sourceType: 'local', sourceLocator: null });
    await withHome(home, async () => {
      writeAuthoritative(alpha, 'codex', 'alpha', '.', [
        ownedActivation({
          scopeId,
          packageId: 'stale',
          sourceRelativeDir: 'stale',
          installedFingerprint: installed,
          sourceRevision: 'recorded-local-revision',
        }),
      ]);
      const before = readFileSync(stateFile(), 'utf8');
      const hostBefore = host.fake.hostMutationState();
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: true,
        validatedAt: now,
        hosts: [host.planner],
      }));
      expect(actionOf(plan, 'alpha')).toBe('install');
      expect(actionOf(plan, 'stale')).toBe('retire-orphan');
      expect(plan.operations.find((row) => row.operation.package === 'stale')?.operation.coverage).toBe('retirement');
      expect(journalOf(plan, 'stale')).toEqual({ kind: 'required', action: 'retire-orphan', mutation: true, readback: true });
      expect(plan.scopes[0]?.prune).toBe('planned');
      expect(plan.report.summary.result).toBe('converged');
      expect(plan.report.command.dryRun).toBe(true);
      expect(plan.report.summary.changed).toBe(false);
      expect(readFileSync(stateFile(), 'utf8')).toBe(before);
      expect(host.fake.hostMutationState()).toBe(hostBefore);
      expect(host.fake.events.some(mutatingEvent)).toBe(false);
    });
  });

  test('an omission without host revalidation is a refusal row and blocks prune', async () => {
    const root = temp('omission-refusal');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const host = boundHost('codex', join(root, 'codex'), ['install', 'update', 'retire']);
    const scopeId = createDeploymentScopeIdentity({ kind: 'local', locator: alpha }, { kind: 'codex', instance: 'default' }).id;
    await withHome(home, async () => {
      writeAuthoritative(alpha, 'codex', 'alpha', '.', [
        ownedActivation({ scopeId, packageId: 'stale', sourceRelativeDir: 'stale' }),
      ]);
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([syncEntry(alpha, 'codex')]),
        dryRun: false,
        validatedAt: now,
        hosts: [host.planner],
      }));
      expect(actionOf(plan, 'alpha')).toBe('install');
      expect(actionOf(plan, 'stale')).toBe('not-attempted');
      expect(plan.operations.find((row) => row.operation.package === 'stale')?.operation.coverage).toBe('retirement');
      expect(plan.operations.some((row) => row.operation.action === 'retire-orphan')).toBe(false);
      expect(plan.scopes[0]?.prune).toBe('blocked');
      expect(reasonOf(plan, 'stale')?.diagnostic).toBe("ownership of 'stale' was not revalidated");
    });
  });

  test('scope identity includes the target instance', async () => {
    const root = temp('instance');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const eastRoot = realpathSync(mkdirTemp(join(root, 'east')));
    const westRoot = realpathSync(mkdirTemp(join(root, 'west')));
    const host = boundHost('hermes', join(root, 'hermes'), ['install', 'update']);
    await withHome(home, async () => {
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([
          {
            operation: 'sync',
            source: { kind: 'local', locator: alpha },
            target: { kind: 'hermes', instance: 'east', context: { root: eastRoot, configPath: join(eastRoot, 'config.yaml') } },
          },
          {
            operation: 'sync',
            source: { kind: 'local', locator: alpha },
            target: { kind: 'hermes', instance: 'west', context: { root: westRoot, configPath: join(westRoot, 'config.yaml') } },
          },
        ]),
        dryRun: true,
        validatedAt: now,
        hosts: [host.planner],
      }));
      const ids = Object.fromEntries(plan.scopes.map((scope) => [scope.scope.target.instance, scope.scope.id]));
      expect(ids['east']).toMatch(/^scope-v1-[0-9a-f]{64}$/u);
      expect(ids['west']).toMatch(/^scope-v1-[0-9a-f]{64}$/u);
      expect(ids['east'] === ids['west']).toBe(false);
      expect(plan.operations.map((row) => row.operation.scope.target.instance).sort()).toEqual(['east', 'west']);
      expect(plan.operations.every((row) => row.operation.action === 'install')).toBe(true);
    });
  });

  test('an unknown retire-source scope is a usage failure and writes nothing', async () => {
    const root = temp('retire-unknown');
    const home = join(root, 'home');
    mkdirSync(home);
    const host = boundHost('codex', join(root, 'codex'), ['retire']);
    const scopeId = `scope-v1-${'a'.repeat(64)}`;
    await withHome(home, async () => {
      const plan = await planLifecycle({
        manifest: manifest([{ operation: 'retire-source', scopeId, target: { kind: 'codex', instance: 'default' } }]),
        dryRun: true,
        validatedAt: now,
        hosts: [host.planner],
      });
      expect(plan.kind).toBe('zero-write-failure');
      if (plan.kind !== 'zero-write-failure') return;
      expect(plan.report.plan).toEqual([]);
      expect(plan.report.command.name).toBe('retire-source');
      expect(plan.report.summary.result).toBe('usage-error');
      expect(plan.report.summary.terminalPhase).toBe('parse');
      expect(plan.report.summary.reason?.code).toBe('usage.invalid-selection');
      expect(exitCodeForLifecycleReport(plan.report)).toBe(2);
      expect(existsSync(stateFile())).toBe(false);
      expect(host.fake.events.some(mutatingEvent)).toBe(false);
    });
  });

  test('retire-source plans a revalidated orphan and refuses a retarget', async () => {
    const root = temp('retire-source');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const host = boundHost('codex', join(root, 'codex'), ['retire']);
    const scopeId = createDeploymentScopeIdentity({ kind: 'local', locator: alpha }, { kind: 'codex', instance: 'default' }).id;
    const installed = host.fake.seedActivation({ nativeId: 'alpha', scopeId, packageName: 'alpha', sourceType: 'local', sourceLocator: null });
    await withHome(home, async () => {
      writeAuthoritative(alpha, 'codex', 'alpha', '.', [
        ownedActivation({ scopeId, packageId: 'alpha', installedFingerprint: installed, sourceRevision: 'recorded-local-revision' }),
      ]);
      const before = readFileSync(stateFile(), 'utf8');
      const hostBefore = host.fake.hostMutationState();
      const retired = expectFrozen(await planLifecycle({
        manifest: manifest([{ operation: 'retire-source', scopeId, target: { kind: 'codex', instance: 'default' } }]),
        dryRun: true,
        validatedAt: now,
        hosts: [host.planner],
      }));
      expect(retired.report.command.name).toBe('retire-source');
      expect(actionOf(retired, 'alpha')).toBe('retire-orphan');
      expect(retired.scopes[0]?.selectorMode).toBe('retired');
      expect(retired.scopes[0]?.desired).toEqual(null);
      expect(retired.report.summary.result).toBe('converged');
      expect(retired.report.summary.changed).toBe(false);
      expect(readFileSync(stateFile(), 'utf8')).toBe(before);
      expect(host.fake.hostMutationState()).toBe(hostBefore);
      expect(host.fake.events.some(mutatingEvent)).toBe(false);

      const retarget = await planLifecycle({
        manifest: manifest([{ operation: 'retire-source', scopeId, target: { kind: 'cursor', instance: 'default' } }]),
        dryRun: false,
        validatedAt: now,
        hosts: [host.planner],
      });
      expect(retarget.kind).toBe('zero-write-failure');
      if (retarget.kind !== 'zero-write-failure') return;
      expect(retarget.report.summary.reason?.code).toBe('usage.invalid-selection');
      expect(retarget.report.plan).toEqual([]);
      expect(readFileSync(stateFile(), 'utf8')).toBe(before);
      expect(host.fake.hostMutationState()).toBe(hostBefore);
    });
  });

  test('retire-source plans prune only when every activation is retire-orphan', async () => {
    const root = temp('retire-mixed');
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const host = boundHost('codex', join(root, 'codex'), ['retire']);
    const scopeId = createDeploymentScopeIdentity({ kind: 'local', locator: alpha }, { kind: 'codex', instance: 'default' }).id;
    const installed = host.fake.seedActivation({ nativeId: 'alpha', scopeId, packageName: 'alpha', sourceType: 'local', sourceLocator: null });
    await withHome(home, async () => {
      writeAuthoritative(alpha, 'codex', 'alpha', '.', [
        ownedActivation({ scopeId, packageId: 'alpha', installedFingerprint: installed, sourceRevision: 'recorded-local-revision' }),
        ownedActivation({ scopeId, packageId: 'beta', sourceRelativeDir: 'beta', sourceRevision: 'recorded-local-revision' }),
      ]);
      const plan = expectFrozen(await planLifecycle({
        manifest: manifest([{ operation: 'retire-source', scopeId, target: { kind: 'codex', instance: 'default' } }]),
        dryRun: false,
        validatedAt: now,
        hosts: [host.planner],
      }));
      expect(actionOf(plan, 'alpha')).toBe('retire-orphan');
      expect(actionOf(plan, 'beta')).toBe('not-attempted');
      expect(plan.scopes[0]?.prune).toBe('blocked');
    });
  });
});

function mutatingEvent(event: string): boolean {
  return event === 'stage'
    || event === 'directives'
    || event === 'pins'
    || event === 'disable-prepare'
    || event === 'retire-prepare'
    || event.includes('apply')
    || event === 'disable'
    || event === 'retire';
}

const now = '2026-10-10T00:00:00.000Z';
const evidenceKey = `sha256:${'a'.repeat(64)}`;
const proofKey = `sha256:${'b'.repeat(64)}`;

function temp(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `plgnz-planner-${label}-`));
  roots.push(root);
  return root;
}

function mkdirTemp(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
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

function syncEntry(locator: string, kind: string, selectors?: SyncManifestPackageSelector[]) {
  return {
    operation: 'sync' as const,
    source: { kind: 'local' as const, locator },
    target: { kind, instance: 'default' },
    ...(selectors === undefined ? {} : { selectors }),
  };
}

function writeCollection(parent: string, names: readonly string[]): { source: string; plugins: Record<string, string> } {
  const dir = join(parent, 'collection');
  const plugins: Record<string, string> = {};
  for (const name of names) plugins[name] = writePlugin(dir, name);
  return { source: realpathSync(dir), plugins };
}

function writeAuthoritative(locator: string, kind: string, packageId: string, relativeDir: string, activations: ActivationRecord[]): void {
  const source: SourceBinding = { kind: 'local', locator };
  const target = { kind, instance: 'default' };
  const scopeId = createDeploymentScopeIdentity(source, target).id;
  const desired = generation(packageId, relativeDir);
  const state: LifecycleStateV2 = {
    version: 2,
    stateGeneration: 1,
    scopes: [{
      id: scopeId,
      source,
      target,
      authority: 'authoritative',
      lifecycle: 'active',
      selectorMode: 'explicit',
      desired,
      lastConverged: desired,
    }],
    activations,
    attempts: [],
    tombstones: [],
  };
  writeLifecycleState(state, { globalPreflight: 'succeeded' });
}

function generation(packageId: string, relativeDir: string): DesiredGenerationRecord {
  return {
    generation: 1,
    revision: '1'.repeat(40),
    sourceFingerprint: 'c'.repeat(64),
    packages: [{
      packageId,
      nativeId: packageId,
      sourceRelativeDir: relativeDir,
      requiredCapabilities: ['activation-reload', 'ordinary-skills', 'readback', 'rollback'],
      adoptionRequested: false,
    }],
    validatedAt: now,
  };
}

function ownedActivation(input: {
  scopeId: string;
  packageId: string;
  sourceRelativeDir?: string;
  route?: 'managed' | 'native';
  activationState?: ActivationRecord['activationState'];
  readbackState?: ActivationRecord['readbackState'];
  sourceFingerprint?: string;
  installedFingerprint?: string;
  sourceRevision?: string;
}): ActivationRecord {
  return {
    scopeId: input.scopeId,
    packageId: input.packageId,
    nativeId: input.packageId,
    sourceRelativeDir: input.sourceRelativeDir ?? '.',
    sourceRevision: input.sourceRevision ?? 'recorded-local-revision',
    route: { kind: input.route ?? 'managed', evidenceKey: { kind: 'capability-profile', key: evidenceKey } },
    ownership: { kind: 'created', proofKey: { kind: 'managed-marker', key: proofKey }, verifiedAt: now },
    fingerprints: {
      source: input.sourceFingerprint ?? 'd'.repeat(64),
      projected: 'e'.repeat(64),
      installed: input.installedFingerprint ?? 'f'.repeat(64),
    },
    activationState: input.activationState ?? 'active',
    readbackState: input.readbackState ?? 'verified',
    pins: [],
    activatedAt: now,
    readbackAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function expectFrozen(plan: LifecyclePlan): Extract<LifecyclePlan, { kind: 'frozen' }> {
  expect(plan.kind).toBe('frozen');
  if (plan.kind !== 'frozen') throw new Error('expected a frozen lifecycle plan');
  return plan;
}

function actionOf(plan: Extract<LifecyclePlan, { kind: 'frozen' }>, packageName: string): string | undefined {
  return plan.operations.find((row) => row.operation.package === packageName)?.operation.action;
}

function actionMap(plan: Extract<LifecyclePlan, { kind: 'frozen' }>): Record<string, string> {
  return Object.fromEntries(plan.operations.map((row) => [row.operation.package, row.operation.action]));
}

function journalOf(plan: Extract<LifecyclePlan, { kind: 'frozen' }>, packageName: string) {
  return plan.operations.find((row) => row.operation.package === packageName)?.journal;
}

function reasonOf(plan: Extract<LifecyclePlan, { kind: 'frozen' }>, packageName: string) {
  return plan.operations.find((row) => row.operation.package === packageName)?.reason;
}

function writePlugin(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'skills', 'a'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(join(dir, 'skills', 'a', 'SKILL.md'), '# skill\n');
  return realpathSync(dir);
}
