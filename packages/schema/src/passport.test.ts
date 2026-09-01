import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  digestPassport,
  parsePassport,
  passportJsonSchema,
  PassportSchema,
} from "./index.js";

const GOLDEN_URL = new URL(
  "../../../examples/sample-passport/passport.json",
  import.meta.url
);

async function loadGolden(): Promise<unknown> {
  return JSON.parse(await readFile(fileURLToPath(GOLDEN_URL), "utf8"));
}

describe("passport schema v1", () => {
  it("validates the golden sample passport", async () => {
    const passport = parsePassport(await loadGolden());
    expect(passport.project.name).toBe("notes-api");
    // The fixture's planted false claims survive regeneration of the golden.
    expect(passport.claims.some((c) => c.status === "contradicted")).toBe(true);
  });

  it("rejects a non-unresolved assertion without source refs", async () => {
    const golden = (await loadGolden()) as {
      claims: Array<{ refs: unknown[] }>;
    };
    golden.claims[0]!.refs = [];
    const result = PassportSchema.safeParse(golden);
    expect(result.success).toBe(false);
  });

  it("allows an unresolved assertion without refs", async () => {
    const golden = (await loadGolden()) as {
      claims: Array<{ status: string; refs: unknown[]; contradictions: unknown[] }>;
    };
    golden.claims[0]!.status = "unresolved";
    golden.claims[0]!.refs = [];
    golden.claims[0]!.contradictions = [];
    expect(PassportSchema.safeParse(golden).success).toBe(true);
  });

  it("refuses a verified architecture narrative — interpretation stays inferred", async () => {
    // Inject a narrative claiming verification; the type locks it to inferred.
    const golden = (await loadGolden()) as {
      architecture: { narrative?: { status: string; text: string; refs: unknown[] } };
    };
    golden.architecture.narrative = {
      status: "locally-verified",
      text: "a narrative claiming to be verified",
      refs: [{ kind: "file", path: "src/server.ts" }],
    };
    expect(PassportSchema.safeParse(golden).success).toBe(false);

    golden.architecture.narrative.status = "inferred";
    expect(PassportSchema.safeParse(golden).success).toBe(true);
  });

  it("digestPassport is stable and excludes integrity.passportDigest", async () => {
    const passport = parsePassport(await loadGolden());
    const digest = digestPassport(passport);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const stamped = {
      ...passport,
      integrity: { ...passport.integrity, passportDigest: digest },
    };
    expect(digestPassport(stamped)).toBe(digest);
  });

  it("exports JSON Schema draft 2020-12", () => {
    const schema = passportJsonSchema();
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(JSON.stringify(schema)).toContain("schemaVersion");
  });
});
