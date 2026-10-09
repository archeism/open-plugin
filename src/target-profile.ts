import {
  canonicalTargetContext,
  parsePersistedTargetIdentity,
  type PersistedTargetContext,
  type PersistedTargetIdentity,
} from './target-identity';
import type { TargetIdentity } from './deployment-scope';

export type TargetProfileFailureKind = 'invalid-argument' | 'invalid-selection';

export class TargetProfileValidationError extends Error {
  constructor(readonly kind: TargetProfileFailureKind, message: string) {
    super(message);
    this.name = 'TargetProfileValidationError';
  }
}

/** Pure adapter boundary for manifest target parsing and batch-overlap checks. */
export interface TargetProfile<Kind extends string = string> {
  readonly kind: Kind;
  parseSyncTarget(value: unknown, label: string): PersistedTargetIdentity;
  parseRetirementTarget(value: unknown, label: string): TargetIdentity;
  canonicalContext(target: PersistedTargetIdentity): PersistedTargetContext | undefined;
  physicalKey(target: PersistedTargetIdentity): string;
  overlaps(left: PersistedTargetIdentity, right: PersistedTargetIdentity): boolean;
}

/** Current native adapters with one implicit store share this strict context-free profile. */
export function singleInstanceTargetProfile<const Kind extends string>(kind: Kind): TargetProfile<Kind> {
  const parse = (value: unknown, label: string, retirement: boolean): PersistedTargetIdentity => {
    const target = parsePersistedTargetIdentity(value, label);
    if (target.kind !== kind) invalidSelection(`${label} kind must be '${kind}'`);
    if (target.instance !== 'default') invalidSelection(`${label} ${kind} instance must be 'default'`);
    if (target.context !== undefined) {
      invalidArgument(`${label} ${kind} does not accept target context${retirement ? ' during retirement' : ''}`);
    }
    return { kind, instance: 'default' };
  };

  return {
    kind,
    parseSyncTarget: (value, label) => parse(value, label, false),
    parseRetirementTarget(value, label) {
      const target = parse(value, label, true);
      return { kind: target.kind, instance: target.instance };
    },
    canonicalContext: () => undefined,
    physicalKey: target => JSON.stringify([target.kind, target.instance]),
    overlaps: (left, right) => left.kind === right.kind && left.instance === right.instance,
  };
}

export function canonicalProfileContext(target: PersistedTargetIdentity): PersistedTargetContext | undefined {
  return target.context === undefined ? undefined : canonicalTargetContext(target.context);
}

export function invalidTargetArgument(message: string): never {
  throw new TargetProfileValidationError('invalid-argument', message);
}

export function invalidTargetSelection(message: string): never {
  throw new TargetProfileValidationError('invalid-selection', message);
}

function invalidArgument(message: string): never {
  return invalidTargetArgument(message);
}

function invalidSelection(message: string): never {
  return invalidTargetSelection(message);
}
