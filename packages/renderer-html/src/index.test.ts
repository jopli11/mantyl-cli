import { describe, expect, it } from "vitest";
import { fixturePassport } from "./fixture.js";
import { renderPassportHtml } from "./index.js";

describe("renderPassportHtml", () => {
  const passport = fixturePassport();
  const output = renderPassportHtml(passport);

  it("is deterministic: same passport in, byte-identical HTML out", () => {
    expect(renderPassportHtml(fixturePassport())).toBe(output);
  });

  it("renders every section heading in the proof-first order", () => {
    const headings = [...output.matchAll(/<h2>(.+?)<\/h2>/g)].map((m) => m[1]);
    expect(headings).toEqual([
      "Architecture (inferred)",
      "Verification",
      "Modules",
      "Decisions",
      "Claims",
      "Risks &amp; unknowns",
      "Incomplete work",
      "Setup",
      "Environment",
      "Acceptance",
    ]);
  });

  it("escapes untrusted text everywhere it lands", () => {
    expect(output).not.toContain("<script>alert");
    expect(output).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(output).toContain("notes-api &lt;fixture&gt;");
    expect(output).toContain("signed tokens &amp; sessions");
  });

  it("badges statuses and surfaces the contradiction", () => {
    expect(output).toContain(`<span class="badge badge-neg">CONTRADICTED</span>`);
    expect(output).toContain("contradicted by: package.json");
    expect(output).toContain(`<span class="badge badge-dim">CREATOR</span>`);
    expect(output).toContain("NOT documented");
  });

  it("renders the acceptance record with both parties and acknowledged findings", () => {
    expect(output).toContain("Delivered by: Ada Builder (Studio A) · 2026-08-30");
    expect(output).toContain("Accepted by: Grace Client · 2026-08-31");
    expect(output).toContain("<code>risk:env</code> · <code>claim:rate-limit</code>");
  });

  it("shows the not-yet-accepted state when acceptedBy is absent", () => {
    const pending = fixturePassport();
    pending.acceptance = {
      deliveredBy: { name: "Ada Builder", date: "2026-08-30" },
      acknowledgedFindings: [],
    };
    const rendered = renderPassportHtml(pending);
    expect(rendered).toContain("Not yet accepted.");
    expect(rendered).not.toContain("Accepted by:");
  });

  it("omits the acceptance section when the passport has none", () => {
    const bare = fixturePassport();
    delete bare.acceptance;
    expect(renderPassportHtml(bare)).not.toContain("<h2>Acceptance</h2>");
  });

  it("renders creator refs", () => {
    const withCreatorRef = fixturePassport();
    withCreatorRef.claims[0]!.refs = [{ kind: "creator", assertionId: "accept-1" }];
    expect(renderPassportHtml(withCreatorRef)).toContain("assertion accept-1");
  });

  it("is self-contained: inline styles, no external requests", () => {
    expect(output).toContain("<style>");
    expect(output).not.toMatch(/src=|href=|url\(/);
  });

  it("contains no em dashes in rendered text (content style rule)", () => {
    expect(output).not.toContain("—");
  });
});
