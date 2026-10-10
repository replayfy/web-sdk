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
