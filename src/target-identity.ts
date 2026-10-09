import type { TargetIdentity } from './deployment-scope';
import { validateStableIdentityString } from './source-reference';

export type PersistedTargetContextValue = string | number | boolean;
export type PersistedTargetContext = Record<string, PersistedTargetContextValue>;

/** Credential-free target identity safe for manifests, durable state, and reports. */
export interface PersistedTargetIdentity extends TargetIdentity {
  /** Adapter-owned, bounded scalar context. Secret-looking keys are refused. */
  context?: PersistedTargetContext;
}

const SECRET_CONTEXT_KEY = /(secret|token|password|credential|authorization|api[-_.]?key|private[-_.]?key)/iu;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//iu;

export class TargetIdentityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetIdentityValidationError';
  }
}

/** Strictly parse and canonicalize the TargetIdentity/context persisted by lifecycle state v2. */
export function parsePersistedTargetIdentity(value: unknown, label: string): PersistedTargetIdentity {
  const target = object(value, label);
  exactFields(target, ['kind', 'instance', 'context']);
  const kind = stableString(target['kind'], `${label}.kind`);
  const instance = stableString(target['instance'], `${label}.instance`);
  if (target['context'] === undefined) return { kind, instance };
  return { kind, instance, context: parseContext(target['context'], `${label}.context`) };
}

/** Stable bytes for comparing adapter contexts independently of caller key order. */
export function canonicalTargetContextBytes(context: PersistedTargetContext | undefined): string {
  return JSON.stringify(context === undefined ? null : canonicalTargetContext(context));
}

/** Copy a validated context into deterministic key order. */
export function canonicalTargetContext(context: PersistedTargetContext): PersistedTargetContext {
  return Object.fromEntries(Object.entries(context).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function parseContext(value: unknown, label: string): PersistedTargetContext {
  const context = object(value, label);
  const parsed: PersistedTargetContext = {};
  for (const key of Object.keys(context).sort()) {
    if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(key)) invalid(`${label} has invalid key '${key}'`);
    if (SECRET_CONTEXT_KEY.test(key)) invalid(`secret-bearing target context key '${key}' is not permitted`);
    const entry = context[key];
    if (typeof entry === 'string') {
      stableString(entry, `${label}.${key}`);
      assertCredentialFree(entry, `${label}.${key}`);
      parsed[key] = entry;
      continue;
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) invalid(`${label}.${key} must be finite`);
      parsed[key] = Object.is(entry, -0) ? 0 : entry;
      continue;
    }
    if (typeof entry === 'boolean') {
      parsed[key] = entry;
      continue;
    }
    invalid(`${label}.${key} must be a scalar`);
  }
  return parsed;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).find(field => !fields.has(field));
  if (unknown !== undefined) invalid(`unsupported target identity field '${unknown}'`);
}

function stableString(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  try {
    validateStableIdentityString(value, label);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  return value;
}

function assertCredentialFree(value: string, label: string): void {
  const authority = ABSOLUTE_URL.test(value) ? value.slice(value.indexOf('//') + 2).split(/[/?#]/u, 1)[0] : undefined;
  if (authority?.includes('@') === true || /[?&](?:access_?token|token|password|secret|api_?key|credential)=/iu.test(value)) {
    invalid(`${label} must not contain credentials`);
  }
}

function invalid(message: string): never {
  throw new TargetIdentityValidationError(message);
}
