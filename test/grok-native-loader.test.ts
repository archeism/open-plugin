import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFiles } from './util';
import { fingerprintTree } from '../src/fingerprint';

const binary = process.env.OPEN_PLUGIN_GROK_NATIVE_BIN;
const conditionalTest = test as typeof test & { if(condition: boolean): typeof test };

conditionalTest.if(binary !== undefined)('real Grok loader reads a local bundle from an isolated home and empty cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-grok-native-'));
  const source = join(root, 'source'); const home = join(root, 'home'); const cwd = join(root, 'empty');
  writeFiles(source, {
    '.claude-plugin/marketplace.json': '{"name":"native-proof","plugins":[{"name":"demo","source":"./plugins/demo"}]}',
    'plugins/demo/plugin.json': '{"name":"demo","version":"1.0.0","description":"Native proof"}',
    'plugins/demo/resources/value.txt': 'amended resource\n',
    'plugins/demo/skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: Ordinary proof\n---\nRead ../../resources/value.txt\n',
    'plugins/demo/skills/manual/SKILL.md': '---\nname: manual\ndescription: Manual proof\n---\nmanual body\n',
    'plugins/demo/skills/manual/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
    'plugins/demo/commands/run.toml': 'description = "Run proof"\nprompt = "first=$1 all=$ARGUMENTS"\n',
    'plugins/demo/.mcp.json': '{"mcpServers":{"probe":{"command":"/usr/bin/true"}}}',
  });
  writeFiles(home, { '.keep': '' }); writeFiles(cwd, { '.keep': '' });
  const nativeEnv: Record<string, string | undefined> = { ...process.env, HOME: home, GROK_HOME: join(home, '.grok'), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache') };
  for (const key of ['CLAUDE_CONFIG_DIR', 'GROK_CONFIG_DIR']) delete nativeEnv[key];
  const plgnzEnv = { ...nativeEnv, OPEN_PLUGIN_HOME: home, OPEN_PLUGIN_GROK_ROOT: join(home, '.grok'), OPEN_PLUGIN_GROK_BIN: binary };
  const invoke = (command: string, args: string[], env: Record<string, string | undefined>) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  try {
    const cli = join(import.meta.dir, '..', 'bin', 'plgnz.mjs');
    // Claude's same-name plugin must coexist without shadowing Grok's native copy.
    writeFiles(join(home, '.claude'), { '.keep': '' });
    invoke(process.execPath, [cli, 'add', source, '--target', 'claude-code', '--json'], plgnzEnv);
    const claudeBefore = fingerprintTree(join(home, '.claude'));
    const first = JSON.parse(invoke(process.execPath, [cli, 'add', source, '--target', 'grok', '--json'], plgnzEnv)) as Array<{ status: string; nativeId: string }>;
    expect(first[0]?.status).toBe('installed'); expect(first[0]?.nativeId).toBe('demo@native-proof');
    const second = JSON.parse(invoke(process.execPath, [cli, 'add', source, '--target', 'grok', '--json'], plgnzEnv)) as Array<{ status: string }>;
    expect(second[0]?.status).toBe('unchanged');
    const inspect = JSON.parse(invoke(binary!, ['inspect', '--json'], nativeEnv)) as { plugins: Array<{ name: string; path: string; enabled: boolean; provides: { mcpServers: number } }>; skills: Array<{ name: string; source: { plugin_name?: string; path?: string } }>; mcpServers: Array<{ name: string }> };
    const installed = inspect.plugins.find(plugin => plugin.name === 'demo');
    expect(installed?.enabled).toBe(true); expect(installed?.provides.mcpServers).toBe(1);
    expect(inspect.skills.filter(skill => skill.source.plugin_name === 'demo').map(skill => skill.name).sort()).toEqual(['manual', 'ordinary', 'run']);
    expect(inspect.mcpServers.some(server => server.name === 'probe')).toBe(true);
    expect(existsSync(join(installed!.path, 'resources', 'value.txt'))).toBe(true);
    expect(readFileSync(join(installed!.path, 'resources', 'value.txt'), 'utf8')).toBe('amended resource\n');
    expect(readFileSync(join(installed!.path, 'skills', 'manual', 'SKILL.md'), 'utf8')).toContain('disable-model-invocation: true');
    expect(readFileSync(join(installed!.path, 'commands', 'run.md'), 'utf8')).toContain('first=$1 all=$ARGUMENTS');
    const removed = JSON.parse(invoke(process.execPath, [cli, 'remove', 'demo@native-proof', '--target', 'grok', '--json'], plgnzEnv)) as Array<{ action: string }>;
    expect(removed[0]?.action).toBe('remove');
    expect(fingerprintTree(join(home, '.claude'))).toBe(claudeBefore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
