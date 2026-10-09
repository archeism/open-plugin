/** Cursor's native local-plugin lifecycle writer. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import { cursorRoot } from '../paths';
import type { PluginSource, ResolvedSource } from '../source';
import { cursor, localDir, mcpCandidates } from './cursor';
import { pinPluginMcpFiles } from '../mcp-write';
import { discoverCommands } from '../conversion';

const OWNERSHIP = '.plgnz-install.json';
type Ownership = { source: string; pluginId: string; fingerprint: string };

export const cursorWriter: HostWriter = {
  ...cursor,
  supportsAdoption: true,
  plannedNativeId: (plugin) => plugin.name,
  legacyNativeIds: (plugin) => plugin.marketplace === undefined ? [] : [`${plugin.name}@${plugin.marketplace}`],
  persistedNativeIdMayAlias: (persisted, requested) => {
    const name = persisted.split('@', 1)[0] ?? persisted;
    return requested !== persisted && (requested === name || requested.startsWith(`${name}@`));
  },
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const id = plugin.name;
    const ownershipId = plugin.marketplace === undefined ? id : `${id}@${plugin.marketplace}`;
    assertSafeIdentity(id);
    const root = localDir();
    const target = join(root, id);
    assertManagedDirectory(root, target);

    if (!opts?.dryRun) mkdirSync(root, { recursive: true });
    const stage = mkdtempSync(join(opts?.dryRun ? tmpdir() : root, '.plgnz-cursor-stage-'));
    try {
      stagePlugin(plugin.dir, stage, id);
      // Preserve an unresolved bare command for the existing read-only `pin`
      // diagnosis path; activation must not rewrite it into a guessed command.
      await pinPluginMcpFiles(stage, mcpCandidates(), { dryRun: false });
      writeOwnership(stage, { source: resolved.sourceUri, pluginId: ownershipId, fingerprint: plugin.contentFingerprint ?? '' });

      const marker = readOwnership(target);
      if (marker !== null && (marker.source !== resolved.sourceUri || !matchesOwnership(marker.pluginId, id, ownershipId))) {
        throw new Error(`Cursor local plugin ${id} belongs to another source; refusing to replace it`);
      }
      const identicalUnowned = existsSync(target) && marker === null && sameTree(stage, target);
      if (existsSync(target) && marker === null && !identicalUnowned) {
        if (!opts?.adoptExisting) throw new Error(`Cursor local plugin ${id} is unowned and differs from the staged representation; pass --adopt-existing to take ownership explicitly`);
        validateExistingIdentity(target, id, sourceVersion(plugin.dir));
      }

      // A bare legacy marker has no collection identity. Re-write it on the
      // next successful add so reader metadata and the durable state agree.
      const unchanged = marker !== null && marker.pluginId === ownershipId && marker.fingerprint === (plugin.contentFingerprint ?? '') && sameTree(stage, target);
      if (opts?.dryRun) {
        console.log(`[cursor] would activate directory: ${target}`);
        return unchanged ? 'unchanged' : undefined;
      }
      if (unchanged) return 'unchanged';
      activate(stage, target, root).commit();
      return;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    if (plugin.path === undefined || !existsSync(plugin.path)) return { changes: [], refusals: [] };
    return pinPluginMcpFiles(plugin.path, mcpCandidates(), opts);
  },
  async remove(id: string): Promise<void> {
    assertSafeIdentity(id);
    const root = localDir();
    const target = join(root, id);
    assertManagedDirectory(root, target);
    const marker = readOwnership(target);
    if (marker === null || !ownsNativeDirectory(marker.pluginId, id)) return;
    rmSync(target, { recursive: true, force: true });
  },
};

function stagePlugin(source: string, stage: string, expectedName: string): void {
  assertNoSymlinks(source);
  cpSync(source, stage, { recursive: true });
  projectCommandsToSkills(stage);
  ensureCursorManifest(stage, expectedName);
  validateStage(stage, expectedName);
}

/**
 * Cursor folded commands into skills: every skill is `/`-invocable and
 * Cursor 2.4's /migrate-to-skills preserves command invocation behavior
 * (Cursor docs → Skills). Command sources therefore project into the
 * plugin's skills tree. A command that is not user-invocable cannot be
 * represented — every Cursor skill is /-invocable — and is refused rather
 * than silently weakened.
 */
function projectCommandsToSkills(stage: string): void {
  if (!hasCommands(stage)) return;
  const commands = discoverCommands(stage);
  const seen = new Set<string>();
  for (const command of commands) {
    if (command.userInvocable === false) throw new Error(`Cursor skill projection cannot represent user-invocable: false: ${command.source}`);
    if (seen.has(command.name)) throw new Error(`Cursor command projection collision: ${command.name}`);
    seen.add(command.name);
    const target = join(stage, 'skills', command.name, 'SKILL.md');
    if (existsSync(target)) throw new Error(`Cursor command collides with an existing skill: ${command.name}`);
    mkdirSync(join(stage, 'skills', command.name), { recursive: true });
    const body = command.body.endsWith('\n') ? command.body : `${command.body}\n`;
    writeFileSync(target, `---\nname: ${JSON.stringify(command.name)}\ndescription: ${JSON.stringify(command.description)}\n---\n${body}`);
  }
  if (commands.length > 0) {
    rmSync(join(stage, 'commands'), { recursive: true, force: true });
    rmSync(join(stage, '.claude', 'commands'), { recursive: true, force: true });
  }
}

function hasCommands(root: string): boolean {
  return existsSync(join(root, 'commands')) || existsSync(join(root, '.claude', 'commands'));
}

function ensureCursorManifest(stage: string, expectedName: string): void {
  const cursorManifest = join(stage, '.cursor-plugin', 'plugin.json');
  if (existsSync(cursorManifest)) return;
  const source = manifestCandidates(stage).find(existsSync);
  if (source === undefined) throw new Error('Cursor stage has no Agent Plugins manifest');
  mkdirSync(join(stage, '.cursor-plugin'), { recursive: true });
  cpSync(source, cursorManifest);
  if (parseManifest(cursorManifest).name !== expectedName) throw new Error(`Cursor manifest identity does not match ${expectedName}`);
}

function validateStage(stage: string, expectedName: string): void {
  assertNoSymlinks(stage);
  const native = parseManifest(join(stage, '.cursor-plugin', 'plugin.json'));
  if (native.name !== expectedName) throw new Error(`Cursor manifest identity does not match ${expectedName}`);
  const canonicalPath = manifestCandidates(stage).find(existsSync);
  if (canonicalPath !== undefined) {
    const canonical = parseManifest(canonicalPath);
    if (native.name !== canonical.name || (canonical.version !== undefined && native.version !== canonical.version)) {
      throw new Error('Cursor native manifest identity does not match the canonical manifest');
    }
  }
  const skills = join(stage, 'skills');
  if (existsSync(skills) && !statSync(skills).isDirectory()) throw new Error('Cursor stage skills path is not a directory');
}

function manifestCandidates(root: string): string[] {
  return [join(root, '.claude-plugin', 'plugin.json'), join(root, 'plugin.json'), join(root, '.plugin', 'plugin.json')];
}

function sourceVersion(root: string): string | undefined {
  const manifest = [join(root, '.cursor-plugin', 'plugin.json'), ...manifestCandidates(root)].find(existsSync);
  return manifest === undefined ? undefined : parseManifest(manifest).version;
}

function parseManifest(path: string): { name: string; version?: string } {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`invalid Cursor plugin manifest: ${path} (${(error as Error).message})`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid Cursor plugin manifest: ${path}`);
  const record = value as Record<string, unknown>;
  if (typeof record['name'] !== 'string' || !validIdentity(record['name'])) throw new Error(`invalid Cursor plugin manifest identity: ${path}`);
  if (record['version'] !== undefined && typeof record['version'] !== 'string') throw new Error(`invalid Cursor plugin manifest version: ${path}`);
  return { name: record['name'], ...(typeof record['version'] === 'string' ? { version: record['version'] } : {}) };
}

function validateExistingIdentity(target: string, expectedName: string, expectedVersion: string | undefined): void {
  const manifest = join(target, '.cursor-plugin', 'plugin.json');
  if (!existsSync(manifest)) throw new Error(`unowned Cursor local plugin has no native manifest: ${target}`);
  const parsed = parseManifest(manifest);
  if (parsed.name !== expectedName || parsed.version !== expectedVersion) throw new Error(`unowned Cursor local plugin identity does not match ${expectedName}`);
}

function readOwnership(target: string): Ownership | null {
  const marker = join(target, OWNERSHIP);
  if (!existsSync(marker)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(marker, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('marker must be an object');
    const record = value as Record<string, unknown>;
    if (typeof record['source'] !== 'string' || typeof record['pluginId'] !== 'string' || typeof record['fingerprint'] !== 'string') throw new Error('marker fields are invalid');
    return { source: record['source'], pluginId: record['pluginId'], fingerprint: record['fingerprint'] };
  } catch (error) {
    throw new Error(`invalid plgnz ownership marker: ${marker} (${(error as Error).message})`);
  }
}

function writeOwnership(stage: string, ownership: Ownership): void {
  writeFileSync(join(stage, OWNERSHIP), JSON.stringify(ownership));
}

/** A legacy bare marker remains owned only for this exact native directory. */
function matchesOwnership(markerId: string, nativeId: string, ownershipId: string): boolean {
  return markerId === nativeId || markerId === ownershipId;
}

function ownsNativeDirectory(markerId: string, nativeId: string): boolean {
  if (markerId === nativeId) return true;
  const prefix = `${nativeId}@`;
  return markerId.startsWith(prefix) && validIdentity(markerId.slice(prefix.length));
}

function activate(stage: string, target: string, root: string): { commit(): void } {
  if (!existsSync(target)) {
    renameSync(stage, target);
    return { commit: () => {} };
  }
  const backupRoot = mkdtempSync(join(root, '.plgnz-cursor-backup-'));
  const backup = join(backupRoot, 'previous');
  renameSync(target, backup);
  try { renameSync(stage, target); }
  catch (error) {
    renameSync(backup, target);
    rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }
  return { commit: () => rmSync(backupRoot, { recursive: true, force: true }) };
}

function sameTree(left: string, right: string): boolean {
  if (!existsSync(right)) return false;
  const entries = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir).sort()) {
        if (name === OWNERSHIP) continue;
        const path = join(dir, name);
        const relative = prefix === '' ? name : `${prefix}/${name}`;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`Cursor managed plugin contains symlink: ${path}`);
        if (stat.isDirectory()) walk(path, relative);
        else if (stat.isFile()) out.push(`${relative}:${hashBytes(path)}`);
        else throw new Error(`Cursor managed plugin contains unsupported file: ${path}`);
      }
    };
    walk(root, '');
    return out;
  };
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function hashBytes(path: string): string {
  const read = readFileSync as unknown as (file: string) => Uint8Array;
  return Array.from(read(path)).join(',');
}

function assertManagedDirectory(root: string, target: string): void {
  const resolvedRoot = resolve(cursorRoot());
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}/`)) throw new Error(`Cursor managed path escapes its store: ${target}`);
  let current = resolvedRoot;
  for (const part of resolvedTarget.slice(resolvedRoot.length).split('/').filter(Boolean)) {
    if (existsSync(current)) assertDirectoryNotLink(current);
    current = join(current, part);
  }
  if (existsSync(current)) assertDirectoryNotLink(current);
}

function assertDirectoryNotLink(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Cursor managed path component is a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`Cursor managed path component is not a directory: ${path}`);
}

function assertNoSymlinks(root: string): void {
  const walk = (dir: string): void => {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error(`Cursor plugin source contains symlink: ${dir}`);
    if (!stat.isDirectory()) throw new Error(`Cursor plugin source is not a directory: ${dir}`);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) throw new Error(`Cursor plugin source contains symlink: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (!entry.isFile()) throw new Error(`Cursor plugin source contains unsupported file: ${path}`);
    }
  };
  walk(root);
}

function assertSafeIdentity(id: string): void {
  if (!validIdentity(id)) throw new Error(`unsafe Cursor plugin identity: ${id}`);
}

function validIdentity(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/iu.test(id);
}
