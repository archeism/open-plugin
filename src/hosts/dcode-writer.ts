/** Transactional writer for dcode's recorded native plugin state. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { dcode, dcodeEnablementFile, dcodeRegistryFile, dcodeRoot, dcodeStateDir } from './dcode';
import { requireCompatible } from '../compatibility';
import { findConsumerProfile } from '../consumer-profiles';

declare const Bun: any;

const MARKER = '.plgnz-install.json';
type Ownership = { source: string; pluginId: string; fingerprint: string };
type Doc = Record<string, unknown>;

export const dcodeWriter: HostWriter = {
  ...dcode,
  supportsAdoption: true,
  plannedNativeId: (plugin) => `${plugin.name}@${plugin.marketplace || 'local'}`,
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const market = plugin.marketplace || 'local'; const id = `${plugin.name}@${market}`;
    assertIdentity(plugin.name, 'plugin'); assertIdentity(market, 'marketplace'); assertIdentity(resolved.sha, 'version');
    const cache = join(dcodeRoot(), 'plugins', 'cache', market, plugin.name);
    const target = join(cache, resolved.sha); assertManagedPath(cache); assertManagedPath(target); assertUnder(cache, target);
    const registryFile = dcodeRegistryFile(), enablementFile = dcodeEnablementFile();
    assertManagedPath(dcodeStateDir()); assertManagedPath(registryFile); assertManagedPath(enablementFile);
    const registry = readRegistry(registryFile);
    const enablement = readEnablement(enablementFile);
    const plugins = object(registry.plugins, 'registry plugins'); const enabled = boolObject(enablement.enabledPlugins, 'enabledPlugins');
    const stage = mkdtempSync(join(tmpdir(), '.plgnz-dcode-stage-'));
    try {
      const manifestVersion = stagePlugin(plugin.dir, stage, plugin.name);
      assertPriorRows(plugins[id], id, cache, resolved.sourceUri, opts?.adoptExisting === true, plugin.name, manifestVersion);
      writeFileSync(join(stage, MARKER), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '' } satisfies Ownership));
      const marker = ownership(target);
      if (marker !== null && (marker.source !== resolved.sourceUri || marker.pluginId !== id)) throw new Error(`dcode plugin ${id} belongs to another source; refusing to replace it`);
      if (existsSync(target) && marker === null) throw new Error(`dcode cache target is unowned; refusing to replace it: ${target}`);
      const unchanged = marker !== null && marker.fingerprint === (plugin.contentFingerprint ?? '') && sameTree(stage, target);
      const nextRegistry: Doc = { ...registry, plugins: { ...plugins, [id]: [{ installPath: target, version: resolved.sha }] } };
      const nextEnablement: Doc = { ...enablement, enabledPlugins: { ...enabled, [id]: true } };
      if (opts?.dryRun) { console.log(`[dcode] would activate directory: ${target}`); console.log(`[dcode] would update registry: ${registryFile}`); return unchanged ? 'unchanged' : undefined; }
      mkdirSync(cache, { recursive: true });
      const beforeRegistry = snapshot(registryFile), beforeEnablement = snapshot(enablementFile);
      if (unchanged) { try { writeDoc(registryFile, nextRegistry); writeDoc(enablementFile, nextEnablement); } catch (error) { restore(registryFile, beforeRegistry); restore(enablementFile, beforeEnablement); throw error; } return 'unchanged'; }
      const activation = activate(stage, target, cache);
      try { writeDoc(registryFile, nextRegistry); writeDoc(enablementFile, nextEnablement); }
      catch (error) { activation.rollback(); restore(registryFile, beforeRegistry); restore(enablementFile, beforeEnablement); throw error; }
      activation.commit();
    } finally { rmSync(stage, { recursive: true, force: true }); }
  },
  async pin(_plugin: InstalledPlugin, _opts?: PinOptions): Promise<PinOutcome> { return { changes: [], refusals: [] }; },
  async remove(id: string): Promise<void> {
    assertIdentity(id, 'plugin id'); const registryFile = dcodeRegistryFile(), enablementFile = dcodeEnablementFile();
    assertManagedPath(dcodeStateDir()); assertManagedPath(registryFile); assertManagedPath(enablementFile);
    const registry = readRegistry(registryFile); const enablement = readEnablement(enablementFile);
    const plugins = object(registry.plugins, 'registry plugins'); const rows = rowsFor(plugins[id]);
    if (rows.length === 0) return;
    const cache = join(dcodeRoot(), 'plugins', 'cache');
    if (rows.some(row => typeof row.installPath !== 'string' || ownership(row.installPath)?.pluginId !== id)) throw new Error(`dcode record ${id} is not wholly plgnz-owned; refusing to remove it`);
    for (const row of rows) { assertUnder(cache, row.installPath as string); assertManagedPath(row.installPath as string); }
    const moved: Array<{ commit(): void; rollback(): void }> = []; const beforeRegistry = snapshot(registryFile), beforeEnablement = snapshot(enablementFile);
    try {
      for (const row of rows) moved.push(moveAside(row.installPath as string));
      const nextPlugins = { ...plugins }; delete nextPlugins[id]; const nextEnabled = { ...boolObject(enablement.enabledPlugins, 'enabledPlugins') }; delete nextEnabled[id];
      writeDoc(registryFile, { ...registry, plugins: nextPlugins }); writeDoc(enablementFile, { ...enablement, enabledPlugins: nextEnabled });
    } catch (error) { for (const backup of moved.reverse()) backup.rollback(); restore(registryFile, beforeRegistry); restore(enablementFile, beforeEnablement); throw error; }
    for (const backup of moved) backup.commit();
  },
};

function stagePlugin(source: string, stage: string, name: string): string | undefined {
  assertNoSymlinks(source); cpSync(source, stage, { recursive: true }); assertNoSymlinks(stage);
  const manifest = [join(stage, 'plugin.json'), join(stage, '.claude-plugin', 'plugin.json'), join(stage, '.codex-plugin', 'plugin.json')].find(existsSync);
  if (!manifest) throw new Error('dcode stage has no supported plugin manifest');
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Doc;
  if (parsed.name !== name) throw new Error(`dcode manifest identity does not match ${name}`);
  if (existsSync(join(stage, 'commands')) || existsSync(join(stage, '.claude', 'commands'))) requireDcodeCapability('commandProjection');
  if (existsSync(join(stage, 'agents')) || existsSync(join(stage, '.claude', 'agents'))) throw new Error('dcode plugin agents are unsupported; refusing to activate');
  for (const skill of skillFiles(stage)) {
    const frontmatter = openingFrontmatter(readFileSync(skill, 'utf8'), skill);
    if (frontmatter !== undefined) {
      for (const key of ['disable-model-invocation', 'disable_model_invocation', 'user-invocable', 'user_invocable']) {
        if (!Object.hasOwn(frontmatter, key)) continue;
        const value = frontmatter[key];
        if (typeof value !== 'boolean') throw new Error(`dcode skill invocation flag ${key} must be boolean: ${skill}`);
        if (key.startsWith('disable') ? value : !value) requireDcodeCapability('userOnlySkills');
      }
    }
    const sidecar = join(dirname(skill), 'agents', 'openai.yaml');
    if (existsSync(sidecar)) {
      let parsed: unknown;
      try { parsed = Bun.YAML.parse(readFileSync(sidecar, 'utf8')); }
      catch { throw new Error(`dcode skill invocation sidecar has invalid YAML: ${sidecar}`); }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`dcode skill invocation sidecar must be an object: ${sidecar}`);
      const policy = (parsed as Doc).policy;
      if (typeof policy === 'object' && policy !== null && !Array.isArray(policy) && Object.hasOwn(policy, 'allow_implicit_invocation')) {
        const value = (policy as Doc).allow_implicit_invocation;
        if (typeof value !== 'boolean') throw new Error(`dcode skill invocation sidecar policy must be boolean: ${sidecar}`);
        if (!value) requireDcodeCapability('userOnlySkills');
      }
    }
  }
  return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : undefined;
}
function requireDcodeCapability(capability: 'commandProjection' | 'userOnlySkills'): void {
  // TODO(2026-09-23): support user-only skills when native non-experimental semantics exist; DEEPAGENTS_CODE_EXPERIMENTAL middleware is intentionally deferred.
  const profile = findConsumerProfile('dcode');
  if (profile === undefined) throw new Error('dcode consumer profile is missing');
  requireCompatible(profile, capability);
}
function skillFiles(root: string): string[] { const out: string[] = []; const walk = (dir: string): void => { for (const entry of readdirSync(dir)) { const path = join(dir, entry); const st = lstatSync(path); if (st.isDirectory()) walk(path); else if (entry === 'SKILL.md') out.push(path); } }; walk(root); return out; }
function openingFrontmatter(raw: string, path: string): Record<string, unknown> | undefined { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw); if (match === null) return undefined; let parsed: unknown; try { parsed = Bun.YAML.parse(match[1] ?? ''); } catch { throw new Error(`dcode skill frontmatter has invalid YAML: ${path}`); } if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`dcode skill frontmatter must be an object: ${path}`); return parsed as Record<string, unknown>; }
function readDoc(file: string, fallback: Doc, label: string): Doc { if (!existsSync(file)) return fallback; try { const value: unknown = JSON.parse(readFileSync(file, 'utf8')); if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object'); return value as Doc; } catch (error) { throw new Error(`invalid dcode ${label}: ${file} (${(error as Error).message})`); } }
function readRegistry(file: string): Doc { const registry = readDoc(file, { version: 2, plugins: {} }, 'registry'); if (registry.version !== 1 && registry.version !== 2) throw new Error(`invalid dcode registry version: ${file}`); const plugins = object(registry.plugins, 'registry plugins'); for (const [id, value] of Object.entries(plugins)) { if (!id || !Array.isArray(value) || value.length === 0) throw new Error(`invalid dcode registry record: ${id}`); for (const row of value) { if (typeof row !== 'object' || row === null || Array.isArray(row) || (typeof (row as Doc).installPath !== 'string' && typeof (row as Doc).install_path !== 'string')) throw new Error(`invalid dcode registry record: ${id}`); } } return registry; }
function readEnablement(file: string): Doc { const enablement = readDoc(file, { version: 1, enabledPlugins: {} }, 'enablement'); if (enablement.version !== undefined && (!Number.isInteger(enablement.version) || (enablement.version as number) > 1)) throw new Error(`invalid dcode enablement version: ${file}`); boolObject(enablement.enabledPlugins, 'enabledPlugins'); return enablement; }
function object(value: unknown, label: string): Doc { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid dcode ${label}`); return value as Doc; }
function boolObject(value: unknown, label: string): Record<string, boolean> { const result = object(value, label); if (Object.values(result).some(value => typeof value !== 'boolean')) throw new Error(`invalid dcode ${label}`); return result as Record<string, boolean>; }
function rowsFor(value: unknown): Doc[] { if (!Array.isArray(value)) return []; return value.filter((value): value is Doc => typeof value === 'object' && value !== null && !Array.isArray(value)); }
function assertPriorRows(value: unknown, id: string, cache: string, source: string, adopt: boolean, name: string, version: string | undefined): void {
  const rows = rowsFor(value);
  for (const row of rows) {
    const install = typeof row.installPath === 'string' ? row.installPath : row.install_path;
    if (typeof install !== 'string') throw new Error(`dcode install record ${id} has no installPath`);
    assertUnder(cache, install); assertManagedPath(install);
    const marker = ownership(install);
    if (marker?.pluginId === id && marker.source === source) continue;
    if (marker !== null || !adopt || rows.length !== 1 || !existsSync(install) || version === undefined || typeof row.version !== 'string' || row.version !== version || resolve(install) !== resolve(join(cache, version))) {
      throw new Error(`dcode install record ${id} is not plgnz-owned; refusing to replace it`);
    }
    assertNoSymlinks(install);
    const manifest = [join(install, 'plugin.json'), join(install, '.claude-plugin', 'plugin.json'), join(install, '.codex-plugin', 'plugin.json')].find(existsSync);
    if (!manifest) throw new Error(`dcode legacy install ${id} has no supported manifest; refusing adoption`);
    let legacy: Doc;
    try { legacy = object(JSON.parse(readFileSync(manifest, 'utf8')) as unknown, 'legacy manifest'); }
    catch { throw new Error(`dcode legacy install ${id} has invalid manifest; refusing adoption`); }
    if (legacy.name !== name || legacy.version !== version) throw new Error(`dcode legacy install ${id} identity differs; refusing adoption`);
  }
}
function ownership(dir: string): Ownership | null { assertManagedPath(dir); const file = join(dir, MARKER); assertManagedPath(file); if (!existsSync(file)) return null; try { const value = JSON.parse(readFileSync(file, 'utf8')) as Doc; if (typeof value.source !== 'string' || typeof value.pluginId !== 'string' || typeof value.fingerprint !== 'string') throw new Error('marker fields are invalid'); return value as Ownership; } catch (error) { throw new Error(`invalid dcode ownership marker: ${file} (${(error as Error).message})`); } }
function writeDoc(file: string, value: Doc): void { mkdirSync(dirname(file), { recursive: true }); const temporary = `${file}.plgnz-${Date.now()}`; try { writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`); renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); } }
function snapshot(file: string): Uint8Array | undefined { const read = readFileSync as unknown as (path: string) => Uint8Array; return existsSync(file) ? read(file) : undefined; }
function restore(file: string, before: Uint8Array | undefined): void { try { if (before === undefined) rmSync(file, { force: true }); else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, before as unknown as string); } } catch {} }
function activate(stage: string, target: string, parent: string): { commit(): void; rollback(): void } { if (!existsSync(target)) { renameSync(stage, target); return { commit: () => {}, rollback: () => rmSync(target, { recursive: true, force: true }) }; } const backup = moveAside(target, parent); try { renameSync(stage, target); } catch (error) { backup.rollback(); throw error; } return { commit: backup.commit, rollback: () => { rmSync(target, { recursive: true, force: true }); backup.rollback(); } }; }
function moveAside(path: string, parent = dirname(path)): { commit(): void; rollback(): void } { const backupRoot = mkdtempSync(join(parent, '.plgnz-dcode-backup-')); const backup = join(backupRoot, 'previous'); renameSync(path, backup); return { commit: () => rmSync(backupRoot, { recursive: true, force: true }), rollback: () => { if (existsSync(backup)) renameSync(backup, path); rmSync(backupRoot, { recursive: true, force: true }); } }; }
function sameTree(left: string, right: string): boolean { if (!existsSync(right)) return false; const read = readFileSync as unknown as (path: string) => Uint8Array; const listing = (root: string): string[] => { const out: string[] = []; const walk = (dir: string, prefix: string): void => { for (const entry of readdirSync(dir).sort()) { if (entry === MARKER) continue; const file = join(dir, entry), relative = prefix ? `${prefix}/${entry}` : entry, st = lstatSync(file); if (st.isDirectory()) walk(file, relative); else if (st.isFile()) out.push(`${relative}:${Array.from(read(file)).join(',')}`); else throw new Error(`dcode stage has unsupported entry: ${file}`); } }; walk(root, ''); return out; }; return JSON.stringify(listing(left)) === JSON.stringify(listing(right)); }
function assertNoSymlinks(dir: string): void { for (const entry of readdirSync(dir)) { const file = join(dir, entry), st = lstatSync(file); if (st.isSymbolicLink()) throw new Error(`dcode plugin contains symlink: ${file}`); if (st.isDirectory()) assertNoSymlinks(file); } }
function assertIdentity(value: string, label: string): void { if (!/^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/.test(value)) throw new Error(`invalid dcode ${label}`); }
function assertUnder(root: string, path: string): void { const absoluteRoot = resolve(root), absolutePath = resolve(path); if (absolutePath === absoluteRoot || !absolutePath.startsWith(`${absoluteRoot}/`)) throw new Error(`dcode path escapes managed cache: ${path}`); }
/** Reject links in the native root or any component beneath it before a write. */
function assertManagedPath(path: string): void { const root = resolve(dcodeRoot()), target = resolve(path); if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`dcode path escapes native root: ${path}`); let current = root; if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`dcode native path contains symlink: ${current}`); const relative = target.slice(root.length).replace(/^\//, ''); for (const part of relative ? relative.split('/') : []) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`dcode native path contains symlink: ${current}`); } }
