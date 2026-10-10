import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowser, load, TEST_SDK_VERSION } from "./helpers.mjs";

const cfg = (x = {}) => ({ apiKey: "k", apiHost: "https://api.test", ...x });
const ev = (type, i, data = {}) => ({ id: `${type}-${i}`, ts: 1000 + i, offsetMs: i, source: "web", type, data });
const big = (n) => "x".repeat(n);

test("sdk descriptor reports the real package and version", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  assert.deepEqual(createSessionRuntime(cfg()).sdk, { name: "@replayfyapp/browser", version: TEST_SDK_VERSION, platform: "web" });
  assert.equal(createSessionRuntime(cfg({ sdk: { version: "custom" } })).sdk.version, "custom");
  installBrowser();
  const { createSessionRuntime: noDefine } = await load("runtime.ts", { define: false });
  assert.equal(noDefine(cfg()).sdk.version, "0.0.0-dev");
});

test("a send drained before rotate() is never requeued into the new session", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  rt.push(ev("custom", 1));
  rt.push(ev("custom", 2));
  const gen = rt.generation;
  const drained = rt.drain();
  rt.rotate();
  rt.push(ev("custom", 3));
  assert.equal(rt.requeue(drained, gen), false);
  assert.deepEqual(rt.drain().map((e) => e.id), ["custom-3"]);
  // same generation: back at the front, in order
  rt.push(ev("custom", 5));
  assert.equal(rt.requeue([ev("custom", 4)], rt.generation), true);
  assert.deepEqual(rt.drain().map((e) => e.id), ["custom-4", "custom-5"]);
});

test("unload batch: one request within the byte budget, most valuable first, rest kept", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  const evs = [
    ev("full_snapshot", 0, { s: big(30_000) }),
    ...Array.from({ length: 40 }, (_, i) => ev("incremental_snapshot", i + 1, { s: big(400) })),
    ev("network", 50, { s: big(2_000) }),
    ev("error", 51, { message: "boom" }),
    ev("navigation", 52, { to: "/b" }),
    ...Array.from({ length: 30 }, (_, i) => ev("incremental_snapshot", 60 + i, { s: "•".repeat(600) })),
    ev("session_end", 99, { reason: "unload" }),
  ];
  for (const e of evs) rt.push(e);
  const sent = [];
  const ROOM = 45_000;
  rt.flushFinal((env) => { sent.push(env); return true; }, () => ROOM);
  assert.equal(sent.length, 1, "exactly one unload request");
  const body = sent[0].events;
  const bytes = body.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
  assert.ok(bytes <= ROOM, `events ${bytes}B must fit ${ROOM}B`);
  const ids = body.map((e) => e.id);
  for (const must of ["session_end-99", "error-51", "navigation-52"]) assert.ok(ids.includes(must), must);
  // replay stream: an unbroken run from the oldest
  const replay = body.filter((e) => e.type.endsWith("snapshot")).map((e) => e.id);
  const expectedRun = evs.filter((e) => e.type.endsWith("snapshot")).slice(0, replay.length).map((e) => e.id);
  assert.deepEqual(replay, expectedRun);
  assert.ok(replay.length < 71, "not everything fits");
  // original order preserved inside the batch
  const order = evs.map((e) => e.id);
  assert.deepEqual([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)), ids);
  // everything else stays buffered, in order, for the next flush
  const rest = rt.drain().map((e) => e.id);
  assert.deepEqual(rest, order.filter((id) => !ids.includes(id)));
});

test("unload batch: nothing fits or the send is refused → everything stays buffered", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  rt.push(ev("full_snapshot", 0, { s: big(80_000) }));
  rt.push(ev("incremental_snapshot", 1));
  let calls = 0;
  rt.flushFinal(() => { calls += 1; return true; }, () => 40_000);
  assert.equal(calls, 0, "an oversized snapshot blocks the replay run; nothing else to send");
  assert.equal(rt.drain().length, 2);
  rt.push(ev("error", 2));
  rt.flushFinal(() => false, () => 40_000);
  assert.deepEqual(rt.drain().map((e) => e.id), ["error-2"]);
  rt.flushFinal(() => { calls += 1; return true; }, () => 40_000);
  assert.equal(calls, 0, "empty buffer sends nothing");
});

test("page URL and referrer are scrubbed of credential query keys", async () => {
  const b = installBrowser({ href: "https://app.test/a?token=abc&utm_source=ads" });
  b.document.referrer = "https://idp.test/cb?code=1&jwt=zzz";
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  rt.push(ev("custom", 1));
  let env;
  rt.flushFinal((e) => { env = e; return true; }, () => 40_000);
  assert.match(env.page.url, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
  assert.match(env.page.url, /utm_source=ads/);
  assert.doesNotMatch(env.page.referrer, /zzz/);
});

test("back/forward-cache restore: new segment; continue, adopt or start a session", async () => {
  const b = installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const a = createSessionRuntime(cfg({ sessionInactivityMs: 10_000 }));
  a.nextSequence();
  // page B in the same tab continues the session and claims numbers
  const bRt = createSessionRuntime(cfg({ sessionInactivityMs: 10_000 }));
  bRt.nextSequence(); bRt.nextSequence();
  const segA = a.segmentId;
  assert.equal(a.restoreFromBfcache(), true);
  assert.equal(a.sessionId, bRt.sessionId);
  assert.notEqual(a.segmentId, segA);
  assert.notEqual(a.segmentId, bRt.segmentId);
  assert.equal(a.nextSequence(), 4, "numbering continues after page B");
  // page B rotated to another session meanwhile: the restored page adopts it
  const st = JSON.parse(b.store.get("replay:ses"));
  b.store.set("replay:ses", JSON.stringify({ ...st, sid: "ses_other", st: 5 }));
  const gen = a.generation;
  assert.equal(a.restoreFromBfcache(), true);
  assert.equal(a.sessionId, "ses_other");
  assert.ok(a.generation > gen);
  // expired: a brand-new session
  b.store.set("replay:ses", JSON.stringify({ sid: "ses_other", st: 5, la: Date.now() - 60_000 }));
  const expired = createSessionRuntime(cfg({ sessionInactivityMs: 10_000 }));
  b.store.set("replay:ses", JSON.stringify({ sid: expired.sessionId, st: 5, la: Date.now() - 60_000 }));
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    assert.equal(expired.restoreFromBfcache(), false);
    assert.notEqual(expired.sessionId, "ses_other");
  } finally {
    Date.now = realNow;
  }
  // a host-supplied id is kept
  const host = createSessionRuntime(cfg({ sessionId: "HOST" }));
  const hostSeg = host.segmentId;
  host.restoreFromBfcache();
  assert.equal(host.sessionId, "HOST");
  assert.notEqual(host.segmentId, hostSeg);
});

test("upload gate: one in flight, exponential backoff capped at 60s, halts", async () => {
  installBrowser();
  const { createUploadGate } = await load("runtime.ts");
  let t = 0;
  const g = createUploadGate(3000, () => t, () => 1); // rand=1 → full delay
  assert.equal(g.canSend(), true);
  g.begin();
  assert.equal(g.canSend(), false, "in flight");
  g.end({ kind: "retry" });
  assert.equal(g.canSend(), false);
  t = 5_999; assert.equal(g.canSend(), false);
  t = 6_000; assert.equal(g.canSend(), true, "3s * 2^1");
  g.begin(); g.end({ kind: "retry" });
  t += 11_999; assert.equal(g.canSend(), false);
  t += 1; assert.equal(g.canSend(), true, "3s * 2^2");
  for (let i = 0; i < 10; i += 1) { g.begin(); g.end({ kind: "retry" }); }
  t += 59_999; assert.equal(g.canSend(), false);
  assert.equal(g.canSend(true), true, "stop() may ignore the backoff");
  t += 1; assert.equal(g.canSend(), true, "capped at 60s");
  g.begin(); assert.equal(g.end({ kind: "ok" }), undefined);
  assert.equal(g.canSend(), true, "ok resets");
  g.begin(); assert.equal(g.end({ kind: "drop", status: 400 }), undefined);
  g.begin(); assert.equal(g.end({ kind: "drop", status: 400 }), undefined);
  g.begin(); assert.equal(g.end({ kind: "drop", status: 400 }), "halt", "3 drops in a row");
  const g2 = createUploadGate(3000, () => 0, () => 1);
  g2.begin();
  assert.equal(g2.end({ kind: "stop", reason: "unauthorized" }), "halt");
});

test("minimum-duration outbox: handed to the next page load of the same session only", async () => {
  const b = installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const p1 = createSessionRuntime(cfg({ sessionInactivityMs: 60_000 }));
  p1.push(ev("full_snapshot", 0));
  p1.push(ev("custom", 1));
  assert.equal(p1.stashForNextPage(), true);
  assert.equal(p1.drain().length, 0, "buffer handed over");
  const p2 = createSessionRuntime(cfg({ sessionInactivityMs: 60_000 }));
  assert.equal(p2.resumed, true);
  assert.equal(b.store.has("replay:outbox"), false, "read once");
  assert.deepEqual(p2.carried.map((c) => [c.segmentId, c.events.map((e) => e.id)]), [[p1.segmentId, ["full_snapshot-0", "custom-1"]]]);
  // still under the minimum on page 2 → page 3 gets page 1's AND page 2's events
  p2.push(ev("custom", 2));
  assert.equal(p2.stashForNextPage(), true);
  const p3 = createSessionRuntime(cfg({ sessionInactivityMs: 60_000 }));
  assert.deepEqual(p3.carried.map((c) => c.segmentId), [p1.segmentId, p2.segmentId]);
  // a NEW session (expired / other tab) never sends someone else's held events
  p3.push(ev("custom", 3));
  p3.stashForNextPage();
  b.store.set("replay:ses", JSON.stringify({ sid: p3.sessionId, st: 0, la: 0 }));
  const fresh = createSessionRuntime(cfg({ sessionInactivityMs: 60_000 }));
  assert.equal(fresh.resumed, false);
  assert.equal(fresh.carried.length, 0);
  assert.equal(b.store.has("replay:outbox"), false, "discarded");
  // too big for the shared storage → dropped, nothing written
  fresh.push(ev("full_snapshot", 9, { s: "x".repeat(1_100_000) }));
  assert.equal(fresh.stashForNextPage(), false);
  assert.equal(b.store.has("replay:outbox"), false);
});
