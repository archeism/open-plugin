/**
 * cursor host reader.
 *
 * Reader only — the writer (add/pin/remove) lives in
 * src/hosts/cursor-writer.ts so loading a reader never evaluates writer code
 * (AGENTS.md: doctor is read-only by construction).
 *
 * Real store layout (measured 2026-09-16, evidence in docs/hosts/cursor.md):
 *   ~/.cursor/mcp.json                      — user-level {mcpServers:{…}}
 *   ~/.cursor/plugins/local/<name>/         — dereferenced plugin copies (the route
 *                                              `npx plugins --target cursor` does NOT take;
 *                                              house evidence: install rejected)
 *   ~/.cursor/plugins/{cache,marketplaces}/ — cursor-native dirs, observed but not read in v0
 *
 * Plugin MCP is declared in `.mcp.json` (and a spec `mcp.json` copy) at the
 * plugin root. Cursor is a GUI host: `launchctl getenv PATH` is unset, so bare
 * commands cannot be assumed to resolve (spec §7.2.1) — doctor flags them and
 * `pin` rewrites them to absolute paths; `add` pins a fresh copy the same way.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HostReader, InstalledPlugin, McpServerEntry } from '../host';
import { cursorRoot } from '../paths';
import { collectPluginServers, collectUserServers, readJson, type PluginMcpCandidate } from '../mcp';
import { singleInstanceTargetProfile } from '../target-profile';

export const cursorTargetProfile = singleInstanceTargetProfile('cursor');

export function localDir(): string {
  return join(cursorRoot(), 'plugins', 'local');
}

/** Where a plugin copy may declare MCP servers, in cursor's priority order. */
export function mcpCandidates(): PluginMcpCandidate[] {
  return [
    { kind: 'spec', file: '.mcp.json' },
    { kind: 'spec', file: 'mcp.json' },
  ];
}

function userConfigFile(): string {
  return join(cursorRoot(), 'mcp.json');
}

export const cursor: HostReader = {
  id: 'cursor',
  gui: true,

  detect(): boolean {
    return existsSync(cursorRoot());
  },

  stores(): string[] {
    return [localDir()];
  },

  listInstalled(): InstalledPlugin[] {
    if (!existsSync(localDir())) return [];
    const out: InstalledPlugin[] = [];
    for (const entry of readdirSync(localDir())) {
      const dir = join(localDir(), entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const manifest = join(dir, '.cursor-plugin', 'plugin.json');
      if (!existsSync(manifest)) continue;
      const plugin: InstalledPlugin = { id: entry, name: entry, path: dir };
      const marketplace = ownershipMarketplace(dir, entry);
      if (marketplace !== undefined) plugin.marketplace = marketplace;
      const parsed = readJson(manifest);
      const version = parsed !== null ? parsed['version'] : undefined;
      if (typeof version === 'string') plugin.version = version;
      out.push(plugin);
    }
    return out;
  },

  mcpEntries(): McpServerEntry[] {
    const entries: McpServerEntry[] = [];
    entries.push(...collectUserServers(userConfigFile(), cursorRoot()));
    for (const plugin of this.listInstalled()) {
      if (plugin.path === undefined || !existsSync(plugin.path)) continue;
      entries.push(...collectPluginServers(plugin.id, plugin.path, mcpCandidates()));
    }
    return entries;
  },
};

/** Recover a collection identity only from a valid plgnz ownership marker. */
function ownershipMarketplace(dir: string, name: string): string | undefined {
  const marker = join(dir, '.plgnz-install.json');
  if (!existsSync(marker)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(marker, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const ownership = parsed as Record<string, unknown>;
    if (typeof ownership['source'] !== 'string' || typeof ownership['fingerprint'] !== 'string' || typeof ownership['pluginId'] !== 'string') return undefined;
    const prefix = `${name}@`;
    const marketplace = ownership['pluginId'].startsWith(prefix) ? ownership['pluginId'].slice(prefix.length) : undefined;
    return marketplace !== undefined && validIdentity(marketplace) ? marketplace : undefined;
  } catch {
    return undefined;
  }
}

function validIdentity(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}
