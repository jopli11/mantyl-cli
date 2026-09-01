/** `mantyl init` — create a validated default configuration file. */

import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILENAME, defaultConfig } from "@mantyl/config";

export interface InitResult {
  outcome: "created" | "exists";
  path: string;
}

export async function initProject(
  projectRoot: string,
  options: { force?: boolean } = {}
): Promise<InitResult> {
  const path = join(projectRoot, CONFIG_FILENAME);
  if (existsSync(path) && !options.force) {
    return { outcome: "exists", path };
  }
  const config = {
    $schema: "https://mantyl.dev/schemas/config-v1.json",
    ...defaultConfig(),
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { outcome: "created", path };
}
