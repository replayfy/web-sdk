// initReplay end to end (real SDK code; rrweb/signals/fingerprint/remote-config
// stubbed): what leaves the page on tab switches, closes, back/forward-cache
// restores, server rejections and session rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { installBrowser, load, makeFetch, ok, json, sleep, types, TEST_SDK_VERSION } from "./helpers.mjs";

const remoteCfg = (o = {}) => ({
  workspaceId: 1,
  shouldNotRecord: o.shouldNotRecord,
  capture: { console: true, network: true, networkHeaders: false, networkBodies: false, errors: true, headers: false, canvas: false, iframe: false, performance: true, autoplayNext: false, minDurationMs: o.minDurationMs ?? 0, trigger: "always" },
  privacy: { maskAllInputs: true, maskSelectors: [], maskInputTypes: ["password"], blockSelectors: [], redactUrlPatterns: [], blockCreditCardText: false, stripQueryParams: false, allowedQueryParams: [], allowedHosts: [] },
  sampling: { rate: o.rate ?? 1, alwaysRecordErrors: !!o.alwaysRecordErrors, alwaysRecordIdentified: false, alwaysRecordOnUrls: [] },
  retentionDays: 30,
});

async function start({ respond, config = {}, href, storage, remote } = {}) {
  const b = installBrowser({ href, storage });
  if (remote !== undefined) globalThis.__remoteConfig = () => remote;
  const f = makeFetch(respond);
  const { initReplay } = await load("initReplay.ts", { stub: true });
  const ctrl = initReplay({ apiKey: "k", apiHost: "https://api.test", flushIntervalMs: 1e9, sessionInactivityMs: 0, fetchImpl: f, ...config });
  await sleep(420); // remote-config race (300ms) → rrweb → first snapshot batch
  return { b, f, ctrl };
}
const all = (f) => f.calls.flatMap((c) => c.envelope.events);
const ends = (f) => all(f).filter((e) => e.type === "session_end");
const silence = () => { const w = console.warn; console.warn = () => {}; return () => { console.warn = w; }; };

test("first batch: real SDK version, snapshot-led", async () => {
  const { f, ctrl } = await start();
  assert.ok(f.calls.length >= 1);
  const first = f.calls[0].envelope;
  assert.deepEqual([first.sdk.name, first.sdk.version], ["@replayfyapp/browser", TEST_SDK_VERSION]);
  assert.ok(types(first).includes("full_snapshot"));
  await ctrl.stop();
});

test("tab switch ships the tail with no session_end; an empty buffer sends nothing", async () => {
  const { b, f, ctrl } = await start();
  const before = f.calls.length;
  ctrl.track("clicked");
  b.hide();
  await sleep(20);
  assert.equal(f.calls.length, before + 1);
  const tail = f.calls.at(-1);
  assert.equal(tail.keepalive, true);
  assert.ok(types(tail.envelope).includes("custom"));
  assert.equal(ends(f).length, 0, "a hidden tab's session goes on");
  b.show(); b.hide();
  await sleep(20);
  assert.equal(f.calls.length, before + 1, "nothing new to send");
  await ctrl.stop();
});

test("close / navigation: exactly one session_end (unload), no beforeunload listener", async () => {
  const { b, f, ctrl } = await start();
  assert.equal(b.window.count("beforeunload"), 0);
  ctrl.track("last");
  b.pagehide(false);
  b.hide(); // the browser fires visibilitychange right after pagehide
  await sleep(20);
  assert.deepEqual(ends(f).map((e) => e.data.reason), ["unload"]);
  assert.ok(all(f).some((e) => e.type === "custom"), "the tail went with it");
  await ctrl.stop();
});

test("back/forward cache: no end on the way in; restore = new segment, page view, fresh snapshot", async () => {
  const { b, f, ctrl } = await start({ config: { sessionInactivityMs: 60_000 } });
  const seg0 = f.calls[0].envelope.segmentId;
  const sid = f.calls[0].envelope.sessionId;
  b.pagehide(true);
  b.hide();
  assert.equal(ends(f).length, 0);
  b.show();
  b.pageshow(true);
  await sleep(60);
  const after = f.calls.map((c) => c.envelope).filter((e) => e.segmentId !== seg0);
  assert.ok(after.length >= 1, "a batch under a new segment");
  assert.equal(after[0].sessionId, sid, "same session");
  const t = after.flatMap(types);
  assert.ok(t.includes("navigation") && t.includes("full_snapshot"), t.join(","));
  await ctrl.stop();
});

test("sampled-out tab never uploads, not even on hide or close", async () => {
  const { b, f, ctrl } = await start({ remote: remoteCfg({ rate: 0 }) });
  ctrl.track("x");
  b.hide();
  b.pagehide(false);
  await sleep(20);
  assert.equal(f.calls.length, 0);
  await ctrl.stop();
});

test("beforeSend runs on the unload batch too, and fails closed", async () => {
  const scrub = ({ envelope }) => ({ envelope: { ...envelope, events: envelope.events.filter((e) => e.data?.name !== "secret") } });
  const { b, f, ctrl } = await start({ config: { beforeSend: scrub } });
  ctrl.track("secret", { pii: "SHOULD_NOT_LEAVE" });
  ctrl.track("fine");
  b.pagehide(false);
  await sleep(20);
  const raw = JSON.stringify(f.calls.map((c) => c.body));
  assert.ok(!raw.includes("SHOULD_NOT_LEAVE"));
  assert.ok(raw.includes('"fine"'));
  await ctrl.stop();

  const restore = silence();
  try {
    let armed = false;
    const boom = ({ envelope }) => { if (armed) throw new Error("scrubber bug"); return { envelope }; };
    const r = await start({ config: { beforeSend: boom } });
    const n = r.f.calls.length;
    armed = true;
    r.ctrl.track("x");
    assert.doesNotThrow(() => r.b.pagehide(false));
    await sleep(20);
    assert.equal(r.f.calls.length, n, "nothing unscrubbed left the page");
  } finally {
    restore();
  }
});

for (const [name, respond] of [
  ["401 (bad key)", () => json(401, { ok: false, error: { code: "UNAUTHORIZED", message: "x" } })],
  ["403 (origin)", () => json(403, { ok: false, error: { code: "FORBIDDEN", message: "x" } })],
  ["plan cap (accepted:false)", () => json(201, { ok: true, data: { accepted: false, shouldNotRecord: true } })],
]) {
  test(`${name} stops uploads for the rest of the page`, async () => {
    const restore = silence();
    try {
      const { b, f, ctrl } = await start({ respond });
      assert.equal(f.calls.length, 1);
      ctrl.track("more");
      await ctrl.flush();
      b.hide();
      b.pagehide(false);
      await sleep(20);
      assert.equal(f.calls.length, 1, "nothing after the first refusal");
      await ctrl.stop();
      assert.equal(f.calls.length, 1);
    } finally {
      restore();
    }
  });
}

test("400: the batch is dropped (never resent); three in a row stop uploads", async () => {
  const restore = silence();
  try {
    const { f, ctrl } = await start({ respond: () => json(400, { ok: false, error: { code: "BAD_REQUEST", message: "x" } }) });
    ctrl.track("a"); await ctrl.flush();
    ctrl.track("b"); await ctrl.flush();
    ctrl.track("c"); await ctrl.flush();
    assert.equal(f.calls.length, 3);
    const ids = all(f).map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "no event sent twice");
  } finally {
    restore();
  }
});

test("5xx: events are kept and delivered once after a backoff", async () => {
  let n = 0;
  const { f, ctrl } = await start({ config: { flushIntervalMs: 100 }, respond: () => (++n <= 3 ? json(503, {}) : ok()) });
  await sleep(1_600);
  const delivered = f.calls.slice(3);
  assert.ok(delivered.length >= 1, "delivered after the failures");
  const firstIds = f.calls[0].envelope.events.map((e) => e.id);
  const okIds = delivered.flatMap((c) => c.envelope.events.map((e) => e.id));
  for (const id of firstIds) assert.ok(okIds.includes(id), "requeued events arrive");
  assert.equal(new Set(okIds).size, okIds.length, "each once");
  await ctrl.stop();
});

test("inactivity rotation: a failed send of the ended session never lands in the new one", async () => {
  let holdSid = null;
  let releaseHeld;
  const gate = new Promise((r) => (releaseHeld = r));
  const respond = async (req) => {
    if (req.envelope.sessionId === holdSid) {
      await gate;
      throw new TypeError("Failed to fetch");
    }
    return ok();
  };
  // 600ms window; the idle check runs every 1s → the session ends at ~1s.
  const { b, f, ctrl } = await start({ respond, config: { sessionInactivityMs: 600, flushIntervalMs: 100 } });
  const s1 = f.calls[0].envelope.sessionId;
  holdSid = s1;
  await sleep(900); // idle end: session_end(inactivity) goes out, held
  const held = f.calls.filter((c) => c.envelope.sessionId === s1 && types(c.envelope).includes("session_end"));
  assert.ok(held.length >= 1, "the inactivity end was sent");
  b.window.fire("pointerdown"); // the user returns → rotate
  assert.notEqual(ctrl.sessionId, s1);
  releaseHeld();
  await sleep(1_600);
  const s2Events = f.calls.filter((c) => c.envelope.sessionId === ctrl.sessionId).flatMap((c) => c.envelope.events);
  assert.ok(s2Events.length > 0);
  const s1Ids = new Set(held.flatMap((c) => c.envelope.events.map((e) => e.id)));
  assert.ok(!s2Events.some((e) => s1Ids.has(e.id)), "no S1 event (its inactivity end included) under S2");
  await ctrl.stop();
});

test("a reload (resumed session) records one page view, no second session start", async () => {
  const storage = new Map();
  const p1 = await start({ storage, config: { sessionInactivityMs: 60_000 } });
  const sid = p1.f.calls[0].envelope.sessionId;
  p1.b.pagehide(false);
  const p2 = await start({ storage, config: { sessionInactivityMs: 60_000 } });
  const first = p2.f.calls[0].envelope;
  assert.equal(first.sessionId, sid);
  assert.equal(types(first).filter((t) => t === "navigation").length, 1);
  assert.equal(types(first).filter((t) => t === "session_start").length, 0);
  assert.ok(first.sequence > p1.f.calls.at(-1).envelope.sequence, "numbering continues");
  await p2.ctrl.stop();
});

test("excludeUrls applies even when the remote config never arrives", async () => {
  const { b, f, ctrl } = await start({ href: "https://app.test/admin/users", config: { excludeUrls: ["/admin/**"] } });
  ctrl.track("x");
  b.hide();
  b.pagehide(false);
  await sleep(20);
  assert.equal(f.calls.length, 0);
  await ctrl.stop();
});

test("stop(): one manual session_end, then the page lifecycle no longer sends", async () => {
  const { b, f, ctrl } = await start();
  await ctrl.stop();
  assert.deepEqual(ends(f).map((e) => e.data.reason), ["manual"]);
  assert.equal(b.window.count("pagehide") + b.window.count("pageshow") + b.document.count("visibilitychange"), 0);
  const n = f.calls.length;
  b.hide();
  b.pagehide(false);
  await sleep(20);
  assert.equal(f.calls.length, n);
});

test("inactivity end then close: one session_end for that session", async () => {
  const { b, f, ctrl } = await start({ config: { sessionInactivityMs: 600 } });
  await sleep(900);
  b.pagehide(false);
  await sleep(20);
  assert.deepEqual(ends(f).map((e) => e.data.reason), ["inactivity"]);
  await ctrl.stop();
});

test("always-record-errors flip takes a fresh base snapshot", async () => {
  const { f, ctrl } = await start({ remote: remoteCfg({ rate: 0, alwaysRecordErrors: true }) });
  assert.equal(f.calls.length, 0);
  globalThis.__emitError({ message: "boom" });
  await ctrl.flush();
  const t = f.calls.flatMap((c) => types(c.envelope));
  assert.ok(t.includes("error") && t.includes("full_snapshot"), t.join(","));
  await ctrl.stop();
});

test("a regular send still pending at pagehide is re-delivered (same sequence)", async () => {
  const respond = (req) => (req.keepalive ? ok() : new Promise(() => {}));
  const { b, f, ctrl } = await start({ respond });
  const n = f.calls.length;
  for (let i = 0; i < 7; i += 1) {
    const props = {};
    for (let k = 0; k < 20; k += 1) props[`k${k}`] = randomBytes(150).toString("base64");
    ctrl.track(`big${i}`, props);
  }
  void ctrl.flush();
  await sleep(150);
  const pending = f.calls.slice(n).find((c) => !c.keepalive);
  assert.ok(pending, "a big batch went out as a normal fetch");
  b.pagehide(false);
  await sleep(20);
  const again = f.calls.filter((c) => c.keepalive && c.envelope.sequence === pending.envelope.sequence);
  assert.equal(again.length, 1, "re-sent once with keepalive");
  assert.equal(again[0].envelope.segmentId, pending.envelope.segmentId);
});

test("minimum duration: the first page of a multi-page visit is kept, a bounce is not", async () => {
  const storage = new Map();
  const remote = remoteCfg({ minDurationMs: 1500 });
  const conf = { sessionInactivityMs: 60_000 };
  // page 1: under the minimum the whole time, then a same-tab navigation
  const p1 = await start({ storage, remote, config: conf });
  p1.ctrl.track("on-page-1");
  assert.equal(p1.f.calls.length, 0, "held: under the minimum duration");
  p1.b.pagehide(false);
  await sleep(20);
  assert.equal(p1.f.calls.length, 0, "nothing uploaded on the way out");
  const outbox = JSON.parse(storage.get("replay:outbox"));
  const seg1 = outbox.batches[0].segmentId;
  // page 2 continues the session; once past the minimum, page 1 goes first
  const p2 = await start({ storage, remote, config: conf });
  await sleep(1200);
  await p2.ctrl.flush();
  await p2.ctrl.flush();
  const [first, second] = p2.f.calls.map((c) => c.envelope);
  assert.equal(first.segmentId, seg1, "page 1's events under page 1's segment");
  assert.ok(types(first).includes("full_snapshot"));
  assert.ok(first.events.some((e) => e.data?.name === "on-page-1"));
  assert.deepEqual(first.events.filter((e) => e.type === "session_end").map((e) => e.data.reason), ["unload"]);
  assert.notEqual(second.segmentId, seg1);
  assert.equal(second.sessionId, first.sessionId);
  await p2.ctrl.stop();

  // a bounce: under the minimum and no page continues the session
  const bounce = await start({ remote, config: conf });
  bounce.ctrl.track("x");
  bounce.b.pagehide(false);
  await sleep(20);
  assert.equal(bounce.f.calls.length, 0);
  // the tab is gone (its sessionStorage with it); a new tab never sends it
  const other = await start({ remote, config: conf });
  await sleep(1200);
  await other.ctrl.flush();
  assert.ok(other.f.calls.every((c) => !c.envelope.events.some((e) => e.data?.name === "x")));
  await other.ctrl.stop();
});
