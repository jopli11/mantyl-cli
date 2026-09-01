import { describe, expect, it } from "vitest";
import { reconcile, type ReconcilerInput } from "./index.js";

const MANIFEST_REF = { kind: "file", path: "package.json" } as const;

function baseInput(overrides: Partial<ReconcilerInput> = {}): ReconcilerInput {
  return {
    facts: [],
    claims: [],
    verification: { plan: [], results: [] },
    termHits: {},
    dependencyNames: [],
    manifestRef: MANIFEST_REF,
    ...overrides,
  };
}

const CLAIM = {
  id: "claim:agent:s1:m1:0",
  origin: "agent" as const,
  refs: [{ kind: "session", sessionId: "s1", messageId: "m1" } as const],
};

describe("reconcile — claims", () => {
  it("contradicts a lexicon claim with no trace in source or dependencies", () => {
    const out = reconcile(
      baseInput({ claims: [{ ...CLAIM, text: "I implemented rate limiting for all endpoints" }] })
    );
    const claim = out.claims[0]!;
    expect(claim.status).toBe("contradicted");
    expect(claim.contradictions).toEqual([MANIFEST_REF]);
    expect(claim.note).toContain("no trace of rate-limiting");
  });

  it("corroborates via dependencies without upgrading the status", () => {
    const out = reconcile(
      baseInput({
        claims: [{ ...CLAIM, text: "I implemented rate limiting for all endpoints" }],
        dependencyNames: ["express-rate-limit"],
      })
    );
    const claim = out.claims[0]!;
    expect(claim.status).toBe("agent-reported");
    expect(claim.note).toContain("corroborated");
    expect(claim.note).toContain("not independently executed");
  });

  it("corroborates via source hits and attaches them as refs", () => {
    const hit = { kind: "file", path: "src/limiter.ts", lines: [4, 4] } as const;
    const out = reconcile(
      baseInput({
        claims: [{ ...CLAIM, text: "I implemented rate limiting" }],
        termHits: { "rate-limiting": [hit] },
      })
    );
    const claim = out.claims[0]!;
    expect(claim.status).toBe("agent-reported");
    expect(claim.refs).toContainEqual(hit);
  });

  it("leaves non-lexicon claims agent-reported and says so honestly", () => {
    const out = reconcile(
      baseInput({ claims: [{ ...CLAIM, text: "I created a lovely onboarding flow" }] })
    );
    expect(out.claims[0]?.status).toBe("agent-reported");
    expect(out.claims[0]?.note).toContain("not checked");
  });
});

describe("reconcile — facts to findings", () => {
  it("turns undocumented env facts into repository-confirmed risks", () => {
    const out = reconcile(
      baseInput({
        facts: [
          {
            id: "fact:env:API_TOKEN",
            kind: "env",
            statement: "…",
            refs: [{ kind: "file", path: "src/server.ts", lines: [6, 6] }],
            data: { name: "API_TOKEN", documented: false },
          },
          {
            id: "fact:env:PORT",
            kind: "env",
            statement: "…",
            refs: [{ kind: "file", path: "src/server.ts", lines: [7, 7] }],
            data: { name: "PORT", documented: true },
          },
        ],
      })
    );
    expect(out.risks).toHaveLength(1);
    expect(out.risks[0]?.text).toContain("API_TOKEN");
    expect(out.risks[0]?.status).toBe("repository-confirmed");
    expect(out.risks[0]?.remediation).toContain(".env.example");
  });

  it("turns TODO facts into incomplete items", () => {
    const out = reconcile(
      baseInput({
        facts: [
          {
            id: "fact:todo:0",
            kind: "todo",
            statement: "TODO: persistence",
            refs: [{ kind: "file", path: "src/store.ts", lines: [1, 1] }],
          },
        ],
      })
    );
    expect(out.incomplete[0]?.title).toContain("persistence");
  });
});

describe("reconcile — unresolved", () => {
  it("records skipped checks as unresolved with remediation", () => {
    const out = reconcile(
      baseInput({
        verification: {
          plan: [],
          results: [
            {
              checkId: "check-build",
              outcome: "skipped",
              command: "npm run build",
              startedAt: "2026-07-21T10:00:00.000Z",
              durationMs: 0,
              envFingerprint: "unavailable: no docker",
            },
          ],
        },
      })
    );
    expect(out.unresolved[0]?.id).toBe("unresolved:check-build");
    expect(out.unresolved[0]?.remediation).toContain("Docker");
  });

  it("records a missing verification run as unresolved", () => {
    const out = reconcile(baseInput({ verification: null }));
    expect(out.unresolved[0]?.id).toBe("unresolved:verification");
    expect(out.unresolved[0]?.remediation).toContain("mantyl verify");
  });

  it("aggregates a wall of undocumented env vars into one risk that names names", () => {
    const facts = Array.from({ length: 8 }, (_, i) => ({
      id: `fact:env:VAR_${i}`,
      kind: "env",
      statement: `Environment variable VAR_${i} is referenced but NOT documented`,
      refs: [{ kind: "file" as const, path: `src/f${i}.ts`, lines: [1, 1] as [number, number] }],
      data: { name: `VAR_${i}`, documented: false },
    }));
    const out = reconcile(baseInput({ facts }));
    expect(out.risks).toHaveLength(1);
    expect(out.risks[0]?.id).toBe("risk:env:undocumented");
    expect(out.risks[0]?.text).toContain("8 environment variables");
    expect(out.risks[0]?.text).toContain("VAR_0");
    expect(out.risks[0]?.text).toContain("and 2 more");

    // A handful stays individual — small counts are individual findings.
    const few = facts.slice(0, 3);
    const outFew = reconcile(baseInput({ facts: few }));
    expect(outFew.risks).toHaveLength(3);
  });
});
