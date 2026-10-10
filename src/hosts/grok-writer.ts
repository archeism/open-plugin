/** Transactional Grok Build marketplace writer. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { tmpdir } from 'node:os';
import { createCapabilityEvidenceProfile, type CapabilityEvidenceProfile } from '../capability-evidence';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type {
  ActivationPreparationCapture,
  CleanupDisposition,
  CleanupReference,
  DurableLifecycleOperation,
  LifecycleHostAdapter,
  LifecycleHostDefinition,
  LifecycleReadbackData,
  LifecycleTargetIdentity,
  NativeMutationScopeData,
  NativeProjectionData,
  NativeProjectionRequest,
  ResolvedLifecyclePin,
  TargetInventoryData,
  TargetVersionObservation,
} from '../lifecycle-host';
import { createLifecycleHostAdapter, createTargetInventoryObservation } from '../lifecycle-runtime';
import type { PluginSource, ResolvedSource } from '../source';
import { fingerprintTree } from '../fingerprint';
import { pinPluginMcpFiles } from '../mcp-write';
import { homeRoot, grokRoot } from '../paths';
import { grok, MARKER, canonical, configFile, localSourceOf, marketplacesRoot, namesOf, ownership, parseGrokVersionOutput, provenanceOf, readJson, registryFile, registryIsReadable, repos, type GrokOwnership } from './grok';

import { yamlParse, yamlStringify } from '../yaml';
import { CryptoHasher } from '../runtime';


type MarketplaceRow = { name?: unknown; kind?: unknown; source?: { path?: unknown } };
const stableId = (plugin: PluginSource) => plugin.marketplace === undefined ? plugin.name : `${plugin.name}@${plugin.marketplace}`;
const digest = (value: string) => { const hash = new CryptoHasher('sha256'); hash.update(value); return hash.digest('hex').slice(0, 16); };
function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `array:${JSON.stringify(value.map(item => canonicalJson(item)))}`;
  if (value !== null && typeof value === 'object') return `object:${JSON.stringify(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalJson(item)]))}`;
  return JSON.stringify(value);
}

export const grokWriter: HostWriter = {
  ...grok,
  supportsAdoption: true,
  plannedNativeId: stableId,
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
      const parsed: unknown = yamlParse(readFileSync(sidecar, 'utf8'));
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
  if (existsSync(legacyMcp) && existsSync(nativeMcp) && canonicalJson(JSON.parse(readFileSync(legacyMcp, 'utf8')).mcpServers) !== canonicalJson(JSON.parse(readFileSync(nativeMcp, 'utf8')).mcpServers)) throw new Error(`conflicting Grok MCP declarations: ${legacyMcp} and ${nativeMcp}`);
  if (existsSync(legacyMcp) && !existsSync(nativeMcp)) cpSync(legacyMcp, nativeMcp);
  if (existsSync(nativeMcp)) { const value = JSON.parse(readFileSync(nativeMcp, 'utf8')) as Record<string, unknown>; const servers = value?.['mcpServers']; if (!value || typeof value !== 'object' || !servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`invalid Grok MCP declaration: ${nativeMcp}`); }
}
function openingFrontmatter(raw: string, path: string): Record<string, unknown> | undefined { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw); if (match === null) return undefined; let value: unknown; try { value = yamlParse(match[1] ?? ''); } catch { throw new Error(`Grok skill frontmatter has invalid YAML: ${path}`); } if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Grok skill frontmatter must be an object: ${path}`); return value as Record<string, unknown>; }
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
  return `---\n${yamlStringify(metadata).trimEnd()}\n---${raw.slice(match[0].length)}`;
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

const GROK_PROVEN_VERSIONS = ['1.0.24', '1.0.41'] as const;
const RELOAD_EFFECTIVE = { requirement: 'reload', status: 'effective' } as const;
const IDLE_EFFECTIVE = { requirement: 'none', status: 'effective' } as const;
const ABSENT_RETENTION = {
  pluginData: { state: 'absent', fingerprint: null },
  inactiveMetadata: { state: 'absent', fingerprint: null },
} as const;

const grokNativeSemantics = {
  'ordinary-skills': 'supported',
  mcp: 'supported',
  hooks: 'unverified',
  commands: 'supported',
  agents: 'unverified',
  'model-invocation-control': 'supported',
  'user-invocation-control': 'supported',
  'auto-update-control': 'supported',
  resources: 'supported',
  'permissions-preprocessing': 'unsupported',
  retirement: 'unverified',
  'retention-safety': 'unverified',
  readback: 'supported',
  rollback: 'supported',
  'activation-reload': 'supported',
  'reversible-disable': 'unverified',
} as const;

function grokEvidenceProfiles(): readonly CapabilityEvidenceProfile[] {
  return GROK_PROVEN_VERSIONS.map((detectedVersion) => createCapabilityEvidenceProfile({
    host: 'grok',
    detectedVersion,
    sourceTypes: ['local'],
    operations: ['install', 'update'],
    route: 'native',
    operationStatus: 'supported',
    semantics: grokNativeSemantics,
    evidence: [
      'docs/hosts/grok.md',
      'docs/research/native-plugin-update-capabilities-2026-10-09.md',
    ],
  }));
}

function probeGrokVersion(): TargetVersionObservation {
  const result = spawnSync(binary(), ['--version'], { env: env(), encoding: 'utf8' });
  return parseGrokVersionOutput(result.stdout ?? '', result.status);
}

function lifecycleMarketplace(scopeId: string, nativeId: string): string {
  return resolve(join(marketplacesRoot(), `plgnz-${digest(`${scopeId}\0${nativeId}`)}`));
}

function marketplacePluginPath(scopeId: string, nativeId: string, packageName: string): string {
  return resolve(join(lifecycleMarketplace(scopeId, nativeId), 'plugins', packageName));
}

function samePath(left: string, right: string): boolean {
  return (canonical(left) ?? resolve(left)) === (canonical(right) ?? resolve(right));
}

function registryNativePath(nativeId: string, packageName: string, stagedSource: string): string | undefined {
  const installed = grok.listInstalled().find((plugin) => plugin.id === nativeId && plugin.path !== undefined);
  if (installed?.path !== undefined) return resolve(installed.path);
  const staged = canonical(stagedSource) ?? resolve(stagedSource);
  for (const [, repo] of repos()) {
    if (typeof repo.path !== 'string') continue;
    const source = localSourceOf(repo);
    if (source === undefined || (canonical(source) ?? resolve(source)) !== staged) continue;
    if (namesOf(repo).includes(packageName) || namesOf(repo).length === 0) return resolve(repo.path);
  }
  return undefined;
}

function declaredVersion(dir: string): string | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<string, unknown>;
    return typeof value.version === 'string' ? value.version : null;
  } catch {
    return null;
  }
}

function provenMarker(plugin: InstalledPlugin): GrokOwnership | undefined {
  if (plugin.path === undefined) return undefined;
  const repo = repos().find(([, candidate]) => candidate.path === plugin.path)?.[1];
  if (repo === undefined) return undefined;
  const provenance = provenanceOf(repo);
  if (provenance === null) return undefined;
  const root = canonical(provenance.root);
  const base = canonical(marketplacesRoot());
  if (root === undefined || base === undefined || !root.startsWith(`${base}/`)) return undefined;
  const marker = ownership(root);
  if (marker?.pluginId !== plugin.id || marker.nativeFingerprint === undefined) return undefined;
  if (provenance.subdir !== `plugins/${plugin.name}` || namesOf(repo).length !== 1 || namesOf(repo)[0] !== plugin.name) return undefined;
  if (canonical(localSourceOf(repo) ?? '') !== canonical(join(root, 'plugins', plugin.name))) return undefined;
  if (fingerprintTree(plugin.path) !== marker.nativeFingerprint) return undefined;
  return marker;
}

function refuseUnprovenSameName(packageName: string, nativeId: string): void {
  const matches = grok.listInstalled().filter((plugin) => plugin.name === packageName);
  if (matches.length === 0) return;
  if (matches.length === 1 && matches[0]?.id === nativeId && provenMarker(matches[0]) !== undefined) return;
  throw new Error(`Grok ${packageName}: an existing native install is not plgnz-owned; refusing to replace it`);
}

function installationRecord(plugin: InstalledPlugin): TargetInventoryData['installations'][number] | undefined {
  if (plugin.path === undefined) return undefined;
  const marker = provenMarker(plugin);
  const digest = fingerprintTree(plugin.path);
  const enabled = plugin.enabled !== false;
  return {
    nativeId: plugin.id,
    packageName: plugin.name,
    ownership: marker === undefined
      ? { kind: 'unmanaged' }
      : { kind: 'owned', proof: 'created', scopeId: marker.scopeId ?? `grok:${plugin.id}`, proofId: `grok:${plugin.id}:${marker.nativeFingerprint}` },
    presence: 'present',
    enablement: enabled ? 'enabled' : 'disabled',
    activation: enabled ? 'active' : 'inactive',
    installedFingerprint: digest,
    installedVersion: declaredVersion(plugin.path),
    source: { type: 'local', immutableRevision: marker?.immutableRevision ?? digest, locator: null },
    contentRoots: [{ label: 'native', path: resolve(plugin.path), fingerprint: digest }],
  };
}

function targetInventory(target: LifecycleTargetIdentity): TargetInventoryData {
  return {
    target,
    installations: grok.listInstalled().flatMap((plugin) => {
      const record = installationRecord(plugin);
      return record === undefined ? [] : [record];
    }),
  };
}

function absentReadback(handle: Pick<DurableLifecycleOperation, 'adapterId' | 'target' | 'scopeId' | 'packageName' | 'nativeId'>): LifecycleReadbackData {
  return {
    adapterId: handle.adapterId,
    target: handle.target,
    scopeId: handle.scopeId,
    packageName: handle.packageName,
    nativeId: handle.nativeId,
    route: 'none',
    presence: 'absent',
    enablement: 'not-applicable',
    activation: 'inactive',
    transition: IDLE_EFFECTIVE,
    installedFingerprint: null,
    contentRoots: [],
    retention: ABSENT_RETENTION,
  };
}

function liveReadback(handle: Pick<DurableLifecycleOperation, 'adapterId' | 'target' | 'scopeId' | 'packageName' | 'nativeId' | 'route'>): LifecycleReadbackData {
  const plugin = grok.listInstalled().find((candidate) => candidate.id === handle.nativeId);
  if (plugin?.path === undefined || provenMarker(plugin) === undefined) return absentReadback(handle);
  const digest = fingerprintTree(plugin.path);
  const enabled = plugin.enabled !== false && inspectCurrent(plugin.name, plugin.path);
  return {
    adapterId: handle.adapterId,
    target: handle.target,
    scopeId: handle.scopeId,
    packageName: handle.packageName,
    nativeId: handle.nativeId,
    route: handle.route,
    presence: 'present',
    enablement: enabled ? 'enabled' : 'disabled',
    activation: enabled ? 'active' : 'inactive',
    transition: RELOAD_EFFECTIVE,
    installedFingerprint: digest,
    contentRoots: [{ label: 'native', path: resolve(plugin.path), fingerprint: digest }],
    retention: ABSENT_RETENTION,
  };
}

function markerDocument(input: {
  scopeId: string;
  nativeId: string;
  packageFingerprint: string;
  nativeFingerprint: string;
  sourceType: string;
  immutableRevision: string;
}): string {
  return JSON.stringify({
    source: input.scopeId,
    pluginId: input.nativeId,
    fingerprint: input.packageFingerprint,
    nativeFingerprint: input.nativeFingerprint,
    scopeId: input.scopeId,
    sourceType: input.sourceType,
    immutableRevision: input.immutableRevision,
  });
}

function writeStagedMarker(marketplace: string, snapshot: { scopeId: string; nativeId: string; packageFingerprint: string; sourceType: string; immutableRevision: string }, nativeFingerprint: string): void {
  writeFileSync(join(marketplace, MARKER), markerDocument({ ...snapshot, nativeFingerprint }));
}

function stageRecord(attemptId: string, operationId: string): string {
  return join(grokRoot(), 'plgnz-stages', `${attemptId}-${operationId}.txt`);
}

function discardStage(attemptId: string, operationId: string): void {
  const record = stageRecord(attemptId, operationId);
  if (!existsSync(record)) return;
  const stage = readFileSync(record, 'utf8').trim();
  if (stage !== '') rmSync(stage, { recursive: true, force: true });
  rmSync(record, { force: true });
}

function stageMarketplace(snapshot: { scopeId: string; nativeId: string; packageName: string; packageRoot: string; packageFingerprint: string; sourceType: string; immutableRevision: string; attemptId: string; operationId: string }): { stagingId: string; stagingRoot: string } {
  const finalPath = lifecycleMarketplace(snapshot.scopeId, snapshot.nativeId);
  mkdirSync(dirname(finalPath), { recursive: true });
  const stage = mkdtempSync(join(dirname(finalPath), '.plgnz-grok-stage-'));
  const record = stageRecord(snapshot.attemptId, snapshot.operationId);
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, stage);
  try {
    const stagedRoot = join(stage, basename(finalPath));
    const stagedPlugin = join(stagedRoot, 'plugins', snapshot.packageName);
    mkdirSync(dirname(stagedPlugin), { recursive: true });
    cpSync(snapshot.packageRoot, stagedPlugin, { recursive: true });
    projectGrokSource(stagedPlugin);
    const catalog = join(stagedRoot, '.grok-plugin', 'marketplace.json');
    mkdirSync(dirname(catalog), { recursive: true });
    writeFileSync(catalog, JSON.stringify({ name: basename(finalPath), plugins: [{ name: snapshot.packageName, source: `./plugins/${snapshot.packageName}` }] }));
    writeStagedMarker(stagedRoot, snapshot, fingerprintTree(stagedPlugin));
    run(['plugin', 'validate', stagedPlugin]);
    return { stagingId: `stage:${snapshot.attemptId}:${snapshot.operationId}`, stagingRoot: resolve(stagedPlugin) };
  } catch (error) {
    discardStage(snapshot.attemptId, snapshot.operationId);
    throw error;
  }
}

function applyRecordedPins(pluginDir: string, pins: readonly ResolvedLifecyclePin[]): readonly string[] {
  if (pins.length === 0) return [];
  const file = join(pluginDir, '.mcp.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const servers = raw['mcpServers'];
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) throw new Error('Grok pin target is missing .mcp.json');
  const record = servers as Record<string, Record<string, unknown>>;
  for (const pin of pins) {
    const server = record[pin.server];
    if (server === undefined) throw new Error(`Grok pin server is missing: ${pin.server}`);
    server.command = pin.executable;
  }
  writeFileSync(file, JSON.stringify(raw));
  return pins.map(({ server }) => server);
}

function rollbackDirectory(attemptId: string, operationId: string): string {
  return resolve(join(grokRoot(), 'plgnz-rollback', `${attemptId}-${operationId}`));
}

function pluginNamesOf(repo: Record<string, unknown>): string[] {
  const plugins = repo['plugins'];
  return plugins !== null && typeof plugins === 'object' && !Array.isArray(plugins) ? Object.keys(plugins as Record<string, unknown>) : [];
}

function marketplacePathOf(repo: Record<string, unknown>): string | undefined {
  const marketplace = repo['marketplace'];
  if (marketplace === null || typeof marketplace !== 'object' || Array.isArray(marketplace)) return undefined;
  const source = (marketplace as Record<string, unknown>)['source_url_or_path'];
  return typeof source === 'string' ? source : undefined;
}

function savedRegistryRepo(directory: string): { key: string | null; repo: Record<string, unknown> | null } {
  const file = join(directory, 'registry-repo.json');
  if (!existsSync(file)) return { key: null, repo: null };
  const value = JSON.parse(readFileSync(file, 'utf8')) as { key?: unknown; repo?: unknown };
  const key = typeof value.key === 'string' ? value.key : null;
  const repo = value.repo !== null && typeof value.repo === 'object' && !Array.isArray(value.repo) ? value.repo as Record<string, unknown> : null;
  return { key, repo };
}

function matchingRegistryRepo(nativeId: string, packageName: string): [string, Record<string, unknown>] | undefined {
  const installed = grok.listInstalled().find((plugin) => plugin.id === nativeId);
  const entries = repos();
  if (installed?.path !== undefined) {
    const found = entries.find(([, repo]) => repo.path === installed.path);
    if (found !== undefined) return [found[0], found[1] as Record<string, unknown>];
  }
  const named = entries.find(([, repo]) => namesOf(repo).includes(packageName));
  if (named !== undefined) return [named[0], named[1] as Record<string, unknown>];
  const planned = entries.find(([, repo]) => namesOf(repo).length === 0 && (localSourceOf(repo)?.endsWith(`/plugins/${packageName}`) ?? false));
  return planned === undefined ? undefined : [planned[0], planned[1] as Record<string, unknown>];
}

function registryDocument(): { version: 1; repos: Record<string, unknown> } {
  const value = readJson(registryFile());
  if (value === null || value['version'] !== 1 || value['repos'] === null || typeof value['repos'] !== 'object' || Array.isArray(value['repos'])) {
    return { version: 1, repos: {} };
  }
  return { version: 1, repos: { ...(value['repos'] as Record<string, unknown>) } };
}

function writeRegistryDocument(document: { version: 1; repos: Record<string, unknown> }): void {
  mkdirSync(dirname(registryFile()), { recursive: true });
  writeFileSync(registryFile(), JSON.stringify(document));
}

function repoBelongsToInstall(key: string, repo: Record<string, unknown>, savedKey: string | null, marketplacePath: string, packageName: string): boolean {
  if (savedKey !== null && key === savedKey) return true;
  const source = marketplacePathOf(repo);
  if (source !== undefined && samePath(source, marketplacePath)) return true;
  const kind = repo['kind'];
  const localSource = kind !== null && typeof kind === 'object' && !Array.isArray(kind) && (kind as Record<string, unknown>)['type'] === 'Local'
    ? (kind as Record<string, unknown>)['source_path']
    : undefined;
  return pluginNamesOf(repo).length === 0 && typeof localSource === 'string' && localSource.endsWith(`/plugins/${packageName}`);
}

function restoreRegistryKey(directory: string, marketplacePath: string, packageName: string): void {
  const saved = savedRegistryRepo(directory);
  const priorInstalled = saved.key !== null && saved.repo !== null && pluginNamesOf(saved.repo).length > 0;
  const document = registryDocument();
  for (const [key, repo] of Object.entries(document.repos)) {
    if (repo === null || typeof repo !== 'object' || Array.isArray(repo)) continue;
    if (!repoBelongsToInstall(key, repo as Record<string, unknown>, saved.key, marketplacePath, packageName)) continue;
    if (priorInstalled && key === saved.key) continue;
    delete document.repos[key];
  }
  if (priorInstalled && saved.key !== null && saved.repo !== null) document.repos[saved.key] = saved.repo;
  writeRegistryDocument(document);
}

function removeMarketplaceRow(root: string): void {
  const rows = marketplaceSources().filter((row) => typeof row.source?.path === 'string' && samePath(row.source.path, root));
  const stored = rows[0]?.source?.path;
  if (typeof stored !== 'string') return;
  run(['plugin', 'marketplace', 'remove', stored]);
}

function captureHostSnapshot(directory: string, nativeId: string, packageName: string): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const plugin = grok.listInstalled().find((candidate) => candidate.id === nativeId);
  if (plugin?.path !== undefined) {
    const native = resolve(plugin.path);
    cpSync(native, join(directory, 'native'), { recursive: true });
    writeFileSync(join(directory, 'native-path.txt'), native);
  }
  const marker = plugin === undefined ? undefined : provenMarker(plugin);
  if (marker !== undefined) {
    const repo = repos().find(([, candidate]) => candidate.path === plugin?.path)?.[1];
    const root = repo === undefined ? undefined : canonical(provenanceOf(repo)?.root ?? '');
    if (root !== undefined) cpSync(root, join(directory, 'marketplace'), { recursive: true });
  }
  const matched = matchingRegistryRepo(nativeId, packageName);
  writeFileSync(join(directory, 'registry-repo.json'), JSON.stringify(matched === undefined ? { key: null } : { key: matched[0], repo: matched[1] }));
  const link = join(grokRoot(), 'plugins', packageName);
  if (lstatExists(link) && lstatSync(link).isSymbolicLink()) writeFileSync(join(directory, 'link.txt'), readlinkSync(link));
}

function freshNativePaths(directory: string, marketplacePath: string): string[] {
  const paths = new Set<string>();
  const saved = savedRegistryRepo(directory);
  if (saved.repo !== null && typeof saved.repo['path'] === 'string' && pluginNamesOf(saved.repo).length === 0) paths.add(resolve(saved.repo['path']));
  for (const [, repo] of repos()) {
    if (typeof repo.path !== 'string') continue;
    const provenance = provenanceOf(repo);
    if (provenance !== null && samePath(provenance.root, marketplacePath)) paths.add(resolve(repo.path));
  }
  return [...paths];
}

function restoreActivationLink(directory: string, packageName: string): void {
  const link = join(grokRoot(), 'plugins', packageName);
  if (existsSync(join(directory, 'link.txt'))) {
    if (lstatExists(link)) rmSync(link);
    symlinkSync(readFileSync(join(directory, 'link.txt'), 'utf8'), link);
    return;
  }
  if (lstatExists(link) && lstatSync(link).isSymbolicLink()) rmSync(link);
}

function restoreHostSnapshot(directory: string, scopeId: string, nativeId: string, packageName: string): void {
  const finalPath = lifecycleMarketplace(scopeId, nativeId);
  const backupPath = join(directory, 'backup-path.txt');
  const nativePathFile = join(directory, 'native-path.txt');
  const hadNative = existsSync(nativePathFile);
  const hadMarketplace = existsSync(join(directory, 'marketplace'));
  if (!hadNative) for (const native of freshNativePaths(directory, finalPath)) rmSync(native, { recursive: true, force: true });
  if (hadMarketplace) {
    rmSync(finalPath, { recursive: true, force: true });
    mkdirSync(dirname(finalPath), { recursive: true });
    cpSync(join(directory, 'marketplace'), finalPath, { recursive: true });
  } else {
    removeMarketplaceRow(finalPath);
    rmSync(finalPath, { recursive: true, force: true });
  }
  if (hadNative) {
    const native = readFileSync(nativePathFile, 'utf8');
    rmSync(native, { recursive: true, force: true });
    cpSync(join(directory, 'native'), native, { recursive: true });
  }
  restoreRegistryKey(directory, finalPath, packageName);
  restoreActivationLink(directory, packageName);
  if (existsSync(backupPath)) rmSync(readFileSync(backupPath, 'utf8'), { recursive: true, force: true });
  if (hadNative) {
    run(['plugin', 'update', packageName]);
    run(['plugin', 'enable', packageName]);
  }
}

function pinPluginAutoUpdate(): string {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const pattern = /^[ \t]*plugin(?:_auto_update|AutoUpdate)[ \t]*=.*(?:\r?\n|$)/gm;
  const line = 'plugin_auto_update = false\n';
  const matched = pattern.test(current);
  pattern.lastIndex = 0;
  let seen = false;
  const next = matched
    ? current.replace(pattern, () => {
      if (seen) return '';
      seen = true;
      return line;
    })
    : current.length === 0 ? line : `${current.endsWith('\n') ? current : `${current}\n`}${line}`;
  if (next !== current) writeFileSync(file, next);
  return 'grok.config.plugin_auto_update=false';
}

function refreshStagedFingerprint(stagingRoot: string, nativeFingerprint: string): void {
  const marketplace = dirname(dirname(stagingRoot));
  const marker = ownership(marketplace);
  if (marker === null || marker.scopeId === undefined || marker.immutableRevision === undefined || marker.sourceType === undefined) {
    throw new Error('Grok staged marketplace marker is incomplete');
  }
  writeStagedMarker(marketplace, {
    scopeId: marker.scopeId,
    nativeId: marker.pluginId,
    packageFingerprint: marker.fingerprint,
    sourceType: marker.sourceType,
    immutableRevision: marker.immutableRevision,
  }, nativeFingerprint);
}

const grokLifecycleDefinition: LifecycleHostDefinition = {
  id: 'grok',
  evidenceProfiles: grokEvidenceProfiles(),
  async probeVersion(): Promise<TargetVersionObservation> {
    return probeGrokVersion();
  },
  async observeTarget(target): Promise<TargetInventoryData> {
    return targetInventory(target);
  },
  async observeNativeMutationScope(request): Promise<NativeMutationScopeData> {
    return { kind: 'bounded', mode: 'exact-package', affectedNativeIds: [request.nativeId] };
  },
  async observeNativeProjection(request): Promise<NativeProjectionData> {
    if ('snapshot' in request) return { kind: 'equivalent', proofId: `grok.staged-marketplace:${request.snapshot.packageFingerprint}` };
    return { kind: 'unverified', reasonId: 'grok.recorded-operation-unverified' };
  },
  async revalidateTargetPrecondition(handle) {
    return {
      version: probeGrokVersion(),
      targetObservationId: createTargetInventoryObservation('grok', targetInventory(handle.target)).observationId,
    };
  },
  async stageActivation(request) {
    return stageMarketplace(request.snapshot);
  },
  async applyLifecycleDirectives() {
    return [pinPluginAutoUpdate()];
  },
  async applyPins(projection) {
    return applyRecordedPins(projection.stagingRoot, projection.pins);
  },
  async captureActivationPreparation(projection, projectedFingerprint): Promise<ActivationPreparationCapture> {
    const directory = rollbackDirectory(projection.attemptId, projection.operationId);
    captureHostSnapshot(directory, projection.nativeId, projection.packageName);
    const prior = liveReadback(projection);
    const nativePath = registryNativePath(projection.nativeId, projection.packageName, projection.stagingRoot)
      ?? prior.contentRoots[0]?.path
      ?? marketplacePluginPath(projection.scopeId, projection.nativeId, projection.packageName);
    return {
      prior,
      expected: {
        adapterId: projection.adapterId,
        target: projection.target,
        scopeId: projection.scopeId,
        packageName: projection.packageName,
        nativeId: projection.nativeId,
        route: projection.route,
        presence: 'present',
        enablement: 'enabled',
        activation: 'active',
        transition: RELOAD_EFFECTIVE,
        installedFingerprint: projectedFingerprint,
        contentRoots: [{ label: 'native', path: nativePath, fingerprint: projectedFingerprint }],
        retention: ABSENT_RETENTION,
      },
      rollbackReference: directory,
      rollbackCoverageOperationIds: projection.affectedOperationIds,
    };
  },
  async captureDisablePreparation(): Promise<never> {
    throw new Error('Grok reversible disable is unverified');
  },
  async captureRetirementPreparation(): Promise<never> {
    throw new Error('Grok retirement is unverified on this native route');
  },
  async apply(prepared) {
    try {
      refuseUnprovenSameName(prepared.handle.packageName, prepared.handle.nativeId);
      if (!registryIsReadable()) throw new Error('Grok native registry is unreadable or unsupported; refusing mutation');
      const nativeFingerprint = prepared.handle.projectedFingerprint;
      if (nativeFingerprint === null || fingerprintTree(prepared.stagingRoot) !== nativeFingerprint) {
        throw new Error('Grok staged plugin does not match the sealed projection');
      }
      refreshStagedFingerprint(prepared.stagingRoot, nativeFingerprint);
      const finalPath = lifecycleMarketplace(prepared.handle.scopeId, prepared.handle.nativeId);
      const stagedRoot = dirname(dirname(prepared.stagingRoot));
      const backup = existsSync(finalPath) ? `${finalPath}.plgnz-backup-${prepared.handle.attemptId}` : undefined;
      if (backup !== undefined) renameSync(finalPath, backup);
      renameSync(stagedRoot, finalPath);
      if (backup !== undefined) writeFileSync(join(prepared.handle.rollbackReference, 'backup-path.txt'), backup);
      ensureMarketplace(finalPath);
      const installed = grok.listInstalled().find((candidate) => candidate.id === prepared.handle.nativeId);
      if (installed === undefined) run(['plugin', 'install', `${prepared.handle.packageName}@local/${basename(finalPath)}`, '--trust']);
      else run(['plugin', 'update', prepared.handle.packageName]);
      run(['plugin', 'enable', prepared.handle.packageName]);
      const native = grok.listInstalled().find((candidate) => candidate.id === prepared.handle.nativeId)?.path;
      const activation = join(grokRoot(), 'plugins', prepared.handle.packageName);
      assertActivationLink(activation, native);
      if (native !== undefined && !lstatExists(activation)) {
        mkdirSync(dirname(activation), { recursive: true });
        symlinkSync(native, activation);
      }
      if (native === undefined || fingerprintTree(native) !== nativeFingerprint || !inspectCurrent(prepared.handle.packageName, native)) {
        throw new Error(`Grok ${prepared.handle.nativeId}: native readback does not match staged content`);
      }
      return { receiptId: `apply:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: true };
    } finally {
      discardStage(prepared.handle.attemptId, prepared.handle.operationId);
    }
  },
  async disable(): Promise<never> {
    throw new Error('Grok reversible disable is unverified');
  },
  async retire(): Promise<never> {
    throw new Error('Grok retirement is unverified on this native route');
  },
  async readback(handle) {
    return liveReadback(handle);
  },
  async rollback(handle) {
    restoreHostSnapshot(handle.rollbackReference, handle.scopeId, handle.nativeId, handle.packageName);
    return { receiptId: `rollback:${handle.attemptId}:${handle.operationId}`, changed: true };
  },
  async cleanup(reference: CleanupReference, disposition: CleanupDisposition) {
    switch (disposition) {
      case 'verified-commit':
      case 'verified-rollback':
      case 'aborted-preparation':
        discardStage(reference.attemptId, reference.operationId);
        rmSync(join(grokRoot(), 'plgnz-rollback', `${reference.attemptId}-${reference.operationId}`), { recursive: true, force: true });
        break;
      default: {
        const unreachable: never = disposition;
        throw new Error(`unexpected Grok cleanup disposition: ${String(unreachable)}`);
      }
    }
    return { cleanupId: `cleanup:${reference.attemptId}:${reference.operationId}`, completed: true };
  },
};

export function createGrokLifecycleAdapter(): LifecycleHostAdapter {
  return createLifecycleHostAdapter(grokLifecycleDefinition);
}
