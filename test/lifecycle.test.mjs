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

async function start({ respond, config = {}, href, storage, remote, local, title } = {}) {
  const b = installBrowser({ href, storage, local, title });
  // `remote` is the config itself, or a function called when the SDK fetches it
  // (to answer late).
  if (remote !== undefined) globalThis.__remoteConfig = typeof remote === "function" ? remote : () => remote;
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

// Answers 504 (a proxy timeout: the server may have stored the batch anyway)
// to the next `n` requests once armed; a regular send makes three attempts.
const failNext = () => {
  let left = 0;
  const respond = () => (left > 0 ? ((left -= 1), json(504, {})) : ok());
  respond.arm = (n = 3) => { left = n; };
  return respond;
};
// A beforeSend that isn't idempotent (like one that hashes a value): it wraps
// every track() name, and records the names it was given.
const wrapNames = (seen) => ({ envelope }) => {
  for (const e of envelope.events) if (e.data?.name) seen.push(e.data.name);
  const events = envelope.events.map((e) => (e.data?.name ? { ...e, data: { ...e.data, name: `h(${e.data.name})` } } : e));
  return { envelope: { ...envelope, events } };
};
// Every event id mapped to the batch numbers it was sent under.
const sequencesById = (f) => {
  const m = new Map();
  for (const { envelope } of f.calls) {
    for (const e of envelope.events) m.set(e.id, new Set([...(m.get(e.id) ?? []), envelope.sequence]));
  }
  return m;
};

test("a batch that fails every attempt is resent whole, under the same sequence and segment", async () => {
  const respond = failNext();
  const seen = [];
  const { f, ctrl } = await start({ respond, config: { flushIntervalMs: 100, beforeSend: wrapNames(seen) } });
  const n = f.calls.length;
  respond.arm(3);
  ctrl.track("a");
  await ctrl.flush();
  const failed = f.calls.slice(n).map((c) => c.envelope);
  assert.equal(failed.length, 3, "three attempts, all failed");
  ctrl.track("b"); // captured during the backoff
  await sleep(700);
  const after = f.calls.slice(n + 3).map((c) => c.envelope);
  assert.ok(after.length >= 2, `resent, then the newer events (${after.length})`);
  const [resend] = after;
  assert.deepEqual([resend.sequence, resend.segmentId], [failed[0].sequence, failed[0].segmentId]);
  assert.deepEqual(resend.events, failed[0].events, "the same batch, nothing merged into it");
  const newer = after.find((e) => e.events.some((x) => x.data?.name === "h(b)"));
  assert.ok(newer && newer.sequence > resend.sequence, "newer events under a later number");
  // the hook ran on it once; on the resend it was only asked (on a copy)
  assert.deepEqual(seen.filter((s) => ["a", "h(a)"].includes(s)), ["a", "h(a)"]);
  assert.ok(!all(f).some((e) => e.data?.name?.startsWith("h(h(")), "never sent through the hook twice");
  for (const [id, seqs] of sequencesById(f)) assert.equal(seqs.size, 1, `${id} sent under one number`);
  await ctrl.stop();
});

test("a carried batch whose send fails keeps the number it was first sent under", async () => {
  const storage = new Map();
  const { p1, conf } = await overflowingPage1(storage);
  const seg1 = p1.f.calls[0].envelope.segmentId;
  let fails = 3;
  const respond = () => (fails-- > 0 ? json(503, {}) : ok());
  const p2 = await start({ storage, respond, config: { ...conf, flushIntervalMs: 100 }, href: "https://app.test/product" });
  await sleep(1_400); // three attempts (~0.9s), the backoff, the resend
  const sent = p2.f.calls.map((c) => c.envelope);
  const page1 = sent.filter((e) => e.segmentId === seg1);
  assert.ok(page1.length >= 4, `three failed attempts, then the resend (${page1.length})`);
  assert.equal(new Set(page1.map((e) => e.sequence)).size, 1, "one number for every attempt");
  assert.match(page1.at(-1).page.url, /\/landing\?utm_source=google/, "still under page 1's URL");
  const own = sent.find((e) => e.segmentId !== seg1);
  assert.ok(own && own.sequence > page1[0].sequence, "page 2's own events after it");
  await p2.ctrl.stop();
});

test("a failed batch still held at close goes in the unload batch, under its number and as the hook left it", async () => {
  const respond = failNext();
  const seen = [];
  const { b, f, ctrl } = await start({ respond, config: { beforeSend: wrapNames(seen) } });
  const n = f.calls.length;
  respond.arm(3);
  ctrl.track("a");
  await ctrl.flush();
  const failed = f.calls[n].envelope;
  b.pagehide(false);
  await sleep(20);
  const out = f.calls.slice(n + 3);
  assert.ok(out.length >= 2, `the held batch, then the tail (${out.length})`);
  assert.equal(out[0].keepalive, true);
  assert.deepEqual([out[0].envelope.sequence, out[0].envelope.segmentId], [failed.sequence, failed.segmentId]);
  assert.deepEqual(out[0].envelope.events, failed.events);
  assert.deepEqual(seen.filter((s) => ["a", "h(a)"].includes(s)), ["a", "h(a)"], "asked again, on a copy");
  assert.ok(!all(f).some((e) => e.data?.name?.startsWith("h(h(")), "never sent through the hook twice");
  const tail = out.at(-1).envelope;
  assert.ok(types(tail).includes("session_end") && tail.sequence > failed.sequence);
  await ctrl.stop();
});

test("a tab switch while a failed batch is held sends a copy under its number, and keeps it for the retry", async () => {
  const respond = failNext();
  const { b, f, ctrl } = await start({ respond });
  const n = f.calls.length;
  respond.arm(3);
  ctrl.track("a");
  await ctrl.flush();
  const failed = f.calls[n].envelope;
  ctrl.track("b");
  b.hide(); // the page may be discarded in the background with no other event
  await sleep(20);
  const hidden = f.calls.slice(n + 3);
  assert.equal(hidden.length, 2, "the copy, then the tail");
  assert.deepEqual([hidden[0].envelope.sequence, hidden[0].envelope.segmentId], [failed.sequence, failed.segmentId]);
  assert.deepEqual(hidden[0].envelope.events, failed.events);
  assert.ok(hidden[1].envelope.events.some((e) => e.data?.name === "b") && hidden[1].envelope.sequence > failed.sequence);
  // the page lives on: the regular retry resends it under the same number
  b.show();
  await ctrl.stop();
  const resent = f.calls.slice(n + 5).filter((c) => c.envelope.sequence === failed.sequence);
  assert.equal(resent.length, 1);
  for (const [id, seqs] of sequencesById(f)) assert.equal(seqs.size, 1, `${id} sent under one number`);
});

test("stop() during an upload that fails delivers it under its number, then the session end", async () => {
  const respond = failNext();
  const { f, ctrl } = await start({ respond });
  const n = f.calls.length;
  respond.arm(3);
  ctrl.track("a");
  void ctrl.flush();
  await sleep(50); // in flight
  await ctrl.stop();
  const out = f.calls.slice(n).map((c) => c.envelope);
  assert.equal(out.length, 5, "three failed attempts, the resend, the closing batch");
  assert.equal(out[3].sequence, out[0].sequence);
  assert.deepEqual(out[3].events, out[0].events);
  assert.ok(types(out[4]).includes("session_end") && out[4].sequence > out[0].sequence);
});

test("stop() while an earlier page's batch fails under it still sends the session end before resolving", async () => {
  const storage = new Map();
  const { conf } = await overflowingPage1(storage);
  let fails = 3;
  const p2 = await start({ storage, config: conf, respond: () => (fails-- > 0 ? json(503, {}) : ok()) });
  assert.ok(p2.f.calls.length >= 1, "page 1's batch is in flight");
  await p2.ctrl.stop();
  assert.deepEqual(ends(p2.f).map((e) => e.data.reason), ["manual"]);
});

// A big rrweb diff from the stubbed recorder (an incremental snapshot).
const bigDiff = (n) => globalThis.__rrweb.emit({ type: 3, timestamp: Date.now(), data: { source: 0, pad: "x".repeat(n) } });

test("a failed batch too big for the unload request still sends its error and custom events at close; the rest keeps its number", async () => {
  const storage = new Map();
  const conf = { sessionInactivityMs: 60_000 };
  const respond = failNext();
  const p1 = await start({ storage, respond, config: conf });
  const n = p1.f.calls.length;
  respond.arm(3);
  p1.ctrl.captureException(new Error("boom"));
  p1.ctrl.track("checkout_clicked");
  for (let i = 0; i < 6; i += 1) bigDiff(12_000);
  await p1.ctrl.flush();
  assert.equal(p1.f.calls.length, n + 3, "three failed attempts");
  const failed = p1.f.calls[n].envelope;
  p1.b.pagehide(false); // closed during the backoff
  await sleep(20);
  const out = p1.f.calls.slice(n + 3).map((c) => c.envelope);
  const part = out.find((e) => types(e).includes("error"));
  assert.ok(part, "the error left with the page");
  assert.deepEqual(types(part).sort(), ["custom", "error"], "only its priority events");
  assert.ok(part.segmentId === failed.segmentId && part.sequence > failed.sequence, "under its segment, a new number");
  assert.equal(part.page.url, failed.page.url);
  assert.ok(!out.some((e) => e.sequence === failed.sequence), "too big to go whole");
  assert.ok(types(out.at(-1)).includes("session_end"));
  // a same-tab navigation: the rest (its replay stream) goes under its number
  const p2 = await start({ storage, config: conf });
  const rest = p2.f.calls.find((c) => c.envelope.sequence === failed.sequence)?.envelope;
  assert.ok(rest, "resent by page 2 under its number");
  assert.deepEqual(rest.events.map((e) => e.id), failed.events.filter((e) => !["error", "custom"].includes(e.type)).map((e) => e.id));
  for (const [id, seqs] of sequencesById({ calls: [...p1.f.calls.slice(n + 3), ...p2.f.calls] })) {
    assert.equal(seqs.size, 1, `${id} sent under one number after the failed attempts`);
  }
  await p2.ctrl.stop();
});

test("a tab switch while a failed batch too big to copy is held sends its error now; the retry sends the rest under its number", async () => {
  const respond = failNext();
  const { b, f, ctrl } = await start({ respond });
  const n = f.calls.length;
  respond.arm(3);
  ctrl.captureException(new Error("boom"));
  for (let i = 0; i < 4; i += 1) bigDiff(9_000);
  await ctrl.flush();
  const failed = f.calls[n].envelope;
  ctrl.track("after");
  b.hide(); // a hidden page can be discarded with no further event
  await sleep(20);
  const hidden = f.calls.slice(n + 3).map((c) => c.envelope);
  const part = hidden.find((e) => types(e).includes("error"));
  assert.ok(part, "its error went on hide");
  assert.deepEqual(types(part), ["error"]);
  assert.ok(part.segmentId === failed.segmentId && part.sequence > failed.sequence);
  assert.ok(!hidden.some((e) => e.sequence === failed.sequence), "too big to copy whole");
  b.show();
  await ctrl.stop();
  const retried = f.calls.slice(n + 3).map((c) => c.envelope).filter((e) => e.sequence === failed.sequence);
  assert.equal(retried.length, 1);
  assert.deepEqual(retried[0].events.map((e) => e.id), failed.events.filter((e) => e.type !== "error").map((e) => e.id));
  for (const [id, seqs] of sequencesById({ calls: f.calls.slice(n + 3) })) assert.equal(seqs.size, 1, `${id} under one number`);
});

test("tab switches during one backoff send the held batch once, not once per switch", async () => {
  const respond = failNext();
  const { b, f, ctrl } = await start({ respond });
  const n = f.calls.length;
  respond.arm(3);
  ctrl.track("a");
  await ctrl.flush();
  const failed = f.calls[n].envelope;
  for (let i = 0; i < 3; i += 1) {
    b.hide();
    await sleep(10);
    b.show();
  }
  const copies = f.calls.slice(n + 3).filter((c) => c.envelope.sequence === failed.sequence);
  assert.equal(copies.length, 1);
  await ctrl.stop();
});

test("a held batch goes again only if beforeSend still lets it: a hook that now returns null drops it", async () => {
  const respond = failNext();
  let consent = true;
  const { b, f, ctrl } = await start({ respond, config: { beforeSend: (ctx) => (consent ? ctx : null) } });
  const n = f.calls.length;
  respond.arm(3);
  ctrl.track("while_consented");
  await ctrl.flush();
  consent = false; // the user withdrew consent
  b.hide(); // no copy on the tab switch
  await sleep(20);
  b.show();
  await ctrl.stop(); // nor when stop() delivers what is left
  assert.equal(f.calls.length, n + 3, "nothing sent after the withdrawal");
});

test("a failed batch of a page without beforeSend goes through the hook of the next page that has one", async () => {
  const storage = new Map();
  const respond = failNext();
  const p1 = await start({ storage, respond, config: { sessionInactivityMs: 60_000 } });
  const n = p1.f.calls.length;
  respond.arm(3);
  for (let i = 0; i < 6; i += 1) bigDiff(12_000); // too big for the unload request
  await p1.ctrl.flush();
  const failed = p1.f.calls[n].envelope;
  p1.b.pagehide(false);
  await sleep(20);
  const scrub = ({ envelope }) => ({ envelope: { ...envelope, events: envelope.events.map((e) => ({ ...e, data: { ...e.data, scrubbed: true } })) } });
  const p2 = await start({ storage, config: { sessionInactivityMs: 60_000, beforeSend: scrub } });
  const again = p2.f.calls.find((c) => c.envelope.sequence === failed.sequence)?.envelope;
  assert.ok(again, "resent by page 2 under its number");
  assert.ok(again.events.length > 0 && again.events.every((e) => e.data.scrubbed), "through page 2's hook");
  await p2.ctrl.stop();
});

test("an upload in flight at navigation from a page without beforeSend goes through the next page's hook", async () => {
  const storage = new Map();
  const respond = (req) => (req.keepalive ? ok() : new Promise(() => {}));
  const p1 = await start({ storage, config: { sessionInactivityMs: 60_000 }, respond });
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
  const p2 = await start({ storage, config: { sessionInactivityMs: 60_000, beforeSend: wrapNames([]) } });
  const again = p2.f.calls.find((c) => c.envelope.sequence === pending.envelope.sequence)?.envelope;
  assert.ok(again, "resent by page 2 under the same sequence");
  const names = again.events.filter((e) => e.type === "custom").map((e) => e.data.name);
  assert.ok(names.length > 0 && names.every((x) => /^h\(big\d+\)$/.test(x)), "scrubbed by page 2's hook");
  await p2.ctrl.stop();
});

test("stop() waits for every send it starts: a held batch's resend fails once under it, then the session end", async () => {
  const respond = failNext();
  const { f, ctrl } = await start({ respond });
  respond.arm(3);
  ctrl.track("a");
  await ctrl.flush(); // fails 3x: held, in backoff
  respond.arm(3); // the first delivery under stop() fails as well
  await ctrl.stop();
  assert.equal(ends(f).length, 1, "the session end went before stop() resolved");
  const count = f.calls.length;
  await sleep(100);
  assert.equal(f.calls.length, count, "nothing sent after stop() resolved");
});

// A beforeSend that edits events in place, like one that hashes a value; with
// `grow` set it also pads the batch past the keepalive budget.
const hashInPlace = (state) => ({ envelope }) => {
  for (const e of envelope.events) if (e.data?.name) e.data.name = `h(${e.data.name})`;
  if (!state.grow) return { envelope };
  const pad = { ...envelope.events[0], id: "pad", type: "console", data: { pad: "x".repeat(60_000) } };
  if (state.grow === "once") state.grow = false;
  return { envelope: { ...envelope, events: [...envelope.events, pad] } };
};
const customNames = (calls) => calls.flatMap((c) => c.envelope.events).filter((e) => e.type === "custom").map((e) => e.data.name);

test("an unload batch retried smaller doesn't run an in-place beforeSend twice on its events", async () => {
  const state = { grow: false };
  const { b, f, ctrl } = await start({ config: { beforeSend: hashInPlace(state) } });
  const n = f.calls.length;
  ctrl.track("a");
  state.grow = "once"; // the first try no longer fits; the smaller retry does
  b.pagehide(false);
  await sleep(20);
  assert.deepEqual(customNames(f.calls.slice(n)), ["h(a)"]);
  await ctrl.stop();
});

test("an unload batch refused on every try goes back to the buffer as it was, not as an in-place beforeSend left it", async () => {
  const state = { grow: false };
  const { b, f, ctrl } = await start({ config: { beforeSend: hashInPlace(state) } });
  const n = f.calls.length;
  ctrl.track("a");
  state.grow = true; // no try fits the keepalive budget
  b.hide(); // the events stay buffered; the regular flush after it sends them
  await sleep(50);
  state.grow = false;
  await ctrl.stop();
  assert.deepEqual(customNames(f.calls.slice(n)), ["h(a)"]);
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

test("an upload carried to the next page goes out as it was sent, not through beforeSend again", async () => {
  const storage = new Map();
  const seen = [];
  const conf = { sessionInactivityMs: 60_000, beforeSend: wrapNames(seen) };
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
  assert.deepEqual(again.envelope.events, pending.envelope.events, "the same events");
  assert.ok(!all(p2.f).some((e) => e.data?.name?.startsWith("h(h(")), "never sent through the hook twice");
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

// ── Privacy: text, input and selector masking ───────────────────────────────

const withPrivacy = (p = {}) => {
  const r = remoteCfg();
  return { ...r, privacy: { ...r.privacy, ...p } };
};
/** A remote config that answers `ms` after the SDK asks for it. */
const later = (value, ms) => () => new Promise((r) => setTimeout(() => r(value), ms));
const rr = () => globalThis.__rrweb;
const captureWarns = () => {
  const w = console.warn;
  const list = [];
  console.warn = (...a) => list.push(a.map(String).join(" "));
  return { list, restore: () => { console.warn = w; } };
};
/** A fake element in the recorded document; `seen` collects closest() selectors. */
const fakeEl = (seen = [], { tag = "p", priv = false } = {}) => ({
  localName: tag,
  tagName: tag.toUpperCase(),
  closest: (s) => { seen.push(s); return priv ? {} : null; },
  getRootNode: () => globalThis.document,
  ownerDocument: globalThis.document,
  getAttribute: () => null,
  hasAttribute: () => false,
});
const fakeInput = (type, attrs = {}, priv = false) => ({
  ...fakeEl([], { tag: type === "textarea" ? "textarea" : "input", priv }),
  type,
  getAttribute: (n) => (n === "type" ? type : n in attrs ? attrs[n] : null),
  hasAttribute: (n) => n in attrs,
});
// rrweb's maskAllInputs types, plus the three its map leaves out (recorded raw).
const INPUT_TYPES = ["color", "date", "datetime-local", "email", "month", "number", "range", "search", "tel", "text", "time", "url", "week", "textarea", "select", "password", "hidden", "file", "image"];
/** The installed maskInputFn stars a plain text value: every value is masked. */
const masksAll = (o) => o.maskInputFn("hello", fakeInput("text")) === "*****";

test("privacy defaults: all text goes through the masker, comments are dropped, inputs are masked", async () => {
  const { ctrl } = await start();
  const o = rr().opts;
  assert.equal(o.maskTextSelector, "*");
  assert.equal(typeof o.maskTextFn, "function");
  assert.deepEqual(o.slimDOMOptions, { comment: true });
  // rrweb's own maskAllInputs would swap in a map without hidden/file/image.
  assert.equal(o.maskAllInputs, undefined);
  assert.deepEqual(Object.keys(o.maskInputOptions).sort(), [...INPUT_TYPES].sort());
  assert.equal(typeof o.maskInputFn, "function");
  assert.equal(o.maskTextFn("Contact jane.doe@example.com", fakeEl()), "Contact ********@*******.***");
  assert.equal(o.maskInputFn("hunter2", fakeInput("password")), "", "a password sends no value and no length");
  assert.equal(o.maskInputFn("hunter2", fakeInput("text", { "data-rr-is-password": "true" })), "", "show-password toggle");
  assert.equal(o.maskInputFn("hello", fakeInput("text")), "*****");
  assert.equal(o.maskInputFn("tok123", fakeInput("hidden")), "", "a hidden input sends nothing");
  assert.equal(o.maskInputFn("C:\\fakepath\\scan.pdf", fakeInput("file")), "", "nor does a file input");
  await ctrl.stop();
});

test("input masking is the app's setting OR the dashboard's force; the dashboard never unmasks", async () => {
  const cases = [
    // [case, remote config, app's maskAllInputs, expected]
    ["no remote config, app unset", undefined, undefined, true],
    ["dashboard off, app unset", withPrivacy({ maskAllInputs: false }), undefined, true],
    ["dashboard off, app opted out", withPrivacy({ maskAllInputs: false }), false, false],
    ["dashboard forces, app opted out", withPrivacy({ maskAllInputs: true }), false, true],
    ["dashboard off, app on", withPrivacy({ maskAllInputs: false }), true, true],
  ];
  for (const [name, remote, maskAllInputs, want] of cases) {
    const { ctrl } = await start({ remote, config: maskAllInputs === undefined ? {} : { maskAllInputs } });
    const o = rr().opts;
    // Every type reaches maskInputFn, which applies the setting per value.
    assert.equal(o.maskAllInputs, undefined, name);
    assert.deepEqual(Object.keys(o.maskInputOptions).sort(), [...INPUT_TYPES].sort(), name);
    assert.equal(o.maskInputFn("hello", fakeInput("text")), want ? "*****" : "hello", name);
    assert.equal(o.maskInputFn("tok123", fakeInput("hidden")), "", name);
    await ctrl.stop();
  }
});

test("an app that opts out still gets the reference tracker's plain-mode masks", async () => {
  const { ctrl } = await start({
    remote: withPrivacy({ maskAllInputs: false, maskSelectors: ["[data-private]"], maskInputTypes: ["password", "tel"] }),
    config: { maskAllInputs: false },
  });
  const f = rr().opts.maskInputFn;
  assert.equal(f("hunter2", fakeInput("password")), "");
  assert.equal(f("hello", fakeInput("text")), "hello");
  assert.equal(f("me@x.io", fakeInput("text")), "*******", "email-like");
  assert.equal(f("abc", fakeInput("email")), "***", "type=email");
  assert.equal(f("card 4111", fakeInput("text")), "*********", "4+ digits");
  assert.equal(f("2024-01-01", fakeInput("date")), "2024-01-01", "dates are not numbers");
  assert.equal(f("555", fakeInput("tel")), "***", "a type the workspace masks");
  assert.equal(f("hello", fakeInput("text", {}, true)), "*****", "inside a private region");
  await ctrl.stop();

  const { ctrl: c2 } = await start({
    remote: withPrivacy({ maskAllInputs: false }),
    config: { maskAllInputs: false, maskInputEmails: false, maskInputNumbers: false },
  });
  const g = rr().opts.maskInputFn;
  assert.equal(g("me@x.io", fakeInput("text")), "me@x.io");
  assert.equal(g("4111", fakeInput("text")), "4111");
  assert.equal(g("hunter2", fakeInput("password")), "", "passwords whatever the flags");
  await c2.stop();
});

test("host and workspace selectors are combined; an invalid block entry is dropped with one warning", async () => {
  const w = captureWarns();
  try {
    const { ctrl } = await start({
      remote: withPrivacy({ maskSelectors: ["[data-private]"], blockSelectors: ["[[", ".no-replay"] }),
      config: { maskTextSelector: ".rpf-mask", blockSelector: ".card" },
    });
    const o = rr().opts;
    const seen = [];
    o.maskTextFn("some text", fakeEl(seen));
    assert.deepEqual(seen, [".rpf-mask, [data-private], .rr-mask"]);
    assert.ok(o.blockSelector.startsWith(".card, .no-replay, "), o.blockSelector);
    assert.ok(!o.blockSelector.includes("[["), o.blockSelector);
    // Media inside a private region is recorded as a placeholder.
    assert.ok(o.blockSelector.includes(":is([data-private]) :is(img, picture, canvas, video, iframe)"), o.blockSelector);
    assert.equal(w.list.filter((m) => m.includes("block selector")).length, 1);
    await ctrl.stop();
  } finally {
    w.restore();
  }
});

test("an invalid mask selector masks all page text, with one warning", async () => {
  const w = captureWarns();
  try {
    const { ctrl } = await start({ remote: withPrivacy({ maskSelectors: ["[["] }), config: { maskTextSelector: ".ok" } });
    const o = rr().opts;
    assert.equal(o.maskTextFn("plain words", fakeEl()), "***** *****");
    assert.equal(o.maskTextFn(".a{b:c}", fakeEl([], { tag: "style" })), ".a{b:c}", "CSS is never altered");
    assert.equal(o.maskInputFn("hello", fakeInput("text")), "*****");
    assert.equal(w.list.filter((m) => m.includes("mask selector")).length, 1);
    await ctrl.stop();
  } finally {
    w.restore();
  }
});

test("maskTextEmails:false keeps ordinary emails but still wipes private text", async () => {
  const { ctrl } = await start({ config: { maskTextEmails: false, maskTextSelector: ".s" } });
  const o = rr().opts;
  assert.equal(o.maskTextSelector, "*");
  assert.equal(o.maskTextFn("mail bob@x.io", fakeEl()), "mail bob@x.io");
  assert.equal(o.maskTextFn("secret", fakeEl([], { priv: true })), "******");
  await ctrl.stop();
});

test("late dashboard rules that add masking restart the recorder; the same rules arriving late don't", async () => {
  const forced = await start({ remote: later(withPrivacy({ maskAllInputs: true }), 400), config: { maskAllInputs: false } });
  await sleep(100);
  assert.equal(rr().installs, 2, "restarted for the force");
  assert.ok(masksAll(rr().opts));
  await forced.ctrl.stop();

  const region = await start({ remote: later(withPrivacy({ maskAllInputs: false, maskSelectors: [".new"] }), 400) });
  await sleep(100);
  assert.equal(rr().installs, 2, "restarted for the new private region");
  const seen = [];
  rr().opts.maskTextFn("x", fakeEl(seen));
  assert.deepEqual(seen, [".new, .rr-mask"]);
  await region.ctrl.stop();

  const same = await start({ remote: later(withPrivacy({ maskAllInputs: false }), 400) });
  await sleep(100);
  assert.equal(rr().installs, 1, "nothing changed: no restart");
  assert.ok(masksAll(rr().opts));
  await same.ctrl.stop();
});

test("the last dashboard rules are kept per key and applied when the config is late", async () => {
  const local = new Map();
  const rules = withPrivacy({ maskAllInputs: true, maskSelectors: ["[data-private]"] });
  const p1 = await start({ local, remote: rules, config: { maskAllInputs: false } });
  await p1.ctrl.stop();
  assert.equal([...local.keys()].filter((k) => k.startsWith("replay:privacy:")).length, 1);

  // The next page's config is slower than the 300ms race: its first snapshot
  // already has the dashboard's rules.
  const p2 = await start({ local, remote: later(rules, 2000), config: { maskAllInputs: false } });
  assert.equal(rr().installs, 1);
  assert.ok(masksAll(rr().opts));
  const seen = [];
  rr().opts.maskTextFn("x", fakeEl(seen));
  assert.deepEqual(seen, ["[data-private], .rr-mask"]);
  await p2.ctrl.stop();

  // Another key gets nothing from it.
  const p3 = await start({ local, remote: later(rules, 2000), config: { apiKey: "other", maskAllInputs: false } });
  assert.ok(!masksAll(rr().opts));
  await p3.ctrl.stop();

  // Storage that throws just means no cached rules.
  const broken = new Map();
  broken.get = () => { throw new Error("blocked"); };
  broken.has = () => { throw new Error("blocked"); };
  broken.set = () => { throw new Error("blocked"); };
  const p4 = await start({ local: broken, remote: later(rules, 2000), config: { maskAllInputs: false } });
  assert.equal(rr().installs, 1);
  assert.ok(!masksAll(rr().opts));
  await p4.ctrl.stop();
});

test("the page title is masked like the replay's <title> text wherever it is sent", async () => {
  const title = "Inbox (3) – jane.doe@example.com";
  const { f, ctrl } = await start({ title, config: { maskTextNumbers: true } });
  const masked = "Inbox (0) – ********@*******.***";
  const start0 = all(f).find((e) => e.type === "session_start");
  assert.equal(start0.data.title, masked, "session_start");
  assert.ok(f.calls.length >= 1);
  for (const c of f.calls) assert.equal(c.envelope.page.title, masked, "every batch's page context");
  assert.equal(globalThis.__navMasker().titleFor(title), masked, "navigation events");
  assert.ok(!JSON.stringify(f.calls.map((c) => c.envelope)).includes("jane.doe"));
  await ctrl.stop();
});

test("URL redaction: the workspace's patterns reach request and resource URLs, with the app's; the replay's page URL is scrubbed", async () => {
  const base = remoteCfg();
  const remote = { ...base, privacy: { ...base.privacy, redactUrlPatterns: ["sessref="] } };
  const { f, ctrl } = await start({ remote, config: { redactUrls: [/hostkey=[^&]*/] } });
  const { redactUrlForStorage } = await load("utils.ts");
  const url = "https://cdn.test/a.png?token=t1&sessref=s1&hostkey=h1&x=1";
  // What the network capture records: its install-time patterns, then the
  // live policy over them (signals.ts urlPolicy). It is installed before the
  // dashboard config arrives.
  const { cfg, getUrlPolicy } = globalThis.__netCapture;
  const request = redactUrlForStorage(url, { patterns: cfg.redactUrls, ...getUrlPolicy() });
  const resource = globalThis.__perfOpts.redactUrl(url);
  for (const out of [request, resource]) {
    assert.ok(!/t1|s1|h1/.test(out), out);
    assert.ok(out.includes("x=1"), out);
  }
  // rrweb's Meta event carries the page URL (installBrowser: ?token=secret).
  const metas = all(f).filter((e) => e.data && e.data.rrwebEvent && e.data.rrwebEvent.type === 4);
  assert.ok(metas.length >= 1);
  for (const m of metas) assert.ok(!m.data.rrwebEvent.data.href.includes("secret"), m.data.rrwebEvent.data.href);
  await ctrl.stop();
});

test("before rrweb starts, click labels already use the cached dashboard selectors", async () => {
  const local = new Map();
  const rules = withPrivacy({ maskSelectors: [".sensitive"] });
  const p1 = await start({ local, remote: rules, config: { maskTextSelector: ".rpf-mask" } });
  await p1.ctrl.stop();

  installBrowser({ local });
  globalThis.__remoteConfig = later(rules, 2000);
  const { initReplay } = await load("initReplay.ts", { stub: true });
  const ctrl = initReplay({ apiKey: "k", apiHost: "https://api.test", flushIntervalMs: 1e9, sessionInactivityMs: 0, fetchImpl: makeFetch(), maskTextSelector: ".rpf-mask" });
  assert.equal(rr().installs, undefined, "rrweb is not running yet");
  const labels = globalThis.__clickMasker();
  const seen = [];
  assert.equal(labels.labelFor("Pay Jane", fakeEl(seen, { priv: true })), "*** ****");
  assert.deepEqual(seen, [".rpf-mask, .sensitive, .rr-mask"]);
  await ctrl.stop();
});
