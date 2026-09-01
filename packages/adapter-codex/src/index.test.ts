import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAvailability, collectCodexSessions } from "./index.js";

const redactor = (text: string): string =>
  text.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED:test-key]");

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

async function fakeCodex(projectRoot: string): Promise<string> {
  const sessionsDir = await mkdtemp(join(tmpdir(), "mantyl-codex-fixture-"));
  dirs.push(sessionsDir);
  const day = join(sessionsDir, "2026", "08", "18");
  await mkdir(day, { recursive: true });

  await writeFile(
    join(day, "rollout-2026-08-18T10-00-00-aaa.jsonl"),
    [
      line({
        type: "session_meta",
        timestamp: "2026-08-18T10:00:00.000Z",
        payload: { id: "codex-1", cwd: projectRoot },
      }),
      line({
        type: "response_item",
        timestamp: "2026-08-18T10:01:00.000Z",
        payload: {
          type: "message",
          id: "m1",
          role: "user",
          content: [
            { type: "input_text", text: "lets go with SQLite for the queue instead of Redis. Token sk-testsecretcodexvalue0001 for local." },
          ],
        },
      }),
      line({
        type: "response_item",
        timestamp: "2026-08-18T10:02:00.000Z",
        payload: {
          type: "message",
          id: "m2",
          role: "assistant",
          content: [{ type: "output_text", text: "I added retry handling to the webhook route." }],
        },
      }),
      // Injected instructions, reasoning, tool calls and junk: all skipped.
      line({
        type: "response_item",
        payload: { type: "message", id: "m3", role: "developer", content: [{ type: "input_text", text: "system rules" }] },
      }),
      line({ type: "response_item", payload: { type: "reasoning", id: "r1" } }),
      line({ type: "event_msg", payload: {} }),
      "not json at all",
    ].join("\n"),
    "utf8"
  );

  // A session for a DIFFERENT project must not leak in.
  await writeFile(
    join(day, "rollout-2026-08-18T11-00-00-bbb.jsonl"),
    [
      line({
        type: "session_meta",
        payload: { id: "codex-other", cwd: join(projectRoot, "..", "another-project") },
      }),
      line({
        type: "response_item",
        payload: {
          type: "message",
          id: "x1",
          role: "user",
          content: [{ type: "input_text", text: "unrelated project message" }],
        },
      }),
    ].join("\n"),
    "utf8"
  );

  return sessionsDir;
}

describe("adapter-codex", () => {
  it("refuses to run without an explicit redactor (fail-closed)", async () => {
    await expect(collectCodexSessions("C:/nowhere")).rejects.toThrow(/redactor is required/);
  });

  it("matches sessions by cwd and extracts redacted conversation only", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mantyl-codex-proj-"));
    dirs.push(projectRoot);
    const sessionsDir = await fakeCodex(projectRoot);

    const sessions = await collectCodexSessions(projectRoot, redactor, {
      codexSessionsDir: sessionsDir,
    });

    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe("codex");
    expect(s.sessionId).toBe("codex-1");
    expect(s.malformedLines).toBe(1);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[0]?.timestamp).toBe("2026-08-18T10:01:00.000Z");

    const allText = s.messages.map((m) => m.text).join("\n");
    expect(allText).not.toContain("testsecretcodexvalue");
    expect(allText).toContain("[REDACTED:");
    expect(allText).toContain("SQLite for the queue");
    expect(allText).not.toContain("system rules");
    expect(allText).not.toContain("unrelated project message");
  });

  it("reports availability honestly", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mantyl-codex-proj-"));
    dirs.push(projectRoot);
    const sessionsDir = await fakeCodex(projectRoot);

    expect(await codexAvailability({ codexSessionsDir: sessionsDir })).toEqual({
      available: true,
    });
    const missing = await codexAvailability({ codexSessionsDir: join(sessionsDir, "nope") });
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain("no Codex CLI sessions");
  });
});
