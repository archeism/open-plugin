import { createHash } from 'node:crypto';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesInstanceIdentity, hermesInstancePluginsDir } from '../src/hosts/hermes';
import {
  HERMES_NATIVE_UPDATE_GATES,
  decideHermesNativeUpdate,
  hermesNativeUpdateProof,
  hermesPluginDataNamespace,
  type HermesGateProof,
  type HermesNativeUpdateGate,
  type HermesNativeUpdateProof,
} from '../src/hermes-identity';
import type { PersistedTargetIdentity } from '../src/target-identity';

const homes: string[] = [];
const previousHermesRoot = process.env.OPEN_PLUGIN_HERMES_ROOT;

afterAll(() => {
  if (previousHermesRoot === undefined) delete process.env.OPEN_PLUGIN_HERMES_ROOT;
  else process.env.OPEN_PLUGIN_HERMES_ROOT = previousHermesRoot;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function failureMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected failure');
}

function target(instance: string, root: string): PersistedTargetIdentity {
  return {
    kind: 'hermes',
    instance,
    context: { root, configPath: join(root, 'config.yaml') },
  };
}

function proofWith(status: (gate: HermesNativeUpdateGate) => HermesGateProof): HermesNativeUpdateProof {
  return {
    'pinned-sha': status('pinned-sha'),
    'noninteractive-consent': status('noninteractive-consent'),
    'noninteractive-dependency': status('noninteractive-dependency'),
    'synchronous-receipt': status('synchronous-receipt'),
    rollback: status('rollback'),
    readback: status('readback'),
  };
}

describe('Hermes lifecycle instance routing', () => {
  test('keeps two Hermes targets in one manifest independently keyed', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plgnz-hermes-instances-')));
    homes.push(home);
    const workRoot = join(home, 'work');
    const personalRoot = join(home, 'personal');
    const manifest = [target('work', workRoot), target('personal', personalRoot)];
    const previous = process.env.OPEN_PLUGIN_HERMES_ROOT;
    process.env.OPEN_PLUGIN_HERMES_ROOT = join(home, 'unrelated');
    try {
      expect(manifest.map(entry => hermesInstancePluginsDir(entry))).toEqual([
        join(workRoot, 'plugins'),
        join(personalRoot, 'plugins'),
      ]);
    } finally {
      if (previous === undefined) delete process.env.OPEN_PLUGIN_HERMES_ROOT;
      else process.env.OPEN_PLUGIN_HERMES_ROOT = previous;
    }
  });

  test('rejects a Hermes target whose root is not a canonical absolute path', () => {
    expect(failureMessage(() => hermesInstancePluginsDir(target('work', 'relative/root')))).toMatch(/canonical absolute path/);
  });

  test('rejects a Hermes target context field outside root and configPath', () => {
    expect(failureMessage(() => hermesInstanceIdentity({
      kind: 'hermes',
      instance: 'work',
      context: { root: '/tmp/hermes-root', configPath: '/tmp/hermes-root/config.yaml', extra: 'no' },
    }))).toMatch(/unsupported field 'extra'/);
  });

  test('names plugin-data from the portable plugin id', () => {
    const digest = createHash('sha256').update('demo-plugin').digest('hex').slice(0, 8);
    expect(hermesPluginDataNamespace('demo-plugin')).toBe(`agent-plugin-demo-plugin-${digest}`);
  });

  for (const gate of HERMES_NATIVE_UPDATE_GATES) {
    test(`refuses native update when ${gate} is unproven`, () => {
      expect(decideHermesNativeUpdate(proofWith(item => item === gate ? 'unproven' : 'proven'))).toEqual({
        route: 'managed',
        refusedGate: gate,
      });
    });
  }

  test('selects native update only when every gate is proven', () => {
    expect(decideHermesNativeUpdate(proofWith(() => 'proven'))).toEqual({ route: 'native' });
  });

  test('recorded Hermes proof refuses pinned SHA before the later gates', () => {
    expect(hermesNativeUpdateProof['pinned-sha']).toBe('unproven');
    expect(decideHermesNativeUpdate(hermesNativeUpdateProof)).toEqual({ route: 'managed', refusedGate: 'pinned-sha' });
  });
});
