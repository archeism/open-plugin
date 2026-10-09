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

export function yamlParse(text: string): unknown {
  return parseYaml(text);
}

const BOOL_NULL_WORDS = new Set([
  "y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO",
  "true", "True", "TRUE", "false", "False", "FALSE",
  "null", "Null", "NULL", "~",
  "on", "On", "ON", "off", "Off", "OFF",
]);
/** Anything Bun's own scalar resolver reads back as a non-string. */
const SCALAR_LOOKALIKE = /^(?:[-+]?(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/u;
const LEADING_INDICATORS = new Set("-?:,[]{}#&*!|>'\"%@`".split(""));
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
  if (value.trim() !== value) return true;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\"" || char === "'") return true;
    if (code < 0x20 || code === 0x7f) return true;
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
