import { isAbsolute, resolve } from 'node:path';

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

/** Canonical, credential-free Source identity safe for persistence and hashing. */
export function validateSourceBinding(source: SourceBinding): void {
  validateStableIdentityString(source.locator, 'Deployment scope Source locator');
  if (source.kind === 'local') {
    if (!isAbsolute(source.locator) || resolve(source.locator) !== source.locator) throw new Error('Local Source locator must be a canonical absolute path');
    return;
  }
  if (source.kind !== 'git') throw new Error('Deployment scope Source binding kind must be local or git');
  validateStableIdentityString(source.ref, 'Deployment scope Source ref');
  validateGitRef(source.ref);
  validateGitLocator(source.locator);
}

/** Reject UTF-16 text that TextEncoder would silently replace before hashing. */
export function validateWellFormedIdentityString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label} must be well-formed UTF-16`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) throw new Error(`${label} must be well-formed UTF-16`);
  }
}

/** Stable identity text shared by Source and Deployment scope boundaries. */
export function validateStableIdentityString(value: string, label: string): void {
  validateWellFormedIdentityString(value, label);
  if (value === '' || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be a non-empty stable value`);
  }
}

/** The canonical ref grammar shared by public Source parsing and durable identity. */
export function validateGitRef(ref: string): string {
  validateWellFormedIdentityString(ref, 'Git ref');
  if (ref === '' || /[\u0000-\u0020\u007f]/u.test(ref) || ref.startsWith('-') || ref.includes('..') || ref.includes('@{') || /[~^:?#*\\[]/u.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
  validateStableIdentityString(ref, 'Git ref');
  return ref;
}

function validateGitLocator(locator: string): void {
  if (locator.includes('%')) invalidGitLocator();
  if (locator.startsWith('git@')) {
    validateScpGitLocator(locator);
    return;
  }

  const scheme = /^(http|https|ssh|git):\/\//u.exec(locator)?.[1];
  if (scheme === undefined) invalidGitLocator();
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(locator);
  } catch {
    invalidGitLocator();
  }
  if (locator.includes('?') || locator.includes('#')) invalidGitLocator();

  const authority = locator.slice(locator.indexOf('//') + 2).split('/', 1)[0]!;
  const at = authority.lastIndexOf('@');
  const userInfo = at === -1 ? undefined : authority.slice(0, at);
  const host = at === -1 ? authority : authority.slice(at + 1);
  if (host === '') invalidGitLocator();
  if (scheme === 'ssh') {
    if (userInfo !== undefined && (userInfo === '' || userInfo.includes(':'))) invalidGitLocator();
  } else if (userInfo !== undefined) invalidGitLocator();
  if (url.toString() !== locator) invalidGitLocator();
}

function validateScpGitLocator(locator: string): void {
  const match = /^git@([a-z0-9.-]+):(.+)$/u.exec(locator);
  if (match === null) invalidGitLocator();
  const host = match[1]!;
  const path = match[2]!;
  if (
    host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
    || path.startsWith('/')
    || path.endsWith('/')
    || path.includes('\\')
    || /[\s?#]/u.test(path)
    || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) invalidGitLocator();
}

function invalidGitLocator(): never {
  throw new Error('Deployment scope Source binding must use a credential-free canonical git locator');
}
