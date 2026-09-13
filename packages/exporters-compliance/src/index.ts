/**
 * @mantyl/exporters-compliance — the compliance export pack (Phase 3).
 * Three PURE consumers of passport.json, in the renderer family:
 * deterministic (same passport in, byte-identical documents out), no
 * network, no LLM, no wall clock. Every timestamp comes from the
 * passport's own run record.
 *
 * What these documents are, honestly: mappings of evidence the passport
 * already carries into the shapes procurement, legal and supply-chain
 * tooling ask for. They support an EU AI Act transparency posture and a
 * software supply-chain review; they are NOT a conformity assessment,
 * a certification, or legal advice, and each document says so itself.
 */

import type { Passport, SourceRef, TruthStatus } from "@mantyl/schema";

/* ------------------------------------------------------------------ */
/* Shared derivations                                                  */
/* ------------------------------------------------------------------ */

const STATUS_MEANING: Record<TruthStatus, string> = {
  "mantyl-verified":
    "independently re-executed and signed by Mantyl's verification service",
  "locally-verified": "proven by execution in an isolated sandbox on the producing machine",
  "repository-confirmed": "directly observable in the repository's files",
  "agent-reported": "stated by a coding agent during the build; not independently proven",
  "creator-confirmed": "stated by the human creator on record",
  inferred: "an interpretation (possibly LLM-assisted); never treated as proof",
  contradicted: "asserted during the build but contradicted by repository evidence",
  unresolved: "an open question the evidence could not settle",
};

function refText(r: SourceRef): string {
  switch (r.kind) {
    case "file":
      return r.lines ? `${r.path}:${r.lines[0]}` : r.path;
    case "commit":
      return `commit ${r.sha.slice(0, 7)}`;
    case "session":
      return `agent session ${r.sessionId}#${r.messageId}`;
    case "check":
      return `executed check ${r.checkId}`;
    case "creator":
      return `creator assertion ${r.assertionId}`;
  }
}

function hasSessionRef(refs: SourceRef[]): boolean {
  return refs.some((r) => r.kind === "session");
}

interface VerificationSummary {
  planned: number;
  selected: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  environments: string[];
}

function summariseVerification(passport: Passport): VerificationSummary {
  const results = passport.verification.results;
  const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
  const environments = [
    ...new Set(
      results
        .map((r) => r.envFingerprint)
        .filter((f): f is string => f !== undefined && f.startsWith("docker:"))
    ),
  ].sort();
  return {
    planned: passport.verification.plan.length,
    selected: passport.verification.plan.filter((c) => c.selected).length,
    executed: results.filter((r) => r.outcome !== "skipped").length,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    errored: count("error"),
    environments,
  };
}

interface AiInvolvementSummary {
  evidenced: boolean;
  agentReportedClaims: number;
  sessionEvidencedClaims: number;
  contradictedClaims: number;
  sessionEvidencedDecisions: number;
  agentReportedDecisions: number;
  creatorConfirmedDecisions: number;
  narrativeIsLlmInferred: boolean;
  disclosure: string;
}

function summariseAiInvolvement(passport: Passport): AiInvolvementSummary {
  const claims = passport.claims;
  const decisions = passport.decisions;
  const summary: AiInvolvementSummary = {
    evidenced: false,
    agentReportedClaims: claims.filter((c) => c.status === "agent-reported").length,
    sessionEvidencedClaims: claims.filter((c) => hasSessionRef(c.refs)).length,
    contradictedClaims: claims.filter((c) => c.status === "contradicted").length,
    // Creator-confirmed decisions count too: they are the creator's own
    // words RECOVERED FROM agent session history, which is exactly the
    // AI-involvement trail this record discloses (caught by dogfooding on
    // mantyl's own passport, whose 20 session-recovered decisions read as
    // "no session evidence" before this line existed).
    sessionEvidencedDecisions: decisions.filter((d) => hasSessionRef(d.refs)).length,
    agentReportedDecisions: decisions.filter((d) => d.status === "agent-reported").length,
    creatorConfirmedDecisions: decisions.filter((d) => d.status === "creator-confirmed").length,
    narrativeIsLlmInferred: passport.architecture.narrative !== undefined,
    disclosure: "",
  };
  summary.evidenced =
    summary.sessionEvidencedClaims > 0 ||
    summary.agentReportedClaims > 0 ||
    summary.sessionEvidencedDecisions > 0 ||
    summary.agentReportedDecisions > 0;
  summary.disclosure = summary.evidenced
    ? `This software was developed with AI coding-agent assistance. The evidence trail records ${summary.sessionEvidencedClaims} claim(s) and ${summary.sessionEvidencedDecisions} decision(s) recovered from coding-agent session history, each labelled with its truth status and source references in the project passport.`
    : "The project passport records no coding-agent session evidence for this repository. Absence of session evidence is not proof that no AI assistance occurred; it means none was found in the local agent history at generation time.";
  return summary;
}

const LIMITATIONS = [
  "This document is generated evidence mapping, not a conformity assessment, a certification, or legal advice.",
  "It describes the repository at exactly the recorded commit and generation time; later changes are outside its scope.",
  "Truth statuses grade the strength of each piece of evidence; only executed checks and signed verifications constitute proof.",
  "Coding-agent involvement is reconstructed from local session history and repository evidence; it is a floor, not a ceiling.",
] as const;

/* ------------------------------------------------------------------ */
/* 1. AI provenance record (EU AI Act transparency support)            */
/* ------------------------------------------------------------------ */

export interface ProvenanceRecord {
  kind: "mantyl-ai-provenance";
  recordVersion: "1";
  purpose: string;
  subject: {
    project: string;
    description?: string;
    stack: string[];
    commit: string | null;
    generatedAt: string;
    toolVersion: string;
    passportDigest: string | null;
    schemaVersion: string;
  };
  aiInvolvement: AiInvolvementSummary;
  verification: VerificationSummary & {
    checks: Array<{
      id: string;
      command: string;
      outcome: string;
      exitCode?: number;
      environment?: string;
      logsDigest?: string;
    }>;
  };
  humanOversight: {
    creatorConfirmedDecisions: number;
    acceptance: {
      deliveredBy?: string;
      acceptedBy?: string;
      acknowledgedFindings: number;
    } | null;
  };
  contradictions: Array<{ text: string; evidence: string[] }>;
  openRisks: Array<{ severity: string; text: string }>;
  statusDefinitions: Record<TruthStatus, string>;
  limitations: string[];
}

export function buildProvenanceRecord(passport: Passport): ProvenanceRecord {
  const acceptance = passport.acceptance ?? null;
  return {
    kind: "mantyl-ai-provenance",
    recordVersion: "1",
    purpose:
      "A machine-readable provenance record for an AI-assisted software delivery, supporting transparency obligations (including those arising under the EU AI Act) with evidence rather than declarations. Every statement derives from the referenced project passport and can be independently re-verified with the mantyl CLI.",
    subject: {
      project: passport.project.name,
      ...(passport.project.description ? { description: passport.project.description } : {}),
      stack: passport.project.stack,
      commit: passport.run.commit,
      generatedAt: passport.run.timestamp,
      toolVersion: passport.run.toolVersion,
      passportDigest: passport.integrity.passportDigest ?? null,
      schemaVersion: passport.schemaVersion,
    },
    aiInvolvement: summariseAiInvolvement(passport),
    verification: {
      ...summariseVerification(passport),
      checks: passport.verification.results.map((r) => ({
        id: r.checkId,
        command: r.command,
        outcome: r.outcome,
        ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
        ...(r.envFingerprint !== undefined ? { environment: r.envFingerprint } : {}),
        ...(r.logsDigest !== undefined ? { logsDigest: r.logsDigest } : {}),
      })),
    },
    humanOversight: {
      creatorConfirmedDecisions: passport.decisions.filter(
        (d) => d.status === "creator-confirmed"
      ).length,
      acceptance: acceptance
        ? {
            deliveredBy: acceptance.deliveredBy.name,
            ...(acceptance.acceptedBy ? { acceptedBy: acceptance.acceptedBy.name } : {}),
            acknowledgedFindings: acceptance.acknowledgedFindings.length,
          }
        : null,
    },
    contradictions: passport.claims
      .filter((c) => c.status === "contradicted")
      .map((c) => ({ text: c.text, evidence: c.contradictions.map(refText) })),
    openRisks: passport.risks.map((r) => ({ severity: r.severity, text: r.text })),
    statusDefinitions: STATUS_MEANING,
    limitations: [...LIMITATIONS],
  };
}

export function renderProvenanceMarkdown(record: ProvenanceRecord): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`# AI provenance record · ${record.subject.project}`);
  push();
  push(`> Generated by Mantyl ${record.subject.toolVersion} · ${record.subject.generatedAt}`);
  push(`> Commit: ${record.subject.commit ?? "not a git repository"}`);
  push(`> Passport digest: \`${record.subject.passportDigest ?? "unstamped"}\``);
  push();
  push(record.purpose);
  push();

  push(`## AI involvement`);
  push();
  push(record.aiInvolvement.disclosure);
  push();
  push(`| Evidence | Count |`);
  push(`| --- | --- |`);
  push(`| Claims recovered from agent sessions | ${record.aiInvolvement.sessionEvidencedClaims} |`);
  push(`| Claims still agent-reported (not independently proven) | ${record.aiInvolvement.agentReportedClaims} |`);
  push(`| Claims contradicted by repository evidence | ${record.aiInvolvement.contradictedClaims} |`);
  push(`| Decisions recovered from agent sessions | ${record.aiInvolvement.sessionEvidencedDecisions} |`);
  push(`| Decisions recovered, agent-reported | ${record.aiInvolvement.agentReportedDecisions} |`);
  push(`| Decisions recovered, creator-confirmed | ${record.aiInvolvement.creatorConfirmedDecisions} |`);
  push(`| Architecture narrative LLM-inferred | ${record.aiInvolvement.narrativeIsLlmInferred ? "yes, labelled inferred" : "no narrative present"} |`);
  push();

  push(`## Independent verification`);
  push();
  const v = record.verification;
  push(
    `${v.executed} of ${v.selected} selected checks executed in an isolated sandbox: ${v.passed} passed, ${v.failed} failed, ${v.errored} errored, ${v.skipped} skipped.`
  );
  if (v.environments.length > 0) {
    push(`Execution environments: ${v.environments.join(", ")}.`);
  }
  push();
  if (v.checks.length > 0) {
    push(`| Check | Command | Outcome |`);
    push(`| --- | --- | --- |`);
    for (const check of v.checks) {
      const exit = check.exitCode !== undefined ? ` (exit ${check.exitCode})` : "";
      push(`| \`${check.id}\` | \`${check.command}\` | ${check.outcome}${exit} |`);
    }
    push();
  }

  if (record.contradictions.length > 0) {
    push(`## Contradictions on record`);
    push();
    push(
      `Transparency includes what did not hold. ${record.contradictions.length} claim(s) made during the build were contradicted by repository evidence:`
    );
    push();
    for (const c of record.contradictions) {
      push(`| Claim | Contradicting evidence |`);
      push(`| --- | --- |`);
      push(`| ${c.text} | ${c.evidence.join(", ") || "recorded in the passport"} |`);
    }
    push();
  }

  push(`## Human oversight`);
  push();
  push(
    `${record.humanOversight.creatorConfirmedDecisions} decision(s) carry the creator's own recorded words.` +
      (record.humanOversight.acceptance
        ? ` The delivery carries an acceptance record: delivered by ${record.humanOversight.acceptance.deliveredBy}` +
          (record.humanOversight.acceptance.acceptedBy
            ? `, accepted by ${record.humanOversight.acceptance.acceptedBy}`
            : "") +
          ` with ${record.humanOversight.acceptance.acknowledgedFindings} finding(s) acknowledged.`
        : ` No acceptance record is attached to this passport.`)
  );
  push();

  if (record.openRisks.length > 0) {
    push(`## Open risks at generation time`);
    push();
    push(`| Severity | Risk |`);
    push(`| --- | --- |`);
    for (const risk of record.openRisks) {
      push(`| ${risk.severity} | ${risk.text} |`);
    }
    push();
  }

  push(`## Truth status definitions`);
  push();
  push(`| Status | Meaning |`);
  push(`| --- | --- |`);
  for (const [status, meaning] of Object.entries(record.statusDefinitions)) {
    push(`| ${status} | ${meaning} |`);
  }
  push();

  push(`## What this record does not claim`);
  push();
  for (const limit of record.limitations) {
    push(`${limit}`);
    push();
  }

  push(
    `Re-verify independently: obtain the repository and its passport, then run \`npx mantyl receive\`. The recorded checks re-execute on your infrastructure and any divergence from digest \`${record.subject.passportDigest ?? "unstamped"}\` is reported.`
  );
  push();
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 2. CycloneDX AIBOM                                                  */
/* ------------------------------------------------------------------ */

/** Deterministic urn:uuid derived from the passport digest (no wall clock, no randomness). */
function serialFromDigest(digest: string | undefined): string | undefined {
  if (!digest || digest.length < 32) return undefined;
  const d = digest.toLowerCase();
  return `urn:uuid:${d.slice(0, 8)}-${d.slice(8, 12)}-${d.slice(12, 16)}-${d.slice(16, 20)}-${d.slice(20, 32)}`;
}

function prop(name: string, value: string): { name: string; value: string } {
  return { name, value };
}

/**
 * A CycloneDX 1.6 BOM describing the delivery as an AI-assisted build:
 * the project as the root component, Mantyl as the producing tool, the
 * module map as components, and the AI involvement plus verification
 * evidence carried in namespaced properties and one annotation. Valid
 * CycloneDX, ingestible by standard SBOM tooling.
 */
export function buildAibom(passport: Passport): Record<string, unknown> {
  const ai = summariseAiInvolvement(passport);
  const v = summariseVerification(passport);
  const serial = serialFromDigest(passport.integrity.passportDigest);
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    ...(serial ? { serialNumber: serial } : {}),
    version: 1,
    metadata: {
      timestamp: passport.run.timestamp,
      tools: {
        components: [
          {
            type: "application",
            name: "mantyl",
            version: passport.run.toolVersion,
            description: "Local-first project passports for AI-built software",
          },
        ],
      },
      component: {
        type: "application",
        "bom-ref": "mantyl:project",
        name: passport.project.name,
        ...(passport.run.commit ? { version: passport.run.commit.slice(0, 7) } : {}),
        ...(passport.project.description
          ? { description: passport.project.description }
          : {}),
        properties: [
          prop("mantyl:passportDigest", passport.integrity.passportDigest ?? "unstamped"),
          prop("mantyl:schemaVersion", passport.schemaVersion),
          prop("mantyl:stack", passport.project.stack.join(",")),
          prop("mantyl:aiAssisted", ai.evidenced ? "true" : "unevidenced"),
          prop("mantyl:claims:sessionEvidenced", String(ai.sessionEvidencedClaims)),
          prop("mantyl:claims:contradicted", String(ai.contradictedClaims)),
          prop("mantyl:decisions:agentReported", String(ai.agentReportedDecisions)),
          prop("mantyl:decisions:creatorConfirmed", String(ai.creatorConfirmedDecisions)),
          prop("mantyl:checks:selected", String(v.selected)),
          prop("mantyl:checks:passed", String(v.passed)),
          prop("mantyl:checks:failed", String(v.failed)),
          prop("mantyl:checks:skipped", String(v.skipped)),
        ],
      },
    },
    components: passport.architecture.modules.map((m) => ({
      type: "library",
      "bom-ref": m.id,
      name: m.name,
      properties: [prop("mantyl:path", m.path), prop("mantyl:truthStatus", m.status)],
    })),
    annotations: [
      {
        "bom-ref": "mantyl:annotation:ai-disclosure",
        subjects: ["mantyl:project"],
        annotator: {
          component: { type: "application", name: "mantyl", version: passport.run.toolVersion },
        },
        timestamp: passport.run.timestamp,
        text: ai.disclosure,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 3. Procurement answer sheet                                         */
/* ------------------------------------------------------------------ */

export function renderProcurementSheet(passport: Passport): string {
  const ai = summariseAiInvolvement(passport);
  const v = summariseVerification(passport);
  const digest = passport.integrity.passportDigest ?? "unstamped";
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);
  const qa = (q: string, a: string) => {
    push(`## ${q}`);
    push();
    push(a);
    push();
  };

  push(`# Procurement answer sheet · ${passport.project.name}`);
  push();
  push(
    `> Answers derived from the project passport generated by Mantyl ${passport.run.toolVersion} at ${passport.run.timestamp}, commit ${passport.run.commit ?? "n/a"}, passport digest \`${digest}\`. Every answer is checkable against that document and re-verifiable with one command.`
  );
  push();

  qa(
    "What is this document?",
    "A standard answer sheet for software procurement and security review, filled from recorded evidence rather than free text. The underlying passport labels every statement with a truth status and source references; this sheet inherits that honesty and never states more than the evidence supports."
  );

  qa(
    "Was AI used to build this software?",
    ai.disclosure +
      (ai.narrativeIsLlmInferred
        ? " The passport's architecture narrative was LLM-assisted and is labelled inferred, a status that can never be treated as proof."
        : "")
  );

  qa(
    "What was independently executed, and what was the result?",
    v.executed > 0
      ? `${v.executed} check(s) executed in an isolated Docker sandbox with the network cut after dependency installation: ${v.passed} passed, ${v.failed} failed, ${v.errored} errored. ${v.skipped} check(s) were recorded as skipped rather than silently omitted. Environments: ${v.environments.join(", ") || "recorded per check"}. Full commands, exit codes and log digests are in the passport's verification section.`
      : "No checks were executed for this passport (the plan records why, check by check). Treat all functional claims as unproven until a verified run exists."
  );

  qa(
    "Can we reproduce the verification ourselves?",
    `Yes, without an account and without contacting the supplier. With the repository and its passport in hand, run \`npx mantyl receive\`. The recorded checks re-execute on your own infrastructure, the file manifest and commit are compared, and any divergence from passport digest \`${digest}\` is reported with the exact file names. A diverged delivery exits non-zero.`
  );

  qa(
    "What ties this document to the exact delivered code?",
    passport.integrity.fileManifestDigest
      ? `Three digests: a per-file manifest digest (\`${passport.integrity.fileManifestDigest.slice(0, 16)}...\`) fingerprinting every tracked file, an evidence digest over the raw evidence artefacts, and the passport digest itself. Editing any delivered file, or the passport, breaks the corresponding digest on the recipient's recheck.`
      : "The passport digest binds this document's source; a file manifest digest was not stamped for this run."
  );

  qa(
    "What known issues ship with this delivery?",
    [
      passport.risks.length > 0
        ? `${passport.risks.length} open risk(s): ${passport.risks.map((r) => `${r.text} (${r.severity})`).join("; ")}.`
        : "No open risks were derived at generation time.",
      passport.incomplete.length > 0
        ? `${passport.incomplete.length} item(s) recorded as incomplete.`
        : "",
      ai.contradictedClaims > 0
        ? `${ai.contradictedClaims} build-time claim(s) were contradicted by repository evidence and are listed in the passport rather than removed.`
        : "",
    ]
      .filter(Boolean)
      .join(" ")
  );

  qa(
    "What data left the developer's machine to produce this?",
    "Nothing, by design. Scanning, verification and passport generation run locally; coding-agent transcripts pass through fail-closed secret redaction before anything is stored. Publishing a passport to a shareable link and purchasing an independently signed verification are separate, explicit actions, and neither ever uploads source code except the consented tracked-file bundle of a paid verification run."
  );

  qa(
    "What does this sheet not claim?",
    LIMITATIONS.join(" ")
  );

  return lines.join("\n");
}
