/**
 * kimi host reader.
 *
 * Reader only — the writer (add/pin/remove) lives in
 * src/hosts/kimi-writer.ts so loading a reader never evaluates writer code
 * (AGENTS.md: doctor is read-only by construction).
 *
 * Real store layout (measured 2026-09-16, evidence in docs/hosts/kimi.md):
 *   ~/.kimi-code/plugins/installed.json — {version:1, plugins:[{id, root, source,
 *                                           enabled, installedAt, updatedAt, originalSource}]}
 *   ~/.kimi-code/plugins/managed/<id>/  — install dirs (`.kimi-plugin/plugin.json`
 *                                           native manifest with inline `mcpServers`,
 *                                           plus spec `.plugin/plugin.json` and
 *                                           `.mcp.json`/`mcp.json` copies)
 *
 * User-level MCP would be `[mcp_servers.<name>]` in ~/.kimi-code/config.toml
 * (kimi is a TOML-config host like codex). None exist on this machine as of
 * 2026-09-16, so that half of the reader is defensive and its shadow
 * semantics are unverified — see docs/hosts/kimi.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { HostReader, InstalledPlugin, McpServerEntry } from '../host';
import { kimiRoot } from '../paths';
import { collectPluginServers, readJson, type PluginMcpCandidate, type RawServerDef } from '../mcp';
import { singleInstanceTargetProfile } from '../target-profile';

import { spawnSync as bunShapedSpawnSync } from '../runtime';

export const kimiTargetProfile = singleInstanceTargetProfile('kimi');

declare const TextDecoder: any;

export function pluginsDir(): string {
  return join(kimiRoot(), 'plugins');
}

/**
 * Where a plugin declares MCP servers. The native manifest carries them inline
 * (measured), ahead of the spec copies `npx plugins` also dereferences.
 */
export function mcpCandidates(): PluginMcpCandidate[] {
  return [
    { kind: 'inline', manifest: 'kimi.plugin.json' },
    { kind: 'inline', manifest: join('.kimi-plugin', 'plugin.json') },
    { kind: 'spec', file: '.mcp.json' },
    { kind: 'spec', file: 'mcp.json' },
  ];
}

function configFile(): string {
  return join(kimiRoot(), 'config.toml');
}

export const kimi: HostReader = {
  id: 'kimi',
  gui: false,

  detect(): boolean {
    return existsSync(kimiRoot()) || explicitCurrentKimiBinary();
  },

  stores(): string[] {
    return [join(pluginsDir(), 'managed')];
  },

  listInstalled(): InstalledPlugin[] {
    const root = readJson(join(pluginsDir(), 'installed.json'));
    if (root === null) return [];
    const plugins = root['plugins'];
    if (!Array.isArray(plugins)) return [];
    const out: InstalledPlugin[] = [];
    for (const raw of plugins) {
      if (typeof raw !== 'object' || raw === null) continue;
      const rec = raw as Record<string, unknown>;
      const id = typeof rec['id'] === 'string' ? rec['id'] : null;
      if (id === null) continue;
      const path = typeof rec['root'] === 'string' ? rec['root'] : undefined;
      const marker = path === undefined ? null : readJson(join(path, '.plgnz-install.json'));
      const markerId = marker?.['pluginId'];
      const ownedId = typeof markerId === 'string' && (markerId === id || new RegExp(`^${escapeRegExp(id)}@[a-z0-9][a-z0-9._-]*$`, 'iu').test(markerId)) ? markerId : id;
      const at = ownedId.indexOf('@');
      const plugin: InstalledPlugin = { id: ownedId, name: at < 0 ? ownedId : ownedId.slice(0, at) };
      if (at >= 0) plugin.marketplace = ownedId.slice(at + 1);
      if (path !== undefined && existsSync(path)) plugin.path = path;
      if (rec['enabled'] === false) plugin.enabled = false;
      out.push(plugin);
    }
    return out;
  },

  mcpEntries(): McpServerEntry[] {
    const entries: McpServerEntry[] = [];
    if (existsSync(configFile())) {
      try {
        const parsed: unknown = parseToml(readFileSync(configFile(), 'utf8'));
        const config = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
        const servers =
          config !== null && typeof config['mcp_servers'] === 'object' && config['mcp_servers'] !== null
            ? (config['mcp_servers'] as Record<string, unknown>)
            : null;
        if (servers !== null) {
          for (const [name, value] of Object.entries(servers)) {
            if (typeof value !== 'object' || value === null) continue;
            const def = value as RawServerDef;
            const transport =
              typeof def['url'] === 'string' ? 'http' : typeof def['command'] === 'string' ? 'stdio' : null;
            if (transport === null) continue;
            const entry: McpServerEntry = { name, transport, origin: 'user', file: configFile(), baseDir: kimiRoot() };
            const command = def['command'];
            if (typeof command === 'string') entry.command = command;
            const rawArgs = def['args'];
            if (Array.isArray(rawArgs)) entry.args = rawArgs.filter((a): a is string => typeof a === 'string');
            if (def['enabled'] === false) entry.enabled = false;
            entries.push(entry);
          }
        }
      } catch {
        // malformed config.toml — treated as no user-level MCP entries
      }
    }
    for (const plugin of this.listInstalled()) {
      if (plugin.path === undefined || !existsSync(plugin.path)) continue;
      entries.push(...collectPluginServers(plugin.id, plugin.path, mcpCandidates()));
    }
    return entries;
  },
};

/** An explicit current native binary is sufficient presence evidence; its writer initializes the selected root. */
function explicitCurrentKimiBinary(): boolean {
  const binary = process.env['OPEN_PLUGIN_KIMI_BIN'];
  if (!binary || !existsSync(binary)) return false;
  try {
    const result = bunShapedSpawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    if (result.exitCode !== 0 || !(result.stdout instanceof Uint8Array)) return false;
    const version = new TextDecoder().decode(result.stdout).trim();
    const match = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.exec(version);
    return match !== null && Number(match[1]) > 0;
  } catch { return false; }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
