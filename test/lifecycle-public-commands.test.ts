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
});
