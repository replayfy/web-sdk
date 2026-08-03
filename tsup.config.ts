import { defineConfig } from "tsup";

/**
 * Two build targets from one source.
 *
 *  1. The npm package — ESM + CJS + .d.ts. Runtime deps (rrweb, web-vitals,
 *     error-stack-parser-es) are left EXTERNAL so the consumer's bundler
 *     resolves/dedupes them. Entry points: the library (`.`) and the wire
 *     schema (`./schema`). Extensions are pinned (.mjs / .cjs) so package.json
 *     `exports` can map them deterministically.
 *
 *  2. The CDN bundle — a single self-contained, minified IIFE that assigns the
 *     global `Replayfy` and INLINES every dependency (`noExternal`), so it drops
 *     straight onto https://cdn.replayfy.app behind a <script> tag with no build
 *     step. Emitted as dist/replay.global.js.
 */
export default defineConfig([
  {
    entry: { index: "src/index.ts", schema: "src/schema.ts" },
    format: ["esm", "cjs"],
    outExtension: ({ format }) => ({ js: format === "esm" ? ".mjs" : ".cjs" }),
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: "es2020",
  },
  {
    entry: { replay: "src/cdn.ts" },
    format: ["iife"],
    globalName: "Replayfy",
    outExtension: () => ({ js: ".global.js" }),
    platform: "browser",
    noExternal: [/.*/],
    minify: true,
    sourcemap: true,
    treeshake: true,
    target: "es2017",
    // Don't wipe the npm build emitted by the first config.
    clean: false,
  },
]);
