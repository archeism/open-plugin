/**
 * Regenerates test/parity/corpus.json from a personal checkout: every SKILL.md
 * frontmatter block and agents/openai.yaml sidecar across all house packages.
 * The corpus pins plugnz's parity harness to real house bytes; rerun after
 * adopting new upstream shapes:
 *   bun scripts/gen-yaml-corpus.ts ~/personal
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) { console.error("usage: bun scripts/gen-yaml-corpus.ts <personal-checkout>"); process.exit(1); }
const entries: Array<{ source: string; raw: string }> = [];
const walk = (dir: string, rel: string): void => {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (statSync(path).isDirectory()) { walk(path, relPath); continue; }
    if (name === "SKILL.md" || (rel?.endsWith("agents") === true && name.endsWith(".yaml"))) {
      const raw = readFileSync(path, "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      // SKILL.md frontmatter is delimited; standalone sidecars are whole
      // YAML documents and contribute their full contents either way.
      const document = name === "SKILL.md" ? match?.[1] : (match?.[1] ?? raw.trim());
      if (document) entries.push({ source: `personal/plugins/${relPath}`, raw: document });
    }
  }
};
walk(join(root, "plugins"), "");
writeFileSync(join(import.meta.dir, "..", "test", "parity", "corpus.json"), `${JSON.stringify(entries, null, 1)}\n`);
console.log(`corpus: ${entries.length} frontmatter blocks`);
