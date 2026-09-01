/**
 * Secret detection and redaction (architecture spec §4).
 * Runs BEFORE content is cached, logged, sent to an LLM or uploaded.
 * Fail-closed: when in doubt, redact — a false positive costs a little
 * context; a false negative leaks a credential.
 *
 * Redaction preserves evidence references (positions, kinds) without
 * preserving secret values.
 */

export interface SecretFinding {
  kind: string;
  /** Offsets into the ORIGINAL text. */
  start: number;
  end: number;
}

export interface RedactionResult {
  text: string;
  findings: SecretFinding[];
}

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Which capture group holds the secret value (0 = whole match). */
  group?: number;
}

const RULES: Rule[] = [
  // Well-known token shapes
  { kind: "aws-access-key", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "stripe-key", pattern: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // URLs with embedded credentials: scheme://user:secret@host
  { kind: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s@]+)@/gi, group: 1 },
  // Assignments to secret-looking names: API_KEY=..., "password": "...", token: '...'
  {
    kind: "secret-assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?([^\s"']{6,})["']?/gi,
    group: 2,
  },
];

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Catch-all for opaque high-entropy blobs assigned or quoted in text. */
function findHighEntropyTokens(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const candidate = /[A-Za-z0-9+/=_-]{32,}/g;
  for (const match of text.matchAll(candidate)) {
    const value = match[0];
    // Skip obvious non-secrets: hex digests are evidence, not credentials —
    // but only when they look exactly like bare sha256/sha1 hex.
    if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value)) continue;
    if (entropy(value) >= 4.2) {
      findings.push({ kind: "high-entropy", start: match.index, end: match.index + value.length });
    }
  }
  return findings;
}

export function detectSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const group = rule.group ?? 0;
      const value = match[group];
      if (!value) continue;
      const offset = group === 0 ? 0 : match[0].indexOf(value);
      const start = match.index + offset;
      findings.push({ kind: rule.kind, start, end: start + value.length });
    }
  }
  findings.push(...findHighEntropyTokens(text));
  // Merge overlaps, earliest-first, longest wins on ties.
  findings.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretFinding[] = [];
  for (const f of findings) {
    const last = merged[merged.length - 1];
    if (last && f.start < last.end) {
      last.end = Math.max(last.end, f.end);
      continue;
    }
    merged.push({ ...f });
  }
  return merged;
}

/** Replace detected secret values with [REDACTED:<kind>] placeholders. */
export function redactText(text: string): RedactionResult {
  const findings = detectSecrets(text);
  if (findings.length === 0) return { text, findings };
  let out = "";
  let cursor = 0;
  for (const f of findings) {
    out += text.slice(cursor, f.start);
    out += `[REDACTED:${f.kind}]`;
    cursor = f.end;
  }
  out += text.slice(cursor);
  return { text: out, findings };
}
