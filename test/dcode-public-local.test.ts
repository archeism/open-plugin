import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const env = { ...process.env, HOME: home, OPEN_PLUGIN_HOME: home, OPEN_PLUGIN_DCODE_ROOT: native };
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
    const removed = cli('remove', nativeId, '--target', 'dcode');
    expect(removed.code).toBe(0);
    expect(removed.data[0]?.status).toBe('installed');
    expect(existsSync(join(native, 'plugins/cache/local/release-smoke/local'))).toBe(false);
    expect(JSON.parse(readFileSync(registry, 'utf8')).plugins).toEqual({ 'foreign@local': [{ installPath: foreign, version: 'local' }] });
    expect(JSON.parse(readFileSync(enablement, 'utf8')).enabledPlugins).toEqual({ 'foreign@local': true });
    expect(readFileSync(join(foreign, 'sentinel.txt'), 'utf8')).toBe('keep\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
