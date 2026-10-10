import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesInstancePluginsDir } from '../src/hosts/hermes';
import { decideHermesPinnedSha } from '../src/hermes-identity';
import type { PersistedTargetIdentity } from '../src/target-identity';

const homes: string[] = [];
const previousHermesRoot = process.env.OPEN_PLUGIN_HERMES_ROOT;

afterEach(() => {
  if (previousHermesRoot === undefined) delete process.env.OPEN_PLUGIN_HERMES_ROOT;
  else process.env.OPEN_PLUGIN_HERMES_ROOT = previousHermesRoot;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function target(instance: string, root: string): PersistedTargetIdentity {
  return {
    kind: 'hermes',
    instance,
    context: { root, configPath: join(root, 'config.yaml') },
  };
}

describe('Hermes lifecycle instance routing', () => {
  test('keeps two Hermes targets in one manifest independently keyed', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plgnz-hermes-instances-')));
    homes.push(home);
    const workRoot = join(home, 'work');
    const personalRoot = join(home, 'personal');
    const manifest = [target('work', workRoot), target('personal', personalRoot)];
    process.env.OPEN_PLUGIN_HERMES_ROOT = join(home, 'unrelated');

    expect(manifest.map(entry => hermesInstancePluginsDir(entry))).toEqual([
      join(workRoot, 'plugins'),
      join(personalRoot, 'plugins'),
    ]);
  });

  test('refuses native update when pinned-SHA behavior is unproven', () => {
    expect(decideHermesPinnedSha('unproven')).toEqual({
      gate: 'pinned-sha',
      proof: 'unproven',
      route: 'managed',
    });
  });
});
