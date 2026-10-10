/**
 * Byte-compatible replacements for Bun.YAML.parse/stringify, proven equal by
 * test/yaml-parity.test.ts over every frontmatter shape the house packages
 * generate. The writer reproduces Bun's flow-style grammar exactly —
 * `{k: v,k2: v2}` with no space after commas, minimal double-quoting, \xNN
 * control escapes — because those bytes are fingerprinted and doctor-proved
 * on every installed copy; identical bytes are the distribution contract,
 * not a nicety. Parsing delegates to the `yaml` package (YAML 1.2 core),
 * which the same harness proves agrees with Bun.YAML.parse on real content.
 */
import { parse as parseYaml } from 'yaml';

// Bun.YAML parses tagged scalars to plain strings — !!timestamp stays the
// source text (yaml@2 would produce a Date) and !!binary stays base64 (yaml@2
// would produce a Buffer) — so both tags resolve to their raw text here.
const bunStringTags = [
  { tag: "tag:yaml.org,2002:timestamp", resolve(value: string): string { return value; } },
  { tag: "tag:yaml.org,2002:binary", resolve(value: string): string { return value; } },
];

export function yamlParse(text: string): unknown {
  // merge: true reproduces Bun.YAML's YAML 1.1 merge-key expansion — without
  // it a `<<:` policy map stays a literal `<<` property and every consumer
  // (semantic inventory, Codex sidecar policy) misses the restriction.
  return parseYaml(text, { merge: true, customTags: bunStringTags });
}

const BOOL_NULL_WORDS = new Set([
  "y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO",
  "true", "True", "TRUE", "false", "False", "FALSE",
  "null", "Null", "NULL", "~",
  "on", "On", "ON", "off", "Off", "OFF",
]);
/** Anything Bun's own scalar resolver reads back as a non-string. */
const SCALAR_LOOKALIKE = /^(?:[-+]?(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/u;
const LEADING_INDICATORS = new Set("-?:,[]{}#&*!|>'\"%@`<".split(""));
const MERGE_KEYS = new Set(["<<", "="]); // "=" observed plain; merge key quoted

function escapeQuoted(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\"") out += "\\\"";
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char === "\0") out += "\\0";
    else if (char === "\x07") out += "\\a";
    else if (char === "\x08") out += "\\b";
    else if (char === "\x0b") out += "\\v";
    else if (char === "\x0c") out += "\\f";
    else if (char === "\x1b") out += "\\e";
    else if (char === "\x85") out += "\\N";
    else if (char === "\xa0") out += "\\_";
    else if (char === "\u2028") out += "\\L";
    else if (char === "\u2029") out += "\\P";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return out;
}

function needsQuotes(value: string): boolean {
  if (value.length === 0) return true;
  if (BOOL_NULL_WORDS.has(value)) return true;
  if (SCALAR_LOOKALIKE.test(value)) return true;
  if (LEADING_INDICATORS.has(value[0]!)) return true;
  if (MERGE_KEYS.has(value)) return value === "<<";
  if (value === ".") return true; // YAML document-end marker as a whole scalar
  // ASCII space at either edge quotes; every other whitespace codepoint
  // (U+2000–U+200A, U+1680, U+202F, U+205F, U+3000, U+FEFF) passes plain —
  // JS trim() strips those, so it must not drive this rule. NEL/NBSP/LS/PS
  // quote anywhere via the codepoint loop below.
  if (value[0] === " " || value.endsWith(" ")) return true;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\"" || char === "'") return true;
    if (code < 0x20 || code === 0x7f) return true;
    // NEL, NBSP, line and paragraph separators: Bun quotes and emits the
    // named escapes \\N \\_ \\L \\P rather than passing them through.
    if (code === 0x85 || code === 0xa0 || code === 0x2028 || code === 0x2029) return true;
  }
  // Observed anywhere-in-string quoting set: flow structure, comment,
  // backtick, and both quote characters. Mid-string |>&*!%@?-=;\() and bare
  // colon stay plain.
  if (/[,#[\]{}"'`]/u.test(value)) return true;
  if (value.includes(": ") || value.endsWith(":")) return true;
  return false;
}

function renderScalar(value: string): string {
  return needsQuotes(value) ? `"${escapeQuoted(value)}"` : value;
}

function renderNumber(value: number): string {
  if (Object.is(value, -0)) return "-0";
  if (Number.isNaN(value)) return ".nan";
  if (value === Infinity) return ".inf";
  if (value === -Infinity) return "-.inf";
  return String(value);
}

export function yamlStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return renderNumber(value);
  if (typeof value === "string") return renderScalar(value);
  if (Array.isArray(value)) return `[${value.map((entry) => yamlStringify(entry === undefined ? null : entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries: string[] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue; // observed: undefined-valued keys are dropped
      entries.push(`${renderScalar(key)}: ${yamlStringify(entry)}`);
    }
    return `{${entries.join(",")}}`;
  }
  return renderScalar(String(value));
}
