import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dcodeWriter } from '../src/hosts/dcode-writer';
import { PackageCapabilityError } from '../src/capability-evidence';
import type { PluginSource, ResolvedSource } from '../src/source';
import { writeFiles } from './util';

const MANAGED_BANNER = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'deepagents-code 0.1.83' 'deepagents (SDK) 0.7.23'
  exit 0
fi
exit 91
`;

function incoming(body = 'ordinary skill\n'): { plugin: PluginSource; resolved: ResolvedSource } {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-dcode-source-'));
  const dir = join(root, 'plugins', 'addy');
  writeFiles(dir, {
    'plugin.json': '{"name":"addy","version":"0.1.0"}\n',
    'skills/a/SKILL.md': `---\nname: a\ndescription: fixture\n---\n${body}`,
  });
  const plugin: PluginSource = { dir, name: 'addy', marketplace: 'personal', contentFingerprint: body };
  return { plugin, resolved: { sourceUri: root, sha: '0.1.0', isGit: false, plugins: [plugin] } };
}

function script(dir: string, body: string): string {
  const path = join(dir, 'dcode');
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

async function withBinary(body: string | undefined, fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-dcode-root-'));
  const oldRoot = process.env['OPEN_PLUGIN_DCODE_ROOT'];
  const oldBin = process.env['OPEN_PLUGIN_DCODE_BIN'];
  process.env['OPEN_PLUGIN_DCODE_ROOT'] = root;
  process.env['OPEN_PLUGIN_DCODE_BIN'] = body === undefined ? join(root, 'missing-dcode') : script(root, body);
  try {
    await fn(root);
  } finally {
    if (oldRoot === undefined) delete process.env['OPEN_PLUGIN_DCODE_ROOT'];
    else process.env['OPEN_PLUGIN_DCODE_ROOT'] = oldRoot;
    if (oldBin === undefined) delete process.env['OPEN_PLUGIN_DCODE_BIN'];
    else process.env['OPEN_PLUGIN_DCODE_BIN'] = oldBin;
    rmSync(root, { recursive: true, force: true });
  }
}

async function failed(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected failure');
}

const registry = (root: string) => join(root, '.state', 'installed_plugins.json');
const managedRoot = (root: string) => join(root, 'plugins/cache/plgnz');

describe('dcode version profile', () => {
  test('keeps an unknown dcode version unverified and admits 0.1.83 only as Managed with typed gaps', async () => {
    const versionScript = (version: string) => `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'deepagents-code ${version}'
  exit 0
fi
exit 91
`;

    for (const body of [undefined, versionScript('0.1.56'), '#!/bin/sh\nprintf \'%s\\n\' \'dcode 0.1.83\'\nexit 0\n']) {
      await withBinary(body, async (root) => {
        const item = incoming();
        const error = await failed(() => dcodeWriter.add(item.plugin, item.resolved));
        expect(error instanceof PackageCapabilityError).toBe(true);
        expect((error as PackageCapabilityError).gaps.map(({ capabilityId, code, evidenceId }) => ({
          capabilityId,
          code,
          evidenceId,
        }))).toEqual([
          { capabilityId: 'profile', code: 'capability.unverified', evidenceId: null },
        ]);
        expect(error.message.includes('0.1.83')).toBe(false);
        expect(existsSync(registry(root))).toBe(false);
        expect(existsSync(managedRoot(root))).toBe(false);
      });
    }

    await withBinary(MANAGED_BANNER, async (root) => {
      const ordinary = incoming();
      await dcodeWriter.add(ordinary.plugin, ordinary.resolved);
      const recorded = JSON.parse(readFileSync(registry(root), 'utf8')) as { plugins: { 'addy@personal': Array<{ installPath: string; version: string }> } };
      const installed = recorded.plugins['addy@personal'][0]!;
      expect(installed.version).toBe('0.1.0');
      expect(installed.installPath.startsWith(`${managedRoot(root)}/`)).toBe(true);
      expect(readFileSync(join(installed.installPath, 'skills/a/SKILL.md'), 'utf8')).toContain('ordinary skill');
    });

    await withBinary(MANAGED_BANNER, async (root) => {
      const gated = incoming();
      writeFiles(gated.plugin.dir, {
        'commands/run.md': '---\ndescription: Run\n---\nbody\n',
        'agents/reviewer.md': '---\nname: reviewer\ndescription: Review\n---\nbody\n',
        'skills/a/SKILL.md': '---\nname: a\ndescription: fixture\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody\n',
      });
      const error = await failed(() => dcodeWriter.add(gated.plugin, gated.resolved));
      expect(error instanceof PackageCapabilityError).toBe(true);
      expect(error.message).toBe("target 'dcode' 0.1.83 managed install is unsupported for commands");
      expect((error as PackageCapabilityError).gaps.map(({ capabilityId, code }) => [capabilityId, code])).toEqual([
        ['commands', 'capability.unsupported'],
        ['agents', 'capability.unsupported'],
        ['model-invocation-control', 'capability.unsupported'],
        ['user-invocation-control', 'capability.unsupported'],
      ]);
      expect(existsSync(registry(root))).toBe(false);
      expect(existsSync(managedRoot(root))).toBe(false);
    });
  });
});
