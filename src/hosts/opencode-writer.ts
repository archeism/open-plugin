/** Transactional OpenCode standalone delivery: private package + skill + command projections. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { opencode, opencodeCommandsDir, opencodePackagesDir, opencodeRoot, opencodeSkillsDir } from './opencode';

import { yamlParse, yamlStringify } from '../yaml';

const MARKER = '.plgnz-install.json';
type Owner = { source: string; pluginId: string; fingerprint: string };
type Move = { target: string; backup?: string };
type ManualSkill = { relative: string; name: string; description: string; body: string; base: string };
type SourceCommand = { relative: string; name: string; description: string; body: string; base: string };
type ProjectedCommand = { relative: string; name: string; description: string; body: string; base: string };

export const opencodeWriter: HostWriter = {
  ...opencode,
  plannedNativeId: (plugin) => `${plugin.name}@${plugin.marketplace ?? 'local'}`,
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const market = plugin.marketplace ?? 'local', id = `${plugin.name}@${market}`, name = packageName(market, plugin.name);
    assertIdentity(market); assertIdentity(plugin.name); assertStore(); assertTree(plugin.dir); assertSupportedRoot(plugin.dir);
    const parent = opts?.dryRun ? tmpdir() : dirname(opencodeRoot());
    if (!opts?.dryRun) mkdirSync(parent, { recursive: true });
    const stage = mkdtempSync(join(parent, '.plgnz-opencode-stage-'));
    try {
      const targets = targetsFor(name, plugin.name); checkTargets(targets, id, resolved.sourceUri);
      const staged = stagePackage(plugin.dir, stage, name, targets.private, { source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '' });
      const unchanged = allSame(staged, targets);
      if (opts?.dryRun) return unchanged ? 'unchanged' : undefined;
      ensureStore(); if (unchanged) return 'unchanged';
      const moves: Move[] = [];
      try {
        for (const key of keys()) {
          const target = targets[key];
          if (!existsSync(target)) { moves.push({ target }); continue; }
          const backupRoot = mkdtempSync(join(dirname(target), '.plgnz-opencode-backup-'));
          const backup = join(backupRoot, 'previous'); renameSync(target, backup); moves.push({ target, backup });
        }
        for (const key of keys()) renameSync(staged[key], targets[key]);
      } catch (error) {
        for (const move of moves.reverse()) { rmSync(move.target, { recursive: true, force: true }); if (move.backup) renameSync(move.backup, move.target); }
        throw error;
      }
      for (const move of moves) if (move.backup) rmSync(dirname(move.backup), { recursive: true, force: true });
    } finally { rmSync(stage, { recursive: true, force: true }); }
  },
  async remove(id: string): Promise<void> {
    const installed = opencode.listInstalled().find(item => item.id === id);
    if (!installed?.path) throw new Error(`OpenCode has no plgnz-owned package for ${id}; refusing to remove`);
    const name = installed.path.slice(opencodePackagesDir().length + 1); if (!validName(name)) throw new Error(`unsafe OpenCode package path: ${installed.path}`);
    const plugin = installed.id.split('@', 1)[0]; if (!plugin || !validName(plugin)) throw new Error(`unsafe OpenCode plugin identity: ${installed.id}`);
    const targets = targetsFor(name, plugin); assertStore();
    for (const key of keys()) if (existsSync(targets[key])) { assertManagedTree(targets[key]); if (!owned(targets[key], id)) throw new Error(`OpenCode target is not owned by ${id}: ${targets[key]}`); }
    const moves: Move[] = [];
    try { for (const key of keys()) { const target = targets[key]; if (!existsSync(target)) continue; const root = mkdtempSync(join(dirname(target), '.plgnz-opencode-remove-')); const backup = join(root, 'previous'); renameSync(target, backup); moves.push({ target, backup }); } }
    catch (error) { for (const move of moves.reverse()) if (move.backup) renameSync(move.backup, move.target); throw error; }
    for (const move of moves) if (move.backup) rmSync(dirname(move.backup), { recursive: true, force: true });
  },
  async pin(_plugin: InstalledPlugin, _opts?: PinOptions): Promise<PinOutcome> { return { changes: [], refusals: [] }; },
};

function stagePackage(source: string, stage: string, name: string, activePrivateRoot: string, ownerValue: Owner): Targets {
  const privateRoot = join(stage, 'private', name), skills = join(stage, 'skills', name), commands = join(stage, 'commands', name);
  mkdirSync(skills, { recursive: true }); mkdirSync(commands, { recursive: true });
  cpSync(source, privateRoot, { recursive: true });
  for (const root of [privateRoot, skills, commands]) writeFileSync(join(root, MARKER), JSON.stringify(ownerValue));
  const manuals = manualSkills(source); const commandsToProject: ProjectedCommand[] = [...sourceCommands(source), ...manuals.map(skill => ({ ...skill, relative: skill.name }))]; const commandNames = new Set<string>();
  for (const command of commandsToProject) { if (commandNames.has(command.name)) throw new Error(`command collision: ${command.name}`); commandNames.add(command.name); }
  for (const command of commandsToProject) writeCommand(join(commands, `${command.relative}.md`), command.description, rewriteCommandReferences(command.body, commandNames, ownerValue.pluginId.split('@', 1)[0] ?? ''), join(activePrivateRoot, command.base));
  cpSync(source, skills, { recursive: true });
  for (const skill of manuals) rmSync(join(skills, skill.relative), { force: true });
  for (const root of [privateRoot, skills, commands]) writeFileSync(join(root, MARKER), JSON.stringify(ownerValue));
  return { private: privateRoot, skills, commands };
}
function sourceCommands(source: string): SourceCommand[] {
  const root = existsSync(join(source, '.claude', 'commands')) ? join(source, '.claude', 'commands') : join(source, 'commands');
  if (!existsSync(root)) return [];
  const out: SourceCommand[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir).sort()) { const path = join(dir, entry), stat = lstatSync(path); if (stat.isDirectory()) { walk(path); continue; } if (!stat.isFile()) throw new Error(`OpenCode command is not a regular file: ${path}`); if (entry.endsWith('.toml')) throw new Error(`OpenCode cannot preserve TOML command semantics: ${path}`); if (!entry.endsWith('.md')) continue; const parsed = commandMarkdown(readFileSync(path, 'utf8'), path); const relative = path.slice(root.length + 1, -3); out.push({ relative, name: relative, description: parsed.description, body: parsed.body, base: dirname(path).slice(source.length + 1) }); } };
  walk(root);
  return out;
}
function manualSkills(source: string): ManualSkill[] {
  const root = join(source, 'skills'); if (!existsSync(root)) return [];
  const out: ManualSkill[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir).sort()) { const path = join(dir, entry), stat = lstatSync(path); if (stat.isDirectory()) walk(path); else if (stat.isFile() && entry === 'SKILL.md') { const parsed = markdown(readFileSync(path, 'utf8'), path); if (parsed.manual) out.push({ relative: path.slice(source.length + 1), name: parsed.name, description: parsed.description, body: parsed.body, base: dirname(path).slice(source.length + 1) }); } } };
  walk(root); return out;
}
function writeCommand(path: string, description: string, body: string, privateRoot: string): void { const preservedBody = body.endsWith('\n') ? body : `${body}\n`; mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `---\ndescription: ${JSON.stringify(description)}\n---\n\n${preservedBody}\nBase directory for this command: ${privateRoot}\nRelative paths in this command are relative to this base directory.\n`); }
function rewriteCommandReferences(body: string, names: Set<string>, namespace: string): string { return body.replace(/(^|[^A-Za-z0-9_/-])\/([A-Za-z0-9][A-Za-z0-9._/-]*)(?=\s|$|[.,:;!?])/gu, (whole, prefix: string, name: string) => names.has(name) ? `${prefix}/${namespace}/${name}` : whole); }
function markdown(raw: string, path: string): { name: string; description: string; body: string; manual: boolean } { const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/); if (!match) throw new Error(`OpenCode projection needs Markdown frontmatter: ${path}`); let value: unknown; try { value = yamlParse(match[1] ?? ''); } catch { throw new Error(`OpenCode projection has invalid YAML: ${path}`); } if (!record(value)) throw new Error(`OpenCode projection frontmatter must be an object: ${path}`); const description = value['description']; if (typeof description !== 'string' || !description.trim()) throw new Error(`OpenCode projection needs description: ${path}`); const name = typeof value['name'] === 'string' ? value['name'] : basenameStem(path); if (!validName(name)) throw new Error(`unsafe OpenCode command or skill name: ${path}`); const userInvocable = policy(value, 'user-invocable', 'user_invocable', path); if (userInvocable === false) throw new Error(`OpenCode cannot preserve user-invocable: false: ${path}`); const disableModelInvocation = policy(value, 'disable-model-invocation', 'disable_model_invocation', path); return { name, description, body: match[2] ?? '', manual: disableModelInvocation === true }; }
function policy(frontmatter: Record<string, unknown>, hyphen: string, underscore: string, path: string): boolean | undefined { const first = frontmatter[hyphen], second = frontmatter[underscore]; if (first !== undefined && second !== undefined && first !== second) throw new Error(`conflicting OpenCode policy aliases ${hyphen}/${underscore}: ${path}`); const value = first ?? second; if (value !== undefined && typeof value !== 'boolean') throw new Error(`OpenCode policy ${hyphen} must be boolean: ${path}`); return value; }
function commandMarkdown(raw: string, path: string): { description: string; body: string } { const parsed = markdown(raw, path); const front = yamlParse((raw.match(/^---\r?\n([\s\S]*?)\r?\n---/) ?? [])[1] ?? ''); if (!record(front)) throw new Error(`OpenCode command frontmatter must be an object: ${path}`); for (const key of Object.keys(front)) if (key !== 'description') throw new Error(`OpenCode cannot preserve command metadata ${key}: ${path}`); if (/!`[\s\S]*?`/u.test(parsed.body) || /@\{/u.test(parsed.body)) throw new Error(`OpenCode cannot preserve command preprocessing: ${path}`); return parsed; }
function basenameStem(path: string): string { const value = path.split('/').at(-2); if (!value) throw new Error(`OpenCode skill has no directory name: ${path}`); return value; }
function packageName(market: string, plugin: string): string { const marketBytes = encode(market), pluginBytes = encode(plugin); return `plgnz-m${marketBytes.length}-${marketBytes}-p${pluginBytes.length}-${pluginBytes}`; }
function encode(value: string): string { return [...value].map(char => char.codePointAt(0)?.toString(16) ?? '').join('x'); }
function validName(value: string): boolean { return /^[a-z0-9][a-z0-9._-]*$/iu.test(value); }
function assertIdentity(value: string): void { if (!validName(value)) throw new Error(`unsafe OpenCode identity: ${value}`); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
type Targets = { private: string; skills: string; commands: string };
function keys(): Array<keyof Targets> { return ['private', 'skills', 'commands']; }
function targetsFor(name: string, commandNamespace: string): Targets { return { private: join(opencodePackagesDir(), name), skills: join(opencodeSkillsDir(), name), commands: join(opencodeCommandsDir(), commandNamespace) }; }
function owner(path: string): Owner | null { const file = join(path, MARKER); if (!existsSync(file)) return null; try { const value: unknown = JSON.parse(readFileSync(file, 'utf8')); if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(); const item = value as Owner; if (typeof item.source !== 'string' || typeof item.pluginId !== 'string' || typeof item.fingerprint !== 'string') throw new Error(); return item; } catch { throw new Error(`invalid OpenCode ownership marker: ${file}`); } }
function owned(privateTarget: string, id: string, source?: string): boolean { const mark = owner(privateTarget); return mark !== null && mark.pluginId === id && (source === undefined || mark.source === source); }
function checkTargets(targets: Targets, id: string, source: string): void { for (const key of keys()) if (existsSync(targets[key])) { assertManagedTree(targets[key]); if (!owned(targets[key], id, source)) throw new Error(`OpenCode target is unowned or belongs to another source: ${targets[key]}`); } }
function allSame(staged: Targets, targets: Targets): boolean { return keys().every(key => sameTree(staged[key], targets[key])); }
function sameTree(a: string, b: string): boolean { if (!existsSync(a) || !existsSync(b)) return false; const bytes = readFileSync as unknown as (path: string) => Uint8Array; const list = (root: string): string[] => { const out: string[] = []; const walk = (dir: string, prefix: string) => { for (const name of readdirSync(dir).sort()) { if (name === MARKER) continue; const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name, stat = lstatSync(path); if (stat.isDirectory()) walk(path, rel); else if (stat.isFile()) out.push(`${rel}:${Array.from(bytes(path)).join(',')}`); else throw new Error(`OpenCode package has unsupported entry: ${path}`); } }; walk(root, ''); return out; }; return JSON.stringify(list(a)) === JSON.stringify(list(b)); }
function assertTree(root: string): void { const stat = lstatSync(root); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OpenCode plugin root is not a real directory: ${root}`); for (const name of readdirSync(root)) { const path = join(root, name), child = lstatSync(path); if (name === MARKER) throw new Error(`OpenCode plugin reserves ${MARKER}: ${path}`); if (child.isSymbolicLink()) throw new Error(`OpenCode plugin contains symlink: ${path}`); if (child.isDirectory()) assertTree(path); else if (!child.isFile()) throw new Error(`OpenCode plugin contains unsupported entry: ${path}`); } }
function assertManagedTree(root: string): void { const stat = lstatSync(root); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OpenCode managed tree is unsafe: ${root}`); for (const name of readdirSync(root)) { const path = join(root, name), child = lstatSync(path); if (child.isSymbolicLink()) throw new Error(`OpenCode managed tree contains symlink: ${path}`); if (child.isDirectory()) assertManagedTree(path); else if (!child.isFile()) throw new Error(`OpenCode managed tree contains unsupported entry: ${path}`); } }
function assertSupportedRoot(source: string): void { for (const entry of ['agents', 'hooks', '.claude/agents', '.claude/hooks', 'mcp.json', '.mcp.json']) if (existsSync(join(source, entry))) throw new Error(`OpenCode cannot preserve root ${entry} semantics: ${join(source, entry)}`); for (const file of ['plugin.json', '.plugin/plugin.json', '.claude-plugin/plugin.json']) { const path = join(source, file); if (!existsSync(path)) continue; let manifest: unknown; try { manifest = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`OpenCode plugin manifest is invalid: ${path}`); } if (!record(manifest)) throw new Error(`OpenCode plugin manifest is invalid: ${path}`); for (const field of ['mcpServers', 'hooks', 'agents']) if (manifest[field] !== undefined) throw new Error(`OpenCode cannot preserve plugin manifest ${field}: ${path}`); } }
function assertStore(): void { for (const path of [opencodeRoot(), join(opencodeRoot(), '.plgnz'), opencodePackagesDir(), opencodeSkillsDir(), opencodeCommandsDir()]) if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error(`OpenCode managed path is unsafe: ${path}`); }
function ensureStore(): void { for (const path of [opencodeRoot(), join(opencodeRoot(), '.plgnz'), opencodePackagesDir(), opencodeSkillsDir(), opencodeCommandsDir()]) { mkdirSync(path, { recursive: true }); assertStore(); } }
