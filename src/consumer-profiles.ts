/**
 * Native plugin migration inventory plus retired standalone cleanup routes from
 * SPEC.md § Compatibility and lifecycle requirements. Profiles describe
 * evidence; they do not make an adapter active.
 */
import type { CompatibilityStatus, ConsumerOperationCapability } from './compatibility';
import { capabilityEvidenceProfiles } from './capability-evidence';

export const targetIds = [
  'claude-code', 'codex', 'omp', 'dcode', 'hermes', 'openclaw', 'grok', 'kimi',
  'zcode-cli', 'zcode-desktop', 'cursor', 'opencode', 'pi', 'gemini-cli',
  'factory', 'grokbot',
] as const;

export type TargetId = typeof targetIds[number];

export interface ConsumerProfile {
  id: TargetId;
  scope: 'native-plugin' | 'excluded-standalone';
  surface: string;
  /** Observed version when known; otherwise evidence has not established one. */
  version: string | 'unverified';
  evidence: string;
  capabilityEvidenceIds: readonly string[];
  /** Legacy verb admission only; package semantics use versioned capability evidence. */
  capabilities: Readonly<Record<ConsumerOperationCapability, CompatibilityStatus>>;
}

const active: Record<ConsumerOperationCapability, CompatibilityStatus> = {
  install: 'supported',
  update: 'supported',
};

const pending = (id: TargetId, surface: string, evidence: string, version: ConsumerProfile['version'] = 'unverified'): ConsumerProfile => ({
  id,
  scope: 'native-plugin',
  surface,
  version,
  evidence,
  capabilityEvidenceIds: [],
  capabilities: { install: 'unverified', update: 'unverified' },
});

function profile(id: TargetId, surface: string, evidence: string, version: ConsumerProfile['version'], capabilities: ConsumerProfile['capabilities']): ConsumerProfile {
  return {
    id,
    scope: 'native-plugin',
    surface,
    version,
    evidence,
    capabilityEvidenceIds: capabilityEvidenceProfiles
      .filter((candidate) => candidate.host === id && candidate.detectedVersion === version)
      .map(({ evidenceId }) => evidenceId),
    capabilities,
  };
}

function excludedStandalone(id: TargetId, surface: string, evidence: string, version: ConsumerProfile['version'] = 'unverified'): ConsumerProfile {
  return {
    id, scope: 'excluded-standalone', surface, version, evidence, capabilityEvidenceIds: [],
    capabilities: { install: 'unsupported', update: 'unsupported' },
  };
}

/** Native plugin routes, with legacy standalone profiles retained only for safe read/remove cleanup. */
export const consumerProfiles: readonly ConsumerProfile[] = [
  profile('claude-code', 'Claude Code plugin loader', 'docs/hosts/claude-code.md', '2.1.275', active),
  profile('codex', 'Codex plugin loader', 'docs/evidence/codex-personal-20260922.json', '0.153.4', active),
  profile('omp', 'OMP native npm/link extension-package loader', 'docs/evidence/omp-native-extension-package-20260923.json', '18.1.4', active),
  profile('dcode', 'deepagents-code plugin loader', 'docs/evidence/dcode-native-update-0.1.83-20261009.json', '0.1.83', active),
  profile('hermes', 'Hermes portable + native directory plugin loaders', 'docs/hosts/hermes.md', 'c0d7294', active),
  pending('openclaw', 'OpenClaw plugin route', 'SPEC.md § Compatibility and lifecycle requirements'),
  profile('grok', 'Grok Build native marketplace loader', 'docs/hosts/grok.md (isolated native lifecycle probe, 2026-09-23)', '1.0.41', active),
  profile('kimi', 'Kimi Code plugin loader', 'docs/hosts/kimi.md (isolated native probe, 2026-09-22)', '2.0.1', active),
  profile('zcode-cli', 'Official Z.ai ZCode CLI plugin loader', 'docs/evidence/zcode-official-cli-872ad960-20260923.json', '0.16.9', active),
  pending('zcode-desktop', 'Z.ai ZCode desktop plugin route', 'SPEC.md § Compatibility and lifecycle requirements'),
  profile('cursor', 'Cursor local plugin loader', 'docs/hosts/cursor.md', '2026.09.18-9a7762b', active),
  excludedStandalone('opencode', 'OpenCode standalone skill and command loaders', 'docs/evidence/opencode-native-loader-20260922.json', '1.15.13'),
  excludedStandalone('pi', 'Pi standalone skill loader', 'docs/evidence/pi-native-loader-20260922.json', '0.80.10'),
  pending('gemini-cli', 'Gemini CLI native plugin-extension route', 'SPEC.md § Compatibility and lifecycle requirements (native extension semantics unverified)'),
  excludedStandalone('factory', 'Factory standalone skill route', 'docs/hosts/factory.md'),
  excludedStandalone('grokbot', 'Grok Bot standalone skill route', 'docs/hosts/grokbot.md'),
];

const byId = new Map(consumerProfiles.map((entry) => [entry.id, entry]));

export function findConsumerProfile(id: string): ConsumerProfile | undefined {
  return byId.get(id as TargetId);
}
