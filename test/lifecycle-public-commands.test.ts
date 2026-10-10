import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { bytesToText, textToBytes, withLifecycleCliHarness } from './lifecycle-cli-harness';
import { parseLifecycleReport } from '../src/lifecycle-report';

describe('public lifecycle commands', () => {
  test('sync dry-run prints a validated report whose outcomes cite the frozen plan', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeAmbient({ 'sentinel.txt': 'outside the managed home\n' });
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('sync-source', {
        'plugin.json': '{"name":"demo","version":"1.0.0","description":"Harness fixture"}\n',
        'skills/demo/SKILL.md': '---\nname: demo\ndescription: Harness fixture\n---\n\nDemo body.\n',
      });
      const cursor = harness.fakeNative('cursor', [
        { args: ['--version'], stdout: '2.4.0\n' },
      ]);

      const result = harness.run(
        ['sync', source, '--target', 'cursor', '--dry-run', '--json'],
        { env: { OPEN_PLUGIN_CURSOR_BIN: cursor.path } },
      );
      const report = parseLifecycleReport(JSON.parse(result.stdout));
      const operationIds = report.plan.map((operation) => operation.operationId);

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        command: report.command.name,
        dryRun: report.command.dryRun,
        source: report.command.sourceSnapshots.map((snapshot) => snapshot.reference.binding),
        outcomeIds: report.outcomes.map((outcome) => outcome.operationId),
        operationIdShape: operationIds.every((operationId) => /^operation-v1-[0-9a-f]{64}$/u.test(operationId)),
        rows: report.outcomes.map((outcome) => ({
          package: outcome.package,
          nativeId: outcome.nativeId,
          target: outcome.scope.target,
          coverage: outcome.coverage,
          action: outcome.action,
          route: outcome.route,
          result: outcome.result,
          resourceState: outcome.resourceState,
          activationState: outcome.activationState,
          changed: outcome.changed,
        })),
        summary: report.summary,
        stateWritten: result.state.after !== undefined,
        cursorBefore: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.after,
        nativeInvocations: result.nativeInvocations['cursor'],
        ambientBefore: result.ambient.before,
        ambientAfter: result.ambient.after,
      }).toEqual({
        exitCode: 0,
        stderr: '',
        command: 'sync',
        dryRun: true,
        source: [{ kind: 'local', locator: source }],
        outcomeIds: operationIds,
        operationIdShape: true,
        rows: [{
          package: 'demo',
          nativeId: 'demo',
          target: { kind: 'cursor', instance: 'default' },
          coverage: 'desired-pair',
          action: 'install',
          route: 'managed',
          result: 'succeeded',
          resourceState: 'present',
          activationState: 'active-conforming',
          changed: false,
        }],
        summary: {
          result: 'converged',
          terminalPhase: 'complete',
          mutationStarted: false,
          changed: false,
          failureCategory: null,
          reason: null,
          recoveryId: null,
          readbackId: null,
        },
        stateWritten: false,
        cursorBefore: result.stores.cursor.before,
        cursorAfter: result.stores.cursor.before,
        nativeInvocations: [{ args: ['--version'] }],
        ambientBefore: {
          directories: [],
          files: { 'sentinel.txt': textToBytes('outside the managed home\n') },
          symlinks: {},
        },
        ambientAfter: {
          directories: [],
          files: { 'sentinel.txt': textToBytes('outside the managed home\n') },
          symlinks: {},
        },
      });
      expect(bytesToText(result.stores.cursor.before.files['.keep']!)).toBe('');
    });
  });

  test('scopes --json lists an empty ledger without writing', async () => {
    await withLifecycleCliHarness((harness) => {
      const result = harness.run(['scopes', '--json']);
      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        inventory: JSON.parse(result.stdout),
        stateWritten: result.state.after !== undefined,
      }).toEqual({
        exitCode: 0,
        stderr: '',
        inventory: { stateGeneration: 0, scopes: [] },
        stateWritten: false,
      });
    });
  });

  test('scopes reports an unknown scope id without writing', async () => {
    await withLifecycleCliHarness((harness) => {
      const missing = `scope-v1-${'a'.repeat(64)}`;
      const result = harness.run(['scopes', missing, '--json']);
      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        stateWritten: result.state.after !== undefined,
      }).toEqual({
        exitCode: 2,
        stderr: `unknown deployment scope '${missing}'\n`,
        stdout: '',
        stateWritten: false,
      });
    });
  });

  test('retire-source of an unrecorded source is a usage report and writes nothing', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('missing-scope', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
      });
      const result = harness.run(['retire-source', source, '--target', 'cursor', '--dry-run', '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));
      expect({
        exitCode: result.exitCode,
        command: report.command.name,
        dryRun: report.command.dryRun,
        plan: report.plan,
        outcomes: report.outcomes,
        summary: report.summary,
        stateWritten: result.state.after !== undefined,
        cursorAfter: result.stores.cursor.after,
      }).toEqual({
        exitCode: 2,
        command: 'retire-source',
        dryRun: true,
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
            diagnostic: `unknown deployment scope '${source}'`,
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        stateWritten: false,
        cursorAfter: result.stores.cursor.before,
      });
    });
  });

  test('sync --manifest rejects a manifest with no entries before planning writes', async () => {
    await withLifecycleCliHarness((harness) => {
      const manifest = join(harness.source('batch', { 'manifest.json': '{"schemaVersion":1}\n' }), 'manifest.json');
      harness.writeHome({ '.cursor/.keep': '' });
      const result = harness.run(['sync', '--manifest', manifest, '--json']);
      const report = parseLifecycleReport(JSON.parse(result.stdout));
      expect({
        exitCode: result.exitCode,
        command: report.command.name,
        plan: report.plan,
        summary: report.summary,
        stateWritten: result.state.after !== undefined,
      }).toEqual({
        exitCode: 2,
        command: 'sync',
        plan: [],
        summary: {
          result: 'usage-error',
          terminalPhase: 'parse',
          mutationStarted: false,
          changed: false,
          failureCategory: 'usage',
          reason: {
            category: 'usage',
            code: 'usage.invalid-argument',
            diagnostic: 'sync manifest entries must be a non-empty array',
            capabilityId: null,
            evidenceId: null,
          },
          recoveryId: null,
          readbackId: null,
        },
        stateWritten: false,
      });
    });
  });

  test('applied sync installs the frozen package and records the scope', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const pluginJson = '{"name":"demo","version":"1.0.0","description":"Harness fixture"}\n';
      const source = harness.source('applied-sync', {
        'plugin.json': pluginJson,
        'skills/demo/SKILL.md': '---\nname: demo\ndescription: Harness fixture\n---\n\nDemo body.\n',
      });
      const cursor = harness.fakeNative('cursor', versionSteps(3));

      const result = harness.run(
        ['sync', source, '--target', 'cursor', '--json'],
        { env: { OPEN_PLUGIN_CURSOR_BIN: cursor.path } },
      );
      const report = parseLifecycleReport(JSON.parse(result.stdout));
      const operationIds = report.plan.map((operation) => operation.operationId);

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        command: report.command.name,
        dryRun: report.command.dryRun,
        outcomeIds: report.outcomes.map((outcome) => outcome.operationId),
        rows: report.outcomes.map((outcome) => ({
          package: outcome.package,
          nativeId: outcome.nativeId,
          action: outcome.action,
          route: outcome.route,
          result: outcome.result,
          resourceState: outcome.resourceState,
          activationState: outcome.activationState,
          changed: outcome.changed,
        })),
        summary: report.summary,
        installed: bytesToText(result.stores.cursor.after.files['plugins/local/demo/plugin.json'] ?? []),
        nativeInvocations: result.nativeInvocations['cursor'],
      }).toEqual({
        exitCode: 0,
        stderr: '',
        command: 'sync',
        dryRun: false,
        outcomeIds: operationIds,
        rows: [{
          package: 'demo',
          nativeId: 'demo',
          action: 'install',
          route: 'managed',
          result: 'succeeded',
          resourceState: 'present',
          activationState: 'active-conforming',
          changed: true,
        }],
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
        installed: pluginJson,
        nativeInvocations: versionSteps(3).map(() => ({ args: ['--version'] })),
      });
    });
  });

  test('scenario 1 dry-run retires only B and apply leaves A and instance two untouched', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const alphaJson = '{"name":"alpha","version":"1.0.0","description":"A"}\n';
      const betaJson = '{"name":"beta","version":"1.0.0","description":"B"}\n';
      const gammaJson = '{"name":"gamma","version":"1.0.0","description":"instance two"}\n';
      const source = harness.source('scenario-1', {
        'alpha/plugin.json': alphaJson,
        'alpha/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: A\n---\n\nAlpha.\n',
        'beta/plugin.json': betaJson,
        'beta/skills/beta/SKILL.md': '---\nname: beta\ndescription: B\n---\n\nBeta.\n',
      });
      const otherSource = harness.source('scenario-1-two', {
        'plugin.json': gammaJson,
        'skills/gamma/SKILL.md': '---\nname: gamma\ndescription: instance two\n---\n\nGamma.\n',
      });
      const cursor = harness.fakeNative('cursor', versionSteps(16));
      const env = { OPEN_PLUGIN_CURSOR_BIN: cursor.path };

      const installed = harness.run(['sync', source, '--target', 'cursor', '--instance', 'one', '--json'], { env });
      const other = harness.run(['sync', otherSource, '--target', 'cursor', '--instance', 'two', '--json'], { env });
      expect(installed.exitCode).toBe(0);
      expect(other.exitCode).toBe(0);
      const alphaBefore = installed.stores.cursor.after.files['plugins/local/alpha/plugin.json'];
      const betaBefore = installed.stores.cursor.after.files['plugins/local/beta/plugin.json'];
      const gammaBefore = other.stores.cursor.after.files['plugins/local/gamma/plugin.json'];
      expect(bytesToText(alphaBefore ?? [])).toBe(alphaJson);
      expect(bytesToText(betaBefore ?? [])).toBe(betaJson);
      expect(bytesToText(gammaBefore ?? [])).toBe(gammaJson);

      const preview = harness.run(
        ['sync', source, '--target', 'cursor', '--instance', 'one', '--plugin', 'alpha', '--dry-run', '--json'],
        { env },
      );
      const previewReport = parseLifecycleReport(JSON.parse(preview.stdout));
      expect({
        exitCode: preview.exitCode,
        stderr: preview.stderr,
        dryRun: previewReport.command.dryRun,
        retirements: previewReport.plan.filter((operation) => operation.action === 'retire-orphan').map((operation) => operation.package),
        actions: previewReport.outcomes.map((outcome) => ({ package: outcome.package, action: outcome.action, result: outcome.result })),
        summary: previewReport.summary,
        stateUntouched: preview.state.before === undefined && preview.state.after === undefined
          ? true
          : bytesToText(preview.state.before ?? []) === bytesToText(preview.state.after ?? []),
        cursorUntouched: preview.stores.cursor.before,
        cursorAfter: preview.stores.cursor.after,
      }).toEqual({
        exitCode: 0,
        stderr: '',
        dryRun: true,
        retirements: ['beta'],
        actions: [
          { package: 'alpha', action: 'unchanged', result: 'succeeded' },
          { package: 'beta', action: 'retire-orphan', result: 'succeeded' },
        ],
        summary: {
          result: 'converged',
          terminalPhase: 'complete',
          mutationStarted: false,
          changed: false,
          failureCategory: null,
          reason: null,
          recoveryId: null,
          readbackId: null,
        },
        stateUntouched: true,
        cursorUntouched: preview.stores.cursor.before,
        cursorAfter: preview.stores.cursor.before,
      });

      const applied = harness.run(
        ['sync', source, '--target', 'cursor', '--instance', 'one', '--plugin', 'alpha', '--json'],
        { env },
      );
      const appliedReport = parseLifecycleReport(JSON.parse(applied.stdout));
      expect({
        exitCode: applied.exitCode,
        stderr: applied.stderr,
        retirements: appliedReport.outcomes.filter((outcome) => outcome.action === 'retire-orphan').map((outcome) => ({
          package: outcome.package,
          result: outcome.result,
          resourceState: outcome.resourceState,
        })),
        alpha: bytesToText(applied.stores.cursor.after.files['plugins/local/alpha/plugin.json'] ?? []),
        betaGone: applied.stores.cursor.after.files['plugins/local/beta/plugin.json'] === undefined,
        gamma: bytesToText(applied.stores.cursor.after.files['plugins/local/gamma/plugin.json'] ?? []),
      }).toEqual({
        exitCode: 0,
        stderr: '',
        retirements: [{ package: 'beta', result: 'succeeded', resourceState: 'absent' }],
        alpha: alphaJson,
        betaGone: true,
        gamma: gammaJson,
      });
    });
  });

  test('retire-source removes a recorded scope and keeps the report on the frozen plan', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('retire-sync', {
        'plugin.json': '{"name":"demo","version":"1.0.0","description":"Harness fixture"}\n',
        'skills/demo/SKILL.md': '---\nname: demo\ndescription: Harness fixture\n---\n\nDemo body.\n',
      });
      const cursor = harness.fakeNative('cursor', versionSteps(8));
      const env = { OPEN_PLUGIN_CURSOR_BIN: cursor.path };
      const installed = harness.run(['sync', source, '--target', 'cursor', '--json'], { env });
      const installedReport = parseLifecycleReport(JSON.parse(installed.stdout));
      const scopeId = installedReport.outcomes[0]?.scope.id;
      expect(installed.exitCode).toBe(0);
      expect(scopeId).toMatch(/^scope-v1-[0-9a-f]{64}$/u);

      const retired = harness.run(['retire-source', scopeId!, '--target', 'cursor', '--json'], { env });
      const report = parseLifecycleReport(JSON.parse(retired.stdout));
      const operationIds = report.plan.map((operation) => operation.operationId);
      expect({
        exitCode: retired.exitCode,
        stderr: retired.stderr,
        command: report.command.name,
        dryRun: report.command.dryRun,
        outcomeIds: report.outcomes.map((outcome) => outcome.operationId),
        rows: report.outcomes.map((outcome) => ({
          package: outcome.package,
          scopeId: outcome.scope.id,
          action: outcome.action,
          result: outcome.result,
          resourceState: outcome.resourceState,
          activationState: outcome.activationState,
          changed: outcome.changed,
        })),
        summary: report.summary,
        pluginRemoved: retired.stores.cursor.after.files['plugins/local/demo/plugin.json'] === undefined,
      }).toEqual({
        exitCode: 0,
        stderr: '',
        command: 'retire-source',
        dryRun: false,
        outcomeIds: operationIds,
        rows: [{
          package: 'demo',
          scopeId,
          action: 'retire-orphan',
          result: 'succeeded',
          resourceState: 'absent',
          activationState: 'inactive',
          changed: true,
        }],
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
        pluginRemoved: true,
      });
    });
  });

  test('batch sync --manifest applies the frozen package', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const pluginJson = '{"name":"demo","version":"1.0.0","description":"Harness fixture"}\n';
      const source = harness.source('batch-apply', {
        'plugin.json': pluginJson,
        'skills/demo/SKILL.md': '---\nname: demo\ndescription: Harness fixture\n---\n\nDemo body.\n',
      });
      const manifest = join(harness.source('batch-file', {
        'manifest.json': `${JSON.stringify({
          schemaVersion: 1,
          entries: [{
            operation: 'sync',
            source: { kind: 'local', locator: source },
            target: { kind: 'cursor', instance: 'default' },
          }],
        })}\n`,
      }), 'manifest.json');
      const cursor = harness.fakeNative('cursor', versionSteps(3));
      const result = harness.run(
        ['sync', '--manifest', manifest, '--json'],
        { env: { OPEN_PLUGIN_CURSOR_BIN: cursor.path } },
      );
      const report = parseLifecycleReport(JSON.parse(result.stdout));
      const operationIds = report.plan.map((operation) => operation.operationId);
      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        command: report.command.name,
        dryRun: report.command.dryRun,
        outcomeIds: report.outcomes.map((outcome) => outcome.operationId),
        rows: report.outcomes.map((outcome) => ({
          package: outcome.package,
          nativeId: outcome.nativeId,
          action: outcome.action,
          route: outcome.route,
          result: outcome.result,
          changed: outcome.changed,
        })),
        summary: {
          result: report.summary.result,
          terminalPhase: report.summary.terminalPhase,
          mutationStarted: report.summary.mutationStarted,
          changed: report.summary.changed,
        },
        installed: bytesToText(result.stores.cursor.after.files['plugins/local/demo/plugin.json'] ?? []),
      }).toEqual({
        exitCode: 0,
        stderr: '',
        command: 'sync',
        dryRun: false,
        outcomeIds: operationIds,
        rows: [{
          package: 'demo',
          nativeId: 'demo',
          action: 'install',
          route: 'managed',
          result: 'succeeded',
          changed: true,
        }],
        summary: {
          result: 'converged',
          terminalPhase: 'complete',
          mutationStarted: true,
          changed: true,
        },
        installed: pluginJson,
      });
    });
  });
});

function versionSteps(count: number): { args: string[]; stdout: string }[] {
  return Array.from({ length: count }, () => ({ args: ['--version'], stdout: '2.4.0\n' }));
}
