import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowser, load, outboxKeys, TEST_SDK_VERSION } from "./helpers.mjs";

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
  const seg = rt.segmentId;
  const drained = rt.drain();
  rt.rotate();
  rt.push(ev("custom", 3));
  assert.equal(rt.requeue({ segmentId: seg, events: drained, page: rt.pageContext(), sequence: 1, hooked: true }, gen), false);
  assert.equal(rt.carried.length, 0);
  assert.deepEqual(rt.drain().map((e) => e.id), ["custom-3"]);
  // a failed batch held for a retry is dropped by a later rotation too
  rt.push(ev("custom", 4));
  const held = { segmentId: rt.segmentId, events: rt.drain(), page: rt.pageContext(), sequence: 2, hooked: true };
  assert.equal(rt.requeue(held, rt.generation), true);
  rt.rotate();
  assert.equal(rt.carried.length, 0);
  assert.equal(rt.drain().length, 0);
});

test("a failed send is requeued whole, ahead of the buffer, keeping its segment, page and sequence", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  rt.push(ev("full_snapshot", 1));
  const page = { ...rt.pageContext(), url: "https://app.test/scrubbed" };
  const batch = { segmentId: rt.segmentId, events: rt.drain(), page, sequence: rt.nextSequence(), hooked: true };
  rt.push(ev("custom", 2)); // captured while the send was in flight
  assert.equal(rt.requeue(batch, rt.generation), true);
  assert.deepEqual(rt.carried, [batch], "carried as it was sent, not merged into the buffer");
  assert.deepEqual(rt.drain().map((e) => e.id), ["custom-2"], "newer events stay behind it");
  // it survives the outbox with its number and its flag
  rt.requeue(rt.carried.shift(), rt.generation);
  rt.stashForNextPage();
  const next = createSessionRuntime(cfg());
  assert.deepEqual(next.carried.map((c) => [c.segmentId, c.sequence, c.hooked, c.page.url]), [[batch.segmentId, batch.sequence, true, "https://app.test/scrubbed"]]);
});

test("held events are bounded during an outage: newest dropped, the oldest batch kept whole", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  const MAX = 20_000;
  const batch = (n, from, sequence) => ({
    segmentId: rt.segmentId,
    sequence,
    hooked: true,
    events: Array.from({ length: n }, (_, i) => ev(i === 0 && from === 0 ? "full_snapshot" : "incremental_snapshot", from + i)),
  });
  // a failed 15k batch (the base snapshot first), 10k captured behind it
  for (let i = 0; i < 10_000; i += 1) rt.push(ev("custom", 100_000 + i));
  assert.equal(rt.requeue(batch(15_000, 0, 1), rt.generation), true);
  assert.equal(rt.carried[0].events.length, 15_000);
  assert.equal(rt.carried[0].events[0].id, "full_snapshot-0");
  let buf = rt.drain();
  assert.equal(buf.length, MAX - 15_000, "the buffer fills what is left of the cap");
  assert.deepEqual([buf[0].id, buf.at(-1).id], ["custom-100000", "custom-104999"], "its oldest events kept");
  // a newer carried batch never sent (no number) past the cap is cut to its
  // oldest events; the buffer goes
  const base = rt.carried.shift();
  rt.carried.push(batch(8_000, 50_000, undefined));
  for (let i = 0; i < 1_000; i += 1) rt.push(ev("custom", 200_000 + i));
  rt.requeue(base, rt.generation);
  assert.deepEqual(rt.carried.map((c) => [c.sequence, c.events.length]), [[1, 15_000], [undefined, 5_000]]);
  assert.equal(rt.carried[1].events.at(-1).id, "incremental_snapshot-54999");
  assert.equal(rt.drain().length, 0);
  // the oldest batch alone past the cap: kept whole, everything newer dropped
  rt.carried.length = 0;
  rt.carried.push(batch(10, 90_000, 4));
  rt.push(ev("custom", 300_000));
  rt.requeue(batch(MAX + 5, 0, 3), rt.generation);
  assert.deepEqual(rt.carried.map((c) => [c.sequence, c.events.length]), [[3, MAX + 5]]);
  assert.equal(rt.drain().length, 0);
  // within the cap nothing is dropped
  rt.carried.length = 0;
  rt.push(ev("custom", 1));
  rt.requeue(batch(10, 0, 5), rt.generation);
  assert.deepEqual([rt.carried[0].events.length, rt.drain().length], [10, 1]);
});

test("the bound never cuts a batch already sent once: it is dropped whole, with everything newer", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  const batch = (n, from, sequence) => ({
    segmentId: rt.segmentId,
    sequence,
    events: Array.from({ length: n }, (_, i) => ev("incremental_snapshot", from + i)),
  });
  // an upload an earlier page left unfinished (it may have landed whole), then
  // this page's leftovers; a 15k failed send goes in front of them
  rt.carried.push(batch(8_000, 50_000, 2), batch(10, 90_000, undefined));
  rt.push(ev("custom", 1));
  rt.requeue(batch(15_000, 0, 1), rt.generation);
  assert.deepEqual(rt.carried.map((c) => [c.sequence, c.events.length]), [[1, 15_000]], "never resent under seq 2 with less than it had");
  assert.equal(rt.drain().length, 0);
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

test("outbox: handed to the next page load of the same session only", async () => {
  const b = installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const p1 = createSessionRuntime(cfg({ sessionInactivityMs: 60_000 }));
  p1.push(ev("full_snapshot", 0));
  p1.push(ev("custom", 1));
  assert.equal(p1.stashForNextPage(), true);
  assert.equal(p1.drain().length, 0, "buffer handed over");
  const p2 = createSessionRuntime(cfg({ sessionInactivityMs: 60_000 }));
  assert.equal(p2.resumed, true);
  assert.deepEqual(outboxKeys(b.store), [], "read once");
  assert.deepEqual(p2.carried.map((c) => [c.segmentId, c.events.map((e) => e.id)]), [[p1.segmentId, ["full_snapshot-0", "custom-1"]]]);
  // page 2 leaves with events too → page 3 gets page 1's AND page 2's events
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
  assert.deepEqual(outboxKeys(b.store), [], "discarded");
  // too big for the shared storage → dropped, nothing written
  fresh.push(ev("full_snapshot", 9, { s: "x".repeat(1_100_000) }));
  assert.equal(fresh.stashForNextPage(), false);
  assert.deepEqual(outboxKeys(b.store), []);
});

test("a send that fails after a back/forward-cache restore stays under its own segment and page", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg({ sessionInactivityMs: 10_000 }));
  rt.push(ev("incremental_snapshot", 1));
  const gen = rt.generation;
  const seg = rt.segmentId;
  const page = { ...rt.pageContext(), url: "https://app.test/before" };
  const sequence = rt.nextSequence();
  const drained = rt.drain();
  rt.push(ev("incremental_snapshot", 2)); // buffered after it, before the freeze
  assert.equal(rt.restoreFromBfcache(), true);
  rt.push(ev("full_snapshot", 3));
  assert.equal(rt.requeue({ segmentId: seg, events: drained, page, sequence, hooked: true }, gen), true);
  assert.deepEqual(rt.drain().map((e) => e.id), ["full_snapshot-3"], "the new page's batch holds only its own events");
  assert.deepEqual(
    rt.carried.map((c) => [c.segmentId, c.sequence, c.events.map((e) => e.id)]),
    [[seg, sequence, ["incremental_snapshot-1"]], [seg, undefined, ["incremental_snapshot-2"]]],
    "the failed batch first, under its number, then what was buffered after it",
  );
  assert.equal(rt.carried[0].page.url, "https://app.test/before");
});

test("unload batch refused once (a beforeSend that grew it) is retried smaller, same sequence", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  for (let i = 0; i < 40; i += 1) rt.push(ev("incremental_snapshot", i, { s: big(800) }));
  rt.push(ev("session_end", 99, { reason: "unload" }));
  const tries = [];
  rt.flushFinal((e) => {
    tries.push(e);
    return tries.length > 1;
  }, () => 40_000);
  assert.equal(tries.length, 2);
  assert.ok(tries[1].events.length < tries[0].events.length);
  assert.ok(tries[1].events.some((e) => e.type === "session_end"), "the session end goes first");
  assert.equal(tries[1].sequence, tries[0].sequence);
  const left = rt.drain();
  assert.equal(left.length + tries[1].events.length, 41, "what didn't go stays buffered");
});

test("unload: carried page loads go first under their own segment and page, and leave room for the tail", async () => {
  const b = installBrowser({ href: "https://app.test/landing?utm_source=google" });
  const { createSessionRuntime } = await load("runtime.ts");
  const p1 = createSessionRuntime(cfg({ sessionInactivityMs: 60_000 }));
  p1.push(ev("full_snapshot", 0));
  p1.stashForNextPage();
  installBrowser({ href: "https://app.test/product", storage: b.store });
  const p2 = createSessionRuntime(cfg({ sessionInactivityMs: 60_000 }));
  assert.equal(p2.carried.length, 1);
  p2.push(ev("session_end", 1, { reason: "unload" }));
  const sent = [];
  p2.flushFinal((e) => (sent.push(e), true), () => 40_000, false);
  assert.deepEqual(sent.map((e) => e.segmentId), [p2.segmentId], "a tab switch leaves carried batches to the regular flush");
  assert.equal(p2.carried.length, 1);
  p2.push(ev("session_end", 1, { reason: "unload" }));
  sent.length = 0;
  p2.flushFinal((e) => (sent.push(e), true), () => 40_000, true);
  assert.deepEqual(sent.map((e) => [e.segmentId, e.page.url]), [
    [p1.segmentId, "https://app.test/landing?utm_source=google"],
    [p2.segmentId, "https://app.test/product"],
  ]);
  assert.equal(p2.carried.length, 0);
  // a carried batch that would eat the tail's room waits (and the tail goes)
  p2.carried.push({ segmentId: "seg_old", events: [ev("full_snapshot", 2, { s: big(36_000) })] });
  p2.push(ev("error", 3));
  sent.length = 0;
  p2.flushFinal((e) => (sent.push(e), true), () => 40_000, true);
  assert.deepEqual(sent.map((e) => e.segmentId), [p2.segmentId]);
  assert.equal(p2.carried.length, 1);
});

test("config.sessionId: lone surrogates and control characters are refused, real pairs kept", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const w = console.warn;
  console.warn = () => {};
  try {
    for (const bad of ["a\uDC00b", "a\uD800", "\uD800x", "a\u0001b", "a\u007Fb"]) {
      assert.notEqual(createSessionRuntime(cfg({ sessionId: bad })).sessionId, bad, JSON.stringify(bad));
    }
    assert.equal(createSessionRuntime(cfg({ sessionId: "u-😀-x" })).sessionId, "u-😀-x");
  } finally {
    console.warn = w;
  }
});

test("carryUnsent: an unfinished upload of this session is carried first, keeping its sequence", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  rt.carried.push({ segmentId: "seg_later", events: [ev("custom", 2)] });
  const page = rt.pageContext();
  const hooked = { sessionId: rt.sessionId, segmentId: rt.segmentId, sequence: 7, sentAt: 1, sdk: rt.sdk, page, events: [ev("full_snapshot", 1)] };
  rt.carryUnsent([
    hooked,
    { sessionId: rt.sessionId, segmentId: rt.segmentId, sequence: 6, sentAt: 1, sdk: rt.sdk, page, events: [ev("custom", 5)] },
    { sessionId: "ses_other", segmentId: "x", sequence: 8, sentAt: 1, sdk: rt.sdk, page, events: [ev("custom", 9)] },
  ], (e) => e === hooked);
  assert.deepEqual(rt.carried.map((c) => [c.segmentId, c.sequence]), [[rt.segmentId, 7], [rt.segmentId, 6], ["seg_later", undefined]]);
  // flagged only when beforeSend ran on what was sent (the caller knows)
  assert.deepEqual(rt.carried.map((c) => c.hooked), [true, undefined, undefined]);
  // it survives the outbox with its number
  rt.stashForNextPage();
  const next = createSessionRuntime(cfg());
  assert.deepEqual(next.carried.map((c) => [c.sequence, c.hooked]), [[7, true], [6, undefined], [undefined, undefined]]);
});

test("unload: a carried batch beforeSend already ran on is flagged, so the hook isn't run again", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  rt.carried.push({ segmentId: rt.segmentId, events: [ev("custom", 1)], page: rt.pageContext(), sequence: 4, hooked: true });
  rt.carried.push({ segmentId: "seg_outbox", events: [ev("custom", 2)] });
  rt.push(ev("session_end", 3, { reason: "unload" }));
  const sent = [];
  rt.flushFinal((e, hooked) => (sent.push([e.segmentId, e.sequence, hooked]), true), () => 40_000, true);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0], [rt.segmentId, 4, true], "resent under its number, as it is");
  assert.equal(sent[1][2], false, "a batch not sent before goes through the hook");
  assert.equal(sent[2][2], false, "and so does the tail");
});

test("tab switch: a held failed batch also goes as a copy under its number, and stays carried", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  const held = { segmentId: rt.segmentId, events: [ev("incremental_snapshot", 1)], page: rt.pageContext(), sequence: 4, hooked: true };
  rt.requeue(held, rt.generation);
  rt.carried.push({ segmentId: "seg_outbox", events: [ev("custom", 2)] });
  rt.push(ev("custom", 3));
  const sent = [];
  const record = (e, hooked) => (sent.push([e.segmentId, e.sequence, hooked, e.events.map((x) => x.id)]), true);
  rt.flushFinal(record, () => 40_000, false);
  assert.equal(sent.length, 2, "the copy, then the tail");
  assert.deepEqual(sent[0], [rt.segmentId, 4, true, ["incremental_snapshot-1"]]);
  assert.deepEqual(sent[1][3], ["custom-3"]);
  assert.deepEqual(rt.carried.map((c) => c.sequence), [4, undefined], "both stay carried for the regular flush");
  // a carried batch never sent before isn't copied (it has no number yet)
  rt.carried.shift();
  rt.push(ev("custom", 5));
  sent.length = 0;
  rt.flushFinal(record, () => 40_000, false);
  assert.deepEqual(sent.map((s) => s[3]), [["custom-5"]]);
  assert.equal(rt.carried.length, 1);
});

test("unload: a failed send too big to go whole sends its priority events under a new number, and keeps the rest under its own", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  const diff = (i) => ev("incremental_snapshot", i, { pad: big(10_000) });
  const page = { ...rt.pageContext(), url: "https://app.test/old" };
  const seq = rt.nextSequence(); // claimed when it was first sent
  rt.requeue({ segmentId: "seg_old", page, sequence: seq, hooked: true, events: [ev("session_start", 1), diff(2), ev("error", 3), diff(4), ev("custom", 5)] }, rt.generation);
  // an earlier page's leftovers, too big as well: whole or not at all, as before
  rt.carried.push({ segmentId: "seg_outbox", events: [ev("custom", 6), diff(7)] });
  rt.push(ev("session_end", 8, { reason: "unload" }));
  const sent = [];
  const record = (e, hooked) => (sent.push([e.segmentId, e.sequence, e.page.url, hooked, e.events.map((x) => x.id)]), true);
  rt.flushFinal(record, () => 20_000, true);
  assert.equal(sent.length, 2, "the priority part, then the tail");
  const [part, tail] = sent;
  assert.deepEqual(part.slice(0, 4), ["seg_old", part[1], "https://app.test/old", true]);
  assert.ok(part[1] > seq, "a new number");
  assert.deepEqual(part[4], ["session_start-1", "error-3", "custom-5"]);
  assert.deepEqual(tail[4], ["session_end-8"]);
  assert.ok(tail[1] > part[1]);
  // what is left keeps its number and stays first; nothing else changed
  assert.deepEqual(rt.carried.map((c) => [c.segmentId, c.sequence, c.events.map((e) => e.id)]), [
    ["seg_old", seq, ["incremental_snapshot-2", "incremental_snapshot-4"]],
    ["seg_outbox", undefined, ["custom-6", "incremental_snapshot-7"]],
  ]);
  // a tab switch later in the same backoff: the rest is still that failed send
  rt.flushFinal(record, () => 40_000, false);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2].slice(1), [seq, "https://app.test/old", true, ["incremental_snapshot-2", "incremental_snapshot-4"]]);
});

test("tab switch: a held failed batch goes out once per failed send, however often the tab is switched", async () => {
  installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg());
  const failed = () => ({ segmentId: rt.segmentId, events: [ev("incremental_snapshot", 1)], page: rt.pageContext(), sequence: 4 });
  rt.requeue(failed(), rt.generation);
  const sent = [];
  const record = (e) => (sent.push(e.sequence), true);
  for (let i = 0; i < 3; i += 1) rt.flushFinal(record, () => 40_000, false);
  assert.deepEqual(sent, [4], "one copy");
  assert.equal(rt.carried.length, 1, "kept for the retry");
  // the retry fails too: that send may go once more
  rt.carried.shift();
  rt.requeue(failed(), rt.generation);
  rt.flushFinal(record, () => 40_000, false);
  rt.flushFinal(record, () => 40_000, false);
  assert.deepEqual(sent, [4, 4]);
});

test("outbox: another project's SDK on the same site never takes it", async () => {
  const b = installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const a = createSessionRuntime(cfg({ apiKey: "key_A", sessionInactivityMs: 60_000 }));
  a.push(ev("custom", 1));
  assert.equal(a.stashForNextPage(), true);
  const other = createSessionRuntime(cfg({ apiKey: "key_B", sessionInactivityMs: 60_000 }));
  assert.equal(other.carried.length, 0);
  assert.equal(outboxKeys(b.store).length, 1, "still there for project A");
  const again = createSessionRuntime(cfg({ apiKey: "key_A", sessionInactivityMs: 60_000 }));
  assert.equal(again.carried.length, 1);
});

test("outbox: a failed or oversized stash keeps the events in memory", async () => {
  const b = installBrowser();
  const { createSessionRuntime } = await load("runtime.ts");
  const rt = createSessionRuntime(cfg({ sessionInactivityMs: 60_000 }));
  rt.carried.push({ segmentId: "seg_huge", events: [ev("full_snapshot", 0, { s: big(1_100_000) })] });
  rt.push(ev("custom", 1));
  // the oversized carried batch is left out; the small buffer still goes
  assert.equal(rt.stashForNextPage(), true);
  assert.deepEqual(rt.carried.map((c) => c.segmentId), ["seg_huge"], "kept in memory");
  assert.equal(rt.drain().length, 0, "the buffer went to the outbox");
  // storage throws: nothing leaves memory
  rt.push(ev("custom", 2));
  const real = globalThis.sessionStorage.setItem;
  globalThis.sessionStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  try {
    assert.equal(rt.stashForNextPage(), false);
  } finally {
    globalThis.sessionStorage.setItem = real;
  }
  assert.equal(rt.carried.length, 1);
  assert.deepEqual(rt.drain().map((e) => e.id), ["custom-2"]);
  assert.ok(b.store.size > 0);
});
