import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type TruthStatus } from "./index.js";

describe("@mantyl/schema", () => {
  it("declares a draft schema version until v1 is frozen", () => {
    expect(SCHEMA_VERSION).toMatch(/-draft$/);
  });

  it("models exactly the eight truth statuses from the spec", () => {
    const statuses: TruthStatus[] = [
      "mantyl-verified",
      "locally-verified",
      "repository-confirmed",
      "agent-reported",
      "creator-confirmed",
      "inferred",
      "contradicted",
      "unresolved",
    ];
    expect(new Set(statuses).size).toBe(8);
  });
});
