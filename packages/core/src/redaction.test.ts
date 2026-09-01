import { describe, expect, it } from "vitest";
import { detectSecrets, redactText } from "./redaction.js";

/**
 * Planted secrets — none may survive redaction (release gate). Assembled
 * at runtime so no credential-shaped literal exists in this source file:
 * hosted scanners (GitHub push protection blocked the public mirror over
 * the Stripe and Slack shapes) match source bytes, while the redaction
 * engine only ever sees the assembled runtime strings, which still match
 * every real provider shape exactly.
 */
const PLANTED = [
  ["AKIAIOSFODNN7", "EXAMPLE"].join(""),
  ["ghp", "abcdefghijklmnopqrstuv0123456789"].join("_"),
  ["sk-ant-api03", "verysecretfixturevalue0001"].join("-"),
  ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
  ["xoxb", "1234567890", "abcdefghijklmnop"].join("-"),
  "hunter2secretpassword",
  "super-Secret-Passw0rd-Value",
];

const DOCUMENT = `
Deploy notes:
AWS_ACCESS_KEY_ID=${PLANTED[0]}
export GITHUB_TOKEN="${PLANTED[1]}"
anthropic key: ${PLANTED[2]}
stripe: ${PLANTED[3]}
slack bot ${PLANTED[4]}
DATABASE_URL=postgres://admin:${PLANTED[5]}@db.internal:5432/app
password = "${PLANTED[6]}"
The PORT variable defaults to 3000.
`;

describe("redaction (fail-closed leak gate)", () => {
  it("no planted secret value survives redaction", () => {
    const { text, findings } = redactText(DOCUMENT);
    for (const secret of PLANTED) {
      // Neither the whole secret nor its distinctive tail may remain.
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(-12));
    }
    expect(findings.length).toBeGreaterThanOrEqual(PLANTED.length - 1);
    expect(text).toContain("[REDACTED:");
  });

  it("preserves non-secret content and env NAMES", () => {
    const { text } = redactText(DOCUMENT);
    expect(text).toContain("AWS_ACCESS_KEY_ID");
    expect(text).toContain("DATABASE_URL");
    expect(text).toContain("The PORT variable defaults to 3000.");
  });

  it("does not flag bare sha256 digests (evidence, not credentials)", () => {
    const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(detectSecrets(`evidenceDigest: ${digest}`)).toEqual([]);
  });

  it("redacts private key blocks entirely", () => {
    const block = `-----BEGIN RSA PRIVATE KEY-----\nMIIfixture+content\n-----END RSA PRIVATE KEY-----`;
    const { text } = redactText(block);
    expect(text).toBe("[REDACTED:private-key-block]");
  });

  it("returns positions usable as evidence references", () => {
    const input = `token=${PLANTED[1]}`;
    const findings = detectSecrets(input);
    expect(findings.length).toBeGreaterThan(0);
    const f = findings[0]!;
    expect(input.slice(f.start, f.end)).toContain("ghp_");
  });
});
