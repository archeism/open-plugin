import { CompatibilityError, type ConsumerCapability } from './compatibility';
import { createLifecycleReason, type LifecycleReason } from './lifecycle-report';
import {
  PACKAGE_SEMANTICS,
  requiredSemanticsForOperation,
  type CapabilityOperation,
  type PackageSemantic,
  type PackageSemanticInventory,
  type SourceType,
} from './semantic-inventory';

declare const Bun: { CryptoHasher: new (algorithm: string) => { update(value: string): void; digest(format: 'hex'): string } };

export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';
export type CapabilityRoute = 'managed' | 'native';

export interface CapabilityEvidenceProfile {
  schemaVersion: 1;
  /** Content address of this credential-free evidence claim. */
  evidenceId: string;
  host: string;
  detectedVersion: string;
  sourceTypes: readonly SourceType[];
  operations: readonly CapabilityOperation[];
  route: CapabilityRoute;
  operationStatus: CapabilityStatus;
  semantics: Readonly<Record<PackageSemantic, CapabilityStatus>>;
  /** Repository-relative evidence references only; no locators or credentials. */
  evidence: readonly string[];
}

export type PackageAdmission = {
  status: 'admitted' | 'refused';
  profile: CapabilityEvidenceProfile | null;
  requirements: readonly PackageSemantic[];
  gaps: Array<Extract<LifecycleReason, { category: 'capability' }>>;
};

export interface PackageAdmissionRequest {
  host: string;
  detectedVersion?: string;
  sourceType: SourceType;
  operation: CapabilityOperation;
  route: CapabilityRoute;
  inventory: PackageSemanticInventory;
}

/** Legacy writer bridge; planners consume PackageAdmission directly. */
export class PackageCapabilityError extends CompatibilityError {
  readonly gaps: PackageAdmission['gaps'];

  constructor(target: string, admission: PackageAdmission) {
    const gap = admission.gaps[0];
    if (gap === undefined) throw new Error('cannot construct a package capability error without a gap');
    super(
      target,
      gap.capabilityId as ConsumerCapability,
      gap.code === 'capability.unsupported' ? 'unsupported' : 'unverified',
      gap.evidenceId ?? '',
      gap.diagnostic,
    );
    this.name = 'PackageCapabilityError';
    this.gaps = admission.gaps;
  }
}

const dcode0183Managed = defineProfile({
  host: 'dcode',
  detectedVersion: '0.1.83',
  sourceTypes: ['local', 'git'],
  operations: ['install', 'update', 'retire'],
  route: 'managed',
  operationStatus: 'supported',
  semantics: {
    'ordinary-skills': 'supported',
    mcp: 'supported',
    hooks: 'supported',
    commands: 'unsupported',
    agents: 'unsupported',
    'model-invocation-control': 'unsupported',
    'user-invocation-control': 'unsupported',
    'auto-update-control': 'supported',
    resources: 'supported',
    'permissions-preprocessing': 'unsupported',
    readback: 'supported',
    rollback: 'supported',
    'activation-reload': 'supported',
  },
  evidence: [
    'docs/evidence/dcode-native-update-0.1.83-20261009.json',
    'docs/research/dcode-session-findings-2026-10-09.md',
  ],
});

export const capabilityEvidenceProfiles: readonly CapabilityEvidenceProfile[] = Object.freeze([
  dcode0183Managed,
]);

/**
 * Admit the package as one unit. Individual gaps are diagnostic detail only;
 * this function never admits a supported subset of a refused package.
 */
export function admitPackageSemantics(request: PackageAdmissionRequest): PackageAdmission {
  const requirements = requiredSemanticsForOperation(request.inventory, request.operation);
  const version = normalizedDetectedVersion(request.detectedVersion);
  const profile = version === undefined ? undefined : capabilityEvidenceProfiles.find((candidate) =>
    candidate.host === request.host
    && candidate.detectedVersion === version
    && candidate.sourceTypes.includes(request.sourceType)
    && candidate.operations.includes(request.operation)
    && candidate.route === request.route);

  if (profile === undefined) {
    const displayVersion = version ?? 'unknown/unparseable';
    return {
      status: 'refused',
      profile: null,
      requirements,
      gaps: [createLifecycleReason(
        'capability',
        'capability.unverified',
        `target '${request.host}' has no verified ${request.route} ${request.operation} profile for version '${displayVersion}' and ${request.sourceType} Sources`,
        'profile',
        null,
      )],
    };
  }

  if (profile.operationStatus !== 'supported') {
    return {
      status: 'refused',
      profile,
      requirements,
      gaps: [capabilityReason(
        profile.operationStatus,
        `operation.${request.operation}`,
        profile,
        `target '${request.host}' ${profile.detectedVersion} ${profile.route} ${request.operation} is ${profile.operationStatus}`,
      )],
    };
  }

  const gaps = requirements.flatMap((semantic) => {
    const status = profile.semantics[semantic];
    return status === 'supported'
      ? []
      : [capabilityReason(
          status,
          semantic,
          profile,
          `target '${request.host}' ${profile.detectedVersion} ${profile.route} ${request.operation} is ${status} for ${semantic}`,
        )];
  });
  return {
    status: gaps.length === 0 ? 'admitted' : 'refused',
    profile,
    requirements,
    gaps,
  };
}

export function requirePackageSemantics(request: PackageAdmissionRequest): PackageAdmission {
  const admission = admitPackageSemantics(request);
  if (admission.status === 'refused') throw new PackageCapabilityError(request.host, admission);
  return admission;
}

function capabilityReason(
  status: Exclude<CapabilityStatus, 'supported'>,
  capabilityId: string,
  profile: CapabilityEvidenceProfile,
  diagnostic: string,
): Extract<LifecycleReason, { category: 'capability' }> {
  return createLifecycleReason(
    'capability',
    status === 'unsupported' ? 'capability.unsupported' : 'capability.unverified',
    diagnostic,
    capabilityId,
    profile.evidenceId,
  );
}

function defineProfile(input: Omit<CapabilityEvidenceProfile, 'schemaVersion' | 'evidenceId'>): CapabilityEvidenceProfile {
  const sourceTypes = [...input.sourceTypes].sort();
  const operations = [...input.operations].sort();
  const evidence = [...input.evidence].sort();
  if (sourceTypes.length === 0 || operations.length === 0 || evidence.length === 0) throw new Error('capability evidence profile needs source types, operations, and evidence');
  for (const reference of evidence) {
    if (!reference.startsWith('docs/') || reference.includes('@') || /[\u0000-\u001f\u007f-\u009f]/u.test(reference)) {
      throw new Error('capability evidence references must be credential-free repository paths');
    }
  }
  for (const semantic of PACKAGE_SEMANTICS) {
    if (input.semantics[semantic] === undefined) throw new Error(`capability evidence profile is missing ${semantic}`);
  }
  const addressable = {
    schemaVersion: 1,
    host: input.host,
    detectedVersion: input.detectedVersion,
    sourceTypes,
    operations,
    route: input.route,
    operationStatus: input.operationStatus,
    semantics: PACKAGE_SEMANTICS.map((semantic) => [semantic, input.semantics[semantic]]),
    evidence,
  };
  const hash = new Bun.CryptoHasher('sha256');
  hash.update(JSON.stringify(addressable));
  const evidenceId = `sha256:${hash.digest('hex')}`;
  return Object.freeze({
    schemaVersion: 1,
    evidenceId,
    host: input.host,
    detectedVersion: input.detectedVersion,
    sourceTypes: Object.freeze(sourceTypes),
    operations: Object.freeze(operations),
    route: input.route,
    operationStatus: input.operationStatus,
    semantics: Object.freeze({ ...input.semantics }),
    evidence: Object.freeze(evidence),
  });
}

function normalizedDetectedVersion(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || value.trim() !== value || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return undefined;
  return value;
}
