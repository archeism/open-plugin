/** Transactional standalone-skill writer for Pi 0.80.10. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { pi, piRoot, skillsDir } from './pi';
import { projectPluginForPi } from '../conversion';

const MARKER = '.plgnz-install.json';
type Owner = { source: string; pluginId: string; fingerprint: string };
type Move = { target: string; backup?: string };

export const piWriter: HostWriter = {
  ...pi,
  plannedNativeId: (plugin) => `${plugin.name}@${plugin.marketplace ?? 'local'}`,
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const market = plugin.marketplace ?? 'local'; const id = `${plugin.name}@${market}`;
    identity(plugin.name, 'plugin'); identity(market, 'marketplace');
    assertPiStore();
    const stageParent = opts?.dryRun ? tmpdir() : dirname(skillsDir());
    if (!opts?.dryRun) mkdirSync(stageParent, { recursive: true });
    const stage = mkdtempSync(join(stageParent, '.plgnz-pi-stage-'));
    try {
      const target = join(skillsDir(), packageName(plugin.name, market));
      const staged = stagePlugin(plugin.dir, stage, plugin.name, market);
      writeFileSync(join(staged, MARKER), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '' } satisfies Owner));
      checkTarget(target, id, resolved.sourceUri);
      const prior = ownedFor(id, resolved.sourceUri);
      const unchanged = prior.length === 1 && prior[0] === target && owner(target)?.fingerprint === (plugin.contentFingerprint ?? '') && sameTree(staged, target);
      if (opts?.dryRun) {
        console.log(`[pi] would activate standalone package: ${target}`);
        return unchanged ? 'unchanged' : undefined;
      }
      ensureStore();
      if (unchanged) return 'unchanged';
      const backups: Move[] = [];
      try {
        for (const candidate of [...new Set([target, ...prior])]) {
          if (!existsSync(candidate)) { backups.push({ target: candidate }); continue; }
          const backupRoot = mkdtempSync(join(skillsDir(), '.plgnz-pi-backup-'));
          const backup = join(backupRoot, 'previous'); renameSync(candidate, backup); backups.push({ target: candidate, backup });
        }
        renameSync(staged, target);
      } catch (error) {
        for (const move of backups.reverse()) { rmSync(move.target, { recursive: true, force: true }); if (move.backup !== undefined) renameSync(move.backup, move.target); }
        throw error;
      }
      for (const move of backups) if (move.backup !== undefined) rmSync(dirname(move.backup), { recursive: true, force: true });
    } finally { rmSync(stage, { recursive: true, force: true }); }
  },
  async pin(_plugin: InstalledPlugin, _opts?: PinOptions): Promise<PinOutcome> { return { changes: [], refusals: [] }; },
  async remove(id: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/iu.test(id)) throw new Error(`unsafe Pi plugin id: ${id}`);
    assertPiStore();
    const targets = ownedFor(id);
    if (targets.length === 0) throw new Error(`Pi has no wholly plgnz-owned standalone skills for ${id}; refusing to remove`);
    const moves: Move[] = [];
    try {
      for (const target of targets) {
        const backupRoot = mkdtempSync(join(skillsDir(), '.plgnz-pi-remove-'));
        const backup = join(backupRoot, 'previous'); renameSync(target, backup); moves.push({ target, backup });
      }
    } catch (error) {
      for (const move of moves.reverse()) if (move.backup !== undefined) renameSync(move.backup, move.target);
      throw error;
    }
    for (const move of moves) if (move.backup !== undefined) rmSync(dirname(move.backup), { recursive: true, force: true });
  },
};

function stagePlugin(source: string, stage: string, plugin: string, market: string): string {
  assertTree(source);
  const root = join(source, 'skills');
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error('Pi standalone delivery requires plugin skills/ directories');
  const destination = join(stage, packageName(plugin, market)); projectPluginForPi(source, destination, plugin);
  const skillFiles: string[] = [];
  const walk = (dir: string): void => { for (const entry of readdirSync(dir)) { const path = join(dir, entry); const stat = lstatSync(path); if (stat.isDirectory()) walk(path); else if (entry === 'SKILL.md') skillFiles.push(path); } };
  walk(join(destination, 'skills'));
  for (const skill of skillFiles) {
    const relative = skill.slice(join(destination, 'skills').length + 1).split('/');
    const sourceName = relative.length >= 2 ? relative[relative.length - 2] : undefined;
    if (sourceName === undefined) throw new Error(`Pi skill has no directory name: ${skill}`);
    const name = `${plugin}-${sourceName}`; piSkillName(name);
    if (name.length > 64) throw new Error(`Pi standalone skill name exceeds 64 characters: ${name}`);
    const text = readFileSync(skill, 'utf8');
    if (!/^---\n[\s\S]*?^description\s*:\s*\S[\s\S]*?^---\s*$/m.test(text)) throw new Error(`Pi skill needs frontmatter description: ${skill}`);
    writeFileSync(skill, namespaceSkill(text, name));
  }
  if (skillFiles.length === 0) throw new Error('Pi standalone delivery found no SKILL.md files');
  assertTree(destination); return destination;
}

function namespaceSkill(text: string, name: string): string {
  const end = text.indexOf('\n---', 3); if (!text.startsWith('---\n') || end === -1) throw new Error('Pi skill frontmatter is malformed');
  const front = text.slice(0, end + 4);
  const next = /^name\s*:/m.test(front) ? front.replace(/^name\s*:.*$/m, `name: ${name}`) : front.slice(0, -4) + `\nname: ${name}\n---`;
  return next + text.slice(end + 4);
}

function packageName(plugin: string, market: string): string { return `${market}___${plugin}`; }
function owner(dir: string): Owner | null { const file = join(dir, MARKER); if (!existsSync(file)) return null; try { const x: unknown = JSON.parse(readFileSync(file, 'utf8')); if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error('not an object'); const r = x as Record<string, unknown>; if (typeof r.source !== 'string' || typeof r.pluginId !== 'string' || typeof r.fingerprint !== 'string') throw new Error('fields are invalid'); return r as Owner; } catch (error) { throw new Error(`invalid Pi ownership marker: ${file} (${(error as Error).message})`); } }
function ownedFor(id: string, source?: string): string[] { assertPiStore(); if (!existsSync(skillsDir())) return []; const out: string[] = []; for (const name of readdirSync(skillsDir())) { const path = join(skillsDir(), name); if (!lstatSync(path).isDirectory()) continue; const mark = owner(path); if (mark?.pluginId === id && (source === undefined || mark.source === source)) out.push(path); } return out; }
function checkTarget(target: string, id: string, source: string): void { assertUnder(skillsDir(), target); if (!existsSync(target)) return; const mark = owner(target); if (mark === null) throw new Error(`Pi standalone skill is unowned; refusing to replace it: ${target}`); if (mark.pluginId !== id || mark.source !== source) throw new Error(`Pi standalone skill belongs to another source; refusing to replace it: ${target}`); }
function sameTree(stage: string, target: string): boolean { if (!existsSync(target)) return false; const bytes = readFileSync as unknown as (path: string) => Uint8Array; const list = (root: string): string[] => { const out: string[] = []; const walk = (dir: string, prefix: string): void => { for (const name of readdirSync(dir).sort()) { if (name === MARKER) continue; const path = join(dir, name), relative = prefix ? `${prefix}/${name}` : name, stat = lstatSync(path); if (stat.isDirectory()) walk(path, relative); else if (stat.isFile()) out.push(`${relative}:${Array.from(bytes(path)).join(',')}`); else throw new Error(`Pi standalone skill contains unsupported entry: ${path}`); } }; walk(root, ''); return out; }; return JSON.stringify(list(stage)) === JSON.stringify(list(target)); }
function assertTree(root: string): void { const stat = lstatSync(root); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Pi plugin root is not a real directory: ${root}`); for (const name of readdirSync(root)) { const path = join(root, name), child = lstatSync(path); if (child.isSymbolicLink()) throw new Error(`Pi plugin contains symlink: ${path}`); if (child.isDirectory()) assertTree(path); else if (!child.isFile()) throw new Error(`Pi plugin contains unsupported entry: ${path}`); } }
function identity(value: string, label: string): void { if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(value)) throw new Error(`unsafe Pi ${label}: ${value}`); }
function piSkillName(value: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) throw new Error(`Pi standalone skill name is not lowercase-hyphenated: ${value}`); }
function ensureStore(): void { assertPiStore(); mkdirSync(piRoot(), { recursive: true }); assertRealDirectory(piRoot()); mkdirSync(skillsDir(), { recursive: true }); assertRealDirectory(skillsDir()); }
function assertPiStore(): void { const root = piRoot(); const home = dirname(dirname(root)); let current = home; for (const part of [basename(dirname(root)), basename(root)]) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Pi managed path component is a symlink: ${current}`); } if (existsSync(root)) assertRealDirectory(root); if (existsSync(skillsDir())) { assertUnder(root, skillsDir()); assertRealDirectory(skillsDir()); } }
function assertRealDirectory(path: string): void { const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`Pi managed path component is a symlink: ${path}`); if (!stat.isDirectory()) throw new Error(`Pi managed path component is not a directory: ${path}`); }
function assertUnder(root: string, path: string): void { const base = resolve(root), candidate = resolve(path); if (candidate !== base && !candidate.startsWith(`${base}/`)) throw new Error(`Pi path escapes standalone skills store: ${path}`); let current = base; for (const part of candidate.slice(base.length).split('/').filter(Boolean)) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Pi managed path component is a symlink: ${current}`); } }
