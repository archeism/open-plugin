import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesToText, snapshotTree, textToBytes, withLifecycleCliHarness } from './lifecycle-cli-harness';
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
      const source = harness.source('scenario-1', {
        'alpha/plugin.json': alphaJson,
        'alpha/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: A\n---\n\nAlpha.\n',
        'beta/plugin.json': betaJson,
        'beta/skills/beta/SKILL.md': '---\nname: beta\ndescription: B\n---\n\nBeta.\n',
      });
      const cursor = harness.fakeNative('cursor', versionSteps(48));
      const env = { OPEN_PLUGIN_CURSOR_BIN: cursor.path };
      const instanceOne = join(harness.storePath('cursor'), 'instances', 'one');
      const instanceTwo = join(harness.storePath('cursor'), 'instances', 'two');

      const installed = harness.run(['sync', source, '--target', 'cursor', '--instance', 'one', '--json'], { env });
      const other = harness.run(['sync', source, '--target', 'cursor', '--instance', 'two', '--json'], { env });
      expect(installed.exitCode).toBe(0);
      expect(other.exitCode).toBe(0);
      const oneBefore = snapshotTree(instanceOne);
      const twoBefore = snapshotTree(instanceTwo);
      expect(bytesToText(oneBefore.files['plugins/local/alpha/plugin.json'] ?? [])).toBe(alphaJson);
      expect(bytesToText(oneBefore.files['plugins/local/beta/plugin.json'] ?? [])).toBe(betaJson);
      expect(bytesToText(twoBefore.files['plugins/local/alpha/plugin.json'] ?? [])).toBe(alphaJson);
      expect(bytesToText(twoBefore.files['plugins/local/beta/plugin.json'] ?? [])).toBe(betaJson);

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
      expect(snapshotTree(instanceTwo)).toEqual(twoBefore);
      expect(snapshotTree(instanceOne)).toEqual(oneBefore);

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
        alpha: bytesToText(snapshotTree(instanceOne).files['plugins/local/alpha/plugin.json'] ?? []),
        betaGone: snapshotTree(instanceOne).files['plugins/local/beta/plugin.json'] === undefined,
        instanceTwo: snapshotTree(instanceTwo),
      }).toEqual({
        exitCode: 0,
        stderr: '',
        retirements: [{ package: 'beta', result: 'succeeded', resourceState: 'absent' }],
        alpha: alphaJson,
        betaGone: true,
        instanceTwo: twoBefore,
      });
    });
  });

  test('scenario 2 bad and uninvoked sources never delete and offline retire keeps retained state', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const keptJson = '{"name":"kept","version":"1.0.0","description":"kept"}\n';
      const foreignJson = '{"name":"foreign","version":"1.0.0"}\n';
      const retainedData = 'plugin data\n';
      const retainedMetadata = 'inactive metadata\n';
      const source = harness.source('scenario-2', {
        'plugin.json': keptJson,
        'skills/kept/SKILL.md': '---\nname: kept\ndescription: kept\n---\n\nKept.\n',
      });
      const malformed = harness.source('scenario-2-malformed', {
        'marketplace.json': '{"name":"bad","plugins":"nope"}\n',
      });
      const empty = harness.source('scenario-2-empty', {
        'README.md': 'no plugins\n',
      });
      const uninvoked = harness.source('scenario-2-uninvoked', {
        'plugin.json': '{"name":"other","version":"1.0.0","description":"uninvoked"}\n',
        'skills/other/SKILL.md': '---\nname: other\ndescription: uninvoked\n---\n\nOther.\n',
      });
      const cursor = harness.fakeNative('cursor', versionSteps(16));
      const git = harness.fakeNative('git-remote', [{
        args: ['ls-remote', 'https://example.test/missing.git', 'HEAD'],
        stderr: 'fatal: unavailable\n',
        exitCode: 17,
      }]);
      const env = { OPEN_PLUGIN_CURSOR_BIN: cursor.path };
      const cursorStore = harness.storePath('cursor');

      const installed = harness.run(['sync', source, '--target', 'cursor', '--json'], { env });
      const installedReport = parseLifecycleReport(JSON.parse(installed.stdout));
      const scopeId = installedReport.outcomes[0]?.scope.id;
      expect(installed.exitCode).toBe(0);
      expect(scopeId).toMatch(/^scope-v1-[0-9a-f]{64}$/u);
      harness.writeHome({
        '.cursor/plugins/local/foreign/.cursor-plugin/plugin.json': foreignJson,
        '.cursor/plugins/retained/kept/data/note.txt': retainedData,
        '.cursor/plugins/retained/kept/metadata/note.txt': retainedMetadata,
      });

      const preserved = (files: Record<string, number[] | undefined>) => ({
        kept: bytesToText(files['plugins/local/kept/plugin.json'] ?? []),
        foreign: bytesToText(files['plugins/local/foreign/.cursor-plugin/plugin.json'] ?? []),
        data: bytesToText(files['plugins/retained/kept/data/note.txt'] ?? []),
        metadata: bytesToText(files['plugins/retained/kept/metadata/note.txt'] ?? []),
      });
      const refused = (label: string, result: ReturnType<typeof harness.run>, fragment: string) => {
        const report = parseLifecycleReport(JSON.parse(result.stdout));
        expect({
          label,
          exitCode: result.exitCode,
          stderr: result.stderr,
          plan: report.plan.length,
          outcomes: report.outcomes.length,
          mutationStarted: report.summary.mutationStarted,
          changed: report.summary.changed,
          diagnostic: report.summary.reason?.diagnostic.includes(fragment) === true,
          cursor: result.stores.cursor.after,
          files: preserved(result.stores.cursor.after.files),
        }).toEqual({
          label,
          exitCode: 2,
          stderr: '',
          plan: 0,
          outcomes: 0,
          mutationStarted: false,
          changed: false,
          diagnostic: true,
          cursor: result.stores.cursor.before,
          files: { kept: keptJson, foreign: foreignJson, data: retainedData, metadata: retainedMetadata },
        });
      };

      refused('missing', harness.run(['sync', join(harness.root, 'missing-source'), '--target', 'cursor', '--json'], { env }), 'Local source not found');
      refused(
        'unreachable',
        harness.run(
          ['sync', 'https://example.test/missing.git', '--target', 'cursor', '--json'],
          { env: { ...env, OPEN_PLUGIN_GIT_BIN: git.path } },
        ),
        'Failed to resolve git remote',
      );
      refused('malformed', harness.run(['sync', malformed, '--target', 'cursor', '--json'], { env }), 'Malformed marketplace');
      const idle = harness.run(['scopes', uninvoked, '--target', 'cursor', '--json'], { env });
      expect({
        exitCode: idle.exitCode,
        stderr: idle.stderr,
        stdout: idle.stdout,
        cursor: idle.stores.cursor.after,
        files: preserved(snapshotTree(cursorStore).files),
      }).toEqual({
        exitCode: 2,
        stderr: `unknown deployment scope '${uninvoked}'\n`,
        stdout: '',
        cursor: idle.stores.cursor.before,
        files: { kept: keptJson, foreign: foreignJson, data: retainedData, metadata: retainedMetadata },
      });
      refused('zero-package', harness.run(['sync', empty, '--target', 'cursor', '--json'], { env }), 'No plugins discovered');

      rmSync(source, { recursive: true, force: true });
      const retired = harness.run(['retire-source', scopeId!, '--target', 'cursor', '--json'], { env });
      const retiredReport = parseLifecycleReport(JSON.parse(retired.stdout));
      const after = snapshotTree(cursorStore);
      expect({
        exitCode: retired.exitCode,
        stderr: retired.stderr,
        sourceAbsent: existsSync(source),
        rows: retiredReport.outcomes.map((outcome) => ({
          package: outcome.package,
          action: outcome.action,
          result: outcome.result,
          resourceState: outcome.resourceState,
        })),
        keptDir: after.directories.includes('plugins/local/kept'),
        foreign: bytesToText(after.files['plugins/local/foreign/.cursor-plugin/plugin.json'] ?? []),
        data: bytesToText(after.files['plugins/retained/kept/data/note.txt'] ?? []),
        metadata: bytesToText(after.files['plugins/retained/kept/metadata/note.txt'] ?? []),
      }).toEqual({
        exitCode: 0,
        stderr: '',
        sourceAbsent: false,
        rows: [{ package: 'kept', action: 'retire-orphan', result: 'succeeded', resourceState: 'absent' }],
        keptDir: false,
        foreign: foreignJson,
        data: retainedData,
        metadata: retainedMetadata,
      });
    });
  });

  test('scenario 3 failures write nothing, and two scope records load as corrupt state', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const source = harness.source('scenario-3', {
        'plugin.json': '{"name":"kept","version":"1.0.0","description":"kept"}\n',
        'skills/kept/SKILL.md': '---\nname: kept\ndescription: kept\n---\n\nKept.\n',
      });
      const other = harness.source('scenario-3-other', {
        'plugin.json': '{"name":"kept","version":"1.0.0","description":"other source"}\n',
        'skills/kept/SKILL.md': '---\nname: kept\ndescription: other source\n---\n\nOther.\n',
      });
      const cursor = harness.fakeNative('cursor', versionSteps(24));
      const broken = harness.fakeNative('cursor-broken', versionSteps(8).map(() => ({
        args: ['--version'],
        stderr: 'probe failed\n',
        exitCode: 1,
      })));
      const env = { OPEN_PLUGIN_CURSOR_BIN: cursor.path };
      const cursorStore = harness.storePath('cursor');
      const statePath = join(harness.home, 'state.json');
      const installed = harness.run(['sync', source, '--target', 'cursor', '--json'], { env });
      expect(installed.exitCode).toBe(0);
      const cursorBefore = snapshotTree(cursorStore);
      const stateBefore = readFileSync(statePath, 'utf8');

      const closed = (label: string, result: ReturnType<typeof harness.run>, stateExpected: string, code: string) => {
        const report = result.stdout.trim().startsWith('{') ? parseLifecycleReport(JSON.parse(result.stdout)) : null;
        expect({
          label,
          failed: result.exitCode !== 0,
          code: report?.summary.reason?.code ?? null,
          mutationStarted: report?.summary.mutationStarted ?? null,
          changed: report?.summary.changed ?? null,
          cursor: snapshotTree(cursorStore),
          state: readFileSync(statePath, 'utf8'),
        }).toEqual({
          label,
          failed: true,
          code,
          mutationStarted: false,
          changed: false,
          cursor: cursorBefore,
          state: stateExpected,
        });
      };

      closed(
        'invalid-selection',
        harness.run(['sync', source, '--target', 'cursor', '--plugin', 'not-in-source', '--json'], { env }),
        stateBefore,
        'usage.invalid-selection',
      );

      const collision = join(harness.source('scenario-3-collision', {}), 'manifest.json');
      writeFileSync(collision, JSON.stringify({
        schemaVersion: 1,
        entries: [
          { operation: 'sync', source: { kind: 'local', locator: source }, target: { kind: 'cursor', instance: 'default' } },
          { operation: 'sync', source: { kind: 'local', locator: other }, target: { kind: 'cursor', instance: 'default' } },
        ],
      }));
      closed('collision', harness.run(['sync', '--manifest', collision, '--json'], { env }), stateBefore, 'internal.ambiguous-ownership');

      const brokenProbe = harness.run(
        ['sync', source, '--target', 'cursor', '--json'],
        { env: { ...env, OPEN_PLUGIN_CURSOR_BIN: broken.path } },
      );
      const probeReport = parseLifecycleReport(JSON.parse(brokenProbe.stdout));
      expect({
        exitCode: brokenProbe.exitCode,
        stderr: brokenProbe.stderr,
        action: probeReport.outcomes[0]?.action ?? null,
        category: probeReport.outcomes[0]?.reason?.category ?? null,
        mutationStarted: probeReport.summary.mutationStarted,
        changed: probeReport.summary.changed,
        cursor: snapshotTree(cursorStore),
        state: readFileSync(statePath, 'utf8'),
      }).toEqual({
        exitCode: 1,
        stderr: '',
        action: 'retain-prior',
        category: 'capability',
        mutationStarted: false,
        changed: false,
        cursor: cursorBefore,
        state: stateBefore,
      });

      const schema = join(harness.source('scenario-3-schema', {}), 'manifest.json');
      writeFileSync(schema, JSON.stringify({
        schemaVersion: 2,
        entries: [
          { operation: 'sync', source: { kind: 'local', locator: source }, target: { kind: 'cursor', instance: 'default' } },
          { operation: 'sync', source: { kind: 'local', locator: other }, target: { kind: 'codex', instance: 'default' } },
        ],
      }));
      closed('deterministic-bug', harness.run(['sync', '--manifest', schema, '--json'], { env }), stateBefore, 'usage.invalid-argument');

      const recorded = JSON.parse(stateBefore) as {
        scopes: Array<{ id: string }>;
        activations: Array<{ scopeId: string }>;
      };
      const scope = recorded.scopes[0]!;
      const duplicateId = `${scope.id.slice(0, -1)}${scope.id.endsWith('a') ? 'b' : 'a'}`;
      recorded.scopes.push({ ...JSON.parse(JSON.stringify(scope)), id: duplicateId });
      recorded.activations.push(
        ...recorded.activations
          .filter((activation) => activation.scopeId === scope.id)
          .map((activation) => ({ ...JSON.parse(JSON.stringify(activation)), scopeId: duplicateId })),
      );
      const duplicated = JSON.stringify(recorded);
      writeFileSync(statePath, duplicated);
      const ambiguous = join(harness.source('scenario-3-ambiguous', {}), 'manifest.json');
      writeFileSync(ambiguous, JSON.stringify({
        schemaVersion: 1,
        entries: [
          { operation: 'sync', source: { kind: 'local', locator: source }, target: { kind: 'cursor', instance: 'default' } },
          { operation: 'sync', source: { kind: 'local', locator: other }, target: { kind: 'cursor', instance: 'one' } },
        ],
      }));
      closed('ambiguous-ownership', harness.run(['sync', '--manifest', ambiguous, '--json'], { env }), duplicated, 'internal.corrupt-state');

      const garbage = '{ not json';
      writeFileSync(statePath, garbage);
      closed(
        'corrupt-state',
        harness.run(['sync', source, '--target', 'cursor', '--json'], { env }),
        garbage,
        'internal.corrupt-state',
      );
    });
  });

  test('scenario 4 one cursor instance converges and the refused version leaves the other scope unpruned', async () => {
    await withLifecycleCliHarness((harness) => {
      harness.writeHome({ '.cursor/.keep': '' });
      const keptJson = '{"name":"kept","version":"1.0.0","description":"kept"}\n';
      const staleJson = '{"name":"stale","version":"1.0.0","description":"stale"}\n';
      const freshJson = '{"name":"fresh","version":"1.0.0","description":"fresh"}\n';
      const installed = harness.source('scenario-4-installed', {
        'kept/plugin.json': keptJson,
        'kept/skills/kept/SKILL.md': '---\nname: kept\ndescription: kept\n---\n\nKept.\n',
        'stale/plugin.json': staleJson,
        'stale/skills/stale/SKILL.md': '---\nname: stale\ndescription: stale\n---\n\nStale.\n',
      });
      const fresh = harness.source('scenario-4-fresh', {
        'plugin.json': freshJson,
        'skills/fresh/SKILL.md': '---\nname: fresh\ndescription: fresh\n---\n\nFresh.\n',
      });
      const accepted = harness.fakeNative('cursor-accepted', versionSteps(16));
      const batch = harness.fakeNative('cursor-batch', [
        { args: ['--version'], stdout: '2.4.0\n' },
        { args: ['--version'], stdout: '1.2.3\n' },
        { args: ['--version'], stdout: '2.4.0\n' },
        { args: ['--version'], stdout: '2.4.0\n' },
        { args: ['--version'], stdout: '2.4.0\n' },
        { args: ['--version'], stdout: '2.4.0\n' },
      ]);
      const seeded = harness.run(
        ['sync', installed, '--target', 'cursor', '--instance', 'two', '--json'],
        { env: { OPEN_PLUGIN_CURSOR_BIN: accepted.path } },
      );
      expect(seeded.exitCode).toBe(0);
      const instanceOne = join(harness.storePath('cursor'), 'instances', 'one');
      const instanceTwo = join(harness.storePath('cursor'), 'instances', 'two');
      const staleBefore = snapshotTree(instanceTwo).files['plugins/local/stale/plugin.json'];
      expect(bytesToText(staleBefore ?? [])).toBe(staleJson);

      const manifest = join(harness.source('scenario-4-manifest', {}), 'manifest.json');
      writeFileSync(manifest, JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            operation: 'sync',
            source: { kind: 'local', locator: fresh },
            target: { kind: 'cursor', instance: 'one' },
          },
          {
            operation: 'sync',
            source: { kind: 'local', locator: installed },
            target: { kind: 'cursor', instance: 'two' },
            selectors: [{ package: 'kept', adoptExisting: false }],
          },
        ],
      }));
      const result = harness.run(
        ['sync', '--manifest', manifest, '--json'],
        { env: { OPEN_PLUGIN_CURSOR_BIN: batch.path } },
      );
      const report = parseLifecycleReport(JSON.parse(result.stdout));
      const incomplete = report.plan.filter((operation) => operation.scope.target.instance === 'two');
      const gap = report.outcomes.find((outcome) => outcome.scope.target.instance === 'two' && outcome.package === 'kept');
      const converged = report.outcomes.find((outcome) => outcome.scope.target.instance === 'one' && outcome.package === 'fresh');
      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        summary: report.summary.result,
        failureCategory: report.summary.failureCategory,
        converged: converged === undefined ? null : { result: converged.result, action: converged.action },
        gap: gap === undefined ? null : { result: gap.result, action: gap.action, category: gap.reason?.category ?? null },
        retirements: incomplete.filter((operation) => operation.action === 'retire-orphan').map((operation) => operation.package),
        fresh: bytesToText(snapshotTree(instanceOne).files['plugins/local/fresh/plugin.json'] ?? []),
        stale: snapshotTree(instanceTwo).files['plugins/local/stale/plugin.json'],
      }).toEqual({
        exitCode: 1,
        stderr: '',
        summary: 'incomplete',
        failureCategory: 'capability',
        converged: { result: 'succeeded', action: 'install' },
        gap: { result: 'failed', action: 'retain-prior', category: 'capability' },
        retirements: [],
        fresh: freshJson,
        stale: staleBefore,
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
