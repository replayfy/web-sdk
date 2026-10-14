// Text and input masking (src/text-mask.ts) and the click labels that use it,
// with fake elements: no DOM library needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { load } from "./helpers.mjs";

const tm = await load("text-mask.ts");
const { maskEmails, wipeText, maskDigits, createTextMasker, inPrivateRegion, validSelector, selectorEntries } = tm;

const stars = (s) => "*".repeat(s.length);
// The reference tracker's email mask: its regex and replacement, inline.
const referenceMaskEmails = (s) =>
  s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, (m) => {
    const at = m.indexOf("@");
    return stars(m.slice(0, at)) + "@" + m.slice(at + 1).split(".").map(stars).join(".");
  });

const ROOT = { nodeType: 9, defaultView: {} };
/** A fake element: `priv` makes closest() match; `onClosest` spies on it. */
function el({ tag = "p", priv = false, onClosest, root = ROOT, ownerDocument = ROOT, attrs = {}, ...rest } = {}) {
  const e = {
    localName: tag,
    tagName: tag.toUpperCase(),
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument,
    closest(sel) {
      onClosest?.(sel);
      if (sel === "select") return rest.select ?? null;
      return priv ? e : null;
    },
    getRootNode: () => root,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
    querySelector: () => null,
    ...rest,
  };
  return e;
}
const masker = (o = {}) =>
  createTextMasker({ maskSelectors: [], maskEmails: true, maskNumbers: false, rootDoc: ROOT, ...o });

// ── maskEmails ──────────────────────────────────────────────────────────────

test("email mask: the reference tracker's vectors", () => {
  const cases = [
    ["mail a@b.co.uk or c@d.com", "mail *@*.**.** or *@*.***"],
    ["contact: john.doe@mail.example.org!", "contact: ********@****.*******.****"],
    ["no email @ here", "no email @ here"],
    ["john.doe@example.com", "********@*******.***"],
    ["a@b@c.d", "a@*@*.*"],
    ["@handle.name", "@handle.name"],
    ["https://cdn.x/@scope/pkg@1.2.3", "https://cdn.x/@*********@*.*.*"],
  ];
  for (const [input, want] of cases) {
    assert.equal(maskEmails(input), want, input);
    assert.equal(referenceMaskEmails(input), want, `reference: ${input}`);
  }
});

test("email mask: same output as the reference regex on 200k random strings", () => {
  const alphabet = ["a", "b", ".", "@", " ", "\t", "\n", " ", " ", "　", "﻿", "1", "é"];
  let seed = 0x2f6b1d3;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  for (let n = 0; n < 200_000; n += 1) {
    const len = 1 + Math.floor(rnd() * 16);
    let s = "";
    for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const got = maskEmails(s);
    if (got !== referenceMaskEmails(s)) assert.fail(`mismatch on ${JSON.stringify(s)}: ${JSON.stringify(got)}`);
    assert.equal(got.length, s.length);
  }
});

test("email mask runs in linear time", () => {
  const time = (s) => {
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      maskEmails(s);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  assert.ok(time("a".repeat(5e5) + "@" + "b".repeat(5e5)) < 200, "one @ in 1M chars");
  assert.ok(time("a@".repeat(5e5)) < 2000, "1M chars of a@");
  // Doubling the input roughly doubles the time (a quadratic pass would 4x it).
  const small = time("a.@".repeat(2e5));
  const big = time("a.@".repeat(4e5));
  assert.ok(big < Math.max(small, 5) * 3.5, `n=${small.toFixed(1)}ms 2n=${big.toFixed(1)}ms`);
});

test("wipe keeps the length and the spaces; digits become 0", () => {
  assert.equal(wipeText("  Sensitive Data "), "  ********* **** ");
  assert.equal(wipeText("hi 😀").length, "hi 😀".length);
  assert.equal(maskDigits("Phone: 123-456-7890"), "Phone: 000-000-0000");
});

test("selector entries are trimmed, de-duplicated and never split on commas", () => {
  assert.deepEqual(selectorEntries([" .a ", "", null, undefined, ".a", ":is(.b, .c)"]), [".a", ":is(.b, .c)"]);
  assert.equal(validSelector("[[", undefined), true, "no DOM to ask: passes");
  const doc = { createDocumentFragment: () => ({ querySelector: (s) => { if (s === "[[") throw new SyntaxError("x"); return null; } }) };
  assert.equal(validSelector("[[", doc), false);
  assert.equal(validSelector(".ok", doc), true);
});

// ── maskTextFn ──────────────────────────────────────────────────────────────

test("maskTextFn: private text wiped, ordinary text email-masked, CSS untouched, scripts wiped", () => {
  const m = masker({ maskSelectors: ["[data-private]"] });
  assert.equal(m.maskTextFn("mail bob@x.io", el()), "mail ***@*.**");
  assert.equal(m.maskTextFn("TOP SECRET a@b.co", el({ priv: true })), "*** ****** ******");
  const css = ".a{background:url(icon@2x.png)}@media(x){}";
  assert.equal(m.maskTextFn(css, el({ tag: "style", priv: true })), css);
  assert.equal(m.maskTextFn(css, el({ tag: "style" })), css);
  assert.equal(m.maskTextFn('var k="bob@x.io"', el({ tag: "script" })), "*** ************");
  assert.equal(m.maskTextFn("bob@x.io", el({ tag: "noscript" })), "********");
  assert.equal(m.maskTextFn("order 123456", el()), "order 123456", "digits kept unless asked");
  assert.equal(masker({ maskNumbers: true }).maskTextFn("order 123456 a1@b.co", el()), "order 000000 **@*.**");
});

test("maskTextFn: a private shadow host or frame element carries into its content", () => {
  const m = masker({ maskSelectors: [".sensitive"] });
  const host = el({ tag: "x-card", priv: true });
  const inShadow = el({ root: { nodeType: 11, host } });
  assert.equal(m.maskTextFn("Hi bob", inShadow), "** ***");
  const frame = el({ tag: "iframe", priv: true });
  const frameDoc = { nodeType: 9, defaultView: { frameElement: frame } };
  const inFrame = el({ root: frameDoc, ownerDocument: frameDoc });
  assert.equal(m.maskTextFn("Hi bob", inFrame), "** ***");
  const openFrame = el({ tag: "iframe" });
  const openDoc = { nodeType: 9, defaultView: { frameElement: openFrame } };
  assert.equal(m.maskTextFn("Hi bob@x.io", el({ root: openDoc, ownerDocument: openDoc })), "Hi ***@*.**");
});

test("maskTextFn: no element → emails only; any throw → wiped", () => {
  const m = masker({ maskSelectors: [".sensitive"] });
  assert.equal(m.maskTextFn("Hi bob@x.io", null), "Hi ***@*.**");
  const throwing = el({ closest: () => { throw new Error("boom"); } });
  assert.equal(m.maskTextFn("Hi bob", throwing), "** ***");
  const badTag = el();
  Object.defineProperty(badTag, "localName", { get() { throw new Error("boom"); } });
  assert.equal(m.maskTextFn("Hi bob", badTag), "** ***");
});

test("maskTextFn: whitespace-only text never touches the DOM", () => {
  let calls = 0;
  const m = masker({ maskSelectors: [".x"] });
  const e = el({ onClosest: () => { calls += 1; } });
  assert.equal(m.maskTextFn("  \n\t ", e), "  \n\t ");
  assert.equal(m.maskTextFn("", e), "");
  assert.equal(calls, 0);
});

test("maskTextFn: the selector holds the workspace entry, the host entry and .rr-mask, once each", () => {
  const seen = [];
  const m = masker({ maskSelectors: ["[data-private]", ".rpf-mask", "[data-private]", ".rr-mask"] });
  m.maskTextFn("text", el({ onClosest: (s) => seen.push(s) }));
  assert.deepEqual(seen, ["[data-private], .rpf-mask, .rr-mask"]);
  assert.equal(m.selector, "[data-private], .rpf-mask, .rr-mask");
});

test("an invalid mask selector wipes all text (except CSS) and warns once", () => {
  const warns = [];
  const doc = { ...ROOT, createDocumentFragment: () => ({ querySelector: (s) => { if (s.includes("[[")) throw new SyntaxError("x"); return null; } }) };
  const m = createTextMasker({ maskSelectors: ["[[", ".ok"], maskEmails: true, maskNumbers: false, rootDoc: doc, warn: (b) => warns.push(b) });
  assert.equal(m.invalid, true);
  assert.deepEqual(warns, [["[["]]);
  assert.equal(m.maskTextFn("plain text", el({ ownerDocument: doc, root: doc })), "***** ****");
  assert.equal(m.maskTextFn("plain text", null), "***** ****");
  assert.equal(m.maskTextFn("a{b:c}", el({ tag: "style" })), "a{b:c}");
  assert.equal(m.isPrivate(el()), true);
  // Media placeholders only come from the entries that parse.
  assert.ok(m.mediaBlockSelector.includes(":is(.ok) :is(img, canvas, video, iframe)"));
  assert.ok(!m.mediaBlockSelector.includes("[["));

  const quiet = [];
  createTextMasker({ maskSelectors: ["[["], maskEmails: true, maskNumbers: false, rootDoc: ROOT, warn: (b) => quiet.push(b) });
  assert.equal(quiet.length, 0, "no parser to ask: no warning");
});

test("with emails and numbers off the masker still wipes private text and keeps CSS", () => {
  const m = masker({ maskSelectors: [".s"], maskEmails: false, maskNumbers: false });
  assert.equal(m.maskTextFn("bob@x.io 12345", el()), "bob@x.io 12345");
  assert.equal(m.maskTextFn("secret", el({ priv: true })), "******");
  assert.equal(m.maskTextFn("x{}", el({ tag: "style", priv: true })), "x{}");
});

test("media inside private regions get a block selector, per entry", () => {
  const m = masker({ maskSelectors: ["[data-private]"] });
  assert.equal(
    m.mediaBlockSelector,
    ":is([data-private]) :is(img, canvas, video, iframe), :is(img, canvas, video, iframe):is([data-private]), " +
      ":is(.rr-mask) :is(img, canvas, video, iframe), :is(img, canvas, video, iframe):is(.rr-mask)",
  );
});

// ── inPrivateRegion ─────────────────────────────────────────────────────────

test("inPrivateRegion never leaves the recording root document", () => {
  let visitedParent = false;
  const parentPage = el({ onClosest: () => { visitedParent = true; } });
  const rootDoc = { nodeType: 9, defaultView: { frameElement: parentPage } };
  const e = el({ root: rootDoc, ownerDocument: rootDoc });
  assert.equal(inPrivateRegion(e, ".x", rootDoc), false);
  assert.equal(visitedParent, false);
});

test("inPrivateRegion fails closed past 64 hops and stops at a cross-origin frame", () => {
  const loop = el();
  loop.getRootNode = () => ({ nodeType: 11, host: loop });
  assert.equal(inPrivateRegion(loop, ".x", ROOT), true);
  const otherDoc = { nodeType: 9, defaultView: {} };
  Object.defineProperty(otherDoc.defaultView, "frameElement", { get() { throw new Error("cross-origin"); } });
  assert.equal(inPrivateRegion(el({ root: otherDoc, ownerDocument: otherDoc }), ".x", ROOT), false);
});

// ── maskInputFn ─────────────────────────────────────────────────────────────

const input = (type, extra = {}) => el({ tag: "input", type, attrs: { type, ...(extra.attrs ?? {}) }, ...extra });

test("inputs, mask all on: passwords send nothing, everything else is starred", () => {
  const m = masker({ inputs: { maskAll: true } });
  assert.equal(m.maskInputFn("hunter2", input("password")), "");
  assert.equal(m.maskInputFn("hunter2", input("text", { attrs: { "data-rr-is-password": "true" } })), "", "show-password toggle");
  assert.equal(m.maskInputFn("hello", input("text")), "*****");
  assert.equal(m.maskInputFn("multi\nline", el({ tag: "textarea", type: "textarea" })), "**********");
  assert.equal(m.maskInputFn("", input("text")), "");
});

test("inputs, app opted out: the reference tracker's plain-mode heuristics still apply", () => {
  const m = masker({ maskSelectors: ["[data-private]"], inputs: { maskAll: false, forcedTypes: ["tel"] } });
  assert.equal(m.maskInputFn("hunter2", input("password")), "", "no value, no length");
  assert.equal(m.maskInputFn("hunter2", input("text", { attrs: { "data-rr-is-password": "true" } })), "");
  assert.equal(m.maskInputFn("hello", input("text")), "hello");
  assert.equal(m.maskInputFn("a@b.co", input("text")), "******");
  assert.equal(m.maskInputFn("abc", input("email")), "***");
  assert.equal(m.maskInputFn("card 4111", input("text")), "*********");
  assert.equal(m.maskInputFn("123", input("text")), "123", "under 4 digits");
  assert.equal(m.maskInputFn("2024-01-01", input("date")), "2024-01-01");
  assert.equal(m.maskInputFn("hello", input("text", { priv: true })), "*****", "inside a private region");
  assert.equal(m.maskInputFn("555", input("tel")), "***", "a workspace-forced type");
  assert.equal(m.maskInputFn("hello", el({ tag: "select", type: "select-one" })), "hello");

  const off = masker({ inputs: { maskAll: false, maskEmails: false, maskNumbers: false } });
  assert.equal(off.maskInputFn("a@b.co", input("text")), "a@b.co");
  assert.equal(off.maskInputFn("4111", input("text")), "4111");
  assert.equal(off.maskInputFn("x", input("password")), "");
});

test("inputs: an error masks the value", () => {
  const m = masker({ inputs: { maskAll: false } });
  const bad = input("text");
  bad.hasAttribute = () => { throw new Error("boom"); };
  assert.equal(m.maskInputFn("hello", bad), "*****");
});

// ── labelFor ────────────────────────────────────────────────────────────────

test("labelFor: private targets (or ones holding private content) are wiped, others email-masked", () => {
  const m = masker({ maskSelectors: [".s"] });
  assert.equal(m.labelFor("Email bob@x.io", el()), "Email ***@*.**");
  assert.equal(m.labelFor("Jane Doe", el({ priv: true })), "**** ***");
  const holder = el({ querySelector: (s) => (s.includes(".s") ? {} : null) });
  assert.equal(m.labelFor("Pay Jane", holder), "*** ****");
});

// ── postProcess ─────────────────────────────────────────────────────────────

const mirrorOf = (map) => ({ getNode: (id) => map[id] ?? null });

test("post-pass: text directly under a private shadow root is wiped in the snapshot", () => {
  const m = masker({ maskSelectors: [".s"] });
  const snap = () => ({ type: 2, data: { node: { type: 0, childNodes: [{ type: 2, id: 5, tagName: "x-a", attributes: {}, isShadowHost: true, childNodes: [{ type: 3, id: 6, textContent: "Hi ***@*.**", isShadow: true }] }] } } });
  const priv = snap();
  m.postProcess(priv, mirrorOf({ 5: el({ tag: "x-a", priv: true }) }));
  assert.equal(priv.data.node.childNodes[0].childNodes[0].textContent, "** ********");
  const pub = snap();
  m.postProcess(pub, mirrorOf({ 5: el({ tag: "x-a" }) }));
  assert.equal(pub.data.node.childNodes[0].childNodes[0].textContent, "Hi ***@*.**");
});

test("post-pass: shadow-root text in mutations is masked like page text", () => {
  const m = masker({ maskSelectors: [".s"] });
  const ev = (parentId) => ({ type: 3, data: { source: 0, adds: [{ parentId, node: { type: 3, id: 9, textContent: "Hi bob@x.io", isShadow: true } }], texts: [], attributes: [], removes: [] } });
  const nodes = { 1: el({ tag: "x-a" }), 2: el({ tag: "x-a", priv: true }) };
  const pub = ev(1);
  m.postProcess(pub, mirrorOf(nodes));
  assert.equal(pub.data.adds[0].node.textContent, "Hi ***@*.**");
  const priv = ev(2);
  m.postProcess(priv, mirrorOf(nodes));
  assert.equal(priv.data.adds[0].node.textContent, "** ********");

  const shadowText = (host) => ({ parentElement: null, parentNode: { nodeType: 11, host } });
  const texts = { type: 3, data: { source: 0, adds: [], attributes: [], texts: [{ id: 3, value: "Yo c@d.io" }, { id: 4, value: "Yo c@d.io" }, { id: 7, value: "Yo c@d.io" }, { id: 8, value: null }] } };
  m.postProcess(texts, mirrorOf({ 3: shadowText(nodes[1]), 4: shadowText(nodes[2]), 7: { parentElement: el(), parentNode: el() } }));
  assert.deepEqual(texts.data.texts.map((t) => t.value), ["Yo *@*.**", "** ******", "Yo c@d.io", null]);
});

test("post-pass: href on non-<link> HTML elements is blanked and <meta content> dropped", () => {
  const m = masker();
  const ev = { type: 2, data: { node: { type: 0, childNodes: [
    { type: 2, id: 2, tagName: "a", attributes: { href: "mailto:bob@x.io" }, childNodes: [] },
    { type: 2, id: 3, tagName: "link", attributes: { rel: "icon", href: "https://x/i.png" }, childNodes: [] },
    { type: 2, id: 4, tagName: "use", isSVG: true, attributes: { href: "#icon" }, childNodes: [] },
    { type: 2, id: 5, tagName: "meta", attributes: { name: "csrf-token", content: "s3cr3t" }, childNodes: [] },
  ] } } };
  m.postProcess(ev, mirrorOf({}));
  const [a, link, use, meta] = ev.data.node.childNodes;
  assert.equal(a.attributes.href, "");
  assert.equal(link.attributes.href, "https://x/i.png");
  assert.equal(use.attributes.href, "#icon");
  assert.deepEqual(meta.attributes, { name: "csrf-token" });

  const svgNs = "http://www.w3.org/2000/svg";
  const mut = { type: 3, data: { source: 0, adds: [{ parentId: 1, node: { type: 2, id: 8, tagName: "a", attributes: { href: "https://x/reset?t=1" }, childNodes: [] } }], texts: [], attributes: [
    { id: 2, attributes: { href: "https://x/magic?t=2" } },
    { id: 4, attributes: { href: "#other" } },
    { id: 5, attributes: { content: "n3w" } },
    { id: 3, attributes: { href: "https://x/a.css" } },
  ] } };
  m.postProcess(mut, mirrorOf({ 2: el({ tag: "a" }), 3: el({ tag: "link" }), 4: el({ tag: "use", namespaceURI: svgNs }), 5: el({ tag: "meta" }) }));
  assert.equal(mut.data.adds[0].node.attributes.href, "");
  assert.deepEqual(mut.data.attributes.map((x) => x.attributes), [{ href: "" }, { href: "#other" }, {}, { href: "https://x/a.css" }]);
});

test("post-pass: a blocked or private iframe's document is not attached", () => {
  const m = masker({ maskSelectors: [".s"], blockSelector: ".no-replay" });
  const attach = (parentId) => ({ type: 3, data: { source: 0, isAttachIframe: true, adds: [{ parentId, nextId: null, node: { type: 0, id: 20, childNodes: [{ type: 2, id: 21, tagName: "html", attributes: {}, childNodes: [] }] } }], texts: [], attributes: [], removes: [] } });
  const nodes = {
    1: el({ tag: "iframe", priv: true }),
    2: el({ tag: "iframe", closest: (s) => (s === ".no-replay" ? {} : null) }),
    3: el({ tag: "iframe", classList: { contains: (c) => c === "rr-block" } }),
    4: el({ tag: "iframe" }),
  };
  for (const id of [1, 2, 3]) {
    const ev = attach(id);
    m.postProcess(ev, mirrorOf(nodes));
    assert.deepEqual(ev.data.adds[0].node.childNodes, [], `iframe ${id}`);
  }
  const open = attach(4);
  m.postProcess(open, mirrorOf(nodes));
  assert.equal(open.data.adds[0].node.childNodes.length, 1);
});

test("post-pass: an option's `selected` is kept only when its select is recorded in clear", () => {
  const plainSel = el({ tag: "select", type: "select-one" });
  const privSel = el({ tag: "select", type: "select-one", priv: true });
  const opt = (select, value, selected = true) => el({ tag: "option", value, selected, select });
  const nodes = { 2: opt(plainSel, "fr"), 3: opt(privSel, "fr"), 4: opt(plainSel, "4111"), 5: opt(plainSel, "de", false) };
  const snap = () => ({ type: 2, data: { node: { type: 0, childNodes: [2, 3, 4, 5].map((id) => ({ type: 2, id, tagName: "option", attributes: { value: nodes[id].value }, childNodes: [] })) } } });
  const optOut = masker({ maskSelectors: [".s"], inputs: { maskAll: false } });
  const ev = snap();
  optOut.postProcess(ev, mirrorOf(nodes));
  assert.deepEqual(ev.data.node.childNodes.map((n) => !!n.attributes.selected), [true, false, false, false]);
  const all = masker({ inputs: { maskAll: true } });
  const ev2 = snap();
  all.postProcess(ev2, mirrorOf(nodes));
  assert.deepEqual(ev2.data.node.childNodes.map((n) => !!n.attributes.selected), [false, false, false, false]);

  const attrs = () => ({ type: 3, data: { source: 0, adds: [], texts: [], attributes: [{ id: 2, attributes: { selected: "" } }, { id: 3, attributes: { selected: "" } }] } });
  const a1 = attrs();
  optOut.postProcess(a1, mirrorOf(nodes));
  assert.deepEqual(a1.data.attributes.map((x) => x.attributes), [{ selected: "" }, {}]);
  const a2 = attrs();
  all.postProcess(a2, mirrorOf(nodes));
  assert.deepEqual(a2.data.attributes.map((x) => x.attributes), [{}, {}]);
});

test("post-pass: no mirror is a no-op; a mirror that throws leaves the event and warns once", () => {
  const m = masker({ maskSelectors: [".s"] });
  const ev = () => ({ type: 3, data: { source: 0, adds: [{ parentId: 1, node: { type: 3, id: 9, textContent: "Hi bob@x.io", isShadow: true } }], texts: [], attributes: [] } });
  const a = ev();
  m.postProcess(a, undefined);
  m.postProcess(a, {});
  assert.equal(a.data.adds[0].node.textContent, "Hi bob@x.io");
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...x) => warns.push(x);
  try {
    const b = ev();
    const boom = { getNode: () => { throw new Error("boom"); } };
    m.postProcess(b, boom);
    m.postProcess(ev(), boom);
    assert.equal(b.data.adds[0].node.textContent, "Hi bob@x.io");
    assert.equal(warns.length, 1);
  } finally {
    console.warn = realWarn;
  }
});

// ── Click labels (signals.ts) ───────────────────────────────────────────────

test("click labels: masked like page text, never a select's chosen option", async () => {
  const { targetLabel } = await load("signals.ts");
  const m = masker({ maskSelectors: [".s"] });
  const select = el({
    tag: "select",
    attrs: { name: "country" },
    selectedOptions: [{ textContent: "France" }],
    ownerDocument: { querySelector: () => null },
  });
  select.closest = () => null;
  assert.equal(targetLabel(select, m), "country");
  assert.equal(targetLabel(select, null), "country");

  const button = (o) => el({ tag: "button", innerText: "Pay Jane Doe", ...o });
  assert.equal(targetLabel(button({ priv: true }), m), "*** **** ***");
  assert.equal(targetLabel(el({ tag: "button", attrs: { "aria-label": "Email bob@x.io" } }), m), "Email ***@*.**");
  assert.equal(targetLabel(el({ tag: "button", attrs: { "aria-label": "Email bob@x.io" } }), null), "Email bob@x.io", "no masker: raw");
  // Masked before the 100-char cut: an address cut in half is still hidden.
  const long = "x".repeat(90) + " john.doe@example.com";
  assert.equal(targetLabel(el({ tag: "button", innerText: long }), m), ("x".repeat(90) + " ********@*******.***").slice(0, 100));
  // A label element that is private wipes the label of a public field.
  const lbl = el({ tag: "label", priv: true, textContent: "Card holder" });
  const field = el({ tag: "input", type: "text", id: "f", ownerDocument: { querySelector: () => lbl } });
  field.closest = () => null;
  assert.equal(targetLabel(field, m), "**** ******");
});
