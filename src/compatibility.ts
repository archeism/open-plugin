import type { ConsumerProfile } from './consumer-profiles';

export type CompatibilityStatus = 'supported' | 'unsupported' | 'unverified';
export type ConsumerCapability = 'install' | 'update' | 'commandProjection' | 'userOnlySkills';

/** A target-specific refusal that callers render as a typed lifecycle reason. */
export class CompatibilityError extends Error {
  constructor(
    readonly target: string,
    readonly capability: ConsumerCapability,
    readonly status: Extract<CompatibilityStatus, 'unsupported' | 'unverified'>,
    readonly evidence: string,
  ) {
    super(`target '${target}' is ${status} for ${capability}; evidence: ${evidence}`);
    this.name = 'CompatibilityError';
  }
}

export function requireCompatible(profile: ConsumerProfile, capability: ConsumerCapability): void {
  const status = profile.capabilities[capability];
  if (status !== 'supported') throw new CompatibilityError(profile.id, capability, status, profile.evidence);
}

/** Preserve meaningful evidence exactly while keeping an absent identifier nullable. */
export function compatibilityEvidenceId(evidence: unknown): string | null {
  return typeof evidence === 'string' && evidence.trim().length > 0 ? evidence : null;
}
