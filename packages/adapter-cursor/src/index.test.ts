import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectCursorSessions, cursorAvailability } from "./index.js";

let sqliteAvailable = true;
try {
  await import("node:sqlite");
} catch {
  sqliteAvailable = false;
}

const redactor = (text: string): string =>
  text.replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED:test-key]");

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

/** Build a miniature Cursor user directory with real SQLite stores. */
async function fakeCursor(projectRoot: string): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const userDir = await mkdtemp(join(tmpdir(), "mantyl-cursor-fixture-"));
  dirs.push(userDir);

  const wsDir = join(userDir, "workspaceStorage", "abc123hash");
  await mkdir(wsDir, { recursive: true });
  await mkdir(join(userDir, "globalStorage"), { recursive: true });

  // Cursor stores the folder as an encoded file URI (c%3A on Windows).
  const uri = pathToFileURL(projectRoot).href;
  await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: uri }));

  const ws = new DatabaseSync(join(wsDir, "state.vscdb"));
  ws.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  ws.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "composer.composerData",
    JSON.stringify({
      allComposers: [
        { composerId: "comp-1", name: "auth work", createdAt: 1755500000000 },
        { composerId: "comp-empty", name: "untouched", createdAt: 1755500000001 },
      ],
    })
  );
  ws.close();

  const g = new DatabaseSync(join(userDir, "globalStorage", "state.vscdb"));
  g.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const put = g.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  put.run(
    "bubbleId:comp-1:b1",
    JSON.stringify({
      type: 1,
      bubbleId: "b1",
      createdAt: 1755500001000,
      text: "lets go with signed JWTs instead of server sessions. Key sk-ant-api03-verysecretcursorvalue01 for testing.",
    })
  );
  put.run(
    "bubbleId:comp-1:b2",
    JSON.stringify({
      type: 2,
      bubbleId: "b2",
      createdAt: 1755500002000,
      text: "I added bearer-token auth to the API middleware.",
    })
  );
  // Tool-only bubble (no prose) and a malformed row: skipped, never fatal.
  put.run("bubbleId:comp-1:b3", JSON.stringify({ type: 2, bubbleId: "b3", text: "" }));
  put.run("bubbleId:comp-1:b4", "this is not json");
  // A bubble for an unrelated composer must not leak in.
  put.run(
    "bubbleId:other-comp:b9",
    JSON.stringify({ type: 1, bubbleId: "b9", text: "unrelated project message" })
  );
  g.close();

  return userDir;
}

describe.runIf(sqliteAvailable)("adapter-cursor", () => {
  it("refuses to run without an explicit redactor (fail-closed)", async () => {
    await expect(collectCursorSessions("C:/nowhere")).rejects.toThrow(/redactor is required/);
  });

  it("finds the workspace by folder URI and extracts ordered, redacted messages", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mantyl-cursor-proj-"));
    dirs.push(projectRoot);
    const userDir = await fakeCursor(projectRoot);

    const sessions = await collectCursorSessions(projectRoot, redactor, {
      cursorUserDir: userDir,
    });

    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe("cursor");
    expect(s.sessionId).toBe("comp-1");
    expect(s.malformedLines).toBe(1);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[0]?.timestamp).toBe("2025-08-18T06:53:21.000Z");

    const allText = s.messages.map((m) => m.text).join("\n");
    expect(allText).not.toContain("verysecretcursorvalue");
    expect(allText).toContain("[REDACTED:");
    expect(allText).toContain("signed JWTs");
    expect(allText).not.toContain("unrelated project message");
  }, 30_000);

  it("returns nothing for projects Cursor has never opened", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mantyl-cursor-proj-"));
    const stranger = await mkdtemp(join(tmpdir(), "mantyl-cursor-stranger-"));
    dirs.push(projectRoot, stranger);
    const userDir = await fakeCursor(projectRoot);

    const sessions = await collectCursorSessions(stranger, redactor, { cursorUserDir: userDir });
    expect(sessions).toEqual([]);
  });

  // 30s: node:sqlite under sandbox CPU contention blows the 5s default.
  it("reports availability honestly", { timeout: 30_000 }, async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mantyl-cursor-proj-"));
    dirs.push(projectRoot);
    const userDir = await fakeCursor(projectRoot);

    expect(await cursorAvailability({ cursorUserDir: userDir })).toEqual({ available: true });
    const missing = await cursorAvailability({ cursorUserDir: join(userDir, "nope") });
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain("no Cursor installation");
  });
});
