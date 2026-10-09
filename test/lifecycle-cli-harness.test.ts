import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  bytesToText,
  textToBytes,
  withLifecycleCliHarness,
  type StateDocument,
} from './lifecycle-cli-harness';
import { initGitRepo } from './util';
import { parseLifecycleReport } from '../src/lifecycle-report';
import { createDeploymentScopeIdentity } from '../src/deployment-scope';
import type { LifecycleStateV2 } from '../src/state';

const lifecycleTime = '2026-10-09T00:00:00.000Z';

function scopedV2State(entries: ReadonlyArray<{ source: string; instance: string }>): LifecycleStateV2 {
  const rows = entries.map(({ source: locator, instance }) => {
    const source = { kind: 'local', locator } as const;
    const identity = createDeploymentScopeIdentity(source, { kind: 'cursor', instance });
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
          packages: [{
            packageId: 'demo',
            nativeId: 'demo',
            sourceRelativeDir: 'demo',
            requiredCapabilities: [],
            adoptionRequested: false,
          }],
          validatedAt: lifecycleTime,
        },
      },
      activation: {
        scopeId: identity.id,
        packageId: 'demo',
        nativeId: 'demo',
        sourceRevision: 'revision-1',
        route: { kind: 'managed' as const, evidenceKey: { kind: 'capability-profile' as const, key: `sha256:${'a'.repeat(64)}` } },
        ownership: { kind: 'created' as const, proofKey: { kind: 'managed-marker' as const, key: `sha256:${'b'.repeat(64)}` }, verifiedAt: lifecycleTime },
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

describe('isolated lifecycle CLI harness', () => {
  test('legacy update and remove reject an ambiguous v2 target instance before adapter work', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const first = harness.source('ambiguous-first', { 'plugin.json': '{"name":"demo","version":"1.0.0"}\n' });
      const second = harness.source('ambiguous-second', { 'plugin.json': '{"name":"demo","version":"1.0.0"}\n' });
      const state = JSON.stringify(scopedV2State([
        { source: first, instance: 'default' },
        { source: second, instance: 'default' },
      ]));
      harness.writeHome({ 'state.json': state });

      for (const args of [
        ['update', 'demo', '--target', 'cursor', '--dry-run', '--json'],
        ['remove', 'demo', '--target', 'cursor', '--dry-run', '--json'],
      ]) {
        const result = harness.run(args);
        const report = parseLifecycleReport(JSON.parse(result.stdout));
        expect({
          exitCode: result.exitCode,
          stderr: result.stderr,
          plan: report.plan,
          outcomes: report.outcomes,
          reason: report.summary.reason,
          phase: report.summary.terminalPhase,
          mutationStarted: report.summary.mutationStarted,
          stateUnchanged: bytesToText(result.state.before!) === bytesToText(result.state.after!),
        }).toEqual({
          exitCode: 1,
          stderr: '',
          plan: [],
          outcomes: [],
          reason: {
            category: 'internal',
            code: 'internal.ambiguous-ownership',
            diagnostic: "multiple cursor/default deployment scopes own native package 'demo'",
            capabilityId: null,
            evidenceId: null,
          },
          phase: 'preflight',
          mutationStarted: false,
          stateUnchanged: true,
        });
      }
    });
  });

  test('legacy update and remove carry the exact default v2 instance instead of the first same-kind scope', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const work = harness.source('instance-work', { 'plugin.json': '{"name":"demo","version":"1.0.0"}\n' });
      const defaultSource = harness.source('instance-default', { 'plugin.json': '{"name":"demo","version":"1.0.0"}\n' });
      harness.writeHome({
        'state.json': JSON.stringify(scopedV2State([
          { source: work, instance: 'work' },
          { source: defaultSource, instance: 'default' },
        ])),
      });

      for (const command of ['update', 'remove'] as const) {
        const result = harness.run([command, 'demo', '--target', 'cursor', '--dry-run', '--json']);
        const report = parseLifecycleReport(JSON.parse(result.stdout));
        expect({
          exitCode: result.exitCode,
          planLength: report.plan.length,
          planInstance: report.plan[0]?.scope.target.instance,
          planSource: report.plan[0]?.scope.source,
          outcomeInstance: report.outcomes[0]?.scope.target.instance,
        }).toEqual({
          exitCode: 0,
          planLength: 1,
          planInstance: 'default',
          planSource: { kind: 'local', locator: defaultSource },
          outcomeInstance: 'default',
        });
      }
    });
  });

  test('runs the real CLI across host stores without touching the ambient home', async () => {
    let fixtureRoot = '';

    await withLifecycleCliHarness(async (harness) => {
      fixtureRoot = harness.root;
      harness.writeAmbient({ 'sentinel.txt': 'outside the managed home\n' });
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('demo-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0","description":"Harness fixture"}\n',
        'skills/demo/SKILL.md': '---\nname: demo\ndescription: Harness fixture\n---\n\nDemo body.\n',
      });
      const claude = harness.fakeNative('claude', [
        { args: ['--version'], stdout: '2.1.275 (Claude Code)\n' },
        { args: ['--version'], stdout: '2.1.275 (Claude Code)\n' },
      ]);

      const result = harness.run(
        ['add', source, '--target', 'claude-code', '--target', 'cursor', '--json'],
        { env: { OPEN_PLUGIN_CLAUDE_CODE_BIN: claude.path } },
      );
      const state = JSON.parse(bytesToText(result.state.after!)) as StateDocument;
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        schemaVersion: report.schemaVersion,
        operationIds: report.plan.map(({ operationId }) => operationId),
        operationIdsMatchOutcomes: report.plan.map(({ operationId }) => operationId).join('\n') === report.outcomes.map(({ operationId }) => operationId).join('\n'),
        sourceSnapshots: report.command.sourceSnapshots.map(({ id, reference }) => ({ id, binding: reference.binding, fingerprintIsSha256: /^[a-f0-9]{64}$/u.test(reference.fingerprint) })),
        outcomes: report.outcomes.map(({ package: packageName, nativeId, scope, result, resourceState, activationState, route, changed }) => ({
          package: packageName,
          nativeId,
          target: scope.target,
          scopeId: scope.id,
          scopeIdIsStableHash: /^scope-v1-[a-f0-9]{64}$/u.test(scope.id),
          result,
          resourceState,
          activationState,
          route,
          changed,
        })),
        summary: report.summary,
        statePairs: state.installs.map(({ host, id, pending }) => ({ host, id, pending })),
        authoredSourceDirs: state.installs.map(({ sourceDir }) => sourceDir),
        cursorManifest: bytesToText(result.stores['cursor']!.after.files['plugins/local/demo/plugin.json']!),
        claudeManifest: bytesToText(result.stores['claude-code']!.after.files['plugins/cache/local/demo/local/plugin.json']!),
        nativeInvocations: result.nativeInvocations['claude'],
        ambientHomeUnchanged: result.ambient.before,
        ambientHomeAfter: result.ambient.after,
      }).toEqual({
        exitCode: 0,
        stderr: '',
        schemaVersion: 1,
        operationIds: report.outcomes.map(({ scope, package: packageName }) => `add:desired-pair:${scope.id}:${packageName}`),
        operationIdsMatchOutcomes: true,
        sourceSnapshots: [{ id: 'source-0', binding: { kind: 'local', locator: source }, fingerprintIsSha256: true }],
        outcomes: [
          { package: 'demo', nativeId: 'demo@local', target: { kind: 'claude-code', instance: 'default' }, scopeId: report.outcomes[0]!.scope.id, scopeIdIsStableHash: true, result: 'succeeded', resourceState: 'present', activationState: 'active-conforming', route: 'managed', changed: true },
          { package: 'demo', nativeId: 'demo', target: { kind: 'cursor', instance: 'default' }, scopeId: report.outcomes[1]!.scope.id, scopeIdIsStableHash: true, result: 'succeeded', resourceState: 'present', activationState: 'active-conforming', route: 'managed', changed: true },
        ],
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
        statePairs: [
          { host: 'claude-code', id: 'demo@local', pending: undefined },
          { host: 'cursor', id: 'demo', pending: undefined },
        ],
        authoredSourceDirs: [source, source],
        cursorManifest: '{"name":"demo","version":"1.0.0","description":"Harness fixture"}\n',
        claudeManifest: '{"name":"demo","version":"1.0.0","description":"Harness fixture"}\n',
        nativeInvocations: [{ args: ['--version'] }, { args: ['--version'] }],
        ambientHomeUnchanged: {
          directories: [],
          files: { 'sentinel.txt': textToBytes('outside the managed home\n') },
          symlinks: {},
        },
        ambientHomeAfter: {
          directories: [],
          files: { 'sentinel.txt': textToBytes('outside the managed home\n') },
          symlinks: {},
        },
      });
    });

    expect(existsSync(fixtureRoot)).toBe(false);
  });

  test('injects and accounts for a native boundary failure', async () => {
    await withLifecycleCliHarness(async (harness) => {
      const source = harness.source('failure-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const claude = harness.fakeNative('claude', [
        { args: ['--version'], stderr: 'forced native failure\n', exitCode: 41 },
      ]);

      const result = harness.run(
        ['add', source, '--target', 'claude-code', '--json'],
        { env: { OPEN_PLUGIN_CLAUDE_CODE_BIN: claude.path } },
      );
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        plan: report.plan,
        outcomes: report.outcomes,
        summary: report.summary,
        stateAfter: result.state.after,
        nativeInvocations: result.nativeInvocations['claude'],
        remainingNativeSteps: claude.remainingSteps(),
      }).toEqual({
        exitCode: 2,
        stderr: '',
        plan: [],
        outcomes: [],
        summary: {
          result: 'usage-error',
          terminalPhase: 'parse',
          mutationStarted: false,
          changed: false,
          failureCategory: 'usage',
          reason: {
            category: 'usage',
            code: 'usage.invalid-selection',
            diagnostic: "requested target 'claude-code' is not present on this machine",
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        stateAfter: undefined,
        nativeInvocations: [{ args: ['--version'] }],
        remainingNativeSteps: 0,
      });
    });
  });

  test('freezes Cursor marketplace identity exactly as its native readback and final ledger record', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('cursor-marketplace-source', {
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'personal',
          plugins: [{ name: 'demo', source: './plugins/demo' }],
        }),
        'plugins/demo/plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });

      const result = harness.run(['add', source, '--target', 'cursor', '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));
      const state = JSON.parse(bytesToText(result.state.after!)) as StateDocument;
      const repeated = harness.run(['add', source, '--target', 'cursor', '--json']);
      const repeatedReport = parseLifecycleReport(JSON.parse(repeated.stdout));
      const repeatedState = JSON.parse(bytesToText(repeated.state.after!)) as StateDocument;

      expect({
        exitCode: result.exitCode,
        planned: report.plan.map(({ nativeId }) => nativeId),
        reported: report.outcomes.map(({ nativeId }) => nativeId),
        recorded: state.installs.map(({ id }) => id),
        repeatedExitCode: repeated.exitCode,
        repeatedPlanned: repeatedReport.plan.map(({ nativeId }) => nativeId),
        repeatedReported: repeatedReport.outcomes.map(({ nativeId }) => nativeId),
        repeatedRecorded: repeatedState.installs.map(({ id }) => id),
      }).toEqual({
        exitCode: 0,
        planned: ['demo'],
        reported: ['demo'],
        recorded: ['demo'],
        repeatedExitCode: 0,
        repeatedPlanned: ['demo'],
        repeatedReported: ['demo'],
        repeatedRecorded: ['demo'],
      });
    });
  });

  test('updates a historical Cursor marketplace identity with one canonical plan, outcome, and ledger row', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('cursor-legacy-marketplace-update-source', {
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'personal',
          plugins: [{ name: 'demo', source: './plugins/demo' }],
        }),
        'plugins/demo/plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const initial = harness.run(['add', source, '--target', 'cursor', '--json']);
      expect(initial.exitCode).toBe(0);
      const historical = JSON.parse(bytesToText(initial.state.after!)) as StateDocument;
      historical.installs[0] = { ...historical.installs[0]!, id: 'demo@personal' };
      harness.writeHome({
        'state.json': JSON.stringify(historical),
        '.cursor/plugins/local/demo/.plgnz-install.json': JSON.stringify({
          source,
          pluginId: 'demo',
          fingerprint: '',
        }),
      });

      const updated = harness.run(['update', 'demo', '--target', 'cursor', '--json']);
      const report = parseLifecycleReport(JSON.parse(updated.stdout));
      const state = JSON.parse(bytesToText(updated.state.after!)) as StateDocument;

      expect({
        exitCode: updated.exitCode,
        planned: report.plan.map(({ nativeId }) => nativeId),
        outcomes: report.outcomes.map(({ nativeId, result }) => ({ nativeId, result })),
        summary: {
          result: report.summary.result,
          mutationStarted: report.summary.mutationStarted,
          reason: report.summary.reason,
        },
        records: state.installs.map(({ host, id, pending }) => ({ host, id, pending })),
      }).toEqual({
        exitCode: 0,
        planned: ['demo'],
        outcomes: [{ nativeId: 'demo', result: 'succeeded' }],
        summary: { result: 'converged', mutationStarted: true, reason: null },
        records: [{ host: 'cursor', id: 'demo', pending: undefined }],
      });
    });
  });

  test('migrates one legacy root identity and rejects canonical plus legacy rows before writes', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.codex/.keep': '' });
      const source = harness.source('codex-legacy-root-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const initial = harness.run(['add', source, '--target', 'codex', '--json']);
      expect(initial.exitCode).toBe(0);
      const historical = JSON.parse(bytesToText(initial.state.after!)) as StateDocument;
      historical.installs[0] = { ...historical.installs[0]!, id: 'demo', pending: 'install' };
      harness.writeHome({ 'state.json': JSON.stringify(historical) });

      const migrated = harness.run(['add', source, '--target', 'codex', '--json']);
      const migratedReport = parseLifecycleReport(JSON.parse(migrated.stdout));
      const migratedState = JSON.parse(bytesToText(migrated.state.after!)) as StateDocument;
      expect({
        exitCode: migrated.exitCode,
        planned: migratedReport.plan.map(({ nativeId }) => nativeId),
        outcomes: migratedReport.outcomes.map(({ nativeId, result }) => ({ nativeId, result })),
        records: migratedState.installs.map(({ host, id, pending }) => ({ host, id, pending })),
      }).toEqual({
        exitCode: 0,
        planned: ['demo@local'],
        outcomes: [{ nativeId: 'demo@local', result: 'succeeded' }],
        records: [{ host: 'codex', id: 'demo@local', pending: undefined }],
      });

      const ambiguous: StateDocument = {
        ...migratedState,
        installs: [
          ...migratedState.installs,
          { ...migratedState.installs[0]!, id: 'demo', pending: 'install' },
        ],
      };
      harness.writeHome({ 'state.json': JSON.stringify(ambiguous) });
      const beforeAmbiguous = JSON.stringify(ambiguous);
      const rejected = harness.run(['add', source, '--target', 'codex', '--json']);
      const rejectedReport = parseLifecycleReport(JSON.parse(rejected.stdout));
      expect({
        exitCode: rejected.exitCode,
        plan: rejectedReport.plan,
        outcomes: rejectedReport.outcomes,
        terminalPhase: rejectedReport.summary.terminalPhase,
        mutationStarted: rejectedReport.summary.mutationStarted,
        reason: rejectedReport.summary.reason,
        stateUnchanged: bytesToText(rejected.state.after!) === beforeAmbiguous,
      }).toEqual({
        exitCode: 1,
        plan: [],
        outcomes: [],
        terminalPhase: 'preflight',
        mutationStarted: false,
        reason: {
          category: 'internal',
          code: 'internal.ambiguous-ownership',
          diagnostic: "multiple codex ledger records match native identity 'demo@local'",
          capabilityId: null,
          evidenceId: null,
        },
        stateUnchanged: true,
      });

      const previewRejected = harness.run(['add', source, '--target', 'codex', '--dry-run', '--json']);
      const previewReport = parseLifecycleReport(JSON.parse(previewRejected.stdout));
      expect({
        exitCode: previewRejected.exitCode,
        plan: previewReport.plan,
        outcomes: previewReport.outcomes,
        terminalPhase: previewReport.summary.terminalPhase,
        mutationStarted: previewReport.summary.mutationStarted,
        reasonCode: previewReport.summary.reason?.code,
        stateUnchanged: bytesToText(previewRejected.state.after!) === beforeAmbiguous,
      }).toEqual({
        exitCode: 1,
        plan: [],
        outcomes: [],
        terminalPhase: 'preflight',
        mutationStarted: false,
        reasonCode: 'internal.ambiguous-ownership',
        stateUnchanged: true,
      });
    });
  });

  test('updates a legacy root identity into one canonical plan, outcome, and ledger row', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.codex/.keep': '' });
      const source = harness.source('codex-legacy-update-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const initial = harness.run(['add', source, '--target', 'codex', '--json']);
      expect(initial.exitCode).toBe(0);
      const historical = JSON.parse(bytesToText(initial.state.after!)) as StateDocument;
      historical.installs[0] = { ...historical.installs[0]!, id: 'demo' };
      const historicalBytes = JSON.stringify(historical);
      harness.writeHome({ 'state.json': historicalBytes });

      const preview = harness.run(['update', 'demo', '--target', 'codex', '--dry-run', '--json']);
      const previewReport = parseLifecycleReport(JSON.parse(preview.stdout));
      expect({
        exitCode: preview.exitCode,
        planned: previewReport.plan.map(({ nativeId }) => nativeId),
        reported: previewReport.outcomes.map(({ nativeId }) => nativeId),
        stateUnchanged: bytesToText(preview.state.after!) === historicalBytes,
      }).toEqual({
        exitCode: 0,
        planned: ['demo@local'],
        reported: ['demo@local'],
        stateUnchanged: true,
      });

      const updated = harness.run(['update', 'demo', '--target', 'codex', '--json']);
      const report = parseLifecycleReport(JSON.parse(updated.stdout));
      const state = JSON.parse(bytesToText(updated.state.after!)) as StateDocument;
      expect({
        exitCode: updated.exitCode,
        planned: report.plan.map(({ nativeId }) => nativeId),
        outcomes: report.outcomes.map(({ nativeId, result }) => ({ nativeId, result })),
        records: state.installs.map(({ host, id, pending }) => ({ host, id, pending })),
      }).toEqual({
        exitCode: 0,
        planned: ['demo@local'],
        outcomes: [{ nativeId: 'demo@local', result: 'succeeded' }],
        records: [{ host: 'codex', id: 'demo@local', pending: undefined }],
      });

      const ambiguous: StateDocument = {
        ...state,
        installs: [...state.installs, { ...state.installs[0]!, id: 'demo' }],
      };
      harness.writeHome({ 'state.json': JSON.stringify(ambiguous) });
      const beforeAmbiguous = JSON.stringify(ambiguous);
      const rejected = harness.run(['update', 'demo', '--target', 'codex', '--json']);
      const rejectedReport = parseLifecycleReport(JSON.parse(rejected.stdout));
      expect({
        exitCode: rejected.exitCode,
        plan: rejectedReport.plan,
        outcomes: rejectedReport.outcomes,
        terminalPhase: rejectedReport.summary.terminalPhase,
        mutationStarted: rejectedReport.summary.mutationStarted,
        reasonCode: rejectedReport.summary.reason?.code,
        diagnostic: rejectedReport.summary.reason?.diagnostic,
        stateUnchanged: bytesToText(rejected.state.after!) === beforeAmbiguous,
      }).toEqual({
        exitCode: 1,
        plan: [],
        outcomes: [],
        terminalPhase: 'preflight',
        mutationStarted: false,
        reasonCode: 'internal.ambiguous-ownership',
        diagnostic: "multiple codex ledger records match native identity 'demo@local'",
        stateUnchanged: true,
      });
    });
  });

  test('rejects canonical plus legacy update rows even when selected by the canonical identity', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.codex/.keep': '' });
      const source = harness.source('codex-canonical-selector-ambiguity-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const initial = harness.run(['add', source, '--target', 'codex', '--json']);
      expect(initial.exitCode).toBe(0);
      const canonical = JSON.parse(bytesToText(initial.state.after!)) as StateDocument;
      const ambiguous: StateDocument = {
        ...canonical,
        installs: [...canonical.installs, { ...canonical.installs[0]!, id: 'demo' }],
      };
      const ambiguousBytes = JSON.stringify(ambiguous);
      harness.writeHome({ 'state.json': ambiguousBytes });

      const rejected = harness.run(['update', 'demo@local', '--target', 'codex', '--dry-run', '--json']);
      const report = parseLifecycleReport(JSON.parse(rejected.stdout));

      expect({
        exitCode: rejected.exitCode,
        plan: report.plan,
        outcomes: report.outcomes,
        phase: report.summary.terminalPhase,
        mutationStarted: report.summary.mutationStarted,
        reasonCode: report.summary.reason?.code,
        stateUnchanged: bytesToText(rejected.state.after!) === ambiguousBytes,
        storeUnchanged: rejected.stores.codex.after,
        storeBefore: rejected.stores.codex.before,
      }).toEqual({
        exitCode: 1,
        plan: [],
        outcomes: [],
        phase: 'preflight',
        mutationStarted: false,
        reasonCode: 'internal.ambiguous-ownership',
        stateUnchanged: true,
        storeUnchanged: rejected.stores.codex.before,
        storeBefore: rejected.stores.codex.before,
      });
    });
  });

  test('removes a legacy root identity through its canonical native representation', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.codex/.keep': '' });
      const source = harness.source('codex-legacy-remove-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const initial = harness.run(['add', source, '--target', 'codex', '--json']);
      expect(initial.exitCode).toBe(0);
      const canonical = JSON.parse(bytesToText(initial.state.after!)) as StateDocument;
      const legacy = { ...canonical.installs[0]!, id: 'demo' };
      const ambiguous: StateDocument = { ...canonical, installs: [...canonical.installs, legacy] };
      harness.writeHome({ 'state.json': JSON.stringify(ambiguous) });

      const rejected = harness.run(['remove', 'demo', '--target', 'codex', '--json']);
      const rejectedReport = parseLifecycleReport(JSON.parse(rejected.stdout));
      expect({
        exitCode: rejected.exitCode,
        plan: rejectedReport.plan,
        outcomes: rejectedReport.outcomes,
        phase: rejectedReport.summary.terminalPhase,
        mutationStarted: rejectedReport.summary.mutationStarted,
        reasonCode: rejectedReport.summary.reason?.code,
        stateUnchanged: bytesToText(rejected.state.after!) === JSON.stringify(ambiguous),
        storeUnchanged: JSON.stringify(rejected.stores.codex.before) === JSON.stringify(rejected.stores.codex.after),
      }).toEqual({
        exitCode: 1,
        plan: [],
        outcomes: [],
        phase: 'preflight',
        mutationStarted: false,
        reasonCode: 'internal.ambiguous-ownership',
        stateUnchanged: true,
        storeUnchanged: true,
      });

      harness.writeHome({ 'state.json': JSON.stringify({ ...canonical, installs: [legacy] }) });
      const removed = harness.run(['remove', 'demo', '--target', 'codex', '--json']);
      const removedReport = parseLifecycleReport(JSON.parse(removed.stdout));
      const finalState = JSON.parse(bytesToText(removed.state.after!)) as StateDocument;
      expect({
        exitCode: removed.exitCode,
        planned: removedReport.plan.map(({ nativeId }) => nativeId),
        outcomes: removedReport.outcomes.map(({ nativeId, result }) => ({ nativeId, result })),
        records: finalState.installs,
        nativeManifestPresent: removed.stores.codex.after.files['plugins/cache/local/demo/local/plugin.json'] !== undefined,
      }).toEqual({
        exitCode: 0,
        planned: ['demo@local'],
        outcomes: [{ nativeId: 'demo@local', result: 'succeeded' }],
        records: [],
        nativeManifestPresent: false,
      });
    });
  });

  test('accepts a canonical remove selector for one legacy ledger identity', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.codex/.keep': '' });
      const source = harness.source('codex-canonical-remove-selector-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const initial = harness.run(['add', source, '--target', 'codex', '--json']);
      expect(initial.exitCode).toBe(0);
      const canonical = JSON.parse(bytesToText(initial.state.after!)) as StateDocument;
      const historical: StateDocument = {
        ...canonical,
        installs: [{ ...canonical.installs[0]!, id: 'demo' }],
      };
      const historicalBytes = JSON.stringify(historical);
      harness.writeHome({ 'state.json': historicalBytes });

      const preview = harness.run(['remove', 'demo@local', '--target', 'codex', '--dry-run', '--json']);
      const previewReport = parseLifecycleReport(JSON.parse(preview.stdout));
      expect({
        exitCode: preview.exitCode,
        planned: previewReport.plan.map(({ nativeId }) => nativeId),
        outcomes: previewReport.outcomes.map(({ nativeId, result }) => ({ nativeId, result })),
        stateUnchanged: bytesToText(preview.state.after!) === historicalBytes,
        storeUnchanged: preview.stores.codex.after,
        storeBefore: preview.stores.codex.before,
      }).toEqual({
        exitCode: 0,
        planned: ['demo@local'],
        outcomes: [{ nativeId: 'demo@local', result: 'succeeded' }],
        stateUnchanged: true,
        storeUnchanged: preview.stores.codex.before,
        storeBefore: preview.stores.codex.before,
      });

      const removed = harness.run(['remove', 'demo@local', '--target', 'codex', '--json']);
      const removedReport = parseLifecycleReport(JSON.parse(removed.stdout));
      const finalState = JSON.parse(bytesToText(removed.state.after!)) as StateDocument;
      expect({
        exitCode: removed.exitCode,
        planned: removedReport.plan.map(({ nativeId }) => nativeId),
        outcomes: removedReport.outcomes.map(({ nativeId, result }) => ({ nativeId, result })),
        records: finalState.installs,
        nativeManifestPresent: removed.stores.codex.after.files['plugins/cache/local/demo/local/plugin.json'] !== undefined,
      }).toEqual({
        exitCode: 0,
        planned: ['demo@local'],
        outcomes: [{ nativeId: 'demo@local', result: 'succeeded' }],
        records: [],
        nativeManifestPresent: false,
      });
    });
  });

  test('hard-refuses a legacy remove when its Source is gone and canonical native identity cannot be proven', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.codex/.keep': '' });
      const source = harness.source('codex-gone-legacy-remove-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const initial = harness.run(['add', source, '--target', 'codex', '--json']);
      expect(initial.exitCode).toBe(0);
      const canonical = JSON.parse(bytesToText(initial.state.after!)) as StateDocument;
      const historical: StateDocument = {
        ...canonical,
        installs: [{ ...canonical.installs[0]!, id: 'demo' }],
      };
      const historicalBytes = JSON.stringify(historical);
      harness.writeHome({ 'state.json': historicalBytes });
      rmSync(source, { recursive: true, force: true });

      const rejected = harness.run(['remove', 'demo', '--target', 'codex', '--json']);
      const report = parseLifecycleReport(JSON.parse(rejected.stdout));

      expect({
        exitCode: rejected.exitCode,
        plan: report.plan,
        outcomes: report.outcomes,
        phase: report.summary.terminalPhase,
        mutationStarted: report.summary.mutationStarted,
        reasonCode: report.summary.reason?.code,
        stateUnchanged: bytesToText(rejected.state.after!) === historicalBytes,
        storeUnchanged: rejected.stores.codex.after,
        storeBefore: rejected.stores.codex.before,
      }).toEqual({
        exitCode: 1,
        plan: [],
        outcomes: [],
        phase: 'preflight',
        mutationStarted: false,
        reasonCode: 'internal.ambiguous-ownership',
        stateUnchanged: true,
        storeUnchanged: rejected.stores.codex.before,
        storeBefore: rejected.stores.codex.before,
      });
    });
  });

  test('rejects source-gone canonical plus legacy remove rows before a dry-run can pick one', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.codex/.keep': '' });
      const source = harness.source('codex-gone-remove-ambiguity-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const initial = harness.run(['add', source, '--target', 'codex', '--json']);
      expect(initial.exitCode).toBe(0);
      const canonical = JSON.parse(bytesToText(initial.state.after!)) as StateDocument;
      const ambiguous: StateDocument = {
        ...canonical,
        installs: [...canonical.installs, { ...canonical.installs[0]!, id: 'demo' }],
      };
      const ambiguousBytes = JSON.stringify(ambiguous);
      harness.writeHome({ 'state.json': ambiguousBytes });
      rmSync(source, { recursive: true, force: true });

      const rejected = harness.run(['remove', 'demo@local', '--target', 'codex', '--dry-run', '--json']);
      const report = parseLifecycleReport(JSON.parse(rejected.stdout));

      expect({
        exitCode: rejected.exitCode,
        plan: report.plan,
        outcomes: report.outcomes,
        phase: report.summary.terminalPhase,
        mutationStarted: report.summary.mutationStarted,
        reasonCode: report.summary.reason?.code,
        stateUnchanged: bytesToText(rejected.state.after!) === ambiguousBytes,
        storeUnchanged: rejected.stores.codex.after,
        storeBefore: rejected.stores.codex.before,
      }).toEqual({
        exitCode: 1,
        plan: [],
        outcomes: [],
        phase: 'preflight',
        mutationStarted: false,
        reasonCode: 'internal.ambiguous-ownership',
        stateUnchanged: true,
        storeUnchanged: rejected.stores.codex.before,
        storeBefore: rejected.stores.codex.before,
      });
    });
  });

  test('does not let an unresolved local alias block a proven distinct marketplace remove', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.codex/.keep': '' });
      const rootSource = harness.source('codex-gone-local-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const marketplaceSource = harness.source('codex-live-marketplace-source', {
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'personal',
          plugins: [{ name: 'demo', source: './plugins/demo' }],
        }),
        'plugins/demo/plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const rootInstall = harness.run(['add', rootSource, '--target', 'codex', '--json']);
      expect(rootInstall.exitCode).toBe(0);
      const marketplaceInstall = harness.run(['add', marketplaceSource, '--target', 'codex', '--json']);
      expect(marketplaceInstall.exitCode).toBe(0);
      const canonical = JSON.parse(bytesToText(marketplaceInstall.state.after!)) as StateDocument;
      const historical: StateDocument = {
        ...canonical,
        installs: canonical.installs.map((record) => record.id === 'demo@local'
          ? { ...record, id: 'demo' }
          : record),
      };
      const historicalBytes = JSON.stringify(historical);
      harness.writeHome({ 'state.json': historicalBytes });
      rmSync(rootSource, { recursive: true, force: true });

      const preview = harness.run(['remove', 'demo@personal', '--target', 'codex', '--dry-run', '--json']);
      const report = parseLifecycleReport(JSON.parse(preview.stdout));

      expect({
        exitCode: preview.exitCode,
        planned: report.plan.map(({ nativeId }) => nativeId),
        outcomes: report.outcomes.map(({ nativeId, result }) => ({ nativeId, result })),
        summary: {
          result: report.summary.result,
          mutationStarted: report.summary.mutationStarted,
          reason: report.summary.reason,
        },
        stateUnchanged: bytesToText(preview.state.after!) === historicalBytes,
        storeUnchanged: preview.stores.codex.after,
        storeBefore: preview.stores.codex.before,
      }).toEqual({
        exitCode: 0,
        planned: ['demo@personal'],
        outcomes: [{ nativeId: 'demo@personal', result: 'succeeded' }],
        summary: { result: 'converged', mutationStarted: false, reason: null },
        stateUnchanged: true,
        storeUnchanged: preview.stores.codex.before,
        storeBefore: preview.stores.codex.before,
      });
    });
  });

  test('freezes a dry-run add pair before adapter validation fails without writing', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.codex/.keep': '' });
      const source = harness.source('codex-invalid-dry-run-source', {
        'plugin.json': '{"name":"demo","version":"unsafe/version"}\n',
      });

      const result = harness.run(['add', source, '--target', 'codex', '--dry-run', '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect(result.exitCode).toBe(1);
      expect(report.plan).toHaveLength(1);
      expect(report.outcomes).toHaveLength(1);
      expect({
        plan: report.plan.map(({ nativeId, action, route }) => ({ nativeId, action, route })),
        outcome: report.outcomes.map(({ operationId, nativeId, action, route, result, changed, reason }) => ({
          operationId,
          nativeId,
          action,
          route,
          result,
          changed,
          diagnostic: reason?.diagnostic,
        })),
        expectedOperationId: report.plan[0]!.operationId,
        mutationStarted: report.summary.mutationStarted,
        stateAfter: result.state.after,
        storeUnchanged: result.stores.codex.after,
        storeBefore: result.stores.codex.before,
      }).toEqual({
        plan: [{ nativeId: 'demo@local', action: 'install', route: 'managed' }],
        outcome: [{
          operationId: report.plan[0]!.operationId,
          nativeId: 'demo@local',
          action: 'install',
          route: 'managed',
          result: 'failed',
          changed: false,
          diagnostic: report.outcomes[0]!.reason?.diagnostic,
        }],
        expectedOperationId: report.plan[0]!.operationId,
        mutationStarted: false,
        stateAfter: undefined,
        storeUnchanged: result.stores.codex.before,
        storeBefore: result.stores.codex.before,
      });
      expect(report.outcomes[0]!.reason?.diagnostic).toContain('unsafe Codex plugin version');
    });
  });

  test('classifies the absence of any writer as a runtime preflight failure', async () => {
    await withLifecycleCliHarness((harness) => {
      const source = harness.source('no-writer-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });

      const result = harness.run(['add', source, '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        sourceBinding: report.command.sourceSnapshots[0]?.reference.binding,
        plan: report.plan,
        outcomes: report.outcomes,
        summary: report.summary,
        state: result.state,
      }).toEqual({
        exitCode: 1,
        stderr: '',
        sourceBinding: { kind: 'local', locator: source },
        plan: [],
        outcomes: [],
        summary: {
          result: 'incomplete',
          terminalPhase: 'preflight',
          mutationStarted: false,
          changed: false,
          failureCategory: 'runtime',
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: 'No detected writer targets',
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        state: {},
      });
    });
  });

  test('an add that cannot persist intent fails without mutating its frozen managed route', async () => {
    await withLifecycleCliHarness(async (harness) => {
      harness.writeHome({
        '.cursor/.keep': '',
        'cache/.keep': '',
      });
      const source = harness.source('add-intent-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });

      chmodSync(harness.home, 0o555);
      let result;
      try {
        result = harness.run(['add', source, '--target', 'cursor', '--json']);
      } finally {
        chmodSync(harness.home, 0o755);
      }
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        outcome: report.outcomes.map((candidate) => ({
          action: candidate.action,
          result: candidate.result,
          route: candidate.route,
          resourceState: candidate.resourceState,
          activationState: candidate.activationState,
          changed: candidate.changed,
          reason: candidate.reason,
        })),
        summary: report.summary,
        state: result.state,
        cursorUnchanged: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.after,
      }).toEqual({
        exitCode: 1,
        stderr: '',
        outcome: [{
          action: 'install',
          result: 'failed',
          route: 'managed',
          resourceState: 'unknown',
          activationState: 'unknown',
          changed: false,
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: report.outcomes[0]!.reason?.diagnostic,
            capabilityId: null,
            evidenceId: null,
          },
        }],
        summary: {
          result: 'incomplete',
          terminalPhase: 'apply',
          mutationStarted: false,
          changed: false,
          failureCategory: 'runtime',
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: report.summary.reason?.diagnostic,
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        state: {},
        cursorUnchanged: { directories: [], files: { '.keep': [] }, symlinks: {} },
        cursorAfter: { directories: [], files: { '.keep': [] }, symlinks: {} },
      });
      expect(report.summary.reason?.diagnostic).toContain('EACCES');
    });
  });

  test('a repeated add dry-run reports unchanged without writing', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('unchanged-add-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const added = harness.run(['add', source, '--target', 'cursor', '--json']);
      expect(added.exitCode).toBe(0);

      const result = harness.run(['add', source, '--target', 'cursor', '--dry-run', '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));
      expect({
        exitCode: result.exitCode,
        action: report.outcomes[0]?.action,
        result: report.outcomes[0]?.result,
        changed: report.outcomes[0]?.changed,
        mutationStarted: report.summary.mutationStarted,
        stateUnchanged: bytesToText(result.state.before!) === bytesToText(result.state.after!),
        cursorUnchanged: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.after,
      }).toEqual({
        exitCode: 0,
        action: 'unchanged',
        result: 'succeeded',
        changed: false,
        mutationStarted: false,
        stateUnchanged: true,
        cursorUnchanged: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.before,
      });
    });
  });

  test('reports a non-finalized update as failed instead of converged unchanged', async () => {
    await withLifecycleCliHarness(async (harness) => {
      const source = harness.source('update-warning-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const state = JSON.stringify({
        version: 1,
        installs: [{
          host: 'claude-code',
          id: 'demo@local',
          source,
          sourceSha: '1111111111111111111111111111111111111111',
        }],
      });
      harness.writeHome({ 'state.json': state });
      const claude = harness.fakeNative('claude', [
        { args: ['--version'], stdout: '2.1.275 (Claude Code)\n' },
        { args: ['--version'], stdout: '2.1.275 (Claude Code)\n' },
        { args: ['--version'], stderr: 'host disappeared\n', exitCode: 41 },
      ]);

      const result = harness.run(
        ['update', 'demo', '--target', 'claude-code', '--json'],
        { env: { OPEN_PLUGIN_CLAUDE_CODE_BIN: claude.path } },
      );
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        outcome: report.outcomes.map((candidate) => ({
          action: candidate.action,
          result: candidate.result,
          route: candidate.route,
          resourceState: candidate.resourceState,
          activationState: candidate.activationState,
          changed: candidate.changed,
          reason: candidate.reason,
        })),
        summary: report.summary,
        stateUnchanged: bytesToText(result.state.before!) === bytesToText(result.state.after!),
        nativeInvocations: result.nativeInvocations['claude'],
      }).toEqual({
        exitCode: 1,
        stderr: '',
        outcome: [{
          action: 'update',
            result: 'failed',
          route: 'managed',
          resourceState: 'unknown',
          activationState: 'unknown',
          changed: false,
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: "host not present on this machine — 'demo@local' skipped",
            capabilityId: null,
            evidenceId: null,
          },
        }],
        summary: {
          result: 'incomplete',
          terminalPhase: 'preflight',
          mutationStarted: false,
          changed: false,
          failureCategory: 'runtime',
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: "host not present on this machine — 'demo@local' skipped",
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        stateUnchanged: true,
        nativeInvocations: [
          { args: ['--version'] },
          { args: ['--version'] },
          { args: ['--version'] },
        ],
      });
    });
  });

  test('an update that cannot persist intent fails without mutating its frozen managed route', async () => {
    await withLifecycleCliHarness(async (harness) => {
      const source = harness.source('update-intent-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      harness.writeHome({
        '.cursor/.keep': '',
        'cache/.keep': '',
        'state.json': JSON.stringify({
          version: 1,
          installs: [{
            host: 'cursor',
            id: 'demo',
            source,
            sourceSha: '1111111111111111111111111111111111111111',
          }],
        }),
      });

      chmodSync(harness.home, 0o555);
      let result;
      try {
        result = harness.run(['update', 'demo', '--target', 'cursor', '--json']);
      } finally {
        chmodSync(harness.home, 0o755);
      }
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        outcome: report.outcomes.map((candidate) => ({
          action: candidate.action,
          result: candidate.result,
          route: candidate.route,
          resourceState: candidate.resourceState,
          activationState: candidate.activationState,
          changed: candidate.changed,
          reason: candidate.reason,
        })),
        summary: report.summary,
        stateUnchanged: bytesToText(result.state.before!) === bytesToText(result.state.after!),
        cursorUnchanged: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.after,
      }).toEqual({
        exitCode: 1,
        stderr: '',
        outcome: [{
          action: 'update',
          result: 'failed',
          route: 'managed',
          resourceState: 'unknown',
          activationState: 'unknown',
          changed: false,
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: report.outcomes[0]!.reason?.diagnostic,
            capabilityId: null,
            evidenceId: null,
          },
        }],
        summary: {
          result: 'incomplete',
          terminalPhase: 'apply',
          mutationStarted: false,
          changed: false,
          failureCategory: 'runtime',
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: report.summary.reason?.diagnostic,
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        stateUnchanged: true,
        cursorUnchanged: { directories: [], files: { '.keep': [] }, symlinks: {} },
        cursorAfter: { directories: [], files: { '.keep': [] }, symlinks: {} },
      });
      expect(report.summary.reason?.diagnostic).toContain('EACCES');
    });
  });

  test('an idempotent update reports unchanged after native readback', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('unchanged-update-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const added = harness.run(['add', source, '--target', 'cursor', '--json']);
      expect(added.exitCode).toBe(0);

      const result = harness.run(['update', 'demo', '--target', 'cursor', '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        outcome: report.outcomes.map((candidate) => ({
          action: candidate.action,
          result: candidate.result,
          route: candidate.route,
          resourceState: candidate.resourceState,
          activationState: candidate.activationState,
          changed: candidate.changed,
          reason: candidate.reason,
        })),
        summary: report.summary,
        cursorUnchanged: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.after,
      }).toEqual({
        exitCode: 0,
        stderr: '',
        outcome: [{
          action: 'update',
          result: 'succeeded',
          route: 'managed',
          resourceState: 'present',
          activationState: 'active-conforming',
          changed: false,
          reason: null,
        }],
        summary: {
          result: 'converged',
          terminalPhase: 'complete',
          mutationStarted: true,
          changed: false,
          failureCategory: null,
          reason: null,
          recoveryId: null,
          readbackId: null,
        },
        cursorUnchanged: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.before,
      });
    });
  });

  test('an update without an owned record is an ownership refusal, not a defect', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });

      const result = harness.run(['update', 'demo', '--target', 'cursor', '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        plan: report.plan,
        outcomes: report.outcomes,
        summary: report.summary,
        state: result.state,
      }).toEqual({
        exitCode: 1,
        stderr: '',
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
            diagnostic: "no install record for 'demo' in state.json — not installed by plgnz; refusing to modify it",
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        state: {},
      });
    });
  });

  test('persists a credential-free remote binding after installing the resolved revision', async () => {
    await withLifecycleCliHarness(async (harness) => {
      const checkout = join(harness.root, 'remote-checkout');
      const remote = join(harness.root, 'remote.git');
      const revision = initGitRepo(checkout, {
        'plugin.json': '{"name":"fixture","version":"1.0.0"}\n',
        'resources/value.txt': 'remote snapshot\n',
      });
      expect(spawnSync('git', ['clone', '--quiet', '--bare', checkout, remote], { encoding: 'utf8' }).status).toBe(0);
      const bin = join(harness.root, 'remote-bin');
      mkdirSync(bin, { recursive: true });
      const git = join(bin, 'git');
      writeFileSync(git, `#!/bin/bash
set -euo pipefail
real_git=/usr/bin/git
remote=${JSON.stringify(remote)}
requested='https://user:super-secret@example.test/repo.git'
args=("$@")
for i in "\${!args[@]}"; do
  if [[ "\${args[$i]}" == "$requested" ]]; then args[$i]="$remote"; fi
done
exec "$real_git" "\${args[@]}"
`);
      chmodSync(git, 0o755);
      harness.writeHome({ '.cursor/.keep': '' });

      const result = harness.run(
        ['add', 'https://user:super-secret@example.test/repo.git#main', '--target', 'cursor', '--json'],
        { env: { OPEN_PLUGIN_GIT_BIN: git } },
      );
      const stateText = bytesToText(result.state.after!);
      const state = JSON.parse(stateText) as { installs: Array<{ source: string; sourceSha: string; sourceDir: string }> };

      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        sourceSnapshots: report.command.sourceSnapshots,
        outcomes: report.outcomes.map((outcome) => ({
          package: outcome.package,
          target: outcome.scope.target,
          source: outcome.scope.source,
          result: outcome.result,
          action: outcome.action,
          nativeId: outcome.nativeId,
        })),
        source: state.installs[0]?.source,
        sourceSha: state.installs[0]?.sourceSha,
        sourceIsFrozen: state.installs[0]?.sourceDir.startsWith(join(harness.home, 'cache', 'source-snapshots')),
        installedBytes: bytesToText(result.stores.cursor.after.files['plugins/local/fixture/resources/value.txt']!),
        durableOutputLeaksCredential: `${result.stdout}\n${result.stderr}\n${stateText}`.includes('super-secret'),
      }).toEqual({
        exitCode: 0,
        stderr: '',
        sourceSnapshots: [{
          id: 'source-0',
          reference: {
            binding: { kind: 'git', locator: 'https://example.test/repo.git', ref: 'main' },
            revision,
            fingerprint: report.command.sourceSnapshots[0]!.reference.fingerprint,
          },
        }],
        outcomes: [{
          package: 'fixture',
          target: { kind: 'cursor', instance: 'default' },
          source: { kind: 'git', locator: 'https://example.test/repo.git', ref: 'main' },
          result: 'succeeded',
          action: 'install',
          nativeId: 'fixture',
        }],
        source: 'https://example.test/repo.git#main',
        sourceSha: revision,
        sourceIsFrozen: true,
        installedBytes: 'remote snapshot\n',
        durableOutputLeaksCredential: false,
      });
    });
  });

  test('an unreachable credentialed remote leaves state and host stores untouched', async () => {
    await withLifecycleCliHarness(async (harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const git = harness.fakeNative('git', [{
        args: ['ls-remote', 'https://user:super-secret@example.test/missing.git', 'HEAD'],
        stderr: 'fatal: unavailable\n',
        exitCode: 17,
      }]);

      const result = harness.run(
        ['add', 'https://user:super-secret@example.test/missing.git', '--target', 'cursor', '--json'],
        { env: { OPEN_PLUGIN_GIT_BIN: git.path } },
      );
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stateUnwritten: result.state,
        cursorUnchanged: result.stores.cursor,
        plan: report.plan,
        outcomes: report.outcomes,
        summary: report.summary,
        outputLeaksCredential: `${result.stdout}\n${result.stderr}`.includes('super-secret'),
        gitInvocations: result.nativeInvocations.git,
      }).toEqual({
        exitCode: 1,
        stateUnwritten: {},
        cursorUnchanged: {
          before: result.stores.cursor.before,
          after: result.stores.cursor.before,
        },
        plan: [],
        outcomes: [],
        summary: {
          result: 'incomplete',
          terminalPhase: 'resolve',
          mutationStarted: false,
          changed: false,
          failureCategory: 'runtime',
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: 'Failed to resolve git remote: https://example.test/missing.git (fatal: unavailable)',
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        outputLeaksCredential: false,
        gitInvocations: [{ args: ['ls-remote', 'https://user:super-secret@example.test/missing.git', 'HEAD'] }],
      });
    });
  });

  test('a corrupt ledger blocks add before source freezing or pair planning', async () => {
    await withLifecycleCliHarness(async (harness) => {
      harness.writeHome({
        '.cursor/.keep': '',
        'state.json': '{ invalid lifecycle state',
      });
      const source = harness.source('corrupt-state-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });

      const result = harness.run(['add', source, '--target', 'cursor', '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        plan: report.plan,
        outcomes: report.outcomes,
        summary: report.summary,
        stateUnchanged: bytesToText(result.state.before!) === bytesToText(result.state.after!),
        cursorUnchanged: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.after,
      }).toEqual({
        exitCode: 1,
        stderr: '',
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
            code: 'internal.corrupt-state',
            diagnostic: report.summary.reason?.diagnostic,
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        stateUnchanged: true,
        cursorUnchanged: { directories: [], files: { '.keep': [] }, symlinks: {} },
        cursorAfter: { directories: [], files: { '.keep': [] }, symlinks: {} },
      });
      expect(report.summary.reason?.diagnostic).toContain('Invalid state.json');
    });
  });

  test('a remove that cannot persist intent fails without mutating its frozen managed route', async () => {
    await withLifecycleCliHarness(async (harness) => {
      const source = harness.source('remove-intent-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      harness.writeHome({
        '.cursor/.keep': '',
        'state.json': JSON.stringify({
          version: 1,
          installs: [{
            host: 'cursor',
            id: 'demo',
            source,
            sourceSha: '1111111111111111111111111111111111111111',
          }],
        }),
      });

      chmodSync(harness.home, 0o555);
      let result;
      try {
        result = harness.run(['remove', 'demo', '--target', 'cursor', '--json']);
      } finally {
        chmodSync(harness.home, 0o755);
      }
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        outcome: report.outcomes.map((candidate) => ({
          action: candidate.action,
          result: candidate.result,
          route: candidate.route,
          resourceState: candidate.resourceState,
          activationState: candidate.activationState,
          changed: candidate.changed,
          reason: candidate.reason,
        })),
        summary: report.summary,
        stateUnchanged: bytesToText(result.state.before!) === bytesToText(result.state.after!),
        cursorUnchanged: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.after,
      }).toEqual({
        exitCode: 1,
        stderr: '',
        outcome: [{
          action: 'retire-orphan',
          result: 'failed',
          route: 'managed',
          resourceState: 'unknown',
          activationState: 'unknown',
          changed: false,
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: report.outcomes[0]!.reason?.diagnostic,
            capabilityId: null,
            evidenceId: null,
          },
        }],
        summary: {
          result: 'incomplete',
          terminalPhase: 'apply',
          mutationStarted: false,
          changed: false,
          failureCategory: 'runtime',
          reason: {
            category: 'runtime',
            code: 'runtime.operation-failed',
            diagnostic: report.summary.reason?.diagnostic,
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        stateUnchanged: true,
        cursorUnchanged: { directories: [], files: { '.keep': [] }, symlinks: {} },
        cursorAfter: { directories: [], files: { '.keep': [] }, symlinks: {} },
      });
      expect(report.summary.reason?.diagnostic).toContain('EACCES');
    });
  });

  test('emits the legacy mutation array only when --legacy-json is explicit', async () => {
    await withLifecycleCliHarness(async (harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('legacy-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });

      const result = harness.run(['add', source, '--target', 'cursor', '--dry-run', '--legacy-json']);

      expect({
        exitCode: result.exitCode,
        progressOnStderr: /^\[cursor\] would activate directory: .+\n$/u.test(result.stderr),
        stdout: JSON.parse(result.stdout),
        storesUnchanged: result.stores.cursor.before,
        storesAfter: result.stores.cursor.after,
      }).toEqual({
        exitCode: 0,
        progressOnStderr: true,
        stdout: [{
          plugin: 'demo',
          target: 'cursor',
          status: 'installed',
          dryRun: true,
          nativeId: 'demo',
          action: 'install',
        }],
        storesUnchanged: { directories: [], files: { '.keep': [] }, symlinks: {} },
        storesAfter: { directories: [], files: { '.keep': [] }, symlinks: {} },
      });
    });
  });

  test('keeps progress on stderr while stdout contains only the lifecycle envelope', async () => {
    await withLifecycleCliHarness(async (harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('json-progress-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });

      const result = harness.run(['add', source, '--target', 'cursor', '--dry-run', '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        schemaVersion: report.schemaVersion,
        result: report.summary.result,
        progressOnStderr: /^\[cursor\] would activate directory: .+\n$/u.test(result.stderr),
      }).toEqual({
        exitCode: 0,
        schemaVersion: 1,
        result: 'converged',
        progressOnStderr: true,
      });
    });
  });

  test('rejects mixed lifecycle and legacy JSON modes with a schema-v1 usage report', async () => {
    await withLifecycleCliHarness((harness) => {
      const result = harness.run(['add', '/must-not-read', '--json', '--legacy-json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        plan: report.plan,
        outcomes: report.outcomes,
        summary: report.summary,
      }).toEqual({
        exitCode: 2,
        stderr: '',
        plan: [],
        outcomes: [],
        summary: {
          result: 'usage-error',
          terminalPhase: 'parse',
          mutationStarted: false,
          changed: false,
          failureCategory: 'usage',
          reason: {
            category: 'usage',
            code: 'usage.invalid-argument',
            diagnostic: '--json and --legacy-json are mutually exclusive',
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
      });
    });
  });

  test('removes the fixture root when the test callback throws', async () => {
    let fixtureRoot = '';
    let message = '';
    try {
      await withLifecycleCliHarness((harness) => {
        fixtureRoot = harness.root;
        harness.writeHome({ 'partial.txt': 'must be cleaned\n' });
        throw new Error('forced callback failure');
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect({ message, fixtureExists: existsSync(fixtureRoot) }).toEqual({
      message: 'forced callback failure',
      fixtureExists: false,
    });
  });
});
