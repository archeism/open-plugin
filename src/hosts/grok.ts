/** Grok Build reader. The writer is deliberately in grok-writer.ts. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { HostReader, InstalledPlugin, McpServerEntry } from '../host';
import type { TargetVersionObservation } from '../lifecycle-host';
import { grokRoot } from '../paths';
import { collectPluginServers } from '../mcp';
import { singleInstanceTargetProfile } from '../target-profile';

import { which } from '../runtime';

export const grokTargetProfile = singleInstanceTargetProfile('grok');

export const MARKER = '.plgnz-install.json';
export type GrokOwnership = {
  source: string;
  pluginId: string;
  fingerprint: string;
  nativeFingerprint?: string;
  scopeId?: string;
  sourceType?: string;
  immutableRevision?: string;
};

export function parseGrokVersionOutput(output: string, status: number | null): TargetVersionObservation {
  if (status === null) return { kind: 'unknown' };
  const line = output.split(/\r?\n/u).map((entry) => entry.trim()).find((entry) => entry.startsWith('grok '));
  const match = line === undefined ? null : /^grok (\d+\.\d+\.\d+)(?: \(([0-9A-Za-z]+)\))?$/u.exec(line);
  if (match === null || status !== 0) return status === 0 ? { kind: 'unparseable' } : { kind: 'unknown' };
  const version = match[1];
  if (version === undefined) return { kind: 'unparseable' };
  const build = match[2];
  return { kind: 'detected', version, probeId: build === undefined ? `grok:${version}` : `grok:${version}:${build}` };
}
type Repo = { path?: unknown; plugins?: unknown; kind?: unknown; marketplace?: unknown };

export function registryFile(): string { return join(grokRoot(), 'installed-plugins', 'registry.json'); }
export function marketplacesRoot(): string { return join(grokRoot(), 'plgnz-marketplaces'); }
export function configFile(): string { return join(grokRoot(), 'config.toml'); }
export function readJson(path: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(readFileSync(path, 'utf8')); return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
export function canonical(path: string): string | undefined { try { return realpathSync(path); } catch { return undefined; } }
export function ownership(root: string): GrokOwnership | null {
  const value = readJson(join(root, MARKER));
  if (value === null || typeof value['source'] !== 'string' || typeof value['pluginId'] !== 'string' || typeof value['fingerprint'] !== 'string') return null;
  return value as GrokOwnership;
}
export function repos(): Array<[string, Repo]> {
  const registry = readJson(registryFile());
  if (registry?.['version'] !== 1 || registry['repos'] === null || typeof registry['repos'] !== 'object' || Array.isArray(registry['repos'])) return [];
  return Object.entries(registry['repos'] as Record<string, unknown>).flatMap(([key, value]) => value !== null && typeof value === 'object' && !Array.isArray(value) ? [[key, value as Repo] as [string, Repo]] : []);
}
/** Absence is valid before first native install; a present registry must match the measured v1 shape. */
export function registryIsReadable(): boolean {
  if (!existsSync(registryFile())) return true;
  const registry = readJson(registryFile());
  return registry?.['version'] === 1 && registry['repos'] !== null && typeof registry['repos'] === 'object' && !Array.isArray(registry['repos']);
}
export function localSourceOf(repo: Repo): string | undefined {
  const kind = repo.kind;
  if (kind === null || typeof kind !== 'object' || Array.isArray(kind)) return undefined;
  const record = kind as Record<string, unknown>;
  return record['type'] === 'Local' && typeof record['source_path'] === 'string' ? record['source_path'] : undefined;
}
function marketplace(repo: Repo): { root: string; subdir: string; name?: string } | null {
  const value = repo.marketplace;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = (value as Record<string, unknown>)['source_url_or_path']; const subdir = (value as Record<string, unknown>)['plugin_subdir']; const name = (value as Record<string, unknown>)['source_display_name'];
  return typeof source === 'string' && typeof subdir === 'string' ? { root: source, subdir, ...(typeof name === 'string' ? { name } : {}) } : null;
}
function pluginNames(repo: Repo): string[] { return repo.plugins !== null && typeof repo.plugins === 'object' && !Array.isArray(repo.plugins) ? Object.keys(repo.plugins as Record<string, unknown>) : []; }
function disabledPlugins(): Set<string> {
  try {
    const config: unknown = parseToml(readFileSync(configFile(), 'utf8'));
    const plugins = config !== null && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>)['plugins'] : undefined;
    const disabled = plugins !== null && typeof plugins === 'object' && !Array.isArray(plugins) ? (plugins as Record<string, unknown>)['disabled'] : undefined;
    return new Set(Array.isArray(disabled) ? disabled.filter((value): value is string => typeof value === 'string') : []);
  } catch { return new Set(); }
}
function validMarker(repo: Repo, name: string, marker: GrokOwnership | null, provenance: { root: string; subdir: string; name?: string } | null, root: string | undefined): marker is GrokOwnership {
  if (marker === null || root === undefined || marker.source === '' || marker.pluginId.split('@', 1)[0] !== name || provenance?.subdir !== `plugins/${name}`) return false;
  return canonical(localSourceOf(repo) ?? '') === canonical(join(root, 'plugins', name));
}

export const grok: HostReader = {
  id: 'grok', gui: false,
  detect(): boolean { return existsSync(grokRoot()) || process.env['OPEN_PLUGIN_GROK_BIN'] !== undefined || which('grok') !== null; },
  stores(): string[] { return [join(grokRoot(), 'installed-plugins'), marketplacesRoot()]; },
  listInstalled(): InstalledPlugin[] {
    const out: InstalledPlugin[] = [];
    const disabled = disabledPlugins();
    for (const [, repo] of repos()) {
      if (typeof repo.path !== 'string' || !existsSync(repo.path)) continue;
      const provenance = marketplace(repo); const root = provenance === null ? undefined : canonical(provenance.root);
      const marker = root === undefined ? null : ownership(root);
      for (const name of pluginNames(repo)) {
        const id = validMarker(repo, name, marker, provenance, root) ? marker.pluginId : (provenance?.name === undefined ? name : `${name}@${provenance.name}`);
        const at = id.indexOf('@');
        out.push({ id, name: at < 0 ? id : id.slice(0, at), ...(at < 0 ? {} : { marketplace: id.slice(at + 1) }), path: repo.path, contentRoots: { native: repo.path }, enabled: !disabled.has(name) });
      }
    }
    return out;
  },
  mcpEntries(): McpServerEntry[] {
    return this.listInstalled().flatMap(plugin => plugin.path === undefined || plugin.enabled === false ? [] :
      collectPluginServers(plugin.id, plugin.path, [
        { kind: 'spec', file: '.mcp.json' },
        { kind: 'inline', manifest: 'plugin.json' },
      ]));
  },
};

export function provenanceOf(repo: Repo): { root: string; subdir: string; name?: string } | null { return marketplace(repo); }
export function namesOf(repo: Repo): string[] { return pluginNames(repo); }

