/** Transactional writer for OMP's native npm/link extension-package lane. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { projectPluginForOmp } from '../conversion';
import { omp, mcpCandidates, pluginsDir } from './omp';
import { pinPluginMcpFiles } from '../mcp-write';

const MARKER = '.plgnz-install.json';
const MANAGED = 'plgnz';
type Ownership = { source: string; pluginId: string; fingerprint: string; packageName: string };
type Doc = Record<string, unknown>;

declare const TextEncoder: { new (): { encode(input?: string): Uint8Array } };

export const ompWriter: HostWriter = {
  ...omp,
  supportsAdoption: true,
  plannedNativeId: (plugin) => `${plugin.name}@${plugin.marketplace ?? 'local'}`,
  legacyNativeIds: (plugin) => plugin.marketplace === undefined ? [plugin.name] : [],
  persistedNativeIdMayAlias: (persisted, requested) =>
    !persisted.includes('@') && (requested === persisted || requested === `${persisted}@local`),
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const market = plugin.marketplace ?? 'local'; const id = `${plugin.name}@${market}`;
    assertIdentity(market, 'marketplace'); assertIdentity(plugin.name, 'plugin');
    const packageName = nativePackageName(market, plugin.name); const version = plugin.version ?? resolved.sha;
    const managed = join(pluginsDir(), MANAGED); const target = join(managed, nativeSlug(market, plugin.name));
    const link = join(pluginsDir(), 'node_modules', '@plgnz', nativeSlug(market, plugin.name));
    const lockFile = join(pluginsDir(), 'omp-plugins.lock.json'); const registryFile = join(pluginsDir(), 'installed_plugins.json');
    const lock = readDoc(lockFile, { plugins: {}, settings: {} }, 'lockfile'); const lockPlugins = object(lock.plugins, 'lockfile plugins');
    const registry = readDoc(registryFile, { version: 2, plugins: {} }, 'registry'); const registryPlugins = object(registry.plugins, 'registry plugins');
    const rows = userRows(registryPlugins[id]);
    if (rows.length > 0) validateLegacy(rows, id, plugin.name, version, opts?.adoptExisting === true);
    const owner = ownership(target);
    if (owner === null && lstatExists(target)) throw new Error(`OMP managed package slot is unowned; refusing to replace it: ${target}`);
    if (owner !== null && (owner.source !== resolved.sourceUri || owner.pluginId !== id || owner.packageName !== packageName)) throw new Error(`OMP plugin ${id} belongs to another source; refusing to replace it`);
    assertOwnedLink(link, target, owner !== null);

    // Activation uses rename, so real installs must stage on the target's
    // filesystem. Dry-runs still project in system temp without creating a store.
    const stageParent = opts?.dryRun ? tmpdir() : managed;
    if (!opts?.dryRun) mkdirSafe(stageParent);
    const stage = mkdtempSync(join(stageParent, '.plgnz-omp-package-'));
    try {
      projectPluginForOmp(plugin.dir, stage, { packageName, version, activeRoot: target, namespace: plugin.name });
      writeFileSync(join(stage, MARKER), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '', packageName } satisfies Ownership));
      const unchanged = owner !== null && owner.fingerprint === (plugin.contentFingerprint ?? '') && sameTree(stage, target) && linkPointsTo(link, target) && lockEnabled(lockPlugins[packageName]);
      if (opts?.dryRun) return unchanged ? 'unchanged' : undefined;
      if (unchanged && rows.length === 0) return 'unchanged';

      mkdirSafe(managed); mkdirSafe(dirname(link));
      const beforeLock = snapshot(lockFile); const beforeRegistry = snapshot(registryFile);
      let active: Move | null = null; let previousLink: Move | null = null; let createdLink = false;
      try {
        if (!unchanged) active = activate(stage, target);
        if (!unchanged) previousLink = moveExisting(link);
        if (!unchanged) { symlinkSync(target, link, 'dir'); createdLink = true; }
        const nextLockPlugins = { ...lockPlugins, [packageName]: { ...entry(lockPlugins[packageName]), version, enabledFeatures: null, enabled: true } };
        const retained = nonUserRows(registryPlugins[id]);
        if (retained.length === 0) delete nextLockPlugins[plugin.name];
        const nextRegistryPlugins = { ...registryPlugins };
        if (retained.length > 0) nextRegistryPlugins[id] = retained; else delete nextRegistryPlugins[id];
        writeDoc(lockFile, { ...lock, plugins: nextLockPlugins });
        if (rows.length > 0) writeDoc(registryFile, { ...registry, plugins: nextRegistryPlugins });
      } catch (error) {
        if (createdLink) rmSync(link, { recursive: true, force: true }); previousLink?.rollback(); active?.rollback();
        restore(lockFile, beforeLock); restore(registryFile, beforeRegistry); throw error;
      }
      previousLink?.commit(); active?.commit();
      const retainedPaths = registryInstallPaths(nextRegistryPlugins(registryPlugins, id));
      for (const row of rows) cleanupLegacy(row, plugin.name, retainedPaths);
      return unchanged ? 'unchanged' : undefined;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    if (plugin.path === undefined || !existsSync(plugin.path)) return { changes: [], refusals: [] };
    return pinPluginMcpFiles(plugin.path, mcpCandidates(), opts);
  },
  async remove(id: string): Promise<void> {
    const owned = findOwned(id); if (owned === null) throw new Error(`OMP plugin ${id} is not plgnz-owned; refusing to remove it`);
    const lockFile = join(pluginsDir(), 'omp-plugins.lock.json'); const lock = readDoc(lockFile, { plugins: {}, settings: {} }, 'lockfile');
    const lockPlugins = object(lock.plugins, 'lockfile plugins'); const link = join(pluginsDir(), 'node_modules', owned.owner.packageName);
    if (!linkPointsTo(link, owned.path)) throw new Error(`OMP native link for ${id} is missing or redirected; refusing to remove it`);
    const before = snapshot(lockFile); let movedRoot: Move | null = null; let movedLink: Move | null = null;
    try { movedRoot = moveExisting(owned.path); movedLink = moveExisting(link); const next = { ...lockPlugins }; delete next[owned.owner.packageName]; writeDoc(lockFile, { ...lock, plugins: next }); }
    catch (error) { movedLink?.rollback(); movedRoot?.rollback(); restore(lockFile, before); throw error; }
    movedLink?.commit(); movedRoot?.commit();
  },
};

function nativePackageName(market: string, plugin: string): string { return `@plgnz/${nativeSlug(market, plugin)}`; }
function nativeSlug(market: string, plugin: string): string { return `${hex(market)}-${hex(plugin)}`; }
function hex(value: string): string { return Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join(''); }
function lockEnabled(value: unknown): boolean { return isDoc(value) && value.enabled === true; }
function entry(value: unknown): Doc { return isDoc(value) ? value : {}; }

function validateLegacy(rows: Array<Doc & { installPath?: unknown }>, id: string, name: string, version: string, adopt: boolean): void {
  if (!adopt) throw new Error(`OMP marketplace install ${id} exists; pass --adopt-existing to migrate it to the native extension-package lane`);
  const [marketplace] = id.split('@').slice(1); const cache = join(pluginsDir(), 'cache', 'plugins');
  for (const row of rows) {
    if (typeof row.installPath !== 'string' || typeof row.version !== 'string' || row.version !== version || marketplace === undefined) throw new Error(`OMP marketplace install ${id} has no safe native copy`);
    const expected = join(cache, `${marketplace}___${name}___${version}`);
    if (resolve(row.installPath) !== resolve(expected)) throw new Error(`OMP marketplace install ${id} is outside its approved cache slot`);
    assertExistingDirectoryTree(cache, row.installPath, `OMP marketplace install ${id}`);
    const manifest = readDoc(join(row.installPath, 'plugin.json'), {}, 'legacy plugin manifest');
    if (manifest.name !== name || (typeof manifest.version === 'string' && manifest.version !== version)) throw new Error(`OMP marketplace install ${id} identity differs from the selected source`);
  }
}
function cleanupLegacy(row: Doc & { installPath?: unknown }, name: string, retainedPaths: Set<string>): void {
  if (typeof row.installPath !== 'string' || retainedPaths.has(resolve(row.installPath))) return;
  const legacyLink = join(pluginsDir(), 'node_modules', name);
  if (linkPointsTo(legacyLink, row.installPath)) rmSync(legacyLink, { force: true });
  rmSync(row.installPath, { recursive: true, force: true });
}
function nextRegistryPlugins(registry: Doc, id: string): Doc { const next = { ...registry }; const retained = nonUserRows(registry[id]); if (retained.length > 0) next[id] = retained; else delete next[id]; return next; }
function registryInstallPaths(registry: Doc): Set<string> { const paths = new Set<string>(); for (const value of Object.values(registry)) if (Array.isArray(value)) for (const row of value) if (isDoc(row) && typeof row.installPath === 'string') paths.add(resolve(row.installPath)); return paths; }
function findOwned(id: string): { path: string; owner: Ownership } | null {
  const root = join(pluginsDir(), MANAGED); if (!existsSync(root)) return null;
  for (const name of readdirSync(root)) { const path = join(root, name); const owner = ownership(path); if (owner?.pluginId === id) return { path, owner }; }
  return null;
}
function assertOwnedLink(path: string, target: string, owned: boolean): void {
  if (!lstatExists(path)) return;
  if (!owned || !linkPointsTo(path, target)) throw new Error(`OMP native package slot is unowned or redirected: ${path}`);
}
function lstatExists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
function linkPointsTo(path: string, target: string): boolean { try { return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === resolve(target); } catch { return false; } }

type Move = { commit(): void; rollback(): void };
function moveExisting(path: string): Move | null {
  if (!lstatExists(path)) return null;
  const root = mkdtempSync(join(dirname(path), '.plgnz-omp-backup-')); const backup = join(root, 'previous'); renameSync(path, backup);
  return { commit: () => rmSync(root, { recursive: true, force: true }), rollback: () => { rmSync(path, { recursive: true, force: true }); renameSync(backup, path); rmSync(root, { recursive: true, force: true }); } };
}
function activate(stage: string, target: string): Move {
  const old = moveExisting(target);
  try {
    if (process.env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE'] === 'after-old-move') throw new Error('forced OMP activation failure');
    renameSync(stage, target);
  } catch (error) {
    old?.rollback();
    throw error;
  }
  return { commit: () => old?.commit(), rollback: () => { rmSync(target, { recursive: true, force: true }); old?.rollback(); } };
}
function mkdirSafe(path: string): void {
  const boundary = resolve(pluginsDir()); const target = resolve(path);
  if (target !== boundary && !target.startsWith(`${boundary}/`)) throw new Error(`OMP managed path escapes the plugin store: ${target}`);
  const parentBoundary = dirname(boundary);
  for (let current = target; ; current = dirname(current)) {
    if (lstatExists(current)) { const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OMP managed path is unsafe: ${current}`); }
    if (current === parentBoundary) break;
  }
  mkdirSync(path, { recursive: true }); let current = target;
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OMP managed path is unsafe: ${current}`);
    if (current === boundary) return;
    current = dirname(current);
  }
}
function assertExistingDirectoryTree(boundaryPath: string, targetPath: string, label: string): void {
  const boundary = resolve(boundaryPath); const target = resolve(targetPath);
  if (target !== boundary && !target.startsWith(`${boundary}/`)) throw new Error(`${label} escapes its approved cache root`);
  for (let current = target; ; current = dirname(current)) {
    if (!lstatExists(current)) throw new Error(`${label} has no safe native copy`);
    const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} contains a symlink or non-directory component: ${current}`);
    if (current === boundary) return;
  }
}
function sameTree(left: string, right: string): boolean {
  if (!existsSync(right)) return false; const bytes = readFileSync as unknown as (path: string) => Uint8Array;
  const list = (root: string): string[] => { const out: string[] = []; const walk = (dir: string, prefix: string): void => { for (const name of readdirSync(dir).sort()) { if (name === MARKER) continue; const path = join(dir, name); const rel = prefix ? `${prefix}/${name}` : name; const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`OMP managed plugin contains symlink: ${path}`); if (stat.isDirectory()) walk(path, rel); else if (stat.isFile()) out.push(`${rel}:${Array.from(bytes(path)).join(',')}`); else throw new Error(`OMP managed plugin contains unsupported file: ${path}`); } }; walk(root, ''); return out; };
  return JSON.stringify(list(left)) === JSON.stringify(list(right));
}
function ownership(path: string): Ownership | null { const marker = join(path, MARKER); if (!existsSync(marker)) return null; const value = readDoc(marker, {}, 'ownership marker'); if (typeof value.source !== 'string' || typeof value.pluginId !== 'string' || typeof value.fingerprint !== 'string' || typeof value.packageName !== 'string') throw new Error(`invalid plgnz ownership marker: ${marker}`); return value as Ownership; }
function readDoc(path: string, fallback: Doc, label: string): Doc { if (!existsSync(path)) return fallback; try { const value: unknown = JSON.parse(readFileSync(path, 'utf8')); if (!isDoc(value)) throw new Error('expected object'); return value; } catch (error) { throw new Error(`invalid OMP ${label}: ${path} (${(error as Error).message})`); } }
function object(value: unknown, label: string): Doc { if (!isDoc(value)) throw new Error(`invalid OMP ${label}`); return value; }
function isDoc(value: unknown): value is Doc { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function userRows(value: unknown): Array<Doc & { installPath?: unknown }> { return Array.isArray(value) ? value.filter((row): row is Doc & { installPath?: unknown } => isDoc(row) && row.scope === 'user') : []; }
function nonUserRows(value: unknown): unknown[] { return Array.isArray(value) ? value.filter(row => !isDoc(row) || row.scope !== 'user') : []; }
function writeDoc(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2)); }
function snapshot(path: string): string | undefined { return existsSync(path) ? readFileSync(path, 'utf8') : undefined; }
function restore(path: string, value: string | undefined): void { if (value === undefined) rmSync(path, { force: true }); else writeFileSync(path, value); }
function assertIdentity(value: string, label: string): void { if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(value)) throw new Error(`unsafe OMP ${label}: ${value}`); }
