import { describe, expect, test } from 'bun:test';
import { selectOmpNativeUpgrade } from '../src/hosts/omp';

const revision = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);
const catalog = { marketplace: 'personal', pluginId: 'demo-plugin@personal', immutableRevision: revision };
const readback = { synchronous: true as const, readbackFingerprint: fingerprint };

describe('OMP native exact-package upgrade selection', () => {
  test('never selects all-plugin upgrade', () => {
    expect(selectOmpNativeUpgrade({ kind: 'all-plugins' })).toEqual({
      status: 'ineligible',
      route: 'managed',
      missing: ['all-plugin-upgrade'],
    });
  });

  test('native is eligible only with frozen catalog binding and synchronous readback', () => {
    expect(selectOmpNativeUpgrade({ kind: 'exact-package', catalog: null, readback: null })).toEqual({
      status: 'ineligible',
      route: 'managed',
      missing: ['frozen-catalog-binding', 'synchronous-readback'],
    });
    expect(selectOmpNativeUpgrade({ kind: 'exact-package', catalog: null, readback })).toEqual({
      status: 'ineligible',
      route: 'managed',
      missing: ['frozen-catalog-binding'],
    });
    expect(selectOmpNativeUpgrade({ kind: 'exact-package', catalog, readback: null })).toEqual({
      status: 'ineligible',
      route: 'managed',
      missing: ['synchronous-readback'],
    });
    expect(selectOmpNativeUpgrade({ kind: 'exact-package', catalog, readback })).toEqual({
      status: 'eligible',
      route: 'native',
      mode: 'exact-package',
    });
  });
});
