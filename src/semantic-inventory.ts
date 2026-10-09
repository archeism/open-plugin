import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { createLifecycleReason, type LifecycleReason } from './lifecycle-report';
import type { PluginSource } from './source';

declare const Bun: { YAML: { parse(input: string): unknown } };

export const PACKAGE_SEMANTICS = [
  'ordinary-skills',
  'mcp',
  'hooks',
  'commands',
  'agents',
  'model-invocation-control',
  'user-invocation-control',
  'auto-update-control',
  'resources',
  'permissions-preprocessing',
  'retirement',
  'retention-safety',
  'readback',
  'rollback',
  'activation-reload',
  'reversible-disable',
] as const;

export const CAPABILITY_OPERATIONS = ['install', 'update', 'disable', 'retire'] as const;
export const SOURCE_TYPES = ['local', 'git'] as const;

export type PackageSemantic = (typeof PACKAGE_SEMANTICS)[number];
export type CapabilityOperation = (typeof CAPABILITY_OPERATIONS)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface PackageComponentInventory {
  skills: string[];
  mcp: string[];
  hooks: string[];
  commands: string[];
  agents: string[];
  resources: string[];
  permissionsPreprocessing: string[];
}

export type ComponentKind = 'command' | 'agent';
export type ComponentRoot = 'commands' | '.claude/commands' | 'agents' | '.claude/agents';
export type ComponentDialect = 'markdown' | 'toml';

export interface ComponentDefinition {
  kind: ComponentKind;
  root: ComponentRoot;
  dialect: ComponentDialect;
  identity: string;
  path: string;
}

export interface InvocationPolicyDeclaration {
  dialect: 'claude-frontmatter' | 'codex-sidecar' | 'component-frontmatter' | 'component-toml';
  path: string;
  field: string;
  direction: 'model' | 'user';
  allowed: boolean;
}

export interface SkillInvocationPolicy {
  skill: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  declarations: InvocationPolicyDeclaration[];
}

export interface ComponentInvocationPolicy {
  component: ComponentKind;
  path: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  declarations: InvocationPolicyDeclaration[];
}

export interface AutoUpdateDeclaration {
  dialect: 'dcode-manifest-extension';
  path: string;
  field: 'extensions.com.langchain.deepagents.code.autoUpdate';
  enabled: boolean;
}

export type HookDeclarationForm =
  | 'default-file'
  | 'manifest-file'
  | 'manifest-directory'
  | 'manifest-inline-event-map'
  | 'manifest-inline-wrapped'
  | 'manifest-inline-array';

/** Source-authored hook configuration facts; target support remains profile-backed. */
export interface HookDeclaration {
  source: string;
  manifestPath: string | null;
  form: HookDeclarationForm;
  events: string[];
  handlerTypes: string[];
}

export interface PackageSemanticInventory {
  schemaVersion: 1;
  package: { name: string; version: string | null; fingerprint: string | null };
  components: PackageComponentInventory;
  componentDefinitions: ComponentDefinition[];
  invocationPolicies: SkillInvocationPolicy[];
  componentInvocationPolicies: ComponentInvocationPolicy[];
  autoUpdate: AutoUpdateDeclaration[];
  /** Every recognized native manifest present, without assigning host precedence. */
  manifestPaths: string[];
  hookDeclarations: HookDeclaration[];
  /** Semantics authored by the package. Lifecycle requirements are added per operation. */
  requiredSemantics: PackageSemantic[];
}

export class SemanticInventoryError extends Error {
  constructor(readonly reason: Extract<LifecycleReason, { category: 'usage' }>) {
    super(reason.diagnostic);
    this.name = 'SemanticInventoryError';
  }
}

/**
 * Inventory immutable Source bytes before a host prepares or activates any
 * component. A malformed semantic declaration is invalid Source input, not a
 * host capability gap.
 */
export function inventoryPackageSemantics(plugin: PluginSource): PackageSemanticInventory {
  const files = walkFiles(plugin.dir);
  const skills = files.filter((path) => path.startsWith('skills/') && path.endsWith('/SKILL.md'));
  const componentInventory = inventoryComponentRoots(plugin.dir);
  const commands = componentInventory.definitions
    .filter(({ kind }) => kind === 'command')
    .map(({ path }) => path)
    .sort();
  const agents = componentInventory.definitions
    .filter(({ kind }) => kind === 'agent')
    .map(({ path }) => path)
    .sort();
  const mcp: string[] = files.filter((path) => path === '.mcp.json' || path === 'mcp.json');
  const sidecars = new Set(skills.map((path) => `${dirname(path)}/agents/openai.yaml`));
  const manifests = readSemanticManifests(plugin.dir);
  const hookInventory = inventoryHooks(plugin.dir, files, manifests);
  const resources = files.filter((path) =>
    (['assets/', 'references/', 'resources/'].some((root) => path.startsWith(root))
      || (path.startsWith('skills/') && !path.endsWith('/SKILL.md'))
      || path.startsWith('hooks/')
      || path.startsWith('.claude/hooks/'))
    && !sidecars.has(path)
    && !hookInventory.configPaths.has(path));

  for (const path of mcp) parseJsonObject(join(plugin.dir, path), `MCP declaration ${path}`);

  const permissionPaths = new Set(componentInventory.permissionPaths);

  const invocationPolicies = skills.map((path) => inventorySkillPolicy(plugin.dir, path));
  const manifest = manifests[0];
  if (manifest?.mcpServers !== undefined) {
    if (!isRecord(manifest.mcpServers)) invalid('plugin manifest mcpServers must be an object');
    mcp.push(`${manifest.path}#mcpServers`);
  }
  const autoUpdate: AutoUpdateDeclaration[] = [];
  if (manifest !== undefined && manifest.extensions !== undefined) {
    const extension = manifest.extensions;
    if (!isRecord(extension)) invalid('plugin manifest extensions must be an object');
    const dcode = extension['com.langchain.deepagents.code'];
    if (dcode !== undefined) {
      if (!isRecord(dcode)) invalid('dcode plugin manifest extension must be an object');
      if (Object.hasOwn(dcode, 'autoUpdate')) {
        if (typeof dcode['autoUpdate'] !== 'boolean') invalid('dcode plugin manifest autoUpdate must be boolean');
        autoUpdate.push({
          dialect: 'dcode-manifest-extension',
          path: manifest.path,
          field: 'extensions.com.langchain.deepagents.code.autoUpdate',
          enabled: dcode['autoUpdate'],
        });
      }
    }
  }

  const components: PackageComponentInventory = {
    skills,
    mcp: uniqueSorted(mcp),
    hooks: hookInventory.components,
    commands,
    agents,
    resources,
    permissionsPreprocessing: [...permissionPaths].sort(),
  };
  const required = new Set<PackageSemantic>();
  if (skills.length > 0) required.add('ordinary-skills');
  if (components.mcp.length > 0) required.add('mcp');
  if (components.hooks.length > 0) required.add('hooks');
  if (commands.length > 0) required.add('commands');
  if (agents.length > 0) required.add('agents');
  if (invocationPolicies.some((policy) => !policy.modelInvocable)) required.add('model-invocation-control');
  if (invocationPolicies.some((policy) => !policy.userInvocable)) required.add('user-invocation-control');
  if (componentInventory.invocationPolicies.some((policy) => !policy.modelInvocable)) required.add('model-invocation-control');
  if (componentInventory.invocationPolicies.some((policy) => !policy.userInvocable)) required.add('user-invocation-control');
  if (autoUpdate.length > 0) required.add('auto-update-control');
  if (resources.length > 0) required.add('resources');
  if (permissionPaths.size > 0) required.add('permissions-preprocessing');

  return {
    schemaVersion: 1,
    package: {
      name: plugin.name,
      version: plugin.version ?? null,
      fingerprint: plugin.contentFingerprint ?? null,
    },
    components,
    componentDefinitions: componentInventory.definitions,
    invocationPolicies,
    componentInvocationPolicies: componentInventory.invocationPolicies,
    autoUpdate,
    manifestPaths: manifests.map(({ path }) => path),
    hookDeclarations: hookInventory.declarations,
    requiredSemantics: ordered(required),
  };
}

/** Project complete Source requirements for activation, or lifecycle-only requirements for retirement. */
export function requiredSemanticsForOperation(
  inventory: PackageSemanticInventory,
  operation: 'install' | 'update',
): PackageSemantic[];
export function requiredSemanticsForOperation(
  inventory: PackageSemanticInventory | undefined,
  operation: 'retire',
): PackageSemantic[];
export function requiredSemanticsForOperation(
  inventory: undefined,
  operation: 'disable',
): PackageSemantic[];
export function requiredSemanticsForOperation(
  inventory: PackageSemanticInventory | undefined,
  operation: CapabilityOperation,
): PackageSemantic[] {
  if (operation === 'retire') {
    return ordered(new Set<PackageSemantic>([
      'retirement',
      'retention-safety',
      'readback',
      'rollback',
      'activation-reload',
    ]));
  }
  if (operation === 'disable') {
    return ordered(new Set<PackageSemantic>([
      'retention-safety',
      'readback',
      'rollback',
      'activation-reload',
      'reversible-disable',
    ]));
  }
  if (inventory === undefined) invalid(`${operation} semantic admission requires Source inventory`);
  const required = new Set(inventory.requiredSemantics);
  required.add('readback');
  required.add('rollback');
  required.add('activation-reload');
  if (operation === 'install' || operation === 'update') required.add('auto-update-control');
  return ordered(required);
}

function inventorySkillPolicy(root: string, skill: string): SkillInvocationPolicy {
  const declarations: InvocationPolicyDeclaration[] = [];
  const frontmatter = openingFrontmatter(readFileSync(join(root, skill), 'utf8'), skill);
  if (frontmatter !== undefined) {
    for (const field of MODEL_INVOCATION_ALIASES) {
      if (!Object.hasOwn(frontmatter, field)) continue;
      const value = frontmatter[field];
      if (typeof value !== 'boolean') invalid(`skill invocation policy ${field} must be boolean: ${skill}`);
      declarations.push({ dialect: 'claude-frontmatter', path: skill, field, direction: 'model', allowed: !value });
    }
    for (const field of USER_INVOCATION_ALIASES) {
      if (!Object.hasOwn(frontmatter, field)) continue;
      const value = frontmatter[field];
      if (typeof value !== 'boolean') invalid(`skill invocation policy ${field} must be boolean: ${skill}`);
      declarations.push({ dialect: 'claude-frontmatter', path: skill, field, direction: 'user', allowed: value });
    }
  }

  const sidecar = `${dirname(skill)}/agents/openai.yaml`;
  if (existsSync(join(root, sidecar))) {
    const parsed = parseYamlObject(readFileSync(join(root, sidecar), 'utf8'), `Codex invocation sidecar ${sidecar}`);
    const policy = parsed['policy'];
    if (policy !== undefined) {
      if (!isRecord(policy)) invalid(`Codex invocation sidecar policy must be an object: ${sidecar}`);
      if (Object.hasOwn(policy, 'allow_implicit_invocation')) {
        const value = policy['allow_implicit_invocation'];
        if (typeof value !== 'boolean') invalid(`Codex invocation sidecar policy must be boolean: ${sidecar}`);
        declarations.push({
          dialect: 'codex-sidecar',
          path: sidecar,
          field: 'policy.allow_implicit_invocation',
          direction: 'model',
          allowed: value,
        });
      }
    }
  }

  return {
    skill,
    modelInvocable: onePolicyValue(declarations, 'model', skill),
    userInvocable: onePolicyValue(declarations, 'user', skill),
    declarations,
  };
}

function onePolicyValue(declarations: InvocationPolicyDeclaration[], direction: 'model' | 'user', skill: string): boolean {
  const values = new Set(declarations.filter((entry) => entry.direction === direction).map((entry) => entry.allowed));
  if (values.size > 1) invalid(`conflicting ${direction}-invocation policy declarations: ${skill}`);
  return values.values().next().value ?? true;
}

function openingFrontmatter(raw: string, path: string): Record<string, unknown> | undefined {
  const match = OPENING_FRONTMATTER.exec(raw);
  if (match === null) return undefined;
  return parseYamlObject(match[1] ?? '', `frontmatter ${path}`);
}

function requiredOpeningFrontmatter(raw: string, path: string): Record<string, unknown> {
  const frontmatter = openingFrontmatter(raw, path);
  if (frontmatter === undefined) invalid(`component frontmatter is required: ${path}`);
  return frontmatter;
}

function parseYamlObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(raw);
  } catch (error) {
    invalid(`${label} has invalid YAML (${errorDiagnostic(error)})`);
  }
  if (!isRecord(parsed)) invalid(`${label} must be an object`);
  return parsed;
}

function parseTomlObject(raw: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (error) {
    invalid(`command ${path} has invalid TOML (${errorDiagnostic(error)})`);
  }
  if (!isRecord(parsed)) invalid(`command ${path} must be an object`);
  return parsed;
}

function parseJsonObject(path: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    invalid(`${label} has invalid JSON (${errorDiagnostic(error)})`);
  }
  if (!isRecord(parsed)) invalid(`${label} must be an object`);
  return parsed;
}

type SemanticManifest = Record<string, unknown> & { path: string };

function readSemanticManifests(root: string): SemanticManifest[] {
  return [
    'plugin.json',
    '.plugin/plugin.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ].filter((path) => existsSync(join(root, path))).map((path) => ({
    ...parseJsonObject(join(root, path), `plugin manifest ${path}`),
    path,
  }));
}

/**
 * Hook discovery follows authored configuration, never directory membership.
 * Agent Plugins 1.0 has no portable hook component (spec §§6.1, 7, 8):
 * https://agent-plugins.org/specification#7-component-types
 * These are native Claude/dcode extension surfaces:
 * https://code.claude.com/docs/en/plugins-reference#hooks
 * https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/manifest.py
 */
function inventoryHooks(
  root: string,
  files: readonly string[],
  manifests: readonly SemanticManifest[],
): { components: string[]; configPaths: ReadonlySet<string>; declarations: HookDeclaration[] } {
  const components = new Set<string>();
  const configPaths = new Set<string>();
  const declarations: HookDeclaration[] = [];
  const documents = new Map<string, Pick<HookDeclaration, 'events' | 'handlerTypes'>>();

  const readDocument = (path: string): Pick<HookDeclaration, 'events' | 'handlerTypes'> => {
    const cached = documents.get(path);
    if (cached !== undefined) return cached;
    const value = parseJsonObject(join(root, path), `hook configuration ${path}`);
    if (Object.keys(value).some((field) => field !== 'hooks') || !isRecord(value['hooks'])) {
      invalid(`hook configuration ${path} must contain only a top-level hooks object`);
    }
    const observation = validateHookEventMap(value['hooks'], `hook configuration ${path}`);
    documents.set(path, observation);
    return observation;
  };
  const addDocument = (
    path: string,
    manifestPath: string | null,
    form: Extract<HookDeclarationForm, 'default-file' | 'manifest-file' | 'manifest-directory'>,
  ): void => {
    const observation = readDocument(path);
    configPaths.add(path);
    components.add(path);
    declarations.push({ source: path, manifestPath, form, ...observation });
  };

  if (files.includes('hooks/hooks.json')) addDocument('hooks/hooks.json', null, 'default-file');

  for (const manifest of manifests.filter((candidate) => Object.hasOwn(candidate, 'hooks'))) {
    if (manifest.path === '.plugin/plugin.json') {
      invalid('hook declarations in .plugin/plugin.json have no source-backed native contract');
    }
    const declaration = manifest['hooks'];
    const addInline = (value: Record<string, unknown>, label: string, arrayItem: boolean): void => {
      let eventMap = value;
      let form: HookDeclarationForm = arrayItem ? 'manifest-inline-array' : 'manifest-inline-event-map';
      if (Object.hasOwn(value, 'hooks')) {
        if (Object.keys(value).some((field) => field !== 'hooks') || !isRecord(value['hooks'])) {
          invalid(`inline hook declaration ${label} has an ambiguous hooks wrapper`);
        }
        if (arrayItem) invalid(`inline hook declaration ${label} cannot use a file-document wrapper inside an array`);
        eventMap = value['hooks'];
        form = 'manifest-inline-wrapped';
      }
      const observation = validateHookEventMap(eventMap, `inline hook declaration ${label}`);
      components.add(label);
      declarations.push({ source: label, manifestPath: manifest.path, form, ...observation });
    };
    const addPath = (value: string): void => {
      const resolved = declaredHookPath(root, value);
      addDocument(resolved.path, manifest.path, resolved.directory ? 'manifest-directory' : 'manifest-file');
    };

    if (typeof declaration === 'string') {
      addPath(declaration);
    } else if (isRecord(declaration)) {
      addInline(declaration, `${manifest.path}#hooks`, false);
    } else if (Array.isArray(declaration) && declaration.length > 0) {
      for (const [index, item] of declaration.entries()) {
        if (typeof item === 'string') addPath(item);
        else if (manifest.path === '.claude-plugin/plugin.json' && isRecord(item)) {
          addInline(item, `${manifest.path}#hooks[${index}]`, true);
        }
        else invalid(`plugin manifest ${manifest.path} hooks[${index}] has an unsupported shape`);
      }
    } else {
      invalid(`plugin manifest ${manifest.path} hooks must be a path, object, or non-empty supported array`);
    }
  }

  return {
    components: [...components].sort(),
    configPaths,
    declarations: declarations.sort((left, right) => left.source.localeCompare(right.source)),
  };
}

function declaredHookPath(root: string, declaration: string): { path: string; directory: boolean } {
  const withoutPrefix = declaration.slice(2);
  if (!declaration.startsWith('./') || declaration.includes('\\') || /^[a-z]:\//iu.test(withoutPrefix)) {
    invalid(`declared hook path must start with './' and use portable separators: ${declaration}`);
  }
  const path = portable(relative(root, join(root, declaration)));
  if (path === '' || path === '..' || path.startsWith('../') || declaration !== `./${path}`) {
    invalid(`declared hook path must be a canonical file inside the plugin root: ${declaration}`);
  }
  const absolute = join(root, path);
  if (!existsSync(absolute)) invalid(`declared hook configuration does not exist: ${declaration}`);
  const stat = lstatSync(absolute);
  if (stat.isDirectory()) {
    const document = `${path}/hooks.json`;
    const documentPath = join(root, document);
    if (!existsSync(documentPath) || !lstatSync(documentPath).isFile()) {
      invalid(`declared hook directory must contain hooks.json: ${declaration}`);
    }
    return { path: document, directory: true };
  }
  if (!stat.isFile() || !path.endsWith('.json')) {
    invalid(`declared hook configuration must be a JSON file or native hook directory: ${declaration}`);
  }
  return { path, directory: false };
}

function validateHookEventMap(
  value: unknown,
  label: string,
): Pick<HookDeclaration, 'events' | 'handlerTypes'> {
  if (!isRecord(value)) invalid(`${label} must be a hook event object`);
  const events: string[] = [];
  const handlerTypes = new Set<string>();
  for (const [event, groups] of Object.entries(value)) {
    if (event.trim() === '' || !Array.isArray(groups)) invalid(`${label} event '${event}' must be an array`);
    events.push(event);
    for (const [groupIndex, group] of groups.entries()) {
      if (!isRecord(group)) invalid(`${label} event '${event}' group ${groupIndex} must be an object`);
      if (group['matcher'] !== undefined && typeof group['matcher'] !== 'string') {
        invalid(`${label} event '${event}' group ${groupIndex} matcher must be a string`);
      }
      if (!Array.isArray(group['hooks'])) invalid(`${label} event '${event}' group ${groupIndex} hooks must be an array`);
      for (const [hookIndex, hook] of group['hooks'].entries()) {
        if (!isRecord(hook) || typeof hook['type'] !== 'string' || hook['type'].trim() === '') {
          invalid(`${label} event '${event}' group ${groupIndex} hook ${hookIndex} needs a non-empty type`);
        }
        validateHookHandler(hook, `${label} event '${event}' group ${groupIndex} hook ${hookIndex}`);
        handlerTypes.add(hook['type']);
      }
    }
  }
  return { events: events.sort(), handlerTypes: [...handlerTypes].sort() };
}

function validateHookHandler(hook: Record<string, unknown>, label: string): void {
  const nonemptyString = (field: string): boolean => typeof hook[field] === 'string' && hook[field].trim() !== '';
  if (hook['type'] === 'command' && nonemptyString('command')) return;
  if (hook['type'] === 'http' && nonemptyString('url')) return;
  if (hook['type'] === 'mcp_tool' && nonemptyString('server') && nonemptyString('tool')) return;
  if ((hook['type'] === 'prompt' || hook['type'] === 'agent') && nonemptyString('prompt')) return;
  invalid(`${label} has an unknown type or is missing required fields`);
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === '.git' || entry === 'node_modules' || entry === '.plgnz-install.json') continue;
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) invalid(`package semantic inventory refuses symlink: ${portable(relative(root, path))}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(portable(relative(root, path)));
      else invalid(`package semantic inventory refuses unsupported entry: ${portable(relative(root, path))}`);
    }
  };
  walk(root);
  return files.sort();
}

type ComponentRootSpec = {
  kind: ComponentKind;
  root: ComponentRoot;
  dialects: Readonly<Record<string, ComponentDialect>>;
};

const COMPONENT_ROOT_SPECS: readonly ComponentRootSpec[] = [
  { kind: 'command', root: 'commands', dialects: { '.md': 'markdown', '.toml': 'toml' } },
  { kind: 'command', root: '.claude/commands', dialects: { '.md': 'markdown' } },
  { kind: 'agent', root: 'agents', dialects: { '.md': 'markdown' } },
  { kind: 'agent', root: '.claude/agents', dialects: { '.md': 'markdown' } },
];

const UNSUPPORTED_COMPONENT_ROOTS = ['.codex/commands', '.codex/agents'] as const;

function inventoryComponentRoots(root: string): {
  definitions: ComponentDefinition[];
  invocationPolicies: ComponentInvocationPolicy[];
  permissionPaths: string[];
} {
  for (const unsupported of UNSUPPORTED_COMPONENT_ROOTS) {
    if (existsSync(join(root, unsupported))) invalid(`unsupported component root: ${unsupported}`);
  }

  const definitions: ComponentDefinition[] = [];
  const invocationPolicies: ComponentInvocationPolicy[] = [];
  const permissionPaths = new Set<string>();
  for (const spec of COMPONENT_ROOT_SPECS) {
    const directory = join(root, spec.root);
    if (!existsSync(directory)) continue;
    const rootStat = lstatSync(directory);
    if (!rootStat.isDirectory()) invalid(`component root must be a directory: ${spec.root}`);
    const entries = readdirSync(directory).sort();
    if (entries.length === 0) invalid(`component root must not be empty: ${spec.root}`);

    const identities = new Set<string>();
    for (const entry of entries) {
      const absolute = join(directory, entry);
      const path = `${spec.root}/${entry}`;
      const stat = lstatSync(absolute);
      if (!stat.isFile()) invalid(`component root entries must be regular files: ${path}`);
      const suffix = Object.keys(spec.dialects).find((candidate) => entry.endsWith(candidate));
      if (suffix === undefined) invalid(`unsupported ${spec.kind} dialect: ${path}`);
      const dialect = spec.dialects[suffix];
      if (dialect === undefined) invalid(`unsupported ${spec.kind} dialect: ${path}`);

      const parsed = parseComponentDefinition(absolute, path, spec.kind, dialect, entry.slice(0, -suffix.length));
      if (identities.has(parsed.definition.identity)) {
        invalid(`duplicate ${spec.kind} identity '${parsed.definition.identity}' within ${spec.root}`);
      }
      identities.add(parsed.definition.identity);
      definitions.push({ ...parsed.definition, root: spec.root });
      if (parsed.policy.declarations.length > 0) invocationPolicies.push(parsed.policy);
      if (parsed.hasPermissionsPreprocessing) permissionPaths.add(path);
    }
  }
  return {
    definitions,
    invocationPolicies,
    permissionPaths: [...permissionPaths].sort(),
  };
}

function parseComponentDefinition(
  absolute: string,
  path: string,
  kind: ComponentKind,
  dialect: ComponentDialect,
  filenameIdentity: string,
): {
  definition: Omit<ComponentDefinition, 'root'>;
  policy: ComponentInvocationPolicy;
  hasPermissionsPreprocessing: boolean;
} {
  const raw = readFileSync(absolute, 'utf8');
  let record: Record<string, unknown>;
  let body: string;
  if (dialect === 'toml') {
    if (kind !== 'command') invalid(`unsupported ${kind} dialect: ${path}`);
    record = parseTomlObject(raw, path);
    if (typeof record['description'] !== 'string' || record['description'].trim() === '' || typeof record['prompt'] !== 'string') {
      invalid(`command TOML needs description and prompt: ${path}`);
    }
    body = record['prompt'];
  } else {
    const frontmatter = requiredOpeningFrontmatter(raw, path);
    if (typeof frontmatter['description'] !== 'string' || frontmatter['description'].trim() === '') {
      invalid(`${kind} description is required: ${path}`);
    }
    record = frontmatter;
    const match = OPENING_FRONTMATTER.exec(raw);
    body = match?.[2] ?? '';
  }

  const identity = kind === 'agent' ? record['name'] : filenameIdentity;
  if (typeof identity !== 'string' || identity.trim() === '') invalid(`${kind} identity is required: ${path}`);
  if (kind === 'command' && /@\{/u.test(body)) invalid(`unsupported command preprocessing: ${path}`);
  const declarations = kind === 'command' ? componentInvocationDeclarations(record, dialect, path) : [];
  const policy: ComponentInvocationPolicy = {
    component: kind,
    path,
    modelInvocable: onePolicyValue(declarations, 'model', path),
    userInvocable: onePolicyValue(declarations, 'user', path),
    declarations,
  };
  return {
    definition: { kind, dialect, identity, path },
    policy,
    hasPermissionsPreprocessing: hasAny(record, PERMISSION_FIELDS) || /!`[\s\S]*?`/u.test(body),
  };
}

function componentInvocationDeclarations(
  record: Record<string, unknown>,
  dialect: ComponentDialect,
  path: string,
): InvocationPolicyDeclaration[] {
  const declarations: InvocationPolicyDeclaration[] = [];
  const policyDialect = dialect === 'toml' ? 'component-toml' : 'component-frontmatter';
  for (const field of MODEL_INVOCATION_ALIASES) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (typeof value !== 'boolean') invalid(`component invocation policy ${field} must be boolean: ${path}`);
    declarations.push({ dialect: policyDialect, path, field, direction: 'model', allowed: !value });
  }
  for (const field of USER_INVOCATION_ALIASES) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (typeof value !== 'boolean') invalid(`component invocation policy ${field} must be boolean: ${path}`);
    declarations.push({ dialect: policyDialect, path, field, direction: 'user', allowed: value });
  }
  onePolicyValue(declarations, 'model', path);
  onePolicyValue(declarations, 'user', path);
  return declarations;
}

function ordered(values: ReadonlySet<PackageSemantic>): PackageSemantic[] {
  return PACKAGE_SEMANTICS.filter((semantic) => values.has(semantic));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function portable(path: string): string {
  return path.replaceAll('\\', '/');
}

function hasAny(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => Object.hasOwn(record, field));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(diagnostic: string): never {
  throw new SemanticInventoryError(createLifecycleReason('usage', 'usage.invalid-argument', diagnostic));
}

function errorDiagnostic(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : String(error);
}

const OPENING_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u;
const MODEL_INVOCATION_ALIASES = ['disable-model-invocation', 'disable_model_invocation'] as const;
const USER_INVOCATION_ALIASES = ['user-invocable', 'user_invocable'] as const;
const PERMISSION_FIELDS = [
  'allowed-tools',
  'allowed_tools',
  'disallowed-tools',
  'disallowed_tools',
  'permission-mode',
  'permission_mode',
  'permissionMode',
  'preprocess',
  'preprocessing',
  'hooks',
  'tools',
  'isolation',
] as const;
