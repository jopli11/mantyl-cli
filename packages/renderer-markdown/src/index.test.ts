import { describe, expect, it } from "vitest";
import { fixturePassport } from "./fixture.js";
import { renderPassportMarkdown } from "./index.js";

describe("renderPassportMarkdown", () => {
  const passport = fixturePassport();
  const output = renderPassportMarkdown(passport);

  it("is deterministic: same passport in, byte-identical markdown out", () => {
    expect(renderPassportMarkdown(fixturePassport())).toBe(output);
  });

  it("renders every section in the proof-first order", () => {
    const headings = [...output.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Project passport · notes-api <fixture>",
      "Verification",
      "Architecture (inferred)",
      "Modules",
      "Decisions",
      "Claims",
      "Risks & unknowns",
      "Incomplete work",
      "Setup",
      "Environment",
      "Acceptance",
    ]);
  });

  it("labels statuses and surfaces the contradiction", () => {
    expect(output).toContain("[CONTRADICTED] I added rate limiting to the API");
    expect(output).toContain("contradicted by: `package.json`");
    expect(output).toContain("[CREATOR]");
    expect(output).toContain("**NOT documented**");
  });

  it("renders check outcomes with exit codes", () => {
    expect(output).toContain("`check-install`: **passed** (exit 0)");
    expect(output).toContain("`check-test`: **failed** (exit 1)");
    expect(output).toContain("Not planned: `check-lint` (no lint script in package.json)");
  });

  it("renders the acceptance record with both parties and acknowledged findings", () => {
    expect(output).toContain("Delivered by: Ada Builder (Studio A) · 2026-08-30");
    expect(output).toContain("Accepted by: Grace Client · 2026-08-31");
    expect(output).toContain("Findings acknowledged at acceptance: `risk:env`, `claim:rate-limit`");
  });

  it("shows the not-yet-accepted state when acceptedBy is absent", () => {
    const pending = fixturePassport();
    pending.acceptance = {
      deliveredBy: { name: "Ada Builder", date: "2026-08-30" },
      acknowledgedFindings: [],
    };
    const rendered = renderPassportMarkdown(pending);
    expect(rendered).toContain("Not yet accepted.");
    expect(rendered).not.toContain("Accepted by:");
  });

  it("omits the acceptance section when the passport has none", () => {
    const bare = fixturePassport();
    delete bare.acceptance;
    expect(renderPassportMarkdown(bare)).not.toContain("## Acceptance");
  });

  it("renders creator refs and the passport digest", () => {
    const withCreatorRef = fixturePassport();
    withCreatorRef.claims[0]!.refs = [{ kind: "creator", assertionId: "accept-1" }];
    expect(renderPassportMarkdown(withCreatorRef)).toContain("assertion `accept-1`");
    expect(output).toContain("a".repeat(64));
  });

  it("contains no em dashes (content style rule)", () => {
    expect(output).not.toContain("—");
  });
});
