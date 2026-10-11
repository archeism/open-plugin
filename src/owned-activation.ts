import type { DeploymentScopeIdentity } from './deployment-scope';
import type { LifecycleTargetIdentity, RecordedOwnedActivation, TargetInstallationData } from './lifecycle-host';
import { createRecordedOwnedActivation } from './lifecycle-runtime';
import { CryptoHasher } from './runtime';
import type { SourceType } from './semantic-inventory';
import type { SourceBinding } from './source-reference';
import type { ActivationRecord, TombstoneRecord } from './state';

export function ownedActivation(
  scope: DeploymentScopeIdentity,
  source: SourceBinding,
  activation: ActivationRecord,
  installation: TargetInstallationData,
  target: LifecycleTargetIdentity,
): RecordedOwnedActivation | null {
  if ((activation.route.kind !== 'managed' && activation.route.kind !== 'native') || activation.ownership.kind === 'legacy-claim') return null;
  if (activation.sourceRevision === undefined || activation.fingerprints.installed === undefined || installation.installedFingerprint === null) return null;
  if (installation.contentRoots.length === 0) return null;
  const route = activation.route;
  const ownership = activation.ownership;
  try {
    return createRecordedOwnedActivation({
      scopeId: scope.id,
      target,
      packageName: activation.packageId,
      nativeId: activation.nativeId,
      sourceType: sourceTypeOf(source),
      sourceRevision: activation.sourceRevision,
      sourceLocator: source.kind === 'git' ? source.locator : null,
      installedVersion: installation.installedVersion,
      route: route.kind,
      evidenceId: route.evidenceKey.key,
      ownership: { kind: ownership.kind, proofId: ownership.proofKey.key },
      activation: activation.activationState === 'nonconforming' ? 'nonconforming' : activation.activationState === 'active' ? 'active' : 'inactive',
      enablement: installation.enablement === 'enabled' ? 'enabled' : 'disabled',
      installedFingerprint: installation.installedFingerprint,
      contentRoots: installation.contentRoots,
    });
  } catch {
    return null;
  }
}

export function retirementTombstone(activation: ActivationRecord, retiredAt: string): TombstoneRecord | null {
  if (activation.route.kind !== 'managed' && activation.route.kind !== 'native') return null;
  if (activation.ownership.kind !== 'created' && activation.ownership.kind !== 'adopted') return null;
  if (activation.sourceRevision === undefined) return null;
  const source = activation.fingerprints.source;
  const projected = activation.fingerprints.projected;
  const installed = activation.fingerprints.installed;
  if (source === undefined || projected === undefined || installed === undefined) return null;
  const tombstone: TombstoneRecord = {
    id: `tombstone-v1-${contentAddress(`${activation.scopeId}\0${activation.packageId}\0${activation.nativeId}`).slice('sha256:'.length)}`,
    scopeId: activation.scopeId,
    packageId: activation.packageId,
    nativeId: activation.nativeId,
    ...(activation.sourceRelativeDir === undefined ? {} : { sourceRelativeDir: activation.sourceRelativeDir }),
    sourceRevision: activation.sourceRevision,
    route: activation.route,
    ownership: activation.ownership,
    fingerprints: { source, projected, installed },
    pins: activation.pins,
    retentionState: 'plugin-state-retained',
    ...(activation.activatedAt === undefined ? {} : { activatedAt: activation.activatedAt }),
    retiredAt,
  };
  return tombstone;
}

function sourceTypeOf(source: SourceBinding): SourceType {
  switch (source.kind) {
    case 'local':
    case 'git':
      return source.kind;
    default: {
      const unreachable: never = source;
      throw new Error(`unknown source ${String(unreachable)}`);
    }
  }
}

function contentAddress(value: string): string {
  const hash = new CryptoHasher('sha256');
  hash.update(value);
  return `sha256:${hash.digest('hex')}`;
}
