/**
 * Doctor fixture tests: for each host — a dead command (✗), a shadowed
 * server name (✗), an unknown-staleness install (!) — plus the
 * fresh/stale state.json comparison and the CLI end-to-end exit code.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, type DoctorFinding } from '../src/doctor';
import { gitRemoteHead, isGitUrl } from '../src/exec';
import { claudeCode } from '../src/hosts/claude-code';
import { codex } from '../src/hosts/codex';
import { kimi } from '../src/hosts/kimi';
import { cursor } from '../src/hosts/cursor';
import { omp } from '../src/hosts/omp';
import type { HostReader } from '../src/host';
import { commitAll, initGitRepo, materialize, repoRoot, withHostEnv, writeLedger } from './util';
import { fingerprintInstallation, fingerprintTree } from '../src/fingerprint';

function marks(result: { findings: DoctorFinding[] }): string {
  return result.findings.map((f) => f.mark).join('');
}

/** The three per-host doctor checks against the shared fixture scenario. */
function assertThreeChecks(host: HostReader, shadowFragment: string): void {
  const result = runDoctor([host]);

  // (1) dead absolute command → ✗, and any ✗ drives exit code 1
  expect(
    result.findings.some(
      (f) => f.mark === '✗' && f.message.includes("server 'demo-server':") && f.message.includes('not found or not executable'),
    ),
  ).toBe(true);
  expect(result.exitCode).toBe(1);

  // (2) same server name in user-level config and plugin mcp.json → ✗
  expect(
    result.findings.some((f) => f.mark === '✗' && f.message.includes("'shared-server'") && f.message.includes(shadowFragment)),
  ).toBe(true);

  // (3) install with no state.json record → ! unknown, never fresh
  expect(
    result.findings.some(
      (f) => f.mark === '!' && f.message.includes('staleness unknown') && f.message.includes('state.json'),
    ),
  ).toBe(true);
  expect(result.findings.some((f) => f.mark === '✓' && f.message.includes('is at source head'))).toBe(false);
}

describe('doctor · claude-code', () => {
  test('dead command, shadowed name, unknown staleness', () => {
    withHostEnv('claude-code', () => assertThreeChecks(claudeCode, 'shadow or duplicate'));
  });

  test('identical .mcp.json and mcp.json copies are deduped', () => {
    withHostEnv('claude-code', () => {
      const result = runDoctor([claudeCode]);
      // once from the plugin (not twice: .mcp.json + mcp.json), once from user config
      expect(
        result.findings.filter(
          (f) => f.message.includes("server 'shared-server': command ok") && f.message.includes('plugin demo-plugin@demo-market'),
        ),
      ).toHaveLength(1);
    });
  });

  test('host root placeholders are expanded; unknown ones are unverifiable', () => {
    withHostEnv('claude-code', () => {
      const result = runDoctor([claudeCode]);
      expect(
        result.findings.some(
          (f) => f.mark === '✓' && f.message.includes('placeholder-server') && f.message.includes('scripts/demo-launcher.sh'),
        ),
      ).toBe(true);
      expect(
        result.findings.some(
          (f) => f.mark === '!' && f.message.includes('mystery-server') && f.message.includes('${MYSTERY_VAR}'),
        ),
      ).toBe(true);
    });
  });

  test('state.json at head → ✓; behind head → ✗ stale', () => {
    withHostEnv('claude-code', (home) => {
      const repo = join(home, 'src-repo');
      mkdirSync(repo);
      const git = (args: string[]): void => {
        const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      };
      git(['init', '-q', '-b', 'main']);
      writeFileSync(join(repo, 'plugin.json'), '{"name":"demo-plugin"}\n');
      git(['add', 'plugin.json']);
      git(['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'one']);
      const head1 = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (head1.status !== null && head1.status !== 0) throw new Error('rev-parse failed');

      writeFileSync(
        join(home, 'state.json'),
        JSON.stringify(
          {
            version: 1,
            installs: [
              { host: 'claude-code', id: 'demo-plugin@demo-market', source: repo, sourceSha: head1.stdout.trim() },
            ],
          },
          null,
          2,
        ),
      );
      const fresh = runDoctor([claudeCode]);
      expect(fresh.findings.some((f) => f.mark === '✓' && f.message.includes('is at source head'))).toBe(true);

      writeFileSync(join(repo, 'plugin.json'), '{"name":"demo-plugin","version":"1.1.0"}\n');
      git(['add', 'plugin.json']);
      git(['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'two']);
      const stale = runDoctor([claudeCode]);
      expect(stale.findings.some((f) => f.mark === '✗' && f.message.includes('is stale'))).toBe(true);
      expect(stale.exitCode).toBe(1);
    });
  });
});

describe('doctor · codex', () => {
  test('dead command, shadowed name (user entry wins), unknown staleness', () => {
    withHostEnv('codex', () => assertThreeChecks(codex, 'silently shadows'));
  });
});

describe('doctor · kimi', () => {
  test('dead command, shadowed name, unknown staleness', () => {
    withHostEnv('kimi', () => assertThreeChecks(kimi, 'shadow or duplicate'));
  });
});

describe('doctor · cursor', () => {
  test('dead command, shadowed name (duplicate), unknown staleness', () => {
    withHostEnv('cursor', () => assertThreeChecks(cursor, 'both load and duplicate'));
  });

  test('bare command on a GUI host → ! with pin hint (spec §7.2.1)', () => {
    withHostEnv('cursor', () => {
      const result = runDoctor([cursor]);
      expect(
        result.findings.some(
          (f) => f.mark === '!' && f.message.includes('bare-gui-server') && f.message.includes('run plgnz pin'),
        ),
      ).toBe(true);
    });
  });

  test('http entries are not command-checked', () => {
    withHostEnv('cursor', () => {
      const result = runDoctor([cursor]);
      expect(result.findings.some((f) => f.message.includes('remote-docs'))).toBe(false);
    });
  });
});

describe('doctor · omp', () => {
  test('dead command and unknown staleness from the native store', () => {
    withHostEnv('omp', () => {
      const result = runDoctor([omp]);
      // (1) dead absolute command → ✗, and any ✗ drives exit code 1
      expect(
        result.findings.some(
          (f) => f.mark === '✗' && f.message.includes("server 'demo-server':") && f.message.includes('not found or not executable'),
        ),
      ).toBe(true);
      expect(result.exitCode).toBe(1);
      // (3) install with no state.json record → ! unknown, never fresh
      expect(
        result.findings.some((f) => f.mark === '!' && f.message.includes('staleness unknown') && f.message.includes('state.json')),
      ).toBe(true);
    });
  });

  test('omp is never routed through a repo-root .mcp.json (AGENTS.md)', () => {
    withHostEnv('omp', (home) => {
      // A repo-root .mcp.json in the cwd is the Claude Code project
      // convention — it must not conjure omp findings (or the host itself).
      writeFileSync(
        join(home, '.mcp.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
          mcpServers: { 'repo-dead-server': { type: 'stdio', command: '/nonexistent/plgnz/repo-server' } },
        }),
      );
      const prevCwd = process.cwd();
      process.chdir(home);
      try {
        const result = runDoctor([omp]);
        expect(result.findings.some((f) => f.message.includes('repo-dead-server'))).toBe(false);
      } finally {
        process.chdir(prevCwd);
      }
    });
  });

  test('no user-level MCP surface: no shadow findings for a plugin-only install', () => {
    withHostEnv('omp', () => {
      const result = runDoctor([omp]);
      expect(result.findings.some((f) => f.message.includes('defined both in user config'))).toBe(false);
    });
  });
});

describe('doctor · git-URL sources', () => {
  // `add` records a git URL verbatim (src/source.ts `sourceUri`), so its head
  // must come from `git ls-remote` — `git rev-parse` on a URL always fails,
  // which used to pin every URL install at `! staleness unknown` forever.
  // The fake https URL is redirected to a local repo with git's insteadOf
  // rewriting, injected through GIT_CONFIG_* env vars: hermetic (no network,
  // no config file written).
  const FAKE_URL = 'https://demo.example/plugin-market.git';

  /** Point FAKE_URL at `localUrl` for the duration of `fn`; restores env. */
  function withUrlRedirect<T>(localUrl: string, fn: () => T): T {
    const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
    const saved = keys.map((k) => process.env[k]);
    process.env['GIT_CONFIG_COUNT'] = '1';
    process.env['GIT_CONFIG_KEY_0'] = `url.${localUrl}.insteadOf`;
    process.env['GIT_CONFIG_VALUE_0'] = FAKE_URL;
    try {
      return fn();
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  }

  test('isGitUrl matches exactly the prefixes add treats as remote', () => {
    expect(isGitUrl('https://example.com/market.git')).toBe(true);
    expect(isGitUrl('http://example.com/market.git')).toBe(true);
    expect(isGitUrl('ssh://git@example.com/owner/market.git')).toBe(true);
    expect(isGitUrl('git://example.com/owner/market.git')).toBe(true);
    expect(isGitUrl('git@example.com:owner/market.git')).toBe(true);
    expect(isGitUrl('file:///tmp/market')).toBe(false);
    expect(isGitUrl('/tmp/checkout')).toBe(false);
    expect(isGitUrl('relative/dir')).toBe(false);
  });

  test('gitRemoteHead resolves a remote head (file:// stand-in), null when unreachable', () => {
    const home = mkdtempSync(join(tmpdir(), 'plgnz-remote-'));
    const repo = join(home, 'repo');
    const head = initGitRepo(repo, { 'plugin.json': '{"name":"demo-plugin"}\n' });
    expect(gitRemoteHead(`file://${repo}`)).toBe(head);
    expect(gitRemoteHead('file:///nonexistent-plgnz/repo')).toBe(null);
  });

  test('ledger source at remote head → ✓; behind remote head → ✗ stale', () => {
    withHostEnv('claude-code', (home) => {
      const repo = join(home, 'remote-market');
      const head1 = initGitRepo(repo, { 'plugin.json': '{"name":"demo-plugin"}\n' });
      writeLedger(home, [{ host: 'claude-code', id: 'demo-plugin@demo-market', source: FAKE_URL, sourceSha: head1 }]);

      withUrlRedirect(`file://${repo}`, () => {
        const fresh = runDoctor([claudeCode]);
        expect(fresh.findings.some((f) => f.mark === '✓' && f.message.includes('is at source head'))).toBe(true);

        const head2 = commitAll(repo, 'move the remote head');
        expect(head2 === head1).toBe(false);
        const stale = runDoctor([claudeCode]);
        expect(stale.findings.some((f) => f.mark === '✗' && f.message.includes('is stale'))).toBe(true);
        expect(stale.exitCode).toBe(1);
      });
    });
  });

  test('an unreachable remote stays ! staleness unknown, never a guess', () => {
    withHostEnv('claude-code', (home) => {
      writeLedger(home, [
        { host: 'claude-code', id: 'demo-plugin@demo-market', source: FAKE_URL, sourceSha: '0'.repeat(40) },
      ]);
      withUrlRedirect('file:///nonexistent-plgnz/repo', () => {
        const result = runDoctor([claudeCode]);
        expect(
          result.findings.some(
            (f) => f.mark === '!' && f.message.includes('staleness unknown') && f.message.includes(FAKE_URL),
          ),
        ).toBe(true);
        expect(result.findings.some((f) => f.mark === '✓' && f.message.includes('is at source head'))).toBe(false);
      });
    });
  });
});

describe('doctor · CLI', () => {
  test('bin/plgnz.mjs doctor --json exits 1 with ✗ findings', () => {
    const { home, env } = materialize('codex');
    const r = spawnSync('bun', [join(repoRoot, 'bin', 'plgnz.mjs'), 'doctor', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout) as DoctorFinding[];
    expect(parsed.some((f) => f.host === 'codex' && f.mark === '✗')).toBe(true);
  });

  test('an unknown verb exits 2 with the usage text', () => {
    const r = spawnSync('bun', [join(repoRoot, 'bin', 'plgnz.mjs'), 'frobnicate'], {
      encoding: 'utf8',
      env: { ...process.env, OPEN_PLUGIN_HOME: '/nonexistent-plgnz-home' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown verb');
  });
});

describe('doctor · output shape', () => {
  test('content proof fingerprints every declared active root while legacy installs keep their tree fingerprint', () => {
    const source = mkdtempSync(join(tmpdir(), 'plgnz-doctor-source-'));
    const privateRoot = mkdtempSync(join(tmpdir(), 'plgnz-doctor-private-'));
    const skillsRoot = mkdtempSync(join(tmpdir(), 'plgnz-doctor-skills-'));
    const commandsRoot = mkdtempSync(join(tmpdir(), 'plgnz-doctor-commands-'));
    writeFileSync(join(source, 'source.txt'), 'source');
    const roots = { private: privateRoot, skills: skillsRoot, commands: commandsRoot };
    for (const [label, root] of Object.entries(roots)) writeFileSync(join(root, `${label}.txt`), label);
    const native = { id: 'multi-root', name: 'multi-root', enabled: true, path: privateRoot, contentRoots: roots };
    const host: HostReader = {
      id: 'multi-root-host', gui: false, detect: () => true, stores: () => [], mcpEntries: () => [], listInstalled: () => [native],
    };
    const record = { host: host.id, id: native.id, source, sourceSha: 'local', sourceDir: source,
      fingerprint: fingerprintTree(source), installedFingerprint: fingerprintInstallation(native), ownership: 'plgnz' as const };
    const content = (): DoctorFinding => runDoctor([host], [record]).findings.find((finding) => finding.check === 'content')!;

    expect(fingerprintInstallation({ id: 'legacy', name: 'legacy', path: privateRoot })).toBe(fingerprintTree(privateRoot));
    expect(content().mark).toBe('✓');
    for (const [label, root] of Object.entries(roots)) {
      writeFileSync(join(root, `${label}.txt`), `${label}-tampered`);
      expect(content().mark).toBe('✗');
      writeFileSync(join(root, `${label}.txt`), label);
      expect(content().mark).toBe('✓');
      rmSync(root, { recursive: true, force: true });
      expect(content().mark).toBe('✗');
      mkdirSync(root);
      writeFileSync(join(root, `${label}.txt`), label);
      expect(content().mark).toBe('✓');
    }
  });

  test('content proof detects source drift, refresh, installed tampering, and deletion', () => {
    const source = mkdtempSync(join(tmpdir(), 'plgnz-doctor-source-'));
    const installed = mkdtempSync(join(tmpdir(), 'plgnz-doctor-installed-'));
    const writeBytes = writeFileSync as unknown as (path: string, bytes: Uint8Array) => void;
    writeBytes(join(source, 'value.bin'), new Uint8Array([0, 1, 255]));
    writeBytes(join(installed, 'value.bin'), new Uint8Array([4, 5, 6]));
    const host: HostReader = {
      id: 'proof-host', gui: false, detect: () => true, stores: () => [], mcpEntries: () => [],
      listInstalled: () => [{ id: 'proof', name: 'proof', enabled: true, path: installed }],
    };
    const record = { host: host.id, id: 'proof', source: source, sourceSha: 'local', sourceDir: source,
      fingerprint: fingerprintTree(source), installedFingerprint: fingerprintTree(installed), ownership: 'plgnz' };
    const content = (): DoctorFinding => runDoctor([host], [record]).findings.find((finding) => finding.check === 'content')!;

    expect(content().mark).toBe('✓');
    expect(content().pluginId).toBe('proof');
    writeBytes(join(source, 'value.bin'), new Uint8Array([9]));
    expect(content().mark).toBe('✗');
    record.fingerprint = fingerprintTree(source);
    expect(content().mark).toBe('✓');
    writeBytes(join(installed, 'value.bin'), new Uint8Array([8]));
    expect(content().mark).toBe('✗');
    rmSync(installed, { recursive: true, force: true });
    expect(content().mark).toBe('✗');
  });

  test('surfaces a durable pending intent as an actionable warning', () => {
    const result = runDoctor([cursor], [{
      host: 'cursor',
      id: 'pending-plugin',
      source: '/source',
      sourceSha: 'old',
      ownership: 'plgnz',
      pending: 'remove',
    }]);
    expect(result.findings.some((finding) => finding.mark === '!' && finding.message.includes('pending remove'))).toBe(true);
  });

  test('marks are only ✓ ✗ !', () => {
    withHostEnv('cursor', () => {
      const result = runDoctor([cursor]);
      expect(marks(result)).toMatch(/^[✓✗!]*$/);
      expect(result.findings.length).toBeGreaterThan(0);
    });
  });
});
