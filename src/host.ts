/**
 * The host contract (AGENTS.md: one module per host under `src/hosts/`,
 * implementing this interface; no host-specific branches outside its module).
 *
 * Split into `HostReader` and `HostWriter` so `doctor` is read-only *by
 * construction*: it takes `HostReader[]` and must never import a writer. A
 * module is evaluated whole, so each host's writer implements `HostWriter` in
 * a sibling `<host>-writer.ts` module — loading the reader must not load the
 * writer. test/doctor-imports.test.ts pins that split.
 */

/** One MCP server as configured somewhere we can read it. */
export interface McpServerEntry {
  /** Server name as written in the config (`mcpServers` key / `[mcp_servers.<name>]`). */
  name: string;
  transport: 'stdio' | 'http';
  /** Where the entry came from: host user-level config or an installed plugin. */
  origin: 'user' | 'plugin';
  /** `plugin@marketplace` (or bare plugin name) when origin is `plugin`. */
  pluginId?: string;
  /** Absolute path of the file the entry was read from. */
  file: string;
  /** Directory relative paths resolve against (plugin root, or the config's root). */
  baseDir: string;
  /** stdio: the executable token (spec §7.2.1: a single token, bare name or `./`-relative). */
  command?: string;
  /** stdio args. Never printed by doctor — args can carry credentials. */
  args?: string[];
  /** False when the host config explicitly disables the entry. */
  enabled?: boolean;
}

/** One installed plugin in a host's native store. */
export interface InstalledPlugin {
  /** Host-native id: `plugin@marketplace` where the host tracks marketplaces, else the plugin name. */
  id: string;
  name: string;
  marketplace?: string;
  /** Install directory, when it exists on disk. */
  path?: string;
  /** Every host-native root whose bytes participate in this active install. */
  contentRoots?: Record<string, string>;
  version?: string;
  /** Source sha the host itself recorded (claude-code `gitCommitSha`), if any. */
  sha?: string;
  enabled?: boolean;
}

export interface HostReader {
  readonly id: string;
  /**
   * True when the host is launched by a macOS GUI app and therefore has no
   * shell PATH — bare commands are suspect there (spec §7.2.1 makes PATH
   * participation client-defined; plugins MUST NOT depend on it).
   */
  readonly gui: boolean;
  /** Is this host present on this machine? */
  detect(): boolean;
  /** Store directories this host owns (for `targets`/reporting). */
  stores(): string[];
  /** Plugins installed in the host's native store. */
  listInstalled(): InstalledPlugin[];
  /** Every MCP server entry the host will consider: user-level config + each installed plugin. */
  mcpEntries(): McpServerEntry[];
}

export interface AddOptions {
  target?: string;
  dryRun?: boolean;
  /** Explicitly replace one selected, proven legacy native install. */
  adoptExisting?: boolean;
}

export interface PinOptions {
  /** Report what would change without writing. */
  dryRun?: boolean;
  /** Restrict the pass to these server names (`update` re-applies recorded pins). */
  only?: readonly string[];
}

/** One bare `command` rewritten to the absolute path it resolved to. */
export interface PinChange {
  server: string;
  from: string;
  to: string;
  /** The file the rewrite was written to. */
  file: string;
}

/** One bare `command` that did not resolve — left untouched, reported as ✗. */
export interface PinRefusal {
  server: string;
  command: string;
  file: string;
}

export interface PinOutcome {
  changes: PinChange[];
  refusals: PinRefusal[];
}

export interface RemoveOptions {
  /** Durable Source identity from the ownership ledger. */
  source?: string;
  /** Exact adapter-owned obsolete identities accepted for this canonical removal. */
  legacyNativeIds?: readonly string[];
}

import type { PluginSource, ResolvedSource } from './source';

export interface HostWriter extends HostReader {
  /** Whether this writer implements explicit legacy adoption. */
  readonly supportsAdoption?: boolean;
  /** Exact public native identity this adapter will expose through readback after apply. */
  readonly plannedNativeId: (plugin: PluginSource) => string;
  /** Adapter-owned obsolete ledger identities eligible for migration to plannedNativeId. */
  readonly legacyNativeIds?: (plugin: PluginSource) => readonly string[];
  /** Pure, conservative relation used to select a persisted ID before dynamic identity capture. */
  readonly persistedNativeIdMayAlias?: (persistedNativeId: string, requestedIdentity: string) => boolean;
  add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'>;
  remove(id: string, opts?: RemoveOptions): Promise<void>;
  /**
   * Rewrite every *bare* stdio `command` in this plugin's installed copy to the
   * absolute path it resolves to on this process's PATH, so a GUI host with no
   * shell PATH can still launch it (spec §7.2.1: whether a configured PATH
   * participates in bare-name resolution is client-defined; plugins MUST NOT
   * depend on it). A command that does not resolve is left alone and returned
   * in `refusals` — `pin` never guesses.
   */
  pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome>;
}
