import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { normalizeSource, resolveSource as resolveSourcePublic } from '../src/source';
import { fingerprintTree } from '../src/fingerprint';
import { commitAll, initGitRepo } from './util';

const sourceHome = mkdtempSync(join(tmpdir(), 'plgnz-source-home-'));
afterAll(() => rmSync(sourceHome, { recursive: true, force: true }));

function resolveSource(source: string): ReturnType<typeof resolveSourcePublic> {
  const previous = process.env['OPEN_PLUGIN_HOME'];
  process.env['OPEN_PLUGIN_HOME'] = sourceHome;
  try { return resolveSourcePublic(source); }
  finally {
    if (previous === undefined) delete process.env['OPEN_PLUGIN_HOME'];
    else process.env['OPEN_PLUGIN_HOME'] = previous;
  }
}

function plugin(dir: string, name = 'fixture'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
}

describe('resolveSource', () => {
  test('normalizes public owner/repo shorthand without treating it as local', () => {
    expect(normalizeSource('owner/repo')).toBe('https://github.com/owner/repo.git');
    expect(normalizeSource('git@github.com:owner/repo.git#release')).toBe('git@github.com:owner/repo.git#release');
    expect(normalizeSource('./plugin')).toBe(resolve('./plugin'));
    expect(normalizeSource('../plugin')).toBe(resolve('../plugin'));
  });

  test('normalizes a relative local root and fingerprints its bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-source-'));
    plugin(root);
    const first = resolveSource(root);
    writeFileSync(join(root, 'resource.md'), 'changed without a version bump\n');
    const second = resolveSource(root);

    expect(first.sourceUri).toBe(resolve(root));
    expect(first.plugins[0]?.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.plugins[0]?.contentFingerprint === first.plugins[0]?.contentFingerprint).toBe(false);
  });

  test('freezes local source bytes before returning packages to lifecycle callers', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-frozen-local-'));
    plugin(root);
    writeFileSync(join(root, 'resource.md'), 'frozen\n');

    const resolved = resolveSource(root);
    const frozen = resolved.plugins[0]!;
    writeFileSync(join(root, 'resource.md'), 'edited after resolution\n');

    expect({
      sourceUri: resolved.sourceUri,
      binding: resolved.snapshot.binding,
      revision: resolved.snapshot.revision,
      snapshotFingerprint: resolved.snapshot.fingerprint,
      sourceDir: frozen.sourceDir,
      relativeDir: frozen.relativeDir,
      stagedBytes: readFileSync(join(frozen.dir, 'resource.md'), 'utf8'),
      stagedAwayFromSource: frozen.dir !== root,
    }).toEqual({
      sourceUri: resolve(root),
      binding: { kind: 'local', locator: resolve(root) },
      revision: resolved.snapshot.fingerprint,
      snapshotFingerprint: resolved.snapshot.fingerprint,
      sourceDir: resolve(root),
      relativeDir: '.',
      stagedBytes: 'frozen\n',
      stagedAwayFromSource: true,
    });
    expect(resolved.snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('freezes a mode-only local Source change as a distinct executable snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-frozen-local-mode-'));
    plugin(root, 'local-mode-fixture');
    const executable = join(root, 'run.sh');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o644);

    const first = resolveSource(root);
    chmodSync(executable, 0o755);
    const second = resolveSource(root);

    expect({
      sameFingerprint: first.snapshot.fingerprint === second.snapshot.fingerprint,
      sameSnapshot: first.snapshotDir === second.snapshotDir,
      firstExecutable: executableBits(join(first.snapshotDir, 'run.sh')),
      secondExecutable: executableBits(join(second.snapshotDir, 'run.sh')),
      sameBytes: readFileSync(join(first.snapshotDir, 'run.sh'), 'utf8') === readFileSync(join(second.snapshotDir, 'run.sh'), 'utf8'),
    }).toEqual({
      sameFingerprint: false,
      sameSnapshot: false,
      firstExecutable: 0,
      secondExecutable: 0o111,
      sameBytes: true,
    });
    chmodSync(join(second.snapshotDir, 'run.sh'), 0o644);
    expectThrow(() => resolveSource(root), 'Cached Source snapshot is corrupt');
  });

  test('binds a credentialed remote ref to one immutable revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-frozen-remote-'));
    const checkout = join(root, 'checkout');
    const remote = join(root, 'remote.git');
    const fakeBin = join(root, 'bin');
    const first = initGitRepo(checkout, {
      'plugin.json': '{"name":"fixture","version":"1.0.0"}',
      'resource.md': 'revision one\n',
    });
    expect(spawnSync('git', ['clone', '--quiet', '--bare', checkout, remote], { encoding: 'utf8' }).status).toBe(0);
    writeFileSync(join(checkout, 'resource.md'), 'revision two\n');
    const second = commitAll(checkout, 'move remote after resolution');
    expect(spawnSync('git', ['-C', checkout, 'push', '--quiet', remote, `${second}:refs/heads/future`], { encoding: 'utf8' }).status).toBe(0);
    mkdirSync(fakeBin, { recursive: true });
    const git = join(fakeBin, 'git');
    writeFileSync(git, `#!/bin/bash
set -euo pipefail
real_git=/usr/bin/git
remote=${JSON.stringify(remote)}
move_to=${JSON.stringify(second)}
requested='https://user:super-secret@example.test/repo.git'
args=("$@")
for i in "\${!args[@]}"; do
  if [[ "\${args[$i]}" == "$requested" || "\${args[$i]}" == "$requested#main" ]]; then args[$i]="$remote"; fi
done
if [[ "\${args[0]}" == ls-remote ]]; then
  output=$("$real_git" "\${args[@]}")
  "$real_git" --git-dir="$remote" update-ref refs/heads/main "$move_to"
  printf '%s\n' "$output"
  exit 0
fi
exec "$real_git" "\${args[@]}"
`);
    chmodSync(git, 0o755);
    const previousGit = process.env['OPEN_PLUGIN_GIT_BIN'];
    process.env['OPEN_PLUGIN_GIT_BIN'] = git;

    try {
      const resolved = resolveSource('https://user:super-secret@example.test/repo.git#main');
      expect({
        sourceUri: resolved.sourceUri,
        snapshot: resolved.snapshot,
        bytes: readFileSync(join(resolved.plugins[0]!.dir, 'resource.md'), 'utf8'),
        remoteHead: spawnSync('/usr/bin/git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim(),
        serializedLeaksCredential: JSON.stringify({ sourceUri: resolved.sourceUri, snapshot: resolved.snapshot }).includes('super-secret'),
      }).toEqual({
        sourceUri: 'https://example.test/repo.git#main',
        snapshot: {
          binding: { kind: 'git', locator: 'https://example.test/repo.git', ref: 'main' },
          revision: first,
          fingerprint: resolved.snapshot.fingerprint,
        },
        bytes: 'revision one\n',
        remoteHead: second,
        serializedLeaksCredential: false,
      });
      expect(resolved.snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (previousGit === undefined) delete process.env['OPEN_PLUGIN_GIT_BIN'];
      else process.env['OPEN_PLUGIN_GIT_BIN'] = previousGit;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('materializes executable mode from distinct exact remote revisions', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-frozen-remote-mode-'));
    const checkout = join(root, 'checkout');
    const remote = join(root, 'remote.git');
    const fakeBin = join(root, 'bin');
    const executable = join(checkout, 'run.sh');
    const first = initGitRepo(checkout, {
      'plugin.json': '{"name":"fixture","version":"1.0.0"}',
      'run.sh': '#!/bin/sh\nexit 0\n',
    });
    chmodSync(executable, 0o755);
    const second = commitAll(checkout, 'make script executable');
    expect(spawnSync('git', ['clone', '--quiet', '--bare', checkout, remote], { encoding: 'utf8' }).status).toBe(0);
    mkdirSync(fakeBin, { recursive: true });
    const git = join(fakeBin, 'git');
    writeFileSync(git, `#!/bin/bash
set -euo pipefail
real_git=/usr/bin/git
remote=${JSON.stringify(remote)}
requested='https://example.test/mode.git'
args=("$@")
for i in "\${!args[@]}"; do
  if [[ "\${args[$i]}" == "$requested" ]]; then args[$i]="$remote"; fi
done
exec "$real_git" "\${args[@]}"
`);
    chmodSync(git, 0o755);
    const previousGit = process.env['OPEN_PLUGIN_GIT_BIN'];
    process.env['OPEN_PLUGIN_GIT_BIN'] = git;

    try {
      const before = resolveSource(`https://example.test/mode.git#${first}`);
      const after = resolveSource(`https://example.test/mode.git#${second}`);
      expect({
        revisions: [before.snapshot.revision, after.snapshot.revision],
        sameFingerprint: before.snapshot.fingerprint === after.snapshot.fingerprint,
        sameSnapshot: before.snapshotDir === after.snapshotDir,
        beforeExecutable: executableBits(join(before.snapshotDir, 'run.sh')),
        afterExecutable: executableBits(join(after.snapshotDir, 'run.sh')),
      }).toEqual({
        revisions: [first, second],
        sameFingerprint: false,
        sameSnapshot: false,
        beforeExecutable: 0,
        afterExecutable: 0o111,
      });
    } finally {
      if (previousGit === undefined) delete process.env['OPEN_PLUGIN_GIT_BIN'];
      else process.env['OPEN_PLUGIN_GIT_BIN'] = previousGit;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses a native-only Claude marketplace manifest for plugin identity and version', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-native-source-'));
    mkdirSync(join(root, '.claude-plugin'));
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'superpowers-dev', plugins: [{ source: './' }],
    }));
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'superpowers', version: '6.4.1', description: 'Native source fixture', nativeOnly: true,
    }));
    const plugin = resolveSource(root).plugins[0];
    expect(plugin?.name).toBe('superpowers');
    expect(plugin?.version).toBe('6.4.1');
    expect(plugin?.marketplace).toBe('superpowers-dev');
  });

  test('rejects conflicting canonical and native manifest identities', () => {
    for (const native of [
      { name: 'other', version: '1.0.0' },
      { name: 'fixture', version: '2.0.0' },
    ]) {
      const root = mkdtempSync(join(tmpdir(), 'plgnz-manifest-conflict-'));
      plugin(root, 'fixture');
      mkdirSync(join(root, '.claude-plugin'));
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(native));
      expectThrow(() => resolveSource(root), 'Conflicting plugin manifest identity');
    }
  });

  test('rejects a malformed native manifest even when a canonical manifest is present', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-manifest-malformed-'));
    plugin(root, 'fixture');
    mkdirSync(join(root, '.claude-plugin'));
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{not json');
    expectThrow(() => resolveSource(root), 'Malformed plugin manifest');
  });

  test('rejects a collection that discovers no plugins', () => {
    const empty = mkdtempSync(join(tmpdir(), 'plgnz-empty-'));
    let error: Error | undefined;
    try { resolveSource(empty); } catch (caught) { error = caught as Error; }
    expect(error?.message).toContain('No plugins discovered');
  });

  test('rejects duplicate marketplace identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-duplicate-'));
    plugin(join(root, 'one'), 'same');
    plugin(join(root, 'two'), 'same');
    mkdirSync(join(root, '.claude-plugin'));
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'personal', plugins: [{ source: 'one' }, { source: 'two' }],
    }));
    let error: Error | undefined;
    try { resolveSource(root); } catch (caught) { error = caught as Error; }
    expect(error?.message).toContain('Duplicate plugin identity');
  });

  test('rejects malformed marketplace files and sources that escape their collection before fallback discovery', () => {
    const malformed = mkdtempSync(join(tmpdir(), 'plgnz-malformed-marketplace-'));
    plugin(malformed, 'fallback-must-not-win');
    mkdirSync(join(malformed, '.claude-plugin'));
    writeFileSync(join(malformed, '.claude-plugin', 'marketplace.json'), '{not json');
    expectThrow(() => resolveSource(malformed), 'Malformed marketplace manifest');

    const collection = mkdtempSync(join(tmpdir(), 'plgnz-escaped-marketplace-'));
    const outside = mkdtempSync(join(tmpdir(), 'plgnz-outside-plugin-'));
    plugin(outside, 'outside');
    writeFileSync(join(collection, 'marketplace.json'), JSON.stringify({ name: 'test', plugins: [{ source: '../' + outside.split('/').pop() }] }));
    expectThrow(() => resolveSource(collection), 'escapes collection root');

    const empty = mkdtempSync(join(tmpdir(), 'plgnz-empty-marketplace-'));
    mkdirSync(join(empty, '.claude-plugin'));
    plugin(join(empty, 'incidental'), 'incidental');
    writeFileSync(join(empty, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'test', plugins: [] }));
    expectThrow(() => resolveSource(empty), 'No plugins discovered in marketplace');
  });

  test('rejects plugin and marketplace identities that could escape a host store', () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'plgnz-unsafe-plugin-'));
    writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({ name: '../../escape' }));
    expectThrow(() => resolveSource(pluginRoot), 'Unsafe plugin name');

    const marketplace = mkdtempSync(join(tmpdir(), 'plgnz-unsafe-marketplace-'));
    mkdirSync(join(marketplace, '.claude-plugin'));
    plugin(join(marketplace, 'safe'), 'safe');
    writeFileSync(join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: '../escape', plugins: [{ source: 'safe' }] }));
    expectThrow(() => resolveSource(marketplace), 'Unsafe marketplace name');
  });

  test('rejects every symlink and fingerprints binary resource bytes without UTF-8 collisions', () => {
    const linked = mkdtempSync(join(tmpdir(), 'plgnz-linked-source-'));
    plugin(linked);
    const target = join(linked, 'target.txt');
    writeFileSync(target, 'not a resource to follow');
    spawnSync('ln', ['-s', target, join(linked, 'linked.txt')]);
    expectThrow(() => resolveSource(linked), 'Symlink');

    const rootTarget = mkdtempSync(join(tmpdir(), 'plgnz-root-link-target-'));
    plugin(rootTarget);
    const rootLink = join(tmpdir(), `plgnz-root-link-${Date.now()}`);
    spawnSync('ln', ['-s', rootTarget, rootLink]);
    expectThrow(() => resolveSource(rootLink), 'Symlink');

    const first = mkdtempSync(join(tmpdir(), 'plgnz-binary-first-'));
    const second = mkdtempSync(join(tmpdir(), 'plgnz-binary-second-'));
    plugin(first);
    plugin(second);
    writeBytes(join(first, 'resource.bin'), [0x80]);
    writeBytes(join(second, 'resource.bin'), [0x81]);
    expect(resolveSource(first).plugins[0]?.contentFingerprint === resolveSource(second).plugins[0]?.contentFingerprint).toBe(false);
  });

  test('fingerprint framing cannot confuse file bytes with the next file record', () => {
    const first = mkdtempSync(join(tmpdir(), 'plgnz-framing-one-'));
    const second = mkdtempSync(join(tmpdir(), 'plgnz-framing-two-'));
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeBytes(join(first, 'a'), [88, 0, 102, 0, 98, 0, 89]);
    writeFileSync(join(second, 'a'), 'X');
    writeFileSync(join(second, 'b'), 'Y');
    expect(fingerprintTree(first) === fingerprintTree(second)).toBe(false);
  });
});

function expectThrow(fn: () => void, message: string): void {
  try {
    fn();
    throw new Error('expected function to throw');
  } catch (caught) {
    expect(caught instanceof Error ? caught.message : String(caught)).toContain(message);
  }
}

function writeBytes(path: string, bytes: number[]): void {
  const write = writeFileSync as unknown as (target: string, data: Uint8Array) => void;
  write(path, new Uint8Array(bytes));
}

function executableBits(path: string): number {
  return statSync(path).mode & 0o111;
}
