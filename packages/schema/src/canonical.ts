/**
 * Canonical serialisation and digests.
 *
 * Digests are part of the passport's integrity story (and later, signing),
 * so serialisation must be byte-identical across platforms:
 * - object keys sorted lexicographically (code-unit order), recursively
 * - no insignificant whitespace
 * - `undefined` object members omitted (same as JSON.stringify)
 * - strings serialised as UTF-8 JSON — no locale, no line endings involved
 *
 * Anything that would serialise non-deterministically (functions, symbols,
 * NaN/Infinity) is rejected loudly rather than silently coerced.
 */

import { createHash } from "node:crypto";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, i) => canonicalize(item, `${path}[${i}]`));
    return `[${items.join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v, `${path}.${k}`)}`);
  return `{${entries.join(",")}}`;
}

/** Deterministic JSON serialisation — the input to every Mantyl digest. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$");
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Digest of any JSON-serialisable value via canonical serialisation. */
export function digestValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export type { Json };
