import type { ConsumerProfile } from './consumer-profiles';
import type { PackageSemantic } from './semantic-inventory';

export type CompatibilityStatus = 'supported' | 'unsupported' | 'unverified';
export type ConsumerOperationCapability = 'install' | 'update';
export type ConsumerCapability = ConsumerOperationCapability | PackageSemantic | 'profile' | `operation.${string}`;

/** A target-specific refusal that callers render as a typed lifecycle reason. */
export class CompatibilityError extends Error {
  constructor(
    readonly target: string,
    readonly capability: ConsumerCapability,
    readonly status: Extract<CompatibilityStatus, 'unsupported' | 'unverified'>,
    readonly evidence: string,
    diagnostic?: string,
  ) {
    super(diagnostic ?? `target '${target}' is ${status} for ${capability}; evidence: ${evidence}`);
    this.name = 'CompatibilityError';
  }
}

export function requireCompatible(profile: ConsumerProfile, capability: ConsumerOperationCapability): void {
  const status = profile.capabilities[capability];
  if (status !== 'supported') throw new CompatibilityError(profile.id, capability, status, profile.evidence);
}

/** Preserve meaningful evidence exactly while keeping an absent identifier nullable. */
export function compatibilityEvidenceId(evidence: unknown): string | null {
  return typeof evidence === 'string' && evidence.trim().length > 0 ? evidence : null;
}
