/** Credential-free Source identity and immutable snapshot proof. */
export type SourceBinding =
  | { kind: 'local'; locator: string }
  | { kind: 'git'; locator: string; ref: string };

/** Durable subset of a resolved Source; safe for state and reports. */
export interface SourceSnapshotReference {
  binding: SourceBinding;
  revision: string;
  fingerprint: string;
}
