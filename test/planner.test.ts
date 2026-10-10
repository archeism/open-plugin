import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitCodeForLifecycleReport } from '../src/lifecycle-report';
import { stateFile } from '../src/paths';
import { planLifecycle } from '../src/planner';
import { parseSyncManifest } from '../src/sync-manifest';
import { FakeLifecycleHost } from './fake-lifecycle-adapter';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('lifecycle planner', () => {
  test('a deterministic ownership defect in the last scope plans nothing and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-planner-'));
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(home);
    const alpha = writePlugin(join(root, 'sources'), 'alpha');
    const beta = writePlugin(join(root, 'sources'), 'beta');
    const codex = new FakeLifecycleHost(join(root, 'codex'), []);
    const cursor = new FakeLifecycleHost(join(root, 'cursor'), []);
    cursor.seedActivation({
      nativeId: 'beta',
      scopeId: 'foreign-scope',
      packageName: 'beta',
      files: { 'payload.txt': 'beta-bytes\n' },
    });
    const codexBefore = codex.hostMutationState();
    const cursorBefore = cursor.hostMutationState();
    const manifest = parseSyncManifest({
      schemaVersion: 1,
      entries: [
        { operation: 'sync', source: { kind: 'local', locator: alpha }, target: { kind: 'codex', instance: 'default' } },
        { operation: 'sync', source: { kind: 'local', locator: beta }, target: { kind: 'cursor', instance: 'default' } },
      ],
    });
    const previousHome = process.env['OPEN_PLUGIN_HOME'];
    process.env['OPEN_PLUGIN_HOME'] = home;
    try {
      expect(existsSync(stateFile())).toBe(false);
      const plan = await planLifecycle({
        manifest,
        dryRun: true,
        validatedAt: '2026-10-10T00:00:00.000Z',
        hosts: [
          { kinds: ['codex'], adapter: codex.adapter, plannedNativeId: (plugin) => plugin.name },
          { kinds: ['cursor'], adapter: cursor.adapter, plannedNativeId: (plugin) => plugin.name },
        ],
      });
      expect(plan.kind).toBe('zero-write-failure');
      if (plan.kind !== 'zero-write-failure') return;
      expect(plan.report.plan).toEqual([]);
      expect(plan.report.outcomes).toEqual([]);
      expect(plan.report.summary).toEqual({
        result: 'incomplete',
        terminalPhase: 'preflight',
        mutationStarted: false,
        changed: false,
        failureCategory: 'internal',
        reason: {
          category: 'internal',
          code: 'internal.ambiguous-ownership',
          diagnostic: "package 'beta' on cursor/default is owned by scope 'foreign-scope'",
          capabilityId: null,
          evidenceId: null,
        },
        recoveryId: null,
        readbackId: null,
      });
      expect(plan.report.command).toEqual({ name: 'sync', dryRun: true, sourceSnapshots: [] });
      expect(exitCodeForLifecycleReport(plan.report)).toBe(1);
      expect(existsSync(stateFile())).toBe(false);
      expect(codex.hostMutationState()).toBe(codexBefore);
      expect(cursor.hostMutationState()).toBe(cursorBefore);
      expect(codex.events).toContain('inventory');
      expect(cursor.events).toContain('inventory');
      expect(codex.events.some(mutatingEvent)).toBe(false);
      expect(cursor.events.some(mutatingEvent)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env['OPEN_PLUGIN_HOME'];
      else process.env['OPEN_PLUGIN_HOME'] = previousHome;
    }
  });
});

function mutatingEvent(event: string): boolean {
  return event === 'stage'
    || event === 'directives'
    || event === 'pins'
    || event === 'disable-prepare'
    || event === 'retire-prepare'
    || event.includes('apply')
    || event === 'disable'
    || event === 'retire';
}

function writePlugin(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'skills', 'a'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(join(dir, 'skills', 'a', 'SKILL.md'), '# skill\n');
  return realpathSync(dir);
}
