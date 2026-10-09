import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprintTree } from '../src/fingerprint';
import {
  PACKAGE_SEMANTICS,
  SemanticInventoryError,
  inventoryPackageSemantics,
  requiredSemanticsForOperation,
} from '../src/semantic-inventory';
import {
  admitPackageSemantics,
  admitPackageSemanticsFromProfiles,
  capabilityEvidenceProfiles,
  createCapabilityEvidenceProfile,
} from '../src/capability-evidence';
import type { PluginSource } from '../src/source';
import { writeFiles } from './util';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function source(name: string, files: Record<string, string>, version = '1.0.0'): PluginSource {
  const root = mkdtempSync(join(tmpdir(), `plgnz-semantics-${name}-`));
  roots.push(root);
  writeFiles(root, {
    'plugin.json': `${JSON.stringify({ name, version })}\n`,
    ...files,
  });
  return {
    dir: root,
    name,
    version,
    contentFingerprint: fingerprintTree(root),
  };
}

function semanticFailure(plugin: PluginSource): SemanticInventoryError {
  try {
    inventoryPackageSemantics(plugin);
  } catch (error) {
    expect(error instanceof SemanticInventoryError).toBe(true);
    return error as SemanticInventoryError;
  }
  throw new Error(`expected semantic inventory failure for ${plugin.name}`);
}

const skill = (frontmatter = '') => `---\nname: fixture\ndescription: fixture\n${frontmatter}---\nbody\n`;
const hookDocument = (event = 'PostToolUse') => `${JSON.stringify({
  hooks: {
    [event]: [{ matcher: 'Write', hooks: [{ type: 'command', command: './hooks/run.sh' }] }],
  },
})}\n`;
const inlineHookMap = (event = 'PostToolUse') => ({
  [event]: [{ matcher: 'Write', hooks: [{ type: 'command', command: './hooks/run.sh' }] }],
});

describe('source package semantic inventory', () => {
  test('keeps every independently admitted semantic as a stable typed requirement', () => {
    expect(PACKAGE_SEMANTICS).toEqual([
      'ordinary-skills',
      'mcp',
      'hooks',
      'commands',
      'agents',
      'model-invocation-control',
      'user-invocation-control',
      'auto-update-control',
      'resources',
      'permissions-preprocessing',
      'retirement',
      'retention-safety',
      'readback',
      'rollback',
      'activation-reload',
      'reversible-disable',
    ]);
  });

  test('separates authored semantics from operation-wide lifecycle requirements', () => {
    const inventory = inventoryPackageSemantics(source('ordinary', {
      'skills/ordinary/SKILL.md': skill(),
    }));

    expect(inventory.components).toEqual({
      skills: ['skills/ordinary/SKILL.md'],
      mcp: [],
      hooks: [],
      commands: [],
      agents: [],
      resources: [],
      permissionsPreprocessing: [],
    });
    expect(inventory.requiredSemantics).toEqual(['ordinary-skills']);
    expect(requiredSemanticsForOperation(inventory, 'install')).toEqual([
      'ordinary-skills',
      'auto-update-control',
      'readback',
      'rollback',
      'activation-reload',
    ]);
  });

  test('normalizes manual-only and model-only policies independently while retaining dialect declarations', () => {
    const inventory = inventoryPackageSemantics(source('policies', {
      'skills/manual/SKILL.md': skill('disable-model-invocation: true\n'),
      'skills/manual/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
      'skills/model/SKILL.md': skill('user_invocable: false\n'),
    }));

    expect(inventory.invocationPolicies).toEqual([
      {
        skill: 'skills/manual/SKILL.md',
        modelInvocable: false,
        userInvocable: true,
        declarations: [
          {
            dialect: 'claude-frontmatter',
            path: 'skills/manual/SKILL.md',
            field: 'disable-model-invocation',
            direction: 'model',
            allowed: false,
          },
          {
            dialect: 'codex-sidecar',
            path: 'skills/manual/agents/openai.yaml',
            field: 'policy.allow_implicit_invocation',
            direction: 'model',
            allowed: false,
          },
        ],
      },
      {
        skill: 'skills/model/SKILL.md',
        modelInvocable: true,
        userInvocable: false,
        declarations: [{
          dialect: 'claude-frontmatter',
          path: 'skills/model/SKILL.md',
          field: 'user_invocable',
          direction: 'user',
          allowed: false,
        }],
      },
    ]);
    expect(inventory.requiredSemantics).toEqual([
      'ordinary-skills',
      'model-invocation-control',
      'user-invocation-control',
    ]);
  });

  test('treats malformed and conflicting invocation policy as invalid source input, never a capability gap', () => {
    const cases = [
      source('alias-conflict', {
        'skills/a/SKILL.md': skill('disable-model-invocation: true\ndisable_model_invocation: false\n'),
      }),
      source('dialect-conflict', {
        'skills/a/SKILL.md': skill('disable-model-invocation: true\n'),
        'skills/a/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
      }),
      source('malformed-policy', {
        'skills/a/SKILL.md': skill('user-invocable: sometimes\n'),
      }),
    ];

    expect(cases.map((plugin) => {
      try {
        inventoryPackageSemantics(plugin);
        return 'accepted';
      } catch (error) {
        expect(error instanceof SemanticInventoryError).toBe(true);
        const { category, code, capabilityId, evidenceId } = (error as SemanticInventoryError).reason;
        return { category, code, capabilityId, evidenceId };
      }
    })).toEqual([
      { category: 'usage', code: 'usage.invalid-argument', capabilityId: null, evidenceId: null },
      { category: 'usage', code: 'usage.invalid-argument', capabilityId: null, evidenceId: null },
      { category: 'usage', code: 'usage.invalid-argument', capabilityId: null, evidenceId: null },
    ]);
  });

  test('inventories commands, agents, MCP, hooks, resources, and permission or preprocessing semantics independently', () => {
    const inventory = inventoryPackageSemantics(source('mixed', {
      'skills/a/SKILL.md': skill(),
      'skills/a/references/guide.md': 'guide\n',
      'references/global.md': 'shared command resource\n',
      'commands/deploy.md': '---\ndescription: deploy\nallowed-tools: Bash\n---\n!`date`\n',
      'agents/reviewer.md': '---\nname: reviewer\ndescription: review\ntools: Read\nisolation: worktree\n---\nreview\n',
      '.mcp.json': '{"mcpServers":{"fixture":{"command":"fixture"}}}\n',
      'hooks/hooks.json': '{"hooks":{}}\n',
    }));

    expect(inventory.requiredSemantics).toEqual([
      'ordinary-skills',
      'mcp',
      'hooks',
      'commands',
      'agents',
      'resources',
      'permissions-preprocessing',
    ]);
    expect(inventory.components.commands).toEqual(['commands/deploy.md']);
    expect(inventory.components.agents).toEqual(['agents/reviewer.md']);
    expect(inventory.components.resources).toEqual([
      'references/global.md',
      'skills/a/references/guide.md',
    ]);
    expect(inventory.components.permissionsPreprocessing).toEqual([
      'agents/reviewer.md',
      'commands/deploy.md',
    ]);
  });

  test('keeps an Addy-shaped scripts-and-docs hooks directory inert until a hook config is declared', () => {
    const inventory = inventoryPackageSemantics(source('latent-hook-resources', {
      'hooks/SDD-CACHE.md': 'documentation\n',
      'hooks/sdd-cache-pre.sh': '#!/bin/sh\n',
      'hooks/sdd-cache-test.sh': '#!/bin/sh\n',
    }));

    expect(inventory.components.hooks).toEqual([]);
    expect(inventory.components.resources).toEqual([
      'hooks/SDD-CACHE.md',
      'hooks/sdd-cache-pre.sh',
      'hooks/sdd-cache-test.sh',
    ]);
    expect(inventory.requiredSemantics).toEqual(['resources']);
  });

  test('inventories the default config plus source-backed dcode and Claude manifest declarations', () => {
    const dcode = inventoryPackageSemantics(source('dcode-hook-declarations', {
      'plugin.json': `${JSON.stringify({
        name: 'dcode-hook-declarations',
        version: '1.0.0',
        hooks: ['./config/hooks', './hooks/hooks.json'],
      })}\n`,
      'config/hooks/hooks.json': hookDocument('PreToolUse'),
      'hooks/hooks.json': hookDocument('SessionStart'),
    }));
    const claude = inventoryPackageSemantics(source('claude-hook-declarations', {
      'hooks/hooks.json': hookDocument('SessionStart'),
      'hooks/run.sh': '#!/bin/sh\n',
      'config/extra-hooks.json': hookDocument('PreToolUse'),
      '.claude-plugin/plugin.json': `${JSON.stringify({
        name: 'claude-hook-declarations',
        version: '1.0.0',
        hooks: ['./config/extra-hooks.json', inlineHookMap('PostToolUse')],
      })}\n`,
    }));

    expect(dcode.components.hooks).toEqual(['config/hooks/hooks.json', 'hooks/hooks.json']);
    expect(dcode.hookDeclarations.map(({ source, form }) => ({ source, form }))).toEqual([
      { source: 'config/hooks/hooks.json', form: 'manifest-directory' },
      { source: 'hooks/hooks.json', form: 'default-file' },
      { source: 'hooks/hooks.json', form: 'manifest-file' },
    ]);
    expect(claude.components.hooks).toEqual([
      '.claude-plugin/plugin.json#hooks[1]',
      'config/extra-hooks.json',
      'hooks/hooks.json',
    ]);
    expect(claude.components.resources).toEqual(['hooks/run.sh']);
    expect(claude.requiredSemantics).toEqual(['hooks', 'resources']);
  });

  test('rejects malformed, unsafe, missing, ambiguous, or conflicting hook declarations', () => {
    const cases = [
      source('malformed-default-hooks-json', { 'hooks/hooks.json': '{broken\n' }),
      source('unwrapped-default-hooks', { 'hooks/hooks.json': JSON.stringify(inlineHookMap()) }),
      source('malformed-hook-event-map', { 'hooks/hooks.json': '{"hooks":{"PostToolUse":{}}}\n' }),
      source('malformed-hook-handler', {
        'hooks/hooks.json': '{"hooks":{"PostToolUse":[{"hooks":[{"command":"./hooks/run.sh"}]}]}}\n',
      }),
      source('missing-declared-hooks', {
        '.claude-plugin/plugin.json': '{"name":"missing-declared-hooks","hooks":"./config/missing.json"}\n',
      }),
      source('unsafe-declared-hooks', {
        '.claude-plugin/plugin.json': '{"name":"unsafe-declared-hooks","hooks":"./../outside.json"}\n',
      }),
      source('unknown-hooks-shape', {
        '.claude-plugin/plugin.json': '{"name":"unknown-hooks-shape","hooks":42}\n',
      }),
      source('windows-absolute-declared-hooks', {
        '.claude-plugin/plugin.json': '{"name":"windows-absolute-declared-hooks","hooks":"./C:/hooks.json"}\n',
      }),
      source('ambiguous-inline-hook-wrapper', {
        'plugin.json': `${JSON.stringify({
          name: 'ambiguous-inline-hook-wrapper', version: '1.0.0',
          hooks: { hooks: inlineHookMap('PreToolUse'), PostToolUse: [] },
        })}\n`,
      }),
      source('unsupported-dcode-mixed-array', {
        'plugin.json': `${JSON.stringify({
          name: 'unsupported-dcode-mixed-array', version: '1.0.0',
          hooks: ['./config/hooks.json', inlineHookMap()],
        })}\n`,
        'config/hooks.json': hookDocument(),
      }),
    ];

    for (const plugin of cases) semanticFailure(plugin);
  });

  test('classifies camel-case command permission mode in Markdown and TOML without overclassifying ordinary arguments or paths', () => {
    const restricted = inventoryPackageSemantics(source('permission-mode', {
      '.claude/commands/markdown.md': '---\ndescription: Markdown\npermissionMode: bypassPermissions\n---\nbody\n',
      'commands/toml.toml': 'description = "TOML"\nprompt = "body"\npermissionMode = "bypassPermissions"\n',
    }));
    const ordinary = inventoryPackageSemantics(source('ordinary-command-body', {
      'commands/plain.md': '---\ndescription: Plain\n---\nUse $ARGUMENTS with ../resources/guide.md.\n',
      'resources/guide.md': 'guide\n',
    }));

    expect(restricted.components.permissionsPreprocessing).toEqual([
      '.claude/commands/markdown.md',
      'commands/toml.toml',
    ]);
    expect(restricted.requiredSemantics).toEqual(['commands', 'permissions-preprocessing']);
    expect(ordinary.components.permissionsPreprocessing).toEqual([]);
    expect(ordinary.requiredSemantics).toEqual(['commands', 'resources']);
  });

  test('rejects unsupported @{...} preprocessing in Markdown and TOML commands', () => {
    const cases = [
      source('markdown-at-preprocessing', {
        'commands/run.md': '---\ndescription: Run\n---\nRead @{../resources/guide.md}.\n',
      }),
      source('toml-at-preprocessing', {
        'commands/run.toml': 'description = "Run"\nprompt = "Read @{../resources/guide.md}."\n',
      }),
    ];

    for (const plugin of cases) {
      expect(semanticFailure(plugin).message).toContain('unsupported command preprocessing');
    }
  });

  test('inventories every valid authored root and unions stronger alternate-root semantics', () => {
    const inventory = inventoryPackageSemantics(source('projected', {
      'commands/build.toml': 'description = "Build"\nprompt = "canonical"\n',
      '.claude/commands/build.md': '---\ndescription: Build\ndisable-model-invocation: true\nuser-invocable: false\n---\nprojected inline !`date\necho ok` preprocessing\n',
      'agents/reviewer.md': '---\nname: reviewer\ndescription: Canonical\n---\nreview\n',
      '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Projected\ntools: Read\n---\nreview\n',
    }));

    expect(inventory.components.commands).toEqual([
      '.claude/commands/build.md',
      'commands/build.toml',
    ]);
    expect(inventory.components.agents).toEqual([
      '.claude/agents/reviewer.md',
      'agents/reviewer.md',
    ]);
    expect(inventory.componentDefinitions).toEqual([
      { kind: 'command', root: 'commands', dialect: 'toml', identity: 'build', path: 'commands/build.toml' },
      { kind: 'command', root: '.claude/commands', dialect: 'markdown', identity: 'build', path: '.claude/commands/build.md' },
      { kind: 'agent', root: 'agents', dialect: 'markdown', identity: 'reviewer', path: 'agents/reviewer.md' },
      { kind: 'agent', root: '.claude/agents', dialect: 'markdown', identity: 'reviewer', path: '.claude/agents/reviewer.md' },
    ]);
    expect(inventory.components.permissionsPreprocessing).toEqual([
      '.claude/agents/reviewer.md',
      '.claude/commands/build.md',
    ]);
    expect(inventory.requiredSemantics).toEqual([
      'commands',
      'agents',
      'model-invocation-control',
      'user-invocation-control',
      'permissions-preprocessing',
    ]);
  });

  test('rejects every unsupported, empty, nested, or non-directory component-root shape', () => {
    const unsupported = [
      source('command-extension', { 'commands/run.txt': 'not a command\n' }),
      source('claude-command-dialect', { '.claude/commands/run.toml': 'description = "Run"\nprompt = "body"\n' }),
      source('agent-extension', { 'agents/reviewer.txt': 'not an agent\n' }),
      source('claude-agent-dialect', { '.claude/agents/reviewer.toml': 'name = "reviewer"\n' }),
      source('nested-command', { 'commands/nested/run.md': '---\ndescription: Run\n---\nbody\n' }),
      source('nested-claude-command', { '.claude/commands/nested/run.md': '---\ndescription: Run\n---\nbody\n' }),
      source('nested-agent', { 'agents/nested/reviewer.md': '---\nname: reviewer\ndescription: Review\n---\nbody\n' }),
      source('nested-claude-agent', { '.claude/agents/nested/reviewer.md': '---\nname: reviewer\ndescription: Review\n---\nbody\n' }),
      source('command-root-file', { commands: 'not a directory\n' }),
      source('claude-command-root-file', { '.claude/commands': 'not a directory\n' }),
      source('agent-root-file', { agents: 'not a directory\n' }),
      source('claude-agent-root-file', { '.claude/agents': 'not a directory\n' }),
      source('codex-command-root', { '.codex/commands/run.md': '---\ndescription: Run\n---\nbody\n' }),
      source('codex-agent-root', { '.codex/agents/reviewer.md': '---\nname: reviewer\ndescription: Review\n---\nbody\n' }),
    ];
    const empty = [
      source('empty-commands', {}),
      source('empty-claude-commands', {}),
      source('empty-agents', {}),
      source('empty-claude-agents', {}),
    ];
    for (const [plugin, root] of empty.map((plugin, index) => [plugin, ['commands', '.claude/commands', 'agents', '.claude/agents'][index]!] as const)) {
      mkdirSync(join(plugin.dir, root), { recursive: true });
    }

    for (const plugin of [...unsupported, ...empty]) {
      semanticFailure(plugin);
    }
  });

  test('rejects malformed definitions, duplicates within one root, and malformed alternate roots', () => {
    const cases = [
      source('markdown-command-no-frontmatter', { 'commands/run.md': 'body only\n' }),
      source('markdown-command-invalid-yaml', { 'commands/run.md': '---\ndescription: [unterminated\n---\nbody\n' }),
      source('claude-command-invalid-yaml', { '.claude/commands/run.md': '---\ndescription: [unterminated\n---\nbody\n' }),
      source('toml-command-no-prompt', { 'commands/run.toml': 'description = "Run"\n' }),
      source('toml-command-invalid', { 'commands/run.toml': 'description = [unterminated\n' }),
      source('command-policy-malformed', { 'commands/run.md': '---\ndescription: Run\nuser-invocable: sometimes\n---\nbody\n' }),
      source('command-policy-conflict', { 'commands/run.toml': 'description = "Run"\nprompt = "body"\ndisable-model-invocation = true\ndisable_model_invocation = false\n' }),
      source('agent-no-name', { 'agents/reviewer.md': '---\ndescription: Review\n---\nbody\n' }),
      source('agent-invalid-yaml', { 'agents/reviewer.md': '---\nname: [unterminated\n---\nbody\n' }),
      source('claude-agent-invalid-yaml', { '.claude/agents/reviewer.md': '---\nname: [unterminated\n---\nbody\n' }),
      source('duplicate-command-identity', {
        'commands/run.md': '---\ndescription: Run\n---\nbody\n',
        'commands/run.toml': 'description = "Run"\nprompt = "body"\n',
      }),
      source('duplicate-agent-identity', {
        'agents/first.md': '---\nname: reviewer\ndescription: First\n---\nbody\n',
        'agents/second.md': '---\nname: reviewer\ndescription: Second\n---\nbody\n',
      }),
      source('malformed-alternate-command', {
        'commands/run.toml': 'description = "Run"\nprompt = "body"\n',
        '.claude/commands/ignored.txt': 'must not disappear\n',
      }),
      source('malformed-alternate-agent', {
        'agents/reviewer.md': '---\nname: reviewer\ndescription: Review\n---\nbody\n',
        '.claude/agents/ignored.toml': 'must not disappear\n',
      }),
    ];

    for (const plugin of cases) {
      semanticFailure(plugin);
    }
  });
});

describe('versioned capability evidence', () => {
  test('selects from an explicit immutable evidence set and rejects ambiguous cells', () => {
    const inventory = inventoryPackageSemantics(source('explicit-evidence', {
      'skills/a/SKILL.md': skill(),
    }));
    const profile = createCapabilityEvidenceProfile({
      host: 'fixture',
      detectedVersion: '1.0.0',
      sourceTypes: ['local'],
      operations: ['install'],
      route: 'managed',
      operationStatus: 'supported',
      semantics: Object.fromEntries(PACKAGE_SEMANTICS.map((semantic) => [semantic, 'supported'])) as Record<(typeof PACKAGE_SEMANTICS)[number], 'supported'>,
      evidence: ['docs/adr/0002-preflight-before-native-activation.md'],
    });
    const request = {
      host: 'fixture',
      detectedVersion: '1.0.0',
      sourceType: 'local' as const,
      operation: 'install' as const,
      route: 'managed' as const,
      inventory,
    };

    expect(admitPackageSemanticsFromProfiles(request, [profile]).status).toBe('admitted');
    let ambiguous: unknown;
    try {
      admitPackageSemanticsFromProfiles(request, [profile, profile]);
    } catch (error) {
      ambiguous = error;
    }
    expect(ambiguous instanceof Error ? ambiguous.message : '').toContain('ambiguous capability evidence');
  });

  test('admits one complete ordinary dcode package and refuses the complete package when any required semantic has a gap', () => {
    const ordinary = inventoryPackageSemantics(source('ordinary-profile', {
      'skills/a/SKILL.md': skill(),
      'skills/a/reference.md': 'supporting resource\n',
    }));
    const withCommandsAndAgents = inventoryPackageSemantics(source('complex-profile', {
      'skills/a/SKILL.md': skill(),
      'commands/a.md': '---\ndescription: a\n---\nbody\n',
      'agents/a.md': '---\nname: a\ndescription: a\n---\nbody\n',
    }));

    const admitted = admitPackageSemantics({
      host: 'dcode',
      detectedVersion: '0.1.83',
      sourceType: 'local',
      operation: 'install',
      route: 'managed',
      inventory: ordinary,
    });
    const refused = admitPackageSemantics({
      host: 'dcode',
      detectedVersion: '0.1.83',
      sourceType: 'git',
      operation: 'update',
      route: 'managed',
      inventory: withCommandsAndAgents,
    });

    expect(admitted.status).toBe('admitted');
    expect(admitted.gaps).toEqual([]);
    expect(admitted.profile?.route).toBe('managed');
    expect(refused.status).toBe('refused');
    expect(refused.gaps.map(({ category, code, capabilityId, evidenceId }) => ({ category, code, capabilityId, evidenceId }))).toEqual([
      { category: 'capability', code: 'capability.unsupported', capabilityId: 'commands', evidenceId: refused.profile?.evidenceId },
      { category: 'capability', code: 'capability.unsupported', capabilityId: 'agents', evidenceId: refused.profile?.evidenceId },
    ]);
  });

  test('admits only hook declarations that dcode 0.1.83 actually selects and loads', () => {
    const effective = inventoryPackageSemantics(source('effective-dcode-hooks', {
      'plugin.json': '{"name":"effective-dcode-hooks","version":"1.0.0","hooks":"./config/hooks"}\n',
      'config/hooks/hooks.json': hookDocument('PreToolUse'),
    }));
    const effectiveInline = inventoryPackageSemantics(source('effective-inline-dcode-hooks', {
      'plugin.json': `${JSON.stringify({
        name: 'effective-inline-dcode-hooks', version: '1.0.0', hooks: { hooks: inlineHookMap('PreToolUse') },
      })}\n`,
    }));
    const masked = inventoryPackageSemantics(source('masked-claude-hooks', {
      '.claude-plugin/plugin.json': `${JSON.stringify({
        name: 'masked-claude-hooks', version: '1.0.0', hooks: inlineHookMap('PreToolUse'),
      })}\n`,
    }));
    const mixedSource = source('mixed-claude-hooks', {
      '.claude-plugin/plugin.json': `${JSON.stringify({
        name: 'mixed-claude-hooks', version: '1.0.0',
        hooks: ['./config/hooks.json', inlineHookMap('PreToolUse')],
      })}\n`,
      'config/hooks.json': hookDocument('PreToolUse'),
    });
    rmSync(join(mixedSource.dir, 'plugin.json'));
    const mixed = inventoryPackageSemantics(mixedSource);
    const unsupportedEventSource = source('unsupported-dcode-hook-event', {
      '.claude-plugin/plugin.json': `${JSON.stringify({
        name: 'unsupported-dcode-hook-event', version: '1.0.0', hooks: inlineHookMap('Setup'),
      })}\n`,
    });
    rmSync(join(unsupportedEventSource.dir, 'plugin.json'));
    const unsupportedEvent = inventoryPackageSemantics(unsupportedEventSource);

    const admission = (inventory: ReturnType<typeof inventoryPackageSemantics>) => admitPackageSemantics({
      host: 'dcode',
      detectedVersion: '0.1.83',
      sourceType: 'git',
      operation: 'install',
      route: 'managed',
      inventory,
    });

    expect(admission(effective).status).toBe('admitted');
    expect(admission(effectiveInline).status).toBe('admitted');
    for (const inventory of [masked, mixed, unsupportedEvent]) {
      const result = admission(inventory);
      expect(result.status).toBe('refused');
      expect(result.gaps.map(({ capabilityId, code }) => ({ capabilityId, code }))).toEqual([
        { capabilityId: 'hooks', code: 'capability.unsupported' },
      ]);
    }
  });

  test('projects retirement from recorded lifecycle semantics only, with or without Source inventory', () => {
    const unsupportedAtRuntime = inventoryPackageSemantics(source('retirement', {
      'commands/run.md': '---\ndescription: Run\nallowed-tools: Bash\n---\nbody\n',
      'agents/reviewer.md': '---\nname: reviewer\ndescription: Review\n---\nbody\n',
      'skills/manual/SKILL.md': skill('disable-model-invocation: true\nuser-invocable: false\n'),
      'mcp.json': '{"mcpServers":{"fixture":{"command":"fixture"}}}\n',
    }));

    const recorded = admitPackageSemantics({
      host: 'dcode',
      detectedVersion: '0.1.83',
      sourceType: 'git',
      operation: 'retire',
      route: 'managed',
      inventory: unsupportedAtRuntime,
    });
    const offline = admitPackageSemantics({
      host: 'dcode',
      detectedVersion: '0.1.83',
      sourceType: 'git',
      operation: 'retire',
      route: 'managed',
    });

    for (const admission of [recorded, offline]) {
      expect(admission.status).toBe('admitted');
      expect(admission.gaps).toEqual([]);
      expect(admission.requirements).toEqual([
        'retirement',
        'retention-safety',
        'readback',
        'rollback',
        'activation-reload',
      ]);
    }
  });

  test('requires explicit reversible-disable evidence instead of inferring it from rollback', () => {
    expect(requiredSemanticsForOperation(undefined, 'disable')).toEqual([
      'retention-safety',
      'readback',
      'rollback',
      'activation-reload',
      'reversible-disable',
    ]);

    const admission = admitPackageSemantics({
      host: 'dcode',
      detectedVersion: '0.1.83',
      sourceType: 'git',
      operation: 'disable',
      route: 'managed',
    });

    expect(admission.status).toBe('refused');
    expect(admission.profile).toBe(null);
    expect(admission.gaps[0]?.code).toBe('capability.unverified');
  });

  test('still requires Source inventory for install and update at the runtime boundary', () => {
    for (const operation of ['install', 'update'] as const) {
      const untyped = {
        host: 'dcode',
        detectedVersion: '0.1.83',
        sourceType: 'local',
        operation,
        route: 'managed',
      } as unknown as Parameters<typeof admitPackageSemantics>[0];
      let failure: unknown;
      try {
        admitPackageSemantics(untyped);
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof SemanticInventoryError).toBe(true);
    }
  });

  test('classifies unknown, unparseable, and unmatched versions as unverified', () => {
    const inventory = inventoryPackageSemantics(source('unknown-version', {
      'skills/a/SKILL.md': skill(),
    }));

    for (const detectedVersion of [undefined, '', 'not a version', '0.1.84']) {
      const result = admitPackageSemantics({
        host: 'dcode',
        detectedVersion,
        sourceType: 'local',
        operation: 'install',
        route: 'managed',
        inventory,
      });
      expect(result.status).toBe('refused');
      expect(result.profile).toBe(null);
      expect(result.gaps).toHaveLength(1);
      expect({
        category: result.gaps[0]?.category,
        code: result.gaps[0]?.code,
        capabilityId: result.gaps[0]?.capabilityId,
        evidenceId: result.gaps[0]?.evidenceId,
      }).toEqual({
        category: 'capability',
        code: 'capability.unverified',
        capabilityId: 'profile',
        evidenceId: null,
      });
    }
  });

  test('keeps route in the evidence key instead of treating Managed proof as Native proof', () => {
    const inventory = inventoryPackageSemantics(source('route-key', {
      'skills/a/SKILL.md': skill(),
    }));
    const result = admitPackageSemantics({
      host: 'dcode',
      detectedVersion: '0.1.83',
      sourceType: 'local',
      operation: 'install',
      route: 'native',
      inventory,
    });

    expect(result.status).toBe('refused');
    expect(result.profile).toBe(null);
    expect(result.gaps[0]?.code).toBe('capability.unverified');
  });

  test('addresses every evidence profile with a credential-free sha256 id', () => {
    expect(capabilityEvidenceProfiles.length).toBeGreaterThan(0);
    for (const profile of capabilityEvidenceProfiles) {
      expect(profile.evidenceId).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(profile.evidenceId.includes(profile.host)).toBe(false);
      expect(profile.evidence.every((reference) => !reference.includes('@'))).toBe(true);
    }
  });

  test('pins current Addy, Vercel, Matt Pocock, and Try Skill requirements to dcode 0.1.83 evidence', () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'dcode-0.1.83-package-semantics.json'), 'utf8')) as {
      dcodeVersion: string;
      packages: Array<{
        name: string;
        version: string;
        skills: number;
        commands: number;
        commandDialect: 'toml' | 'markdown' | 'none';
        claudeCommandProjection?: number;
        agents: number;
        hooks: boolean;
        hookResources: string[];
        mcp: boolean;
        resources: boolean;
        manualOnly: { frontmatter: number; codexSidecar: number };
        expectedGaps: string[];
      }>;
    };

    const actual = fixture.packages.map((item) => {
      const files: Record<string, string> = {};
      for (let index = 0; index < item.skills; index += 1) {
        const id = String(index + 1).padStart(2, '0');
        files[`skills/s${id}/SKILL.md`] = skill(index < item.manualOnly.frontmatter ? 'disable-model-invocation: true\n' : '');
        if (index < item.manualOnly.codexSidecar) {
          files[`skills/s${id}/agents/openai.yaml`] = 'policy:\n  allow_implicit_invocation: false\n';
        }
      }
      for (let index = 0; index < item.commands; index += 1) {
        const id = String(index + 1).padStart(2, '0');
        if (item.commandDialect === 'toml') {
          files[`commands/c${id}.toml`] = `description = "command ${id}"\nprompt = "body $ARGUMENTS"\n`;
        } else {
          files[`commands/c${id}.md`] = `---\ndescription: command ${id}\n---\nbody $ARGUMENTS\n`;
        }
      }
      for (let index = 0; index < (item.claudeCommandProjection ?? 0); index += 1) {
        const id = String(index + 1).padStart(2, '0');
        files[`.claude/commands/c${id}.md`] = `---\ndescription: command ${id}\n---\nprojected body $ARGUMENTS\n`;
      }
      for (let index = 0; index < item.agents; index += 1) {
        const id = String(index + 1).padStart(2, '0');
        files[`agents/a${id}.md`] = `---\nname: a${id}\ndescription: agent ${id}\n---\nbody\n`;
      }
      if (item.hooks) files['hooks/hooks.json'] = '{"hooks":{}}\n';
      for (const path of item.hookResources) files[path] = path.endsWith('.md') ? 'hook documentation\n' : '#!/bin/sh\n';
      if (item.mcp) files['mcp.json'] = '{"mcpServers":{"fixture":{"command":"fixture"}}}\n';
      if (item.resources) files['skills/s01/references/evidence.md'] = 'frozen supporting resource\n';

      const inventory = inventoryPackageSemantics(source(item.name, files, item.version));
      const admission = admitPackageSemantics({
        host: 'dcode',
        detectedVersion: fixture.dcodeVersion,
        sourceType: 'git',
        operation: 'install',
        route: 'managed',
        inventory,
      });
      return {
        name: item.name,
        counts: {
          skills: inventory.components.skills.length,
          commandDefinitions: inventory.components.commands.length,
          neutralCommands: inventory.componentDefinitions.filter(({ root }) => root === 'commands').length,
          claudeCommands: inventory.componentDefinitions.filter(({ root }) => root === '.claude/commands').length,
          agents: inventory.components.agents.length,
          hookConfigs: inventory.components.hooks.length,
          hookResources: inventory.components.resources.filter((path) => path.startsWith('hooks/')).length,
          modelRestricted: inventory.invocationPolicies.filter(({ modelInvocable }) => !modelInvocable).length,
          sidecars: inventory.invocationPolicies.flatMap(({ declarations }) => declarations).filter(({ dialect }) => dialect === 'codex-sidecar').length,
        },
        gaps: admission.gaps.map(({ capabilityId }) => capabilityId),
        expectedGaps: item.expectedGaps,
        status: admission.status,
      };
    });

    expect(actual).toEqual([
      { name: 'addy', counts: { skills: 25, commandDefinitions: 18, neutralCommands: 9, claudeCommands: 9, agents: 4, hookConfigs: 0, hookResources: 9, modelRestricted: 0, sidecars: 0 }, gaps: ['commands', 'agents'], expectedGaps: ['commands', 'agents'], status: 'refused' },
      { name: 'vercel', counts: { skills: 7, commandDefinitions: 3, neutralCommands: 3, claudeCommands: 0, agents: 0, hookConfigs: 0, hookResources: 0, modelRestricted: 0, sidecars: 0 }, gaps: ['commands'], expectedGaps: ['commands'], status: 'refused' },
      { name: 'mattpocock', counts: { skills: 37, commandDefinitions: 0, neutralCommands: 0, claudeCommands: 0, agents: 0, hookConfigs: 0, hookResources: 0, modelRestricted: 22, sidecars: 22 }, gaps: ['model-invocation-control'], expectedGaps: ['model-invocation-control'], status: 'refused' },
      { name: 'try-skill', counts: { skills: 3, commandDefinitions: 0, neutralCommands: 0, claudeCommands: 0, agents: 0, hookConfigs: 0, hookResources: 0, modelRestricted: 1, sidecars: 0 }, gaps: ['model-invocation-control'], expectedGaps: ['model-invocation-control'], status: 'refused' },
    ]);
  });
});
