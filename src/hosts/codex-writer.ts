/**
 * codex host writer — add/pin/remove for the store documented in
 * docs/hosts/codex.md.
 *
 * A sibling of the reader module so doctor's import graph never loads writer
 * code (AGENTS.md: doctor is read-only by construction;
 * test/doctor-imports.test.ts pins it).
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import { readPluginManifest, type PluginSource, type ResolvedSource } from '../source';
import { codexHome } from '../paths';
import { codex, configFile, mcpCandidates } from './codex';
import { pinPluginMcpFiles } from '../mcp-write';
import { projectPluginForCodex } from '../conversion';

const OWNERSHIP = '.plgnz-install.json';

export const codexWriter: HostWriter = {
  ...codex,
  supportsAdoption: true,
  plannedNativeId: (plugin) => `${plugin.name}@${plugin.marketplace || 'local'}`,
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const marketplace = plugin.marketplace || 'local';
    const id = `${plugin.name}@${marketplace}`;
    const version = pluginVersion(plugin.dir);
    if (!validVersionSegment(version)) throw new Error(`unsafe Codex plugin version: ${version}`);
    const slot = join(codexHome(), 'plugins', 'cache', marketplace, plugin.name);
    const targetDir = join(slot, version);
    const configPath = configFile();
    assertManagedConfigPath(codexHome(), configPath);

    if (opts?.dryRun) {
      const stage = mkdtempSync(join(tmpdir(), 'plgnz-codex-dry-run-'));
      try {
        projectPluginForCodex(plugin.dir, stage);
        ensureNativeManifest(stage, plugin.name, version);
        validateStage(stage);
        writeFileSync(join(stage, OWNERSHIP), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '' }));
        assertManagedPath(codexHome(), slot);
        if (existsSync(slot)) {
          assertNoSymlinks(slot);
          assertNoWinningForeignVersion(slot, version, id, resolved.sourceUri);
          const marker = readOwnership(targetDir);
          if (marker !== null && (marker.source !== resolved.sourceUri || marker.pluginId !== id)) throw new Error(`codex cache slot ${targetDir} has a different owned source identity; refusing to replace it`);
          if (existsSync(targetDir) && marker === null && !sameTree(stage, targetDir)) {
            if (!opts.adoptExisting) throw new Error(`codex cache slot ${targetDir} is unowned and differs from the staged representation; pass --adopt-existing to take ownership explicitly`);
            validateCachedIdentity(targetDir, plugin.name, version);
          }
        }
      }
      finally { rmSync(stage, { recursive: true, force: true }); }
      console.log(`[codex] would activate directory: ${targetDir}`);
      console.log(`[codex] would update config: ${configPath}`);
      return;
    }
    assertManagedPath(codexHome(), slot);
    mkdirSync(slot, { recursive: true });
    assertNoSymlinks(slot);
    assertNoWinningForeignVersion(slot, version, id, resolved.sourceUri);
    const marker = readOwnership(targetDir);
    if (marker !== null && (marker.source !== resolved.sourceUri || marker.pluginId !== id)) throw new Error(`codex cache slot ${targetDir} has a different owned source identity; refusing to replace it`);
    const stage = mkdtempSync(join(slot, '.plgnz-stage-'));
    try {
      projectPluginForCodex(plugin.dir, stage);
      ensureNativeManifest(stage, plugin.name, version);
      validateStage(stage);
      writeFileSync(join(stage, OWNERSHIP), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '' }));
      const identicalUnowned = existsSync(targetDir) && marker === null && sameTree(stage, targetDir);
      if (existsSync(targetDir) && marker === null && !identicalUnowned) {
        if (!opts?.adoptExisting) throw new Error(`codex cache slot ${targetDir} is unowned and differs from the staged representation; pass --adopt-existing to take ownership explicitly`);
        validateCachedIdentity(targetDir, plugin.name, version);
      }
      const unchanged = marker !== null && marker.fingerprint === plugin.contentFingerprint && sameTree(stage, targetDir);
      if (unchanged) {
        const alreadyEnabled = isEnabled(configPath, id);
        try { if (!alreadyEnabled) enable(configPath, id); }
        finally { rmSync(stage, { recursive: true, force: true }); }
        return alreadyEnabled ? 'unchanged' : undefined;
      }
      const configBefore = readConfigSnapshot(configPath);
      const activation = activate(stage, targetDir, slot);
      try {
        enable(configPath, id);
      } catch (error) {
        try { restoreConfig(configPath, configBefore); }
        finally { activation.rollback(); }
        throw error;
      }
      // The new slot and config are now the active install. Backup disposal and
      // old-version cleanup may fail, but must never roll back by deleting the
      // new active slot after its backup has been partially or fully removed.
      activation.commit();
      cleanupOwnedVersions(slot, targetDir, id, resolved.sourceUri);
      return;
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }


  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    if (plugin.path === undefined || !existsSync(plugin.path)) return { changes: [], refusals: [] };
    return pinPluginMcpFiles(plugin.path, mcpCandidates(), opts);
  },
  async remove(id: string): Promise<void> {
    const configPath = configFile();
    assertManagedConfigPath(codexHome(), configPath);
    const at = id.indexOf('@');
    const owned: string[] = [];
    if (at !== -1) {
      const slot = join(codexHome(), 'plugins', 'cache', id.slice(at + 1), id.slice(0, at));
      if (existsSync(slot)) {
        assertNoSymlinks(slot);
        for (const version of readdirSync(slot)) {
          const candidate = join(slot, version);
          if (!statSync(candidate).isDirectory()) continue;
          if (readOwnership(candidate)?.pluginId === id) owned.push(candidate);
        }
      }
    }
    if (existsSync(configPath)) {
      const toml = readFileSync(configPath, 'utf8');
      const header = `[plugins."${id}"]`;
      const idx = toml.indexOf(header);
      if (idx !== -1) {
        const nextTable = toml.indexOf('\n[', idx + header.length);
        const end = nextTable === -1 ? toml.length : nextTable;
        const block = toml.slice(idx, end);
        const withoutEnabled = block.replace(/^enabled\s*=\s*(true|false)\s*\n?/mu, '');
        const remaining = withoutEnabled.slice(header.length).trim();
        const replacement = remaining === '' ? '' : `${withoutEnabled.trimEnd()}\nenabled = false\n`;
        writeFileSync(configPath, toml.slice(0, idx) + replacement + toml.slice(end));
      }
    }
    for (const candidate of owned) rmSync(candidate, { recursive: true, force: true });
  }
};

function enable(configPath: string, id: string): void {
    let toml = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    parseConfigToml(toml, configPath);

    let newToml = toml;
    const header = `[plugins."${id}"]`;
    const idx = toml.indexOf(header);
    if (idx !== -1) {
      const nextTable = toml.indexOf('\n[', idx + header.length);
      const blockEnd = nextTable !== -1 ? nextTable : toml.length;
      const block = toml.slice(idx, blockEnd);
      const enabled = /^([ \t]*enabled[ \t]*=[ \t]*)(true|false)([ \t]*(?:#.*)?)$/gmu;
      const matches = [...block.matchAll(enabled)];
      if (matches.length > 1) throw new Error(`duplicate enabled keys in Codex plugin config: ${id}`);
      if (matches[0]?.[2] === 'false') {
        const newBlock = block.replace(enabled, '$1true$3');
        newToml = toml.slice(0, idx) + newBlock + toml.slice(blockEnd);
      } else if (matches.length === 0) {
        newToml = toml.slice(0, idx + header.length) + '\nenabled = true' + toml.slice(idx + header.length);
      }
    } else {
      if (!newToml.endsWith('\n') && newToml.length > 0) newToml += '\n';
      newToml += `[plugins."${id}"]\nenabled = true\n`;
    }

    mkdirSync(dirname(configPath), { recursive: true });
    parseConfigToml(newToml, configPath);
    writeFileSync(configPath, newToml);
}

function parseConfigToml(text: string, path: string): void {
  if (text.trim() === '') return;
  try { parseToml(text); }
  catch (error) { throw new Error(`invalid Codex config TOML: ${path} (${(error as Error).message})`); }
}

function isEnabled(configPath: string, id: string): boolean {
  if (!existsSync(configPath)) return false;
  const toml = readFileSync(configPath, 'utf8');
  const header = `[plugins."${id}"]`;
  const idx = toml.indexOf(header);
  if (idx === -1) return false;
  const nextTable = toml.indexOf('\n[', idx + header.length);
  const block = toml.slice(idx, nextTable === -1 ? toml.length : nextTable);
  return !/^enabled\s*=\s*false\s*$/mu.test(block);
}

type ConfigSnapshot = { existed: false } | { existed: true; bytes: Uint8Array };

function readConfigSnapshot(path: string): ConfigSnapshot {
  if (!existsSync(path)) return { existed: false };
  const read = readFileSync as unknown as (file: string) => Uint8Array;
  return { existed: true, bytes: read(path) };
}

function restoreConfig(path: string, snapshot: ConfigSnapshot): void {
  if (!snapshot.existed) {
    rmSync(path, { force: true });
    return;
  }
  const write = writeFileSync as unknown as (file: string, bytes: Uint8Array) => void;
  write(path, snapshot.bytes);
}

function pluginVersion(dir: string): string {
  return readPluginManifest(dir)?.version ?? 'local';
}

function validVersionSegment(value: string): boolean {
  return value === 'local' || /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function readOwnership(dir: string): { source: string; pluginId: string; fingerprint: string } | null {
  const file = join(dir, OWNERSHIP);
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null) throw new Error('marker must be an object');
    const record = value as Record<string, unknown>;
    if (typeof record['source'] !== 'string' || typeof record['pluginId'] !== 'string' || typeof record['fingerprint'] !== 'string') throw new Error('marker fields are invalid');
    return { source: record['source'], pluginId: record['pluginId'], fingerprint: record['fingerprint'] };
  } catch (error) {
    throw new Error(`invalid plgnz ownership marker: ${file} (${(error as Error).message})`);
  }
}

function validateStage(stage: string): void {
  if (readPluginManifest(stage) === undefined) throw new Error('Codex stage has no Agent Plugins manifest');
  const skills = join(stage, 'skills');
  if (existsSync(skills) && !statSync(skills).isDirectory()) throw new Error('Codex stage skills path is not a directory');
}

function validateCachedIdentity(target: string, expectedName: string, expectedVersion: string): void {
  const candidates = [join(target, '.codex-plugin', 'plugin.json'), join(target, 'plugin.json'), join(target, '.plugin', 'plugin.json')];
  const manifest = candidates.find(existsSync);
  if (manifest === undefined) throw new Error(`unowned Codex cache slot has no manifest: ${target}`);
  const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid cached Codex manifest: ${manifest}`);
  const record = value as Record<string, unknown>;
  if (record['name'] === expectedName && record['version'] === expectedVersion) return;
  if (manifest === candidates[0] && record['name'] === expectedName && nativeBuildVariant(expectedVersion, record['version'])) {
    const canonical = candidates.slice(1).find(existsSync);
    if (canonical !== undefined) {
      const canonicalValue: unknown = JSON.parse(readFileSync(canonical, 'utf8'));
      if (typeof canonicalValue === 'object' && canonicalValue !== null && !Array.isArray(canonicalValue)) {
        const identity = canonicalValue as Record<string, unknown>;
        if (identity['name'] === expectedName && identity['version'] === expectedVersion) return;
      }
    }
  }
  throw new Error(`cached Codex manifest identity does not match ${expectedName}@${expectedVersion}`);
}

function nativeBuildVariant(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(expected)) return false;
  const base = expected.split('+')[0]!;
  return actual.startsWith(`${base}+`) && /^(?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*$/u.test(actual.slice(base.length + 1));
}

/** Codex's native loader requires its own manifest path; project only safe, relevant fields. */
function ensureNativeManifest(stage: string, fallbackName: string, fallbackVersion: string): void {
  const native = join(stage, '.codex-plugin', 'plugin.json');
  const sourceManifest = readPluginManifest(stage);
  if (sourceManifest === undefined) throw new Error('Codex stage has no Agent Plugins manifest');
  const name = sourceManifest.name ?? fallbackName;
  const version = sourceManifest.version ?? fallbackVersion;
  const description = sourceManifest.description ?? `Plugin ${name}`;
  let overlay: Record<string, unknown> = {};
  if (existsSync(native)) {
    const value: unknown = JSON.parse(readFileSync(native, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Codex native plugin manifest must be an object');
    overlay = value as Record<string, unknown>;
    if (overlay['name'] !== undefined && overlay['name'] !== name) throw new Error(`Codex native plugin name conflicts with Agent Plugins manifest: ${String(overlay['name'])}`);
    if (overlay['version'] !== undefined && overlay['version'] !== version) throw new Error(`Codex native plugin version conflicts with Agent Plugins manifest: ${String(overlay['version'])}`);
    if (overlay['skills'] !== undefined && overlay['skills'] !== './skills/' && overlay['skills'] !== './skills') {
      throw new Error(`unsupported Codex native skills pointer: ${String(overlay['skills'])}`);
    }
  }
  mkdirSync(dirname(native), { recursive: true });
  writeFileSync(native, JSON.stringify({ ...overlay, name, version, description, skills: overlay['skills'] ?? './skills/' }));
}

function assertManagedPath(root: string, target: string): void {
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`Codex managed path escapes its home: ${target}`);
  const suffix = target === root ? '' : target.slice(root.length + 1);
  let current = root;
  for (const part of ['', ...suffix.split('/').filter(Boolean)]) {
    if (part !== '') current = join(current, part);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Codex managed path component is a symlink: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Codex managed path component is not a directory: ${current}`);
  }
}

function assertManagedConfigPath(root: string, path: string): void {
  assertManagedPath(root, dirname(path));
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Codex managed config is a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`Codex managed config is not a file: ${path}`);
}

function activate(stage: string, target: string, slot: string): { commit(): void; rollback(): void } {
  if (!existsSync(target)) {
    renameSync(stage, target);
    return { commit: () => {}, rollback: () => rmSync(target, { recursive: true, force: true }) };
  }
  const backup = mkdtempSync(join(slot, '.plgnz-backup-'));
  const previous = join(backup, 'previous');
  renameSync(target, previous);
  try { renameSync(stage, target); }
  catch (error) {
    renameSync(previous, target);
    rmSync(backup, { recursive: true, force: true });
    throw error;
  }
  return {
    commit: () => rmSync(backup, { recursive: true, force: true }),
    rollback: () => {
      rmSync(target, { recursive: true, force: true });
      renameSync(previous, target);
      rmSync(backup, { recursive: true, force: true });
    },
  };
}

function sameTree(left: string, right: string): boolean {
  const listing = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (current: string, prefix: string): void => {
      for (const entry of readdirSync(current).sort()) {
        if (entry === OWNERSHIP) continue;
        const path = join(current, entry);
        const relative = prefix === '' ? entry : `${prefix}/${entry}`;
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path, relative);
        else if (stat.isFile()) out.push(`${relative}:${bytesKey(path)}`);
      }
    };
    walk(dir, '');
    return out;
  };
  return JSON.stringify(listing(left)) === JSON.stringify(listing(right));
}

function bytesKey(path: string): string {
  const read = readFileSync as unknown as (file: string) => Uint8Array;
  return Array.from(read(path)).join(',');
}

function assertNoWinningForeignVersion(slot: string, requested: string, id: string, source: string): void {
  for (const version of readdirSync(slot)) {
    const candidate = join(slot, version);
    if (!statSync(candidate).isDirectory() || version === requested) continue;
    const marker = readOwnership(candidate);
    if (wins(version, requested) && (marker?.pluginId !== id || marker.source !== source)) {
      throw new Error(`foreign Codex cache version ${version} would remain active over ${requested}`);
    }
  }
}

function cleanupOwnedVersions(slot: string, active: string, id: string, source: string): void {
  for (const version of readdirSync(slot)) {
    const candidate = join(slot, version);
    if (candidate === active || !statSync(candidate).isDirectory()) continue;
    const marker = readOwnership(candidate);
    if (marker?.pluginId === id && marker.source === source) rmSync(candidate, { recursive: true, force: true });
  }
}

function assertNoSymlinks(dir: string): void {
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Codex managed slot contains symlink: ${path}`);
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(dir);
}

function wins(left: string, right: string): boolean {
  if (left === 'local') return right !== 'local';
  if (right === 'local') return false;
  const parse = (value: string): { numbers: number[]; prerelease?: string } | null => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u);
    return match === null ? null : { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], ...(match[4] === undefined ? {} : { prerelease: match[4] }) };
  };
  const l = parse(left); const r = parse(right);
  if (l !== null && r !== null) {
    for (let i = 0; i < 3; i += 1) if (l.numbers[i] !== r.numbers[i]) return (l.numbers[i] ?? 0) > (r.numbers[i] ?? 0);
    if (l.prerelease === undefined && r.prerelease !== undefined) return true;
    if (l.prerelease !== undefined && r.prerelease === undefined) return false;
    if (l.prerelease !== undefined && r.prerelease !== undefined) return comparePrerelease(l.prerelease, r.prerelease) > 0;
    return false;
  }
  return left > right;
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
