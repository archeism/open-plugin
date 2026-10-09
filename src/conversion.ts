/**
 * Codex projection for plugin content that Claude-style plugins express as
 * commands. This is deliberately a file-to-file transform: lifecycle code can
 * stage its destination before it asks a host writer to activate anything.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { readPluginManifest } from './source';
import { hermesCommandCompanionId } from './hermes-identity';

import { yamlParse, yamlStringify } from './yaml';


interface Command {
  name: string;
  description: string;
  argumentHint?: string;
  userInvocable?: boolean;
  allowImplicit: boolean;
  body: string;
  source: string;
}

interface OmpProjectionOptions {
  /** Native npm/link package identity recorded by OMP. */
  packageName: string;
  /** Version recorded in OMP's runtime lock. */
  version: string;
  /** Final owned package root. Command resource hints must survive staging. */
  activeRoot: string;
  /** Public plugin namespace used for manual-only skill commands. */
  namespace: string;
}

interface HermesSkill { name: string; description: string; userOnly: boolean }

const COMMAND_FIELDS = new Set(['description', 'argument-hint', 'argument_hint', 'disable-model-invocation', 'disable_model_invocation', 'user-invocable', 'user_invocable']);
const UNSUPPORTED_FIELDS = new Set(['allowed-tools', 'allowed_tools', 'permissionMode', 'permission_mode', 'hooks', 'model', 'context']);
const UNSUPPORTED_CLAUDE_COMPONENTS = new Set(['agents', 'hooks', 'mcpServers', 'outputStyles', 'lspServers']);

/**
 * Copy a package into a caller-owned temporary destination and add Codex skill
 * projections for its prompt commands. The source is checked before copying so
 * neither symlinks nor paths outside the source can enter the output.
 */
export function projectPluginForCodex(sourceDir: string, destinationDir: string): void {
  const source = resolve(sourceDir);
  const destination = resolve(destinationDir);
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`plugin source is not a directory: ${source}`);
  if (destination === source || destination.startsWith(`${source}/`)) throw new Error('destination must not be inside the plugin source');
  assertSafeTree(source);

  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length !== 0) throw new Error(`Codex projection destination must be empty: ${destination}`);
  const stage = mkdtempSync(join(destination, '.plgnz-codex-stage-'));
  try {
    cpSync(source, stage, { recursive: true });
    const commands = discoverCommands(source);
    validateClaudeNativeSemantics(source, commands);
    const namespace = readPackageName(source);
    for (const command of commands) { if (command.userInvocable === false) throw new Error(`user-invocable: false is unsupported by Codex: ${command.source}`); writeCommandSkill(stage, command, namespace, new Set(commands.map(item => item.name))); }
    translateNativeSkillPolicies(stage);
    publishStage(stage, destination);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Build one OMP native extension package. OMP's npm/link lane discovers the
 * package's ordinary Agent Plugin skills and its commands/ directory together.
 * Manual-only skills are kept out of skills/ and exposed as namespaced commands;
 * a private source snapshot keeps every sibling reference and resource path.
 */
export function projectPluginForOmp(sourceDir: string, destinationDir: string, options: OmpProjectionOptions): void {
  const source = resolve(sourceDir); const destination = resolve(destinationDir);
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`plugin source is not a directory: ${source}`);
  if (destination === source || destination.startsWith(`${source}/`)) throw new Error('destination must not be inside the plugin source');
  assertSafeTree(source); mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length !== 0) throw new Error(`OMP projection destination must be empty: ${destination}`);
  cpSync(source, destination, { recursive: true });
  const privateRoot = join(destination, '.plgnz', 'source');
  mkdirSync(dirname(privateRoot), { recursive: true });
  cpSync(source, privateRoot, { recursive: true });

  const commands = discoverCommands(source);
  validateClaudeNativeSemantics(source, commands);
  const projected = new Set<string>();
  const commandNames = new Set(commands.map(command => command.name));
  rmSync(join(destination, 'commands'), { recursive: true, force: true });
  for (const command of commands) {
    if (command.userInvocable === false) throw new Error(`user-invocable: false is unsupported by OMP command projection: ${command.source}`);
    if (command.allowImplicit) throw new Error(`model-invocable source command is unsupported by OMP command projection: ${command.source}`);
    writeOmpCommand(destination, `${options.namespace}:${command.name}`, command.description, command.argumentHint, rewriteOmpCommandReferences(command.body, commandNames, options.namespace),
      join(options.activeRoot, '.plgnz', 'source', relativeCommandBase(source, command.source)), projected);
  }

  const skills = join(source, 'skills');
  if (existsSync(skills)) {
    for (const entry of readdirSync(skills).sort()) {
      const skillDir = join(skills, entry); const skillFile = join(skillDir, 'SKILL.md');
      if (!statSync(skillDir).isDirectory() || !existsSync(skillFile)) continue;
      const parsed = parseManualSkill(skillDir);
      if (parsed.userInvocable === false) throw new Error(`user-invocable: false is unsupported by OMP skill projection: ${skillFile}`);
      if (!parsed.manual) { stripOmpInvocationMetadata(join(destination, 'skills', entry, 'SKILL.md'), parsed.metadata); continue; }
      const commandName = `${options.namespace}:${parsed.name}`;
      writeOmpCommand(destination, commandName, parsed.description, parsed.argumentHint, rewriteOmpCommandReferences(parsed.body, commandNames, options.namespace),
        join(options.activeRoot, '.plgnz', 'source', 'skills', entry), projected);
      rmSync(join(destination, 'skills', entry), { recursive: true, force: true });
    }
  }
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify({ name: options.packageName, version: options.version, omp: {} }, null, 2)}\n`);
}

function rewriteOmpCommandReferences(body: string, names: Set<string>, namespace: string): string {
  return body.replace(/(^|[^A-Za-z0-9_:-])\/([a-z0-9][a-z0-9-]*)(?=\s|$|[.,:;!?])/giu,
    (whole, prefix: string, name: string) => names.has(name) ? `${prefix}/${namespace}:${name}` : whole);
}

function relativeCommandBase(source: string, path: string): string {
  const parent = dirname(path);
  if (parent === source) return '';
  if (!parent.startsWith(`${source}/`)) throw new Error(`command source escapes plugin: ${path}`);
  return parent.slice(source.length + 1);
}

function writeOmpCommand(root: string, name: string, description: string, argumentHint: string | undefined, body: string, base: string, names: Set<string>): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(name)) throw new Error(`unsafe OMP command name: ${name}`);
  if (names.has(name)) throw new Error(`OMP command collision: ${name}`);
  names.add(name);
  const hint = argumentHint === undefined ? '' : `argument-hint: ${yamlString(argumentHint)}\n`;
  const preserved = body.endsWith('\n') ? body : `${body}\n`;
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'commands', `${name}.md`), `---\ndescription: ${yamlString(description)}\n${hint}---\n${preserved}\nBase directory for this command: ${base}\nRelative paths in this command are relative to this base directory.\n`);
}

function parseManualSkill(directory: string): { name: string; description: string; argumentHint?: string; userInvocable?: boolean; manual: boolean; body: string; metadata: Record<string, unknown> } {
  const path = join(directory, 'SKILL.md');
  const raw = readFileSync(path, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`skill frontmatter is required: ${path}`);
  const metadata = parseYaml(match[1] ?? '', path);
  normalizeMetadata(metadata, path);
  const name = metadata['name'], description = metadata['description'];
  if (typeof name !== 'string' || !validSegment(name) || typeof description !== 'string' || !description.trim()) throw new Error(`invalid OMP skill identity: ${path}`);
  const manual = metadata['disable-model-invocation'];
  const userInvocable = metadata['user-invocable'];
  const hint = metadata['argument-hint'];
  if (manual !== undefined && typeof manual !== 'boolean') throw new Error(`disable-model-invocation must be boolean: ${path}`);
  if (userInvocable !== undefined && typeof userInvocable !== 'boolean') throw new Error(`user-invocable must be boolean: ${path}`);
  if (hint !== undefined && typeof hint !== 'string') throw new Error(`argument hint must be text: ${path}`);
  const sidecar = join(directory, 'agents', 'openai.yaml');
  const implicit = existsSync(sidecar) ? readImplicitPolicy(sidecar) : undefined;
  if (implicit !== undefined && typeof manual === 'boolean' && implicit === manual) throw new Error(`conflicting invocation policy for native skill ${name}`);
  return { name, description, ...(typeof hint === 'string' ? { argumentHint: hint } : {}), ...(typeof userInvocable === 'boolean' ? { userInvocable } : {}), manual: manual === true || implicit === false, body: match[2] ?? '', metadata };
}

function stripOmpInvocationMetadata(path: string, parsed: Record<string, unknown>): void {
  const raw = readFileSync(path, 'utf8'); const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`skill frontmatter is required: ${path}`);
  const kept = { ...parsed };
  for (const key of ['disable-model-invocation', 'disable_model_invocation', 'user-invocable', 'user_invocable', 'argument-hint', 'argument_hint']) delete kept[key];
  writeFileSync(path, `---\n${yamlStringify(kept).replace(/\s*$/u, '')}\n---\n${match[2] ?? ''}`);

}

/**
 * Preserve the portable Agent Plugin as the primary package and, when prompt
 * commands exist, generate a sibling native directory plugin. The native
 * handler queues the expanded prompt through PluginContext.inject_message;
 * it never prints a prompt as if that had started a model turn.
 */
export function projectPluginForHermes(sourceDir: string, destinationDir: string, companionDir?: string): void {
  const source = resolve(sourceDir);
  const destination = resolve(destinationDir);
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`plugin source is not a directory: ${source}`);
  if (destination === source || destination.startsWith(`${source}/`)) throw new Error('destination must not be inside the plugin source');
  assertSafeTree(source);
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length !== 0) throw new Error(`Hermes projection destination must be empty: ${destination}`);
  const stage = mkdtempSync(join(destination, '.plgnz-hermes-stage-'));
  try {
    cpSync(source, stage, { recursive: true });
    const commands = discoverCommands(source);
    validateClaudeNativeSemantics(source, commands);
    const pluginId = readPackageName(source);
    const skills = projectHermesSkills(stage);
    if (commands.length > 0 || skills.length > 0) {
      if (companionDir === undefined) throw new Error('Hermes skills and prompt commands require a native companion destination');
      writeHermesCommandCompanion(companionDir, pluginId, commands, skills);
    }
    publishStage(stage, destination);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function writeHermesCommandCompanion(destinationDir: string, pluginId: string, commands: Command[], skills: HermesSkill[]): void {
  const destination = resolve(destinationDir);
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length !== 0) throw new Error(`Hermes companion destination must be empty: ${destination}`);
  for (const command of commands) {
    if (command.userInvocable === false) throw new Error(`Hermes cannot preserve user-invocable: false for prompt command: ${command.source}`);
    if (command.allowImplicit) throw new Error(`Hermes cannot preserve model-invocable prompt command policy: ${command.source}`);
  }
  const companionId = hermesCommandCompanionId(pluginId);
  const commandNames = new Set(commands.map(command => command.name));
  const bridged = [...commands.map(command => ({ ...command,
    name: `${pluginId}:${command.name}`,
    body: command.body.replace(/(^|[^A-Za-z0-9_-])\/([a-z0-9][a-z0-9-]*)(?=\s|$|[.,:;!?])/giu, (whole, prefix: string, name: string) => commandNames.has(name) ? `${prefix}/${pluginId}:${name}` : whole),
  })), ...skills.filter(skill => skill.userOnly).map(skill => ({
    name: `${pluginId}:${skill.name}`,
    description: `User-only skill: ${skill.description}`,
    argumentHint: '[arguments]', userInvocable: true, allowImplicit: false,
    body: `Read and follow the user-invoked skill at .plgnz-user-skills/${skill.name}/SKILL.md relative to the plugin root above. Treat it as the governing instructions for this turn. User arguments: $ARGUMENTS`,
    source: `${pluginId}/skills/${skill.name}/SKILL.md`,
  }))];
  if (new Set(bridged.map(command => command.name)).size !== bridged.length) throw new Error(`Hermes command projection collides in ${pluginId}`);
  const rows = bridged.map(command => `    (${JSON.stringify(command.name)}, ${JSON.stringify(command.description)}, ${JSON.stringify(command.argumentHint ?? '')}, ${JSON.stringify(command.body)}),`).join('\n');
  const ordinary = skills.filter(skill => !skill.userOnly);
  const skillRows = ordinary.map(skill => `        (${JSON.stringify(skill.name)}, ${JSON.stringify(skill.description)}),`).join('\n');
  writeFileSync(join(destination, 'plugin.yaml'), `name: ${companionId}\nversion: 1\ndescription: Native prompt-command bridge for ${pluginId}\nrequires_plugins:\n  - ${pluginId}\n`);
  writeFileSync(join(destination, '__init__.py'), `"""Generated by plgnz. Queues portable prompt commands into the interactive Hermes CLI."""\nfrom pathlib import Path\nimport re\nimport shlex\n\n_COMMANDS = [\n${rows}\n]\n\ndef _expand(template, raw_args):\n    raw = raw_args or ""\n    try:\n        parts = shlex.split(raw)\n    except ValueError:\n        parts = raw.split()\n    def replacement(match):\n        if match.group(0) == "$ARGUMENTS":\n            return raw\n        index = int(match.group(1) or match.group(2))\n        return parts[index - 1] if 0 < index <= len(parts) else ""\n    return re.sub(r"\\$ARGUMENTS\\b|\\$(?:\\{([0-9]+)\\}|([0-9]+))", replacement, template)\n\ndef _handler(ctx, template):\n    def run(raw_args):\n        plugin_root = Path(__file__).resolve().parent.parent / ${JSON.stringify(pluginId)}\n        prompt = _expand(template, raw_args)\n        prompt = (f"Plugin root: {plugin_root}\\n"
            "Resolve relative skill, agent, and reference paths from that plugin root.\\n\\n" + prompt)\n        if not ctx.inject_message(prompt):\n            return "Unsupported outside an interactive Hermes CLI session; no model turn was started."\n        return None\n    return run\n\ndef register(ctx):\n    for name, description, args_hint, template in _COMMANDS:\n        ctx.register_command(name, _handler(ctx, template), description=description, args_hint=args_hint)\n`);
  if (ordinary.length > 0) {
    const init = join(destination, '__init__.py');
    writeFileSync(init, `${readFileSync(init, 'utf8')}    import hashlib\n    plugin_id = ${JSON.stringify(pluginId)}\n    slug = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "_-") else "-" for ch in plugin_id.lower()).strip("-_") or "plugin"\n    namespace = f"agent-plugin-{slug}-{hashlib.sha256(plugin_id.encode()).hexdigest()[:8]}"\n    skills = [\n${skillRows}\n    ]\n    lines = "\\n".join(f"- {namespace}:{name}: {description}" for name, description in skills)\n    section = ${JSON.stringify(`Portable skills from ${pluginId} are available through Hermes skill tools:\n`)} + lines + ${JSON.stringify('\nUse skill_view with the exact qualified name when a listed skill matches the task.')}\n    ctx.register_system_prompt_section(${JSON.stringify(`${companionId}.skills`)}, section, position="after_memory")\n`);
  }
}

function projectHermesSkills(stage: string): HermesSkill[] {
  const root = join(stage, 'skills');
  if (!existsSync(root)) return [];
  const result = readdirSync(root).sort().flatMap(entry => {
    const skill = join(root, entry, 'SKILL.md');
    if (!existsSync(skill)) return [];
    const match = readFileSync(skill, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match === null) return [];
    const metadata = parseYaml(match[1] ?? '', skill);
    return typeof metadata['description'] === 'string' ? [{ name: entry, description: metadata['description'], userOnly: hermesSkillUserOnly(skill, metadata) }] : [];
  });
  const userOnly = result.filter(skill => skill.userOnly);
  if (userOnly.length > 0) {
    const privateRoot = join(stage, '.plgnz-user-skills');
    cpSync(root, privateRoot, { recursive: true });
    for (const skill of userOnly) rmSync(join(root, skill.name), { recursive: true });
  }
  for (const skill of result.filter(item => !item.userOnly)) stripOrdinaryHermesPolicy(join(root, skill.name, 'SKILL.md'));
  return result;
}

function validateClaudeNativeSemantics(source: string, commands: Command[]): void {
  const file = join(source, '.claude-plugin', 'plugin.json');
  if (!existsSync(file)) return;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Claude native plugin manifest must be an object: ${file}`);
  for (const field of UNSUPPORTED_CLAUDE_COMPONENTS) {
    if (parsed[field] !== undefined) throw new Error(`Claude native ${field} semantics are unsupported for Codex conversion: ${file}`);
  }
  if (parsed['skills'] !== undefined && parsed['skills'] !== './skills' && parsed['skills'] !== './skills/') {
    throw new Error(`Claude native skills pointer is unsupported for Codex conversion: ${file}`);
  }
  if (parsed['skills'] !== undefined && (!existsSync(join(source, 'skills')) || !statSync(join(source, 'skills')).isDirectory())) {
    throw new Error(`Claude native skills pointer cannot be preserved for Codex conversion: ${file}`);
  }
  if (parsed['commands'] === undefined) return;
  const listed = Array.isArray(parsed['commands']) ? parsed['commands'] : [parsed['commands']];
  if (!listed.every(value => typeof value === 'string')) throw new Error(`Claude native commands pointer is invalid for Codex conversion: ${file}`);
  const preserved = new Set(commands.map(command => `./${command.source.slice(source.length + 1)}`));
  const requested = new Set(listed as string[]);
  if (requested.size !== preserved.size || [...requested].some(path => !preserved.has(path))) {
    throw new Error(`Claude native commands pointer is unsupported for Codex conversion: ${file}`);
  }
}

function assertSafeTree(root: string): void {
  // `statSync` follows links, so use find's physical link test before cpSync.
  // This avoids copying a resource that later resolves outside the package.
  const links = spawnSync('find', [root, '-type', 'l', '-print'], { encoding: 'utf8' });
  if (links.status !== 0) throw new Error(`could not inspect plugin resources: ${root}`);
  if (links.stdout.trim() !== '') throw new Error(`symlink is not supported in plugin resources: ${links.stdout.trim()}`);
}

function discoverCommands(source: string): Command[] {
  const claude = join(source, '.claude', 'commands');
  if (existsSync(claude)) return readCommandDirectory(claude, 'markdown');
  const root = join(source, 'commands');
  if (!existsSync(root)) return [];
  const markdown = readCommandDirectory(root, 'markdown');
  return markdown.length > 0 ? markdown : readCommandDirectory(root, 'toml');
}

export { discoverCommands };

function readPackageName(source: string): string {
  const manifest = readPluginManifest(source);
  if (manifest === undefined) {
    throw new Error('Plugin manifest is required for command namespace mapping');
  }
  return manifest.name;
}

function readCommandDirectory(directory: string, kind: 'markdown' | 'toml'): Command[] {
  if (!statSync(directory).isDirectory()) throw new Error(`command path is not a directory: ${directory}`);
  return readdirSync(directory).sort().flatMap(file => {
    if (!file.endsWith(kind === 'markdown' ? '.md' : '.toml')) return [];
    const path = join(directory, file);
    if (!statSync(path).isFile()) throw new Error(`command must be a regular file: ${path}`);
    return [kind === 'markdown' ? parseMarkdownCommand(path) : parseTomlCommand(path)];
  });
}

function parseMarkdownCommand(path: string): Command {
  const raw = readFileSync(path, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match === null) throw new Error(`command frontmatter is required: ${path}`);
  const metadata = parseYaml(match[1] ?? '', path);
  validateMetadata(metadata, path);
  normalizeMetadata(metadata, path);
  const description = metadata['description'];
  if (typeof description !== 'string' || description.trim() === '') throw new Error(`command description is required: ${path}`);
  return commandFrom(path, description, metadata['argument-hint'], metadata['user-invocable'], metadata['disable-model-invocation'], match[2] ?? '');
}

function parseTomlCommand(path: string): Command {
  const parsed: unknown = parseToml(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`invalid command TOML: ${path}`);
  validateMetadata(parsed, path);
  normalizeMetadata(parsed, path);
  const description = parsed['description'];
  const prompt = parsed['prompt'];
  if (typeof description !== 'string' || description.trim() === '' || typeof prompt !== 'string') throw new Error(`command TOML needs description and prompt: ${path}`);
  return commandFrom(path, description, parsed['argument-hint'], parsed['user-invocable'], parsed['disable-model-invocation'], prompt);
}

function normalizeMetadata(metadata: Record<string, unknown>, path: string): void {
  for (const [hyphen, underscore] of [['argument-hint', 'argument_hint'], ['user-invocable', 'user_invocable'], ['disable-model-invocation', 'disable_model_invocation']] as const) {
    if (metadata[hyphen] !== undefined && metadata[underscore] !== undefined) throw new Error(`conflicting command metadata spellings: ${path} (${hyphen}, ${underscore})`);
    if (metadata[hyphen] === undefined && metadata[underscore] !== undefined) metadata[hyphen] = metadata[underscore];
  }
}

function commandFrom(path: string, description: string, argumentHint: unknown, userInvocable: unknown, disableModelInvocation: unknown, body: string): Command {  const name = basename(path).replace(/\.(md|toml)$/u, '');
  if (!validSegment(name)) throw new Error(`unsafe command name: ${name}`);
  if (argumentHint !== undefined && typeof argumentHint !== 'string') throw new Error(`argument hint must be text: ${path}`);
  if (userInvocable !== undefined && typeof userInvocable !== 'boolean') throw new Error(`user-invocable must be boolean: ${path}`);
  if (disableModelInvocation !== undefined && typeof disableModelInvocation !== 'boolean') throw new Error(`disable-model-invocation must be boolean: ${path}`);
  if (/!`[\s\S]*?`/u.test(body)) throw new Error(`shell preprocessing is unsupported: ${path}`);
  return { name, description, ...(typeof argumentHint === 'string' ? { argumentHint } : {}), ...(typeof userInvocable === 'boolean' ? { userInvocable } : {}), allowImplicit: disableModelInvocation === false, body, source: path };
}

/**
 * Normalize a staged plugin's command sources to the Markdown command form
 * every Markdown-commands host loads (spec §2: TOML prompt commands map into
 * the native Markdown form when semantics are equivalent). Directory
 * semantics match discoverCommands: any .md present wins and .toml files in
 * that directory are shadowed and removed; otherwise each .toml
 * (description + prompt) becomes <stem>.md. Invocation-policy metadata has
 * no Markdown equivalent and is refused rather than silently stripped.
 */
export function normalizeCommandSources(root: string): void {
  const dir = join(root, 'commands');
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`commands path is not a directory: ${dir}`);
  normalizeCommandTree(dir);
}

export function normalizeCommandTree(dir: string): void {
  const stats = readdirSync(dir).sort().map((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`command source contains symlink: ${path}`);
    return { name, path, isDirectory: stat.isDirectory(), isFile: stat.isFile() };
  });
  for (const entry of stats) if (entry.isDirectory) normalizeCommandTree(entry.path);
  const hasMarkdown = stats.some((entry) => entry.isFile && entry.name.endsWith('.md'));
  for (const entry of stats) {
    if (!entry.isFile || !entry.name.endsWith('.toml')) continue;
    if (hasMarkdown) { rmSync(entry.path); continue; }
    const projected = tomlCommandMarkdown(entry.path);
    writeFileSync(join(dir, `${projected.name}.md`), projected.text);
    rmSync(entry.path);
  }
}

/** The Markdown command text a TOML prompt command maps to (spec §2).
 * Invocation-policy metadata has no Markdown equivalent and is refused
 * rather than silently stripped. */
export function tomlCommandMarkdown(path: string): { name: string; text: string } {
  const command = parseTomlCommand(path);
  if (command.userInvocable === false || command.allowImplicit) throw new Error(`command invocation policy is unsupported by Markdown projection: ${path}`);
  const hint = command.argumentHint === undefined ? '' : `argument-hint: ${yamlString(command.argumentHint)}\n`;
  const body = command.body.endsWith('\n') ? command.body : `${command.body}\n`;
  return { name: command.name, text: `---\ndescription: ${yamlString(command.description)}\n${hint}---\n${body}` };
}

/** Pi projector: reuse the shared command parser, but emit Pi's native skill form. */
export function projectPluginForPi(sourceDir: string, destinationDir: string, namespace: string): void {
  const source = resolve(sourceDir); const destination = resolve(destinationDir);
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`plugin source is not a directory: ${source}`);
  if (destination === source || destination.startsWith(`${source}/`)) throw new Error('destination must not be inside the plugin source');
  assertSafeTree(source); mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length !== 0) throw new Error(`Pi projection destination must be empty: ${destination}`);
  cpSync(source, destination, { recursive: true });
  const commands = discoverCommands(source); const names = new Set(commands.map(command => command.name));
  for (const command of commands) writePiCommandSkill(destination, command, namespace, names);
}

function writePiCommandSkill(stage: string, command: Command, namespace: string, names: Set<string>): void {
  if (command.userInvocable === false) throw new Error(`user-invocable: false has no proven Pi skill equivalent: ${command.source}`);
  const skillDir = join(stage, 'skills', command.name);
  if (existsSync(skillDir)) throw new Error(`collision: command ${command.name} would replace an existing skill`);
  const body = command.body
    .replace(/\$ARGUMENTS\b/gu, 'the text after this /skill invocation')
    .replace(/(^|[^A-Za-z0-9_-])\/([a-z0-9][a-z0-9-]*)(?=\s|$|[.,:;!?])/giu, (whole, prefix: string, name: string) => names.has(name) ? `${prefix}/skill:${namespace}-${name}` : whole);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${namespace}-${command.name}\ndescription: ${yamlString(command.description)}\ndisable-model-invocation: true\n---\n\nUse the text after this /skill invocation as command arguments; no text means empty arguments. Relative paths remain relative to this skill directory.\n\n${body}`);
}

function validateMetadata(metadata: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (UNSUPPORTED_FIELDS.has(key)) throw new Error(`permission semantics are unsupported for Codex conversion: ${path} (${key})`);
    if (!COMMAND_FIELDS.has(key) && key !== 'prompt') throw new Error(`unknown command metadata: ${path} (${key})`);
    if (key !== 'description' && key !== 'argument-hint' && key !== 'argument_hint' && key !== 'prompt' && typeof value !== 'boolean') {
      throw new Error(`command policy metadata must be boolean: ${path} (${key})`);
    }
  }
}

function writeCommandSkill(stage: string, command: Command, namespace: string, commandNames: Set<string>): void {
  const skillDir = join(stage, 'skills', command.name);
  if (existsSync(skillDir)) throw new Error(`collision: command ${command.name} would replace an existing skill`);
  const body = command.body.replace(/\$ARGUMENTS\b/gu, 'the invocation tail').replace(/(^|[^A-Za-z0-9_-])\/([a-z0-9][a-z0-9-]*)(?=\s|$|[.,:;!?])/giu, (whole, prefix: string, name: string) => commandNames.has(name) ? `${prefix}$${namespace}:${name}` : whole);
  const hint = command.argumentHint === undefined ? '' : `argument-hint: ${yamlString(command.argumentHint)}\n`;
  const userInvocable = command.userInvocable === undefined ? '' : `user-invocable: ${command.userInvocable}\n`;
  const preface = "Use the user's text after the skill invocation as command arguments; no text means empty arguments. Load referenced skills from sibling directories (../<skill>/SKILL.md). Plugin personas live at ../../agents/<persona>.md and shared references at ../../references/, relative to this file.\n\nFor persona work, read the persona file and use the current harness's available delegation facility with those instructions. Persona names are not assumed to be registered tools or agent types. If delegation is unavailable, perform the passes sequentially and report that limitation.\n\n";
  mkdirSync(join(skillDir, 'agents'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${command.name}\ndescription: ${yamlString(command.description)}\n${hint}${userInvocable}disable-model-invocation: ${!command.allowImplicit}\n---\n\n${preface}${body}`);
  writePolicy(join(skillDir, 'agents', 'openai.yaml'), command.allowImplicit);
}

function hermesSkillUserOnly(skill: string, metadata: Record<string, unknown>): boolean {
  const value = (hyphen: string, underscore: string): unknown => {
    if (metadata[hyphen] !== undefined && metadata[underscore] !== undefined) throw new Error(`conflicting Hermes skill invocation policy spellings: ${skill}`);
    return metadata[hyphen] ?? metadata[underscore];
  };
  const disable = value('disable-model-invocation', 'disable_model_invocation');
  const user = value('user-invocable', 'user_invocable');
  if (disable !== undefined && typeof disable !== 'boolean') throw new Error(`invalid Hermes skill invocation policy: ${skill}`);
  if (user !== undefined && typeof user !== 'boolean') throw new Error(`invalid Hermes skill invocation policy: ${skill}`);
  if (user === false) throw new Error(`Hermes cannot preserve user-invocable: false: ${skill}`);
  const sidecar = join(dirname(skill), 'agents', 'openai.yaml');
  const implicit = existsSync(sidecar) ? readImplicitPolicy(sidecar) : undefined;
  if (disable !== undefined && implicit !== undefined && implicit !== !disable) throw new Error(`conflicting invocation policy for Hermes skill ${skill}`);
  const userOnly = disable === true || implicit === false;
  return userOnly;
}

function stripOrdinaryHermesPolicy(skill: string): void {
  const raw = readFileSync(skill, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) throw new Error(`Hermes skill frontmatter is required: ${skill}`);
  const metadata = parseYaml(match[1] ?? '', skill);
  let changed = false;
  for (const key of ['disable-model-invocation', 'disable_model_invocation', 'user-invocable', 'user_invocable']) {
    if (metadata[key] !== undefined) { delete metadata[key]; changed = true; }
  }
  if (changed) writeFileSync(skill, `---\n${yamlStringify(metadata).trimEnd()}\n---${raw.slice(match[0].length)}`);
}

function translateNativeSkillPolicies(stage: string): void {
  const skills = join(stage, 'skills');
  if (!existsSync(skills)) return;
  for (const entry of readdirSync(skills)) {
    const skill = join(skills, entry);
    if (!statSync(skill).isDirectory()) continue;
    const file = join(skill, 'SKILL.md');
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const metadata = match === null ? {} : parseYaml(match[1] ?? '', file);
    const manual = metadata['disable-model-invocation'] === true;
    const automatic = metadata['disable-model-invocation'] === false;
    const sidecar = join(skill, 'agents', 'openai.yaml');
    if (existsSync(sidecar)) {
      const policy = readImplicitPolicy(sidecar);
      if (policy !== undefined && ((manual && policy !== false) || (automatic && policy !== true))) {
        throw new Error(`conflicting invocation policy for native skill ${entry}`);
      } else if (policy === undefined && manual) writePolicy(sidecar, false);
    } else if (manual) {
      mkdirSync(dirname(sidecar), { recursive: true });
      writePolicy(sidecar, false);
    }
  }
}

function readImplicitPolicy(path: string): boolean | undefined {
  const parsed: unknown = yamlParse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`invalid Codex sidecar: ${path}`);
  const policy = parsed['policy'];
  if (policy === undefined) return undefined;
  if (!isRecord(policy)) throw new Error(`invalid Codex invocation policy: ${path}`);
  if (policy['allow_implicit_invocation'] === undefined) throw new Error(`missing Codex invocation policy: ${path}`);
  if (typeof policy['allow_implicit_invocation'] !== 'boolean') throw new Error(`invalid Codex invocation policy: ${path}`);
  return policy['allow_implicit_invocation'];
}

function writePolicy(path: string, allowImplicit: boolean): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8').replace(/\s*$/u, '') : '';
  const suffix = `policy:\n  allow_implicit_invocation: ${allowImplicit}\n`;
  writeFileSync(path, existing === '' ? suffix : `${existing}\n${suffix}`);
}

function publishStage(stage: string, destination: string): void {
  for (const entry of readdirSync(stage)) cpSync(join(stage, entry), join(destination, entry), { recursive: true });
  rmSync(stage, { recursive: true, force: true });
}

function parseYaml(text: string, path: string): Record<string, unknown> {
  try {
    const parsed: unknown = yamlParse(text);
    if (!isRecord(parsed)) throw new Error('frontmatter must be a mapping');
    return parsed;
  } catch (error) {
    throw new Error(`invalid YAML frontmatter: ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function validSegment(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
