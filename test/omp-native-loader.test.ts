/** Opt-in installed OMP 18.1.4 extension-package lifecycle proof. */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFiles } from './util';

const omp = process.env['OMP_BIN'] ?? '/Users/chaz/.bun/bin/omp';
const installedSource = '/Users/chaz/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src';
const nativeTest: (name: string, fn: () => void) => void = process.env['OMP_NATIVE_LOADER'] === '1' && existsSync(omp) && existsSync(installedSource) ? test : () => {};
const repo = join(import.meta.dir, '..');
const plgnz = join(repo, 'bin', 'plgnz.mjs');
const slug = '6175646974-64656d6f';

function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, PI_CONFIG_DIR: '.omp', OPEN_PLUGIN_HOME: home, OPEN_PLUGIN_OMP_ROOT: join(home, '.omp') };
  for (const key of ['PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) delete env[key];
  return env as Record<string, string>;
}

function run(command: string, args: string[], env: Record<string, string>, cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function discover(env: Record<string, string>, cwd: string): { skills: string[]; commands: string[]; expanded: string } {
  const script = `
    import { loadSkills } from ${JSON.stringify(join(installedSource, 'extensibility/skills.ts'))};
    import { loadSlashCommands, expandSlashCommand } from ${JSON.stringify(join(installedSource, 'extensibility/slash-commands.ts'))};
    const skillResult = await loadSkills({ cwd: ${JSON.stringify(cwd)} });
    const commands = await loadSlashCommands({ cwd: ${JSON.stringify(cwd)} });
    console.log(JSON.stringify({
      skills: skillResult.skills.map(skill => skill.name),
      commands: commands.map(command => command.name),
      expanded: expandSlashCommand('/demo:manual alpha beta', commands),
    }));
  `;
  return JSON.parse(run('bun', ['-e', script], env, cwd)) as { skills: string[]; commands: string[]; expanded: string };
}

nativeTest('OMP loads projected commands and skills through its native npm/link lifecycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-omp-native-loader-'));
  const home = join(root, 'home'); const cwd = join(root, 'empty-cwd'); const collection = join(root, 'collection');
  const plugin = join(collection, 'plugins', 'demo'); const installed = join(home, '.omp/plugins/plgnz', slug);
  const env = cleanEnv(home);
  try {
    mkdirSync(join(home, '.omp', 'plugins'), { recursive: true }); mkdirSync(cwd, { recursive: true });
    writeFiles(plugin, {
      'plugin.json': '{"name":"demo","version":"1.0.0"}',
      'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\ndisable-model-invocation: false\nuser-invocable: true\n---\nordinary resource resources/value.txt\n',
      'skills/ordinary/resources/value.txt': 'one\n',
      'skills/manual/SKILL.md': '---\nname: manual\ndescription: manual\ndisable-model-invocation: true\n---\nmanual first=$1 all=$ARGUMENTS resource=resources/value.txt\n',
      'skills/manual/resources/value.txt': 'manual one\n',
      'skills/sidecar/SKILL.md': '---\nname: sidecar\ndescription: sidecar manual\n---\nsidecar body\n',
      'skills/sidecar/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
      '.claude/commands/run.md': '---\ndescription: run\n---\nrun first=$1 all=$ARGUMENTS\n',
    });
    writeFiles(collection, { 'marketplace.json': '{"name":"audit","plugins":[{"name":"demo","source":"./plugins/demo"}]}' });

    expect(JSON.parse(run('bun', [plgnz, 'add', collection, '--target', 'omp', '--legacy-json'], env, cwd))[0].status).toBe('installed');
    let found = discover(env, cwd);
    expect(found.skills).toContain('ordinary'); expect(found.skills.includes('manual')).toBe(false); expect(found.skills.includes('sidecar')).toBe(false);
    expect(found.commands).toContain('demo:manual'); expect(found.commands).toContain('demo:sidecar'); expect(found.commands).toContain('demo:run');
    expect(found.expanded).toContain('manual first=alpha all=alpha beta');
    expect(found.expanded).toContain(join(installed, '.plgnz/source/skills/manual'));
    expect(JSON.parse(run('bun', [plgnz, 'add', collection, '--target', 'omp', '--legacy-json'], env, cwd))[0].status).toBe('unchanged');

    writeFileSync(join(plugin, 'skills/manual/resources/value.txt'), 'manual two\n');
    expect(JSON.parse(run('bun', [plgnz, 'add', collection, '--target', 'omp', '--legacy-json'], env, cwd))[0].status).toBe('installed');
    expect(readFileSync(join(installed, '.plgnz/source/skills/manual/resources/value.txt'), 'utf8')).toBe('manual two\n');
    writeFileSync(join(plugin, '.claude/commands/run.md'), '---\ndescription: bad\nuser-invocable: false\n---\nbad\n');
    const failed = spawnSync('bun', [plgnz, 'add', collection, '--target', 'omp', '--legacy-json'], { cwd, encoding: 'utf8', env });
    expect(failed.status).toBe(1);
    found = discover(env, cwd); expect(found.commands).toContain('demo:manual'); expect(found.commands).toContain('demo:run');

    writeFileSync(join(plugin, '.claude/commands/run.md'), '---\ndescription: run\n---\nrun first=$1 all=$ARGUMENTS\n');
    expect(['installed', 'unchanged']).toContain(JSON.parse(run('bun', [plgnz, 'add', collection, '--target', 'omp', '--legacy-json'], env, cwd))[0].status);

    expect(JSON.parse(run('bun', [plgnz, 'remove', 'demo@audit', '--target', 'omp', '--legacy-json'], env, cwd))[0].status).toBe('installed');
    expect(existsSync(installed)).toBe(false);
    found = discover(env, cwd); expect(found.skills.includes('ordinary')).toBe(false); expect(found.commands.includes('demo:manual')).toBe(false); expect(found.commands.includes('demo:run')).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
