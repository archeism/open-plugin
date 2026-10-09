/**
 * Host registry — readers only.
 *
 * doctor imports `hosts` from here, and doctor is read-only by construction
 * (AGENTS.md: it must not import any writer). A module is evaluated whole,
 * so honoring that at module granularity means writers cannot live in the
 * reader files: each host's writer is a sibling `<host>-writer.ts`, and the
 * writer list is aggregated in src/hosts/writers.ts — a module this index
 * never imports. test/doctor-imports.test.ts walks doctor's import graph and
 * fails if a writer creeps back into it.
 */
import type { HostReader } from '../host';
import type { TargetProfile } from '../target-profile';
import { claudeCode, claudeCodeTargetProfile } from './claude-code';
import { codex, codexTargetProfile } from './codex';
import { kimi, kimiTargetProfile } from './kimi';
import { cursor, cursorTargetProfile } from './cursor';
import { omp, ompTargetProfile } from './omp';
import { pi } from './pi';
import { dcode, dcodeTargetProfile } from './dcode';
import { opencode } from './opencode';
import { grok, grokTargetProfile } from './grok';
import { zcodeCli, zcodeCliTargetProfile } from './zcode-cli';
import { hermes, hermesTargetProfile } from './hermes';

export const hosts: HostReader[] = [claudeCode, codex, kimi, cursor, omp, hermes, pi, dcode, opencode, grok, zcodeCli];

/** Pure lifecycle target contracts for active native mutation routes. */
export const targetProfiles = [
  claudeCodeTargetProfile,
  codexTargetProfile,
  kimiTargetProfile,
  cursorTargetProfile,
  ompTargetProfile,
  dcodeTargetProfile,
  grokTargetProfile,
  zcodeCliTargetProfile,
  hermesTargetProfile,
] as const satisfies readonly TargetProfile[];
