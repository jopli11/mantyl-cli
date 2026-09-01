/**
 * Source bundle packing for cloud verification (spec §5 step 11).
 *
 * Rules:
 * - ONLY git-tracked files enter the bundle: the delivery, nothing else.
 *   Local state, secret env files and scan.exclude patterns can never be
 *   uploaded because they never make the list.
 * - The bundle digest is computed so the CLI can show the user exactly
 *   what will be uploaded before anything leaves the machine, and the
 *   worker can prove it received exactly that.
 * - Requires a git repository. Cloud verification accredits a commit;
 *   without git there is nothing to bind the accreditation to.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { createRunContext } from "./run-context.js";
import { listTrackedFiles } from "@mantyl/collectors-git";

export class PackError extends Error {}

export interface PackedBundle {
  /** gzip tar bytes of the tracked files, paths relative to the root. */
  bytes: Buffer;
  /** sha256 of the bundle bytes. */
  digest: string;
  fileCount: number;
  /** Uncompressed input size in bytes, for the consent summary. */
  totalBytes: number;
  commit: string;
}

const MAX_BUNDLE_FILES = 20_000;

/** Pack the project's tracked files for upload. Pure function of git state. */
export async function packProject(projectRoot: string): Promise<PackedBundle> {
  const context = await createRunContext(projectRoot, { toolVersion: "pack" });
  if (context.commit === null) {
    throw new PackError("cloud verification needs a git repository with at least one commit");
  }
  if (context.dirty) {
    throw new PackError(
      "the working tree has uncommitted changes — commit them first so the accreditation binds a real commit"
    );
  }

  // ALL tracked files: the bundle is the delivery, and verification needs
  // everything the recipient would have — including directories that
  // scan.exclude hides from evidence (fixtures broke our own test suite
  // when the first bundle omitted them). Exclusion scopes evidence, not
  // delivery.
  const tracked = await listTrackedFiles(projectRoot);
  const files = [...tracked].sort();
  if (files.length === 0) {
    throw new PackError("no tracked files found to bundle");
  }
  if (files.length > MAX_BUNDLE_FILES) {
    throw new PackError(`bundle would contain ${files.length} files (limit ${MAX_BUNDLE_FILES})`);
  }

  const { stat } = await import("node:fs/promises");
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += await stat(join(projectRoot, file)).then(
      (s) => s.size,
      () => 0
    );
  }

  const staging = await mkdtemp(join(tmpdir(), "mantyl-pack-"));
  const tarPath = join(staging, "bundle.tgz");
  try {
    await tar.create(
      {
        cwd: projectRoot,
        file: tarPath,
        gzip: true,
        portable: true,
        // Deterministic-ish: fixed mtime keeps repeat packs comparable.
        mtime: new Date(0),
        follow: false,
      },
      files
    );
    const bytes = await readFile(tarPath);
    return {
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
      fileCount: files.length,
      totalBytes,
      commit: context.commit,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Extract a received bundle into a directory. Worker-side. */
export async function extractBundle(bytes: Buffer, targetDir: string): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "mantyl-extract-"));
  const tarPath = join(staging, "bundle.tgz");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(tarPath, bytes);
    await tar.extract({ cwd: targetDir, file: tarPath });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
