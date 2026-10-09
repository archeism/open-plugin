import { describe, expect, test } from 'bun:test';
import { createDeploymentScopeIdentity } from '../src/deployment-scope';
import type { SourceBinding } from '../src/source-reference';

describe('deployment scope identity', () => {
  test('is stable for one credential-free Source binding and target instance', () => {
    const source: SourceBinding = { kind: 'git', locator: 'https://example.test/repo.git', ref: 'main' };
    const target = { kind: 'hermes', instance: 'default' };

    expect(createDeploymentScopeIdentity(source, target)).toEqual({
      id: 'scope-v1-54ad3647cd66d54bb728ae21679704c5d2acd2c739bb3bc94fd7e786fe382476',
      source,
      target,
    });
    expect(createDeploymentScopeIdentity(source, target)).toEqual(createDeploymentScopeIdentity(source, target));
  });

  test('changes when locator, ref, target kind, or target instance changes', () => {
    const baseline = createDeploymentScopeIdentity(
      { kind: 'git', locator: 'https://example.test/repo.git', ref: 'main' },
      { kind: 'hermes', instance: 'default' },
    ).id;
    const changed = [
      createDeploymentScopeIdentity({ kind: 'git', locator: 'https://mirror.test/repo.git', ref: 'main' }, { kind: 'hermes', instance: 'default' }).id,
      createDeploymentScopeIdentity({ kind: 'git', locator: 'https://example.test/repo.git', ref: 'release' }, { kind: 'hermes', instance: 'default' }).id,
      createDeploymentScopeIdentity({ kind: 'git', locator: 'https://example.test/repo.git', ref: 'main' }, { kind: 'codex', instance: 'default' }).id,
      createDeploymentScopeIdentity({ kind: 'git', locator: 'https://example.test/repo.git', ref: 'main' }, { kind: 'hermes', instance: 'work' }).id,
    ];

    expect(new Set([baseline, ...changed]).size).toBe(5);
  });

  test('refuses secret-bearing bindings and empty target identity fields', () => {
    expectThrow(
      () => createDeploymentScopeIdentity(
        { kind: 'git', locator: 'https://user:secret@example.test/repo.git', ref: 'main' },
        { kind: 'codex', instance: 'default' },
      ),
      'credential-free',
    );
    expectThrow(
      () => createDeploymentScopeIdentity(
        { kind: 'local', locator: '/tmp/source' },
        { kind: 'codex', instance: '' },
      ),
      'target instance',
    );
    expectThrow(
      () => createDeploymentScopeIdentity(
        { kind: 'local', locator: '/tmp/source/../other' },
        { kind: 'codex', instance: 'default' },
      ),
      'canonical absolute path',
    );
  });
});

function expectThrow(fn: () => unknown, message: string): void {
  try {
    fn();
    throw new Error('expected function to throw');
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toContain(message);
  }
}
