// Test harness: bundles src/ modules with esbuild (fresh module state per
// import) and fakes the few browser globals the SDK touches, so the real code
// runs under node:test without a browser.
import { build } from "esbuild";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
export const TEST_SDK_VERSION = "9.9.9-test";

const STUBS = {
  rrweb: `
    const r = (globalThis.__rrweb = globalThis.__rrweb || { snapshots: 0 });
    const meta = () => ({ type: 4, timestamp: Date.now(), data: { href: location.href, width: 1, height: 1 } });
    // \`install\`: which record() call (1st, 2nd…) took the snapshot.
    const full = () => ({ type: 2, timestamp: Date.now(), data: { node: { id: 1 }, install: r.installs } });
    export const record = Object.assign(
      (opts) => {
        r.emit = opts.emit; r.recording = true; r.opts = opts; r.installs = (r.installs || 0) + 1;
        opts.emit(meta()); opts.emit(full()); r.snapshots += 1;
        return () => { r.recording = false; };
      },
      { takeFullSnapshot: () => {
          if (!r.recording) throw new Error("not recording");
          r.emit(meta()); r.emit(full()); r.snapshots += 1;
        },
        // The SDK's event post-pass reads rrweb's mirror; the fake snapshot
        // has no node it would look up.
        mirror: { getNode: () => null } },
    );
    export const addCustomEvent = () => {};`,
  "./signals": `
    const noop = () => () => {};
    export const createConsoleCapture = noop, createViewportCapture = noop;
    // The URL redaction the real captures apply per request / per resource.
    export const createNetworkCapture = (cfg, cb, getUrlPolicy) => {
      globalThis.__netCapture = { cfg, getUrlPolicy, emit: cb };
      return () => {};
    };
    export const createPerformanceCapture = (cb, opts) => {
      globalThis.__perfOpts = opts;
      globalThis.__perfEmit = cb;
      return () => {};
    };
    // The masker getters the real captures read per click / per navigation.
    export const createRageDeadClickCapture = (cb, getMasker) => {
      globalThis.__clickMasker = getMasker;
      globalThis.__emitClick = cb;
      return () => {};
    };
    export const createErrorCapture = (cb) => { globalThis.__emitError = cb; return () => {}; };
    export const createNavigationCapture = (cb, getMasker) => {
      globalThis.__navMasker = getMasker;
      cb({ to: location.href, trigger: "load" });
      return () => {};
    };
    export const errorDataFromValue = (e, handled) => ({ message: String(e), handled });`,
  "./fingerprint": `
    export const getBrowserFingerprint = () => ({ fp: "fp_test" });
    export const setStoredFingerprint = () => {};`,
  "./remote-config": `
    export async function fetchRemoteConfig() {
      const f = globalThis.__remoteConfig;
      return typeof f === "function" ? f() : null;
    }`,
};

let importSeq = 0;
/** Bundle `src/<entry>` and import it fresh. `stub: true` swaps rrweb, signals,
 *  fingerprint and remote-config for the in-memory fakes above. */
export async function load(entry, { stub = false, define = true } = {}) {
  const plugins = stub
    ? [{
        name: "stubs",
        setup(b) {
          b.onResolve({ filter: /^(rrweb|\.\/signals|\.\/fingerprint|\.\/remote-config)$/ }, (a) => ({
            path: a.path, namespace: "stub",
          }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js" }));
        },
      }]
    : [];
  const out = await build({
    entryPoints: [SRC + entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    logLevel: "silent",
    define: define ? { __REPLAY_SDK_VERSION__: JSON.stringify(TEST_SDK_VERSION) } : {},
    plugins,
  });
  const code = out.outputFiles[0].text + `\n//# fresh-${importSeq++}`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

/** Install a fake browser: storage, window/document event targets, navigator
 *  (sendBeacon spy), location. Returns handles for driving it. */
export function installBrowser({ href = "https://app.test/a?token=secret&utm_source=x", visible = true, storage, local, title = "Page" } = {}) {
  const mkTarget = () => {
    const map = new Map();
    return {
      addEventListener(t, fn) { if (!map.has(t)) map.set(t, new Set()); map.get(t).add(fn); },
      removeEventListener(t, fn) { map.get(t)?.delete(fn); },
      fire(t, extra = {}) { for (const fn of [...(map.get(t) ?? [])]) fn({ type: t, ...extra }); },
      count(t) { return map.get(t)?.size ?? 0; },
    };
  };
  const store = storage ?? new Map();
  const ss = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const url = new URL(href);
  const location = { href, pathname: url.pathname };
  const win = Object.assign(mkTarget(), {
    location,
    innerWidth: 1280,
    innerHeight: 800,
    screen: { width: 1280, height: 800 },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    clearInterval: (t) => clearInterval(t),
  });
  const doc = Object.assign(mkTarget(), {
    visibilityState: visible ? "visible" : "hidden", title, referrer: "",
    // Selector validation: this fake parser rejects anything containing "[[".
    createDocumentFragment: () => ({
      querySelector: (sel) => { if (String(sel).includes("[[")) throw new SyntaxError(`bad selector ${sel}`); return null; },
    }),
  });
  const beacons = [];
  const nav = {
    userAgent: "node-test",
    language: "en",
    doNotTrack: null,
    sendBeacon: (u, blob) => { beacons.push({ url: u, blob }); return true; },
  };
  globalThis.sessionStorage = ss;
  globalThis.localStorage = local
    ? { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k) }
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.window = win;
  globalThis.document = doc;
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  globalThis.location = location;
  globalThis.screen = win.screen;
  // rrweb heartbeat uses the global setInterval: don't let it hold the test open.
  const realSetInterval = globalThis.__realSetInterval ?? (globalThis.__realSetInterval = setInterval);
  globalThis.setInterval = (fn, ms, ...a) => { const t = realSetInterval(fn, ms, ...a); t.unref?.(); return t; };
  globalThis.__rrweb = { snapshots: 0 };
  globalThis.__remoteConfig = undefined;
  globalThis.__emitError = undefined;
  globalThis.__clickMasker = undefined;
  globalThis.__emitClick = undefined;
  globalThis.__navMasker = undefined;
  globalThis.__netCapture = undefined;
  globalThis.__perfEmit = undefined;
  return {
    store, window: win, document: doc, beacons,
    hide() { doc.visibilityState = "hidden"; doc.fire("visibilitychange"); },
    show() { doc.visibilityState = "visible"; doc.fire("visibilitychange"); },
    pagehide(persisted = false) { win.fire("pagehide", { persisted }); },
    pageshow(persisted = false) { win.fire("pageshow", { persisted }); },
  };
}

/** Decode a batch request body (gzip ArrayBuffer, Uint8Array or JSON string). */
export function decodeBody(body) {
  if (typeof body === "string") return JSON.parse(body);
  const buf = Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
  try { return JSON.parse(gunzipSync(buf).toString("utf8")); } catch { return JSON.parse(buf.toString("utf8")); }
}

/** A recording fetch. `respond(req)` returns a Response (default: 201
 *  accepted), throws to simulate a network error, or returns a promise to hold
 *  the request. Each recorded request: { url, init, body, envelope, keepalive }. */
export function makeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/v1/sdk/config")) return new Response("{}", { status: 404 });
    const body = decodeBody(init.body);
    const req = { url: u, init, body, envelope: body.envelope, keepalive: !!init.keepalive };
    calls.push(req);
    return (respond ?? (() => ok()))(req);
  };
  fetchImpl.calls = calls;
  fetchImpl.batches = () => calls.map((c) => c.envelope);
  return fetchImpl;
}

export const ok = () => json(201, { ok: true, data: { accepted: true, acceptedSequence: 1, sessionId: "s" } });
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const types = (envelope) => envelope.events.map((e) => e.type);

/** The SDK's outbox (held events for the next page load) in a fake storage:
 *  its key is per ingest host + api key. */
export function outboxKeys(store) {
  return [...store.keys()].filter((k) => k.startsWith("replay:outbox"));
}
export function readOutbox(store) {
  const k = outboxKeys(store)[0];
  return k ? JSON.parse(store.get(k)) : null;
}
