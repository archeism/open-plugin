import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cursor } from '../src/hosts/cursor';
import { cursorWriter } from '../src/hosts/cursor-writer';
import type { PluginSource, ResolvedSource } from '../src/source';
import { writeFiles } from './util';

function fixture(files: Record<string, string> = {}): { plugin: PluginSource; resolved: ResolvedSource } {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-cursor-source-'));
  const dir = join(root, 'plugins', 'demo-plugin');
  writeFiles(dir, {
    'plugin.json': '{"name":"demo-plugin","version":"1.2.0"}',
    '.cursor-plugin/plugin.json': '{"name":"demo-plugin","version":"1.2.0","native":"keep"}',
    'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary skill\n---\nordinary body\n',
    'skills/manual/SKILL.md': '---\nname: manual\ndescription: manual skill\ndisable-model-invocation: true\n---\nmanual body\n',
    'resources/value.txt': 'one\n',
    ...files,
  });
  const plugin: PluginSource = { dir, name: 'demo-plugin', contentFingerprint: 'source-one' };
  return { plugin, resolved: { sourceUri: root, sha: 'local', isGit: false, plugins: [plugin] } };
}

async function isolated(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-cursor-home-'));
  const previous = process.env['OPEN_PLUGIN_CURSOR_ROOT'];
  process.env['OPEN_PLUGIN_CURSOR_ROOT'] = join(root, '.cursor');
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env['OPEN_PLUGIN_CURSOR_ROOT']; else process.env['OPEN_PLUGIN_CURSOR_ROOT'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try { await run(); } catch (error) { return error as Error; }
  throw new Error('expected operation to fail');
}

function stageDirectories(root: string): string[] {
  const local = join(root, '.cursor/plugins/local');
  return existsSync(local) ? readdirSync(local).filter(name => name.startsWith('.plgnz-cursor-stage-')) : [];
}

describe('cursor local-plugin lifecycle', () => {
  test('installs a native local copy, preserves Cursor-only policy bytes, and reads it back from a fresh isolated store', async () => {
    await isolated(async root => {
      const incoming = fixture();
      writeFiles(join(root, '.cursor'), { 'mcp.json': '{"mcpServers":{"user":{"url":"https://keep.example"}}}' });
      await cursorWriter.add(incoming.plugin, incoming.resolved);
      const target = join(root, '.cursor/plugins/local/demo-plugin');
      expect(readFileSync(join(target, 'skills/manual/SKILL.md'), 'utf8')).toBe(readFileSync(join(incoming.plugin.dir, 'skills/manual/SKILL.md'), 'utf8'));
      expect(readFileSync(join(target, '.cursor-plugin/plugin.json'), 'utf8')).toBe(readFileSync(join(incoming.plugin.dir, '.cursor-plugin/plugin.json'), 'utf8'));
      expect(readFileSync(join(root, '.cursor/mcp.json'), 'utf8')).toBe('{"mcpServers":{"user":{"url":"https://keep.example"}}}');
      const installed = cursor.listInstalled();
      expect(installed).toHaveLength(1);
      expect(installed[0]?.id).toBe('demo-plugin');
      expect(installed[0]?.version).toBe('1.2.0');
      expect(installed[0]?.path).toBe(target);
    });
  });

  test('is unchanged on the same source bytes and refreshes a same-version byte change', async () => {
    await isolated(async root => {
      const incoming = fixture();
      await cursorWriter.add(incoming.plugin, incoming.resolved);
      expect(await cursorWriter.add(incoming.plugin, incoming.resolved)).toBe('unchanged');
      expect(await cursorWriter.add(incoming.plugin, incoming.resolved)).toBe('unchanged');
      expect(stageDirectories(root)).toEqual([]);
      writeFileSync(join(incoming.plugin.dir, 'resources/value.txt'), 'two\n');
      incoming.plugin.contentFingerprint = 'source-two';
      await cursorWriter.add(incoming.plugin, incoming.resolved);
      expect(readFileSync(join(root, '.cursor/plugins/local/demo-plugin/resources/value.txt'), 'utf8')).toBe('two\n');
    });
  });

  test('dry runs leave no Cursor staging directory behind', async () => {
    await isolated(async root => {
      const incoming = fixture();
      await cursorWriter.add(incoming.plugin, incoming.resolved);
      await cursorWriter.add(incoming.plugin, incoming.resolved, { dryRun: true });
      await cursorWriter.add(incoming.plugin, incoming.resolved, { dryRun: true });
      expect(stageDirectories(root)).toEqual([]);
    });
  });

  test('refuses a stale native manifest before replacing an active owned copy', async () => {
    await isolated(async root => {
      const incoming = fixture();
      await cursorWriter.add(incoming.plugin, incoming.resolved);
      writeFileSync(join(incoming.plugin.dir, '.cursor-plugin/plugin.json'), '{"name":"demo-plugin","version":"0.9.0"}');
      incoming.plugin.contentFingerprint = 'stale-native-manifest';
      expect((await failure(() => cursorWriter.add(incoming.plugin, incoming.resolved))).message).toContain('native manifest identity');
      expect(readFileSync(join(root, '.cursor/plugins/local/demo-plugin/resources/value.txt'), 'utf8')).toBe('one\n');
    });
  });

  test('projects command sources into the skills tree, preserving an active owned copy until success', async () => {
    await isolated(async root => {
      const incoming = fixture();
      await cursorWriter.add(incoming.plugin, incoming.resolved);
      writeFiles(incoming.plugin.dir, { '.claude/commands/launch.md': '---\ndescription: launch\n---\nbody\n' });
      incoming.plugin.contentFingerprint = 'commands-present';
      await cursorWriter.add(incoming.plugin, incoming.resolved);
      const target = join(root, '.cursor/plugins/local/demo-plugin');
      expect(readFileSync(join(target, 'resources/value.txt'), 'utf8')).toBe('one\n');
      expect(readFileSync(join(target, 'skills/launch/SKILL.md'), 'utf8')).toBe('---\nname: "launch"\ndescription: "launch"\n---\nbody\n');
      expect(existsSync(join(target, '.claude', 'commands'))).toBe(false);
    });
  });

  test('projects TOML prompt commands into skills and refuses unrepresentable policy', async () => {
    await isolated(async root => {
      const incoming = fixture();
      writeFiles(incoming.plugin.dir, { 'commands/ship.toml': 'description = "Launch review"\nprompt = """Fan out."""\n' });
      incoming.plugin.contentFingerprint = 'toml-command';
      await cursorWriter.add(incoming.plugin, incoming.resolved);
      const target = join(root, '.cursor/plugins/local/demo-plugin');
      expect(readFileSync(join(target, 'skills/ship/SKILL.md'), 'utf8')).toBe('---\nname: "ship"\ndescription: "Launch review"\n---\nFan out.\n');
      expect(existsSync(join(target, 'commands'))).toBe(false);

      writeFiles(incoming.plugin.dir, { 'commands/locked.toml': 'description = "Locked"\nuser-invocable = false\nprompt = "body"\n' });
      incoming.plugin.contentFingerprint = 'locked-command';
      expect((await failure(() => cursorWriter.add(incoming.plugin, incoming.resolved))).message).toContain('user-invocable: false');
      expect(readFileSync(join(target, 'skills/ship/SKILL.md'), 'utf8')).toContain('Fan out.');
    });
  });

  test('removes only marker-owned local copies and refuses a foreign replacement without adoption', async () => {
    await isolated(async root => {
      const incoming = fixture();
      const target = join(root, '.cursor/plugins/local/demo-plugin');
      writeFiles(target, { '.cursor-plugin/plugin.json': '{"name":"demo-plugin","version":"1.2.0"}', 'foreign.txt': 'keep\n' });
      expect((await failure(() => cursorWriter.add(incoming.plugin, incoming.resolved))).message).toContain('unowned');
      expect(readFileSync(join(target, 'foreign.txt'), 'utf8')).toBe('keep\n');
      await cursorWriter.add(incoming.plugin, incoming.resolved, { adoptExisting: true });
      expect(readFileSync(join(target, 'resources/value.txt'), 'utf8')).toBe('one\n');
      expect(existsSync(join(target, '.plgnz-install.json'))).toBe(true);
      writeFiles(join(root, '.cursor/plugins/local/foreign-plugin'), { '.cursor-plugin/plugin.json': '{"name":"foreign-plugin","version":"1.0.0"}' });
      await cursorWriter.remove('demo-plugin');
      expect(existsSync(target)).toBe(false);
      expect(existsSync(join(root, '.cursor/plugins/local/foreign-plugin'))).toBe(true);
    });
  });
});
