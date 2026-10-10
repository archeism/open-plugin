import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, writeFiles } from './util';
import { parseLifecycleReport } from '../src/lifecycle-report';

test('public dcode local add returns the removable native id and leaves foreign state intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-dcode-public-local-'));
  const home = join(root, 'home'), native = join(home, '.deepagents'), source = join(root, 'plugin'), empty = join(root, 'empty');
  try {
    mkdirSync(empty); mkdirSync(join(native, '.state'), { recursive: true });
    writeFiles(source, {
      'plugin.json': '{"name":"release-smoke","version":"0.1.0"}\n',
      'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: fixture\n---\nbody\n',
    });
    const foreign = join(native, 'plugins/cache/local/foreign/local');
    writeFiles(foreign, { 'plugin.json': '{"name":"foreign","version":"0.1.0"}\n', 'sentinel.txt': 'keep\n' });
    const registry = join(native, '.state', 'installed_plugins.json');
    const enablement = join(native, '.state', 'plugin_state.json');
    writeFileSync(registry, JSON.stringify({ version: 2, plugins: { 'foreign@local': [{ installPath: foreign, version: 'local' }] } }));
    writeFileSync(enablement, JSON.stringify({ version: 1, enabledPlugins: { 'foreign@local': true } }));
    const binary = join(root, 'dcode');
    writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' 'deepagents-code 0.1.83' 'deepagents (SDK) 0.7.23'; exit 0; fi\nexit 91\n`);
    chmodSync(binary, 0o755);
    const env = { ...process.env, HOME: home, OPEN_PLUGIN_HOME: home, OPEN_PLUGIN_DCODE_ROOT: native, OPEN_PLUGIN_DCODE_BIN: binary };
    const cli = (...args: string[]) => {
      const outputFlag = args[0] === 'list' ? '--json' : '--legacy-json';
      const result = spawnSync(process.execPath, [join(repoRoot, 'bin/plgnz.mjs'), ...args, outputFlag], { cwd: empty, env, encoding: 'utf8' });
      return { code: result.status, data: JSON.parse(result.stdout) as any, stderr: result.stderr };
    };
    const addResult = spawnSync(process.execPath, [join(repoRoot, 'bin/plgnz.mjs'), 'add', source, '--target', 'dcode', '--json'], { cwd: empty, env, encoding: 'utf8' });
    const added = parseLifecycleReport(JSON.parse(addResult.stdout));
    expect(addResult.status).toBe(0);
    const nativeId = added.outcomes[0]?.nativeId as string;
    expect(nativeId).toBe('release-smoke@local');
    const ledger = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as { installs: Array<{ id: string }> };
    expect({
      planned: added.plan[0]?.nativeId,
      reported: added.outcomes[0]?.nativeId,
      recorded: ledger.installs[0]?.id,
      nativeRecorded: Object.hasOwn(JSON.parse(readFileSync(registry, 'utf8')).plugins, nativeId),
    }).toEqual({
      planned: nativeId,
      reported: nativeId,
      recorded: nativeId,
      nativeRecorded: true,
    });
    const listed = cli('list', '--target', 'dcode');
    expect(listed.code).toBe(0);
    expect(listed.data[0]?.plugins.some((plugin: { id: string }) => plugin.id === nativeId)).toBe(true);
    const recorded = JSON.parse(readFileSync(registry, 'utf8')) as { plugins: Record<string, Array<{ installPath: string; version: string }>> };
    const installedPath = recorded.plugins[nativeId]?.[0]?.installPath;
    expect(recorded.plugins[nativeId]?.[0]?.version).toBe('0.1.0');
    expect(installedPath?.startsWith(join(native, 'plugins/cache/plgnz/'))).toBe(true);
    const removed = cli('remove', nativeId, '--target', 'dcode');
    expect(removed.code).toBe(0);
    expect(removed.data[0]?.status).toBe('installed');
    expect(existsSync(installedPath!)).toBe(false);
    expect(JSON.parse(readFileSync(registry, 'utf8')).plugins).toEqual({ 'foreign@local': [{ installPath: foreign, version: 'local' }] });
    expect(JSON.parse(readFileSync(enablement, 'utf8')).enabledPlugins).toEqual({ 'foreign@local': true });
    expect(readFileSync(join(foreign, 'sentinel.txt'), 'utf8')).toBe('keep\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public hashed-path adoption migrates one matching row and leaves a sibling untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-dcode-public-hashed-'));
  const home = join(root, 'home');
  const native = join(home, '.deepagents');
  const source = join(root, 'plugin');
  const empty = join(root, 'empty');
  const hashed = join(native, 'plugins/cache/local-a1b2/release-smoke-c3d4/0-1-0-e5f6');
  const sibling = join(native, 'plugins/cache/local-a1b2/other-d4e5/0-1-0-f6a7');
  try {
    mkdirSync(empty);
    mkdirSync(join(native, '.state'), { recursive: true });
    writeFiles(source, {
      'plugin.json': '{"name":"release-smoke","version":"0.1.0"}\n',
      'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: fixture\n---\nbody\n',
    });
    writeFiles(hashed, {
      'plugin.json': '{"name":"release-smoke","version":"0.1.0"}\n',
      'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: fixture\n---\nbody\n',
    });
    writeFiles(sibling, { 'plugin.json': '{"name":"other","version":"0.1.0"}\n', 'sentinel.txt': 'keep\n' });
    const registry = join(native, '.state', 'installed_plugins.json');
    const enablement = join(native, '.state', 'plugin_state.json');
    const seeded = {
      version: 2,
      plugins: {
        'release-smoke@local': [{ installPath: hashed, version: '0.1.0' }],
        'other@local': [{ installPath: sibling, version: '0.1.0' }],
      },
    };
    writeFileSync(registry, JSON.stringify(seeded));
    writeFileSync(enablement, JSON.stringify({ version: 1, enabledPlugins: { 'release-smoke@local': true, 'other@local': true } }));
    const binary = join(root, 'dcode');
    writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' 'deepagents-code 0.1.83' 'deepagents (SDK) 0.7.23'; exit 0; fi\nexit 91\n`);
    chmodSync(binary, 0o755);
    const env = { ...process.env, HOME: home, OPEN_PLUGIN_HOME: home, OPEN_PLUGIN_DCODE_ROOT: native, OPEN_PLUGIN_DCODE_BIN: binary };
    const run = (args: string[]) => spawnSync(process.execPath, [join(repoRoot, 'bin/plgnz.mjs'), ...args], { cwd: empty, env, encoding: 'utf8' });
    const refused = run(['add', source, '--target', 'dcode', '--json']);
    expect(refused.status).toBe(1);
    expect(readFileSync(registry, 'utf8')).toBe(JSON.stringify(seeded));
    expect(readFileSync(join(hashed, 'skills/ordinary/SKILL.md'), 'utf8')).toContain('body');
    const adopted = run(['add', source, '--target', 'dcode', '--adopt-existing', '--json']);
    expect(adopted.status).toBe(0);
    const recorded = JSON.parse(readFileSync(registry, 'utf8')) as { plugins: Record<string, Array<{ installPath: string; version: string }>> };
    const row = recorded.plugins['release-smoke@local']?.[0];
    expect(row?.version).toBe('0.1.0');
    expect(row?.installPath.startsWith(join(native, 'plugins/cache/plgnz/'))).toBe(true);
    expect(existsSync(hashed)).toBe(false);
    expect(recorded.plugins['other@local']).toEqual([{ installPath: sibling, version: '0.1.0' }]);
    expect(readFileSync(join(sibling, 'sentinel.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(source, 'plugin.json'), 'utf8')).toBe('{"name":"release-smoke","version":"0.1.0"}\n');
    const marker = JSON.parse(readFileSync(join(row!.installPath, '.plgnz-install.json'), 'utf8')) as { sourceRevision: string };
    expect(marker.sourceRevision).toBe('local');
    expect(JSON.parse(readFileSync(enablement, 'utf8')).enabledPlugins['other@local']).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
