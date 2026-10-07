import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDoctor } from '../src/doctor';
import { resolveOfficialZcodeCli, zcodeCli, zcodeCliBinaryCandidates } from '../src/hosts/zcode-cli';

function withZcode(fn: (home: string, cliRoot: string, binary: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'plgnz-zcode-reader-'));
  const cliRoot = join(home, '.zcode', 'cli');
  const binary = join(home, 'zcode');
  const keys = ['OPEN_PLUGIN_HOME', 'OPEN_PLUGIN_ZCODE_CLI_BIN', 'ZCODE_STORAGE_DIR'] as const;
  const prior = keys.map((key) => process.env[key]);
  process.env.OPEN_PLUGIN_HOME = home;
  process.env.OPEN_PLUGIN_ZCODE_CLI_BIN = binary;
  process.env.ZCODE_STORAGE_DIR = join(home, '.zcode');
  try { fn(home, cliRoot, binary); }
  finally {
    keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; });
    rmSync(home, { recursive: true, force: true });
  }
}

function fakeBinary(path: string, version: string): void {
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nif [ "$1" = "doctor" ] && [ "$2" = "--json" ]; then echo '{"cli":{"name":"zcode","processName":"zcode-cli"}}'; exit 0; fi\nexit 91\n`);
  chmodSync(path, 0o755);
}

function nativeRow(cliRoot: string, marketplace: string): { id: string; name: string; marketplace: string; version: string; installPath: string; scope: 'user' } {
  const id = `demo@${marketplace}`;
  const installPath = join(cliRoot, 'plugins', 'cache', marketplace, 'demo', '1.0.0');
  mkdirSync(installPath, { recursive: true });
  writeFileSync(join(installPath, 'plugin.json'), '{"name":"demo","version":"1.0.0"}\n');
  writeFileSync(join(installPath, '.plgnz-install.json'), JSON.stringify({ owner: 'plgnz', schema: 1, logicalId: 'demo@personal', nativeId: id, fingerprint: 'a'.repeat(64), source: '/fixture/source' }));
  return { id, name: 'demo', marketplace, version: '1.0.0', installPath, scope: 'user' };
}

describe('official ZCode CLI reader lifecycle', () => {
  test('rejects a community binary even when its doctor mimics the official identity, without seeding a store', () => {
    withZcode((_home, cliRoot, binary) => {
      fakeBinary(binary, 'zcode-app-cli 3.12.3-26\nzcode-runtime 0.16.5');
      expect(zcodeCli.detect()).toBe(false);
      expect(runDoctor([zcodeCli]).findings).toEqual([]);
      expect(existsSync(cliRoot)).toBe(false);
    });
  });

  test('reports a per-plugin or globally disabled native install as unhealthy and leaves the native store untouched', () => {
    withZcode((_home, cliRoot, binary) => {
      fakeBinary(binary, '0.16.9');
      const native = nativeRow(cliRoot, 'plgnz-owned');
      const registry = join(cliRoot, 'plugins', 'installed_plugins.json');
      const config = join(cliRoot, 'config.json');
      writeFileSync(registry, JSON.stringify({ version: 1, plugins: [native] }));
      writeFileSync(config, JSON.stringify({ plugins: { enabledPlugins: { [native.id]: false } } }));
      const beforeRegistry = readFileSync(registry, 'utf8');
      const beforeConfig = readFileSync(config, 'utf8');
      expect(zcodeCli.listInstalled().some((row) => row.id === 'demo@personal' && row.enabled === false)).toBe(true);
      const result = runDoctor([zcodeCli], [{ host: 'zcode-cli', id: 'demo@personal', source: '/fixture/source', sourceSha: 'fixture' }]);
      expect(result.findings.some((finding) => finding.host === 'zcode-cli' && finding.pluginId === 'demo@personal' && finding.check === 'content' && finding.mark === '✗')).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(readFileSync(registry, 'utf8')).toBe(beforeRegistry);
      expect(readFileSync(config, 'utf8')).toBe(beforeConfig);

      writeFileSync(config, JSON.stringify({ plugins: { enabled: false, enabledPlugins: { [native.id]: true } } }));
      const globalConfig = readFileSync(config, 'utf8');
      expect(zcodeCli.listInstalled().some((row) => row.id === 'demo@personal' && row.enabled === false)).toBe(true);
      const globalResult = runDoctor([zcodeCli], [{ host: 'zcode-cli', id: 'demo@personal', source: '/fixture/source', sourceSha: 'fixture' }]);
      expect(globalResult.findings.some((finding) => finding.pluginId === 'demo@personal' && finding.check === 'content' && finding.mark === '✗')).toBe(true);
      expect(readFileSync(config, 'utf8')).toBe(globalConfig);

      writeFileSync(config, JSON.stringify({ plugins: { enabled: true, enabledPlugins: { [native.id]: true } } }));
      const project = join(cliRoot, 'project');
      mkdirSync(join(project, '.zcode'), { recursive: true });
      writeFileSync(join(project, '.zcode', 'config.json'), JSON.stringify({ plugins: { enabledPlugins: { [native.id]: false } } }));
      const originalCwd = process.cwd();
      try {
        process.chdir(project);
        expect(zcodeCli.listInstalled().some((row) => row.id === 'demo@personal' && row.enabled === false)).toBe(true);
        const projectResult = runDoctor([zcodeCli], [{ host: 'zcode-cli', id: 'demo@personal', source: '/fixture/source', sourceSha: 'fixture' }]);
        expect(projectResult.findings.some((finding) => finding.pluginId === 'demo@personal' && finding.check === 'content' && finding.mark === '✗')).toBe(true);
      } finally { process.chdir(originalCwd); }
    });
  });

  test('refuses two native records claiming the same logical install identity', () => {
    withZcode((_home, cliRoot, binary) => {
      fakeBinary(binary, '0.16.9');
      const first = nativeRow(cliRoot, 'plgnz-one');
      const second = nativeRow(cliRoot, 'plgnz-two');
      writeFileSync(join(cliRoot, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 1, plugins: [first, second] }));
      writeFileSync(join(cliRoot, 'config.json'), JSON.stringify({ plugins: { enabledPlugins: { [first.id]: true, [second.id]: true } } }));
      let failure: Error | undefined;
      try { zcodeCli.listInstalled(); } catch (error) { failure = error as Error; }
      expect(failure?.message).toMatch(/ambiguous/i);
    });
  });
});

describe('official ZCode CLI default detection', () => {
  test('an explicit OPEN_PLUGIN_ZCODE_CLI_BIN override is exclusive: no fallback candidates', () => {
    withZcode((_home, _cliRoot, binary) => {
      fakeBinary(binary, '0.16.9');
      expect(zcodeCliBinaryCandidates()).toEqual([binary]);
    });
  });

  test('without an override, the desktop-bundled CLI under an isolated home is detected', () => {
    withZcode((home, _cliRoot, _binary) => {
      delete process.env.OPEN_PLUGIN_ZCODE_CLI_BIN;
      const bundle = join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
      mkdirSync(dirname(bundle), { recursive: true });
      fakeBinary(bundle, '0.16.9');
      expect(resolveOfficialZcodeCli()).toBe(bundle);
      expect(zcodeCli.detect()).toBe(true);
    });
  });

  test('an isolated home never falls through to the system-wide desktop bundle', () => {
    withZcode((home, _cliRoot, _binary) => {
      delete process.env.OPEN_PLUGIN_ZCODE_CLI_BIN;
      expect(zcodeCliBinaryCandidates()).toEqual([join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs')]);
    });
  });
});
