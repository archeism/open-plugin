import { describe, expect, test } from 'bun:test';
import { createDeploymentScopeIdentity } from '../src/deployment-scope';
import {
  deploymentScopeForSyncManifestEntry,
  parseSyncManifest,
  selectManifestPackages,
  SyncManifestValidationError,
} from '../src/sync-manifest';

describe('sync manifest public parser', () => {
  test('preserves ordered multi-Source, multi-instance work while normalizing adoption defaults', () => {
    const retiredScope = `scope-v1-${'a'.repeat(64)}`;
    const parsed = parseSyncManifest({
      schemaVersion: 1,
      entries: [
        {
          operation: 'sync',
          source: { kind: 'git', locator: 'https://example.test/personal.git', ref: 'main' },
          target: { kind: 'dcode', instance: 'default' },
          selectors: [
            { package: 'addy', adoptExisting: true },
            { package: 'toolbox' },
          ],
        },
        {
          operation: 'sync',
          source: { kind: 'local', locator: '/sources/personal' },
          target: {
            kind: 'hermes',
            instance: 'work',
            context: { root: '/profiles/work/.hermes', configPath: '/profiles/work/.hermes/config.yaml' },
          },
        },
        {
          operation: 'retire-source',
          scopeId: retiredScope,
          target: { kind: 'hermes', instance: 'old' },
        },
      ],
    });

    expect(parsed).toEqual({
      schemaVersion: 1,
      entries: [
        {
          operation: 'sync',
          source: { kind: 'git', locator: 'https://example.test/personal.git', ref: 'main' },
          target: { kind: 'dcode', instance: 'default' },
          selectors: [
            { package: 'addy', adoptExisting: true },
            { package: 'toolbox', adoptExisting: false },
          ],
        },
        {
          operation: 'sync',
          source: { kind: 'local', locator: '/sources/personal' },
          target: {
            kind: 'hermes',
            instance: 'work',
            context: { root: '/profiles/work/.hermes', configPath: '/profiles/work/.hermes/config.yaml' },
          },
        },
        {
          operation: 'retire-source',
          scopeId: retiredScope,
          target: { kind: 'hermes', instance: 'old' },
        },
      ],
    });
    expect(parseSyncManifest(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test('treats absent selectors as all packages and explicit selectors as the complete ordered Desired set', () => {
    const allEntry = parseSyncManifest({
      schemaVersion: 1,
      entries: [{
        operation: 'sync',
        source: { kind: 'local', locator: '/sources/all' },
        target: { kind: 'codex', instance: 'default' },
      }],
    }).entries[0]!;
    const explicitEntry = parseSyncManifest({
      schemaVersion: 1,
      entries: [{
        operation: 'sync',
        source: { kind: 'local', locator: '/sources/explicit' },
        target: { kind: 'codex', instance: 'default' },
        selectors: [
          { package: 'second', adoptExisting: true },
          { package: 'first' },
        ],
      }],
    }).entries[0]!;
    const discovered = [
      { name: 'first', bytes: 'one' },
      { name: 'second', bytes: 'two' },
      { name: 'third', bytes: 'three' },
    ];

    if (allEntry.operation !== 'sync' || explicitEntry.operation !== 'sync') throw new Error('expected sync entries');
    expect(selectManifestPackages(allEntry, discovered)).toEqual([
      { plugin: discovered[0], adoptionRequested: false },
      { plugin: discovered[1], adoptionRequested: false },
      { plugin: discovered[2], adoptionRequested: false },
    ]);
    expect(selectManifestPackages(explicitEntry, discovered)).toEqual([
      { plugin: discovered[1], adoptionRequested: true },
      { plugin: discovered[0], adoptionRequested: false },
    ]);
  });

  test('never interprets an empty selector or zero-package Source as an empty Desired set', () => {
    const emptySelector = {
      schemaVersion: 1,
      entries: [{
        operation: 'sync',
        source: { kind: 'local', locator: '/sources/empty-selector' },
        target: { kind: 'codex', instance: 'default' },
        selectors: [],
      }],
    };
    expect(validationCode(() => parseSyncManifest(emptySelector))).toBe('usage.invalid-selection');

    const unfiltered = parseSyncManifest({
      schemaVersion: 1,
      entries: [{
        operation: 'sync',
        source: { kind: 'local', locator: '/sources/unfiltered' },
        target: { kind: 'codex', instance: 'default' },
      }],
    }).entries[0]!;
    if (unfiltered.operation !== 'sync') throw new Error('expected sync entry');
    expect(validationCode(() => selectManifestPackages(unfiltered, []))).toBe('usage.invalid-selection');
    expect(validationCode(() => selectManifestPackages(unfiltered, [{ name: 'duplicate' }, { name: 'duplicate' }]))).toBe('usage.invalid-selection');
  });

  test('rejects duplicate selectors and duplicate, overlapping, or contradictory scope entries', () => {
    const source = { kind: 'local' as const, locator: '/sources/personal' };
    const target = { kind: 'codex', instance: 'default' } as const;
    const sync = {
      operation: 'sync',
      source,
      target,
      selectors: [{ package: 'addy' }],
    };
    const scopeId = createDeploymentScopeIdentity(source, target).id;
    const retire = { operation: 'retire-source', scopeId, target };
    const otherTarget = { kind: 'dcode', instance: 'default' } as const;

    const invalidEntries = [
      [{ ...sync, selectors: [{ package: 'addy' }, { package: 'addy', adoptExisting: true }] }],
      [sync, sync],
      [sync, { ...sync, selectors: [{ package: 'toolbox' }] }],
      [sync, retire],
      [retire, retire],
      [retire, { ...retire, target: otherTarget }],
    ];

    expect(invalidEntries.map((entries) => validationCode(() => parseSyncManifest({ schemaVersion: 1, entries })))).toEqual([
      'usage.invalid-selection',
      'usage.invalid-selection',
      'usage.invalid-selection',
      'usage.invalid-selection',
      'usage.invalid-selection',
      'usage.invalid-selection',
    ]);
  });

  test('rejects unknown versions and fields strictly while separating malformed input from invalid selection', () => {
    const baseEntry = {
      operation: 'sync',
      source: { kind: 'git', locator: 'https://example.test/plugins.git', ref: 'main' },
      target: { kind: 'dcode', instance: 'default' },
      selectors: [{ package: 'addy' }],
    };
    const retiredScope = `scope-v1-${'b'.repeat(64)}`;
    const cases: Array<{ value: unknown; code: string }> = [
      { value: { schemaVersion: 2, entries: [baseEntry] }, code: 'usage.invalid-argument' },
      { value: { schemaVersion: 1, entries: [baseEntry], extra: true }, code: 'usage.invalid-argument' },
      { value: { schemaVersion: 1, entries: [{ ...baseEntry, extra: true }] }, code: 'usage.invalid-argument' },
      { value: { schemaVersion: 1, entries: [{ ...baseEntry, selectors: 'addy' }] }, code: 'usage.invalid-argument' },
      { value: { schemaVersion: 1, entries: [{ ...baseEntry, selectors: [{ package: 'addy', extra: true }] }] }, code: 'usage.invalid-argument' },
      { value: { schemaVersion: 1, entries: [{ ...baseEntry, source: { ...baseEntry.source, credential: 'secret' } }] }, code: 'usage.invalid-argument' },
      { value: { schemaVersion: 1, entries: [{ ...baseEntry, source: { kind: 'git', locator: 'https://user:secret@example.test/plugins.git', ref: 'main' } }] }, code: 'usage.invalid-argument' },
      { value: { schemaVersion: 1, entries: [{ ...baseEntry, target: { kind: 'future-host', instance: 'default' } }] }, code: 'usage.invalid-selection' },
      { value: { schemaVersion: 1, entries: [{ ...baseEntry, target: { kind: 'dcode', instance: 'work' } }] }, code: 'usage.invalid-selection' },
      { value: { schemaVersion: 1, entries: [{ ...baseEntry, target: { kind: 'dcode', instance: 'default', context: { root: '/tmp/dcode' } } }] }, code: 'usage.invalid-argument' },
      {
        value: {
          schemaVersion: 1,
          entries: [{
            ...baseEntry,
            target: { kind: 'hermes', instance: 'work', context: { root: 'relative', configPath: '/profiles/work/config.yaml' } },
          }],
        },
        code: 'usage.invalid-argument',
      },
      {
        value: {
          schemaVersion: 1,
          entries: [{ operation: 'retire-source', scopeId: retiredScope, target: { kind: 'dcode', instance: 'default' }, source: baseEntry.source }],
        },
        code: 'usage.invalid-argument',
      },
      {
        value: {
          schemaVersion: 1,
          entries: [{
            operation: 'retire-source',
            scopeId: retiredScope,
            target: {
              kind: 'hermes',
              instance: 'old',
              context: { root: '/profiles/old/.hermes', configPath: '/profiles/old/.hermes/config.yaml' },
            },
          }],
        },
        code: 'usage.invalid-argument',
      },
    ];

    expect(cases.map(({ value }) => validationCode(() => parseSyncManifest(value)))).toEqual(cases.map(({ code }) => code));
  });

  test('uses canonical Source × kind/instance scope identity without folding adapter context into the ID', () => {
    const entry = (root: string) => parseSyncManifest({
      schemaVersion: 1,
      entries: [{
        operation: 'sync',
        source: { kind: 'git', locator: 'https://example.test/plugins.git', ref: 'main' },
        target: {
          kind: 'hermes',
          instance: 'work',
          context: { root, configPath: `${root}/config.yaml` },
        },
      }],
    }).entries[0]!;
    const first = entry('/profiles/first/.hermes');
    const second = entry('/profiles/second/.hermes');
    if (first.operation !== 'sync' || second.operation !== 'sync') throw new Error('expected sync entries');

    const firstScope = deploymentScopeForSyncManifestEntry(first);
    const secondScope = deploymentScopeForSyncManifestEntry(second);
    expect(firstScope).toEqual({
      id: firstScope.id,
      source: { kind: 'git', locator: 'https://example.test/plugins.git', ref: 'main' },
      target: { kind: 'hermes', instance: 'work' },
    });
    expect(firstScope.id).toBe(secondScope.id);
    expect(firstScope.id).toMatch(/^scope-v1-[0-9a-f]{64}$/);
  });
});

function validationCode(fn: () => unknown): string {
  try {
    fn();
    return 'accepted';
  } catch (error) {
    if (!(error instanceof SyncManifestValidationError)) throw error;
    return error.reason.code;
  }
}
