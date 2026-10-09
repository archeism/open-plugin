import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dcode } from '../src/hosts/dcode';
import { dcodeWriter } from '../src/hosts/dcode-writer';
import { CompatibilityError } from '../src/compatibility';
import { PackageCapabilityError } from '../src/capability-evidence';
import { SemanticInventoryError } from '../src/semantic-inventory';
import type { PluginSource, ResolvedSource } from '../src/source';
import { writeFiles } from './util';

function incoming(body = 'ordinary skill\n'): { plugin: PluginSource; resolved: ResolvedSource } {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-dcode-source-')); const dir = join(root, 'plugins', 'addy');
  writeFiles(dir, { 'plugin.json': '{"name":"addy","version":"0.1.0"}\n', 'skills/a/SKILL.md': `---\nname: a\ndescription: fixture\n---\n${body}` });
  const plugin: PluginSource = { dir, name: 'addy', marketplace: 'personal', contentFingerprint: body };
  return { plugin, resolved: { sourceUri: root, sha: '0.1.0', isGit: false, plugins: [plugin] } };
}
async function isolated(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-dcode-root-')); const old = process.env['OPEN_PLUGIN_DCODE_ROOT'];
  process.env['OPEN_PLUGIN_DCODE_ROOT'] = root;
  try { await fn(root); } finally { if (old === undefined) delete process.env['OPEN_PLUGIN_DCODE_ROOT']; else process.env['OPEN_PLUGIN_DCODE_ROOT'] = old; rmSync(root, { recursive: true, force: true }); }
}
async function failed(run: () => Promise<unknown>): Promise<Error> { try { await run(); } catch (error) { return error as Error; } throw new Error('expected failure'); }
const registry = (root: string) => join(root, '.state', 'installed_plugins.json');
const copy = (root: string) => join(root, 'plugins/cache/personal/addy/0.1.0');

describe('dcode lifecycle', () => {
  test('uses the isolated root and exposes enabled native installs', async () => {
    await isolated(async root => { const item = incoming(); await dcodeWriter.add(item.plugin, item.resolved); expect(dcode.detect()).toBe(true); expect(dcode.listInstalled()[0]?.id).toBe('addy@personal'); expect(dcode.listInstalled()[0]?.enabled).toBe(true); expect(dcode.listInstalled()[0]?.path).toBe(copy(root)); });
  });
  test('same content is unchanged and same-version changed bytes refresh', async () => {
    await isolated(async root => {
      const first = incoming('first\n'); await dcodeWriter.add(first.plugin, first.resolved); expect(await dcodeWriter.add(first.plugin, first.resolved)).toBe('unchanged');
      const changed = incoming('second\n'); changed.resolved.sourceUri = first.resolved.sourceUri; await dcodeWriter.add(changed.plugin, changed.resolved);
      expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toContain('second');
    });
  });
  test('explicit adoption takes over one identity-matched native copy without deleting the prior cache', async () => {
    await isolated(async root => {
      const item = incoming(); item.resolved.sha = 'local';
      writeFiles(copy(root), { 'plugin.json': '{"name":"addy","version":"0.1.0"}\n', 'skills/a/SKILL.md': 'legacy\n' });
      writeFiles(root, {
        '.state/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'addy@personal': [{ installPath: copy(root), version: '0.1.0' }] } }),
        '.state/plugin_state.json': JSON.stringify({ version: 1, enabledPlugins: { 'addy@personal': true } }),
      });
      expect((await failed(() => dcodeWriter.add(item.plugin, item.resolved))).message).toContain('not plgnz-owned');
      await dcodeWriter.add(item.plugin, item.resolved, { dryRun: true, adoptExisting: true });
      expect(dcode.listInstalled()[0]?.path).toBe(copy(root));
      await dcodeWriter.add(item.plugin, item.resolved, { adoptExisting: true });
      expect(dcode.listInstalled()[0]?.path).toBe(join(root, 'plugins/cache/personal/addy/local'));
      expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toBe('legacy\n');
      await dcodeWriter.remove('addy@personal');
      expect(existsSync(copy(root))).toBe(true);
    });
  });
  test('adoption refuses a mismatched legacy manifest and preserves native state', async () => {
    await isolated(async root => {
      const item = incoming(); item.resolved.sha = 'local';
      writeFiles(copy(root), { 'plugin.json': '{"name":"other","version":"0.1.0"}\n' });
      writeFiles(root, { '.state/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'addy@personal': [{ installPath: copy(root), version: '0.1.0' }] } }) });
      const before = readFileSync(registry(root), 'utf8');
      expect((await failed(() => dcodeWriter.add(item.plugin, item.resolved, { adoptExisting: true }))).message).toContain('identity differs');
      expect(readFileSync(registry(root), 'utf8')).toBe(before);
      expect(existsSync(join(root, 'plugins/cache/personal/addy/local'))).toBe(false);
    });
  });
  test('failed metadata commit during adoption restores the legacy native record', async () => {
    await isolated(async root => {
      const item = incoming(); item.resolved.sha = 'local';
      writeFiles(copy(root), { 'plugin.json': '{"name":"addy","version":"0.1.0"}\n', 'skills/a/SKILL.md': 'legacy\n' });
      writeFiles(root, {
        '.state/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'addy@personal': [{ installPath: copy(root), version: '0.1.0' }] } }),
        '.state/plugin_state.json': JSON.stringify({ version: 1, enabledPlugins: { 'addy@personal': true } }),
      });
      const before = readFileSync(registry(root), 'utf8');
      const now = Date.now;
      Date.now = () => 12345;
      mkdirSync(join(root, '.state', 'plugin_state.json.plgnz-12345'));
      try { await failed(() => dcodeWriter.add(item.plugin, item.resolved, { adoptExisting: true })); }
      finally { Date.now = now; }
      expect(readFileSync(registry(root), 'utf8')).toBe(before);
      expect(dcode.listInstalled()[0]?.path).toBe(copy(root));
      expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toBe('legacy\n');
      expect(existsSync(join(root, 'plugins/cache/personal/addy/local'))).toBe(false);
    });
  });
  test('copies ordinary skill bytes without normalizing line endings', async () => {
    await isolated(async root => {
      const raw = 'byte-preserved\r\n'; const item = incoming(raw); await dcodeWriter.add(item.plugin, item.resolved);
      expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toBe(`---\nname: a\ndescription: fixture\n---\n${raw}`);
    });
  });
  test('retains native MCP and hook declarations without translation', async () => {
    await isolated(async root => {
      const item = incoming(); writeFiles(item.plugin.dir, { '.mcp.json': '{"mcpServers":{"fixture":{"command":"fixture"}}}\n', 'hooks/hooks.json': '{"hooks":{}}\n' });
      await dcodeWriter.add(item.plugin, item.resolved);
      expect(readFileSync(join(copy(root), '.mcp.json'), 'utf8')).toBe('{"mcpServers":{"fixture":{"command":"fixture"}}}\n'); expect(readFileSync(join(copy(root), 'hooks/hooks.json'), 'utf8')).toBe('{"hooks":{}}\n');
    });
  });
  test('refuses a .plugin-only manifest that the native loader does not read', async () => {
    await isolated(async root => {
      const item = incoming(); rmSync(join(item.plugin.dir, 'plugin.json')); writeFiles(item.plugin.dir, { '.plugin/plugin.json': '{"name":"addy","version":"0.1.0"}\n' });
      expect((await failed(() => dcodeWriter.add(item.plugin, item.resolved))).message).toContain('no supported plugin manifest'); expect(existsSync(copy(root))).toBe(false);
    });
  });
  test('unsupported commands, agents, and model-invocation controls are typed before activation', async () => {
    await isolated(async root => {
      const first = incoming('first\n'); await dcodeWriter.add(first.plugin, first.resolved); const before = readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8');
      const command = incoming('second\n'); command.resolved.sourceUri = first.resolved.sourceUri; writeFiles(command.plugin.dir, { 'commands/x.md': 'nope\n', 'agents/x.md': '---\nname: x\ndescription: x\n---\nbody\n' });
      const commandFailure = await failed(() => dcodeWriter.add(command.plugin, command.resolved));
      expect(commandFailure instanceof PackageCapabilityError).toBe(true);
      expect((commandFailure as PackageCapabilityError).gaps.map(({ capabilityId }) => capabilityId)).toEqual(['commands', 'agents']);
      expect(commandFailure.message).toContain("target 'dcode' 0.1.83 managed update is unsupported for commands");
      expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toBe(before);
      const gated = incoming(); gated.resolved.sourceUri = first.resolved.sourceUri; writeFiles(gated.plugin.dir, { 'skills/a/SKILL.md': '---\nname: a\ndescription: fixture\ndisable-model-invocation: true\n---\nbody\n' });
      const gatedFailure = await failed(() => dcodeWriter.add(gated.plugin, gated.resolved)); expect(gatedFailure instanceof CompatibilityError).toBe(true); expect(gatedFailure.message).toContain('unsupported for model-invocation-control'); expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toBe(before);
    });
  });
  test('reads model and user invocation aliases independently only from opening YAML frontmatter', async () => {
    await isolated(async root => {
      const first = incoming('first\n'); await dcodeWriter.add(first.plugin, first.resolved); const before = readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8');
      for (const [key, value, capability] of [['disable-model-invocation', true, 'model-invocation-control'], ['disable_model_invocation', true, 'model-invocation-control'], ['user-invocable', false, 'user-invocation-control'], ['user_invocable', false, 'user-invocation-control']] as const) {
        const gated = incoming(); gated.resolved.sourceUri = first.resolved.sourceUri; writeFiles(gated.plugin.dir, { 'skills/a/SKILL.md': `---\nname: a\ndescription: fixture\n"${key}": ${value}\n---\nbody\n` });
        const failure = await failed(() => dcodeWriter.add(gated.plugin, gated.resolved)); expect(failure instanceof CompatibilityError).toBe(true); expect(failure.message).toContain(`unsupported for ${capability}`); expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toBe(before);
      }
      const ordinary = incoming(); ordinary.resolved.sourceUri = first.resolved.sourceUri; writeFiles(ordinary.plugin.dir, { 'skills/a/SKILL.md': '---\nname: a\ndescription: fixture\ndisable-model-invocation: false\nuser-invocable: true\n---\nbody\n', 'skills/a/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n' });
      expect(await dcodeWriter.add(ordinary.plugin, ordinary.resolved, { dryRun: true })).toBeUndefined(); expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toBe(before);
      const bodyOnly = incoming('---\nname: a\ndescription: fixture\n---\nThe text disable-model-invocation: true is body text.\n'); bodyOnly.resolved.sourceUri = first.resolved.sourceUri;
      expect(await dcodeWriter.add(bodyOnly.plugin, bodyOnly.resolved, { dryRun: true })).toBeUndefined(); expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toBe(before);
    });
  });
  test('refuses a Codex sidecar that restricts implicit skill invocation', async () => {
    await isolated(async root => {
      const first = incoming('first\n'); await dcodeWriter.add(first.plugin, first.resolved);
      const restricted = incoming('second\n'); restricted.resolved.sourceUri = first.resolved.sourceUri;
      writeFiles(restricted.plugin.dir, { 'skills/a/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n' });
      const failure = await failed(() => dcodeWriter.add(restricted.plugin, restricted.resolved));
      expect(failure instanceof CompatibilityError).toBe(true);
      expect(failure.message).toContain('unsupported for model-invocation-control');
      writeFiles(restricted.plugin.dir, { 'skills/a/SKILL.md': '---\nname: a\ndescription: fixture\ndisable-model-invocation: false\nuser-invocable: true\n---\nsecond\n' });
      const conflict = await failed(() => dcodeWriter.add(restricted.plugin, restricted.resolved));
      expect(conflict instanceof SemanticInventoryError).toBe(true);
      expect(conflict.message).toContain('conflicting model-invocation policy declarations');
      expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toContain('first');
    });
  });
  test('dry-run preflights identically and writes no active state', async () => {
    await isolated(async root => {
      const item = incoming(); await dcodeWriter.add(item.plugin, item.resolved, { dryRun: true }); expect(existsSync(registry(root))).toBe(false); expect(existsSync(copy(root))).toBe(false);
      writeFiles(copy(root), { 'foreign.txt': 'keep\n' });
      for (const opts of [{ dryRun: true }, undefined]) expect((await failed(() => dcodeWriter.add(item.plugin, item.resolved, opts))).message).toContain('unowned');
      expect(readFileSync(join(copy(root), 'foreign.txt'), 'utf8')).toBe('keep\n');
    });
  });
  test('rejects a symlinked native cache before it can write outside the dcode root', async () => {
    await isolated(async root => {
      const outside = mkdtempSync(join(tmpdir(), 'plgnz-dcode-outside-')); const item = incoming();
      mkdirSync(join(root, 'plugins'), { recursive: true }); expect(spawnSync('ln', ['-s', outside, join(root, 'plugins', 'cache')]).status).toBe(0);
      for (const opts of [{ dryRun: true }, undefined]) expect((await failed(() => dcodeWriter.add(item.plugin, item.resolved, opts))).message).toContain('symlink');
      expect(existsSync(join(outside, 'personal', 'addy'))).toBe(false); expect(existsSync(registry(root))).toBe(false); rmSync(outside, { recursive: true, force: true });
    });
  });
  test('rejects malformed native records and ownership markers without overwriting them', async () => {
    await isolated(async root => {
      const item = incoming(); writeFiles(root, { '.state/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'addy@personal': ['broken'] } }), '.state/plugin_state.json': JSON.stringify({ version: 1, enabledPlugins: {} }) });
      const before = readFileSync(registry(root), 'utf8'); expect((await failed(() => dcodeWriter.add(item.plugin, item.resolved))).message).toContain('registry record'); expect(readFileSync(registry(root), 'utf8')).toBe(before);
      rmSync(join(root, '.state'), { recursive: true, force: true }); writeFiles(copy(root), { '.plgnz-install.json': '{bad json' });
      expect((await failed(() => dcodeWriter.add(item.plugin, item.resolved))).message).toContain('ownership marker'); expect(readFileSync(join(copy(root), '.plgnz-install.json'), 'utf8')).toBe('{bad json');
    });
  });
  test('removes only a marker-owned native record', async () => {
    await isolated(async root => {
      const item = incoming(); await dcodeWriter.add(item.plugin, item.resolved); await dcodeWriter.remove('addy@personal'); expect(existsSync(copy(root))).toBe(false); expect(JSON.parse(readFileSync(registry(root), 'utf8')).plugins['addy@personal']).toBeUndefined();
      writeFiles(copy(root), { 'foreign.txt': 'keep\n' }); writeFiles(root, { '.state/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'addy@personal': [{ installPath: copy(root), version: '0.1.0' }] } }) });
      expect((await failed(() => dcodeWriter.remove('addy@personal'))).message).toContain('not wholly'); expect(existsSync(copy(root))).toBe(true);
    });
  });
  test('metadata failure rollback retains the prior active copy', async () => {
    await isolated(async root => {
      const item = incoming('first\n'); await dcodeWriter.add(item.plugin, item.resolved); const before = readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8');
      // A directory at the enablement file makes the second metadata commit fail.
      rmSync(join(root, '.state', 'plugin_state.json')); writeFiles(join(root, '.state', 'plugin_state.json'), { '.keep': '' });
      const changed = incoming('second\n'); changed.resolved.sourceUri = item.resolved.sourceUri;
      await failed(() => dcodeWriter.add(changed.plugin, changed.resolved)); expect(readFileSync(join(copy(root), 'skills/a/SKILL.md'), 'utf8')).toBe(before);
    });
  });
});
