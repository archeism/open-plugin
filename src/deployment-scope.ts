import { isAbsolute, resolve } from 'node:path';
import type { SourceBinding } from './source-reference';

declare const Bun: {
  CryptoHasher: new (algorithm: 'sha256') => {
    update(input: string | Uint8Array): void;
    digest(encoding: 'hex'): string;
  };
};

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
  const hash = new Bun.CryptoHasher('sha256');
  const encoder = new TextEncoder();
  for (const field of fields) frame(hash, encoder.encode(field));
  return {
    id: `scope-v1-${hash.digest('hex')}`,
    source: { ...source },
    target: { ...target },
  };
}

function validateSourceBinding(source: SourceBinding): void {
  validateIdentityField(source.locator, 'Source locator');
  if (source.kind === 'local') {
    if (!isAbsolute(source.locator) || resolve(source.locator) !== source.locator) throw new Error('Local Source locator must be a canonical absolute path');
    return;
  }
  validateIdentityField(source.ref, 'Source ref');
  if (source.locator.startsWith('http://') || source.locator.startsWith('https://')) {
    const locator = new URL(source.locator);
    if (locator.username !== '' || locator.password !== '' || locator.search !== '' || locator.hash !== '') {
      throw new Error('Deployment scope Source binding must be credential-free');
    }
  }
}

function validateIdentityField(value: string, label: string): void {
  if (value === '' || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Deployment scope ${label} must be a non-empty stable value`);
}

function frame(hash: InstanceType<typeof Bun.CryptoHasher>, bytes: Uint8Array): void {
  hash.update(new Uint8Array([bytes.byteLength >>> 24, bytes.byteLength >>> 16, bytes.byteLength >>> 8, bytes.byteLength]));
  hash.update(bytes);
}
