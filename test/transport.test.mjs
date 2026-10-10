import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { installBrowser, load, makeFetch, ok, json, sleep } from "./helpers.mjs";

const env = (extra = {}) => ({
  sessionId: "ses_1", segmentId: "seg_1", sequence: 1, sentAt: 1,
  sdk: { name: "t", version: "t", platform: "web" }, page: { url: "https://a.test/" },
  events: [{ id: "e", ts: 1, offsetMs: 0, source: "web", type: "custom", data: {} }],
  ...extra,
});
// incompressible payload of ~n gzip bytes
const noisy = (n) => env({ events: [{ id: "e", ts: 1, offsetMs: 0, source: "web", type: "custom", data: { s: randomBytes(n).toString("base64") } }] });
const sender = async (fetchImpl) => {
  const { createBatchSender } = await load("transport.ts");
  return createBatchSender({ apiKey: "k", apiHost: "https://api.test", fetchImpl });
};

test("classifyBatchResponse maps every ingest answer", async () => {
  installBrowser();
  const { classifyBatchResponse: c } = await load("transport.ts");
  assert.deepEqual(c(201, { ok: true, data: { accepted: true } }), { kind: "ok" });
  assert.deepEqual(c(201, { ok: true, data: { accepted: false, shouldNotRecord: true } }), { kind: "stop", reason: "should_not_record" });
  assert.equal(c(200, undefined).kind, "retry", "non-JSON 2xx (captive portal)");
  assert.equal(c(200, { ok: false }).kind, "drop");
  assert.deepEqual(c(401, {}), { kind: "stop", reason: "unauthorized" });
  assert.deepEqual(c(403, {}), { kind: "stop", reason: "forbidden" });
  assert.equal(c(404, {}).kind, "stop");
  for (const s of [400, 413, 415, 422]) assert.equal(c(s, {}).kind, "drop", String(s));
  for (const s of [408, 429, 500, 502, 503]) assert.equal(c(s, {}).kind, "retry", String(s));
});

test("send(): outcomes and in-call retries per response", async () => {
  const cases = [
    [() => ok(), "ok", 1],
    [() => json(201, { ok: true, data: { accepted: false, shouldNotRecord: true } }), "stop", 1],
    [() => json(400, { ok: false, error: { code: "BAD_REQUEST", message: "x" } }), "drop", 1],
    [() => json(401, { ok: false }), "stop", 1],
    [() => json(403, { ok: false }), "stop", 1],
    [() => json(413, { statusCode: 413, message: "Compressed payload too large" }), "drop", 1],
    [() => json(429, {}), "retry", 1],
    [() => json(500, {}), "retry", 3],
    [() => { throw new TypeError("Failed to fetch"); }, "retry", 3],
  ];
  for (const [respond, kind, calls] of cases) {
    installBrowser();
    const f = makeFetch(respond);
    const send = await sender(f);
    const out = await send(env());
    assert.equal(out.kind, kind, `${respond} → ${kind}`);
    assert.equal(f.calls.length, calls, `${kind}: ${calls} call(s)`);
  }
  // 503 then 201 → ok on the 2nd attempt
  installBrowser();
  let n = 0;
  const f = makeFetch(() => (++n === 1 ? json(503, {}) : ok()));
  assert.equal((await (await sender(f))(env())).kind, "ok");
  assert.equal(f.calls.length, 2);
});

test("small batches go out with keepalive (navigation-proof), big ones without", async () => {
  installBrowser();
  const f = makeFetch();
  const send = await sender(f);
  await send(env());
  assert.equal(f.calls[0].keepalive, true, "small gzip body → keepalive");
  assert.equal(f.calls[0].init.headers["content-encoding"], "gzip");
  await send(noisy(40_000));
  assert.equal(f.calls[1].keepalive, false, "~40KB gzip body → normal fetch");
});

test("keepalive budget: concurrent sends share 24KB; refused keepalive degrades once", async () => {
  installBrowser();
  const held = [];
  const f = makeFetch(() => new Promise((r) => held.push(r)));
  const send = await sender(f);
  const p1 = send(noisy(11_000));
  await sleep(50);
  const p2 = send(noisy(11_000));
  const p3 = send(noisy(11_000));
  await sleep(50);
  assert.deepEqual(f.calls.map((c) => c.keepalive), [true, true, false], "third would exceed 24KB in flight");
  held.forEach((r) => r(ok()));
  await Promise.all([p1, p2, p3]);
  // a keepalive refused while a plain fetch works → stop using keepalive here
  const b2 = installBrowser();
  const f2 = makeFetch((req) => { if (req.keepalive) throw new TypeError("keepalive refused"); return ok(); });
  const send2 = await sender(f2);
  assert.equal((await send2(env())).kind, "ok");
  await send2(env());
  assert.deepEqual(f2.calls.map((c) => c.keepalive), [true, false, false]);
  assert.equal(send2.sendFinal(env()), true);
  assert.equal(f2.calls.length, 3, "unload path skips the refused keepalive…");
  assert.equal(b2.beacons.length, 1, "…and uses sendBeacon");
});

test("redeliverPending re-sends a pending normal fetch once, same bytes and sequence", async () => {
  installBrowser();
  let release;
  const f = makeFetch((req) => (req.keepalive ? ok() : new Promise((r) => (release = r))));
  const send = await sender(f);
  const p = send(noisy(20_000)); // > 16KB gzip → normal fetch
  await sleep(80);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].keepalive, false);
  send.redeliverPending();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].keepalive, true);
  assert.deepEqual(f.calls[1].envelope, f.calls[0].envelope, "same envelope (sequence)");
  assert.ok(Buffer.from(new Uint8Array(f.calls[1].init.body)).equals(Buffer.from(new Uint8Array(f.calls[0].init.body))), "same gzip bytes");
  send.redeliverPending();
  assert.equal(f.calls.length, 2, "never twice");
  release(json(500, {}));
  assert.equal((await p).kind, "ok", "superseded send resolves without retrying");
  assert.equal(f.calls.length, 2);
  // too big for the budget even gzipped → not re-sent
  installBrowser();
  const f3 = makeFetch(() => new Promise(() => {}));
  const send3 = await sender(f3);
  send3(noisy(60_000));
  await sleep(120);
  send3.redeliverPending();
  assert.equal(f3.calls.length, 1);
});

test("sendFinal: keepalive within the 48KB budget, false when it doesn't fit", async () => {
  installBrowser();
  const held = [];
  const f = makeFetch(() => new Promise((r) => held.push(r)));
  const send = await sender(f);
  const room = send.finalRoom(env());
  assert.ok(room > 40_000 && room < 48 * 1024);
  const fits = env({ events: [{ id: "e", ts: 1, offsetMs: 0, source: "web", type: "custom", data: { s: "x".repeat(30_000) } }] });
  assert.equal(send.sendFinal(fits), true);
  assert.equal(f.calls[0].keepalive, true);
  assert.equal(typeof f.calls[0].init.body, "string", "unload body is plain JSON (no async gzip)");
  assert.ok(send.finalRoom(env()) < 20_000, "in-flight bytes count against the budget");
  assert.equal(send.sendFinal(fits), false, "a second 30KB body doesn't fit while the first is in flight");
  held[0](ok());
  await sleep(10);
  assert.equal(send.sendFinal(fits), true, "budget released after it settles");
});

test("sendFinal uses sendBeacon where keepalive isn't supported", async () => {
  const b = installBrowser();
  const RealRequest = globalThis.Request;
  globalThis.Request = class {}; // no keepalive on the prototype
  try {
    const f = makeFetch();
    const { createBatchSender } = await load("transport.ts");
    const send = createBatchSender({ apiKey: "k1", apiHost: "https://api.test", fetchImpl: f });
    assert.equal(send.sendFinal(env()), true);
    assert.equal(f.calls.length, 0);
    assert.equal(b.beacons.length, 1);
    assert.match(b.beacons[0].url, /[?&]k=k1/);
    assert.equal(b.beacons[0].blob.type, "text/plain");
  } finally {
    globalThis.Request = RealRequest;
  }
});

test("retagSession re-tags the stored identity to the new session id", async () => {
  const b = installBrowser();
  const send = await sender(makeFetch());
  send.bindSession("ses_A", false);
  send.setIdentify({ distinctId: "u1" });
  assert.equal(JSON.parse(b.store.get("replay:identify")).sid, "ses_A");
  send.retagSession("ses_B");
  assert.equal(JSON.parse(b.store.get("replay:identify")).sid, "ses_B");
});
