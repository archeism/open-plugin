/**
 * Builds dist/plugnz.mjs: one plain-JavaScript ESM bundle with a node
 * shebang, compilable by Bun but runnable by plain Node >= 22 — the published
 * artifact (spec: runtime-agnostic distribution). The dev tree keeps its
 * Bun shim at bin/plugnz.mjs; only the npm package ships dist/.
 */
import { build } from "bun";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entry = join(root, "scripts", "cli-entry.ts");
const outdir = join(root, "dist");
const result = await build({
  entrypoints: [entry],
  target: "node",
  format: "esm",
  naming: "plugnz.mjs",
  outdir,
  sourcemap: "none",
});
if (result.outputs.length === 0) throw new Error("bundle produced no outputs");
const bundled = readFileSync(join(outdir, "plugnz.mjs"), "utf8");
writeFileSync(join(outdir, "plugnz.mjs"), `#!/usr/bin/env node\n${bundled}`);
chmodSync(join(outdir, "plugnz.mjs"), 0o755);
console.log(`dist/plugnz.mjs ${(bundled.length / 1024).toFixed(0)} KiB`);
