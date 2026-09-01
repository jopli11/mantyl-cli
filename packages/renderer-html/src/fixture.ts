/**
 * A schema-valid fixture passport exercising every rendered section,
 * including the ones production has never populated (acceptance, the
 * creator SourceRef). Parsed through PassportSchema so renderer tests
 * fail loudly if the fixture drifts from the contract.
 */

import { PassportSchema, SCHEMA_VERSION, type Passport } from "@mantyl/schema";

export function fixturePassport(): Passport {
  return PassportSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    run: {
      toolVersion: "0.0.0-test",
      timestamp: "2026-08-31T12:00:00.000Z",
      commit: "abc123def456abc123def456abc123def456abcd",
      configDigest: "c".repeat(64),
    },
    project: {
      name: "notes-api <fixture>",
      stack: ["node", "typescript"],
      services: [],
    },
    setup: {
      steps: [
        {
          id: "setup:install",
          status: "locally-verified",
          refs: [{ kind: "check", checkId: "check-install" }],
          command: "pnpm install",
        },
      ],
      env: [
        {
          id: "env:API_TOKEN",
          status: "repository-confirmed",
          refs: [{ kind: "file", path: "src/server.ts", lines: [3, 3] }],
          name: "API_TOKEN",
          documented: false,
        },
      ],
    },
    architecture: {
      narrative: {
        status: "inferred",
        text: 'A small HTTP API with <script>alert("xss")</script> risks noted.',
        refs: [],
      },
      modules: [
        {
          id: "module:src",
          status: "repository-confirmed",
          refs: [{ kind: "file", path: "src" }],
          name: "src",
          path: "src",
        },
      ],
    },
    decisions: [
      {
        id: "decision:1",
        status: "creator-confirmed",
        refs: [{ kind: "session", sessionId: "s1", messageId: "m1" }],
        title: "use sqlite for storage",
        rationale: "use sqlite for storage because it needs no server",
        date: "2026-08-01",
      },
    ],
    claims: [
      {
        id: "claim:rate-limit",
        status: "contradicted",
        refs: [{ kind: "session", sessionId: "s1", messageId: "m2" }],
        text: "I added rate limiting to the API",
        contradictions: [{ kind: "file", path: "package.json" }],
      },
      {
        id: "claim:auth",
        status: "agent-reported",
        refs: [{ kind: "session", sessionId: "s1", messageId: "m3" }],
        text: "Authentication uses signed tokens & sessions",
        contradictions: [],
      },
    ],
    risks: [
      {
        id: "risk:env",
        status: "repository-confirmed",
        refs: [{ kind: "file", path: "src/server.ts" }],
        severity: "medium",
        text: "API_TOKEN is referenced but not documented",
        remediation: "document it in .env.example",
      },
    ],
    incomplete: [
      {
        id: "todo:persistence",
        status: "repository-confirmed",
        refs: [{ kind: "file", path: "src/store.ts", lines: [10, 10] }],
        title: "TODO: persist notes to disk",
      },
    ],
    verification: {
      plan: [
        {
          id: "check-install",
          kind: "install",
          command: "pnpm install",
          reason: "lockfile present",
          selected: true,
        },
        {
          id: "check-lint",
          kind: "lint",
          command: "pnpm lint",
          reason: "no lint script",
          selected: false,
          skipReason: "no lint script in package.json",
        },
      ],
      results: [
        {
          checkId: "check-install",
          outcome: "passed",
          command: "pnpm install",
          exitCode: 0,
          startedAt: "2026-08-31T11:59:00.000Z",
          durationMs: 4200,
        },
        {
          checkId: "check-test",
          outcome: "failed",
          command: "pnpm test",
          exitCode: 1,
          startedAt: "2026-08-31T11:59:30.000Z",
          durationMs: 900,
        },
      ],
    },
    integrity: {
      passportDigest: "a".repeat(64),
      evidenceDigest: "b".repeat(64),
      fileManifestDigest: "d".repeat(64),
    },
    acceptance: {
      deliveredBy: { name: "Ada Builder", organisation: "Studio A", date: "2026-08-30" },
      acceptedBy: { name: "Grace Client", date: "2026-08-31" },
      acknowledgedFindings: ["risk:env", "claim:rate-limit"],
    },
  });
}
