import type { HostWriter } from './host';
import type { PluginSource } from './source';

/** Adapter-owned native identity captured once before any lifecycle mutation. */
export interface NativeIdentitySnapshot {
  nativeId: string;
  legacyNativeIds: readonly string[];
  equivalentNativeIds: readonly string[];
}

export type NativeIdentityCapture =
  | { ok: true; identity: NativeIdentitySnapshot }
  | { ok: false; nativeId: string | null; error: unknown };

/** Call both adapter identity seams exactly once and retain no live adapter-owned arrays. */
export function captureNativeIdentity(writer: HostWriter, plugin: PluginSource): NativeIdentityCapture {
  let nativeId: string | null = null;
  let legacyNativeIds: readonly string[] = Object.freeze([]);
  let failed = false;
  let failure: unknown;
  try {
    nativeId = writer.plannedNativeId(plugin);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    legacyNativeIds = Object.freeze([...(writer.legacyNativeIds?.(plugin) ?? [])]);
  } catch (error) {
    if (!failed) failure = error;
    failed = true;
  }
  if (failed) return Object.freeze({ ok: false, nativeId, error: failure });
  const equivalentNativeIds = Object.freeze([...new Set([nativeId!, ...legacyNativeIds])]);
  return Object.freeze({
    ok: true,
    identity: Object.freeze({ nativeId: nativeId!, legacyNativeIds, equivalentNativeIds }),
  });
}
