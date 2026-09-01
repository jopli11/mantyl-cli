import { defineConfig } from "tsup";

/**
 * The published `mantyl` package is a SINGLE self-contained bundle: all
 * @mantyl/* workspace packages (plus commander and zod) are compiled in, so
 * `npm install -g mantyl` needs no scoped packages and no workspace protocol.
 * Only @anthropic-ai/sdk stays external — it is dynamically imported by the
 * analysis provider and declared as a real dependency.
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  banner: {
    // Bundled CommonJS deps (commander) require() node builtins; ESM output
    // needs a real require for that.
    js: 'import { createRequire as __mantylCreateRequire } from "node:module"; const require = __mantylCreateRequire(import.meta.url);',
  },
  format: "esm",
  platform: "node",
  target: "node20",
  clean: true,
  sourcemap: false,
  dts: false,
  minify: false,
});
