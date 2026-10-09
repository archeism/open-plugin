import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';
import { chmodSync, existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { materialize, materializeInto, withHostEnvAsync, initGitRepo, repoRoot, writeLedger } from './util';
import { main } from '../src/cli';
import { readState } from '../src/state';
import { claudeCode } from '../src/hosts/claude-code';
import { codex } from '../src/hosts/codex';
import { kimi } from '../src/hosts/kimi';
import { cursor } from '../src/hosts/cursor';
import { omp } from '../src/hosts/omp';
import { runDoctor } from '../src/doctor';
import { writers } from '../src/hosts/writers';
import type { HostWriter } from '../src/host';
import { CompatibilityError } from '../src/compatibility';
import { kimiNativeEnv, withKimiNative } from './kimi-fixture';
import { LifecycleReportValidationError, parseLifecycleReport } from '../src/lifecycle-report';

const plannedNativeId: HostWriter['plannedNativeId'] = (plugin) => plugin.name;

const pluginsMap = {
  'plugin.json': JSON.stringify({ name: "new-plugin", mcpServers: { demo: { command: "demo" } } }, null, 2),
  'mcp.json': JSON.stringify({ mcpServers: { demo: { command: "demo" } } }, null, 2)
};

const hermesPluginsMap = {
  'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'new-plugin', version: '1.0.0' }, null, 2),
  'mcp.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { demo: { type: 'stdio', command: 'demo' } } }, null, 2),
};

describe('add', () => {
  test('reports a target detection exception as a preflight defect', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = join(home, 'detect-exception-source');
      initGitRepo(sourceDir, pluginsMap);
      const originalWriters = [...writers];
      const exploding: HostWriter = {
        id: 'codex',
        gui: false, plannedNativeId,
        detect: () => {
          throw new Proxy(Object.create(null), {
            getPrototypeOf: () => { throw new Error('prototype trap'); },
            get: () => { throw new Error('property trap'); },
          });
        },
        stores: () => [],
        listInstalled: () => [],
        mcpEntries: () => [],
        add: async () => {},
        remove: async () => {},
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const output: string[] = [];
      const originalLog = console.log;
      writers.splice(0, writers.length, exploding);
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', sourceDir, '--target', 'codex', '--json'])).toBe(1);
      } finally {
        writers.splice(0, writers.length, ...originalWriters);
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect(report.outcomes).toEqual([]);
      expect(report.summary).toEqual({
        result: 'incomplete',
        terminalPhase: 'preflight',
        mutationStarted: false,
        changed: false,
        failureCategory: 'internal',
        reason: {
          category: 'internal',
          code: 'internal.defect',
          diagnostic: 'unknown thrown value',
          capabilityId: null,
          evidenceId: null,
        },
        recoveryId: null,
        readbackId: null,
      });
    });
  });

  test('claude-code > writes registry and copies files', async () => {
    await withHostEnvAsync('claude-code', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      
      const code = await main(['add', sourceDir, '--target', 'claude-code']);
      expect(code).toBe(0);

      const installed = claudeCode.listInstalled();
      expect(installed.length).toBeGreaterThan(0);
      const plugin = installed.find(p => p.name === 'new-plugin');
      expect(plugin !== undefined).toBe(true);
      expect(plugin?.path && existsSync(plugin.path)).toBe(true);
      expect(plugin?.path && existsSync(join(plugin.path, '.claude-plugin', 'plugin.json'))).toBe(true);

      const state = readState();
      expect(state.find(r => r.id === 'new-plugin@local') !== undefined).toBe(true);
    });
  });

  test('codex > writes config and copies files', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      
      const code = await main(['add', sourceDir, '--target', 'codex']);
      expect(code).toBe(0);

      const installed = codex.listInstalled();
      expect(installed.find(p => p.name === 'new-plugin') !== undefined).toBe(true);

      const state = readState();
      const record = state.find(r => r.id === 'new-plugin@local' && r.host === 'codex');
      expect(record !== undefined).toBe(true);
      expect(record?.sourceDir).toContain('open-plugin-source-');
      expect(record?.installedFingerprint?.length).toBe(64);
    });
  });

  test('kimi > writes registry and copies files', async () => {
    await withHostEnvAsync('kimi', async (home) => {
      await withKimiNative(home, async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      
      const code = await main(['add', sourceDir, '--target', 'kimi']);
      expect(code).toBe(0);

      const installed = kimi.listInstalled();
      expect(installed.find(p => p.name === 'new-plugin') !== undefined).toBe(true);

      const state = readState();
      expect(state.find(r => r.id === 'new-plugin' && r.host === 'kimi') !== undefined).toBe(true);
      });
    });
  });

  test('kimi > explicit current binary installs before its selected native root exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'open-plugin-kimi-empty-root-'));
    const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
    const root = join(home, '.kimi-code');
    const saved = Object.fromEntries(['OPEN_PLUGIN_HOME', 'OPEN_PLUGIN_KIMI_ROOT', 'OPEN_PLUGIN_KIMI_BIN'].map(key => [key, process.env[key]]));
    process.env.OPEN_PLUGIN_HOME = home;
    process.env.OPEN_PLUGIN_KIMI_ROOT = root;
    try {
      process.env.OPEN_PLUGIN_KIMI_BIN = join(home, 'missing-kimi');
      expect(kimi.detect()).toBe(false);
      const nonExecutable = join(home, 'non-executable-kimi'); writeFileSync(nonExecutable, '#!/bin/sh\necho 2.0.1\n');
      process.env.OPEN_PLUGIN_KIMI_BIN = nonExecutable;
      expect(kimi.detect()).toBe(false);
      const legacy = join(home, 'legacy-kimi'); writeFileSync(legacy, '#!/bin/sh\necho 0.16.0\n'); chmodSync(legacy, 0o755);
      process.env.OPEN_PLUGIN_KIMI_BIN = legacy;
      expect(kimi.detect()).toBe(false);
      process.env.OPEN_PLUGIN_KIMI_BIN = kimiNativeEnv(home).OPEN_PLUGIN_KIMI_BIN;
      expect(existsSync(root)).toBe(false);
      expect(kimi.detect()).toBe(true);
      initGitRepo(sourceDir, pluginsMap);
      expect(await main(['add', sourceDir, '--target', 'kimi'])).toBe(0);
      expect(kimi.listInstalled().some(plugin => plugin.name === 'new-plugin')).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('cursor > writes directory directly', async () => {
    await withHostEnvAsync('cursor', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      
      const code = await main(['add', sourceDir, '--target', 'cursor']);
      expect(code).toBe(0);

      const installed = cursor.listInstalled();
      expect(installed.find(p => p.name === 'new-plugin') !== undefined).toBe(true);

      const state = readState();
      expect(state.find(r => r.id === 'new-plugin' && r.host === 'cursor') !== undefined).toBe(true);
    });
  });

  test('cursor > marketplace collection survives add, list, doctor, legacy pending repair, update failures, and removal', async () => {
    await withHostEnvAsync('cursor', async (home) => {
      rmSync(join(home, '.cursor', 'plugins', 'local', 'demo-plugin'), { recursive: true, force: true });
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-cursor-marketplace-'));
      initGitRepo(sourceDir, {
        '.claude-plugin/marketplace.json': JSON.stringify({ name: 'personal', plugins: [{ name: 'personal', source: './plugins/personal' }] }),
        'plugins/personal/plugin.json': JSON.stringify({ name: 'personal', version: '0.2.0' }),
        'plugins/personal/skills/skill/SKILL.md': '# Personal\n',
      });

      expect(await main(['add', sourceDir, '--target', 'cursor', '--plugin', 'personal', '--adopt-existing', '--legacy-json'])).toBe(0);
      expect(cursor.listInstalled().some((plugin) => plugin.id === 'personal' && plugin.name === 'personal' && plugin.marketplace === 'personal')).toBe(true);

      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['list', '--target', 'cursor', '--json'])).toBe(0);
        const listed = JSON.parse(output.join('')) as Array<{ host: string; plugins: Array<{ id: string; marketplace?: string }> }>;
        expect(listed).toHaveLength(1);
        expect(listed[0]?.host).toBe('cursor');
        expect(listed[0]?.plugins.some((plugin) => plugin.id === 'personal' && plugin.marketplace === 'personal')).toBe(true);

        output.length = 0;
        expect(await main(['doctor', '--target', 'cursor', '--json'])).toBe(0);
        const findings = JSON.parse(output.join('')) as Array<{ host: string; mark: string }>;
        expect(findings.some((finding) => finding.host === 'cursor' && finding.mark === '✗')).toBe(false);

        const original = readState().find((record) => record.host === 'cursor' && record.id === 'personal');
        expect(original === undefined).toBe(false);
        const target = join(home, '.cursor', 'plugins', 'local', 'personal');
        // This is the state left by the old writer: a native bare marker and
        // a pending marketplace-qualified CLI record. Retrying must recover it.
        writeFileSync(join(target, '.plgnz-install.json'), JSON.stringify({ source: sourceDir, pluginId: 'personal', fingerprint: original?.fingerprint ?? '' }));
        writeLedger(home, [{ ...original!, id: 'personal@personal', pending: 'install' }]);

        output.length = 0;
        expect(await main(['add', sourceDir, '--target', 'cursor', '--plugin', 'personal', '--adopt-existing', '--legacy-json'])).toBe(0);
        expect((JSON.parse(readFileSync(join(target, '.plgnz-install.json'), 'utf8')) as { pluginId?: string }).pluginId).toBe('personal@personal');
        expect(readState().find((record) => record.host === 'cursor' && record.id === 'personal')?.pending).toBeUndefined();

        output.length = 0;
        expect(await main(['add', sourceDir, '--target', 'cursor', '--plugin', 'personal', '--adopt-existing', '--legacy-json'])).toBe(0);
        const outcomes = JSON.parse(output.join('')) as Array<{ status: string; nativeId: string }>;
        const nativeId = cursor.listInstalled().find((plugin) => plugin.name === 'personal')?.id;
        expect(nativeId).toBe('personal');
        expect(outcomes.some((outcome) => outcome.status === 'unchanged' && outcome.nativeId === nativeId)).toBe(true);

        writeFileSync(join(sourceDir, 'plugins', 'personal', 'skills', 'skill', 'SKILL.md'), '# Personal v2\n');
        output.length = 0;
        expect(await main(['update', 'personal', '--target', 'cursor', '--legacy-json'])).toBe(0);
        expect(readFileSync(join(target, 'skills', 'skill', 'SKILL.md'), 'utf8')).toBe('# Personal v2\n');

        mkdirSync(join(sourceDir, 'plugins', 'personal', '.claude', 'commands'), { recursive: true });
        writeFileSync(join(sourceDir, 'plugins', 'personal', '.claude', 'commands', 'unverified.md'), '# command\n');
        output.length = 0;
        expect(await main(['update', 'personal', '--target', 'cursor', '--legacy-json'])).toBe(1);
        expect(readFileSync(join(target, 'skills', 'skill', 'SKILL.md'), 'utf8')).toBe('# Personal v2\n');
        expect(readState().some((record) => record.host === 'cursor' && record.id === 'personal' && record.pending === 'install')).toBe(true);

        rmSync(join(sourceDir, 'plugins', 'personal', '.claude'), { recursive: true, force: true });
        output.length = 0;
        expect(await main(['update', 'personal', '--target', 'cursor', '--legacy-json'])).toBe(0);
        expect(readState().find((record) => record.host === 'cursor' && record.id === 'personal')?.pending).toBeUndefined();

        output.length = 0;
        expect(await main(['remove', nativeId!, '--target', 'cursor', '--legacy-json'])).toBe(0);
        expect(existsSync(target)).toBe(false);
        expect(readState().find((record) => record.host === 'cursor' && record.id === 'personal')).toBeUndefined();
      } finally {
        console.log = originalLog;
      }
    });
  });

  test('omp > writes registry, lockfile and copies files', async () => {
    await withHostEnvAsync('omp', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      
      const code = await main(['add', sourceDir, '--target', 'omp']);
      expect(code).toBe(0);

      const installed = omp.listInstalled();
      expect(installed.find(p => p.name === 'new-plugin') !== undefined).toBe(true);
      
      const state = readState();
      expect(state.find(r => r.id === 'new-plugin@local' && r.host === 'omp') !== undefined).toBe(true);
    });
  });

  test('idempotency > running twice works and produces same result', async () => {
    await withHostEnvAsync('claude-code', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      
      const code1 = await main(['add', sourceDir, '--target', 'claude-code']);
      expect(code1).toBe(0);
      const state1 = readState();
      
      const code2 = await main(['add', sourceDir, '--target', 'claude-code']);
      expect(code2).toBe(0);
      const state2 = readState();
      
      expect(state1.length).toBe(state2.length);
    });
  });

  test('json dry-run reports a planned install without writing state or host content', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', sourceDir, '--target', 'codex', '--dry-run', '--legacy-json'])).toBe(0);
      } finally {
        console.log = originalLog;
      }

      const outcomes = JSON.parse(output.join('')) as Array<{ plugin: string; target: string; status: string; dryRun: boolean }>;
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.plugin).toBe('new-plugin');
      expect(outcomes[0]?.target).toBe('codex');
      expect(outcomes[0]?.status).toBe('installed');
      expect(outcomes[0]?.dryRun).toBe(true);
      expect(readState().find((record) => record.host === 'codex' && record.id === 'new-plugin@local')).toBeUndefined();
      expect(codex.listInstalled().find((plugin) => plugin.name === 'new-plugin')).toBeUndefined();
    });
  });

  test('rejects duplicate or absent requested targets before writing', async () => {
    await withHostEnvAsync('codex', async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      const originalLog = console.log;
      const output: string[] = [];
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', sourceDir, '--target', 'codex', '--target', 'codex', '--json'])).toBe(2);
      } finally {
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect(report.summary.result).toBe('usage-error');
      expect(report.summary.reason?.diagnostic).toContain('duplicate target');
      expect(readState()).toEqual([]);
      expect(codex.listInstalled().find((plugin) => plugin.name === 'new-plugin')).toBeUndefined();
    });
  });

  test('reports an explicitly requested but absent dcode target without creating a native store', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try { expect(await main(['add', sourceDir, '--target', 'dcode', '--json'])).toBe(2); }
      finally { console.log = originalLog; }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect(report.plan).toHaveLength(0); expect(report.outcomes).toHaveLength(0); expect(report.summary.reason?.diagnostic).toContain("requested target 'dcode' is not present on this machine");
      expect(readState()).toEqual([]); expect(existsSync(join(home, '.deepagents'))).toBe(false);
    });
  });

  test('rejects a name outside the frozen target inventory before source or native writes', async () => {
    await withHostEnvAsync('codex', async () => {
      const before = codex.listInstalled().map((plugin) => plugin.id);
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', '/not/read', '--target', 'not-a-target', '--json'])).toBe(2);
      } finally { console.log = originalLog; }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect(report.summary.reason?.code).toBe('usage.invalid-selection');
      expect(report.summary.reason?.diagnostic).toContain("unknown target 'not-a-target'");
      expect(readState()).toEqual([]);
      expect(codex.listInstalled().map((plugin) => plugin.id)).toEqual(before);
    });
  });

  test('selects one plugin from a marketplace and rejects unknown selectors before writing', async () => {
    await withHostEnvAsync('codex', async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-marketplace-'));
      mkdirSync(join(sourceDir, '.claude-plugin'), { recursive: true });
      for (const name of ['one', 'two']) {
        mkdirSync(join(sourceDir, name));
        writeFileSync(join(sourceDir, name, 'plugin.json'), JSON.stringify({ name }));
      }
      writeFileSync(join(sourceDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'personal', plugins: [{ source: 'one' }, { source: 'two' }] }));
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', sourceDir, '--target', 'codex', '--plugin', 'one', '--dry-run', '--legacy-json'])).toBe(0);
      } finally { console.log = originalLog; }
      const outcomes = JSON.parse(output.join('')) as Array<{ plugin: string; nativeId?: string }>;
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.plugin).toBe('one');
      expect(outcomes[0]?.nativeId).toBe('one@personal');
      expect(codex.listInstalled().find((plugin) => plugin.name === 'one')).toBeUndefined();
    });
  });

  test('rejects an unknown plugin selector and unknown option before writing', async () => {
    await withHostEnvAsync('codex', async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      for (const args of [
        ['add', sourceDir, '--target', 'codex', '--plugin', 'missing', '--json'],
        ['add', sourceDir, '--target', 'codex', '--unknown', '--json'],
      ]) {
        const output: string[] = [];
        const originalLog = console.log;
        console.log = (value: string) => output.push(value);
        try { expect(await main(args)).toBe(2); } finally { console.log = originalLog; }
        const report = parseLifecycleReport(JSON.parse(output.join('')));
        expect(report.summary.result).toBe('usage-error');
      }
      expect(readState()).toEqual([]);
      expect(codex.listInstalled().find((plugin) => plugin.name === 'new-plugin')).toBeUndefined();
    });
  });

  test('claude-code accepts --adopt-existing in a public dry-run without state writes', async () => {
    await withHostEnvAsync('claude-code', async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', sourceDir, '--target', 'claude-code', '--adopt-existing', '--dry-run', '--legacy-json'])).toBe(0);
      } finally { console.log = originalLog; }
      const outcomes = JSON.parse(output.join('')) as Array<{ plugin: string; target: string; status: string; dryRun: boolean }>;
      expect(outcomes).toEqual([{ plugin: 'new-plugin', target: 'claude-code', status: 'installed', action: 'install', dryRun: true, nativeId: 'new-plugin@local' }]);
      expect(readState()).toEqual([]);
    });
  });

  test('claude-code accepts repeated public adoption for its already-owned native install', async () => {
    await withHostEnvAsync('claude-code', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, { ...pluginsMap, 'plugin.json': JSON.stringify({ name: 'new-plugin', version: '1.0.0' }) });
      const legacy = join(home, '.claude/plugins/cache/local/new-plugin/1.0.0');
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'plugin.json'), JSON.stringify({ name: 'new-plugin', version: '1.0.0' }));
      mkdirSync(join(legacy, '.claude-plugin'), { recursive: true });
      writeFileSync(join(legacy, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'new-plugin', version: '1.0.0', skills: './skills/' }));
      writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'new-plugin@local': [{ scope: 'user', installPath: legacy, version: '1.0.0' }] } }));
      expect(await main(['add', sourceDir, '--target', 'claude-code', '--adopt-existing'])).toBe(0);
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', sourceDir, '--target', 'claude-code', '--adopt-existing', '--legacy-json'])).toBe(0);
      } finally { console.log = originalLog; }
      const nativeId = claudeCode.listInstalled().find((plugin) => plugin.name === 'new-plugin')?.id;
      expect(nativeId).toBe('new-plugin@local');
      expect(JSON.parse(output.join(''))).toEqual([{ plugin: 'new-plugin', target: 'claude-code', status: 'unchanged', action: 'install', dryRun: false, nativeId }]);
    });
  });

  test('installs through the active Hermes native adapter', async () => {
    await withHostEnvAsync('codex', async (home) => {
      mkdirSync(join(home, '.hermes'), { recursive: true });
      writeFileSync(join(home, '.hermes', 'config.yaml'), 'model: fixture\n');
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, hermesPluginsMap);
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', sourceDir, '--target', 'hermes', '--legacy-json'])).toBe(0);
      } finally { console.log = originalLog; }
      const outcomes = JSON.parse(output.join('')) as Array<{ plugin: string; target: string; status: string; action: string; dryRun: boolean; diagnostic?: string }>;
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.plugin).toBe('new-plugin');
      expect(outcomes[0]?.target).toBe('hermes');
      expect(outcomes[0]?.status).toBe('installed');
      expect(outcomes[0]?.action).toBe('install');
      expect(outcomes[0]?.dryRun).toBe(false);
      expect(outcomes[0]?.diagnostic).toBeUndefined();
      expect(readState().find(record => record.host === 'hermes') !== undefined).toBe(true);
      expect(codex.listInstalled().find((plugin) => plugin.name === 'new-plugin')).toBeUndefined();
    });
  });

  test('refuses an explicitly selected unverified adapter without mutation', async () => {
    await withHostEnvAsync('codex', async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', sourceDir, '--target', 'gemini-cli', '--legacy-json'])).toBe(1);
      } finally { console.log = originalLog; }
      const outcomes = JSON.parse(output.join('')) as Array<{ plugin: string; target: string; status: string; action: string; dryRun: boolean; diagnostic?: string }>;
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.plugin).toBe('new-plugin');
      expect(outcomes[0]?.target).toBe('gemini-cli');
      expect(outcomes[0]?.status).toBe('unverified');
      expect(outcomes[0]?.action).toBe('install');
      expect(outcomes[0]?.dryRun).toBe(false);
      expect(outcomes[0]?.diagnostic).toContain('unverified for install');
      expect(readState()).toEqual([]);
      expect(codex.listInstalled().find((plugin) => plugin.name === 'new-plugin')).toBeUndefined();
    });
  });

  test('installs Codex and Hermes together when both native adapters are selected', async () => {
    await withHostEnvAsync('codex', async (home) => {
      mkdirSync(join(home, '.hermes', 'plugins'), { recursive: true });
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, hermesPluginsMap);
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', sourceDir, '--target', 'codex', '--target', 'hermes', '--legacy-json'])).toBe(0);
      } finally { console.log = originalLog; }
      const outcomes = JSON.parse(output.join('')) as Array<{ target: string; status: string }>;
      expect(outcomes.find((outcome) => outcome.target === 'hermes')?.status).toBe('installed');
      expect(outcomes.find((outcome) => outcome.target === 'codex')?.status).toBe('installed');
      expect(readState()).toHaveLength(2);
      expect(codex.listInstalled().find((plugin) => plugin.name === 'new-plugin') !== undefined).toBe(true);
    });
  });

  test('refuses standalone Pi delivery without writing an install record or skill tree', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (value: string) => output.push(value);
      try {
        expect(await main(['add', '/must-not-read', '--target', 'pi', '--legacy-json'])).toBe(1);
      } finally {
        console.log = originalLog;
      }
      const outcomes = JSON.parse(output.join('')) as Array<{ target: string; status: string; action: string; diagnostic?: string }>;
      expect(outcomes).toHaveLength(1);
      // Pairless command failures can only be represented by the legacy wildcard row.
      expect(outcomes[0]?.target).toBe('*');
      expect(outcomes[0]?.status).toBe('unsupported');
      expect(outcomes[0]?.action).toBe('install');
      expect(outcomes[0]?.diagnostic).toContain('unsupported for install');
      expect(readState()).toEqual([]);
      expect(existsSync(join(home, '.pi', 'agent', 'skills', 'local___new-plugin'))).toBe(false);
    });
  });

  test('reclassifies a post-intent writer refusal and stops later adds', async () => {
    for (const scenario of [
      { evidence: 'test evidence', expectedEvidenceId: 'test evidence' },
      { evidence: '', expectedEvidenceId: null },
    ] as const) {
      await withHostEnvAsync('codex', async () => {
        const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
        initGitRepo(sourceDir, pluginsMap);
        const originalWriters = [...writers];
        const refusing: HostWriter = {
          id: 'codex', gui: false, plannedNativeId, detect: () => true, stores: () => [], listInstalled: () => [], mcpEntries: () => [],
          add: async () => { throw new CompatibilityError('codex', 'install', 'unsupported', scenario.evidence); },
          remove: async () => {}, pin: async () => ({ changes: [], refusals: [] }),
        };
        let laterAddCalls = 0;
        const later: HostWriter = {
          id: 'cursor', gui: false, plannedNativeId, detect: () => true, stores: () => [], listInstalled: () => [], mcpEntries: () => [],
          add: async () => { laterAddCalls += 1; },
          remove: async () => {}, pin: async () => ({ changes: [], refusals: [] }),
        };
        const output: string[] = [];
        const originalLog = console.log;
        writers.splice(0, writers.length, refusing, later);
        console.log = (value: string) => output.push(value);
        try {
          expect(await main(['add', sourceDir, '--target', 'codex', '--target', 'cursor', '--json'])).toBe(1);
        } finally {
          writers.splice(0, writers.length, ...originalWriters);
          console.log = originalLog;
        }
        const report = parseLifecycleReport(JSON.parse(output.join('')));
        expect({
          laterAddCalls,
          plan: report.plan.map(({ action, route }) => ({ action, route })),
          outcomes: report.outcomes.map(({ result, action, route, resourceState, reason }) => ({ result, action, route, resourceState, reason })),
          summary: report.summary,
          pending: readState().map(({ host, pending }) => ({ host, pending })),
        }).toEqual({
          laterAddCalls: 0,
          plan: [
            { action: 'install', route: 'managed' },
            { action: 'install', route: 'managed' },
          ],
          outcomes: [{
            result: 'pending',
            action: 'install',
            route: 'managed',
            resourceState: 'potentially-changed',
            reason: {
              category: 'recovery',
              code: 'recovery.required',
              diagnostic: `target 'codex' refused install after pending intent was persisted — target 'codex' is unsupported for install; evidence: ${scenario.evidence}`,
              capabilityId: null,
              evidenceId: null,
            },
          }, {
            result: 'not-attempted',
            action: 'install',
            route: 'managed',
            resourceState: 'unknown',
            reason: {
              category: 'runtime',
              code: 'runtime.operation-failed',
              diagnostic: 'not attempted after an earlier install failure',
              capabilityId: null,
              evidenceId: null,
            },
          }],
          summary: {
            result: 'incomplete',
            terminalPhase: 'apply',
            mutationStarted: true,
            changed: false,
            failureCategory: 'recovery',
            reason: report.outcomes[0]!.reason,
            recoveryId: report.plan[0]!.operationId,
            readbackId: null,
          },
          pending: [{ host: 'codex', pending: 'install' }],
        });
      });
    }
  });

  test('classifies missing and failed native inspection as readback failures', async () => {
    for (const scenario of [
      {
        listInstalled: (): ReturnType<HostWriter['listInstalled']> => [],
        code: 'readback.mismatch',
        diagnostic: 'native install readback is missing new-plugin',
      },
      {
        listInstalled: (): ReturnType<HostWriter['listInstalled']> => { throw new Error('forced inventory readback failure'); },
        code: 'readback.failed',
        diagnostic: 'forced inventory readback failure',
      },
    ] as const) {
      await withHostEnvAsync('codex', async () => {
        const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
        initGitRepo(sourceDir, pluginsMap);
        const originalWriters = [...writers];
        const probing: HostWriter = {
          id: 'codex',
          gui: false, plannedNativeId,
          detect: () => true,
          stores: () => [],
          listInstalled: scenario.listInstalled,
          mcpEntries: () => [],
          add: async () => {},
          remove: async () => {},
          pin: async () => ({ changes: [], refusals: [] }),
        };
        const output: string[] = [];
        const originalLog = console.log;
        writers.splice(0, writers.length, probing);
        console.log = (value: string) => output.push(value);
        try {
          expect(await main(['add', sourceDir, '--target', 'codex', '--json'])).toBe(1);
        } finally {
          writers.splice(0, writers.length, ...originalWriters);
          console.log = originalLog;
        }
        const report = parseLifecycleReport(JSON.parse(output.join('')));
        expect({
          result: report.outcomes[0]?.result,
          changed: report.outcomes[0]?.changed,
          resourceState: report.outcomes[0]?.resourceState,
          reasonCode: report.outcomes[0]?.reason?.code,
          diagnostic: report.outcomes[0]?.reason?.diagnostic,
          terminalPhase: report.summary.terminalPhase,
          mutationStarted: report.summary.mutationStarted,
        }).toEqual({
          result: 'failed',
          changed: true,
          resourceState: 'potentially-changed',
          reasonCode: scenario.code,
          diagnostic: scenario.diagnostic,
          terminalPhase: 'readback',
          mutationStarted: true,
        });
      });
    }
  });

  test('classifies a post-readback ledger failure as recovery-required finalization', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-add-finalize-'));
      initGitRepo(sourceDir, pluginsMap);
      const originalWriters = [...writers];
      const writer: HostWriter = {
        id: 'codex',
        gui: false, plannedNativeId,
        detect: () => true,
        stores: () => [],
        listInstalled: () => {
          chmodSync(home, 0o555);
          return [{ id: 'new-plugin', name: 'new-plugin', enabled: true, path: sourceDir }];
        },
        mcpEntries: () => [],
        add: async () => {},
        remove: async () => {},
        pin: async () => ({ changes: [], refusals: [] }),
      };
      const output: string[] = [];
      const originalLog = console.log;
      writers.splice(0, writers.length, writer);
      console.log = (value: string) => output.push(value);
      let code: number;
      try {
        code = await main(['add', sourceDir, '--target', 'codex', '--json']);
      } finally {
        chmodSync(home, 0o755);
        writers.splice(0, writers.length, ...originalWriters);
        console.log = originalLog;
      }
      const report = parseLifecycleReport(JSON.parse(output.join('')));
      expect({
        code,
        result: report.outcomes[0]?.result,
        changed: report.outcomes[0]?.changed,
        resourceState: report.outcomes[0]?.resourceState,
        activationState: report.outcomes[0]?.activationState,
        reasonCode: report.outcomes[0]?.reason?.code,
        terminalPhase: report.summary.terminalPhase,
        mutationStarted: report.summary.mutationStarted,
        recoveryId: report.summary.recoveryId,
      }).toEqual({
        code: 1,
        result: 'pending',
        changed: true,
        resourceState: 'present',
        activationState: 'active-conforming',
        reasonCode: 'recovery.required',
        terminalPhase: 'finalize',
        mutationStarted: true,
        recoveryId: report.plan[0]!.operationId,
      });
    });
  });

  test('does not mutate a host when pending intent cannot be persisted', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
      initGitRepo(sourceDir, pluginsMap);
      writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, installs: [] }));
      chmodSync(home, 0o555);
      try {
        expect(await main(['add', sourceDir, '--target', 'codex', '--legacy-json'])).toBe(1);
        expect(codex.listInstalled().some((plugin) => plugin.name === 'new-plugin')).toBe(false);
      } finally {
        chmodSync(home, 0o755);
      }
    });
  });

  test('persists the desired source before a writer failure leaves install pending', async () => {
    await withHostEnvAsync('codex', async (home) => {
      const oldSource = mkdtempSync(join(tmpdir(), 'open-plugin-old-source-'));
      initGitRepo(oldSource, pluginsMap);
      const nextSource = mkdtempSync(join(tmpdir(), 'open-plugin-new-source-'));
      writeFileSync(join(nextSource, 'plugin.json'), JSON.stringify({ name: 'new-plugin', version: 'unsafe/version' }));
      writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, installs: [
        { host: 'codex', id: 'new-plugin@local', source: oldSource, sourceSha: 'old', ownership: 'plgnz' },
      ] }));
      expect(await main(['add', nextSource, '--target', 'codex'])).toBe(1);
      const pending = readState().find((record) => record.host === 'codex' && record.id === 'new-plugin@local');
      expect(pending?.source).toBe(nextSource);
      expect(pending?.pending).toBe('install');
    });
  });

  test('actual CLI keeps every selected pair in the frozen plan after a later matrix failure', () => {
    const { home, env } = materialize('codex');
    materializeInto(home, 'cursor');
    const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-invalid-codex-source-'));
    writeFileSync(join(sourceDir, 'plugin.json'), JSON.stringify({ name: 'new-plugin', version: 'unsafe/version' }));
    const result = spawnSync('bun', [join(repoRoot, 'bin', 'plgnz.mjs'), 'add', sourceDir, '--target', 'codex', '--target', 'cursor', '--json'], {
      cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const report = parseLifecycleReport(JSON.parse(result.stdout));
    expect(report.plan.map(({ action, route }) => ({ action, route }))).toEqual([
      { action: 'install', route: 'managed' },
      { action: 'install', route: 'managed' },
    ]);
    expect(report.outcomes.map(({ operationId, result, action, route, reason }) => ({ operationId, result, action, route, diagnostic: reason?.diagnostic }))).toEqual([
      {
        operationId: report.plan[0]!.operationId,
        result: 'pending',
        action: 'install',
        route: 'managed',
        diagnostic: report.outcomes[0]!.reason?.diagnostic,
      },
      {
        operationId: report.plan[1]!.operationId,
        result: 'not-attempted',
        action: 'install',
        route: 'managed',
        diagnostic: 'not attempted after an earlier install failure',
      },
    ]);
    expect(report.outcomes[0]!.reason?.diagnostic).toContain('unsafe Codex plugin version');

    const missingOutcome = JSON.parse(JSON.stringify(report)) as typeof report;
    missingOutcome.outcomes.pop();
    let missingCode = 'accepted';
    try { parseLifecycleReport(missingOutcome); }
    catch (error) { missingCode = (error as LifecycleReportValidationError).reason.code; }
    expect(missingCode).toBe('protocol.missing-outcome');
  });

  test('actual CLI ignores absent unverified adapters and fails cleanly when no writer target is detected', () => {
    const home = mkdtempSync(join(tmpdir(), 'open-plugin-empty-home-'));
    const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-source-'));
    initGitRepo(sourceDir, pluginsMap);
    const result = spawnSync('bun', [join(repoRoot, 'bin', 'plgnz.mjs'), 'add', sourceDir, '--legacy-json'], {
      cwd: repoRoot,
      env: { ...process.env, OPEN_PLUGIN_HOME: home },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const outcomes = JSON.parse(result.stdout) as Array<{ status: string; diagnostic?: string }>;
    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[0]?.diagnostic).toContain('No detected writer targets');
  });

  test('doctor content proof follows install, local source refresh, and native tampering', async () => {
    await withHostEnvAsync('codex', async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'open-plugin-content-proof-'));
      initGitRepo(sourceDir, { ...pluginsMap, 'resource.txt': 'one\n' });
      expect(await main(['add', sourceDir, '--target', 'codex'])).toBe(0);
      const content = () => runDoctor([codex]).findings.find((finding) => finding.check === 'content' && finding.pluginId === 'new-plugin@local');
      expect(content()?.mark).toBe('✓');

      writeFileSync(join(sourceDir, 'resource.txt'), 'two\n');
      expect(content()?.mark).toBe('✗');
      expect(await main(['add', sourceDir, '--target', 'codex'])).toBe(0);
      expect(content()?.mark).toBe('✓');

      const installed = codex.listInstalled().find((plugin) => plugin.id === 'new-plugin@local');
      expect(installed?.path === undefined).toBe(false);
      writeFileSync(join(installed!.path!, 'resource.txt'), 'tampered\n');
      expect(content()?.mark).toBe('✗');
    });
  });
});
