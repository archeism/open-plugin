import { validateSourceBinding, validateStableIdentityString, type SourceBinding } from './source-reference';

import { CryptoHasher } from './runtime';

export { validateSourceBinding } from './source-reference';


declare const TextEncoder: {
  new (): { encode(input?: string): Uint8Array };
};

export interface TargetIdentity {
  kind: string;
  instance: string;
}

export interface DeploymentScopeIdentity {
  id: string;
  source: SourceBinding;
  target: TargetIdentity;
}

/** Stable scope identity; immutable Source revision is deliberately not part of this key. */
export function createDeploymentScopeIdentity(source: SourceBinding, target: TargetIdentity): DeploymentScopeIdentity {
  validateSourceBinding(source);
  validateIdentityField(target.kind, 'target kind');
  validateIdentityField(target.instance, 'target instance');
  const fields = [
    'deployment-scope-v1',
    source.kind,
    source.locator,
    source.kind === 'git' ? source.ref : '',
    target.kind,
    target.instance,
  ];
  const hash = new CryptoHasher('sha256');
  const encoder = new TextEncoder();
  for (const field of fields) frame(hash, encoder.encode(field));
  return {
    id: `scope-v1-${hash.digest('hex')}`,
    source: { ...source },
    target: { ...target },
  };
}

function validateIdentityField(value: string, label: string): void {
  validateStableIdentityString(value, `Deployment scope ${label}`);
}

function frame(hash: CryptoHasher, bytes: Uint8Array): void {
  hash.update(new Uint8Array([bytes.byteLength >>> 24, bytes.byteLength >>> 16, bytes.byteLength >>> 8, bytes.byteLength]));
  hash.update(bytes);
}
