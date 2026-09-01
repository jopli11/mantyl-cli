import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, parseAcceptanceRecord } from "@mantyl/schema";
import { prepareAccept, recordAcceptance } from "./accept.js";
import { generateProject } from "./generate.js";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("../../../examples/sample-project", import.meta.url)
);
const FIXTURE_SESSIONS = fileURLToPath(
  new URL("../../adapter-claude-code/fixtures", import.meta.url)
);

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-accept-"));
  dirs.push(dir);
  return dir;
}
async function fixtureCopy(): Promise<string> {
  const dir = await tempDir();
  await cp(FIXTURE_PROJECT, dir, { recursive: true });
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const OPTIONS = {
  toolVersion: "0.0.0-test",
  sessionDir: FIXTURE_SESSIONS,
  now: () => new Date("2026-07-21T13:00:00.000Z"),
};

describe("prepareAccept", () => {
  it("surfaces every open finding on an untampered delivery", async () => {
    const project = await fixtureCopy();
    const generated = await generateProject(project, OPTIONS);

    const prepared = await prepareAccept(project, {
      toolVersion: "0.0.0-test",
      passportPath: generated.passportPath,
      skipChecks: true,
    });

    expect(prepared.refused).toBe(false);
    expect(prepared.passport).not.toBeNull();
    const kinds = new Set(prepared.openFindings.map((f) => f.kind));
    // The seeded fixture carries all three: the contradicted rate-limit
    // claims, the undocumented env risk, and the persistence TODO.
    expect(kinds).toContain("contradicted-claim");
    expect(kinds).toContain("risk");
    expect(kinds).toContain("incomplete");
    const ids = prepared.openFindings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses a tampered delivery and lists nothing to acknowledge", async () => {
    const project = await fixtureCopy();
    const generated = await generateProject(project, OPTIONS);
    await writeFile(
      join(project, "src", "store.ts"),
      "// tampered after handover\nexport const notes = [];\n"
    );

    const prepared = await prepareAccept(project, {
      toolVersion: "0.0.0-test",
      passportPath: generated.passportPath,
      skipChecks: true,
    });

    expect(prepared.refused).toBe(true);
    expect(prepared.openFindings).toEqual([]);
  });
});

describe("recordAcceptance", () => {
  it("writes a canonical record binding the exact passport digest", async () => {
    const project = await fixtureCopy();
    const generated = await generateProject(project, OPTIONS);
    const prepared = await prepareAccept(project, {
      toolVersion: "0.0.0-test",
      passportPath: generated.passportPath,
      skipChecks: true,
    });
    expect(prepared.passport).not.toBeNull();

    const { record, path } = await recordAcceptance(project, prepared.passport!, {
      acceptedBy: { name: "Grace Client", organisation: "Client Co" },
      acknowledgedFindings: prepared.openFindings.map((f) => f.id),
      now: () => new Date("2026-08-31T15:00:00.000Z"),
    });

    expect(record.kind).toBe("mantyl-acceptance");
    expect(record.passportDigest).toBe(generated.passport.integrity.passportDigest);
    expect(record.acceptedBy).toEqual({
      name: "Grace Client",
      organisation: "Client Co",
      date: "2026-08-31",
    });
    expect(record.acknowledgedFindings).toEqual([...record.acknowledgedFindings].sort());
    expect(record.acknowledgedFindings.length).toBe(prepared.openFindings.length);

    // On disk: canonical JSON, schema-valid on re-parse, byte-stable.
    const raw = await readFile(path, "utf8");
    expect(raw).toBe(`${canonicalJson(record)}\n`);
    const reparsed = parseAcceptanceRecord(JSON.parse(raw));
    expect(reparsed).toEqual(record);
  });

  it("omits organisation when none is given", async () => {
    const project = await fixtureCopy();
    const generated = await generateProject(project, OPTIONS);
    const prepared = await prepareAccept(project, {
      toolVersion: "0.0.0-test",
      passportPath: generated.passportPath,
      skipChecks: true,
    });

    const { record } = await recordAcceptance(project, prepared.passport!, {
      acceptedBy: { name: "Solo Recipient" },
      acknowledgedFindings: [],
      now: () => new Date("2026-08-31T15:00:00.000Z"),
    });
    expect(record.acceptedBy).toEqual({ name: "Solo Recipient", date: "2026-08-31" });
    expect("organisation" in record.acceptedBy).toBe(false);
  });
});
