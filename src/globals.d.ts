declare function setTimeout(callback: () => void, ms: number): unknown;

/**
 * Minimal ambient declarations for the node builtins and globals this project
 * uses, so `tsc --noEmit` passes under strict mode with a zero-dependency
 * typecheck (allowed deps: typescript, smol-toml, add-mcp — no @types/node).
 * Bun implements these at runtime; only the surface we consume is declared.
 */

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): {
    mode: number;
    isFile(): boolean;
    isDirectory(): boolean;
  };
  export function lstatSync(path: string): {
    mode: number;
    isSymbolicLink(): boolean;
    isFile(): boolean;
    isDirectory(): boolean;
  };
  export function accessSync(path: string, mode?: number): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function cpSync(src: string, dest: string, options?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
  export function chmodSync(path: string, mode: number): void;
  export function mkdtempSync(prefix: string): string;
  export function renameSync(oldPath: string, newPath: string): void;
  export function realpathSync(path: string): string;
  export function symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void;
  export function readlinkSync(path: string): string;
  export const constants: { X_OK: number };
}

declare module 'node:path' {
  export const delimiter: string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export function isAbsolute(p: string): boolean;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options?: { cwd?: string; encoding?: string; env?: Record<string, string | undefined> },
  ): SpawnSyncResult;
}

declare module 'node:crypto' {
  export interface Hash {
    update(value: string | Uint8Array): Hash;
    digest(format: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

/** Minimal surface of Bun's test runner used by this repo's tests. */
declare module 'bun:test' {
  export function afterAll(fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export const test: typeof it;
  export function expect(actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toMatch(pattern: RegExp): void;
    toHaveLength(expected: number): void;
    toBeGreaterThan(expected: number): void;
    toBeUndefined(): void;
  };
}

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
  chdir(dir: string): void;
  argv: string[];
  platform: string;
  execPath: string;
  exitCode?: number;
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const URL: {
  new(input: string): {
    username: string;
    password: string;
    search: string;
    hash: string;
    toString(): string;
  };
};

interface ImportMeta {
  /** Absolute directory of the current module (Bun / bundler convention). */
  readonly dir: string;
  readonly url: string;
}

/** Runtime-bridge surfaces: buffer-shaped spawnSync overload (ambient module
 * declarations merge), async spawn, and the loopback port probe. */
declare module 'node:child_process' {
  export interface SpawnSyncBufferResult {
    status: number | null;
    stdout?: Uint8Array;
    stderr?: Uint8Array;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; killSignal?: 'SIGKILL'; stdio?: unknown; maxBuffer?: number; encoding: 'buffer' },
  ): SpawnSyncBufferResult;
  export interface ChildProcessLike {
    exitCode: number | null;
    on(event: 'exit', listener: (code: number | null) => void): ChildProcessLike;
    on(event: 'error', listener: (error: Error) => void): ChildProcessLike;
    kill(): void;
  }
  export function spawn(command: string, args: string[], options: { env?: Record<string, string | undefined>; cwd?: string; stdio?: unknown }): ChildProcessLike;
}

declare module 'node:net' {
  export interface NetServer {
    unref(): NetServer;
    on(event: 'error', listener: (error: Error) => void): NetServer;
    listen(port: number, host: string, callback: () => void): void;
    address(): { port: number } | string | null;
    close(callback?: () => void): void;
  }
  export function createServer(): NetServer;
}
