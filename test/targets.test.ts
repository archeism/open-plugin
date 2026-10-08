import { test, expect, describe } from 'bun:test';
import { withHostEnvAsync } from './util';
import { main } from '../src/cli';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './util';

describe('targets', () => {
  test('lists detected targets', async () => {
    await withHostEnvAsync('claude-code', async (home) => {
      const origLog = console.log;
      const logs: string[] = [];
      console.log = (...args: any[]) => logs.push(args.join(' '));
      
      const code = await main(['targets']);
      
      console.log = origLog;
      expect(code).toBe(0);
      expect(logs).toContain('claude-code');
    });
  });
  
  test('json output', async () => {
    await withHostEnvAsync('claude-code', async (home) => {
      const origLog = console.log;
      let output = '';
      console.log = (msg: string) => output = msg;
      
      const code = await main(['targets', '--json']);
      
      console.log = origLog;
      expect(code).toBe(0);
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toContain('claude-code');
    });
  });

  test('list json filters to the requested detected target', async () => {
    await withHostEnvAsync('claude-code', async () => {
      const originalLog = console.log;
      let output = '';
      console.log = (msg: string) => output = msg;
      try {
        expect(await main(['list', '--target', 'claude-code', '--json'])).toBe(0);
      } finally {
        console.log = originalLog;
      }
      const rows = JSON.parse(output) as Array<{ host: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.host).toBe('claude-code');
    });
  });

  test('actual CLI exposes all frozen profiles only when requested', () => {
    const result = spawnSync('bun', [join(repoRoot, 'bin', 'plugnz.mjs'), 'targets', '--all'], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('grokbot');
  });

  test('targets --all --json retains profile evidence while default JSON stays ids', async () => {
    await withHostEnvAsync('claude-code', async () => {
      const originalLog = console.log;
      let output = '';
      console.log = (message: string) => { output = message; };
      try { expect(await main(['targets', '--all', '--json'])).toBe(0); }
      finally { console.log = originalLog; }
      const profiles = JSON.parse(output) as Array<{ id: string; scope: string; evidence: string; capabilities: Record<string, string> }>;
      expect(profiles).toHaveLength(16);
      expect(profiles.find((profile) => profile.id === 'grokbot')?.scope).toBe('excluded-standalone');
      expect(profiles.find((profile) => profile.id === 'pi')?.capabilities.install).toBe('unsupported');
      expect(profiles.find((profile) => profile.id === 'gemini-cli')?.scope).toBe('native-plugin');
      expect(profiles.find((profile) => profile.id === 'cursor')?.evidence).toBe('docs/hosts/cursor.md');
      expect(profiles.find((profile) => profile.id === 'codex')?.capabilities.commandProjection).toBe('supported');
      expect(profiles.find((profile) => profile.id === 'omp')?.capabilities.userOnlySkills).toBe('supported');
      const dcode = profiles.find((profile) => profile.id === 'dcode')?.capabilities;
      expect(dcode?.install).toBe('supported'); expect(dcode?.update).toBe('supported'); expect(dcode?.commandProjection).toBe('unsupported'); expect(dcode?.userOnlySkills).toBe('unsupported');
    });
  });

  test('actual CLI reports its package version as JSON', () => {
    const result = spawnSync('bun', [join(repoRoot, 'bin', 'plugnz.mjs'), '--version', '--json'], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(JSON.parse(result.stdout)).toEqual({ name: 'plugnz', version });
  });
});
