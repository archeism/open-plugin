import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { omp } from '../src/hosts/omp';
import { ompWriter } from '../src/hosts/omp-writer';
import type { PluginSource, ResolvedSource } from '../src/source';
import { writeFiles } from './util';

const slug = '706572736f6e616c-64656d6f2d706c7567696e';
const packageName = `@plgnz/${slug}`;
const owned = (root: string): string => join(root, '.omp', 'plugins', 'plgnz', slug);
const link = (root: string): string => join(root, '.omp', 'plugins', 'node_modules', packageName);

function fixture(files: Record<string, string> = {}): { plugin: PluginSource; resolved: ResolvedSource } {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-omp-source-'));
  const dir = join(root, 'plugins', 'demo-plugin');
  writeFiles(dir, {
    'plugin.json': '{"name":"demo-plugin","version":"1.2.0"}',
    'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\n"disable-model-invocation": false\nuser-invocable: true\nargument-hint: >-\n  optional words\n---\nordinary body\n',
    'skills/manual/SKILL.md': '---\nname: manual\ndescription: manual command\ndisable-model-invocation: true\nargument-hint: words\n---\nmanual $ARGUMENTS from resources/value.txt\n',
    'skills/sidecar/SKILL.md': '---\nname: sidecar\ndescription: sidecar manual command\n---\nsidecar body\n',
    'skills/sidecar/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
    '.claude/commands/run.md': '---\ndescription: run command\nargument-hint: target\n---\nrun $1 / $ARGUMENTS then /run using ../../resources/value.txt\n',
    'resources/value.txt': 'one\n',
    ...files,
  });
  const plugin: PluginSource = { dir, name: 'demo-plugin', marketplace: 'personal', version: '1.2.0', contentFingerprint: 'one' };
  return { plugin, resolved: { sourceUri: root, sha: 'source-sha', isGit: false, plugins: [plugin] } };
}

async function isolated(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(process.env['OPEN_PLUGIN_TEST_OMP_HOME_PARENT'] ?? tmpdir(), 'plgnz-omp-home-'));
  const old = process.env['OPEN_PLUGIN_OMP_ROOT'];
  process.env['OPEN_PLUGIN_OMP_ROOT'] = join(root, '.omp');
  try { await run(root); }
  finally {
    if (old === undefined) delete process.env['OPEN_PLUGIN_OMP_ROOT']; else process.env['OPEN_PLUGIN_OMP_ROOT'] = old;
    rmSync(root, { recursive: true, force: true });
  }
}
async function failure(run: () => Promise<unknown>): Promise<Error> { try { await run(); } catch (error) { return error as Error; } throw new Error('expected failure'); }

describe('OMP native extension-package lifecycle', () => {
  test('installs and updates without using the system temporary directory and cleans destination staging', async () => isolated(async root => {
    const incoming = fixture(); const previous = process.env['TMPDIR'];
    const unavailable = join(root, 'unavailable-system-temp'); process.env['TMPDIR'] = unavailable;
    try {
      await ompWriter.add(incoming.plugin, incoming.resolved);
      writeFileSync(join(incoming.plugin.dir, 'resources/value.txt'), 'two\n'); incoming.plugin.contentFingerprint = 'two';
      await ompWriter.add(incoming.plugin, incoming.resolved);
      expect(readFileSync(join(owned(root), 'resources/value.txt'), 'utf8')).toBe('two\n');
      expect(await ompWriter.add(incoming.plugin, incoming.resolved)).toBe('unchanged');
      expect(readdirSync(dirname(owned(root)))).toEqual([slug]);
      expect(existsSync(unavailable)).toBe(false);
      expect(process.env['TMPDIR']).toBe(unavailable);
    } finally { if (previous === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = previous; }
  }));

  test('a successful dry-run leaves an absent native store absent', async () => isolated(async root => {
    const incoming = fixture();
    expect(await ompWriter.add(incoming.plugin, incoming.resolved, { dryRun: true })).toBeUndefined();
    expect(existsSync(join(root, '.omp'))).toBe(false);
  }));

  test('refuses staging through a symlinked managed store without modifying its contents', async () => isolated(async root => {
    const incoming = fixture(); const foreign = join(root, 'foreign');
    writeFiles(foreign, { 'keep.txt': 'keep\n' }); mkdirSync(join(root, '.omp/plugins'), { recursive: true });
    symlinkSync(foreign, dirname(owned(root)), 'dir');
    expect((await failure(() => ompWriter.add(incoming.plugin, incoming.resolved))).message).toContain('managed path is unsafe');
    expect(readdirSync(foreign)).toEqual(['keep.txt']);
    expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('keep\n');
  }));

  test('projects ordinary skills, commands, and manual-only skills into one native package', async () => isolated(async root => {
    const incoming = fixture();
    writeFiles(join(root, '.omp'), { 'marketplaces.json': '{"marketplaces":[{"name":"user"}]}' });
    await ompWriter.add(incoming.plugin, incoming.resolved);
    const target = owned(root);
    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))).toEqual({ name: packageName, version: '1.2.0', omp: {} });
    expect(readFileSync(join(target, 'skills/ordinary/SKILL.md'), 'utf8')).toContain('ordinary body');
    expect(readFileSync(join(target, 'skills/ordinary/SKILL.md'), 'utf8').includes('disable-model-invocation')).toBe(false);
    expect(existsSync(join(target, 'skills/manual'))).toBe(false);
    expect(existsSync(join(target, 'skills/sidecar'))).toBe(false);
    expect(readFileSync(join(target, '.plgnz/source/skills/manual/SKILL.md'), 'utf8')).toContain('manual $ARGUMENTS');
    expect(readFileSync(join(target, 'commands/demo-plugin:manual.md'), 'utf8')).toContain(join(target, '.plgnz/source/skills/manual'));
    expect(readFileSync(join(target, 'commands/demo-plugin:sidecar.md'), 'utf8')).toContain('sidecar body');
    expect(readFileSync(join(target, 'commands/demo-plugin:run.md'), 'utf8')).toContain('/demo-plugin:run');
    expect(readFileSync(join(target, 'commands/demo-plugin:run.md'), 'utf8')).toContain(join(target, '.plgnz/source/.claude/commands'));
    expect(lstatSync(link(root)).isSymbolicLink()).toBe(true);
    expect(resolve(dirname(link(root)), readlinkSync(link(root)))).toBe(target);
    expect(JSON.parse(readFileSync(join(root, '.omp/plugins/omp-plugins.lock.json'), 'utf8')).plugins[packageName].enabled).toBe(true);
    expect(readFileSync(join(root, '.omp/marketplaces.json'), 'utf8')).toContain('user');
    expect(omp.listInstalled().some(plugin => plugin.id === 'demo-plugin@personal' && plugin.path === target && plugin.version === '1.2.0')).toBe(true);
  }));

  test('re-adds unchanged, refreshes same-version bytes, and preserves the active copy after a failed projection', async () => isolated(async root => {
    const incoming = fixture();
    await ompWriter.add(incoming.plugin, incoming.resolved);
    expect(await ompWriter.add(incoming.plugin, incoming.resolved)).toBe('unchanged');
    writeFileSync(join(incoming.plugin.dir, 'resources/value.txt'), 'two\n'); incoming.plugin.contentFingerprint = 'two';
    await ompWriter.add(incoming.plugin, incoming.resolved);
    expect(readFileSync(join(owned(root), 'resources/value.txt'), 'utf8')).toBe('two\n');
    writeFileSync(join(incoming.plugin.dir, '.claude/commands/run.md'), '---\ndescription: unsafe\nuser-invocable: false\n---\nunsafe\n'); incoming.plugin.contentFingerprint = 'unsafe';
    expect((await failure(() => ompWriter.add(incoming.plugin, incoming.resolved))).message).toContain('user-invocable: false');
    expect(readFileSync(join(owned(root), 'resources/value.txt'), 'utf8')).toBe('two\n');
    expect(readFileSync(join(owned(root), 'commands/demo-plugin:run.md'), 'utf8')).toContain('run $1');
    expect(readdirSync(dirname(owned(root)))).toEqual([slug]);
  }));

  test('rolls back the old directory and link when activation fails after moving the directory aside', async () => isolated(async root => {
    const incoming = fixture(); await ompWriter.add(incoming.plugin, incoming.resolved);
    writeFileSync(join(incoming.plugin.dir, 'resources/value.txt'), 'two\n'); incoming.plugin.contentFingerprint = 'two';
    process.env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE'] = 'after-old-move';
    try { expect((await failure(() => ompWriter.add(incoming.plugin, incoming.resolved))).message).toContain('forced OMP activation failure'); }
    finally { delete process.env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE']; }
    expect(readFileSync(join(owned(root), 'resources/value.txt'), 'utf8')).toBe('one\n');
    expect(resolve(dirname(link(root)), readlinkSync(link(root)))).toBe(owned(root));
    expect(readdirSync(dirname(owned(root)))).toEqual([slug]);
  }));

  test('migrates a selected legacy marketplace row only with adoption and removes legacy bytes after activation', async () => isolated(async root => {
    const incoming = fixture();
    const legacy = join(root, '.omp/plugins/cache/plugins/personal___demo-plugin___1.2.0');
    writeFiles(legacy, { 'plugin.json': '{"name":"demo-plugin","version":"1.2.0"}', 'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\n---\nlocally edited legacy bytes\n' });
    writeFiles(join(root, '.omp/plugins'), {
      'installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'demo-plugin@personal': [{ scope: 'user', installPath: legacy, version: '1.2.0' }] } }),
      'omp-plugins.lock.json': JSON.stringify({ plugins: { 'demo-plugin': { version: '1.2.0', enabled: true } }, settings: {} }),
    });
    mkdirSync(join(root, '.omp/plugins/node_modules'), { recursive: true });
    const legacyLink = join(root, '.omp/plugins/node_modules/demo-plugin'); symlinkSync(legacy, legacyLink);
    expect((await failure(() => ompWriter.add(incoming.plugin, incoming.resolved))).message).toContain('--adopt-existing');
    await ompWriter.add(incoming.plugin, incoming.resolved, { adoptExisting: true });
    expect(existsSync(legacy)).toBe(false); expect(existsSync(legacyLink)).toBe(false);
    expect(readFileSync(join(owned(root), 'skills/ordinary/SKILL.md'), 'utf8')).toContain('ordinary body');
    const registry = JSON.parse(readFileSync(join(root, '.omp/plugins/installed_plugins.json'), 'utf8'));
    expect(registry.plugins['demo-plugin@personal']).toBeUndefined();
    const lock = JSON.parse(readFileSync(join(root, '.omp/plugins/omp-plugins.lock.json'), 'utf8'));
    expect(lock.plugins['demo-plugin']).toBeUndefined(); expect(lock.plugins[packageName].enabled).toBe(true);
  }));

  test('removes only the marked package and refuses a redirected native link', async () => isolated(async root => {
    const incoming = fixture(); await ompWriter.add(incoming.plugin, incoming.resolved);
    const foreign = join(root, 'foreign'); writeFiles(foreign, { 'keep.txt': 'keep\n' });
    rmSync(link(root)); symlinkSync(foreign, link(root));
    expect((await failure(() => ompWriter.remove('demo-plugin@personal'))).message).toContain('redirected');
    expect(existsSync(owned(root))).toBe(true);
    rmSync(link(root)); symlinkSync(owned(root), link(root));
    await ompWriter.remove('demo-plugin@personal');
    expect(existsSync(owned(root))).toBe(false); expect(existsSync(link(root))).toBe(false); expect(existsSync(foreign)).toBe(true);
    const lock = JSON.parse(readFileSync(join(root, '.omp/plugins/omp-plugins.lock.json'), 'utf8')) as { plugins: Record<string, { enabled: boolean }> };
    expect(lock.plugins[packageName]?.enabled).toBe(true);
  }));

  test('re-add keeps feature selection and settings while enabling the package', async () => isolated(async root => {
    const incoming = fixture();
    await ompWriter.add(incoming.plugin, incoming.resolved);
    const lockFile = join(root, '.omp/plugins/omp-plugins.lock.json');
    const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as { plugins: Record<string, Record<string, unknown>>; settings: unknown };
    lock.plugins[packageName] = { ...lock.plugins[packageName], enabled: false, enabledFeatures: ['skills'], settings: { theme: 'quiet' } };
    lock.settings = { telemetry: false };
    writeFileSync(lockFile, JSON.stringify(lock));
    await ompWriter.add(incoming.plugin, incoming.resolved);
    const next = JSON.parse(readFileSync(lockFile, 'utf8')) as { plugins: Record<string, { enabled: boolean; enabledFeatures: string[]; settings: { theme: string } }>; settings: { telemetry: boolean } };
    expect(next.plugins[packageName]?.enabled).toBe(true);
    expect(next.plugins[packageName]?.enabledFeatures).toEqual(['skills']);
    expect(next.plugins[packageName]?.settings).toEqual({ theme: 'quiet' });
    expect(next.settings).toEqual({ telemetry: false });
    expect(readFileSync(join(owned(root), 'resources/value.txt'), 'utf8')).toBe('one\n');
  }));

  test('dry-run refuses unsupported invocation gates without creating the OMP store', async () => isolated(async root => {
    const incoming = fixture({ 'skills/private/SKILL.md': '---\nname: private\ndescription: private\nuser-invocable: false\n---\nprivate\n' });
    expect((await failure(() => ompWriter.add(incoming.plugin, incoming.resolved, { dryRun: true }))).message).toContain('user-invocable: false');
    expect(existsSync(join(root, '.omp/plugins'))).toBe(false);
  }));

  test('refuses arbitrary legacy paths and an unowned managed target without deleting either', async () => isolated(async root => {
    const incoming = fixture(); const outside = join(root, 'outside'); writeFiles(outside, { 'plugin.json': '{"name":"demo-plugin","version":"1.2.0"}', 'keep.txt': 'keep\n' });
    writeFiles(join(root, '.omp/plugins'), { 'installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'demo-plugin@personal': [{ scope: 'user', installPath: outside, version: '1.2.0' }] } }) });
    expect((await failure(() => ompWriter.add(incoming.plugin, incoming.resolved, { adoptExisting: true }))).message).toContain('approved cache slot');
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
    rmSync(join(root, '.omp/plugins/installed_plugins.json'));
    writeFiles(owned(root), { 'foreign.txt': 'keep\n' });
    expect((await failure(() => ompWriter.add(incoming.plugin, incoming.resolved))).message).toContain('unowned');
    expect(readFileSync(join(owned(root), 'foreign.txt'), 'utf8')).toBe('keep\n');
  }));
});
