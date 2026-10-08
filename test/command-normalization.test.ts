import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeCommandSources, normalizeCommandTree } from '../src/conversion';

function withStage(files: Record<string, string>, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-command-normalize-'));
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function failureOf(action: () => void): Error | undefined {
  try { action(); } catch (error) { return error as Error; }
  return undefined;
}

describe('Markdown command normalization (spec §2)', () => {
  test('a TOML prompt command becomes a Markdown command with description frontmatter', () => {
    withStage({ 'commands/ship.toml': 'description = "Launch review"\nprompt = """Fan out personas."""\n' }, (root) => {
      normalizeCommandSources(root);
      const projected = join(root, 'commands/ship.md');
      expect(existsSync(projected)).toBe(true);
      expect(existsSync(join(root, 'commands/ship.toml'))).toBe(false);
      expect(readFileSync(projected, 'utf8')).toBe('---\ndescription: "Launch review"\n---\nFan out personas.\n');
    });
  });

  test('an argument hint and a nested directory survive the projection', () => {
    withStage({
      'commands/ship.toml': 'description = "Launch"\nargument-hint = "[scope]"\nprompt = "body"\n',
      'commands/nested/deep.toml': 'description = "Nested"\nprompt = "nested body"\n',
    }, (root) => {
      normalizeCommandSources(root);
      expect(readFileSync(join(root, 'commands/ship.md'), 'utf8')).toBe('---\ndescription: "Launch"\nargument-hint: "[scope]"\n---\nbody\n');
      expect(readFileSync(join(root, 'commands/nested/deep.md'), 'utf8')).toBe('---\ndescription: "Nested"\n---\nnested body\n');
    });
  });

  test('Markdown wins per directory exactly like discovery: shadowed TOML is removed', () => {
    withStage({ 'commands/keep.md': '---\ndescription: Kept\n---\nmarkdown body\n', 'commands/shadowed.toml': 'description = "Shadowed"\nprompt = "gone"\n' }, (root) => {
      normalizeCommandSources(root);
      expect(readFileSync(join(root, 'commands/keep.md'), 'utf8')).toContain('markdown body');
      expect(existsSync(join(root, 'commands/shadowed.toml'))).toBe(false);
      expect(existsSync(join(root, 'commands/shadowed.md'))).toBe(false);
    });
  });

  test('invocation-policy metadata is refused, never silently stripped', () => {
    withStage({ 'commands/locked.toml': 'description = "Locked"\nuser-invocable = false\nprompt = "body"\n' }, (root) => {
      expect(failureOf(() => normalizeCommandSources(root))?.message).toContain('invocation policy');
    });
    withStage({ 'commands/implicit.toml': 'description = "Implicit"\ndisable-model-invocation = false\nprompt = "body"\n' }, (root) => {
      expect(failureOf(() => normalizeCommandSources(root))?.message).toContain('invocation policy');
    });
  });

  test('invalid TOML command shape and symlinks fail closed', () => {
    withStage({ 'commands/broken.toml': 'description = "No prompt"\n' }, (root) => {
      expect(failureOf(() => normalizeCommandSources(root))?.message).toContain('description and prompt');
    });
    withStage({ 'commands/target.toml': 'description = "x"\nprompt = "y"\n' }, (other) => {
      withStage({ 'commands/link.toml': 'description = "x"\nprompt = "y"\n' }, (linked) => {
        rmSync(join(linked, 'commands/link.toml'));
        const linkedResult = spawnSync('ln', ['-s', join(other, 'commands/target.toml'), join(linked, 'commands/link.toml')]);
        expect(linkedResult.status).toBe(0);
        expect(failureOf(() => normalizeCommandTree(join(linked, 'commands')))?.message).toContain('symlink');
      });
    });
  });

  test('a package without a commands directory is untouched', () => {
    withStage({ 'skills/example/SKILL.md': '---\nname: example\ndescription: Example\n---\nbody\n' }, (root) => {
      normalizeCommandSources(root);
      expect(existsSync(join(root, 'skills/example/SKILL.md'))).toBe(true);
      expect(existsSync(join(root, 'commands'))).toBe(false);
    });
  });
});
