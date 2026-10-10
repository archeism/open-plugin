import { describe, expect, test } from 'bun:test';
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
});
