import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { yamlParse, yamlStringify } from '../src/yaml';

declare const Bun: {
  YAML: { parse(input: string): unknown; stringify(value: unknown): string };
  CryptoHasher: new (algorithm: string) => { update(value: string): { digest(format: 'hex'): string } };
};

type CorpusEntry = { source: string; raw: string };
const corpus: CorpusEntry[] = JSON.parse(readFileSync(join(import.meta.dir, "parity", "corpus.json"), "utf8"));

/** Grammar cases derived from probing Bun.YAML.stringify directly; each pair
 * is (input, exact Bun output) so a Bun upgrade that shifts the grammar fails
 * here before it can ship different bytes to any install. */
// Simple cases pin the grammar with hand-written literals.
const GRAMMAR: Array<[unknown, string]> = [
  [{ name: "ordinary", description: "ordinary skill" }, "{name: ordinary,description: ordinary skill}"],
  [{ name: "unicode", description: "审查 skill-ai-backend 仓库的 diff、MR、分支" }, "{name: unicode,description: 审查 skill-ai-backend 仓库的 diff、MR、分支}"],
  [{ name: "flags", description: "flags", "disable-model-invocation": true, "user-invocable": false, missing: null }, "{name: flags,description: flags,disable-model-invocation: true,user-invocable: false,missing: null}"],
  [{ name: "nums", description: "nums", count: 42, ratio: 3.14, big: 1e21 }, "{name: nums,description: nums,count: 42,ratio: 3.14,big: 1e+21}"],
  [{ name: "nested", description: "nested", metadata: { credits: { author: "Matt", url: "https://x.y" }, items: [{ a: 1 }] } }, "{name: nested,description: nested,metadata: {credits: {author: Matt,url: https://x.y},items: [{a: 1}]}}"],
  [{ description: "no-name" }, "{description: no-name}"],
  [{}, "{}"],
  [{ a: {} }, "{a: {}}"],
  [{ a: [] }, "{a: []}"],
  [{ a: undefined, b: 1 }, "{b: 1}"],
  [[1, [2, [3]]], "[1,[2,[3]]]"],
  [{ "": 1 }, '{"": 1}'],
  [{ zero: -0 }, "{zero: -0}"],
  [{ inf: Infinity, nan: NaN, ninf: -Infinity }, "{inf: .inf,nan: .nan,ninf: -.inf}"],
  ["plain", "plain"],
  ["with space", "with space"],
  [" leading", '" leading"'],
  ["trailing ", '"trailing "'],
  ["", '""'],
  ["42", '"'+'42'+'"'],
  ["y", '"y"'], ["yes", '"yes"'], ["on", '"on"'], ["off", '"off"'], ["no", '"no"'], ["n", '"n"'], ["null", '"null"'], ["~", '"~"'], ["true", '"true"'],
  ["0x1F", '"0x1F"'], ["0o17", '"0o17"'], ["1.5e3", '"1.5e3"'], [".5", '".5"'], ["+3", '"+3"'], ["1e5", '"1e5"'], ["0.0", '"0.0"'],
  ["1_000", "1_000"], ["1:30", "1:30"], ["12:34:56", "12:34:56"], ["1800s", "1800s"], ["0b101", "0b101"],
  [".inf", '".inf"'], [".nan", '".nan"'], ["Infinity", "Infinity"], ["NaN", "NaN"],
  ["-dash", '"-dash"'], ["?q", '"?q"'], ["!bang", '"!bang"'], ["&anchor", '"&anchor"'], ["%pct", '"%pct"'], ["@at", '"@at"'],
  ["|pipe", '"|pipe"'], [">gt", '">gt"'], ["{brace", '"{brace"'], ["[brack", '"[brack"'], [",comma", '",comma"'],
  ["#hash", '"#hash"'], ["a#b", '"a#b"'], ["a #b", '"a #b"'], ["a:b", "a:b"], ["a: b", '"a: b"'], ["a,", '"a,"'], ["a,b", '"a,b"'],
  ["end:", '"end:"'], [":", '":"'], ["=", "="], ["<<", '"<<"'],
  ["a b  c", "a b  c"], ["emoji 🎉", "emoji 🎉"], ["ünïcödé", "ünïcödé"],
  ["a]b", '"a]b"'], ["a}b", '"a}b"'], ["a`b", '"a`b"'], ["a{b", '"a{b"'], ["a[b", '"a[b"'],
  ["a|b", "a|b"], ["a>b", "a>b"], ["a&b", "a&b"], ["a*b", "a*b"], ["a!b", "a!b"], ["a?b", "a?b"], ["a-b", "a-b"],
  ["a=b", "a=b"], ["a;b", "a;b"], ["a(b", "a(b"], ["a)b", "a)b"],
];

// Escape-heavy inputs are pinned against Bun.YAML.stringify itself, so no
// hand-escaped expected literal can lie about the escape grammar.
const CROSS_CHECK: unknown[] = [
  { name: "quotes", description: "He said \"stop\" — then didn't" },
  { name: "multiline", description: "Line one.\nLine two.\nLine three ends." },
  { name: "kw", description: "Keeps arrays.", keywords: ["a", "b-c", "d_e"], when_to_use: ["x", "y"] },
  { name: "empty", description: "" },
  { name: "colon:value", description: "key: value: with: colons: and # hash" },
  [[[["deep"]]]],
  ["[x]"],
  ["tab\there"],
  ["quote\"inside"],
  ["apos'inside"],
  ["back\\slash"],
  ["x\r y"],
  ["a\x7f b"],
  ["null\n"],
];

describe("yaml byte parity (capability yaml-parity)", () => {
  test("writer grammar table matches Bun.YAML.stringify exactly", () => {
    for (const [input, expected] of GRAMMAR) {
      expect(yamlStringify(input)).toBe(expected);
      expect(Bun.YAML.stringify(input)).toBe(expected);
    }
    for (const input of CROSS_CHECK) {
      expect(yamlStringify(input)).toBe(Bun.YAML.stringify(input));
    }
  });

  test("every real house frontmatter stringifies byte-identically to Bun.YAML", () => {
    expect(corpus.length).toBeGreaterThan(100);
    let checked = 0;
    for (const entry of corpus) {
      const value = Bun.YAML.parse(entry.raw);
      const ours = yamlStringify(value);
      const theirs = Bun.YAML.stringify(value);
      if (ours !== theirs) throw new Error(`byte drift at ${entry.source}:\nours:   ${ours}\nbun's:  ${theirs}`);
      checked += 1;
    }
    expect(checked).toBe(corpus.length);
  });

  test("yaml package parse agrees with Bun.YAML.parse on the whole corpus", () => {
    for (const entry of corpus) {
      const ours = yamlParse(entry.raw);
      const theirs = Bun.YAML.parse(entry.raw);
      expect(ours).toEqual(theirs);
    }
  });

  test("sha256 hex parity between Bun.CryptoHasher and node:crypto", () => {
    for (const entry of corpus.slice(0, 20)) {
      const bunHex = new Bun.CryptoHasher("sha256").update(entry.raw).digest("hex");
      const nodeHex = createHash("sha256").update(entry.raw).digest("hex");
      expect(nodeHex).toBe(bunHex);
    }
  });
});

describe("runtime.spawn failure settlement", () => {
  test("a vanished binary settles exited with -1 and reports exitCode immediately", async () => {
    const { spawn } = await import("../src/runtime");
    const child = spawn(["/nonexistent/binary/for/plugnz/smoke", "--version"]);
    const code = await child.exited;
    expect(code).toBe(-1);
    expect(child.exitCode).toBe(-1);
  });
});

describe("runtime.spawn option forwarding", () => {
  test("timeout kills the child and settles exited with -1", async () => {
    const { spawn } = await import("../src/runtime");
    const sleeper = "/bin/sleep";
    const child = spawn([sleeper, "30"], { timeout: 120 });
    const started = performance.now();
    const code = await child.exited;
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(code).toBe(-1);
  });
});
