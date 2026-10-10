/** Claude Code's native cache/registry writer. Kept separate from the read-only reader. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { tomlCommandMarkdown } from '../conversion';
import { claudeCode, mcpCandidates, pluginsDir } from './claude-code';
import { pinPluginMcpFiles } from '../mcp-write';

import { CryptoHasher } from '../runtime';

const OWNERSHIP = '.plgnz-install.json';
type Ownership = { source: string; pluginId: string; fingerprint: string; adopted?: true };
type Registry = { version: number; plugins: Record<string, unknown> };

export const claudeCodeWriter: HostWriter = {
  ...claudeCode,
  supportsAdoption: true,
  plannedNativeId: (plugin) => `${plugin.name}@${plugin.marketplace || 'local'}`,
  legacyNativeIds: (plugin) => plugin.marketplace === undefined ? [plugin.name] : [],
  persistedNativeIdMayAlias: (persisted, requested) =>
    !persisted.includes('@') && (requested === persisted || requested === `${persisted}@local`),
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const marketplace = plugin.marketplace || 'local';
    const id = `${plugin.name}@${marketplace}`;
    const version = resolved.sha;
    const slot = join(pluginsDir(), 'cache', marketplace, plugin.name);
    const registryFile = join(pluginsDir(), 'installed_plugins.json');
    const settingsFile = join(pluginsDir(), '..', 'settings.json');
    const marketplacesFile = join(pluginsDir(), 'known_marketplaces.json');
    const snapshotRoot = resolved.snapshotDir ?? resolved.sourceUri;
    const frozenSource = resolved.snapshot !== undefined;
    const wrapper = frozenSource || !existsSync(join(snapshotRoot, '.claude-plugin', 'marketplace.json')) ? join(pluginsDir(), 'marketplaces', `.plgnz-${marketplace}`) : undefined;
    for (const path of [slot, registryFile, settingsFile, marketplacesFile]) assertManagedPath(path);
    const registry = readRegistry(registryFile);
    const settings = readSettings(settingsFile);
    const marketplaces = readMarketplaces(marketplacesFile);
    const alreadyOwned = hasAdoptedRegistryInstall(registry, id, resolved.sourceUri, slot);
    const legacy = opts?.adoptExisting && !alreadyOwned ? validateLegacyUserInstall(registry, id, slot, plugin) : undefined;
    const owned = ownedRegistryTarget(registry, id, resolved.sourceUri, slot, version);
    const matchedCatalogMember = legacy === undefined && !alreadyOwned && !hasUserRegistryInstall(registry, id) &&
      matchesNativeCatalogMember(marketplaces, marketplace, plugin, resolved);
    const preserveNativeMarketplace = legacy !== undefined || alreadyOwned || matchedCatalogMember;
    const target = owned ??
      (legacy !== undefined && existsSync(join(slot, version)) && readOwnership(join(slot, version)) === null
        ? join(slot, `${version}.plgnz`)
        : join(slot, version));
    assertManagedPath(target);
    if (existsSync(target)) assertNoSymlinks(target);
    const existing = readOwnership(target);
    assertTargetIsReplaceable(target, existing, id, resolved.sourceUri);
    assertNoForeignRegistryEntry(registry, id, target, resolved.sourceUri, legacy);
    if (!preserveNativeMarketplace && wrapper !== undefined) assertManagedPath(wrapper);
    if (!preserveNativeMarketplace) validateMarketplaceRegistration(marketplaces, marketplace, snapshotRoot, resolved.sourceUri, plugin, frozenSource);
    if (opts?.dryRun) {
      const stage = mkdtempSync(join(tmpdir(), 'plgnz-claude-dry-run-'));
      try { stagePlugin(plugin.dir, stage, plugin.name, version); }
      finally { rmSync(stage, { recursive: true, force: true }); }
      console.log(`[claude-code] would activate directory: ${target}`);
      console.log(`[claude-code] would update registry: ${registryFile}`);
      return;
    }
    mkdirSync(slot, { recursive: true });
    assertManagedPath(slot);
    const stage = mkdtempSync(join(slot, '.plgnz-stage-'));
    const ownedWrapper = preserveNativeMarketplace ? undefined : wrapper;
    const wrapperSnapshot = ownedWrapper === undefined ? undefined : snapshotDirectory(ownedWrapper);
    let durable = false;
    try {
      stagePlugin(plugin.dir, stage, plugin.name, version);
      const nextMarketplaces = preserveNativeMarketplace ? undefined : marketplacesWithLocalSource(marketplaces, marketplace, snapshotRoot, resolved.sourceUri, plugin, frozenSource);
      writeFileSync(join(stage, OWNERSHIP), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '', ...(preserveNativeMarketplace ? { adopted: true } : {}) }));
      const unchanged = existing !== null && existing.fingerprint === (plugin.contentFingerprint ?? '') && sameTree(stage, target);
      if (unchanged) {
        try {
          writeRegistry(registryFile, registryWithEntry(registry, id, target, version, resolved));
          writeSettings(settingsFile, settingsWithEnabled(settings, id, true));
          if (nextMarketplaces !== undefined) writeMarketplaces(marketplacesFile, nextMarketplaces);
          durable = true;
        } catch (error) {
          restoreMetadata(registryFile, registry, settingsFile, settings, nextMarketplaces === undefined ? undefined : marketplacesFile, nextMarketplaces === undefined ? undefined : marketplaces);
          throw error;
        }
        return 'unchanged';
      }
      let activation: { commit(): void; rollback(): void } | undefined;
      try {
        activation = activate(stage, target, slot);
        writeRegistry(registryFile, registryWithEntry(registry, id, target, version, resolved));
        writeSettings(settingsFile, settingsWithEnabled(settings, id, true));
        if (nextMarketplaces !== undefined) writeMarketplaces(marketplacesFile, nextMarketplaces);
        durable = true;
      } catch (error) {
        activation?.rollback();
        restoreMetadata(registryFile, registry, settingsFile, settings, nextMarketplaces === undefined ? undefined : marketplacesFile, nextMarketplaces === undefined ? undefined : marketplaces);
        throw error;
      }
      // The registry is durable before old cache content is discarded. A cleanup
      // failure must never roll back the now-active target.
      activation.commit();
      cleanupPriorOwnedPaths(registry, id, target, resolved.sourceUri);
    } catch (error) {
      // Once metadata points at the new cache, cleanup errors must preserve the
      // durable activation rather than resurrecting its old wrapper.
      if (!durable) restoreDirectory(ownedWrapper, wrapperSnapshot);
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }
    finally {
      rmSync(stage, { recursive: true, force: true });
      if (wrapperSnapshot !== undefined) rmSync(wrapperSnapshot, { recursive: true, force: true });
    }
  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    if (plugin.path === undefined || !existsSync(plugin.path)) return { changes: [], refusals: [] };
    return pinPluginMcpFiles(plugin.path, mcpCandidates(), opts);
  },
  async remove(id: string): Promise<void> {
    const registryFile = join(pluginsDir(), 'installed_plugins.json');
    const settingsFile = join(pluginsDir(), '..', 'settings.json');
    for (const path of [registryFile, settingsFile]) assertManagedPath(path);
    const settings = readSettings(settingsFile);
    if (!existsSync(registryFile)) {
      const enabled = settings['enabledPlugins'];
      if (typeof enabled === 'object' && enabled !== null && !Array.isArray(enabled) && (enabled as Record<string, unknown>)[id] === true) writeSettings(settingsFile, settingsWithEnabled(settings, id, false));
      return;
    }
    const registry = readRegistry(registryFile);
    const row = registry.plugins[id];
    if (!Array.isArray(row)) return;
    const ownedRows = row.filter(record => typeof record === 'object' && record !== null && (record as Record<string, unknown>)['scope'] === 'user');
    const ownedPaths = ownedRows.flatMap(record => {
      if (typeof record !== 'object' || record === null) return [];
      const path = (record as Record<string, unknown>)['installPath'];
      return typeof path === 'string' && readOwnership(path)?.pluginId === id ? [path] : [];
    });
    if (ownedRows.length === 0 || ownedPaths.length !== ownedRows.length) throw new Error(`claude-code user registry entry ${id} is not wholly plgnz-owned; refusing to remove it`);
    const backups: Array<{ commit(): void; rollback(): void }> = [];
    try {
      for (const path of ownedPaths) backups.push(moveAside(path));
      const next: Registry = { ...registry, plugins: { ...registry.plugins } };
      const retained = row.filter(record => !ownedRows.includes(record));
      if (retained.length === 0) delete next.plugins[id]; else next.plugins[id] = retained;
      writeRegistry(registryFile, next);
      writeSettings(settingsFile, settingsWithEnabled(settings, id, false));
    } catch (error) {
      for (const backup of backups.reverse()) backup.rollback();
      restoreMetadata(registryFile, registry, settingsFile, settings);
      throw error;
    }
    // Do not attempt rollback after any deletion cleanup has begun: the
    // registry removal is already durable and the active state is correct.
    for (const backup of backups) backup.commit();
    const marketplacesFile = join(pluginsDir(), 'known_marketplaces.json');
    const marketplaces = readMarketplaces(marketplacesFile);
    const at = id.indexOf('@'); const market = at === -1 ? undefined : id.slice(at + 1);
    const entry = market ? marketplaces[market] as Record<string, unknown> | undefined : undefined;
    const path = entry?.['installLocation'];
    if (typeof path === 'string') {
      const plugin = id.slice(0, id.indexOf('@'));
      const copy = join(path, 'plugins', plugin);
      if (readOwnership(copy)?.pluginId === id) {
        rmSync(copy, { recursive: true, force: true });
        const manifest = join(path, '.claude-plugin', 'marketplace.json');
        if (existsSync(manifest)) {
          const document: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
          if (typeof document === 'object' && document !== null && !Array.isArray(document)) {
            const current = document as Record<string, unknown>;
            const entries = Array.isArray(current['plugins']) ? current['plugins'] : [];
            writeFileSync(manifest, JSON.stringify({ ...current, plugins: entries.filter(value => !(typeof value === 'object' && value !== null && (value as Record<string, unknown>)['name'] === plugin)) }, null, 2));
          }
        }
      }
      if (readOwnership(path)?.pluginId === `marketplace@${market}` && readdirSync(join(path, 'plugins')).length === 0) { rmSync(path, { recursive: true, force: true }); const next = { ...marketplaces }; delete next[market as string]; writeMarketplaces(marketplacesFile, next); }
    }
  },
};

function stagePlugin(source: string, stage: string, fallbackName: string, fallbackVersion: string): void {
  cpSync(source, stage, { recursive: true });
  assertNoSymlinks(stage);
  const root = join(stage, 'plugin.json');
  const canonical = join(stage, '.plugin', 'plugin.json');
  const manifest = existsSync(canonical) ? canonical : existsSync(root) ? root : undefined;
  if (manifest === undefined) throw new Error('Claude Code stage has no Agent Plugins manifest');
  const canonicalManifest = parseManifest(manifest, 'canonical');
  if (canonicalManifest.name !== fallbackName) throw new Error(`Claude Code canonical manifest name ${canonicalManifest.name} does not match selected plugin ${fallbackName}`);
  const native = join(stage, '.claude-plugin', 'plugin.json');
  if (!existsSync(native)) {
    mkdirSync(dirname(native), { recursive: true });
    writeFileSync(native, JSON.stringify({ name: canonicalManifest.name, version: canonicalManifest.version ?? fallbackVersion, description: canonicalManifest.description, skills: './skills/' }));
  }
  projectRootCommandsToNative(stage);
  projectNativeCommands(stage, native);
  const nativeManifest = parseManifest(native, 'Claude Code');
  if (nativeManifest.name !== canonicalManifest.name || (canonicalManifest.version !== undefined && nativeManifest.version !== canonicalManifest.version)) throw new Error('Claude Code native manifest identity does not match the canonical manifest');
  for (const path of [join(stage, 'skills'), join(stage, 'commands'), join(stage, '.claude', 'commands')]) {
    if (existsSync(path) && !statSync(path).isDirectory()) throw new Error(`Claude Code stage native content path is not a directory: ${path}`);
  }
  if (fallbackName.length === 0) throw new Error('Claude Code plugin name is empty');
}

/** Root command sources map into Claude Code's native discovery path when
 * the package has no explicit .claude/commands tree (spec §2): Markdown
 * commands pass through and TOML prompt commands convert there. The
 * package's own command bytes are never modified — Claude Code installs are
 * byte-preserving. */
function projectRootCommandsToNative(stage: string): void {
  const nativeCommands = join(stage, '.claude', 'commands');
  if (existsSync(nativeCommands)) return;
  const rootCommands = join(stage, 'commands');
  if (!existsSync(rootCommands)) return;
  const entries = readdirSync(rootCommands).sort();
  const markdown = entries.filter((file) => file.endsWith('.md'));
  const toml = entries.filter((file) => file.endsWith('.toml'));
  if (markdown.length === 0 && toml.length === 0) return;
  mkdirSync(nativeCommands, { recursive: true });
  for (const file of markdown) cpSync(join(rootCommands, file), join(nativeCommands, file));
  if (markdown.length > 0) return;
  for (const file of toml) {
    const projected = tomlCommandMarkdown(join(rootCommands, file));
    writeFileSync(join(nativeCommands, `${projected.name}.md`), projected.text);
  }
}

/** Claude Code only discovers plugin commands from an explicit manifest list. */
function projectNativeCommands(stage: string, native: string): void {
  const commandsRoot = join(stage, '.claude', 'commands');
  if (!existsSync(commandsRoot)) return;
  const commands = readdirSync(commandsRoot).filter(file => file.endsWith('.md')).sort().map(file => `./.claude/commands/${file}`);
  if (commands.length === 0) return;
  const parsed: unknown = JSON.parse(readFileSync(native, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid Claude Code manifest');
  const manifest = parsed as Record<string, unknown>;
  if (manifest['commands'] !== undefined) {
    const listed = manifest['commands'];
    if (!Array.isArray(listed) || !commands.every(command => listed.includes(command))) throw new Error('Claude Code manifest does not enumerate every native Markdown command');
    return;
  }
  manifest['commands'] = commands;
  writeFileSync(native, JSON.stringify(manifest, null, 2));
}

function parseManifest(file: string, kind: string): { name: string; version?: string; description?: string } {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid ${kind} manifest: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${kind} manifest`);
  const manifest = value as Record<string, unknown>;
  if (typeof manifest['name'] !== 'string' || manifest['name'] === '') throw new Error(`Invalid ${kind} manifest identity`);
  if (manifest['version'] !== undefined && (typeof manifest['version'] !== 'string' || manifest['version'] === '')) throw new Error(`Invalid ${kind} manifest identity`);
  return { name: manifest['name'], ...(typeof manifest['version'] === 'string' ? { version: manifest['version'] } : {}), ...(typeof manifest['description'] === 'string' ? { description: manifest['description'] } : {}) };
}

function readRegistry(file: string): Registry {
  if (!existsSync(file)) return { version: 2, plugins: {} };
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid Claude Code plugin registry: ${file} (${error instanceof Error ? error.message : String(error)})`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid Claude Code plugin registry: ${file}`);
  const root = value as Record<string, unknown>;
  if (typeof root['plugins'] !== 'object' || root['plugins'] === null || Array.isArray(root['plugins'])) throw new Error(`Invalid Claude Code plugin registry: ${file}`);
  return { version: typeof root['version'] === 'number' ? root['version'] : 2, plugins: root['plugins'] as Record<string, unknown> };
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid Claude Code settings: ${file} (${error instanceof Error ? error.message : String(error)})`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid Claude Code settings: ${file}`);
  const settings = value as Record<string, unknown>;
  if (settings['enabledPlugins'] !== undefined && (typeof settings['enabledPlugins'] !== 'object' || settings['enabledPlugins'] === null || Array.isArray(settings['enabledPlugins']))) throw new Error(`Invalid Claude Code enabledPlugins setting: ${file}`);
  return settings;
}

function readMarketplaces(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid Claude Code marketplace registry: ${file} (${error instanceof Error ? error.message : String(error)})`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid Claude Code marketplace registry: ${file}`);
  return value as Record<string, unknown>;
}

function marketplacesWithLocalSource(marketplaces: Record<string, unknown>, name: string, sourcePath: string, sourceIdentity: string, plugin: PluginSource, forceWrapper: boolean): Record<string, unknown> {
  const manifest = join(sourcePath, '.claude-plugin', 'marketplace.json');
  const catalog = validateMarketplaceRegistration(marketplaces, name, sourcePath, sourceIdentity, plugin, forceWrapper);
  if (forceWrapper || !existsSync(manifest)) {
    const marker = join(catalog, OWNERSHIP);
    const copy = join(catalog, 'plugins', plugin.name);
    rmSync(copy, { recursive: true, force: true });
    cpSync(plugin.dir, copy, { recursive: true });
    writeFileSync(join(copy, OWNERSHIP), JSON.stringify({ source: sourceIdentity, pluginId: `${plugin.name}@${name}`, fingerprint: plugin.contentFingerprint ?? '' }));
    mkdirSync(join(catalog, '.claude-plugin'), { recursive: true });
    const current = existsSync(join(catalog, '.claude-plugin', 'marketplace.json')) ? JSON.parse(readFileSync(join(catalog, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins?: unknown[] } : {};
    const plugins = Array.isArray(current.plugins) ? current.plugins.filter(entry => !(typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['name'] === plugin.name)) : [];
    plugins.push({ name: plugin.name, source: `./plugins/${plugin.name}` });
    writeFileSync(join(catalog, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name, owner: { name: 'plgnz' }, plugins }));
    writeFileSync(marker, JSON.stringify({ source: 'plgnz-wrapper', pluginId: `marketplace@${name}`, fingerprint: '' }));
  }
  let document: unknown;
  try { document = JSON.parse(readFileSync(join(catalog, '.claude-plugin', 'marketplace.json'), 'utf8')); }
  catch (error) { throw new Error(`Invalid Claude Code marketplace manifest: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof document !== 'object' || document === null || (document as Record<string, unknown>)['name'] !== name) throw new Error(`Claude Code marketplace manifest identity does not match ${name}`);
  return { ...marketplaces, [name]: { source: { source: 'directory', path: catalog }, installLocation: catalog, lastUpdated: new Date().toISOString() } };
}

/** Read-only preflight shared by real activation and dry-run. */
function validateMarketplaceRegistration(marketplaces: Record<string, unknown>, name: string, sourcePath: string, sourceIdentity: string, plugin: PluginSource, forceWrapper: boolean): string {
  if (!sourcePath.startsWith('/')) throw new Error(`Claude Code marketplace registration for remote source ${name} is unverified`);
  const manifest = join(sourcePath, '.claude-plugin', 'marketplace.json');
  const catalog = !forceWrapper && existsSync(manifest) ? sourcePath : join(pluginsDir(), 'marketplaces', `.plgnz-${name}`);
  if (!existsSync(manifest) && existsSync(catalog)) {
    assertNoSymlinks(catalog);
    const wrapper = readOwnership(catalog);
    if (wrapper?.pluginId !== `marketplace@${name}` || wrapper.source !== 'plgnz-wrapper') throw new Error(`Claude Code marketplace wrapper ${catalog} is foreign; refusing to replace it`);
    const copy = join(catalog, 'plugins', plugin.name);
    if (existsSync(copy) && readOwnership(copy)?.source !== sourceIdentity) throw new Error(`Claude Code marketplace wrapper plugin ${copy} is foreign; refusing to replace it`);
  }
  if (existsSync(join(catalog, '.claude-plugin', 'marketplace.json'))) {
    let document: unknown;
    try { document = JSON.parse(readFileSync(join(catalog, '.claude-plugin', 'marketplace.json'), 'utf8')); }
    catch (error) { throw new Error(`Invalid Claude Code marketplace manifest: ${error instanceof Error ? error.message : String(error)}`); }
    if (typeof document !== 'object' || document === null || (document as Record<string, unknown>)['name'] !== name) throw new Error(`Claude Code marketplace manifest identity does not match ${name}`);
  }
  const existing = marketplaces[name];
  if (typeof existing === 'object' && existing !== null) {
    const previous = ((existing as Record<string, unknown>)['source'] as Record<string, unknown> | undefined)?.['path'];
    if (typeof previous === 'string' && previous !== catalog && previous !== sourceIdentity) throw new Error(`Claude Code marketplace ${name} is registered from a different source; refusing to replace it`);
  }
  return catalog;
}

/** Restore durable metadata without letting a restoration failure strand a cache swap. */
function restoreMetadata(registryFile: string, registry: Registry, settingsFile: string, settings: Record<string, unknown>, marketplacesFile?: string, marketplaces?: Record<string, unknown>): void {
  try { writeRegistry(registryFile, registry); } catch { /* the failed atomic write left this file untouched */ }
  try { writeSettings(settingsFile, settings); } catch { /* preserve the original operation error */ }
  if (marketplacesFile !== undefined && marketplaces !== undefined) {
    try { writeMarketplaces(marketplacesFile, marketplaces); } catch { /* preserve the original operation error */ }
  }
}

/** Snapshot an owned wrapper so wrapper, cache, and registries share one rollback boundary. */
function snapshotDirectory(directory: string): string | undefined {
  if (!existsSync(directory)) return undefined;
  assertNoSymlinks(directory);
  const snapshot = mkdtempSync(join(tmpdir(), 'plgnz-claude-wrapper-'));
  cpSync(directory, join(snapshot, 'previous'), { recursive: true });
  return snapshot;
}

function restoreDirectory(directory: string | undefined, snapshot: string | undefined): void {
  if (directory === undefined) return;
  rmSync(directory, { recursive: true, force: true });
  const previous = snapshot === undefined ? undefined : join(snapshot, 'previous');
  if (previous !== undefined && existsSync(previous)) {
    mkdirSync(dirname(directory), { recursive: true });
    renameSync(previous, directory);
  }
}

function settingsWithEnabled(settings: Record<string, unknown>, id: string, enabled: boolean): Record<string, unknown> {
  const prior = settings['enabledPlugins'];
  const plugins = typeof prior === 'object' && prior !== null && !Array.isArray(prior) ? prior as Record<string, unknown> : {};
  return { ...settings, enabledPlugins: { ...plugins, [id]: enabled } };
}

function registryWithEntry(registry: Registry, id: string, installPath: string, version: string, resolved: ResolvedSource): Registry {
  const now = new Date().toISOString();
  const prior = Array.isArray(registry.plugins[id]) ? registry.plugins[id] : [];
  const user = prior.find(value => typeof value === 'object' && value !== null && (value as Record<string, unknown>)['scope'] === 'user');
  const entry: Record<string, unknown> = typeof user === 'object' && user !== null ? { ...(user as Record<string, unknown>) } : { scope: 'user', installedAt: now };
  entry['installPath'] = installPath; entry['version'] = version; entry['lastUpdated'] = now;
  if (resolved.isGit) entry['gitCommitSha'] = resolved.sha; else delete entry['gitCommitSha'];
  let replaced = false;
  const rows = prior.map(value => {
    if (!replaced && typeof value === 'object' && value !== null && (value as Record<string, unknown>)['scope'] === 'user') { replaced = true; return entry; }
    return value;
  });
  if (!replaced) rows.push(entry);
  return { ...registry, plugins: { ...registry.plugins, [id]: rows } };
}

function writeRegistry(file: string, registry: Registry): void {
  writeJsonAtomically(file, registry);
}

function writeSettings(file: string, settings: Record<string, unknown>): void {
  writeJsonAtomically(file, settings);
}

function writeMarketplaces(file: string, marketplaces: Record<string, unknown>): void {
  writeJsonAtomically(file, marketplaces);
}

function writeJsonAtomically(file: string, value: unknown): void {
  assertManagedPath(file);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.plgnz-${Date.now()}`;
  assertManagedPath(temp);
  try { writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}

function assertNoForeignRegistryEntry(registry: Registry, id: string, target: string, source: string, adoptedLegacy?: string): void {
  const rows = registry.plugins[id]; if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || (row as Record<string, unknown>)['scope'] !== 'user') continue;
    const path = (row as Record<string, unknown>)['installPath'];
    if (typeof path !== 'string' || path === target || !existsSync(path)) continue;
    if (path === adoptedLegacy) continue;
    const ownership = readOwnership(path);
    if (ownership?.pluginId !== id || ownership.source !== source) throw new Error(`claude-code user install ${id} points at ${path}; refusing to replace it`);
  }
}

/** A legacy native row may be superseded only through explicit adoption. The old cache is never marked or removed. */
function validateLegacyUserInstall(registry: Registry, id: string, slot: string, plugin: PluginSource): string | undefined {
  const rows = Array.isArray(registry.plugins[id]) ? registry.plugins[id] : [];
  const users = rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && (row as Record<string, unknown>)['scope'] === 'user');
  if (users.length === 0) return undefined;
  if (users.length !== 1) throw new Error(`claude-code user install ${id} is ambiguous; refusing adoption`);
  const row = users[0]!;
  const path = row['installPath'];
  if (typeof path !== 'string' || dirname(path) !== slot || !existsSync(path)) throw new Error(`claude-code user install ${id} is outside its native cache slot; refusing adoption`);
  assertNoSymlinks(path);
  if (readOwnership(path) !== null) throw new Error(`claude-code user install ${id} is already owned; refusing legacy adoption`);
  const manifest = parseManifest(join(path, '.claude-plugin', 'plugin.json'), 'existing native');
  const selected = parseManifest(join(plugin.dir, 'plugin.json'), 'selected canonical');
  if (manifest.name !== plugin.name || manifest.version === undefined || manifest.version !== selected.version || row['version'] !== manifest.version) {
    throw new Error(`claude-code user install ${id} native identity does not match the selected plugin; refusing adoption`);
  }
  return path;
}

/** Once a marker-owned adoption is active, updates keep using its registry-selected sibling slot. */
function ownedRegistryTarget(registry: Registry, id: string, source: string, slot: string, version: string): string | undefined {
  const rows = Array.isArray(registry.plugins[id]) ? registry.plugins[id] : [];
  const users = rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && (row as Record<string, unknown>)['scope'] === 'user');
  if (users.length !== 1) return undefined;
  const path = users[0]!['installPath'];
  if (typeof path !== 'string' || dirname(path) !== slot || path !== join(slot, `${version}.plgnz`) || !existsSync(path)) return undefined;
  const ownership = readOwnership(path);
  return ownership?.pluginId === id && ownership.source === source ? path : undefined;
}

/** A later source SHA gets a new cache slot but retains the native marketplace established before adoption. */
function hasAdoptedRegistryInstall(registry: Registry, id: string, source: string, slot: string): boolean {
  const rows = Array.isArray(registry.plugins[id]) ? registry.plugins[id] : [];
  const users = rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && (row as Record<string, unknown>)['scope'] === 'user');
  if (users.length !== 1) return false;
  const path = users[0]!['installPath'];
  if (typeof path !== 'string' || dirname(path) !== slot || !existsSync(path)) return false;
  const ownership = readOwnership(path);
  return ownership?.pluginId === id && ownership.source === source && ownership.adopted === true;
}

function hasUserRegistryInstall(registry: Registry, id: string): boolean {
  const rows = registry.plugins[id];
  return Array.isArray(rows) && rows.some(row => typeof row === 'object' && row !== null && (row as Record<string, unknown>)['scope'] === 'user');
}

/** A new member may keep a native catalog only if that catalog delivers identical staged bytes. */
function matchesNativeCatalogMember(marketplaces: Record<string, unknown>, name: string, plugin: PluginSource, resolved: ResolvedSource): boolean {
  const registration = marketplaces[name];
  if (typeof registration !== 'object' || registration === null || Array.isArray(registration)) return false;
  const record = registration as Record<string, unknown>;
  const source = record['source'];
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return false;
  const sourceRecord = source as Record<string, unknown>;
  const catalog = sourceRecord['path'];
  if (sourceRecord['source'] !== 'directory' || typeof catalog !== 'string' || catalog !== record['installLocation'] || !catalog.startsWith('/') || catalog === resolved.sourceUri) return false;
  if (!containedPath(resolved.sourceUri, plugin.sourceDir ?? plugin.dir)) return false;
  const manifest = join(catalog, '.claude-plugin', 'marketplace.json');
  if (!existsSync(manifest)) return false;
  assertCatalogPath(catalog, manifest);
  let document: unknown;
  try { document = JSON.parse(readFileSync(manifest, 'utf8')); } catch { return false; }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return false;
  const catalogManifest = document as Record<string, unknown>;
  if (catalogManifest['name'] !== name || !Array.isArray(catalogManifest['plugins'])) return false;
  const selected = catalogManifest['plugins'].filter(item => typeof item === 'object' && item !== null && (item as Record<string, unknown>)['name'] === plugin.name);
  if (selected.length !== 1) return false;
  const memberSource = (selected[0] as Record<string, unknown>)['source'];
  if (typeof memberSource !== 'string' || !memberSource.startsWith('./')) return false;
  const nativeDir = resolve(catalog, memberSource);
  if (!containedPath(catalog, nativeDir) || nativeDir === resolve(catalog)) return false;
  assertCatalogPath(catalog, nativeDir);
  if (!existsSync(nativeDir) || !lstatSync(nativeDir).isDirectory()) return false;
  const stages = mkdtempSync(join(tmpdir(), 'plgnz-claude-catalog-proof-'));
  try {
    const incoming = join(stages, 'incoming');
    const native = join(stages, 'native');
    stagePlugin(plugin.dir, incoming, plugin.name, resolved.sha);
    stagePlugin(nativeDir, native, plugin.name, resolved.sha);
    return sameTree(incoming, native);
  } finally { rmSync(stages, { recursive: true, force: true }); }
}

function containedPath(root: string, path: string): boolean {
  if (!root.startsWith('/') || !path.startsWith('/')) return false;
  const suffix = relative(resolve(root), resolve(path));
  return suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\');
}

function assertCatalogPath(root: string, path: string): void {
  if (!containedPath(root, path)) throw new Error(`Claude Code native catalog member escapes catalog: ${path}`);
  const target = resolve(path);
  let current = resolve(root);
  for (const part of ['', ...relative(current, target).split('/').filter(Boolean)]) {
    if (part !== '') current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Claude Code native catalog path contains symlink: ${current}`);
    if (current !== target && !stat.isDirectory()) throw new Error(`Claude Code native catalog path is not a directory: ${current}`);
  }
}

function assertTargetIsReplaceable(target: string, ownership: Ownership | null, id: string, source: string): void {
  if (existsSync(target) && ownership === null) throw new Error(`claude-code cache slot ${target} is unowned; refusing to replace it`);
  if (ownership !== null && (ownership.pluginId !== id || ownership.source !== source)) throw new Error(`claude-code cache slot ${target} has a different owned source identity; refusing to replace it`);
}

/** Check only path components this operation will read or write, including dangling links. */
function assertManagedPath(path: string): void {
  const root = resolve(join(pluginsDir(), '..'));
  const target = resolve(path);
  const suffix = relative(root, target);
  if (suffix === '..' || suffix.startsWith('../') || suffix.startsWith('..\\')) throw new Error(`Claude Code managed path escapes its root: ${path}`);
  let current = root;
  for (const part of ['', ...suffix.split('/').filter(Boolean)]) {
    if (part !== '') current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Claude Code managed path component is a symlink: ${current}`);
    if (current !== target && !stat.isDirectory()) throw new Error(`Claude Code managed path component is not a directory: ${current}`);
  }
}

function cleanupPriorOwnedPaths(registry: Registry, id: string, active: string, source: string): void {
  const rows = registry.plugins[id];
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const path = (row as Record<string, unknown>)['installPath'];
    if (typeof path !== 'string' || path === active || !existsSync(path)) continue;
    const ownership = readOwnership(path);
    if (ownership?.pluginId === id && ownership.source === source) rmSync(path, { recursive: true, force: true });
  }
}

function readOwnership(dir: string): Ownership | null {
  const file = join(dir, OWNERSHIP); if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    return typeof value['source'] === 'string' && typeof value['pluginId'] === 'string' && typeof value['fingerprint'] === 'string' && (value['adopted'] === undefined || value['adopted'] === true) ? { source: value['source'], pluginId: value['pluginId'], fingerprint: value['fingerprint'], ...(value['adopted'] === true ? { adopted: true } : {}) } : null;
  } catch { return null; }
}

function activate(stage: string, target: string, slot: string): { commit(): void; rollback(): void } {
  if (!existsSync(target)) { renameSync(stage, target); return { commit: () => {}, rollback: () => rmSync(target, { recursive: true, force: true }) }; }
  const backup = moveAside(target, slot);
  try { renameSync(stage, target); } catch (error) { backup.rollback(); throw error; }
  return { commit: backup.commit, rollback: () => { rmSync(target, { recursive: true, force: true }); backup.rollback(); } };
}

function moveAside(path: string, parent = dirname(path)): { commit(): void; rollback(): void } {
  const backupRoot = mkdtempSync(join(parent, '.plgnz-backup-')); const backup = join(backupRoot, 'previous'); renameSync(path, backup);
  return { commit: () => rmSync(backupRoot, { recursive: true, force: true }), rollback: () => { if (existsSync(backup)) renameSync(backup, path); rmSync(backupRoot, { recursive: true, force: true }); } };
}

function sameTree(left: string, right: string): boolean {
  if (!existsSync(right)) return false;
  const listing = (root: string): string[] => {
    const out: string[] = []; const visit = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir).sort()) { if (entry === OWNERSHIP) continue; const path = join(dir, entry); const relative = prefix === '' ? entry : `${prefix}/${entry}`; if (statSync(path).isDirectory()) visit(path, relative); else if (statSync(path).isFile()) out.push(`${relative}:${bytesKey(path)}`); }
    }; visit(root, ''); return out;
  };
  return JSON.stringify(listing(left)) === JSON.stringify(listing(right));
}

function bytesKey(path: string): string {
  const readBytes = readFileSync as unknown as (file: string) => Uint8Array;
  const hash = new CryptoHasher('sha256');
  hash.update(readBytes(path));
  return hash.digest('hex');
}

function assertNoSymlinks(dir: string): void {
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`Claude Code cache contains symlink: ${dir}`);
  for (const entry of readdirSync(dir)) { const path = join(dir, entry); const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`Claude Code cache contains symlink: ${path}`); if (stat.isDirectory()) assertNoSymlinks(path); }
}
