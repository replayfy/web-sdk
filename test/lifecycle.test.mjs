// initReplay end to end (real SDK code; rrweb/signals/fingerprint/remote-config
// stubbed): what leaves the page on tab switches, closes, back/forward-cache
// restores, server rejections and session rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { installBrowser, load, makeFetch, ok, json, sleep, types, readOutbox, TEST_SDK_VERSION } from "./helpers.mjs";

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

test("a short visit is uploaded at once, whatever the minimum duration (the server judges it)", async () => {
  const { b, f } = await start({ remote: remoteCfg({ minDurationMs: 60_000 }) });
  assert.ok(f.calls.length >= 1 && types(f.calls[0].envelope).includes("full_snapshot"), "first batch right away");
  globalThis.__emitError({ message: "boom" });
  b.pagehide(false);
  await sleep(20);
  const t = all(f).map((e) => e.type);
  assert.ok(t.includes("error") && t.includes("session_end"), t.join(","));
});

test("stop() before the first show or a slow remote config leaves nothing recording", async () => {
  // a tab loaded hidden, stopped, then shown
  const b = installBrowser({ visible: false });
  const f = makeFetch();
  const { initReplay } = await load("initReplay.ts", { stub: true });
  const ctrl = initReplay({ apiKey: "k", apiHost: "https://api.test", flushIntervalMs: 1e9, fetchImpl: f });
  await ctrl.stop();
  assert.equal(b.document.count("visibilitychange"), 0);
  b.show();
  await sleep(450);
  assert.ok(!globalThis.__rrweb.recording, "rrweb never started");
  assert.equal(f.calls.length, 0);

  // stop() while the remote config is slower than the 300ms race, then it arrives
  installBrowser();
  let deliver;
  globalThis.__remoteConfig = () => new Promise((r) => { deliver = r; });
  const f2 = makeFetch();
  const { initReplay: init2 } = await load("initReplay.ts", { stub: true });
  const c2 = init2({ apiKey: "k", apiHost: "https://api.test", flushIntervalMs: 1e9, fetchImpl: f2 });
  await sleep(50);
  await c2.stop();
  await sleep(350); // the race's timeout branch runs now
  deliver(remoteCfg());
  await sleep(50);
  assert.ok(!globalThis.__rrweb.recording, "neither the timeout branch nor the late config re-installs rrweb");
});

// Page 1 buffers more than the unload budget, then a same-tab navigation.
async function overflowingPage1(storage) {
  const conf = { sessionInactivityMs: 60_000 };
  const p1 = await start({ storage, config: conf, href: "https://app.test/landing?utm_source=google" });
  for (let i = 0; i < 160; i += 1) p1.ctrl.track(`t${i}`, { v: randomBytes(300).toString("base64") });
  p1.b.pagehide(false);
  await sleep(20);
  const sentNames = all(p1.f).filter((e) => e.type === "custom").map((e) => e.data.name);
  return { p1, conf, sentNames };
}

test("what doesn't fit the unload budget on a navigation reaches the next page, under its own page", async () => {
  const storage = new Map();
  const { p1, conf, sentNames } = await overflowingPage1(storage);
  assert.ok(sentNames.length > 0 && sentNames.length < 160, `unload batch carried ${sentNames.length}`);
  const seg1 = p1.f.calls[0].envelope.segmentId;
  const p2 = await start({ storage, config: conf, href: "https://app.test/product" });
  const first = p2.f.calls[0].envelope;
  assert.equal(first.segmentId, seg1, "page 1's leftovers under page 1's segment");
  assert.match(first.page.url, /\/landing\?utm_source=google/, "and page 1's URL");
  const late = first.events.filter((e) => e.type === "custom").map((e) => e.data.name);
  assert.equal(new Set([...sentNames, ...late]).size, 160, "nothing lost");
  await p2.ctrl.stop();
});

test("a page 2 that leaves before its snapshot hands page 1's leftovers on", async () => {
  const storage = new Map();
  const { p1, conf } = await overflowingPage1(storage);
  const seg1 = p1.f.calls[0].envelope.segmentId;
  // page 2: a redirect, gone before rrweb even started
  const b2 = installBrowser({ storage });
  const { initReplay } = await load("initReplay.ts", { stub: true });
  initReplay({ apiKey: "k", apiHost: "https://api.test", flushIntervalMs: 1e9, fetchImpl: makeFetch(), ...conf });
  b2.pagehide(false);
  const outbox = readOutbox(storage);
  assert.equal(outbox.batches[0].segmentId, seg1, "page 1's leftovers first");
  assert.equal(outbox.batches.length, 2, "then the redirect page's own events (its page view)");
  assert.notEqual(outbox.batches[1].segmentId, seg1);
});

test("a redirect before the first snapshot keeps the landing page's session_start, URL and UTM tags", async () => {
  const storage = new Map();
  const conf = { sessionInactivityMs: 60_000 };
  const b1 = installBrowser({ storage, href: "https://app.test/landing?utm_source=google" });
  globalThis.__remoteConfig = () => new Promise(() => {}); // slow config: rrweb waits for the 300ms race
  const { initReplay } = await load("initReplay.ts", { stub: true });
  initReplay({ apiKey: "k", apiHost: "https://api.test", flushIntervalMs: 1e9, fetchImpl: makeFetch(), ...conf });
  await sleep(50); // before the 300ms remote-config race → no snapshot yet
  b1.pagehide(false);
  const p2 = await start({ storage, config: conf, href: "https://app.test/home" });
  const first = p2.f.calls[0].envelope;
  assert.match(first.page.url, /\/landing\?utm_source=google/);
  assert.ok(types(first).includes("session_start"), types(first).join(","));
  await p2.ctrl.stop();
});

test("leftovers are handed on when the page goes into the back/forward cache too", async () => {
  const storage = new Map();
  const conf = { sessionInactivityMs: 60_000 };
  const p1 = await start({ storage, config: conf });
  for (let i = 0; i < 160; i += 1) p1.ctrl.track(`t${i}`, { v: randomBytes(300).toString("base64") });
  p1.b.pagehide(true);
  await sleep(20);
  const sent = all(p1.f).filter((e) => e.type === "custom").map((e) => e.data.name);
  const p2 = await start({ storage, config: conf });
  await p2.ctrl.flush();
  const late = all(p2.f).filter((e) => e.type === "custom").map((e) => e.data.name);
  assert.equal(new Set([...sent, ...late]).size, 160, "nothing lost");
  await p2.ctrl.stop();
});

test("a page that doesn't record still hands an earlier page's leftovers on", async () => {
  const storage = new Map();
  const conf = { sessionInactivityMs: 60_000 };
  const p1 = await start({ storage, config: conf });
  for (let i = 0; i < 160; i += 1) p1.ctrl.track(`t${i}`, { v: randomBytes(300).toString("base64") });
  p1.b.pagehide(false);
  await sleep(20);
  const seg1 = p1.f.calls[0].envelope.segmentId;
  const p2 = await start({ storage, config: { ...conf, excludeUrls: ["/a"] } });
  p2.b.pagehide(false);
  const outbox = readOutbox(storage);
  assert.deepEqual(outbox.batches.map((x) => x.segmentId), [seg1]);
});

test("an earlier page's batch doesn't delay this page's first snapshot", async () => {
  const storage = new Map();
  const conf = { sessionInactivityMs: 60_000 };
  const p1 = await start({ storage, config: conf });
  for (let i = 0; i < 160; i += 1) p1.ctrl.track(`t${i}`, { v: randomBytes(300).toString("base64") });
  p1.b.pagehide(false);
  await sleep(20);
  const p2 = await start({ storage, config: conf });
  const segs = p2.f.calls.map((c) => c.envelope.segmentId);
  assert.equal(segs.length, 2, "page 1's leftovers, then page 2's snapshot batch, without waiting a flush interval");
  assert.ok(types(p2.f.calls[1].envelope).includes("full_snapshot"));
  await p2.ctrl.stop();
});

test("a large upload still in flight at navigation reaches the next page under its own sequence", async () => {
  const storage = new Map();
  const conf = { sessionInactivityMs: 60_000 };
  const respond = (req) => (req.keepalive ? ok() : new Promise(() => {}));
  const p1 = await start({ storage, config: conf, respond });
  for (let i = 0; i < 20; i += 1) {
    const props = {};
    for (let k = 0; k < 20; k += 1) props[`k${k}`] = randomBytes(150).toString("base64");
    p1.ctrl.track(`big${i}`, props);
  }
  void p1.ctrl.flush();
  await sleep(150);
  const pending = p1.f.calls.find((c) => !c.keepalive);
  assert.ok(pending, "a big normal fetch is in flight");
  p1.b.pagehide(false);
  await sleep(20);
  const p2 = await start({ storage, config: conf });
  const again = p2.f.calls.find((c) => c.envelope.sequence === pending.envelope.sequence);
  assert.ok(again, "resent by page 2 under the same sequence");
  assert.equal(again.envelope.segmentId, pending.envelope.segmentId);
  await p2.ctrl.stop();
});

test("track() after stop() doesn't rotate an idle session", async () => {
  const { b, ctrl } = await start({ config: { sessionInactivityMs: 300 } });
  await sleep(600); // ended for inactivity
  const before = JSON.parse(b.store.get("replay:ses")).sid;
  await ctrl.stop();
  ctrl.track("after-stop");
  assert.equal(JSON.parse(b.store.get("replay:ses")).sid, before);
});

test("back/forward-cache restore into a new session records a page view", async () => {
  const { b, f, ctrl } = await start({ config: { sessionInactivityMs: 400 } });
  const sid = f.calls[0].envelope.sessionId;
  b.pagehide(true);
  b.hide();
  await sleep(700);
  b.show();
  b.pageshow(true);
  await sleep(60);
  const t = f.calls.map((c) => c.envelope).filter((e) => e.sessionId !== sid).flatMap(types);
  assert.ok(t.includes("session_start") && t.includes("navigation") && t.includes("full_snapshot"), t.join(","));
  await ctrl.stop();
});

test("tab switch then close while that batch is in flight: the close still sends its session_end", async () => {
  const respond = () => new Promise(() => {}); // nothing ever completes
  const { b, f, ctrl } = await start({ respond });
  // many small events: the tab-switch batch fills the budget to within one of them
  for (let i = 0; i < 160; i += 1) ctrl.track(`t${i}`, { v: randomBytes(300).toString("base64") });
  b.hide();
  await sleep(150);
  b.pagehide(false);
  await sleep(20);
  assert.deepEqual(ends(f).map((e) => e.data.reason), ["unload"]);
});

test("a beforeSend that grows the unload batch still gets the session_end out", async () => {
  const pad = ({ envelope }) => ({ envelope: { ...envelope, events: envelope.events.map((e) => ({ ...e, data: { ...e.data, pad: "p".repeat(1500) } })) } });
  const { b, f, ctrl } = await start({ config: { beforeSend: pad } });
  const n = f.calls.length;
  for (let i = 0; i < 40; i += 1) ctrl.track(`t${i}`, { v: "x".repeat(300) });
  b.pagehide(false);
  await sleep(20);
  const out = f.calls.slice(n);
  assert.ok(out.length >= 1, "something was sent");
  assert.deepEqual(ends(f).map((e) => e.data.reason), ["unload"]);
});
