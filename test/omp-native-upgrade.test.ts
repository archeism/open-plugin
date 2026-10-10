import { describe, expect, test } from 'bun:test';
import {
  ompUpgradeMutationScope,
  ompUpgradeProjection,
  selectOmpNativeUpgrade,
  type OmpNativeUpgradeCandidate,
  type OmpRetirementSafety,
  type OmpSynchronousReadbackCapability,
} from '../src/hosts/omp';

const revision = 'a'.repeat(40);
const target = { marketplace: 'personal', pluginId: 'demo-plugin' };
const catalog = { marketplace: 'personal', pluginId: 'demo-plugin', immutableRevision: revision };
const readback = { synchronous: true as const };
const rollback = { restoresPriorActivation: true as const };
const retirement: OmpRetirementSafety = { kind: 'operation-specific', preserves: ['disabled', 'features', 'settings'] };

function exact(input: Partial<Extract<OmpNativeUpgradeCandidate, { kind: 'exact-package' }>>): OmpNativeUpgradeCandidate {
  return { kind: 'exact-package', target, catalog, readback, rollback, retirement, ...input };
}

describe('OMP native exact-package upgrade selection', () => {
  test('never selects all-plugin upgrade', () => {
    expect(selectOmpNativeUpgrade({ kind: 'all-plugins' })).toEqual({
      status: 'ineligible',
      route: 'managed',
      scope: 'unbounded',
      missing: ['all-plugin-upgrade'],
    });
    expect(ompUpgradeMutationScope({ kind: 'all-plugins' }, 'demo-plugin@personal')).toEqual({ kind: 'unbounded' });
    expect(ompUpgradeProjection({ kind: 'all-plugins' })).toEqual({
      kind: 'requires-managed',
      reasonId: 'all-plugin-upgrade',
    });
  });

  test('native is eligible only when the frozen catalog binds this package and the remaining proofs hold', () => {
    expect(selectOmpNativeUpgrade(exact({ catalog: null, readback: null, rollback: null, retirement: null }))).toEqual({
      status: 'ineligible',
      route: 'managed',
      scope: 'unavailable',
      missing: ['frozen-catalog-binding', 'synchronous-readback', 'rollback', 'operation-specific-retirement'],
    });
    expect(selectOmpNativeUpgrade(exact({ catalog: null }))).toEqual({
      status: 'ineligible',
      route: 'managed',
      scope: 'unavailable',
      missing: ['frozen-catalog-binding'],
    });
    expect(selectOmpNativeUpgrade(exact({
      catalog: { marketplace: 'other', pluginId: 'demo-plugin', immutableRevision: revision },
    }))).toEqual({
      status: 'ineligible',
      route: 'managed',
      scope: 'unavailable',
      missing: ['frozen-catalog-binding'],
    });
    expect(selectOmpNativeUpgrade(exact({
      catalog: { marketplace: 'personal', pluginId: 'other-plugin', immutableRevision: revision },
    }))).toEqual({
      status: 'ineligible',
      route: 'managed',
      scope: 'unavailable',
      missing: ['frozen-catalog-binding'],
    });
    expect(selectOmpNativeUpgrade(exact({ readback: null }))).toEqual({
      status: 'ineligible',
      route: 'managed',
      scope: 'unavailable',
      missing: ['synchronous-readback'],
    });
    expect(selectOmpNativeUpgrade(exact({ rollback: null }))).toEqual({
      status: 'ineligible',
      route: 'managed',
      scope: 'unavailable',
      missing: ['rollback'],
    });
    expect(selectOmpNativeUpgrade(exact({ retirement: { kind: 'marketplace-removal' } }))).toEqual({
      status: 'ineligible',
      route: 'managed',
      scope: 'unavailable',
      missing: ['operation-specific-retirement'],
    });
    expect(selectOmpNativeUpgrade(exact({}))).toEqual({
      status: 'eligible',
      route: 'native',
      mode: 'exact-package',
    });
    expect(ompUpgradeMutationScope(exact({}), 'demo-plugin@personal')).toEqual({
      kind: 'bounded',
      mode: 'exact-package',
      affectedNativeIds: ['demo-plugin@personal'],
    });
    expect(ompUpgradeProjection(exact({}))).toEqual({
      kind: 'equivalent',
      proofId: 'omp-exact-package-upgrade',
    });
  });

  test('rejects a malformed binding, a non-synchronous result, and an unknown command', () => {
    expect(selectOmpNativeUpgrade(exact({
      catalog: { marketplace: 'personal', pluginId: 'demo-plugin', immutableRevision: 'a'.repeat(39) },
    })).status).toBe('ineligible');
    expect(selectOmpNativeUpgrade(exact({
      catalog: { marketplace: 'personal', pluginId: 'demo-plugin', immutableRevision: 'A'.repeat(40) },
    })).status).toBe('ineligible');
    expect(selectOmpNativeUpgrade(exact({
      catalog: { marketplace: 'personal', pluginId: 'demo-plugin@personal', immutableRevision: revision },
    })).status).toBe('ineligible');
    expect(selectOmpNativeUpgrade(exact({
      catalog: { marketplace: 'personal', pluginId: 'demo-plugin', immutableRevision: 'a'.repeat(63) },
    })).status).toBe('ineligible');
    expect(selectOmpNativeUpgrade(exact({
      catalog: { marketplace: 'personal', pluginId: 'demo-plugin', immutableRevision: 'a'.repeat(64) },
    })).status).toBe('eligible');
    expect(selectOmpNativeUpgrade(exact({
      target: { marketplace: 'personal', pluginId: ' demo-plugin' },
    })).status).toBe('ineligible');
    expect(selectOmpNativeUpgrade(exact({
      target: { marketplace: 'personal', pluginId: 'demo\nplugin' },
    })).status).toBe('ineligible');
    const asynchronous = { synchronous: false } as unknown as OmpSynchronousReadbackCapability;
    expect(selectOmpNativeUpgrade(exact({ readback: asynchronous })).status).toBe('ineligible');
    let thrown: unknown;
    try { selectOmpNativeUpgrade({ kind: 'marketplace-wide' } as unknown as OmpNativeUpgradeCandidate); }
    catch (error) { thrown = error; }
    expect(thrown instanceof Error ? thrown.message : '').toContain('unknown');
  });
});
