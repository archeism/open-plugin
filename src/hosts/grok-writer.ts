/** Transactional Grok Build marketplace writer. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { fingerprintTree } from '../fingerprint';
import { pinPluginMcpFiles } from '../mcp-write';
import { homeRoot, grokRoot } from '../paths';
import { grok, MARKER, canonical, localSourceOf, marketplacesRoot, namesOf, ownership, provenanceOf, registryIsReadable, repos, type GrokOwnership } from './grok';

declare const Bun: { YAML: { parse(input: string): unknown; stringify(value: unknown): string }; CryptoHasher: new (algorithm: string) => { update(value: string): void; digest(encoding: 'hex'): string } };

type MarketplaceRow = { name?: unknown; kind?: unknown; source?: { path?: unknown } };
const stableId = (plugin: PluginSource) => plugin.marketplace === undefined ? plugin.name : `${plugin.name}@${plugin.marketplace}`;
const digest = (value: string) => { const hash = new Bun.CryptoHasher('sha256'); hash.update(value); return hash.digest('hex').slice(0, 16); };

export const grokWriter: HostWriter = {
  ...grok,
  supportsAdoption: true,
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const nativeFingerprint = validateGrokSource(plugin.dir);
    if (!registryIsReadable()) throw new Error('Grok native registry is unreadable or unsupported; refusing mutation');
    const id = stableId(plugin); const root = join(marketplacesRoot(), `plgnz-${digest(`${resolved.sourceUri}\0${id}`)}`); const parent = dirname(root);
    const prior = canonical(root); const priorMarker = prior === undefined ? null : ownership(prior);
    if (prior !== undefined && priorMarker === null) throw new Error(`Grok marketplace ${root} is unowned; refusing to replace it`);
    if (priorMarker !== null && (priorMarker.source !== resolved.sourceUri || priorMarker.pluginId !== id)) throw new Error(`Grok marketplace ${root} belongs to another source; refusing to replace it`);
    const legacy = legacyCandidate(plugin, opts?.adoptExisting === true, prior);
    if (legacy === undefined) assertExistingNativeOwnership(id, plugin.name, root);
    const activation = join(grokRoot(), 'plugins', plugin.name);
    const existingNative = grok.listInstalled().find(candidate => candidate.name === plugin.name)?.path;
    assertActivationLink(activation, existingNative);
    const unchanged = lstatExists(activation) && prior !== undefined && priorMarker?.fingerprint === plugin.contentFingerprint && priorMarker?.nativeFingerprint === nativeFingerprint && existsSync(join(prior, 'plugins', plugin.name)) && fingerprintTree(join(prior, 'plugins', plugin.name)) === nativeFingerprint && current(id, prior, plugin.name, nativeFingerprint);
    if (opts?.dryRun) return unchanged ? 'unchanged' : undefined;
    if (unchanged) return 'unchanged';
    mkdirSync(parent, { recursive: true });
    const stage = mkdtempSync(join(parent, '.plgnz-grok-stage-'));
    const stagedRoot = join(stage, basename(root));
    try {
      const stagedPlugin = join(stagedRoot, 'plugins', plugin.name);
      mkdirSync(dirname(stagedPlugin), { recursive: true }); cpSync(plugin.dir, stagedPlugin, { recursive: true });
      projectGrokSource(stagedPlugin);
      const catalog = join(stagedRoot, '.grok-plugin', 'marketplace.json');
      mkdirSync(dirname(catalog), { recursive: true });
      writeFileSync(catalog, JSON.stringify({ name: basename(root), plugins: [{ name: plugin.name, source: `./plugins/${plugin.name}` }] }));
      writeFileSync(join(stagedRoot, MARKER), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '', nativeFingerprint } satisfies GrokOwnership));
      run(['plugin', 'validate', stagedPlugin]);
      const priorFingerprint = priorMarker?.nativeFingerprint;
      const backup = prior === undefined ? undefined : `${root}.plgnz-backup-${Date.now()}`;
      let backedUp = false;
      let legacyRemoved = false;
      let legacyLinkRemoved = false;
      let activationCreated = false;
      try {
        if (prior !== undefined) { renameSync(prior, backup!); backedUp = true; }
        renameSync(stagedRoot, root);
        ensureMarketplace(root);
        if (legacy !== undefined) {
          run(['plugin', 'uninstall', plugin.name, '--confirm']);
          legacyRemoved = true;
          if (grok.listInstalled().some(candidate => candidate.name === plugin.name)) throw new Error(`Grok ${id}: legacy uninstall left an active record`);
          if (legacy.link !== undefined) { rmSync(legacy.link); legacyLinkRemoved = true; }
        }
        const installed = grok.listInstalled().find(candidate => candidate.id === id);
        if (installed === undefined) run(['plugin', 'install', `${plugin.name}@local/${basename(root)}`, '--trust']);
        else run(['plugin', 'update', plugin.name]);
        run(['plugin', 'enable', plugin.name]);
        const nativePath = grok.listInstalled().find(candidate => candidate.id === id)?.path;
        if (nativePath === undefined) throw new Error(`Grok ${id}: native install path is missing`);
        assertActivationLink(activation, nativePath);
        if (!lstatExists(activation)) {
          mkdirSync(dirname(activation), { recursive: true });
          symlinkSync(nativePath, activation);
          activationCreated = true;
        }
        if (!current(id, root, plugin.name, nativeFingerprint)) throw new Error(`Grok ${id}: native readback does not match staged content`);
      } catch (error) {
        if (activationCreated) rmSync(activation);
        if (backedUp && backup !== undefined) {
          rmSync(root, { recursive: true, force: true }); renameSync(backup, root);
          try {
            ensureMarketplace(root); run(['plugin', 'update', plugin.name]); run(['plugin', 'enable', plugin.name]);
            if (!current(id, root, plugin.name, priorFingerprint)) throw new Error(`Grok ${id}: native rollback did not restore the prior bytes`);
          } catch (rollback) { throw new Error(`Grok ${id}: update failed and native rollback could not be verified: ${(rollback as Error).message}`, { cause: error }); }
        } else if (backup === undefined) {
          try {
            if (marketplaceSources().some(row => typeof row.source?.path === 'string' && canonical(row.source.path) === canonical(root))) run(['plugin', 'marketplace', 'remove', root]);
            rmSync(root, { recursive: true, force: true });
            if (legacy !== undefined && legacyRemoved) {
              run(['plugin', 'install', legacy.source, '--trust']);
              run(['plugin', 'enable', plugin.name]);
              const restored = grok.listInstalled().find(candidate => candidate.name === plugin.name);
              if (restored?.path === undefined || fingerprintTree(restored.path) !== legacy.fingerprint) throw new Error(`Grok ${id}: legacy native content was not restored`);
              if (legacyLinkRemoved && legacy.link !== undefined) symlinkSync(restored.path, legacy.link);
            }
          } catch (rollback) { throw new Error(`Grok ${id}: install failed and cleanup could not be verified: ${(rollback as Error).message}`, { cause: error }); }
        }
        throw error;
      }
      if (backup !== undefined) rmSync(backup, { recursive: true, force: true });
    } finally { rmSync(stage, { recursive: true, force: true }); }
  },
  async remove(id: string): Promise<void> {
    if (!registryIsReadable()) throw new Error('Grok native registry is unreadable or unsupported; refusing mutation');
    const installed = grok.listInstalled().filter(plugin => plugin.id === id);
    if (installed.length !== 1 || installed[0]?.path === undefined) throw new Error(`Grok ${id} is not a single plgnz-owned install; refusing native removal`);
    const native = repos().find(([, candidate]) => candidate.path === installed[0]!.path);
    if (native === undefined) throw new Error(`Grok ${id}: native registry readback is missing`);
    const repo = native[1];
    const provenance = provenanceOf(repo); if (provenance === null) throw new Error(`Grok ${id}: native install has no marketplace provenance`);
    const root = canonical(provenance.root); const marker = root === undefined ? null : ownership(root);
    if (root === undefined || marker?.pluginId !== id || marker.source === '' || provenance.subdir !== `plugins/${installed[0]!.name}` || canonical(localSourceOf(repo) ?? '') !== canonical(join(root, 'plugins', installed[0]!.name)) || namesOf(repo).length !== 1 || namesOf(repo)[0] !== installed[0]!.name) throw new Error(`Grok ${id}: native ownership proof is incomplete; refusing removal`);
    assertOwnedRoot(root);
    const shared = repos().filter(([, candidate]) => canonical(provenanceOf(candidate)?.root ?? '') === root);
    if (shared.length !== 1) throw new Error(`Grok ${id}: marketplace root is shared by another native install; refusing removal`);
    const sources = marketplaceSources().filter(source => typeof source.source?.path === 'string' && canonical(source.source.path) === root);
    if (sources.length !== 1) throw new Error(`Grok ${id}: marketplace source is missing or ambiguous; refusing removal`);
    const activation = join(grokRoot(), 'plugins', installed[0]!.name);
    assertActivationLink(activation, installed[0]!.path);
    const linked = lstatExists(activation);
    run(['plugin', 'marketplace', 'remove', sources[0]!.source!.path as string]);
    if (grok.listInstalled().some(plugin => plugin.id === id)) throw new Error(`Grok ${id}: native removal did not deactivate the plugin`);
    if (linked) rmSync(activation);
    rmSync(root, { recursive: true, force: true });
  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    return plugin.path === undefined ? { changes: [], refusals: [] } : pinPluginMcpFiles(plugin.path, [
      { kind: 'spec', file: '.mcp.json' },
      { kind: 'inline', manifest: 'plugin.json' },
    ], opts);
  },
};

function basename(path: string): string { return path.slice(path.lastIndexOf('/') + 1); }
/** Native user plugins precede Claude compatibility imports; never replace foreign paths. */
function assertActivationLink(link: string, nativePath: string | undefined): void {
  if (!lstatExists(link)) return;
  if (nativePath === undefined || !lstatSync(link).isSymbolicLink() || canonical(nativePath) === undefined || canonical(link) !== canonical(nativePath)) {
    throw new Error(`Grok activation path is not the registered native plugin: ${link}`);
  }
}
/** Grok Build resolves its native store from GROK_HOME (xai-dirs/src/lib.rs). */
function env(): Record<string, string | undefined> { const home = homeRoot(); return { ...process.env, HOME: home, GROK_HOME: grokRoot(), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), CLAUDE_CONFIG_DIR: join(home, '.claude') }; }
function binary(): string { const value = process.env['OPEN_PLUGIN_GROK_BIN'] ?? 'grok'; return value; }
function run(args: string[]): string { const result = spawnSync(binary(), args, { env: env(), encoding: 'utf8' }); if (result.status !== 0) throw new Error(`grok ${args.join(' ')}: ${(result.stderr || result.stdout).trim()}`); return result.stdout; }
function marketplaceSources(): MarketplaceRow[] { try { const value: unknown = JSON.parse(run(['plugin', 'marketplace', 'list', '--json'])); return Array.isArray(value) ? value.filter((row): row is MarketplaceRow => row !== null && typeof row === 'object') : []; } catch { return []; } }
function ensureMarketplace(root: string): void { const rows = marketplaceSources().filter(row => typeof row.source?.path === 'string' && canonical(row.source.path) === canonical(root)); if (rows.length === 0) run(['plugin', 'marketplace', 'add', root]); else if (rows.length !== 1) throw new Error(`Grok marketplace ${root} is ambiguous`); }
function current(id: string, root: string, name: string, fingerprint?: string): boolean {
  const plugin = grok.listInstalled().find(candidate => candidate.id === id);
  if (plugin?.path === undefined || plugin.enabled === false || (fingerprint !== undefined && fingerprintTree(plugin.path) !== fingerprint)) return false;
  const repo = repos().find(([, candidate]) => candidate.path === plugin.path)?.[1];
  if (repo === undefined) return false;
  const provenance = provenanceOf(repo);
  return provenance !== null && canonical(provenance.root) === canonical(root) && canonical(localSourceOf(repo) ?? '') === canonical(join(root, 'plugins', name)) && provenance.subdir === `plugins/${name}` && namesOf(repo).length === 1 && namesOf(repo)[0] === name && inspectCurrent(name, plugin.path);
}
function inspectCurrent(name: string, path: string): boolean { try { const value: unknown = JSON.parse(run(['inspect', '--json'])); if (value === null || typeof value !== 'object' || Array.isArray(value)) return false; const plugins = (value as Record<string, unknown>)['plugins']; return Array.isArray(plugins) && plugins.some(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry) && (entry as Record<string, unknown>)['name'] === name && (entry as Record<string, unknown>)['enabled'] !== false && typeof (entry as Record<string, unknown>)['path'] === 'string' && canonical((entry as Record<string, unknown>)['path'] as string) === canonical(path)); } catch { return false; } }
function validateGrokSource(dir: string): string {
  const stage = mkdtempSync(join(tmpdir(), 'plgnz-grok-preflight-'));
  try { cpSync(dir, stage, { recursive: true }); projectGrokSource(stage); return fingerprintTree(stage); }
  finally { rmSync(stage, { recursive: true, force: true }); }
}

/** Grok consumes native Markdown commands and frontmatter, not Codex policy sidecars. */
function projectGrokSource(dir: string): void {
  const manifest = join(dir, 'plugin.json');
  if (existsSync(manifest)) {
    const doc = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    if (doc['permissions'] !== undefined) throw new Error(`Grok permission semantics are unverified: ${manifest}`);
    if (doc['commands'] !== undefined && doc['commands'] !== './commands' && doc['commands'] !== './commands/') throw new Error(`Grok custom command path is unverified: ${manifest}`);
  }
  const skills = join(dir, 'skills');
  if (existsSync(skills)) for (const name of readdirSync(skills)) {
    const skill = join(skills, name); if (!lstatSync(skill).isDirectory()) continue;
    const file = join(skill, 'SKILL.md'); if (!existsSync(file)) continue;
    const raw = readFileSync(file, 'utf8'); const fm = openingFrontmatter(raw, file);
    const hadAlias = fm !== undefined && (Object.hasOwn(fm, 'disable_model_invocation') || Object.hasOwn(fm, 'user_invocable'));
    const manual = fm === undefined ? undefined : normalizeBooleanPolicy(fm, 'disable-model-invocation', 'disable_model_invocation', file);
    if (fm !== undefined) normalizeBooleanPolicy(fm, 'user-invocable', 'user_invocable', file);
    const sidecar = join(skill, 'agents', 'openai.yaml');
    let sidecarManual: boolean | undefined;
    if (existsSync(sidecar)) {
      const parsed: unknown = Bun.YAML.parse(readFileSync(sidecar, 'utf8'));
      const policy = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)['policy'] : undefined;
      if (policy !== undefined) {
        if (!policy || typeof policy !== 'object' || Array.isArray(policy) || typeof (policy as Record<string, unknown>)['allow_implicit_invocation'] !== 'boolean') throw new Error(`invalid Grok invocation sidecar: ${sidecar}`);
        sidecarManual = !(policy as Record<string, boolean>)['allow_implicit_invocation'];
      }
    }
    if (manual !== undefined && sidecarManual !== undefined && manual !== sidecarManual) throw new Error(`conflicting Grok invocation policy: ${file}`);
    if (sidecarManual !== undefined && manual === undefined) {
      if (fm === undefined) throw new Error(`Grok skill frontmatter required for sidecar policy: ${file}`);
      fm['disable-model-invocation'] = sidecarManual;
    }
    if (fm !== undefined && (sidecarManual !== undefined && manual === undefined || hadAlias)) writeFileSync(file, withFrontmatter(raw, fm, file));
  }
  const commands = join(dir, 'commands'); const claudeCommands = join(dir, '.claude', 'commands');
  const seen = new Set<string>();
  // Host-specific command trees are alternatives, not additive namespaces.
  // Prefer Grok's root commands; retain Claude-only packages as a fallback.
  for (const source of [existsSync(commands) ? commands : claudeCommands]) {
    if (!existsSync(source)) continue;
    for (const entry of readdirSync(source)) {
      const path = join(source, entry); const stat = lstatSync(path);
      if (!stat.isFile() || !/\.(md|toml)$/u.test(entry)) continue;
      const name = entry.replace(/\.(md|toml)$/u, '');
      if (seen.has(name)) throw new Error(`duplicate Grok command ${name}`); seen.add(name);
      if (existsSync(join(skills, name, 'SKILL.md'))) throw new Error(`Grok command ${name} collides with a native skill`);
      const output = join(commands, `${name}.md`);
      if (entry.endsWith('.md')) {
        const raw = readFileSync(path, 'utf8'); const fm = openingFrontmatter(raw, path);
        if (!fm || typeof fm.description !== 'string') throw new Error(`Grok command needs description frontmatter: ${path}`);
        const manual = normalizeBooleanPolicy(fm, 'disable-model-invocation', 'disable_model_invocation', path);
        normalizeBooleanPolicy(fm, 'user-invocable', 'user_invocable', path);
        if (/!`[\s\S]*?`/u.test(raw)) throw new Error(`Grok executable command preprocessing is unsupported: ${path}`);
        if (fm['allowed-tools'] !== undefined || fm['permissionMode'] !== undefined) throw new Error(`Grok command permission semantics are unverified: ${path}`);
        mkdirSync(commands, { recursive: true });
        if (manual === undefined) fm['disable-model-invocation'] = true;
        writeFileSync(output, withFrontmatter(raw, fm, path));
      } else {
        const parsed: unknown = parseToml(readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid Grok TOML command: ${path}`);
        const doc = parsed as Record<string, unknown>;
        if (typeof doc.description !== 'string' || typeof doc.prompt !== 'string') throw new Error(`Grok TOML command needs description and prompt: ${path}`);
        if (Object.keys(doc).some(key => !['description', 'prompt', 'argument-hint', 'argument_hint', 'disable-model-invocation', 'disable_model_invocation', 'user-invocable', 'user_invocable'].includes(key))) throw new Error(`Grok TOML command has unsupported metadata: ${path}`);
        for (const [native, alias] of [['argument-hint', 'argument_hint'], ['disable-model-invocation', 'disable_model_invocation'], ['user-invocable', 'user_invocable']] as const) if (doc[native] !== undefined && doc[alias] !== undefined && doc[native] !== doc[alias]) throw new Error(`conflicting Grok TOML command metadata: ${path}`);
        if (/!`[\s\S]*?`/u.test(doc.prompt)) throw new Error(`Grok executable command preprocessing is unsupported: ${path}`);
        const hint = doc['argument-hint'] ?? doc.argument_hint;
        const disabled = doc['disable-model-invocation'] ?? doc.disable_model_invocation ?? true;
        const invocable = doc['user-invocable'] ?? doc.user_invocable ?? true;
        if ((hint !== undefined && typeof hint !== 'string') || typeof disabled !== 'boolean' || typeof invocable !== 'boolean') throw new Error(`invalid Grok TOML command policy: ${path}`);
        mkdirSync(commands, { recursive: true });
        writeFileSync(output, `---\ndescription: ${JSON.stringify(doc.description)}\n${hint === undefined ? '' : `argument-hint: ${JSON.stringify(hint)}\n`}disable-model-invocation: ${disabled}\nuser-invocable: ${invocable}\n---\n\n${doc.prompt}`);
      }
    }
  }
  const legacyMcp = join(dir, 'mcp.json'); const nativeMcp = join(dir, '.mcp.json');
  if (existsSync(legacyMcp) && existsSync(nativeMcp) && readFileSync(legacyMcp, 'utf8') !== readFileSync(nativeMcp, 'utf8')) throw new Error(`conflicting Grok MCP declarations: ${legacyMcp} and ${nativeMcp}`);
  if (existsSync(legacyMcp) && !existsSync(nativeMcp)) cpSync(legacyMcp, nativeMcp);
  if (existsSync(nativeMcp)) { const value = JSON.parse(readFileSync(nativeMcp, 'utf8')) as Record<string, unknown>; const servers = value?.['mcpServers']; if (!value || typeof value !== 'object' || !servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`invalid Grok MCP declaration: ${nativeMcp}`); }
}
function openingFrontmatter(raw: string, path: string): Record<string, unknown> | undefined { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw); if (match === null) return undefined; let value: unknown; try { value = Bun.YAML.parse(match[1] ?? ''); } catch { throw new Error(`Grok skill frontmatter has invalid YAML: ${path}`); } if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Grok skill frontmatter must be an object: ${path}`); return value as Record<string, unknown>; }
function normalizeBooleanPolicy(metadata: Record<string, unknown>, native: string, alias: string, path: string): boolean | undefined {
  const first = metadata[native], second = metadata[alias];
  if (first !== undefined && second !== undefined && first !== second) throw new Error(`conflicting Grok invocation policy spellings: ${path}`);
  const value = first ?? second;
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`Grok ${native} must be boolean: ${path}`);
  if (second !== undefined) { metadata[native] = value; delete metadata[alias]; }
  return value as boolean | undefined;
}
function withFrontmatter(raw: string, metadata: Record<string, unknown>, path: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/u.exec(raw);
  if (match === null) throw new Error(`Grok frontmatter required: ${path}`);
  return `---\n${Bun.YAML.stringify(metadata).trimEnd()}\n---${raw.slice(match[0].length)}`;
}
type LegacyInstall = { source: string; fingerprint: string; link?: string };
function legacyCandidate(plugin: PluginSource, adopt: boolean, prior: string | undefined): LegacyInstall | undefined {
  const matches = grok.listInstalled().filter(candidate => candidate.name === plugin.name);
  if (matches.length === 0 || matches.length === 1 && matches[0]?.id === stableId(plugin)) return undefined;
  if (!adopt || prior !== undefined || matches.length !== 1 || matches[0]?.path === undefined || matches[0].enabled === false) throw new Error(`Grok ${plugin.name}: an existing native install is not plgnz-owned; refusing to replace it`);
  const installed = canonical(matches[0].path);
  const base = canonical(join(grokRoot(), 'installed-plugins'));
  if (installed === undefined || base === undefined || !installed.startsWith(`${base}/`) || lstatSync(matches[0].path).isSymbolicLink()) throw new Error(`Grok ${plugin.name}: legacy native path is unsafe`);
  const rows = repos().filter(([, repo]) => canonical(typeof repo.path === 'string' ? repo.path : '') === installed);
  if (rows.length !== 1 || provenanceOf(rows[0]![1]) !== null || namesOf(rows[0]![1]).length !== 1 || namesOf(rows[0]![1])[0] !== plugin.name) throw new Error(`Grok ${plugin.name}: legacy native identity is ambiguous`);
  const source = localSourceOf(rows[0]![1]);
  if (source === undefined || !existsSync(source) || lstatSync(source).isSymbolicLink()) throw new Error(`Grok ${plugin.name}: legacy source is missing or unsafe`);
  const oldManifest = JSON.parse(readFileSync(join(installed, 'plugin.json'), 'utf8')) as Record<string, unknown>;
  const newManifest = JSON.parse(readFileSync(join(plugin.dir, 'plugin.json'), 'utf8')) as Record<string, unknown>;
  if (oldManifest.name !== plugin.name || newManifest.name !== plugin.name || oldManifest.version !== newManifest.version || fingerprintTree(source) !== fingerprintTree(installed)) throw new Error(`Grok ${plugin.name}: legacy source, version, and native bytes must match before adoption`);
  const link = join(grokRoot(), 'plugins', plugin.name);
  if (existsSync(link) || lstatExists(link)) {
    if (!lstatSync(link).isSymbolicLink() || canonical(resolve(dirname(link), readlinkSync(link))) !== installed) throw new Error(`Grok ${plugin.name}: unmanaged same-name plugin link blocks adoption`);
  }
  return { source, fingerprint: fingerprintTree(installed), ...(lstatExists(link) ? { link } : {}) };
}
function lstatExists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
function assertExistingNativeOwnership(id: string, name: string, root: string): void { const matches = grok.listInstalled().filter(plugin => plugin.name === name); if (matches.length === 0) return; if (matches.length !== 1 || matches[0]?.id !== id || matches[0].path === undefined) throw new Error(`Grok ${name}: an existing native install is not plgnz-owned; refusing to replace it`); const repo = repos().find(([, candidate]) => candidate.path === matches[0]!.path)?.[1]; if (repo === undefined) throw new Error(`Grok ${name}: an existing native install has no registry record`); const provenance = provenanceOf(repo); if (provenance === null || canonical(provenance.root) !== canonical(root) || canonical(localSourceOf(repo) ?? '') !== canonical(join(root, 'plugins', name)) || provenance.subdir !== `plugins/${name}` || namesOf(repo).length !== 1) throw new Error(`Grok ${name}: an existing native install has foreign provenance; refusing to replace it`); }
function assertOwnedRoot(root: string): void { const base = canonical(marketplacesRoot()); if (base === undefined || root === base || !root.startsWith(`${base}/`)) throw new Error(`Grok marketplace root escapes plgnz storage: ${root}`); const relative = root.slice(base.length + 1).split('/'); let current = base; for (const part of relative) { current = join(current, part); const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Grok marketplace root is not a safe owned directory: ${current}`); } }
