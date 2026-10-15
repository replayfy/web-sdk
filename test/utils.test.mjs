import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

test("utf8Bytes counts real UTF-8 bytes", async () => {
  const { utf8Bytes } = await load("utils.ts");
  for (const s of ["", "abc", "•", "漢字", "😀", "a\uD800b", "mixed • 漢 😀 x"]) {
    assert.equal(utf8Bytes(s), Buffer.byteLength(s, "utf8"), JSON.stringify(s));
  }
});

test("applyBeforeSend fails closed and warns once", async () => {
  const { applyBeforeSend } = await load("utils.ts");
  const env = { events: [{ type: "custom" }] };
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    assert.equal(applyBeforeSend(undefined, env), env, "no hook: same envelope");
    const scrubbed = applyBeforeSend(({ envelope }) => ({ envelope: { ...envelope, page: "x" } }), env);
    assert.equal(scrubbed.page, "x");
    assert.equal(applyBeforeSend(() => null, env), null, "null drops");
    assert.equal(applyBeforeSend(({ envelope }) => ({ envelope: { ...envelope, events: [] } }), env), null, "no events drops");
    assert.equal(applyBeforeSend(() => { throw new Error("boom"); }, env), null, "throw drops");
    assert.equal(applyBeforeSend(async ({ envelope }) => ({ envelope }), env), null, "promise drops");
    assert.equal(warns.length, 1, "one warning per page");
  } finally {
    console.warn = realWarn;
  }
});

test("the CDN bundle has no regex lookbehind (a parse error in Safari before 16.4)", async () => {
  const { build } = await import("esbuild");
  const out = await build({
    entryPoints: [new URL("../src/cdn.ts", import.meta.url).pathname],
    bundle: true, write: false, format: "iife", platform: "browser", target: "es2017", logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  // The text/input masker (src/text-mask.ts) is part of what is checked.
  assert.ok(code.includes("replay privacy post-pass failed"), "masker missing from the bundle");
  assert.ok(!code.includes("(?<!") && !code.includes("(?<="), "lookbehind found in the bundle");
});

test("URL redaction: key-only patterns hide every value, bad patterns are skipped", async () => {
  const { withRedactedUrl, compileRedactPatterns, redactUrlForStorage } = await load("utils.ts");
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    const rx = compileRedactPatterns(["token=", "api_key=", "([", "session-[0-9]+"]);
    assert.equal(rx.length, 3, "the invalid pattern is skipped");
    assert.equal(warns.length, 1, "one warning");
    assert.equal(
      withRedactedUrl("https://a.io/p?token=abc&x=1&token=def#h", rx),
      "https://a.io/p?token=[REDACTED]&x=1&token=[REDACTED]#h",
    );
    assert.equal(withRedactedUrl("https://a.io/u/session-123/v", rx), "https://a.io/u/[REDACTED]/v");
    assert.equal(withRedactedUrl("https://a.io/?q=1", [/x*/]), "https://a.io/?q=1", "empty matches change nothing");
    assert.equal(withRedactedUrl("https://a.io/?a.b=1&acb=2", ["a.b"]), "https://a.io/?a.b[REDACTED]&acb=2", "string keys are literal");
    assert.equal(
      redactUrlForStorage("https://a.io/?API_KEY=s3cr3t&u=1", { patterns: compileRedactPatterns(["api_key="]) }),
      "https://a.io/?API_KEY=[REDACTED]&u=1",
    );
  } finally {
    console.warn = realWarn;
  }
});
