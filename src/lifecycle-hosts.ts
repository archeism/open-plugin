import type { LifecycleHostAdapter } from './lifecycle-host';
import { createLifecycleHostAdapter } from './lifecycle-runtime';
import type { PlannerHost } from './planner';
import type { PluginSource } from './source';
import { createClaudeCodeLifecycleHost, claudeCodeWriter } from './hosts/claude-code-writer';
import { codexLifecycle, codexWriter } from './hosts/codex-writer';
import { cursorManagedLifecycle, cursorWriter } from './hosts/cursor-writer';
import { createGrokLifecycleAdapter, grokWriter } from './hosts/grok-writer';
import { hermesLifecycle, hermesWriter } from './hosts/hermes-writer';
import { kimiLifecycle, kimiWriter } from './hosts/kimi-writer';
import { ompLifecycle, ompWriter } from './hosts/omp-writer';
import { zcodeCliLifecycle, zcodeCliWriter } from './hosts/zcode-cli-writer';

function plannerHost(
  kind: string,
  adapter: LifecycleHostAdapter,
  plannedNativeId: (plugin: PluginSource) => string,
): PlannerHost {
  return { kinds: [kind], adapter, plannedNativeId };
}

export const lifecyclePlannerHosts: readonly PlannerHost[] = [
  plannerHost('claude-code', createClaudeCodeLifecycleHost(), claudeCodeWriter.plannedNativeId),
  plannerHost('codex', codexLifecycle, codexWriter.plannedNativeId),
  plannerHost('kimi', createLifecycleHostAdapter(kimiLifecycle), kimiWriter.plannedNativeId),
  plannerHost('cursor', cursorManagedLifecycle, cursorWriter.plannedNativeId),
  plannerHost('omp', ompLifecycle, ompWriter.plannedNativeId),
  plannerHost('hermes', hermesLifecycle, hermesWriter.plannedNativeId),
  plannerHost('grok', createGrokLifecycleAdapter(), grokWriter.plannedNativeId),
  plannerHost('zcode-cli', zcodeCliLifecycle, zcodeCliWriter.plannedNativeId),
];
