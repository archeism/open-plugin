import { CompatibilityError, type ConsumerCapability } from './compatibility';
import { createLifecycleReason, type LifecycleReason } from './lifecycle-report';
import {
  PACKAGE_SEMANTICS,
  requiredSemanticsForOperation,
  type CapabilityOperation,
  type HookDeclarationForm,
  type PackageSemantic,
  type PackageSemanticInventory,
  type SourceType,
} from './semantic-inventory';

declare const Bun: { CryptoHasher: new (algorithm: string) => { update(value: string): void; digest(format: 'hex'): string } };

export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';
export type CapabilityRoute = 'managed' | 'native';

export interface HookCapabilityEvidence {
  /** Native manifest selection order; generic inventory does not assign this precedence. */
  manifestPrecedence: readonly string[];
  supportedForms: readonly HookDeclarationForm[];
  supportedEvents: readonly string[];
  supportedHandlerTypes: readonly string[];
}

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
  hookPolicy: HookCapabilityEvidence | null;
  /** Repository-relative evidence references only; no locators or credentials. */
  evidence: readonly string[];
}

export type PackageAdmission = {
  status: 'admitted' | 'refused';
  profile: CapabilityEvidenceProfile | null;
  requirements: readonly PackageSemantic[];
  gaps: Array<Extract<LifecycleReason, { category: 'capability' }>>;
};

interface PackageAdmissionRequestBase {
  host: string;
  detectedVersion?: string;
  sourceType: SourceType;
  route: CapabilityRoute;
}

export type PackageAdmissionRequest =
  | (PackageAdmissionRequestBase & {
      operation: 'install' | 'update';
      inventory: PackageSemanticInventory;
    })
  | (PackageAdmissionRequestBase & {
      operation: 'disable';
      /** Disablement is authorized from a recorded owned activation, never Source bytes. */
      inventory?: never;
    })
  | (PackageAdmissionRequestBase & {
      operation: 'retire';
      /** Retirement is authorized from recorded activation state when Source is unavailable. */
      inventory?: PackageSemanticInventory;
    });

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

const dcode0183Managed = createCapabilityEvidenceProfile({
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
    retirement: 'supported',
    'retention-safety': 'supported',
    readback: 'supported',
    rollback: 'supported',
    'activation-reload': 'supported',
    'reversible-disable': 'unverified',
  },
  hookPolicy: {
    manifestPrecedence: ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'],
    supportedForms: [
      'default-file',
      'manifest-file',
      'manifest-directory',
      'manifest-inline-event-map',
      'manifest-inline-wrapped',
    ],
    supportedEvents: [
      'SessionStart',
      'UserPromptSubmit',
      'SessionEnd',
      'PermissionRequest',
      'Notification',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PreCompact',
      'Stop',
      'SubagentStart',
      'SubagentStop',
    ],
    supportedHandlerTypes: ['command'],
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
  return admitPackageSemanticsFromProfiles(request, capabilityEvidenceProfiles);
}

/** Pure evidence lookup used by the lifecycle route selector with its frozen profile set. */
export function admitPackageSemanticsFromProfiles(
  request: PackageAdmissionRequest,
  profiles: readonly CapabilityEvidenceProfile[],
): PackageAdmission {
  const requirements = request.operation === 'retire'
    ? requiredSemanticsForOperation(request.inventory, 'retire')
    : request.operation === 'disable'
      ? requiredSemanticsForOperation(undefined, 'disable')
      : requiredSemanticsForOperation(request.inventory, request.operation);
  const version = normalizedDetectedVersion(request.detectedVersion);
  const matching = version === undefined ? [] : profiles.filter((candidate) =>
    candidate.host === request.host
    && candidate.detectedVersion === version
    && candidate.sourceTypes.includes(request.sourceType)
    && candidate.operations.includes(request.operation)
    && candidate.route === request.route);
  if (matching.length > 1) {
    throw new Error(`ambiguous capability evidence for ${request.host} ${version} ${request.sourceType} ${request.route} ${request.operation}`);
  }
  const profile = matching[0];

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
    const hookProblem = semantic === 'hooks' && (request.operation === 'install' || request.operation === 'update')
      ? unsupportedHookDeclaration(request.inventory, profile.hookPolicy)
      : null;
    const status = profile.semantics[semantic] === 'supported' && hookProblem !== null
      ? 'unverified'
      : profile.semantics[semantic];
    return status === 'supported'
      ? []
      : [capabilityReason(
          status,
          semantic,
          profile,
          hookProblem ?? `target '${request.host}' ${profile.detectedVersion} ${profile.route} ${request.operation} is ${status} for ${semantic}`,
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

export function createCapabilityEvidenceProfile(
  input: Omit<CapabilityEvidenceProfile, 'schemaVersion' | 'evidenceId' | 'hookPolicy'> & {
    hookPolicy?: HookCapabilityEvidence | null;
  },
): CapabilityEvidenceProfile {
  const sourceTypes = [...input.sourceTypes].sort();
  const operations = [...input.operations].sort();
  const evidence = [...input.evidence].sort();
  const hookPolicy = normalizeHookPolicy(input.hookPolicy ?? null);
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
    hookPolicy,
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
    hookPolicy,
    evidence: Object.freeze(evidence),
  });
}

function unsupportedHookDeclaration(
  inventory: PackageSemanticInventory,
  policy: HookCapabilityEvidence | null,
): string | null {
  if (policy === null) return 'target profile has no evidence for authored hook declaration dialects';
  if (inventory.hookDeclarations.length === 0) return 'authored hook components have no validated declarations';
  const selectedManifest = policy.manifestPrecedence.find((path) => inventory.manifestPaths.includes(path));
  const supportedSources = new Set<string>();
  const supported = inventory.hookDeclarations.map((declaration) => {
    const effective = declaration.manifestPath === null || declaration.manifestPath === selectedManifest;
    const compatible = effective
      && policy.supportedForms.includes(declaration.form)
      && declaration.events.every((event) => policy.supportedEvents.includes(event))
      && declaration.handlerTypes.every((type) => policy.supportedHandlerTypes.includes(type));
    if (compatible) supportedSources.add(declaration.source);
    return compatible;
  });
  const unsupported = inventory.hookDeclarations.find((declaration, index) =>
    supported[index] !== true && !supportedSources.has(declaration.source));
  if (unsupported === undefined) return null;
  return `target hook profile cannot prove '${unsupported.source}' (${unsupported.form}) under selected manifest '${selectedManifest ?? 'none'}'`;
}

function normalizeHookPolicy(input: HookCapabilityEvidence | null): HookCapabilityEvidence | null {
  if (input === null) return null;
  const manifestPrecedence = uniqueStrings(input.manifestPrecedence, 'hook manifest precedence');
  const supportedForms = uniqueStrings(input.supportedForms, 'hook declaration form').sort() as HookDeclarationForm[];
  const supportedEvents = uniqueStrings(input.supportedEvents, 'hook event').sort();
  const supportedHandlerTypes = uniqueStrings(input.supportedHandlerTypes, 'hook handler type').sort();
  return Object.freeze({
    manifestPrecedence: Object.freeze(manifestPrecedence),
    supportedForms: Object.freeze(supportedForms),
    supportedEvents: Object.freeze(supportedEvents),
    supportedHandlerTypes: Object.freeze(supportedHandlerTypes),
  });
}

function uniqueStrings(input: readonly string[], label: string): string[] {
  if (input.length === 0 || input.some((value) => value.trim() === '' || value.trim() !== value)) {
    throw new Error(`${label} evidence must contain non-empty canonical strings`);
  }
  if (new Set(input).size !== input.length) throw new Error(`${label} evidence must not contain duplicates`);
  return [...input];
}

function normalizedDetectedVersion(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || value.trim() !== value || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return undefined;
  return value;
}
