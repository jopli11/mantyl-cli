/**
 * `mantyl publish` — the explicit, opt-in bridge from local passport to
 * hosted passport (spec §5 step 11).
 *
 * Rules:
 * - publishing NEVER uploads source code: the payload is the passport
 *   document alone, which already carries only redacted evidence
 * - the passport must pass its own digest self-check locally before it
 *   leaves the machine — a forged or hand-edited passport is refused here,
 *   and refused again independently by the server
 * - human approval happens in the CLI; this module only prepares and sends
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, digestPassport, parsePassport, type Passport } from "@mantyl/schema";

export class PassportInvalidError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = "PassportInvalidError";
  }
}

export interface PreparedPublish {
  passport: Passport;
  digest: string;
  /** Canonical JSON body — exactly what will be uploaded. */
  body: string;
}

/** Read and locally re-validate the passport before anything leaves disk. */
export async function preparePublish(
  projectRoot: string,
  options: { artifactsDir?: string } = {}
): Promise<PreparedPublish> {
  const artifactsDir = options.artifactsDir ?? join(projectRoot, ".mantyl");
  const path = join(artifactsDir, "passport.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new PassportInvalidError(
      `no passport found at ${path} — run \`mantyl generate\` first`
    );
  }

  let passport: Passport;
  try {
    passport = parsePassport(JSON.parse(raw));
  } catch (err) {
    throw new PassportInvalidError("passport.json does not match the passport schema", err);
  }

  const recorded = passport.integrity.passportDigest;
  if (recorded === undefined) {
    throw new PassportInvalidError("passport carries no digest — regenerate it");
  }
  const computed = digestPassport(passport);
  if (computed !== recorded) {
    throw new PassportInvalidError(
      "passport digest self-check FAILED — the file was modified after generation; regenerate it"
    );
  }

  return { passport, digest: recorded, body: canonicalJson(passport) };
}

export interface PublishResult {
  id: string;
  url: string;
  /** Shown exactly once; absent when the passport was already hosted. */
  deleteToken?: string;
  deduplicated: boolean;
}

/** Upload a prepared passport. The endpoint re-validates independently. */
export async function publishPassport(
  prepared: PreparedPublish,
  endpoint: string
): Promise<PublishResult> {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/passports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: prepared.body,
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? detail;
    } catch {
      // non-JSON error body — use the raw slice
    }
    throw new Error(`publish failed (${response.status}): ${detail}`);
  }
  return JSON.parse(text) as PublishResult;
}
