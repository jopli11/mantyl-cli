/**
 * File manifest — content-addressed record of the delivered tree.
 * The manifest digest binds a passport to the exact bytes it describes;
 * `mantyl receive` recomputes it on the recipient's copy and compares.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { digestValue } from "@mantyl/schema";
import type { FileEntry } from "@mantyl/collectors-repository";

export interface FileManifest {
  /** path → sha256 of file contents, sorted by path. */
  files: Record<string, string>;
  digest: string;
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function buildFileManifest(
  projectRoot: string,
  files: FileEntry[]
): Promise<FileManifest> {
  const entries: Record<string, string> = {};
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    // Untracked files are local-machine state, not part of the delivery —
    // fingerprinting them guarantees false divergence on every receive.
    if (file.tracked === false) continue;
    entries[file.path] = await sha256File(join(projectRoot, file.path));
  }
  return { files: entries, digest: digestValue(entries) };
}

/** Compare two manifests and name the divergent paths. */
export function diffManifests(
  recorded: Record<string, string>,
  current: Record<string, string>
): { added: string[]; removed: string[]; modified: string[] } {
  const added = Object.keys(current).filter((p) => !(p in recorded)).sort();
  const removed = Object.keys(recorded).filter((p) => !(p in current)).sort();
  const modified = Object.keys(recorded)
    .filter((p) => p in current && recorded[p] !== current[p])
    .sort();
  return { added, removed, modified };
}
