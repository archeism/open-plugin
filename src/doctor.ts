/**
 * `plgnz doctor` — read-only diagnosis.
 *
 * Read-only by construction: this module imports only the readers-only host
 * registry (src/hosts/index.ts) — no writer module loads with it — and
 * touches no file except reading configs and running `git rev-parse` /
 * `git ls-remote` against recorded sources. test/doctor-imports.test.ts
 * walks this module's import graph and fails if a writer appears in it.
 *
 * Three checks (AGENTS.md contract):
 *  (1) command resolution — every stdio server in each host's native MCP
 *      config AND in each installed plugin's mcp.json/.mcp.json: a command
 *      containing `/` must exist and be executable; a bare command is
 *      resolved on this process's PATH. On GUI hosts (cursor) a bare command
 *      is additionally flagged `!` with the hint `run plgnz pin` —
 *      macOS GUI apps have no shell PATH (spec §7.2.1 makes PATH
 *      participation client-defined).
 *  (2) shadow / duplicate — the same server name in a host's user-level MCP
 *      config and in an installed plugin's mcp.json is ✗: on codex the user
 *      entry wins and silently shadows the plugin server; on cursor both
 *      load and duplicate.
 *  (3) staleness — the installed plugin's recorded source sha (state.json,
 *      written by `add`) vs the source's current head: `git rev-parse` for a
 *      local checkout, `git ls-remote` for a git URL (recorded verbatim by
 *      `add`, so it is the same query the install was resolved with).
 *      Installs made by another tool have no record: report `unknown` —
 *      never treat a missing record as fresh or as zero.
 *
 * Output: one line per finding `<host>  ✓|✗|!  <message>`; `--json` emits
 * the same as an array; exit 1 if any ✗, else 0.
 *
 * Messages never include server args or env values — args can carry
 * credentials.
 */
import type { HostReader, McpServerEntry } from './host';
import { hosts as allHosts } from './hosts';
import { findRecord, readState, type InstallRecord } from './state';
import { expandRootPlaceholders, gitHead, gitRemoteHead, isExecutableFile, isGitUrl, resolveCommandPath, which } from './exec';
import { fingerprintInstallation, fingerprintSourceTree } from './fingerprint';

export type Mark = '✓' | '✗' | '!';

export interface DoctorFinding {
  host: string;
  mark: Mark;
  message: string;
  check?: 'content';
  pluginId?: string;
}

function contentFinding(host: string, pluginId: string, mark: Mark, message: string): DoctorFinding {
  return { host, pluginId, check: 'content', mark, message };
}

/** Verify source bytes and the activated native tree independently of git freshness. */
function checkContent(host: HostReader, state: InstallRecord[], out: DoctorFinding[]): void {
  const installed = new Map(host.listInstalled().map((plugin) => [plugin.id, plugin]));
  const records = state.filter((record) => record.host === host.id);
  for (const record of records) {
    if (record.pending !== undefined) {
      out.push(contentFinding(host.id, record.id, '!', `install '${record.id}' content unverified — ${record.pending} is pending`));
      continue;
    }
    const native = installed.get(record.id);
    if (native === undefined || native.enabled === false || native.path === undefined) {
      out.push(contentFinding(host.id, record.id, '✗', `install '${record.id}' content stale — enabled native representation is missing`));
      continue;
    }
    if (record.sourceDir === undefined || record.fingerprint === undefined || record.installedFingerprint === undefined) {
      out.push(contentFinding(host.id, record.id, '!', `install '${record.id}' content unverified — legacy record has no complete byte proof`));
      continue;
    }
    let sourceFingerprint: string;
    try { sourceFingerprint = fingerprintSourceTree(record.sourceDir); }
    catch (error) {
      out.push(contentFinding(host.id, record.id, '✗', `install '${record.id}' source content cannot be verified — ${(error as Error).message}`));
      continue;
    }
    if (sourceFingerprint !== record.fingerprint) {
      out.push(contentFinding(host.id, record.id, '✗', `install '${record.id}' source content changed since activation`));
      continue;
    }
    let nativeFingerprint: string;
    try { nativeFingerprint = fingerprintInstallation(native); }
    catch (error) {
      out.push(contentFinding(host.id, record.id, '✗', `install '${record.id}' native content cannot be verified — ${(error as Error).message}`));
      continue;
    }
    if (nativeFingerprint !== record.installedFingerprint) {
      out.push(contentFinding(host.id, record.id, '✗', `install '${record.id}' native content changed after activation`));
      continue;
    }
    out.push(contentFinding(host.id, record.id, '✓', `install '${record.id}' source and native content match their recorded byte proofs`));
  }
  for (const native of installed.values()) {
    if (records.some((record) => record.id === native.id)) continue;
    out.push(contentFinding(host.id, native.id, '!', `install '${native.id}' content unverified — no plgnz record`));
  }
}

export interface DoctorResult {
  findings: DoctorFinding[];
  exitCode: number;
}

function originLabel(entry: McpServerEntry): string {
  if (entry.origin === 'plugin' && entry.pluginId !== undefined) return `plugin ${entry.pluginId}`;
  if (entry.origin === 'plugin') return 'plugin';
  return 'user config';
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** sha equality tolerant of the host recording a short sha (claude-code records 12 chars). */
function sameSha(installed: string, head: string): boolean {
  const a = installed.toLowerCase();
  const b = head.toLowerCase();
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/** Check (1): every stdio command resolves and is executable. */
function checkCommands(host: HostReader, entries: McpServerEntry[], out: DoctorFinding[]): void {
  for (const entry of entries) {
    if (entry.transport !== 'stdio' || entry.command === undefined) continue;
    const label = originLabel(entry);
    const suffix = entry.enabled === false ? ' [disabled]' : '';
    // Host-native configs expand root placeholders at launch (spec §9.2 for
    // ${PLUGIN_ROOT}; CLAUDE_/CODEX_/CURSOR_ variants measured in real caches).
    // A known placeholder is expanded here so the real target is checked; an
    // unknown one makes the entry unverifiable — flagged `!`, not dead.
    let command = entry.command;
    if (command.includes('${')) {
      const result = expandRootPlaceholders(command, entry.baseDir);
      if (result.unknown !== null) {
        out.push({
          host: host.id,
          mark: '!',
          message: `server '${entry.name}': command contains placeholder ${result.unknown} that plgnz cannot expand — not verified (${label})${suffix}`,
        });
        continue;
      }
      command = result.expanded;
    }
    if (command.includes('/')) {
      const resolved = resolveCommandPath(command, entry.baseDir);
      if (isExecutableFile(resolved)) {
        out.push({ host: host.id, mark: '✓', message: `server '${entry.name}': command ok: ${resolved} (${label})${suffix}` });
      } else {
        out.push({
          host: host.id,
          mark: '✗',
          message: `server '${entry.name}': command not found or not executable: ${resolved} (${label})${suffix}`,
        });
      }
    } else {
      const resolved = which(entry.command);
      if (host.gui) {
        if (resolved === null) {
          out.push({
            host: host.id,
            mark: '✗',
            message: `server '${entry.name}': bare command '${entry.command}' not found on PATH (${label})${suffix}`,
          });
        } else {
          out.push({
            host: host.id,
            mark: '!',
            message:
              `server '${entry.name}': bare command '${entry.command}' may not resolve — macOS GUI apps have no shell PATH ` +
              `(spec §7.2.1); run plgnz pin${suffix}`,
          });
        }
      } else if (resolved !== null) {
        out.push({
          host: host.id,
          mark: '✓',
          message: `server '${entry.name}': bare command '${entry.command}' resolves to ${resolved} (${label})${suffix}`,
        });
      } else {
        out.push({
          host: host.id,
          mark: '✗',
          message: `server '${entry.name}': bare command '${entry.command}' not found on PATH (${label})${suffix}`,
        });
      }
    }
  }
}

/** Check (2): a server name defined both user-level and by an installed plugin. */
function checkShadows(host: HostReader, entries: McpServerEntry[], out: DoctorFinding[]): void {
  const userNames = new Set(entries.filter((e) => e.origin === 'user').map((e) => e.name));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.origin !== 'plugin' || entry.pluginId === undefined || !userNames.has(entry.name)) continue;
    const key = `${entry.name}\0${entry.pluginId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let behavior: string;
    if (host.id === 'codex') {
      behavior = 'on codex the user entry wins and silently shadows the plugin server';
    } else if (host.id === 'cursor') {
      behavior = 'on cursor both load and duplicate';
    } else {
      behavior = 'they shadow or duplicate each other';
    }
    out.push({
      host: host.id,
      mark: '✗',
      message: `server '${entry.name}' is defined both in user config and in plugin '${entry.pluginId}' — ${behavior}`,
    });
  }
}

/** Check (3): installed sha (state.json) vs the source's current head. */
function checkStaleness(host: HostReader, state: InstallRecord[], out: DoctorFinding[]): void {
  for (const install of host.listInstalled()) {
    const record = findRecord(state, host.id, install.id);
    if (record === undefined) {
      out.push({
        host: host.id,
        mark: '!',
        message: `install '${install.id}' staleness unknown — no record in state.json (installed by another tool?)`,
      });
      continue;
    }
    if (record.pending !== undefined) continue;
    // A git-URL source is recorded verbatim by `add` and has no local
    // checkout to rev-parse — its head comes from `git ls-remote`, the same
    // query that resolved the install (src/source.ts).
    const head = isGitUrl(record.source) ? gitRemoteHead(record.source) : gitHead(record.source);
    if (head === null) {
      out.push({
        host: host.id,
        mark: '!',
        message: `install '${install.id}' staleness unknown — cannot determine head of ${record.source}`,
      });
      continue;
    }
    if (sameSha(record.sourceSha, head)) {
      out.push({ host: host.id, mark: '✓', message: `install '${install.id}' is at source head ${shortSha(head)}` });
    } else {
      out.push({
        host: host.id,
        mark: '✗',
        message: `install '${install.id}' is stale — installed ${shortSha(record.sourceSha)}, source head ${shortSha(head)}`,
      });
    }
  }
}

export function runDoctor(hostList: HostReader[] = allHosts, state: InstallRecord[] = readState()): DoctorResult {
  const findings: DoctorFinding[] = [];
  const selected = new Set(hostList.map((host) => host.id));
  for (const record of state) {
    if (record.pending !== undefined && selected.has(record.host)) {
      findings.push({ host: record.host, mark: '!', message: `install '${record.id}' has pending ${record.pending} intent — retry the ${record.pending === 'remove' ? 'remove' : 'add/update'} operation` });
    }
  }
  for (const host of hostList) {
    if (!host.detect()) continue;
    const entries = host.mcpEntries();
    checkCommands(host, entries, findings);
    checkShadows(host, entries, findings);
    checkContent(host, state, findings);
    checkStaleness(host, state, findings);
  }
  const exitCode = findings.some((f) => f.mark === '✗') ? 1 : 0;
  return { findings, exitCode };
}

export function formatFinding(f: DoctorFinding): string {
  return `${f.host}  ${f.mark}  ${f.message}`;
}
