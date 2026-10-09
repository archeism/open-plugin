import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  capabilityEvidenceProfiles,
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

const skill = (frontmatter = '') => `---\nname: fixture\ndescription: fixture\n${frontmatter}---\nbody\n`;

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
      'readback',
      'rollback',
      'activation-reload',
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

  test('uses the neutral component tree once when a package also carries a host projection', () => {
    const inventory = inventoryPackageSemantics(source('projected', {
      'commands/build.toml': 'description = "Build"\nprompt = "canonical"\n',
      '.claude/commands/build.md': '---\ndescription: Build\n---\nprojected\n',
      'agents/reviewer.md': '---\nname: reviewer\ndescription: Canonical\n---\nreview\n',
      '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Projected\n---\nreview\n',
    }));

    expect(inventory.components.commands).toEqual(['commands/build.toml']);
    expect(inventory.components.agents).toEqual(['agents/reviewer.md']);
  });
});

describe('versioned capability evidence', () => {
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
          commands: inventory.components.commands.length,
          agents: inventory.components.agents.length,
          modelRestricted: inventory.invocationPolicies.filter(({ modelInvocable }) => !modelInvocable).length,
          sidecars: inventory.invocationPolicies.flatMap(({ declarations }) => declarations).filter(({ dialect }) => dialect === 'codex-sidecar').length,
        },
        gaps: admission.gaps.map(({ capabilityId }) => capabilityId),
        expectedGaps: item.expectedGaps,
        status: admission.status,
      };
    });

    expect(actual).toEqual([
      { name: 'addy', counts: { skills: 25, commands: 9, agents: 4, modelRestricted: 0, sidecars: 0 }, gaps: ['commands', 'agents'], expectedGaps: ['commands', 'agents'], status: 'refused' },
      { name: 'vercel', counts: { skills: 7, commands: 3, agents: 0, modelRestricted: 0, sidecars: 0 }, gaps: ['commands'], expectedGaps: ['commands'], status: 'refused' },
      { name: 'mattpocock', counts: { skills: 37, commands: 0, agents: 0, modelRestricted: 22, sidecars: 22 }, gaps: ['model-invocation-control'], expectedGaps: ['model-invocation-control'], status: 'refused' },
      { name: 'try-skill', counts: { skills: 3, commands: 0, agents: 0, modelRestricted: 1, sidecars: 0 }, gaps: ['model-invocation-control'], expectedGaps: ['model-invocation-control'], status: 'refused' },
    ]);
  });
});
