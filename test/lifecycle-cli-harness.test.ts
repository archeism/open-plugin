import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  bytesToText,
  textToBytes,
  withLifecycleCliHarness,
  type StateDocument,
} from './lifecycle-cli-harness';

describe('isolated lifecycle CLI harness', () => {
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
      const outcomes = JSON.parse(result.stdout) as Array<{ plugin: string; target: string; status: string }>;

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        outcomes: outcomes.map(({ plugin, target, status }) => ({ plugin, target, status })),
        statePairs: state.installs.map(({ host, id, pending }) => ({ host, id, pending })),
        cursorManifest: bytesToText(result.stores['cursor']!.after.files['plugins/local/demo/plugin.json']!),
        claudeManifest: bytesToText(result.stores['claude-code']!.after.files['plugins/cache/local/demo/local/plugin.json']!),
        nativeInvocations: result.nativeInvocations['claude'],
        ambientHomeUnchanged: result.ambient.before,
        ambientHomeAfter: result.ambient.after,
      }).toEqual({
        exitCode: 0,
        stderr: '',
        outcomes: [
          { plugin: 'demo', target: 'claude-code', status: 'installed' },
          { plugin: 'demo', target: 'cursor', status: 'installed' },
        ],
        statePairs: [
          { host: 'claude-code', id: 'demo@local', pending: undefined },
          { host: 'cursor', id: 'demo', pending: undefined },
        ],
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
      const outcomes = JSON.parse(result.stdout) as Array<{ target: string; status: string; diagnostic: string }>;

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        outcomes,
        stateAfter: result.state.after,
        nativeInvocations: result.nativeInvocations['claude'],
        remainingNativeSteps: claude.remainingSteps(),
      }).toEqual({
        exitCode: 2,
        stderr: '',
        outcomes: [{
          target: 'claude-code',
          plugin: '*',
          status: 'failed',
          dryRun: false,
          diagnostic: "requested target 'claude-code' is not present on this machine",
        }],
        stateAfter: undefined,
        nativeInvocations: [{ args: ['--version'] }],
        remainingNativeSteps: 0,
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
