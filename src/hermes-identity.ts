import { CryptoHasher } from './runtime';

export const HERMES_PORTABLE_SURFACE_VERSION = 'c0d7294769';
export const HERMES_PORTABLE_SURFACE_PROBE = 'hermes-portable-c0d7294769';

/** Collision-resistant sibling id for a generated Hermes command companion. */
export function hermesCommandCompanionId(pluginId: string): string {
  return `${pluginId}.plgnz-commands`;
}

export const HERMES_NATIVE_UPDATE_GATES = [
  'pinned-sha',
  'noninteractive-consent',
  'noninteractive-dependency',
  'synchronous-receipt',
  'rollback',
  'readback',
] as const;

export type HermesNativeUpdateGate = (typeof HERMES_NATIVE_UPDATE_GATES)[number];
export type HermesGateProof = 'proven' | 'unproven';
export type HermesNativeUpdateProof = Readonly<Record<HermesNativeUpdateGate, HermesGateProof>>;

export const hermesNativeUpdateProof: HermesNativeUpdateProof = {
  'pinned-sha': 'unproven',
  'noninteractive-consent': 'unproven',
  'noninteractive-dependency': 'unproven',
  'synchronous-receipt': 'unproven',
  'rollback': 'unproven',
  'readback': 'unproven',
};

export type HermesNativeUpdateDecision =
  | { readonly route: 'native' }
  | { readonly route: 'managed'; readonly refusedGate: HermesNativeUpdateGate };

export function decideHermesNativeUpdate(proof: HermesNativeUpdateProof): HermesNativeUpdateDecision {
  for (const gate of HERMES_NATIVE_UPDATE_GATES) {
    const status = proof[gate];
    switch (status) {
      case 'unproven':
        return { route: 'managed', refusedGate: gate };
      case 'proven':
        break;
      default: {
        const unreachable: never = status;
        return unreachable;
      }
    }
  }
  return { route: 'native' };
}

export function hermesPluginDataNamespace(pluginId: string): string {
  const slug = pluginId.toLowerCase().replace(/[^a-z0-9_-]/gu, '-').replace(/^[-_]+|[-_]+$/gu, '') || 'plugin';
  const hash = new CryptoHasher('sha256');
  hash.update(pluginId);
  return `agent-plugin-${slug}-${hash.digest('hex').slice(0, 8)}`;
}
