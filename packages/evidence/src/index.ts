/**
 * @mantyl/evidence — the evidence graph and reconciliation (spec §4, §6).
 * Links claims to evidence and assigns truth statuses. Pure functions over
 * data: no filesystem, no network, no LLM — everything here is deterministic
 * and explainable.
 *
 * The type system enforces the spec's core rule: analysis (LLM) output can
 * only ever be "inferred"; verified statuses require executed checks.
 */

import type { CheckResult, PlannedCheck, SourceRef, TruthStatus } from "@mantyl/schema";

/** Statuses an automated *analysis* (LLM) output may ever hold. */
export type AnalysisStatus = Extract<TruthStatus, "inferred">;

/** Statuses only deterministic execution may assign. */
export type ExecutionStatus = Extract<TruthStatus, "locally-verified" | "mantyl-verified">;

/* ---------------------------------------------------------------- inputs */

export interface FactInput {
  id: string;
  kind: string;
  statement: string;
  refs: SourceRef[];
  data?: Record<string, unknown>;
}

export interface ClaimInput {
  id: string;
  text: string;
  origin: "agent" | "readme";
  refs: SourceRef[];
}

export interface ReconcilerInput {
  facts: FactInput[];
  claims: ClaimInput[];
  verification: { plan: PlannedCheck[]; results: CheckResult[] } | null;
  /** Source-search hits per lexicon label, prepared by the caller. */
  termHits: Record<string, SourceRef[]>;
  /** Declared dependency names (package.json). */
  dependencyNames: string[];
  /** Ref pointing at the dependency manifest, used as contradiction evidence. */
  manifestRef: SourceRef | null;
}

/* --------------------------------------------------------------- outputs */

export interface ReconciledClaim {
  id: string;
  text: string;
  status: TruthStatus;
  refs: SourceRef[];
  contradictions: SourceRef[];
  note: string;
}

export interface ReconciledRisk {
  id: string;
  severity: "low" | "medium" | "high";
  text: string;
  status: TruthStatus;
  refs: SourceRef[];
  remediation?: string;
}

export interface ReconciledIncomplete {
  id: string;
  title: string;
  status: TruthStatus;
  refs: SourceRef[];
}

export interface UnresolvedItem {
  id: string;
  reason: string;
  remediation: string;
}

export interface Reconciliation {
  claims: ReconciledClaim[];
  risks: ReconciledRisk[];
  incomplete: ReconciledIncomplete[];
  unresolved: UnresolvedItem[];
}

/* ---------------------------------------------------------------- lexicon */

/**
 * The checkable-claim lexicon: mechanisms we can deterministically look for.
 * A claim mentioning a lexicon entry is CHECKED; claims outside the lexicon
 * honestly stay agent-reported (unchecked ≠ untrue ≠ true).
 */
export interface LexiconEntry {
  label: string;
  claimPattern: RegExp;
  dependencyPattern: RegExp;
}

export const CLAIM_LEXICON: LexiconEntry[] = [
  { label: "rate-limiting", claimPattern: /rate.?limit/i, dependencyPattern: /rate.?limit/i },
  { label: "redis", claimPattern: /\bredis\b/i, dependencyPattern: /^(io)?redis/i },
  { label: "postgres", claimPattern: /\bpostgres(ql)?\b/i, dependencyPattern: /^(pg|postgres)/i },
  { label: "stripe", claimPattern: /\bstripe\b/i, dependencyPattern: /^stripe$/i },
  { label: "websocket", claimPattern: /\bwebsockets?\b/i, dependencyPattern: /^(ws|socket\.io)/i },
  { label: "auth", claimPattern: /\b(auth|bearer|jwt|token)\b/i, dependencyPattern: /(jwt|auth|passport)/i },
  { label: "encryption", claimPattern: /\bencrypt/i, dependencyPattern: /crypt/i },
  { label: "backup", claimPattern: /\bbackups?\b/i, dependencyPattern: /backup/i },
];

/* -------------------------------------------------------------- reconcile */

function reconcileClaim(claim: ClaimInput, input: ReconcilerInput): ReconciledClaim {
  const entry = CLAIM_LEXICON.find((e) => e.claimPattern.test(claim.text));
  if (!entry) {
    return {
      ...claimBase(claim),
      status: "agent-reported",
      note: "outside the checkable lexicon — reported as stated, not checked",
    };
  }

  const sourceHits = input.termHits[entry.label] ?? [];
  const depHit = input.dependencyNames.some((dep) => entry.dependencyPattern.test(dep));

  if (sourceHits.length > 0 || depHit) {
    return {
      ...claimBase(claim),
      status: "agent-reported",
      refs: [...claim.refs, ...sourceHits.slice(0, 5)],
      note: `corroborated: ${entry.label} appears in ${depHit ? "dependencies" : "source"} — not independently executed`,
    };
  }

  return {
    ...claimBase(claim),
    status: "contradicted",
    contradictions: input.manifestRef ? [input.manifestRef] : [],
    note: `no trace of ${entry.label} in source or declared dependencies`,
  };
}

function claimBase(claim: ClaimInput): Omit<ReconciledClaim, "status" | "note"> {
  return { id: claim.id, text: claim.text, refs: claim.refs, contradictions: [] };
}

export function reconcile(input: ReconcilerInput): Reconciliation {
  const claims = input.claims.map((claim) => reconcileClaim(claim, input));

  const risks: ReconciledRisk[] = [];
  const incomplete: ReconciledIncomplete[] = [];
  const undocumentedEnv: FactInput[] = [];
  for (const fact of input.facts) {
    if (fact.kind === "env" && fact.data?.documented === false) {
      undocumentedEnv.push(fact);
    }
    if (fact.kind === "todo") {
      incomplete.push({
        id: `incomplete:${fact.id}`,
        title: fact.statement,
        status: "repository-confirmed",
        refs: fact.refs,
      });
    }
  }

  // A handful of undocumented variables are individual findings; a wall of
  // forty identical medium risks buries everything else (first-user data).
  // Past the threshold they aggregate into one risk that still names names.
  const ENV_RISK_AGGREGATE_THRESHOLD = 5;
  if (undocumentedEnv.length > ENV_RISK_AGGREGATE_THRESHOLD) {
    const names = undocumentedEnv.map((f) => String(f.data?.name));
    const shown = names.slice(0, 6);
    risks.push({
      id: "risk:env:undocumented",
      severity: "medium",
      text:
        `${names.length} environment variables are required but undocumented ` +
        `(${shown.join(", ")}${names.length > shown.length ? ` and ${names.length - shown.length} more` : ""}) — ` +
        `the next owner will discover them at runtime`,
      status: "repository-confirmed",
      refs: undocumentedEnv.flatMap((f) => f.refs.slice(0, 1)).slice(0, 10),
      remediation: "Document every required variable in .env.example",
    });
  } else {
    for (const fact of undocumentedEnv) {
      risks.push({
        id: `risk:${fact.id}`,
        severity: "medium",
        text: `${String(fact.data?.name)} is required but undocumented — the next owner will discover it at runtime`,
        status: "repository-confirmed",
        refs: fact.refs,
        remediation: `Document ${String(fact.data?.name)} in .env.example`,
      });
    }
  }

  const unresolved: UnresolvedItem[] = [];
  if (input.verification) {
    for (const result of input.verification.results) {
      if (result.outcome === "skipped") {
        unresolved.push({
          id: `unresolved:${result.checkId}`,
          reason: `check "${result.checkId}" could not run (${result.envFingerprint})`,
          remediation: "Make the sandbox available (start Docker) and rerun mantyl verify",
        });
      }
      if (result.outcome === "error") {
        unresolved.push({
          id: `unresolved:${result.checkId}`,
          reason: `check "${result.checkId}" did not complete (timeout or execution error)`,
          remediation: "Inspect the check log, raise verify.timeoutSeconds if needed, and rerun",
        });
      }
    }
  } else {
    unresolved.push({
      id: "unresolved:verification",
      reason: "no verification run found for this scan",
      remediation: "Run mantyl verify to execute checks in the sandbox",
    });
  }

  return {
    claims: claims.sort((a, b) => (a.id < b.id ? -1 : 1)),
    risks: risks.sort((a, b) => (a.id < b.id ? -1 : 1)),
    incomplete: incomplete.sort((a, b) => (a.id < b.id ? -1 : 1)),
    unresolved: unresolved.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}
