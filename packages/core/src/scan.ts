/**
 * `mantyl scan` — canonical data flow steps 1–4 (spec §5):
 * run context → collect → redact → extract facts and claims.
 * Artefacts are written to .mantyl/ as canonical JSON so identical inputs
 * produce byte-identical facts/claims files (determinism gate).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@mantyl/schema";
import { collectGit, listTrackedFiles, type GitObservation } from "@mantyl/collectors-git";
import {
  collectRepository,
  type RepositoryObservation,
} from "@mantyl/collectors-repository";
import {
  collectSessions,
  type Redactor,
  type SessionRecord,
} from "@mantyl/adapter-claude-code";
import { collectCursorSessions } from "@mantyl/adapter-cursor";
import { collectCodexSessions } from "@mantyl/adapter-codex";
import { createRunContext, type RunContext } from "./run-context.js";
import { redactText } from "./redaction.js";
import { detectCapabilities, type Capabilities } from "./capabilities.js";
import { extractFacts, type Fact } from "./facts.js";
import {
  claimsFromReadme,
  claimsFromSessions,
  type ClaimCandidate,
} from "./claims.js";
import { decisionsFromSessions, type DecisionCandidate } from "./decisions.js";

export interface SessionSummary {
  sessionId: string;
  source: SessionRecord["source"];
  path: string;
  messageCount: number;
  malformedLines: number;
}

export interface AdapterWarning {
  source: "cursor" | "codex";
  message: string;
}

export interface ScanResult {
  context: RunContext;
  git: GitObservation;
  repository: RepositoryObservation;
  sessions: SessionSummary[];
  capabilities: Capabilities;
  facts: Fact[];
  claims: ClaimCandidate[];
  decisions: DecisionCandidate[];
  artifactsDir: string;
  redactionEnabled: boolean;
  /**
   * A beta adapter that threw mid-collection (not one that is simply not
   * installed — those return empty quietly). Surfaced so a passport with
   * no agent history is never silently mistaken for a project with none.
   */
  adapterWarnings: AdapterWarning[];
}

export interface ScanOptions {
  toolVersion: string;
  /** Override the Claude Code session directory (tests, unusual setups). */
  sessionDir?: string;
  /** Override artefact output directory (default {projectRoot}/.mantyl). */
  artifactsDir?: string;
  now?: () => Date;
}

export async function scanProject(
  projectRoot: string,
  options: ScanOptions
): Promise<ScanResult> {
  const context = await createRunContext(projectRoot, {
    toolVersion: options.toolVersion,
    ...(options.now ? { now: options.now } : {}),
  });

  const redactionEnabled = context.config.config.redaction.enabled;
  // Fail-closed wiring: identity passthrough exists ONLY behind explicit config.
  const redactor: Redactor = redactionEnabled ? (text) => redactText(text).text : (text) => text;

  // A missing install returns [] from inside the adapters; a throw here is
  // a real failure (schema drift, a locked or corrupt store) and must not
  // silently produce a passport with no agent history.
  const adapterWarnings: AdapterWarning[] = [];
  const warned = (source: AdapterWarning["source"]) => (err: unknown) => {
    adapterWarnings.push({
      source,
      message: err instanceof Error ? err.message : String(err),
    });
    return [] as SessionRecord[];
  };

  const [git, repository, claudeSessions, cursorSessions, codexSessions, trackedPaths] = await Promise.all([
    collectGit(projectRoot),
    collectRepository(projectRoot, {
      exclude: context.config.config.scan.exclude,
    }),
    collectSessions(
      projectRoot,
      redactor,
      options.sessionDir ? { sessionDir: options.sessionDir } : {}
    ),
    collectCursorSessions(projectRoot, redactor).catch(warned("cursor")),
    collectCodexSessions(projectRoot, redactor).catch(warned("codex")),
    listTrackedFiles(projectRoot),
  ]);
  const sessionRecords: SessionRecord[] = [
    ...claudeSessions,
    ...cursorSessions,
    ...codexSessions,
  ];

  // Distinguish the delivered repository from local-machine state: a file on
  // disk that git does not track is not part of what the recipient receives.
  if (git.isRepo) {
    repository.files = repository.files.map((f) => ({
      ...f,
      tracked: trackedPaths.has(f.path),
    }));
  }

  const capabilities = detectCapabilities(repository);
  const facts = extractFacts(repository, git, capabilities);
  const claims = [
    ...claimsFromSessions(sessionRecords),
    ...(await claimsFromReadme(projectRoot, repository.readmePath)),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));
  const decisions = decisionsFromSessions(sessionRecords);

  const sessions: SessionSummary[] = sessionRecords.map((s: SessionRecord) => ({
    sessionId: s.sessionId,
    source: s.source,
    path: s.path,
    messageCount: s.messages.length,
    malformedLines: s.malformedLines,
  }));

  const artifactsDir = options.artifactsDir ?? join(projectRoot, ".mantyl");
  await mkdir(artifactsDir, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFile(join(artifactsDir, name), `${canonicalJson(value)}\n`, "utf8");

  await Promise.all([
    write("run.json", {
      toolVersion: context.toolVersion,
      commit: context.commit,
      dirty: context.dirty,
      configDigest: context.config.digest,
      startedAt: context.startedAt.toISOString(),
      redactionEnabled,
    }),
    write("capabilities.json", capabilities),
    write("facts.json", facts),
    write("claims.json", claims),
    write("decisions.json", decisions),
    write("sessions.json", sessions),
  ]);

  return {
    context,
    git,
    repository,
    sessions,
    capabilities,
    facts,
    claims,
    decisions,
    artifactsDir,
    redactionEnabled,
    adapterWarnings,
  };
}
