import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  bytesToText,
  textToBytes,
  withLifecycleCliHarness,
  type StateDocument,
} from './lifecycle-cli-harness';
import { initGitRepo } from './util';

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
        authoredSourceDirs: state.installs.map(({ sourceDir }) => sourceDir),
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

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        outcomes: JSON.parse(result.stdout),
        source: state.installs[0]?.source,
        sourceSha: state.installs[0]?.sourceSha,
        sourceIsFrozen: state.installs[0]?.sourceDir.startsWith(join(harness.home, 'cache', 'source-snapshots')),
        installedBytes: bytesToText(result.stores.cursor.after.files['plugins/local/fixture/resources/value.txt']!),
        durableOutputLeaksCredential: `${result.stdout}\n${result.stderr}\n${stateText}`.includes('super-secret'),
      }).toEqual({
        exitCode: 0,
        stderr: '',
        outcomes: [{
          plugin: 'fixture',
          target: 'cursor',
          status: 'installed',
          action: 'install',
          dryRun: false,
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
      const outcomes = JSON.parse(result.stdout) as Array<{ status: string; diagnostic: string }>;

      expect({
        exitCode: result.exitCode,
        stateUnwritten: result.state,
        cursorUnchanged: result.stores.cursor,
        outcome: outcomes[0],
        outputLeaksCredential: `${result.stdout}\n${result.stderr}`.includes('super-secret'),
        gitInvocations: result.nativeInvocations.git,
      }).toEqual({
        exitCode: 1,
        stateUnwritten: {},
        cursorUnchanged: {
          before: result.stores.cursor.before,
          after: result.stores.cursor.before,
        },
        outcome: {
          plugin: '*',
          target: '*',
          status: 'failed',
          action: 'install',
          dryRun: false,
          diagnostic: 'Failed to resolve git remote: https://example.test/missing.git (fatal: unavailable)',
        },
        outputLeaksCredential: false,
        gitInvocations: [{ args: ['ls-remote', 'https://user:super-secret@example.test/missing.git', 'HEAD'] }],
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
