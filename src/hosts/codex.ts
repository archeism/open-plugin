/**
 * codex host reader.
 *
 * Reader only — the writer (add/pin/remove) lives in
 * src/hosts/codex-writer.ts so loading a reader never evaluates writer code
 * (AGENTS.md: doctor is read-only by construction).
 *
 * Real store layout (measured 2026-09-16, evidence in docs/hosts/codex.md):
 *   ~/.codex/config.toml                          — [plugins."<name>@<marketplace>"] enabled = bool;
 *                                                    user-level [mcp_servers.<name>] (command/args
 *                                                    = stdio, url = HTTP)
 *   ~/.codex/plugins/cache/<marketplace>/<name>/<version>/  — install dirs
 *
 * Plugin MCP is declared via `.codex-plugin/plugin.json`'s `mcpServers`
 * member, which measured as a pointer string (`"./.mcp.json"`, never inline,
 * across 13 manifests) resolved against the plugin root; the plugins CLI also
 * writes spec `.mcp.json`/`mcp.json` copies — all are read, identical entries
 * deduped.
 *
 * Shadow semantics (measured): a user-level [mcp_servers.X] silently wins over
 * a plugin-provided server of the same name — see doctor check (2).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { which } from '../exec';
import type { HostReader, InstalledPlugin, McpServerEntry } from '../host';
import { codexHome } from '../paths';
import { collectPluginServers, type PluginMcpCandidate, type RawServerDef } from '../mcp';
import { spawnSync } from '../runtime';
import { singleInstanceTargetProfile } from '../target-profile';

export const codexTargetProfile = singleInstanceTargetProfile('codex');

/** Live `codex --version` evidence. Static consumer-profile metadata is not a probe. */
export type CodexVersionProbe =
  | { readonly kind: 'detected'; readonly version: string; readonly probeId: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unparseable' };

export function resolveCodexBinary(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env['OPEN_PLUGIN_CODEX_BIN'];
  const binary = explicit !== undefined && explicit.length > 0 ? explicit : which('codex');
  if (binary === null || !existsSync(binary)) return null;
  return binary;
}

export function probeCodexVersion(env: Record<string, string | undefined> = process.env): CodexVersionProbe {
  const binary = resolveCodexBinary(env);
  if (binary === null) return { kind: 'unknown' };
  let stdout = '';
  let exitCode = -1;
  try {
    const result = spawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    exitCode = result.exitCode;
    stdout = [...result.stdout].map((byte) => String.fromCharCode(byte)).join('').trim();
  } catch {
    return { kind: 'unknown' };
  }
  if (exitCode !== 0) return { kind: 'unknown' };
  const match = /^codex-cli (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(stdout);
  if (match === null) return { kind: 'unparseable' };
  const version = match[1];
  if (version === undefined) return { kind: 'unparseable' };
  return { kind: 'detected', version, probeId: `codex-cli:${version}` };
}

export function configFile(): string {
  return join(codexHome(), 'config.toml');
}

/**
 * Where a plugin declares MCP servers. `.codex-plugin/plugin.json` measured as
 * a *pointer* (`"mcpServers": "./.mcp.json"`), never inline, so pinning it is a
 * no-op — the pointed file is a spec candidate here and is pinned directly.
 */
export function mcpCandidates(): PluginMcpCandidate[] {
  return [
    { kind: 'inline', manifest: join('.codex-plugin', 'plugin.json') },
    { kind: 'spec', file: '.mcp.json' },
    { kind: 'spec', file: 'mcp.json' },
  ];
}

function parseConfig(): Record<string, unknown> | null {
  try {
    const parsed: unknown = parseToml(readFileSync(configFile(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function table(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Pick the install dir using Codex's `active_plugin_version`: `local` wins, then semver, then lexical fallback. */
function cacheDirFor(marketplace: string, name: string): string | undefined {
  const slot = join(codexHome(), 'plugins', 'cache', marketplace, name);
  if (!existsSync(slot)) return undefined;
  let best: string | undefined;
  for (const entry of readdirSync(slot)) {
    const candidate = join(slot, entry);
    try {
      if (!statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    if (best === undefined || comparePluginVersion(entry, best) > 0) best = entry;
  }
  return best === undefined ? undefined : join(slot, best);
}

function comparePluginVersion(left: string, right: string): number {
  if (left === 'local') return right === 'local' ? 0 : 1;
  if (right === 'local') return -1;
  const parse = (value: string): { numbers: number[]; prerelease?: string } | null => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u);
    return match === null ? null : { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], ...(match[4] === undefined ? {} : { prerelease: match[4] }) };
  };
  const l = parse(left);
  const r = parse(right);
  if (l !== null && r !== null) {
    for (let index = 0; index < 3; index += 1) if (l.numbers[index] !== r.numbers[index]) return (l.numbers[index] ?? 0) - (r.numbers[index] ?? 0);
    if (l.prerelease === undefined && r.prerelease !== undefined) return 1;
    if (l.prerelease !== undefined && r.prerelease === undefined) return -1;
    if (l.prerelease !== undefined && r.prerelease !== undefined) return comparePrerelease(l.prerelease, r.prerelease);
    return 0;
  }
  return left.localeCompare(right);
}

function comparePrerelease(left: string, right: string): number {
  const l = left.split('.'); const r = right.split('.');
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const a = l[index]; const b = r[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const an = /^\d+$/u.test(a); const bn = /^\d+$/u.test(b);
    if (an && bn) return Number(a) - Number(b);
    if (an) return -1;
    if (bn) return 1;
    return a.localeCompare(b);
  }
  return 0;
}

export const codex: HostReader = {
  id: 'codex',
  gui: false,

  detect(): boolean {
    return existsSync(codexHome());
  },

  stores(): string[] {
    return [join(codexHome(), 'plugins', 'cache')];
  },

  listInstalled(): InstalledPlugin[] {
    const config = parseConfig();
    if (config === null) return [];
    const plugins = table(config['plugins']);
    if (plugins === null) return [];
    const out: InstalledPlugin[] = [];
    for (const id of Object.keys(plugins)) {
      const def = table(plugins[id]);
      const enabled = !(def !== null && def['enabled'] === false);
      const at = id.indexOf('@');
      const name = at === -1 ? id : id.slice(0, at);
      const marketplace = at === -1 ? undefined : id.slice(at + 1);
      const path = enabled && marketplace !== undefined ? cacheDirFor(marketplace, name) : undefined;
      const plugin: InstalledPlugin = { id, name, enabled };
      if (marketplace !== undefined) plugin.marketplace = marketplace;
      if (path !== undefined) {
        plugin.path = path;
        const version = basename(path);
        if (version.length > 0) plugin.version = version;
      }
      out.push(plugin);
    }
    return out;
  },

  mcpEntries(): McpServerEntry[] {
    const config = parseConfig();
    if (config === null) return [];
    const entries: McpServerEntry[] = [];
    const userServers = table(config['mcp_servers']);
    if (userServers !== null) {
      for (const [name, value] of Object.entries(userServers)) {
        const def = table(value);
        if (def === null) continue;
        const defRecord = def as RawServerDef;
        const transport =
          typeof defRecord['url'] === 'string' ? 'http' : typeof defRecord['command'] === 'string' ? 'stdio' : null;
        if (transport === null) continue;
        const entry: McpServerEntry = {
          name,
          transport,
          origin: 'user',
          file: configFile(),
          baseDir: codexHome(),
        };
        const command = defRecord['command'];
        if (typeof command === 'string') entry.command = command;
        const rawArgs = defRecord['args'];
        if (Array.isArray(rawArgs)) entry.args = rawArgs.filter((a): a is string => typeof a === 'string');
        if (defRecord['enabled'] === false) entry.enabled = false;
        entries.push(entry);
      }
    }
    for (const plugin of this.listInstalled()) {
      if (plugin.path === undefined || !existsSync(plugin.path)) continue;
      entries.push(...collectPluginServers(plugin.id, plugin.path, mcpCandidates()));
    }
    return entries;
  },
};
