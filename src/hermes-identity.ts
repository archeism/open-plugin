/** Collision-resistant sibling id for a generated Hermes command companion. */
export function hermesCommandCompanionId(pluginId: string): string {
  return `${pluginId}.plgnz-commands`;
}

/** Whether Hermes native update has a proven pinned-SHA contract for this process. */
export type HermesPinnedShaProof = 'proven' | 'unproven';

/**
 * Native update stays managed until pinned-SHA behavior is proven.
 * A proven gate does not by itself select native.
 */
export type HermesPinnedShaDecision =
  | { readonly gate: 'pinned-sha'; readonly proof: 'unproven'; readonly route: 'managed' }
  | { readonly gate: 'pinned-sha'; readonly proof: 'proven' };

export function decideHermesPinnedSha(proof: HermesPinnedShaProof): HermesPinnedShaDecision {
  switch (proof) {
    case 'unproven':
      return { gate: 'pinned-sha', proof, route: 'managed' };
    case 'proven':
      return { gate: 'pinned-sha', proof };
    default: {
      const unreachable: never = proof;
      return unreachable;
    }
  }
}
