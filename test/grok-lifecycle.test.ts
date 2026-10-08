import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grok } from '../src/hosts/grok';
import { grokWriter } from '../src/hosts/grok-writer';
import { resolveSource, type PluginSource, type ResolvedSource } from '../src/source';
import { main } from '../src/cli';
import { writeFiles } from './util';

type Fixture = { root: string; home: string; source: string; plugin: PluginSource; resolved: ResolvedSource };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-grok-lifecycle-'));
  const source = join(root, 'source');
  writeFiles(source, {
    '.claude-plugin/marketplace.json': '{"name":"catalog","plugins":[{"name":"demo","source":"./plugins/demo"}]}',
    'plugins/demo/plugin.json': '{"name":"demo","version":"1.0.0","description":"Demo"}',
    'plugins/demo/skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\n---\n\nfirst\n',
    'plugins/demo/resources/value.txt': 'one\n',
  });
  const resolved = resolveSource(source);
  const plugin = resolved.plugins[0]!;
  return { root, home: join(root, 'home'), source, plugin, resolved };
}

function writeFakeGrok(root: string): string {
  const program = join(root, 'fake-grok.mjs');
  const binary = join(root, 'fake-grok');
  writeFileSync(program, String.raw`
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = join(process.env.HOME, '.grok');
const state = join(home, 'fake-marketplaces.json');
const registry = join(home, 'installed-plugins', 'registry.json');
const read = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const write = (path, value) => { mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const markets = () => read(state, []);
const registryValue = () => read(registry, { version: 1, repos: {} });
const saveRegistry = value => write(registry, value);
const args = process.argv.slice(2);
if (args[0] === 'plugin' && args[1] === 'validate') process.exit(0);
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list') { console.log(JSON.stringify(markets())); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') { const root = args[3]; write(state, [...markets(), { name: root.split('/').at(-1), kind: 'local', source: { path: root } }]); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') { const root = args[3]; write(state, markets().filter(row => row.source.path !== root)); const value = registryValue(); for (const [key, repo] of Object.entries(value.repos)) if (repo.marketplace.source_url_or_path === root) delete value.repos[key]; saveRegistry(value); process.exit(0); }
const install = name => { const row = markets().find(item => item.name === args[2].split('@local/')[1]); if (!row) process.exit(2); const source = join(row.source.path, 'plugins', name); if (!existsSync(source)) process.exit(3); const target = join(home, 'installed-plugins', name + '-native'); rmSync(target, { recursive: true, force: true }); cpSync(source, target, { recursive: true }); const value = registryValue(); value.repos[name] = { path: target, plugins: { [name]: {} }, kind: { type: 'Local', source_path: source }, marketplace: { source_url_or_path: row.source.path, source_display_name: row.name, plugin_subdir: 'plugins/' + name } }; saveRegistry(value); };
if (args[0] === 'plugin' && args[1] === 'install') { install(args[2].split('@')[0]); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'update') { if (process.env.GROK_FAKE_NOOP_UPDATE === '1') process.exit(0); const value = registryValue(); const repo = value.repos[args[2]]; if (!repo || !existsSync(repo.kind.source_path)) process.exit(4); rmSync(repo.path, { recursive: true, force: true }); cpSync(repo.kind.source_path, repo.path, { recursive: true }); saveRegistry(value); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'enable') process.exit(0);
if (args[0] === 'inspect' && args[1] === '--json') { const value = registryValue(); console.log(JSON.stringify({ plugins: Object.entries(value.repos).map(([name, repo]) => ({ name, path: repo.path, enabled: true })) })); process.exit(0); }
process.exit(9);
`);
  writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`);
  chmodSync(binary, 0o755);
  return binary;
}

async function isolated(run: (value: Fixture) => Promise<void>): Promise<void> {
  const value = fixture(); const previous = { OPEN_PLUGIN_HOME: process.env.OPEN_PLUGIN_HOME, OPEN_PLUGIN_GROK_ROOT: process.env.OPEN_PLUGIN_GROK_ROOT, OPEN_PLUGIN_GROK_BIN: process.env.OPEN_PLUGIN_GROK_BIN };
  process.env.OPEN_PLUGIN_HOME = value.home; process.env.OPEN_PLUGIN_GROK_ROOT = join(value.home, '.grok'); process.env.OPEN_PLUGIN_GROK_BIN = writeFakeGrok(value.root);
  try { await run(value); }
  finally { for (const [key, prior] of Object.entries(previous)) { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; } rmSync(value.root, { recursive: true, force: true }); }
}

async function failure(run: () => Promise<unknown>): Promise<Error> { try { await run(); } catch (error) { return error as Error; } throw new Error('expected operation to fail'); }

describe('Grok Build native marketplace lifecycle', () => {
  test('accepts equivalent MCP servers despite schema metadata and key order, but rejects actual conflicts', async () => {
    await isolated(async ({ plugin, resolved }) => {
      writeFiles(plugin.dir, {
        'mcp.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { vercel: { type: 'http', url: 'https://mcp.vercel.com' } } }),
        '.mcp.json': JSON.stringify({ mcpServers: { vercel: { url: 'https://mcp.vercel.com', type: 'http' } } }),
      });
      await grokWriter.add(plugin, resolved);
      expect(await grokWriter.add(plugin, resolved)).toBe('unchanged');
      writeFiles(plugin.dir, { 'mcp.json': JSON.stringify({ mcpServers: { vercel: { type: 'http', url: 'https://different.invalid' } } }) });
      expect((await failure(() => grokWriter.add(plugin, resolved))).message).toContain('conflicting Grok MCP');
      writeFiles(plugin.dir, {
        'mcp.json': JSON.stringify({ mcpServers: { demo: { command: 'test', env: {} } } }),
        '.mcp.json': JSON.stringify({ mcpServers: { demo: { command: 'test', env: [] } } }),
      });
      expect((await failure(() => grokWriter.add(plugin, resolved))).message).toContain('conflicting Grok MCP');
    });
  });
  test('prefers root commands over alternate Claude commands without changing source', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      const claude = '---\ndescription: Claude spec\n---\nClaude-specific body\n';
      writeFiles(plugin.dir, {
        'commands/spec.toml': 'description = "Spec"\nprompt = "Root spec body"\n',
        '.claude/commands/spec.md': claude,
      });
      await grokWriter.add(plugin, resolved);
      const active = join(home, '.grok', 'installed-plugins', 'demo-native');
      expect(readFileSync(join(active, 'commands/spec.md'), 'utf8')).toContain('Root spec body');
      expect(readFileSync(join(plugin.dir, '.claude/commands/spec.md'), 'utf8')).toBe(claude);
      expect(existsSync(join(plugin.dir, 'commands/spec.md'))).toBe(false);
      expect(await grokWriter.add(plugin, resolved)).toBe('unchanged');
    });
  });

  test('retains Claude command fallback when root commands are absent', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      writeFiles(plugin.dir, { '.claude/commands/spec.md': '---\ndescription: Spec\n---\nFallback body\n' });
      await grokWriter.add(plugin, resolved);
      expect(readFileSync(join(home, '.grok', 'installed-plugins', 'demo-native', 'commands/spec.md'), 'utf8')).toContain('Fallback body');
    });
  });

  test('uses registry provenance to retain source identity, refreshes changed bytes, and removes only its owned marketplace', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      await grokWriter.add(plugin, resolved);
      const active = join(home, '.grok', 'installed-plugins', 'demo-native');
      expect(grok.listInstalled().map(value => value.id)).toEqual(['demo@catalog']);
      expect(readlinkSync(join(home, '.grok', 'plugins', 'demo'))).toBe(active);
      expect(readFileSync(join(active, 'resources/value.txt'), 'utf8')).toBe('one\n');
      expect(await grokWriter.add(plugin, resolved)).toBe('unchanged');
      writeFileSync(join(plugin.dir, 'resources/value.txt'), 'two\n'); plugin.contentFingerprint = resolveSource(resolved.sourceUri).plugins[0]!.contentFingerprint;
      await grokWriter.add(plugin, resolved);
      expect(readFileSync(join(active, 'resources/value.txt'), 'utf8')).toBe('two\n');
      await grokWriter.remove('demo@catalog');
      let linkRemains = false;
      try { lstatSync(join(home, '.grok', 'plugins', 'demo')); linkRemains = true; } catch { /* Missing, including no dangling link. */ }
      expect(linkRemains).toBe(false);
      expect(grok.listInstalled()).toEqual([]);
      expect(existsSync(join(home, '.grok', 'plgnz-marketplaces'))).toBe(true);
    });
  });

  test('refuses foreign activation directories and dangling links without changing them', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      const link = join(home, '.grok', 'plugins', 'demo');
      writeFiles(link, { 'keep.txt': 'foreign' });
      expect((await failure(() => grokWriter.add(plugin, resolved))).message).toContain('activation path');
      expect(readFileSync(join(link, 'keep.txt'), 'utf8')).toBe('foreign');
      rmSync(link, { recursive: true });
      symlinkSync('/missing/foreign-plugin', link);
      expect((await failure(() => grokWriter.add(plugin, resolved))).message).toContain('activation path');
      expect(readlinkSync(link)).toBe('/missing/foreign-plugin');
      expect(grok.listInstalled()).toEqual([]);
    });
  });

  test('repairs missing native activation on an otherwise unchanged installation', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      await grokWriter.add(plugin, resolved);
      const link = join(home, '.grok', 'plugins', 'demo');
      rmSync(link);
      expect(await grokWriter.add(plugin, resolved, { dryRun: true })).toBeUndefined();
      expect(existsSync(link)).toBe(false);
      await grokWriter.add(plugin, resolved);
      expect(readlinkSync(link)).toBe(join(home, '.grok', 'installed-plugins', 'demo-native'));
      expect(await grokWriter.add(plugin, resolved)).toBe('unchanged');
    });
  });

  test('refuses removal when the activation link was replaced by a foreign directory', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      await grokWriter.add(plugin, resolved);
      const link = join(home, '.grok', 'plugins', 'demo');
      rmSync(link);
      writeFiles(link, { 'keep.txt': 'foreign' });
      expect((await failure(() => grokWriter.remove('demo@catalog'))).message).toContain('activation path');
      expect(readFileSync(join(link, 'keep.txt'), 'utf8')).toBe('foreign');
      expect(grok.listInstalled()).toHaveLength(1);
    });
  });

  test('keeps the prior native bytes and source marker when update exits zero without applying staged content', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      await grokWriter.add(plugin, resolved);
      const active = join(home, '.grok', 'installed-plugins', 'demo-native');
      const marketplace = JSON.parse(readFileSync(join(home, '.grok', 'fake-marketplaces.json'), 'utf8'))[0].source.path as string;
      const markerBefore = readFileSync(join(marketplace, '.plgnz-install.json'), 'utf8');
      writeFileSync(join(plugin.dir, 'resources/value.txt'), 'stale\n'); plugin.contentFingerprint = resolveSource(resolved.sourceUri).plugins[0]!.contentFingerprint;
      process.env.GROK_FAKE_NOOP_UPDATE = '1';
      try { expect((await failure(() => grokWriter.add(plugin, resolved))).message).toContain('native readback does not match staged content'); }
      finally { delete process.env.GROK_FAKE_NOOP_UPDATE; }
      expect(readFileSync(join(active, 'resources/value.txt'), 'utf8')).toBe('one\n');
      expect(readFileSync(join(marketplace, '.plgnz-install.json'), 'utf8')).toBe(markerBefore);
    });
  });

  test('projects sidecar user-only policy and TOML commands while retaining resources and MCP', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      writeFiles(plugin.dir, {
        'skills/manual/SKILL.md': '---\nname: manual\ndescription: manual\n---\nmanual\n',
        'skills/manual/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
        'commands/run.toml': 'description = "Run"\nprompt = "first=$1 all=$ARGUMENTS"\nargument-hint = "words"\n',
        '.mcp.json': '{"mcpServers":{"probe":{"command":"/usr/bin/true"}}}',
      });
      plugin.contentFingerprint = resolveSource(resolved.sourceUri).plugins[0]!.contentFingerprint;
      await grokWriter.add(plugin, resolved);
      const active = join(home, '.grok', 'installed-plugins', 'demo-native');
      expect(readFileSync(join(active, 'skills/manual/SKILL.md'), 'utf8')).toContain('disable-model-invocation: true');
      expect(readFileSync(join(active, 'skills/manual/agents/openai.yaml'), 'utf8')).toContain('allow_implicit_invocation: false');
      expect(readFileSync(join(active, 'commands/run.md'), 'utf8')).toContain('first=$1 all=$ARGUMENTS');
      expect(readFileSync(join(active, 'resources/value.txt'), 'utf8')).toBe('one\n');
      expect(grok.mcpEntries().map(entry => entry.name)).toEqual(['probe']);
      expect(await grokWriter.add(plugin, resolved)).toBe('unchanged');
    });
  });

  test('refuses a same-name foreign native install before native activation', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      const foreign = join(home, '.grok', 'installed-plugins', 'foreign-demo'); mkdirSync(foreign, { recursive: true }); writeFileSync(join(foreign, 'keep.txt'), 'foreign\n');
      writeFiles(join(home, '.grok'), { 'installed-plugins/registry.json': JSON.stringify({ version: 1, repos: { foreign: { path: foreign, plugins: { demo: {} }, kind: { type: 'Local', source_path: '/foreign/plugins/demo' }, marketplace: { source_url_or_path: '/foreign', source_display_name: 'foreign', plugin_subdir: 'plugins/demo' } } } }) });
      expect((await failure(() => grokWriter.add(plugin, resolved))).message).toContain('not plgnz-owned');
      expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('foreign\n');
    });
  });

  test('refuses an unmarked materialization root and invalid MCP before replacing active bytes', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      await grokWriter.add(plugin, resolved);
      const active = join(home, '.grok', 'installed-plugins', 'demo-native');
      const marketplace = JSON.parse(readFileSync(join(home, '.grok', 'fake-marketplaces.json'), 'utf8'))[0].source.path as string;
      rmSync(join(marketplace, '.plgnz-install.json'));
      expect((await failure(() => grokWriter.add(plugin, resolved))).message).toContain('is unowned');
      expect(readFileSync(join(active, 'resources/value.txt'), 'utf8')).toBe('one\n');
      writeFileSync(join(marketplace, '.plgnz-install.json'), JSON.stringify({ source: resolved.sourceUri, pluginId: 'demo@catalog', fingerprint: plugin.contentFingerprint }));
      writeFiles(plugin.dir, { 'mcp.json': '{"mcpServers":[]}' });
      expect((await failure(() => grokWriter.add(plugin, resolved))).message).toContain('invalid Grok MCP declaration');
      expect(readFileSync(join(active, 'resources/value.txt'), 'utf8')).toBe('one\n');
    });
  });

  test('refuses a symlinked owned root before recursive removal', async () => {
    await isolated(async ({ home, plugin, resolved, root }) => {
      await grokWriter.add(plugin, resolved);
      const marketplace = JSON.parse(readFileSync(join(home, '.grok', 'fake-marketplaces.json'), 'utf8'))[0].source.path as string;
      const outside = join(root, 'outside'); renameSync(marketplace, outside); symlinkSync(outside, marketplace);
      expect((await failure(() => grokWriter.remove('demo@catalog'))).message).toContain('escapes plgnz storage');
      expect(existsSync(join(outside, '.plgnz-install.json'))).toBe(true);
    });
  });

  test('reads native disablement from config and does not let a mismatched marker forge the logical id', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      await grokWriter.add(plugin, resolved);
      const marketplace = JSON.parse(readFileSync(join(home, '.grok', 'fake-marketplaces.json'), 'utf8'))[0].source.path as string;
      writeFileSync(join(home, '.grok', 'config.toml'), '[plugins]\ndisabled = ["demo"]\n');
      writeFileSync(join(marketplace, '.plgnz-install.json'), JSON.stringify({ source: resolved.sourceUri, pluginId: 'other@catalog', fingerprint: plugin.contentFingerprint }));
      const installed = grok.listInstalled();
      expect(installed[0]?.id).toContain('demo@plgnz-');
      expect(installed[0]?.enabled).toBe(false);
      const original = console.log; let output = '';
      console.log = (value: unknown) => { output = String(value); };
      try { expect(await main(['list', '--target', 'grok', '--json'])).toBe(0); } finally { console.log = original; }
      expect(JSON.parse(output)[0].plugins[0].enabled).toBe(false);
    });
  });

  test('refuses a malformed native registry before it can replace an active install', async () => {
    await isolated(async ({ home, plugin, resolved }) => {
      await grokWriter.add(plugin, resolved);
      const active = join(home, '.grok', 'installed-plugins', 'demo-native');
      writeFileSync(join(home, '.grok', 'installed-plugins', 'registry.json'), '{"version":99}');
      writeFileSync(join(plugin.dir, 'resources/value.txt'), 'new\n');
      expect((await failure(() => grokWriter.add(plugin, resolved))).message).toContain('registry is unreadable or unsupported');
      expect(readFileSync(join(active, 'resources/value.txt'), 'utf8')).toBe('one\n');
    });
  });
});
