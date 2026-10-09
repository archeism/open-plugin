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

  test('accepts each deliberate credential-free git transport form', () => {
    const locators = [
      'https://example.invalid/owner/repo.git',
      'ssh://git@example.invalid/owner/repo.git',
      'git://example.invalid/owner/repo.git',
      'git@example.invalid:owner/repo.git',
    ];

    for (const locator of locators) {
      expect(createDeploymentScopeIdentity(
        { kind: 'git', locator, ref: 'main' },
        { kind: 'dcode', instance: 'default' },
      ).source.locator).toBe(locator);
    }
  });

  test('rejects userinfo, passwords, queries, and fragments across URL transports', () => {
    const locators = [
      'http://alice@example.invalid/owner/repo.git',
      'https://alice@example.invalid/owner/repo.git',
      'http://alice:secret@example.invalid/owner/repo.git',
      'https://alice:secret@example.invalid/owner/repo.git',
      'ssh://alice:secret@example.invalid/owner/repo.git',
      'git://alice:secret@example.invalid/owner/repo.git',
      ...['http', 'https', 'ssh', 'git'].flatMap(scheme => [
        `${scheme}://example.invalid/owner/repo.git?token=synthetic`,
        `${scheme}://example.invalid/owner/repo.git#synthetic-secret`,
      ]),
    ];

    for (const locator of locators) {
      expectThrow(
        () => createDeploymentScopeIdentity(
          { kind: 'git', locator, ref: 'main' },
          { kind: 'dcode', instance: 'default' },
        ),
        'credential-free',
      );
    }
  });

  test('rejects percent escapes across every admitted remote transport', () => {
    const locators = [
      'http://example.invalid/owner/%2Frepo.git',
      'https://example.invalid/owner/%2Frepo.git',
      'ssh://alice%3Asupersecret@example.invalid/owner/repo.git',
      'ssh://alice%0Ainjected@example.invalid/owner/repo.git',
      'ssh://git@example.invalid/owner/%C2%85repo.git',
      'ssh://alice%2Fsecret@example.invalid/owner/repo.git',
      'ssh://git@example.invalid/owner/%.git',
      'ssh://git@example.invalid/owner/%GG.git',
      'ssh://git@example.invalid/owner/%F0%9F%9A%80.git',
      'git://example.invalid/owner/%2Frepo.git',
      'git@example.invalid:owner/%2Frepo.git',
    ];

    for (const locator of locators) {
      expectThrow(
        () => createDeploymentScopeIdentity(
          { kind: 'git', locator, ref: 'main' },
          { kind: 'dcode', instance: 'default' },
        ),
        'credential-free canonical git locator',
      );
    }
  });

  test('keeps percent signs valid outside remote Source locators', () => {
    expect(createDeploymentScopeIdentity(
      { kind: 'local', locator: '/tmp/100%/plugin' },
      { kind: 'dcode', instance: 'default' },
    ).source.locator).toBe('/tmp/100%/plugin');
    expect(createDeploymentScopeIdentity(
      { kind: 'git', locator: 'git@example.invalid:owner/repo.git', ref: 'release%candidate' },
      { kind: 'dcode', instance: 'default' },
    ).source).toEqual({ kind: 'git', locator: 'git@example.invalid:owner/repo.git', ref: 'release%candidate' });
  });

  test('requires canonical credential-free SCP-style syntax', () => {
    for (const locator of [
      'alice@example.invalid:owner/repo.git',
      'git@:owner/repo.git',
      'git@example.invalid:',
      'git@example.invalid:/owner/repo.git',
      'git@example.invalid:owner//repo.git',
      'git@example.invalid:owner/../repo.git',
      'git@example.invalid:owner/repo name.git',
      'git@example.invalid:owner/repo.git?token=synthetic',
      'git@example.invalid:owner/repo.git#synthetic-secret',
    ]) {
      expectThrow(
        () => createDeploymentScopeIdentity(
          { kind: 'git', locator, ref: 'main' },
          { kind: 'dcode', instance: 'default' },
        ),
        'credential-free canonical git locator',
      );
    }
    for (const control of ['\u0080', '\u0085']) {
      expectThrow(
        () => createDeploymentScopeIdentity(
          { kind: 'git', locator: `git@example.invalid:owner/${control}repo.git`, ref: 'main' },
          { kind: 'dcode', instance: 'default' },
        ),
        'stable value',
      );
    }
  });

  test('rejects unpaired UTF-16 surrogates in every scope identity field without aliasing U+FFFD', () => {
    const target = { kind: 'dcode', instance: 'default' };
    expect(createDeploymentScopeIdentity(
      { kind: 'git', locator: 'git@example.invalid:owner/repo-\uFFFD.git', ref: 'release-\uFFFD' },
      target,
    ).id.startsWith('scope-v1-')).toBe(true);

    for (const unpaired of ['\uD800', '\uDBFF', '\uDC00', '\uDFFF']) {
      const cases = [
        () => createDeploymentScopeIdentity({ kind: 'git', locator: 'git@example.invalid:owner/repo-' + unpaired + '.git', ref: 'main' }, target),
        () => createDeploymentScopeIdentity({ kind: 'git', locator: 'git@example.invalid:owner/repo.git', ref: 'release-' + unpaired }, target),
        () => createDeploymentScopeIdentity({ kind: 'git', locator: 'git@example.invalid:owner/repo.git', ref: 'main' }, { kind: 'dcode-' + unpaired, instance: 'default' }),
        () => createDeploymentScopeIdentity({ kind: 'git', locator: 'git@example.invalid:owner/repo.git', ref: 'main' }, { kind: 'dcode', instance: 'work-' + unpaired }),
      ];
      for (const createScope of cases) expectThrow(createScope, 'well-formed UTF-16');
    }
    for (const malformed of [
      '\uD800\uD800',
      '\uDC00\uDC00',
      '\uDC00\uD800',
      '\uD800x',
      '\uD83D\uDE80\uD800',
      '\uDC00\uD83D\uDE80',
    ]) {
      expectThrow(
        () => createDeploymentScopeIdentity(
          { kind: 'git', locator: 'git@example.invalid:owner/repo-' + malformed + '.git', ref: 'main' },
          target,
        ),
        'well-formed UTF-16',
      );
    }
  });

  test('preserves paired surrogates and non-BMP text in scope identity fields', () => {
    const source: SourceBinding = {
      kind: 'git',
      locator: 'git@example.invalid:owner/repo-\uD800\uDC00-\uDBFF\uDFFF-\uD83D\uDE00.git',
      ref: 'release-\uD800\uDC00-\uDBFF\uDFFF-\uD83D\uDE80',
    };
    const target = {
      kind: 'dcode-\uD800\uDC00-\uDBFF\uDFFF-\uD83D\uDE80',
      instance: 'work-\uD800\uDC00-\uDBFF\uDFFF-\uD83D\uDCBB',
    };

    expect(createDeploymentScopeIdentity(source, target)).toEqual(createDeploymentScopeIdentity(source, target));
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
