// The network and performance captures (src/signals.ts) against fake browser
// globals: what they record before anything is buffered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowser, load } from "./helpers.mjs";

const { createNetworkCapture, createPerformanceCapture } = await load("signals.ts");
const { redactUrlForStorage } = await load("utils.ts");

/** The few XMLHttpRequest members the network capture patches. */
class FakeXhr {}
FakeXhr.prototype.open = function open() {};
FakeXhr.prototype.send = function send() {};
FakeXhr.prototype.setRequestHeader = function setRequestHeader() {};

test("network capture: request and response bodies only while the live policy records them", async () => {
  installBrowser();
  globalThis.XMLHttpRequest = FakeXhr;
  const fetchImpl = async () =>
    new Response('{"email":"jane@example.com"}', { headers: { "content-type": "application/json" } });
  window.fetch = fetchImpl;
  let policy = { bodies: false };
  const events = [];
  const stop = createNetworkCapture({ apiKey: "k", apiHost: "https://api.test", fetchImpl }, (d) => events.push(d), () => policy);
  try {
    await window.fetch("https://app.test/api/me", { method: "POST", body: '{"q":"jane"}' });
    assert.equal(events.length, 1);
    assert.equal(events[0].requestBody, undefined);
    assert.equal(events[0].responseBody, undefined);
    navigator.sendBeacon("https://app.test/ping", "jane@example.com");
    assert.equal(events[1].requestBody, undefined, "nor a beacon's");

    policy = { bodies: true };
    await window.fetch("https://app.test/api/me", { method: "POST", body: '{"q":"jane"}' });
    assert.equal(events[2].requestBody, '{"q":"jane"}');
    assert.equal(events[2].responseBody, '{"email":"jane@example.com"}');
  } finally {
    stop();
  }
});

test("network capture: the host's sanitizeBody runs on beacon bodies too", () => {
  installBrowser();
  globalThis.XMLHttpRequest = FakeXhr;
  window.fetch = async () => new Response("");
  const events = [];
  const sanitizeBody = ({ body }) => body.replace(/jane@example\.com/g, "[email]");
  const stop = createNetworkCapture({ apiKey: "k", apiHost: "https://api.test", sanitizeBody }, (d) => events.push(d), () => ({ bodies: true }));
  try {
    navigator.sendBeacon("https://app.test/ping", "user=jane@example.com");
    assert.equal(events[0].requestBody, "user=[email]");
  } finally {
    stop();
  }
});

test("performance capture: a long frame's script URL and invoker are redacted", async () => {
  installBrowser();
  const observers = [];
  const RealObserver = globalThis.PerformanceObserver;
  globalThis.PerformanceObserver = class {
    static supportedEntryTypes = ["long-animation-frame"];
    constructor(cb) { this.cb = cb; }
    observe(o) { observers.push({ type: o.type, cb: this.cb }); }
    disconnect() {}
  };
  document.readyState = "loading";
  const events = [];
  const redactUrl = (u) => redactUrlForStorage(u, { patterns: ["sessref="] });
  const stop = createPerformanceCapture((d) => events.push(d), { captureResourceTimings: false, redactUrl });
  try {
    const url = "https://cdn.test/widget.js?sessref=s1&api_key=K&ok=1";
    const loaf = observers.find((o) => o.type === "long-animation-frame");
    loaf.cb({ getEntries: () => [{ duration: 120, blockingDuration: 70, scripts: [{ duration: 90, sourceURL: url, invoker: url, invokerType: "classic-script" }] }] });
    loaf.cb({ getEntries: () => [{ duration: 80, scripts: [{ duration: 60, invoker: "BUTTON#pay.onclick", invokerType: "event-listener" }] }] });
    const [script, listener] = events.filter((e) => e.metric === "long_animation_frame");
    for (const k of ["scriptSource", "scriptInvoker"]) {
      assert.ok(!/s1|=K/.test(script.detail[k]) && script.detail[k].includes("ok=1"), script.detail[k]);
    }
    assert.equal(listener.detail.scriptInvoker, "BUTTON#pay.onclick", "an event listener's invoker is kept");
  } finally {
    stop();
    globalThis.PerformanceObserver = RealObserver;
  }
});
