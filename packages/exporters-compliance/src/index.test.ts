import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePassport } from "@mantyl/schema";
import {
  buildAibom,
  buildProvenanceRecord,
  renderProcurementSheet,
  renderProvenanceMarkdown,
} from "./index.js";

const GOLDEN = fileURLToPath(
  new URL("../../../examples/sample-passport/passport.json", import.meta.url)
);

async function golden() {
  return parsePassport(JSON.parse(await readFile(GOLDEN, "utf8")));
}

describe("compliance export pack on the golden passport", () => {
  it("is deterministic: same passport in, byte-identical documents out", async () => {
    const passport = await golden();
    expect(JSON.stringify(buildProvenanceRecord(passport))).toBe(
      JSON.stringify(buildProvenanceRecord(passport))
    );
    expect(JSON.stringify(buildAibom(passport))).toBe(JSON.stringify(buildAibom(passport)));
    expect(renderProcurementSheet(passport)).toBe(renderProcurementSheet(passport));
    expect(renderProvenanceMarkdown(buildProvenanceRecord(passport))).toBe(
      renderProvenanceMarkdown(buildProvenanceRecord(passport))
    );
  });

  it("provenance record binds the exact passport and surfaces contradictions", async () => {
    const passport = await golden();
    const record = buildProvenanceRecord(passport);
    expect(record.kind).toBe("mantyl-ai-provenance");
    expect(record.subject.project).toBe(passport.project.name);
    expect(record.subject.passportDigest).toBe(passport.integrity.passportDigest ?? null);
    expect(record.subject.generatedAt).toBe(passport.run.timestamp);
    // The golden fixture's claims and decisions come from agent sessions,
    // so involvement must read as evidenced (session refs on decisions
    // count even when creator-confirmed: the words came from the session).
    expect(record.aiInvolvement.evidenced).toBe(true);
    // The golden fixture carries the seeded contradicted rate-limiting claim.
    expect(record.contradictions.length).toBeGreaterThan(0);
    expect(record.contradictions.some((c) => /rate.?limit/i.test(c.text))).toBe(true);
    // All eight truth statuses are defined, and the honesty text is present.
    expect(Object.keys(record.statusDefinitions)).toHaveLength(8);
    expect(record.limitations.some((l) => /not a conformity assessment/.test(l))).toBe(true);
  });

  it("aibom is valid-shaped CycloneDX 1.6 with a digest-derived serial", async () => {
    const passport = await golden();
    const bom = buildAibom(passport) as {
      bomFormat: string;
      specVersion: string;
      serialNumber?: string;
      metadata: { component: { name: string; properties: Array<{ name: string; value: string }> } };
      components: unknown[];
      annotations: Array<{ text: string }>;
    };
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.6");
    const digest = passport.integrity.passportDigest!;
    expect(bom.serialNumber).toBe(
      `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
    );
    expect(bom.metadata.component.name).toBe(passport.project.name);
    expect(bom.components).toHaveLength(passport.architecture.modules.length);
    const propNames = bom.metadata.component.properties.map((p) => p.name);
    expect(propNames).toContain("mantyl:passportDigest");
    expect(propNames).toContain("mantyl:aiAssisted");
    expect(bom.annotations[0]?.text.length).toBeGreaterThan(0);
  });

  it("our template text follows the content rules: no em dashes", async () => {
    // Quoted passport data (claims, risks) is evidence and is passed through
    // verbatim even if it contains em dashes; the rule binds OUR words. A
    // passport stripped of data-bearing text isolates the templates.
    const passport = await golden();
    const stripped = {
      ...passport,
      claims: [],
      risks: [],
      decisions: [],
      incomplete: [],
      architecture: { modules: passport.architecture.modules },
    } as typeof passport;
    const provenance = renderProvenanceMarkdown(buildProvenanceRecord(stripped));
    const procurement = renderProcurementSheet(stripped);
    expect(provenance.includes("—")).toBe(false);
    expect(procurement.includes("—")).toBe(false);
  });

  it("procurement sheet answers the reproduction question with the one command", async () => {
    const passport = await golden();
    const sheet = renderProcurementSheet(passport);
    expect(sheet).toContain("npx mantyl receive");
    expect(sheet).toContain(passport.integrity.passportDigest!);
    expect(sheet).toContain("Was AI used to build this software?");
    expect(sheet).toContain("What data left the developer's machine");
  });

  it("states absence of agent evidence honestly instead of claiming no AI", async () => {
    const passport = await golden();
    const stripped = {
      ...passport,
      claims: [],
      decisions: [],
      architecture: { ...passport.architecture, narrative: undefined },
    } as typeof passport;
    const record = buildProvenanceRecord(stripped);
    expect(record.aiInvolvement.evidenced).toBe(false);
    expect(record.aiInvolvement.disclosure).toContain("not proof that no AI assistance occurred");
  });
});
