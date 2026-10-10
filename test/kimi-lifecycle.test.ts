import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintTree } from '../src/fingerprint';
import { kimiWriter, kimiLifecycle } from '../src/hosts/kimi-writer';
import { kimi } from '../src/hosts/kimi';
import {
  LifecycleHostPhaseError,
  createFrozenPackageSnapshot,
  createLifecycleHostAdapter,
  createLifecyclePlanCoverage,
  createRecordedOwnedActivation,
  createResolvedLifecyclePins,
} from '../src/lifecycle-runtime';
import { PACKAGE_SEMANTICS, type PackageSemanticInventory } from '../src/semantic-inventory';
import { type PluginSource, type ResolvedSource } from '../src/source';
import { writeFiles } from './util';
import { withKimiNative } from './kimi-fixture';

function fixture(): { root: string; home: string; plugin: PluginSource; resolved: ResolvedSource } {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-kimi-lifecycle-'));
  const source = join(root, 'source');
  writeFiles(source, {
    'plugin.json': '{"name":"demo","version":"1.0.0","description":"Demo"}',
    'mcp.json': '{"mcpServers":{"fixture":{"type":"stdio","command":"fixture-mcp"}}}',
    'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\n---\n\nBody\n',
  });
  const plugin: PluginSource = { dir: source, name: 'demo', contentFingerprint: 'one' };
  return { root, home: join(root, 'home'), plugin, resolved: { sourceUri: source, sha: 'same-source-revision', isGit: false, plugins: [plugin] } };
}

async function withKimi<T>(fn: (value: ReturnType<typeof fixture>) => Promise<T>): Promise<T> {
  const value = fixture(); const before = process.env.OPEN_PLUGIN_KIMI_ROOT;
  process.env.OPEN_PLUGIN_KIMI_ROOT = join(value.home, '.kimi-code');
  try { return await fn(value); } finally { if (before === undefined) delete process.env.OPEN_PLUGIN_KIMI_ROOT; else process.env.OPEN_PLUGIN_KIMI_ROOT = before; rmSync(value.root, { recursive: true, force: true }); }
}

describe('Kimi lifecycle preflight', () => {
  test('uses the isolated native loader for install, unchanged re-add, refresh, and rollback', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      await withKimiNative(home, async () => {
        writeFiles(plugin.dir, { '.kimi-plugin/plugin.json': '{"mcpServers":{"fixture":{"type":"stdio","command":"fixture-mcp"}}}' });
        await kimiWriter.add(plugin, resolved); const target = join(home, '.kimi-code', 'plugins', 'managed', 'demo'); expect(readFileSync(join(target, 'skills/ordinary/SKILL.md'), 'utf8')).toContain('Body');
        expect(JSON.parse(readFileSync(join(target, 'kimi.plugin.json'), 'utf8')).mcpServers.fixture.command).toBe('fixture-mcp');
        expect(await kimiWriter.add(plugin, resolved)).toBe('unchanged');
        writeFiles(plugin.dir, { 'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\n---\n\nChanged\n' }); plugin.contentFingerprint = 'two'; await kimiWriter.add(plugin, resolved); expect(readFileSync(join(target, 'skills/ordinary/SKILL.md'), 'utf8')).toContain('Changed');
        expect(readFileSync(join(target, '.plgnz-install.json'), 'utf8')).toContain('two');
        const registryBeforeFailure = readFileSync(join(home, '.kimi-code', 'plugins', 'installed.json'), 'utf8');
        writeFiles(plugin.dir, { 'skills/ordinary/SKILL.md': 'failed refresh' }); plugin.contentFingerprint = 'three'; process.env.KIMI_FAIL_ENABLE = '1'; let failure: Error | undefined; try { await kimiWriter.add(plugin, resolved); } catch (error) { failure = error as Error; } finally { delete process.env.KIMI_FAIL_ENABLE; }
        expect(failure?.message).toContain('forced enable failure'); expect(readFileSync(join(target, 'skills/ordinary/SKILL.md'), 'utf8')).toContain('Changed');
        expect(readFileSync(join(home, '.kimi-code', 'plugins', 'installed.json'), 'utf8')).toBe(registryBeforeFailure);
        expect(readdirSync(join(home, '.kimi-code', 'plugins')).some(name => name.startsWith('.plgnz-kimi-'))).toBe(false);
      });
    });
  });
  test('accepts the native registry canonicalizing an existing managed root', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      await withKimiNative(home, async () => {
        process.env.KIMI_CANONICALIZE_ROOT = '1';
        try {
          await kimiWriter.add(plugin, resolved);
          expect(existsSync(join(home, '.kimi-code', 'plugins', 'managed', 'demo'))).toBe(true);
        } finally {
          delete process.env.KIMI_CANONICALIZE_ROOT;
        }
      });
    });
  });
  test('maps a marketplace package between its logical id and Kimi bare native id', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      await withKimiNative(home, async () => {
        plugin.marketplace = 'catalog';
        await kimiWriter.add(plugin, resolved);
        expect(kimi.listInstalled().map(installed => installed.id)).toEqual(['demo@catalog']);
        const marker = join(home, '.kimi-code', 'plugins', 'managed', 'demo', '.plgnz-install.json');
        writeFileSync(marker, JSON.stringify({ source: resolved.sourceUri, pluginId: 'demo', fingerprint: 'one' }));
        expect(await kimiWriter.add(plugin, resolved)).toBeUndefined();
        expect(JSON.parse(readFileSync(marker, 'utf8')).pluginId).toBe('demo@catalog');
        expect(kimi.listInstalled().map(installed => installed.id)).toEqual(['demo@catalog']);
        plugin.contentFingerprint = 'two';
        await kimiWriter.add(plugin, resolved);
        expect(kimi.listInstalled().map(installed => installed.id)).toEqual(['demo@catalog']);
        writeFileSync(marker, JSON.stringify({ source: resolved.sourceUri, pluginId: 'other@catalog', fingerprint: 'two' }));
        expect(kimi.listInstalled().map(installed => installed.id)).toEqual(['demo']);
        writeFileSync(marker, JSON.stringify({ source: resolved.sourceUri, pluginId: 'demo', fingerprint: 'two' }));
        await kimiWriter.remove('demo@catalog', { source: resolved.sourceUri, legacyNativeIds: ['demo'] });
        expect(kimi.listInstalled()).toHaveLength(0);
        expect(existsSync(join(home, '.kimi-code', 'plugins', 'managed', 'demo'))).toBe(true);
      });
    });
  });
  test('stages ordinary skills before a dry-run without touching the native store', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      const result = await kimiWriter.add(plugin, resolved, { dryRun: true });
      expect(result).toBeUndefined();
      const root = join(home, '.kimi-code');
      expect(existsSync(join(root, 'plugins', 'managed', 'demo'))).toBe(false);
      expect(existsSync(join(root, 'plugins', 'installed.json'))).toBe(false);
      expect(existsSync(join(root, 'plugins'))).toBe(false);
    });
  });

  test('rejects unsupported native-specific behavior before any active write', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      writeFiles(plugin.dir, { 'kimi.plugin.json': '{"name":"demo","hooks":{}}' });
      let failure: Error | undefined;
      try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { failure = error as Error; }
      expect(failure?.message).toContain('unsupported Kimi native manifest field: hooks');
      expect(existsSync(join(home, '.kimi-code', 'plugins', 'managed', 'demo'))).toBe(false);
    });
  });

  test('rejects a legacy 0.x Kimi binary before native activation', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      const legacy = join(home, 'legacy-kimi'); mkdirSync(home, { recursive: true }); writeFileSync(legacy, '#!/bin/sh\necho 0.16.0\n'); chmodSync(legacy, 0o755);
      const before = process.env.OPEN_PLUGIN_KIMI_BIN; process.env.OPEN_PLUGIN_KIMI_BIN = legacy;
      let failure: Error | undefined;
      try { await kimiWriter.add(plugin, resolved); } catch (error) { failure = error as Error; }
      finally { if (before === undefined) delete process.env.OPEN_PLUGIN_KIMI_BIN; else process.env.OPEN_PLUGIN_KIMI_BIN = before; }
      expect(failure?.message).toContain('legacy or unsupported binary');
      expect(existsSync(join(home, '.kimi-code', 'plugins', 'managed', 'demo'))).toBe(false);
      expect(existsSync(join(home, '.kimi-code', 'plugins', 'installed.json'))).toBe(false);
    });
  });

  test('converts a valid TOML command set to Markdown; invalid TOML is refused, not dropped', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      writeFiles(plugin.dir, { 'commands/only.toml': 'description = "unsupported"\n' });
      let failure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { failure = error as Error; }
      expect(failure?.message).toContain('description and prompt');
      expect(existsSync(join(home, '.kimi-code', 'plugins', 'managed', 'demo'))).toBe(false);
      writeFiles(plugin.dir, { 'commands/only.toml': 'description = "Runs the demo"\nprompt = "Run the demo."\n' });
      expect(await kimiWriter.add(plugin, resolved, { dryRun: true })).toBeUndefined();
      expect(existsSync(join(home, '.kimi-code', 'plugins', 'managed', 'demo'))).toBe(false);
    });
  });

  test('uses native Markdown commands and manual-skill exclusion while refusing unsupported user-invocable policy', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      writeFiles(plugin.dir, { 'commands/run.md': '---\ndescription: Run\n---\n$ARGUMENTS\n' });
      expect(await kimiWriter.add(plugin, resolved, { dryRun: true })).toBeUndefined();
      rmSync(join(plugin.dir, 'commands'), { recursive: true });
      writeFiles(plugin.dir, { 'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\ndisable-model-invocation: true\n---\nBody\n' });
      expect(await kimiWriter.add(plugin, resolved, { dryRun: true })).toBeUndefined();
      writeFiles(plugin.dir, { 'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\n"disable-model-invocation": true\n---\nBody\n' });
      expect(await kimiWriter.add(plugin, resolved, { dryRun: true })).toBeUndefined();
      writeFiles(plugin.dir, { 'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\n---\nThe text disable-model-invocation: true is body text.\n' });
      expect(await kimiWriter.add(plugin, resolved, { dryRun: true })).toBeUndefined();
      writeFiles(plugin.dir, { 'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\nuser-invocable: false\n---\nBody\n' });
      let policyFailure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { policyFailure = error as Error; }
      expect(policyFailure?.message).toContain('does not support user-invocable skill policy');
      expect(existsSync(join(home, '.kimi-code', 'plugins', 'managed', 'demo'))).toBe(false);
    });
  });

  test('honors an explicit native commands pointer when both supported command trees exist', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      await withKimiNative(home, async () => {
        writeFiles(plugin.dir, {
          'commands/root.md': '---\ndescription: Root\n---\n$ARGUMENTS\n',
          '.claude/commands/claude.md': '---\ndescription: Claude\n---\n$ARGUMENTS\n',
          'kimi.plugin.json': '{"name":"demo","commands":"./commands/"}',
        });
        await kimiWriter.add(plugin, resolved);
        const target = join(home, '.kimi-code', 'plugins', 'managed', 'demo');
        expect(JSON.parse(readFileSync(join(target, 'kimi.plugin.json'), 'utf8')).commands).toBe('./commands/');
        expect(existsSync(join(target, 'commands/root.md'))).toBe(true);
        expect(existsSync(join(target, '.claude/commands/claude.md'))).toBe(true);
      });
    });
  });

  test('rejects the chosen .claude command tree even when a valid root tree also exists', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      writeFiles(plugin.dir, {
        'commands/root.md': '---\ndescription: Root\n---\n$ARGUMENTS\n',
        '.claude/commands/invalid.md': '---\ndescription: Invalid\nallowed-tools: Bash\n---\nBody\n',
      });
      let failure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { failure = error as Error; }
      expect(failure?.message).toContain('Kimi command metadata is unsupported: allowed-tools');
      expect(existsSync(join(home, '.kimi-code', 'plugins', 'managed', 'demo'))).toBe(false);
    });
  });

  test('refuses unsupported command metadata and preprocessing without replacing an active plugin', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      await withKimiNative(home, async () => {
        await kimiWriter.add(plugin, resolved);
        const target = join(home, '.kimi-code', 'plugins', 'managed', 'demo');
        const before = readFileSync(join(target, 'skills/ordinary/SKILL.md'), 'utf8');
        writeFiles(plugin.dir, { 'commands/invalid.md': '---\ndescription: Invalid\nmodel: fast\n---\nBody\n' }); plugin.contentFingerprint = 'metadata';
        let metadataFailure: Error | undefined; try { await kimiWriter.add(plugin, resolved); } catch (error) { metadataFailure = error as Error; }
        expect(metadataFailure?.message).toContain('Kimi command metadata is unsupported: model');
        expect(readFileSync(join(target, 'skills/ordinary/SKILL.md'), 'utf8')).toBe(before);
        rmSync(join(plugin.dir, 'commands'), { recursive: true });
        writeFiles(plugin.dir, { 'commands/preprocess.md': '---\ndescription: Invalid\n---\n!`date`\n' }); plugin.contentFingerprint = 'preprocess';
        let preprocessingFailure: Error | undefined; try { await kimiWriter.add(plugin, resolved); } catch (error) { preprocessingFailure = error as Error; }
        expect(preprocessingFailure?.message).toContain('Kimi command preprocessing is unsupported');
        expect(readFileSync(join(target, 'skills/ordinary/SKILL.md'), 'utf8')).toBe(before);
      });
    });
  });

  test('refuses conflicting manual aliases and unproven numeric command placeholders', async () => {
    await withKimi(async ({ plugin, resolved }) => {
      writeFiles(plugin.dir, { 'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\ndisable-model-invocation: true\ndisable_model_invocation: false\n---\nBody\n' });
      let aliasFailure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { aliasFailure = error as Error; }
      expect(aliasFailure?.message).toContain('aliases conflict');
      writeFiles(plugin.dir, { 'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary\n---\nBody\n', 'commands/numbered.md': '---\ndescription: Numbered\n---\n$1\n' });
      let placeholderFailure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { placeholderFailure = error as Error; }
      expect(placeholderFailure?.message).toContain('Kimi command preprocessing is unsupported');
    });
  });

  test('preserves ordinary persona and resource files while refusing executable manifest declarations', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      await withKimiNative(home, async () => {
        writeFiles(plugin.dir, { 'agents/persona.md': 'ordinary persona', 'skills/ordinary/resources/example.txt': 'resource' });
        await kimiWriter.add(plugin, resolved);
        const target = join(home, '.kimi-code', 'plugins', 'managed', 'demo');
        expect(readFileSync(join(target, 'agents/persona.md'), 'utf8')).toBe('ordinary persona');
        expect(readFileSync(join(target, 'skills/ordinary/resources/example.txt'), 'utf8')).toBe('resource');
      });
      for (const key of ['hooks', 'agents', 'executables']) {
        writeFiles(plugin.dir, { 'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0', description: 'Demo', [key]: {} }) });
        let failure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { failure = error as Error; }
        expect(failure?.message).toContain(`Kimi root manifest ${key} is unsupported`);
      }
    });
  });

  test('uses the verified native remove endpoint for a recorded owned representation', async () => {
    await withKimi(async ({ home }) => {
      await withKimiNative(home, async () => {
      const root = join(home, '.kimi-code'); const target = join(root, 'plugins', 'managed', 'demo');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, '.plgnz-install.json'), JSON.stringify({ source: 'fixture', pluginId: 'demo', fingerprint: 'one' }));
      writeFileSync(join(root, 'plugins', 'installed.json'), JSON.stringify({ version: 1, plugins: [{ id: 'demo', root: target, enabled: true }] }));
      await kimiWriter.remove('demo');
      expect(existsSync(target)).toBe(true);
      expect(JSON.parse(readFileSync(join(root, 'plugins', 'installed.json'), 'utf8')).plugins).toHaveLength(0);
      });
    });
  });

  test('rejects malformed registry and ownership marker before native activation', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      const root = join(home, '.kimi-code'); const registry = join(root, 'plugins', 'installed.json'); mkdirSync(join(root, 'plugins'), { recursive: true });
      writeFileSync(registry, JSON.stringify({ version: 0, plugins: [] }));
      let registryFailure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { registryFailure = error as Error; }
      expect(registryFailure?.message).toContain('unsupported Kimi installed registry');
      writeFileSync(registry, JSON.stringify({ version: 1, plugins: [] }));
      const target = join(root, 'plugins', 'managed', 'demo'); mkdirSync(target, { recursive: true }); writeFileSync(join(target, '.plgnz-install.json'), '{');
      let markerFailure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { markerFailure = error as Error; }
      expect(markerFailure?.message).toContain('invalid plgnz ownership marker');
    });
  });

  test('does not move an active target when registry snapshot acquisition fails', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      const root = join(home, '.kimi-code'); const target = join(root, 'plugins', 'managed', 'demo'); mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'preserve.txt'), 'active');
      writeFileSync(join(target, '.plgnz-install.json'), JSON.stringify({ source: resolved.sourceUri, pluginId: 'demo', fingerprint: 'old' }));
      writeFileSync(join(root, 'plugins', 'installed.json'), '{');
      let failure: Error | undefined; try { await kimiWriter.add(plugin, resolved); } catch (error) { failure = error as Error; }
      expect(failure?.message).toContain('invalid Kimi installed registry');
      expect(readFileSync(join(target, 'preserve.txt'), 'utf8')).toBe('active');
      expect(readdirSync(join(root, 'plugins')).some(name => name.startsWith('.plgnz-kimi-backup-'))).toBe(false);
    });
  });

  test('refuses the interactive marketplace updater as an update route and keeps retirement on its own gate', async () => {
    await withKimi(async ({ home, root }) => {
      const binary = join(home, 'kimi');
      mkdirSync(home, { recursive: true });
      writeFileSync(binary, '#!/bin/sh\necho 2.0.1\n');
      chmodSync(binary, 0o755);
      const managed = join(home, '.kimi-code', 'plugins', 'managed', 'demo');
      mkdirSync(managed, { recursive: true });
      writeFileSync(join(managed, 'payload.txt'), 'installed\n');
      writeFileSync(join(managed, '.plgnz-install.json'), JSON.stringify({ source: join(root, 'source'), pluginId: 'demo', fingerprint: 'owned-demo' }));
      writeFileSync(join(home, '.kimi-code', 'plugins', 'installed.json'), JSON.stringify({
        version: 1,
        plugins: [{ id: 'demo', root: managed, enabled: true }],
      }));
      const before = process.env.OPEN_PLUGIN_KIMI_BIN;
      process.env.OPEN_PLUGIN_KIMI_BIN = binary;
      try {
        const adapter = createLifecycleHostAdapter(kimiLifecycle);
        const target = { kind: 'kimi', instance: 'default' } as const;
        const version = await adapter.probeVersion(target);
        const observed = await adapter.observeTarget(target);
        const installed = observed.installations.find((row) => row.nativeId === 'demo');
        if (installed === undefined || installed.ownership.kind !== 'owned' || installed.source === null || installed.installedFingerprint === null) {
          throw new Error('owned Kimi installation was not observed');
        }
        const packageRoot = join(root, 'update-package');
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(join(packageRoot, 'payload.txt'), 'replacement\n');
        const packageFingerprint = fingerprintTree(packageRoot);
        const inventory: PackageSemanticInventory = {
          schemaVersion: 1,
          package: { name: 'demo', version: '1.1.0', fingerprint: packageFingerprint },
          components: { skills: [], mcp: [], hooks: [], commands: [], agents: [], resources: [], permissionsPreprocessing: [] },
          componentDefinitions: [],
          invocationPolicies: [],
          componentInvocationPolicies: [],
          autoUpdate: [],
          manifestPaths: [],
          hookDeclarations: [],
          requiredSemantics: [...PACKAGE_SEMANTICS],
        };
        const snapshot = createFrozenPackageSnapshot({
          operationId: 'op-update',
          attemptId: 'attempt-update',
          scopeId: installed.ownership.scopeId,
          target,
          action: 'update',
          packageName: 'demo',
          nativeId: 'demo',
          sourceType: 'local',
          immutableRevision: 'local-demo-revision',
          snapshotRoot: root,
          packageRoot,
          relativePackagePath: 'update-package',
          snapshotFingerprint: fingerprintTree(root),
          packageFingerprint,
          inventory,
        });
        const pins = createResolvedLifecyclePins([]);
        const updateScope = await adapter.observeNativeMutationScope({
          targetObservation: observed,
          operation: 'update',
          packageName: 'demo',
          nativeId: 'demo',
          sourceType: 'local',
        });
        const updateProjection = await adapter.observeNativeProjection({
          targetObservation: observed,
          operation: 'update',
          snapshot,
          pins,
        });
        const update = adapter.decideRoute({
          target,
          operationId: 'op-update',
          attemptId: 'attempt-update',
          scopeId: installed.ownership.scopeId,
          packageName: 'demo',
          nativeId: 'demo',
          version,
          sourceType: 'local',
          targetObservation: observed,
          nativeScope: updateScope,
          nativeProjection: updateProjection,
          planCoverage: createLifecyclePlanCoverage(observed, [{
            nativeId: 'demo',
            operationId: 'op-update',
            operation: 'update',
            mutationGroupId: 'group-update',
            authorization: 'observed-owned',
          }]),
          operation: 'update',
          snapshot,
          pins,
        });
        const activation = createRecordedOwnedActivation({
          scopeId: installed.ownership.scopeId,
          target,
          packageName: 'demo',
          nativeId: 'demo',
          sourceType: 'local',
          sourceRevision: installed.source.immutableRevision,
          sourceLocator: null,
          installedVersion: installed.installedVersion,
          route: 'native',
          evidenceId: 'kimi-owned-demo',
          ownership: { kind: 'created', proofId: installed.ownership.proofId },
          activation: 'active',
          enablement: 'enabled',
          installedFingerprint: installed.installedFingerprint,
          contentRoots: installed.contentRoots,
        });
        const retireScope = await adapter.observeNativeMutationScope({
          targetObservation: observed,
          operation: 'retire',
          packageName: 'demo',
          nativeId: 'demo',
          sourceType: 'local',
        });
        const retireProjection = await adapter.observeNativeProjection({
          targetObservation: observed,
          operation: 'retire',
          operationId: 'op-retire',
          attemptId: 'attempt-retire',
          activation,
        });
        const retire = adapter.decideRoute({
          target,
          operationId: 'op-retire',
          attemptId: 'attempt-retire',
          scopeId: installed.ownership.scopeId,
          packageName: 'demo',
          nativeId: 'demo',
          version,
          sourceType: 'local',
          targetObservation: observed,
          nativeScope: retireScope,
          nativeProjection: retireProjection,
          planCoverage: createLifecyclePlanCoverage(observed, [{
            nativeId: 'demo',
            operationId: 'op-retire',
            operation: 'retire',
            mutationGroupId: 'group-retire',
            authorization: 'observed-owned',
          }]),
          operation: 'retire',
          activation,
        });

        expect(version).toEqual({ kind: 'detected', version: '2.0.1', probeId: 'kimi-bin:2.0.1' });
        expect(updateScope.kind).toBe('unavailable');
        expect(updateProjection.kind === 'unverified' && updateProjection.reasonId).toBe('interactive-marketplace-updater');
        expect(update.kind).toBe('capability-gap');
        expect(update.kind === 'capability-gap' && update.operation).toBe('update');
        expect(update.kind === 'capability-gap' && update.status).toBe('unsupported');
        expect(update.kind === 'capability-gap' && update.gaps.map((gap) => gap.capabilityId)).toEqual(['operation.update', 'operation.update']);
        expect(retireScope.kind === 'bounded' && retireScope.mode).toBe('exact-package');
        expect(retireScope.kind === 'bounded' && retireScope.affectedNativeIds).toEqual(['demo']);
        expect(retire.kind).toBe('capability-gap');
        expect(retire.kind === 'capability-gap' && retire.operation).toBe('retire');
        expect(retire.kind === 'capability-gap' && retire.status).toBe('unverified');
        expect(retire.kind === 'capability-gap' && retire.gaps.map((gap) => gap.capabilityId)).toEqual(['operation.retire', 'profile']);
        expect(readFileSync(join(managed, 'payload.txt'), 'utf8')).toBe('installed\n');
      } finally {
        if (before === undefined) delete process.env.OPEN_PLUGIN_KIMI_BIN;
        else process.env.OPEN_PLUGIN_KIMI_BIN = before;
      }
    });
  });

  test('stages a native install, reads a restart back as effective, and rolls it back', async () => {
    await withKimi(async ({ home, root, plugin }) => {
      await withKimiNative(home, async () => {
        const adapter = createLifecycleHostAdapter(kimiLifecycle);
        const target = { kind: 'kimi', instance: 'default' } as const;
        const version = await adapter.probeVersion(target);
        const observed = await adapter.observeTarget(target);
        const packageRoot = plugin.dir;
        const packageFingerprint = fingerprintTree(packageRoot);
        const snapshot = createFrozenPackageSnapshot({
          operationId: 'op-install',
          attemptId: 'attempt-install',
          scopeId: 'kimi:default',
          target,
          action: 'install',
          packageName: 'demo',
          nativeId: 'demo',
          sourceType: 'local',
          immutableRevision: 'local-demo-revision',
          snapshotRoot: root,
          packageRoot,
          relativePackagePath: 'source',
          snapshotFingerprint: fingerprintTree(root),
          packageFingerprint,
          inventory: {
            schemaVersion: 1,
            package: { name: 'demo', version: '1.0.0', fingerprint: packageFingerprint },
            components: { skills: ['skills/ordinary/SKILL.md'], mcp: ['mcp.json'], hooks: [], commands: [], agents: [], resources: [], permissionsPreprocessing: [] },
            componentDefinitions: [],
            invocationPolicies: [],
            componentInvocationPolicies: [],
            autoUpdate: [],
            manifestPaths: ['plugin.json'],
            hookDeclarations: [],
            requiredSemantics: [],
          },
        });
        const pins = createResolvedLifecyclePins([]);
        const nativeScope = await adapter.observeNativeMutationScope({
          targetObservation: observed,
          operation: 'install',
          packageName: 'demo',
          nativeId: 'demo',
          sourceType: 'local',
        });
        const nativeProjection = await adapter.observeNativeProjection({
          targetObservation: observed,
          operation: 'install',
          snapshot,
          pins,
        });
        const decision = adapter.decideRoute({
          target,
          operationId: 'op-install',
          attemptId: 'attempt-install',
          scopeId: 'kimi:default',
          packageName: 'demo',
          nativeId: 'demo',
          version,
          sourceType: 'local',
          targetObservation: observed,
          nativeScope,
          nativeProjection,
          planCoverage: createLifecyclePlanCoverage(observed, [{
            nativeId: 'demo',
            operationId: 'op-install',
            operation: 'install',
            mutationGroupId: 'group-install',
            authorization: 'planned-create',
          }]),
          operation: 'install',
          snapshot,
          pins,
        });
        if (decision.kind !== 'selected' || decision.route !== 'native') {
          throw new Error(`install route was not selected: ${decision.kind}`);
        }
        const staged = await adapter.stageActivation({ selection: decision, snapshot, pins });
        const directed = await adapter.applyLifecycleDirectives(staged);
        const pinned = await adapter.applyPins(directed);
        const prepared = await adapter.sealActivation(pinned);
        process.env.KIMI_FAIL_ENABLE = '1';
        let enableFailure: unknown;
        try { await adapter.apply(prepared); } catch (error) { enableFailure = error; }
        finally { delete process.env.KIMI_FAIL_ENABLE; }
        expect(enableFailure instanceof LifecycleHostPhaseError).toBe(true);
        if (!(enableFailure instanceof LifecycleHostPhaseError)) throw new Error('failed enable did not surface a phase error');
        expect(enableFailure.phase).toBe('apply');
        expect(enableFailure.mutationStarted).toBe(true);
        expect(existsSync(join(home, '.kimi-code', 'plugins', 'managed', 'demo'))).toBe(false);
        const receipt = await adapter.apply(prepared);
        const managed = join(home, '.kimi-code', 'plugins', 'managed', 'demo');
        const installedSkill = readFileSync(join(managed, 'skills/ordinary/SKILL.md'), 'utf8');
        const read = await adapter.readback(prepared.handle);
        const verified = adapter.verify(prepared.handle, read);
        const rolled = await adapter.rollback(prepared.handle);
        const restored = await adapter.readback(prepared.handle);
        const rollbackVerified = adapter.verifyRollback(prepared.handle, restored);
        const cleaned = await adapter.cleanup(prepared.handle, 'verified-rollback');
        expect(receipt.changed).toBe(true);
        expect(read.transition).toEqual({ requirement: 'restart', status: 'effective' });
        expect(read.presence).toBe('present');
        expect(read.enablement).toBe('enabled');
        expect(installedSkill).toContain('Body');
        expect(verified.phase).toBe('verified');
        expect(rolled.changed).toBe(true);
        expect(restored.presence).toBe('absent');
        expect(restored.installedFingerprint).toBe(null);
        expect(rollbackVerified.phase).toBe('rollback-verified');
        expect(cleaned.completed).toBe(true);
        expect(existsSync(managed)).toBe(false);
        expect(existsSync(join(home, '.kimi-code', 'plugins', '.plgnz-kimi-lifecycle'))).toBe(false);
      });
    });
  });

  test('probes the default Kimi binary through the isolated home when OPEN_PLUGIN_KIMI_BIN is unset', async () => {
    await withKimi(async ({ home }) => {
      const isolated = join(home, 'isolated');
      const binary = join(isolated, '.local', 'share', 'kimi-code', 'bin', 'kimi');
      const decoyHome = join(home, 'real-home');
      const decoy = join(decoyHome, '.local', 'share', 'kimi-code', 'bin', 'kimi');
      mkdirSync(join(isolated, '.local', 'share', 'kimi-code', 'bin'), { recursive: true });
      mkdirSync(join(decoyHome, '.local', 'share', 'kimi-code', 'bin'), { recursive: true });
      writeFileSync(binary, '#!/bin/sh\necho 2.0.1\n');
      writeFileSync(decoy, '#!/bin/sh\necho 9.9.9\n');
      chmodSync(binary, 0o755);
      chmodSync(decoy, 0o755);
      const beforeBin = process.env.OPEN_PLUGIN_KIMI_BIN;
      const beforePluginHome = process.env.OPEN_PLUGIN_HOME;
      const beforeHome = process.env.HOME;
      delete process.env.OPEN_PLUGIN_KIMI_BIN;
      process.env.OPEN_PLUGIN_HOME = isolated;
      process.env.HOME = decoyHome;
      try {
        const version = await createLifecycleHostAdapter(kimiLifecycle).probeVersion({ kind: 'kimi', instance: 'default' });
        expect(version).toEqual({ kind: 'detected', version: '2.0.1', probeId: 'kimi-bin:2.0.1' });
      } finally {
        if (beforeBin === undefined) delete process.env.OPEN_PLUGIN_KIMI_BIN;
        else process.env.OPEN_PLUGIN_KIMI_BIN = beforeBin;
        if (beforePluginHome === undefined) delete process.env.OPEN_PLUGIN_HOME;
        else process.env.OPEN_PLUGIN_HOME = beforePluginHome;
        if (beforeHome === undefined) delete process.env.HOME;
        else process.env.HOME = beforeHome;
      }
    });
  });

  test('rejects managed cache and metadata symlinks before native activation', async () => {
    await withKimi(async ({ home, plugin, resolved }) => {
      const root = join(home, '.kimi-code'); const elsewhere = join(home, 'elsewhere'); mkdirSync(join(root, 'plugins'), { recursive: true }); mkdirSync(elsewhere);
      expect(spawnSync('ln', ['-s', elsewhere, join(root, 'plugins', 'managed')]).status).toBe(0);
      let cacheFailure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { cacheFailure = error as Error; }
      expect(cacheFailure?.message).toContain('managed path component is a symlink');
      rmSync(join(root, 'plugins', 'managed'));
      expect(spawnSync('ln', ['-s', join(home, 'elsewhere', 'registry'), join(root, 'plugins', 'installed.json')]).status).toBe(0);
      let metadataFailure: Error | undefined; try { await kimiWriter.add(plugin, resolved, { dryRun: true }); } catch (error) { metadataFailure = error as Error; }
      expect(metadataFailure?.message).toContain('managed metadata is a symlink');
    });
  });
});
