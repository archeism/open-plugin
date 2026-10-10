import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { pinPluginMcpFiles } from '../mcp-write';
import { CryptoHasher } from '../runtime';
import { dcode, dcodeCacheRoot, dcodeEnablementFile, dcodeMcpCandidates, dcodeRegistryFile, dcodeRoot, dcodeStateDir, probeDcodeVersion } from './dcode';
import { requirePackageSemantics } from '../capability-evidence';
import { inventoryPackageSemantics } from '../semantic-inventory';

const MARKER = '.plgnz-install.json';
const MANIFESTS = ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'] as const;
const READBACK_FAULT = '.plgnz-dcode-readback-fault';

type Doc = Record<string, unknown>;
type Ownership =
  | { kind: 'legacy'; source: string; pluginId: string; fingerprint: string }
  | { kind: 'current'; source: string; pluginId: string; fingerprint: string; projectedFingerprint: string; sourceRevision: string };
type Prior =
  | { kind: 'none' }
  | { kind: 'owned'; path: string; marker: Ownership }
  | { kind: 'adoptable'; path: string };
type ManifestIdentity = { version: string };

export const dcodeWriter: HostWriter = {
  ...dcode,
  supportsAdoption: true,
  plannedNativeId: (plugin) => `${plugin.name}@${plugin.marketplace || 'local'}`,
  legacyNativeIds: (plugin) => plugin.marketplace === undefined ? [plugin.name] : [],
  persistedNativeIdMayAlias: (persisted, requested) =>
    !persisted.includes('@') && (requested === persisted || requested === `${persisted}@local`),
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const market = plugin.marketplace || 'local';
    const id = `${plugin.name}@${market}`;
    assertIdentity(plugin.name, 'plugin');
    assertIdentity(market, 'marketplace');
    assertIdentity(resolved.sha, 'version');
    const registryFile = dcodeRegistryFile();
    const enablementFile = dcodeEnablementFile();
    assertManagedPath(dcodeStateDir());
    assertManagedPath(registryFile);
    assertManagedPath(enablementFile);
    const registry = readRegistry(registryFile);
    const enablement = readEnablement(enablementFile);
    const plugins = object(registry.plugins, 'registry plugins');
    const enabled = boolObject(enablement.enabledPlugins, 'enabledPlugins');
    const manifest = declaredManifest(plugin.dir, plugin.name);
    const observation = probeDcodeVersion();
    requirePackageSemantics({
      host: 'dcode',
      detectedVersion: observation.kind === 'detected' ? observation.version : undefined,
      sourceType: resolved.isGit ? 'git' : 'local',
      operation: rowsFor(plugins[id]).length === 0 ? 'install' : 'update',
      route: 'managed',
      inventory: inventoryPackageSemantics({ ...plugin, dir: plugin.dir, version: manifest.version }),
    });
    const prior = assessPrior(plugins[id], id, resolved.sourceUri, opts?.adoptExisting === true, plugin.name, manifest.version, plugin.dir);
    const managedRoot = join(dcodeCacheRoot(), 'plgnz');
    assertCachePath(managedRoot);
    const stageParent = opts?.dryRun ? tmpdir() : managedRoot;
    if (!opts?.dryRun) mkdirSync(managedRoot, { recursive: true });
    const stage = mkdtempSync(join(stageParent, '.plgnz-dcode-stage-'));
    try {
      stagePlugin(plugin.dir, stage, plugin.name, manifest.version);
      forceAutoUpdateOff(stage);
      pinPluginMcpFiles(stage, dcodeMcpCandidates(), { dryRun: false });
      const projected = projectionDigest(stage);
      const sourceFingerprint = plugin.contentFingerprint ?? '';
      const marker: Ownership = {
        kind: 'current',
        source: resolved.sourceUri,
        pluginId: id,
        fingerprint: sourceFingerprint,
        projectedFingerprint: projected,
        sourceRevision: resolved.sha,
      };
      writeFileSync(join(stage, MARKER), `${JSON.stringify(markerBody(marker))}\n`);
      const target = managedSlot(id, projected);
      assertCachePath(target);
      const slot = ownership(target);
      if (slot !== null && (slot.source !== resolved.sourceUri || slot.pluginId !== id)) throw new Error(`dcode plugin ${id} belongs to another source; refusing to replace it`);
      if (existsSync(target) && slot === null) throw new Error(`dcode cache target is unowned; refusing to replace it: ${target}`);
      const unchanged = slot?.kind === 'current'
        && slot.fingerprint === sourceFingerprint
        && slot.projectedFingerprint === projected
        && slot.sourceRevision === resolved.sha
        && sameTree(stage, target);
      const nextRegistry: Doc = { ...registry, plugins: { ...plugins, [id]: [{ installPath: target, version: manifest.version }] } };
      const nextEnablement: Doc = { ...enablement, enabledPlugins: { ...enabled, [id]: true } };
      if (opts?.dryRun) {
        console.log(`[dcode] would activate directory: ${target}`);
        console.log(`[dcode] would update registry: ${registryFile}`);
        return unchanged ? 'unchanged' : undefined;
      }
      const beforeRegistry = snapshot(registryFile);
      const beforeEnablement = snapshot(enablementFile);
      if (unchanged) {
        try {
          writeDoc(registryFile, nextRegistry);
          writeDoc(enablementFile, nextEnablement);
          assertReadback(id, registryFile, enablementFile, target, manifest.version, projected, resolved.sha);
        } catch (error) {
          restore(registryFile, beforeRegistry);
          restore(enablementFile, beforeEnablement);
          throw error;
        }
        return 'unchanged';
      }
      const activation = activate(stage, target, managedRoot);
      try {
        writeDoc(registryFile, nextRegistry);
        writeDoc(enablementFile, nextEnablement);
        assertReadback(id, registryFile, enablementFile, target, manifest.version, projected, resolved.sha);
      } catch (error) {
        activation.rollback();
        restore(registryFile, beforeRegistry);
        restore(enablementFile, beforeEnablement);
        throw error;
      }
      activation.commit();
      const former = prior.kind === 'none' ? undefined : prior.path;
      if (former !== undefined && resolve(former) !== resolve(target)) retireFormer(former);
    } finally {
      rmSync(stage, { recursive: true, force: true });
      if (opts?.dryRun !== true && existsSync(managedRoot) && readdirSync(managedRoot).every((name) => name.startsWith('.plgnz-dcode-'))) {
        rmSync(managedRoot, { recursive: true, force: true });
      }
    }
  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    if (plugin.path === undefined || !existsSync(plugin.path)) return { changes: [], refusals: [] };
    assertCachePath(plugin.path);
    return pinPluginMcpFiles(plugin.path, dcodeMcpCandidates(), opts);
  },
  async remove(id: string): Promise<void> {
    assertIdentity(id, 'plugin id');
    const registryFile = dcodeRegistryFile();
    const enablementFile = dcodeEnablementFile();
    assertManagedPath(dcodeStateDir());
    assertManagedPath(registryFile);
    assertManagedPath(enablementFile);
    const registry = readRegistry(registryFile);
    const enablement = readEnablement(enablementFile);
    const plugins = object(registry.plugins, 'registry plugins');
    const rows = rowsFor(plugins[id]);
    if (rows.length === 0) return;
    if (rows.length !== 1) throw new Error(`dcode install record ${id} has duplicate rows; refusing to remove it`);
    const install = rowInstall(rows[0]!, id);
    assertCachePath(install);
    if (ownership(install)?.pluginId !== id) throw new Error(`dcode record ${id} is not wholly plgnz-owned; refusing to remove it`);
    const moved: Array<{ commit(): void; rollback(): void }> = [];
    const beforeRegistry = snapshot(registryFile);
    const beforeEnablement = snapshot(enablementFile);
    try {
      moved.push(moveAside(install));
      const nextPlugins = { ...plugins };
      delete nextPlugins[id];
      const nextEnabled = { ...boolObject(enablement.enabledPlugins, 'enabledPlugins') };
      delete nextEnabled[id];
      writeDoc(registryFile, { ...registry, plugins: nextPlugins });
      writeDoc(enablementFile, { ...enablement, enabledPlugins: nextEnabled });
    } catch (error) {
      for (const backup of moved.reverse()) backup.rollback();
      restore(registryFile, beforeRegistry);
      restore(enablementFile, beforeEnablement);
      throw error;
    }
    for (const backup of moved) backup.commit();
  },
};

function markerBody(marker: Ownership): Doc {
  if (marker.kind === 'legacy') return { source: marker.source, pluginId: marker.pluginId, fingerprint: marker.fingerprint };
  return {
    source: marker.source,
    pluginId: marker.pluginId,
    fingerprint: marker.fingerprint,
    projectedFingerprint: marker.projectedFingerprint,
    sourceRevision: marker.sourceRevision,
  };
}

function managedSlot(nativeId: string, projectedFingerprint: string): string {
  const hash = new CryptoHasher('sha256');
  hash.update('plgnz-dcode-managed-v1\0');
  hash.update(nativeId);
  hash.update('\0');
  hash.update(projectedFingerprint);
  return join(dcodeCacheRoot(), 'plgnz', hash.digest('hex'));
}

function assessPrior(value: unknown, id: string, source: string, adopt: boolean, name: string, version: string, sourceDir: string): Prior {
  const rows = rowsFor(value);
  if (rows.length > 1) throw new Error(`dcode install record ${id} has duplicate rows; refusing to replace it`);
  if (rows.length === 0) return { kind: 'none' };
  const install = rowInstall(rows[0]!, id);
  assertCachePath(install);
  const marker = ownership(install);
  if (marker !== null && marker.pluginId === id && marker.source === source) return { kind: 'owned', path: install, marker };
  if (marker !== null) throw new Error(`dcode plugin ${id} has a conflicting ownership marker`);
  if (!adopt) throw new Error(`dcode install record ${id} is not plgnz-owned; refusing to replace it`);
  if (!existsSync(install) || lstatSync(install).isSymbolicLink() || !lstatSync(install).isDirectory()) {
    throw new Error(`dcode install record ${id} is not plgnz-owned; refusing to replace it`);
  }
  assertNoSymlinks(install);
  const declared = typeof rows[0]!.version === 'string' ? rows[0]!.version : undefined;
  let legacy: ManifestIdentity & { name: string };
  try { legacy = declaredManifest(install, name); }
  catch (error) {
    const message = (error as Error).message;
    if (message.includes('identity does not match') || message.includes('no declared version') || message.includes('no supported plugin manifest')) {
      throw new Error(`dcode legacy install ${id} identity differs; refusing adoption`);
    }
    throw new Error(`dcode legacy install ${id} has invalid manifest; refusing adoption`);
  }
  if (legacy.name !== name || legacy.version !== version || declared !== legacy.version) {
    throw new Error(`dcode legacy install ${id} identity differs; refusing adoption`);
  }
  if (!sameTree(sourceDir, install)) throw new Error(`dcode legacy install ${id} content differs; refusing adoption`);
  return { kind: 'adoptable', path: install };
}

function declaredManifest(dir: string, expectedName: string): ManifestIdentity & { name: string } {
  const manifest = MANIFESTS.map((relative) => join(dir, relative)).find((file) => existsSync(file));
  if (manifest === undefined) throw new Error('dcode stage has no supported plugin manifest');
  let parsed: Doc;
  try { parsed = object(JSON.parse(readFileSync(manifest, 'utf8')), 'manifest'); }
  catch (error) { throw new Error(`invalid dcode manifest: ${manifest} (${(error as Error).message})`); }
  if (parsed.name !== expectedName) throw new Error(`dcode manifest identity does not match ${expectedName}`);
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) throw new Error('dcode manifest has no declared version');
  assertIdentity(parsed.version, 'manifest version');
  return { name: expectedName, version: parsed.version };
}

function stagePlugin(source: string, stage: string, name: string, version: string): void {
  assertNoSymlinks(source);
  cpSync(source, stage, { recursive: true });
  assertNoSymlinks(stage);
  const manifest = declaredManifest(stage, name);
  if (manifest.version !== version) throw new Error(`dcode manifest identity does not match ${name}`);
}

function forceAutoUpdateOff(dir: string): void {
  const manifest = MANIFESTS.map((relative) => join(dir, relative)).find((file) => existsSync(file));
  if (manifest === undefined) throw new Error('dcode stage has no supported plugin manifest');
  const parsed = object(JSON.parse(readFileSync(manifest, 'utf8')), 'manifest');
  const extensions = parsed.extensions === undefined ? {} : object(parsed.extensions, 'manifest extensions');
  const current = extensions['com.langchain.deepagents.code'];
  const dcodeExtension = current === undefined ? {} : object(current, 'dcode manifest extension');
  dcodeExtension.autoUpdate = false;
  extensions['com.langchain.deepagents.code'] = dcodeExtension;
  parsed.extensions = extensions;
  writeFileSync(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
}

function assertReadback(id: string, registryFile: string, enablementFile: string, target: string, version: string, projected: string, sourceRevision: string): void {
  if (existsSync(join(dcodeStateDir(), READBACK_FAULT))) throw new Error(`dcode readback failed for ${id}`);
  const registry = readRegistry(registryFile);
  const enablement = readEnablement(enablementFile);
  const rows = rowsFor(object(registry.plugins, 'registry plugins')[id]);
  if (rows.length !== 1) throw new Error(`dcode readback failed for ${id}`);
  const install = rowInstall(rows[0]!, id);
  if (resolve(install) !== resolve(target)) throw new Error(`dcode readback path mismatch for ${id}`);
  if (rows[0]!.version !== version) throw new Error(`dcode readback version mismatch for ${id}`);
  if (boolObject(object(enablement.enabledPlugins, 'enabledPlugins'), 'enabledPlugins')[id] !== true) throw new Error(`dcode readback enablement mismatch for ${id}`);
  const marker = ownership(target);
  if (marker?.kind !== 'current' || marker.projectedFingerprint !== projected || marker.sourceRevision !== sourceRevision) {
    throw new Error(`dcode readback fingerprint mismatch for ${id}`);
  }
  if (projectionDigest(target) !== projected) throw new Error(`dcode readback content mismatch for ${id}`);
}

function retireFormer(path: string): void {
  try {
    assertCachePath(path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('former cache is not a directory');
    const backup = join(dirname(path), `.plgnz-dcode-retire-${basename(path)}`);
    if (existsSync(backup)) {
      if (!lstatSync(backup).isDirectory()) throw new Error('retire destination is not a directory');
      rmSync(backup, { recursive: true, force: true });
    }
    renameSync(path, backup);
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(path)) throw new Error('former cache remains');
  } catch (error) {
    throw new Error(`dcode cleanup could not retire former cache: ${path} (${(error as Error).message})`);
  }
}

function projectionDigest(root: string): string {
  const hash = new CryptoHasher('sha256');
  for (const entry of listTree(root)) hash.update(`${entry}\0`);
  return hash.digest('hex');
}

function listTree(root: string): string[] {
  const read = readFileSync as unknown as (path: string) => Uint8Array;
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === MARKER) continue;
      const file = join(dir, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`dcode plugin contains symlink: ${file}`);
      if (stat.isDirectory()) walk(file, relative);
      else if (stat.isFile()) out.push(`${relative}:${Array.from(read(file)).join(',')}`);
      else throw new Error(`dcode stage has unsupported entry: ${file}`);
    }
  };
  walk(root, '');
  return out;
}

function sameTree(left: string, right: string): boolean {
  if (!existsSync(right)) return false;
  return JSON.stringify(listTree(left)) === JSON.stringify(listTree(right));
}

function readDoc(file: string, fallback: Doc, label: string): Doc {
  if (!existsSync(file)) return fallback;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Doc;
  } catch (error) {
    throw new Error(`invalid dcode ${label}: ${file} (${(error as Error).message})`);
  }
}

function readRegistry(file: string): Doc {
  const registry = readDoc(file, { version: 2, plugins: {} }, 'registry');
  if (registry.version !== 1 && registry.version !== 2) throw new Error(`invalid dcode registry version: ${file}`);
  const plugins = object(registry.plugins, 'registry plugins');
  for (const [id, value] of Object.entries(plugins)) {
    if (!id || !Array.isArray(value) || value.length === 0) throw new Error(`invalid dcode registry record: ${id}`);
    for (const row of value) {
      if (typeof row !== 'object' || row === null || Array.isArray(row) || (typeof (row as Doc).installPath !== 'string' && typeof (row as Doc).install_path !== 'string')) {
        throw new Error(`invalid dcode registry record: ${id}`);
      }
    }
  }
  return registry;
}

function readEnablement(file: string): Doc {
  const enablement = readDoc(file, { version: 1, enabledPlugins: {} }, 'enablement');
  if (enablement.version !== undefined && (!Number.isInteger(enablement.version) || (enablement.version as number) > 1)) throw new Error(`invalid dcode enablement version: ${file}`);
  boolObject(enablement.enabledPlugins, 'enabledPlugins');
  return enablement;
}

function object(value: unknown, label: string): Doc {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid dcode ${label}`);
  return value as Doc;
}

function boolObject(value: unknown, label: string): Record<string, boolean> {
  const result = object(value, label);
  if (Object.values(result).some((entry) => typeof entry !== 'boolean')) throw new Error(`invalid dcode ${label}`);
  return result as Record<string, boolean>;
}

function rowsFor(value: unknown): Doc[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Doc => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
}

function rowInstall(row: Doc, id: string): string {
  const install = typeof row.installPath === 'string' ? row.installPath : row.install_path;
  if (typeof install !== 'string') throw new Error(`dcode install record ${id} has no installPath`);
  return install;
}

function ownership(dir: string): Ownership | null {
  assertManagedPath(dir);
  const file = join(dir, MARKER);
  assertManagedPath(file);
  if (!existsSync(file)) return null;
  try {
    const value = object(JSON.parse(readFileSync(file, 'utf8')), 'ownership marker');
    if (typeof value.source !== 'string' || typeof value.pluginId !== 'string' || typeof value.fingerprint !== 'string') throw new Error('marker fields are invalid');
    const projected = value.projectedFingerprint;
    const revision = value.sourceRevision;
    if (projected === undefined && revision === undefined) return { kind: 'legacy', source: value.source, pluginId: value.pluginId, fingerprint: value.fingerprint };
    if (typeof projected !== 'string' || typeof revision !== 'string') throw new Error('marker fields are invalid');
    return { kind: 'current', source: value.source, pluginId: value.pluginId, fingerprint: value.fingerprint, projectedFingerprint: projected, sourceRevision: revision };
  } catch (error) {
    throw new Error(`invalid dcode ownership marker: ${file} (${(error as Error).message})`);
  }
}

function writeDoc(file: string, value: Doc): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.plgnz-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function snapshot(file: string): Uint8Array | undefined {
  const read = readFileSync as unknown as (path: string) => Uint8Array;
  return existsSync(file) ? read(file) : undefined;
}

function restore(file: string, before: Uint8Array | undefined): void {
  try {
    if (before === undefined) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, before as unknown as string);
    }
  } catch {}
}

function activate(stage: string, target: string, parent: string): { commit(): void; rollback(): void } {
  if (!existsSync(target)) {
    renameSync(stage, target);
    return { commit: () => {}, rollback: () => rmSync(target, { recursive: true, force: true }) };
  }
  const backup = moveAside(target, parent);
  try { renameSync(stage, target); }
  catch (error) { backup.rollback(); throw error; }
  return {
    commit: backup.commit,
    rollback: () => {
      rmSync(target, { recursive: true, force: true });
      backup.rollback();
    },
  };
}

function moveAside(path: string, parent = dirname(path)): { commit(): void; rollback(): void } {
  const backupRoot = mkdtempSync(join(parent, '.plgnz-dcode-backup-'));
  const backup = join(backupRoot, 'previous');
  renameSync(path, backup);
  return {
    commit: () => rmSync(backupRoot, { recursive: true, force: true }),
    rollback: () => {
      if (existsSync(backup)) renameSync(backup, path);
      rmSync(backupRoot, { recursive: true, force: true });
    },
  };
}

function assertNoSymlinks(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`dcode plugin contains symlink: ${file}`);
    if (stat.isDirectory()) assertNoSymlinks(file);
  }
}

function assertIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/.test(value)) throw new Error(`invalid dcode ${label}`);
}

function assertCachePath(path: string): void {
  const root = resolve(dcodeCacheRoot());
  const target = resolve(path);
  if (target === root || !target.startsWith(`${root}/`)) throw new Error(`dcode path escapes managed cache: ${path}`);
  let current = root;
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`dcode native path contains symlink: ${current}`);
  const relative = target.slice(root.length).replace(/^\//, '');
  for (const part of relative.length === 0 ? [] : relative.split('/')) {
    if (part === '' || part === '.' || part === '..') throw new Error(`dcode path escapes managed cache: ${path}`);
    current = join(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`dcode native path contains symlink: ${current}`);
  }
  if (!existsSync(target) || !existsSync(root)) return;
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) throw new Error(`dcode path escapes managed cache: ${path}`);
}

function assertManagedPath(path: string): void {
  const root = resolve(dcodeRoot());
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`dcode path escapes native root: ${path}`);
  let current = root;
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`dcode native path contains symlink: ${current}`);
  const relative = target.slice(root.length).replace(/^\//, '');
  for (const part of relative ? relative.split('/') : []) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`dcode native path contains symlink: ${current}`);
  }
}
