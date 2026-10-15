/**
 * Text and input masking for the replay, following the reference tracker's
 * defaults:
 *  - text inside a private region (a mask selector, or `.rr-mask`) is wiped to
 *    "*" at the same length (no trim, so the layout keeps its line lengths);
 *  - all other text has its email addresses masked at the same length ("@" and
 *    "." kept), and every digit becomes "0" when maskTextNumbers is on;
 *  - CSS text is never altered; script and noscript text never leaves readable;
 *  - input values: a password sends nothing (no value, no length), and neither
 *    does an input type the reference tracker records no value for (hidden,
 *    file, url, color, month, week, datetime-local, image); every other value
 *    is "*"-masked unless the app opted out, and even then values that look
 *    like emails or carry 4+ digits in a row, and every value inside a private
 *    region, stay masked. A textarea's text is masked like its value.
 *
 * rrweb only calls maskTextFn for text it already decided to mask, and then
 * uses its result INSTEAD of its own "*" wipe. initReplay therefore routes
 * every text node through it (maskTextSelector "*") and the decision is made
 * here, per element.
 *
 * Pure: no DOM access at import, ES2017, no regex lookbehind (a parse error in
 * Safari before 16.4).
 */

const STAR = "*";

/** Same-length run of "*". */
export const stars = (s: string): string => STAR.repeat(s.length);

/** Every non-space character becomes "*": same length, no trim (rrweb's wipe). */
export const wipeText = (t: string): string => t.replace(/\S/g, STAR);

/** Every digit becomes "0" (the reference tracker's number mask). */
export const maskDigits = (t: string): string => t.replace(/\d/g, "0");

/** Mask every email address at the same length, keeping "@" and the dots
 *  between domain labels: "john.doe@mail.example.org" → "********@****.*******.***".
 *  Same matches as `/[^\s@]+@[^\s@]+\.[^\s@]+/g`, but linear on any input
 *  (that regex backtracks quadratically on long runs of "@"/"."). */
export function maskEmails(text: string): string {
  if (text.indexOf("@") === -1) return text;
  // Odd indices are the whitespace runs; even ones the tokens between them.
  const parts = text.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].indexOf("@") !== -1) parts[i] = maskEmailsInToken(parts[i]);
  }
  return parts.join("");
}

// One whitespace-free token: an address is a non-empty segment, "@", then a
// segment with a dot that has a character on each side. A match consumes both
// segments, so the next one can only start after them.
function maskEmailsInToken(token: string): string {
  const seg = token.split("@");
  let i = 0;
  while (i + 1 < seg.length) {
    if (seg[i] !== "" && hasDomainDot(seg[i + 1])) {
      seg[i] = stars(seg[i]);
      seg[i + 1] = seg[i + 1].split(".").map(stars).join(".");
      i += 2;
    } else {
      i += 1;
    }
  }
  return seg.join("@");
}

function hasDomainDot(seg: string): boolean {
  const d = seg.indexOf(".", 1);
  return d !== -1 && d <= seg.length - 2;
}

const PROBE_CLASS = "replay-sdk-selector-probe";

/** True when the browser parses `sel` (an invalid selector makes rrweb treat
 *  every node as unmatched, or throw on every mutation for blockSelector) AND
 *  it can be joined with the next entry. An entry that leaves a string,
 *  bracket or paren open (`[data-x="a`, `div:is(`, a trailing `\`) parses
 *  alone, because the parser closes it at the end, but swallows every entry
 *  joined after it: `[data-x="a, [data-private]` never matches
 *  `[data-private]`. So the entry is joined with a selector for a probe
 *  element, which must still match it.
 *  Without a DOM to ask (tests), every selector passes. */
export function validSelector(sel: string, doc?: Document | null): boolean {
  if (!doc || typeof doc.createDocumentFragment !== "function") return true;
  try {
    const frag = doc.createDocumentFragment();
    frag.querySelector(sel);
    if (typeof doc.createElement !== "function" || typeof frag.appendChild !== "function") return true;
    const probe = doc.createElement("i");
    probe.className = PROBE_CLASS;
    frag.appendChild(probe);
    return frag.querySelector(`${sel}, .${PROBE_CLASS}`) === probe;
  } catch {
    return false;
  }
}

/** Trimmed, de-duplicated, non-empty selector entries. A host string is ONE
 *  entry: it is never split on commas (`:is(a, b)` would break). */
export function selectorEntries(
  list: ReadonlyArray<string | null | undefined>,
): string[] {
  const out: string[] = [];
  for (const s of list) {
    if (typeof s !== "string") continue;
    const t = s.trim();
    if (t && out.indexOf(t) === -1) out.push(t);
  }
  return out;
}

/** Is `el` inside `selector`, across shadow roots (to the host) and same-origin
 *  iframes (to the frame element)? The walk never leaves the recording root
 *  document, so an SDK running inside an iframe never looks at the embedding
 *  page. Past 64 hops it answers true (fail closed). */
export function inPrivateRegion(
  el: Element,
  selector: string,
  rootDoc: Document | null | undefined,
): boolean {
  let cur: Element | null = el;
  for (let hops = 0; cur && hops < 64; hops += 1) {
    if (cur.closest(selector)) return true;
    const root: Node | null =
      typeof cur.getRootNode === "function" ? cur.getRootNode() : null;
    if (root && root.nodeType === 11 && (root as ShadowRoot).host) {
      cur = (root as ShadowRoot).host;
      continue;
    }
    if (cur.ownerDocument === rootDoc) return false;
    try {
      cur = (cur.ownerDocument?.defaultView?.frameElement as Element | null) ?? null;
    } catch {
      cur = null; // cross-origin parent
    }
  }
  return cur !== null;
}

/** Every input type whose value rrweb records, as its maskInputOptions: rrweb
 *  hands each of these values to maskInputFn, which decides (and applies the
 *  app's / dashboard's mask-all). rrweb's own maskAllInputs map has no hidden,
 *  file or image inputs, whose values it would then record raw. */
export const ALL_INPUT_TYPES: Readonly<Record<string, true>> = {
  color: true,
  date: true,
  "datetime-local": true,
  email: true,
  month: true,
  number: true,
  range: true,
  search: true,
  tel: true,
  text: true,
  time: true,
  url: true,
  week: true,
  textarea: true,
  select: true,
  password: true,
  hidden: true,
  file: true,
  image: true,
};

// The input types the reference tracker records a value for. Any other
// <input> (hidden, file, url, color, month, week, datetime-local, image) sends
// no value at all.
const VALUE_TYPES = ["text", "password", "email", "search", "number", "range", "date", "tel", "time"];
// Inputs whose value attribute is a caption or a fixed token, never typed data
// (the reference tracker keeps it).
const CAPTION_TYPES = ["button", "reset", "submit", "checkbox", "radio"];

export interface InputMaskOptions {
  /** Mask every value ("*" per character): the app's maskAllInputs OR the
   *  dashboard's force. */
  maskAll: boolean;
  /** Input types the workspace always masks (dashboard), e.g. ["email"]. */
  forcedTypes?: ReadonlyArray<string>;
  /** With maskAll off: still mask values that look like emails (type=email or
   *  containing "@"). Default true. */
  maskEmails?: boolean;
  /** With maskAll off: still mask values with 4+ digits in a row (except date
   *  inputs). Default true. */
  maskNumbers?: boolean;
}

export interface TextMaskerOptions {
  /** Host and workspace mask selectors (one entry each); `.rr-mask` is added. */
  maskSelectors: ReadonlyArray<string | null | undefined>;
  /** Mask emails in all ordinary text. */
  maskEmails: boolean;
  /** Turn every digit in ordinary text into "0". */
  maskNumbers: boolean;
  /** The recording root document (`document`). */
  rootDoc?: Document | null;
  /** Called once, with the mask entries the browser can't parse. */
  warn?: (bad: string[]) => void;
  /** Input masking; absent = mask every value. */
  inputs?: InputMaskOptions;
  /** The validated block selector rrweb gets: a blocked iframe's document is
   *  not recorded (rrweb attaches it anyway), and a click label on or holding
   *  a blocked element is wiped (the replay shows a placeholder there). */
  blockSelector?: string;
}

export interface TextMasker {
  /** The joined mask entries, `.rr-mask` included. */
  readonly selector: string;
  /** A mask entry is invalid: the whole page is private (fail closed). */
  readonly invalid: boolean;
  /** Block selector for images, canvas, video and iframes inside private
   *  regions (placeholders in the replay), or undefined when none parses. */
  readonly mediaBlockSelector: string | undefined;
  isPrivate(el: Element | null | undefined): boolean;
  /** rrweb maskTextFn (rrweb passes the text's parent element, or null). */
  maskTextFn(text: string, el: Element | null): string;
  /** rrweb maskInputFn. */
  maskInputFn(text: string, el: Element): string;
  /** A click label: wiped for a private or blocked target (or one holding
   *  private or blocked content), else email/number-masked like ordinary
   *  text. */
  labelFor(label: string, el: Element | null): string;
  /** document.title, masked like the `<title>` text in the replay. */
  titleFor(title: string): string;
  /** Edits an rrweb event in place before it is buffered (see below). False:
   *  nothing in it may be recorded, drop the event. */
  postProcess(ev: unknown, mirror: unknown): boolean;
}

// The parts of rrweb's serialized nodes and events the post-pass reads.
// rrweb numbers: NodeType Element = 2, Text = 3; EventType FullSnapshot = 2,
// IncrementalSnapshot = 3; IncrementalSource Mutation = 0.
interface SNode {
  type?: number;
  id?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SNode[];
  textContent?: string;
  compatMode?: string;
  isShadow?: boolean;
  isShadowHost?: boolean;
  isSVG?: boolean;
}
interface MutationData {
  source?: number;
  isAttachIframe?: boolean;
  adds?: Array<{ parentId?: number; node?: SNode }>;
  removes?: Array<{ parentId?: number; id?: number }>;
  texts?: Array<{ id?: number; value?: string | null }>;
  attributes?: Array<{ id?: number; attributes?: Record<string, unknown> }>;
}
// The other incremental sources name their target as `id` (input, clicks,
// scroll, media, canvas, styles), `positions[].id` (pointer moves) or
// `ranges[].start/end` (selection).
interface InteractionData {
  id?: number;
  positions?: Array<{ id?: number }>;
  ranges?: Array<{ start?: number; end?: number }>;
}
interface RrEvent {
  type?: number;
  data?: { node?: SNode } & MutationData & InteractionData;
}
type DomLike = Element & {
  value?: string;
  type?: string;
  selected?: boolean;
  contentDocument?: Document | null;
  parentNode?: (Node & { host?: Element }) | null;
};

const XHTML = "http://www.w3.org/1999/xhtml";
const MEDIA = "img, picture, canvas, video, iframe";
const MEDIA_TAGS = ["img", "picture", "canvas", "video", "iframe"];
const lower = (s: unknown): string => (typeof s === "string" ? s.toLowerCase() : "");

/** A <link>'s href is kept only where the replay needs it to load styles or
 *  fonts, as the reference tracker records only those links. */
const linkKeepsHref = (rel: unknown, as: unknown): boolean =>
  lower(rel).indexOf("stylesheet") !== -1 || lower(as) === "style" || lower(as) === "font";

type InputDecision = "hide" | "mask" | "clear";

export function createTextMasker(opts: TextMaskerOptions): TextMasker {
  const rootDoc = opts.rootDoc ?? null;
  const entries = selectorEntries([...opts.maskSelectors, ".rr-mask"]);
  const bad = entries.filter((e) => !validSelector(e, rootDoc));
  const invalid = bad.length > 0;
  if (invalid && opts.warn) opts.warn(bad);
  const selector = entries.join(", ");

  // Images (and <picture> sources), canvas, video and iframes inside a private
  // region become rrweb blocked placeholders (the reference tracker records no
  // pixels there). Built per valid entry so one entry the browser can't put
  // inside :is() doesn't cost the others theirs; the post-pass makes the same
  // placeholders where this selector can't reach (no :is(), or a shadow root).
  const media: string[] = [];
  for (const e of entries) {
    if (bad.indexOf(e) !== -1) continue;
    const m = `:is(${e}) :is(${MEDIA}), :is(${MEDIA}):is(${e})`;
    if (validSelector(m, rootDoc)) media.push(m);
  }
  const mediaBlockSelector = media.length ? media.join(", ") : undefined;

  const inputs: InputMaskOptions = opts.inputs ?? { maskAll: true };
  const forced = (inputs.forcedTypes ?? []).map(lower);
  const inputEmails = inputs.maskEmails !== false;
  const inputNumbers = inputs.maskNumbers !== false;

  const isPrivate = (el: Element | null | undefined): boolean => {
    try {
      return invalid || (!!el && inPrivateRegion(el, selector, rootDoc));
    } catch {
      return true;
    }
  };

  // A label taken from an element's text/descendants: private content anywhere
  // inside it counts.
  const holdsPrivate = (el: Element | null): boolean => {
    try {
      return invalid || (!!el && typeof el.querySelector === "function" && !!el.querySelector(selector));
    } catch {
      return true;
    }
  };

  const scrub = (t: string): string => {
    let out = t;
    if (opts.maskNumbers) out = maskDigits(out);
    if (opts.maskEmails) out = maskEmails(out);
    return out;
  };

  // rrweb serializes a snapshot or a mutation batch synchronously and asks
  // maskTextFn about every text node in it, so text under the same ancestors
  // asks the same question again and again: one closest() walk per text node
  // made a full snapshot of a deep page cost up to half again as much. During
  // such a pass the answers are kept per element, for every element on the
  // walk, so each element is matched once. The DOM can't change during the
  // pass; the answers are dropped when rrweb emits the pass's event (see
  // postProcess) and at the end of the task at the latest. Only rrweb's
  // text path uses them.
  let textMemo: WeakMap<Element, boolean> | null = null;
  const dropTextMemo = () => {
    textMemo = null;
  };
  const privateForText = (el: Element): boolean => {
    if (invalid) return true;
    if (typeof el.matches !== "function" || typeof WeakMap !== "function") return isPrivate(el);
    try {
      if (!textMemo) {
        textMemo = new WeakMap();
        if (typeof queueMicrotask === "function") queueMicrotask(dropTextMemo);
        else void Promise.resolve().then(dropTextMemo);
      }
      const memo = textMemo;
      // The same walk as inPrivateRegion, one element at a time.
      const path: Element[] = [];
      let cur: Element = el;
      let hops = 0;
      let result = false;
      for (;;) {
        const known = memo.get(cur);
        if (known !== undefined) {
          result = known;
          break;
        }
        path.push(cur);
        if (cur.matches(selector)) {
          result = true;
          break;
        }
        const parent: Element | null = cur.parentElement;
        if (parent) {
          cur = parent;
          continue;
        }
        // The top of this tree: on to a shadow root's host, or to a
        // same-origin frame's element, never past the recording root
        // document; past 64 of these hops, private (fail closed).
        const root: Node | null = typeof cur.getRootNode === "function" ? cur.getRootNode() : null;
        let next: Element | null = null;
        if (root && root.nodeType === 11 && (root as ShadowRoot).host) {
          next = (root as ShadowRoot).host;
        } else if (cur.ownerDocument !== rootDoc) {
          try {
            next = (cur.ownerDocument?.defaultView?.frameElement as Element | null) ?? null;
          } catch {
            next = null; // cross-origin parent
          }
        }
        if (!next) break;
        hops += 1;
        if (hops >= 64) {
          result = true;
          break;
        }
        cur = next;
      }
      for (const e of path) memo.set(e, result);
      return result;
    } catch {
      return true;
    }
  };

  const maskText = (text: string, el: Element | null, inPass: boolean): string => {
    try {
      if (!text || !/\S/.test(text)) return text;
      const tag = el ? lower(el.localName) : "";
      // CSS, HTML or SVG: masking would corrupt it (url(icon@2x.png), @media).
      if (tag === "style") return text;
      // Never recorded by the reference tracker; the replayer hides them.
      if (tag === "script" || tag === "noscript") return wipeText(text);
      // A textarea's text is its default value: masked like the value.
      if (tag === "textarea" && el) return maskInputFn(text, el);
      if (invalid) return wipeText(text);
      if (el && (inPass ? privateForText(el) : isPrivate(el))) return wipeText(text);
      return scrub(text);
    } catch {
      return wipeText(text);
    }
  };
  const maskTextFn = (text: string, el: Element | null): string => maskText(text, el, true);

  const isPassword = (el: DomLike): boolean =>
    lower(el.type) === "password" ||
    (typeof el.getAttribute === "function" && lower(el.getAttribute("type")) === "password") ||
    // rrweb marks a field that was ever type=password (a show-password toggle).
    (typeof el.hasAttribute === "function" && el.hasAttribute("data-rr-is-password"));

  const inputType = (el: DomLike): string =>
    lower(el.type) || (typeof el.getAttribute === "function" ? lower(el.getAttribute("type")) : "");

  const decideInput = (text: string, el: DomLike): InputDecision => {
    if (isPassword(el)) return "hide";
    const type = inputType(el);
    const tag = lower(el.localName || el.tagName);
    if (tag === "input") {
      if (CAPTION_TYPES.indexOf(type) !== -1) return "clear";
      if (VALUE_TYPES.indexOf(type || "text") === -1) return "hide";
    }
    if (inputs.maskAll) return "mask";
    if (forced.indexOf(type) !== -1 || forced.indexOf(tag) !== -1) return "mask";
    if (isPrivate(el)) return "mask";
    if (inputEmails && (type === "email" || text.indexOf("@") !== -1)) return "mask";
    if (inputNumbers && type !== "date" && /\d{4}/.test(text)) return "mask";
    return "clear";
  };

  const maskInputFn = (text: string, el: Element): string => {
    const value = typeof text === "string" ? text : "";
    try {
      const d = decideInput(value, el as DomLike);
      return d === "hide" ? "" : d === "mask" ? stars(value) : value;
    } catch {
      return stars(value);
    }
  };

  // A blocked element is a placeholder in the replay: nothing in it is
  // recorded, its text in a click label included.
  const blockedLabel = (el: Element | null): boolean => {
    const sel = opts.blockSelector;
    if (!sel || !el) return false;
    try {
      return (
        inPrivateRegion(el, sel, rootDoc) ||
        (typeof el.querySelector === "function" && !!el.querySelector(sel))
      );
    } catch {
      return true;
    }
  };

  const labelFor = (label: string, el: Element | null): string => {
    try {
      if (!label) return label;
      return isPrivate(el) || holdsPrivate(el) || blockedLabel(el)
        ? wipeText(label)
        : scrub(label);
    } catch {
      return wipeText(label);
    }
  };

  const titleFor = (title: string): string => {
    try {
      if (!title) return title;
      const el = rootDoc && typeof rootDoc.querySelector === "function" ? rootDoc.querySelector("title") : null;
      return maskText(title, el, false);
    } catch {
      return wipeText(title);
    }
  };

  // ── Post-pass on rrweb events ────────────────────────────────────────────
  // rrweb gives no hook for these, so the event is edited before it is
  // buffered (rrweb emits synchronously after its snapshot/mutation pass, so
  // its mirror still maps ids to the live nodes):
  //  - text directly under a shadow root reaches maskTextFn with no element,
  //    and the mutation path never masks it: wipe it under a private host,
  //    mask it like ordinary text otherwise;
  //  - href on any HTML element other than a stylesheet/font <link> is blanked
  //    and <meta content> is dropped (mailto: links, magic-link URLs, CSRF
  //    tokens), as the reference tracker does;
  //  - an input's recorded value is dropped when the masker hides it
  //    (passwords, hidden, file…), and so is the raw HTML default rrweb keeps
  //    for a field whose live value is empty; a hidden value's attribute
  //    changes are dropped too (one empty change per keystroke would give the
  //    password's length and rhythm);
  //  - images, canvases, videos and iframes in a private region become
  //    placeholders (the media block selector can't reach into a shadow root,
  //    and needs :is());
  //  - a blocked or private iframe's document is not attached, and nothing
  //    rrweb later records inside it (text, attributes, inputs, clicks) ships;
  //  - an <option>'s `selected` is kept only when its select's value is
  //    recorded in clear (rrweb drops it for every select once selects are
  //    maskable, and records attribute changes to it raw).
  // A node the mirror fails to look up is UNKNOWN, and every check on it fails
  // closed; a node it doesn't have (a cross-origin frame's) gets the checks
  // that need no node, failing closed where the tag would decide.
  let warned = false;
  const warnOnce = (err: unknown) => {
    if (warned) return;
    warned = true;
    // eslint-disable-next-line no-console
    console.warn("[replay-sdk] replay privacy post-pass failed:", err);
  };
  const UNKNOWN = {} as DomLike;
  // Documents of frames that are not recorded, and media recorded as
  // placeholders: whatever rrweb later records in or on them is dropped.
  const skippedDocs = new WeakSet<object>();
  const placeholders = new WeakSet<object>();
  let anySkipped = false;

  const optionInClear = (opt: DomLike | null, mustBeSelected: boolean): boolean => {
    if (!opt || typeof opt.closest !== "function") return false;
    if (mustBeSelected && !opt.selected) return false;
    const sel = opt.closest("select") as DomLike | null;
    return !!sel && decideInput(typeof opt.value === "string" ? opt.value : "", sel) === "clear";
  };

  // The masker sends no value for this field (password, hidden, file…).
  const hidesValue = (el: DomLike): boolean => {
    try {
      return el === UNKNOWN || decideInput("", el) === "hide";
    } catch {
      return true;
    }
  };

  const blockedFrame = (el: DomLike | null): boolean => {
    if (!el) return false;
    if (el === UNKNOWN) return true;
    try {
      if (isPrivate(el)) return true;
      if (el.classList && el.classList.contains("rr-block")) return true;
      return !!opts.blockSelector && !!el.closest(opts.blockSelector);
    } catch {
      return true;
    }
  };

  const inSkippedFrame = (n: DomLike | null): boolean => {
    if (!anySkipped || !n || n === UNKNOWN) return false;
    const doc = (n as unknown as Node).nodeType === 9 ? n : n.ownerDocument;
    return !!doc && skippedDocs.has(doc);
  };
  const skipped = (n: DomLike | null): boolean =>
    anySkipped && !!n && (placeholders.has(n) || inSkippedFrame(n));

  const shadowText = (t: string, host: unknown): string =>
    !host || isPrivate(host as Element) ? wipeText(t) : maskTextFn(t, null);

  const isEmpty = (o: object): boolean => {
    for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return false;
    return true;
  };

  const postProcess = (ev: unknown, mirror: unknown): boolean => {
    // rrweb emits once its pass is done: the next pass starts afresh.
    dropTextMemo();
    const e = ev as RrEvent | null;
    if (!e || !e.data) return true;
    const m = mirror as { getNode?: (id: number) => unknown } | null | undefined;
    const node = (id: unknown): DomLike | null => {
      if (typeof id !== "number" || !m || typeof m.getNode !== "function") return null;
      try {
        return (m.getNode(id) as DomLike | null) ?? null;
      } catch (err) {
        warnOnce(err);
        return UNKNOWN;
      }
    };

    // rrweb's own blocked placeholder: the size, the class, nothing else.
    const placeholder = (n: SNode, live: DomLike) => {
      let w = 0;
      let h = 0;
      try {
        const r = live.getBoundingClientRect();
        w = r.width;
        h = r.height;
      } catch {
        /* unknown size: an empty box */
      }
      const cls = n.attributes && n.attributes.class;
      n.attributes = { rr_width: `${w}px`, rr_height: `${h}px` };
      if (typeof cls === "string") n.attributes.class = cls;
      n.childNodes = [];
      if (live !== UNKNOWN) {
        placeholders.add(live);
        anySkipped = true;
      }
    };

    const fixElement = (n: SNode) => {
      if (n.isShadowHost && Array.isArray(n.childNodes)) {
        let host: DomLike | null = null;
        let looked = false;
        for (const c of n.childNodes) {
          if (c && c.type === 3 && c.isShadow && typeof c.textContent === "string" && c.textContent) {
            if (!looked) {
              host = node(n.id);
              looked = true;
            }
            c.textContent = shadowText(c.textContent, host);
          }
        }
      }
      const a = n.attributes;
      if (!a) return;
      const tag = n.tagName;
      if (!n.isSVG && MEDIA_TAGS.indexOf(tag ?? "") !== -1 && !("rr_width" in a)) {
        const live = node(n.id);
        if (live && isPrivate(live)) {
          placeholder(n, live);
          return;
        }
      }
      if (tag === "meta") delete a.content;
      else if (typeof a.href === "string" && a.href && !n.isSVG && (tag !== "link" || !linkKeepsHref(a.rel, a.as))) {
        a.href = "";
      }
      if ((tag === "input" || tag === "textarea") && "value" in a) {
        // rrweb masks only a non-empty live value; an empty one leaves the
        // HTML default in place, raw.
        const live = node(n.id);
        if (live && (hidesValue(live) || (live !== UNKNOWN && !live.value))) delete a.value;
      }
      if (tag === "option" && !inputs.maskAll && !a.selected && optionInClear(node(n.id), true)) {
        a.selected = true;
      }
    };

    const walk = (root: SNode | undefined) => {
      const stack: Array<SNode | undefined> = [root];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== "object") continue;
        if (n.type === 2) fixElement(n);
        if (Array.isArray(n.childNodes)) for (const k of n.childNodes) stack.push(k);
      }
    };

    // Not recorded in a skipped frame's document (nor a nested one's).
    const skipFrame = (docId: unknown, frame: DomLike | null) => {
      let doc: unknown = node(docId);
      if (!doc || doc === UNKNOWN) doc = frame && frame !== UNKNOWN ? frame.contentDocument : null;
      if (doc && typeof doc === "object") {
        skippedDocs.add(doc);
        anySkipped = true;
      }
    };

    const fixAttributes = (a: Record<string, unknown>, el: DomLike | null) => {
      const known = !!el && el !== UNKNOWN;
      const tag = known ? lower(el!.localName) : "";
      if ("content" in a && (!known || tag === "meta")) delete a.content;
      if (typeof a.href === "string" && a.href !== "") {
        const html = known && (!el!.namespaceURI || el!.namespaceURI === XHTML);
        if (!known || (html && (tag !== "link" || !linkKeepsHref(el!.getAttribute("rel"), el!.getAttribute("as"))))) {
          a.href = "";
        }
      }
      if ("selected" in a && (!known || (tag === "option" && !optionInClear(el, false)))) delete a.selected;
      if ("value" in a && el && (el === UNKNOWN || ((tag === "input" || tag === "textarea") && hidesValue(el)))) {
        delete a.value;
      }
    };

    const fixMutation = (d: MutationData): boolean => {
      let dropped = false;
      if (Array.isArray(d.adds)) {
        const kept: typeof d.adds = [];
        for (const add of d.adds) {
          const n = add && add.node;
          if (!n) {
            kept.push(add);
            continue;
          }
          const parent = node(add.parentId);
          if (d.isAttachIframe && skipped(parent)) {
            skipFrame(n.id, parent);
            dropped = true;
            continue;
          }
          if (d.isAttachIframe && blockedFrame(parent)) {
            skipFrame(n.id, parent);
            n.childNodes = [];
            // rrweb's rebuild reads the first child of a quirks-mode document.
            delete n.compatMode;
            kept.push(add);
            continue;
          }
          if (skipped(parent)) {
            dropped = true;
            continue;
          }
          if (n.type === 3 && n.isShadow && typeof n.textContent === "string" && n.textContent) {
            // rrweb's parentId for shadow-root children is the host.
            n.textContent = shadowText(n.textContent, parent);
          }
          walk(n);
          kept.push(add);
        }
        if (kept.length !== d.adds.length) d.adds = kept;
      }
      if (anySkipped && Array.isArray(d.removes)) {
        const kept = d.removes.filter((r) => !(r && skipped(node(r.parentId))));
        if (kept.length !== d.removes.length) {
          d.removes = kept;
          dropped = true;
        }
      }
      if (Array.isArray(d.texts)) {
        const kept: typeof d.texts = [];
        for (const t of d.texts) {
          const value = t && typeof t.value === "string" ? t.value : "";
          const n = t && (value || anySkipped) ? node(t.id) : null;
          if (skipped(n)) {
            dropped = true;
            continue;
          }
          if (value && n === UNKNOWN) t.value = wipeText(value);
          else if (value && n) {
            const parent = n.parentNode;
            if (n.parentElement === null && parent && parent.nodeType === 11) {
              t.value = shadowText(value, parent.host);
            }
          }
          kept.push(t);
        }
        if (kept.length !== d.texts.length) d.texts = kept;
      }
      if (Array.isArray(d.attributes)) {
        const kept: typeof d.attributes = [];
        for (const at of d.attributes) {
          const a = at && at.attributes;
          if (!a) {
            kept.push(at);
            continue;
          }
          const el = node(at.id);
          if (skipped(el)) {
            dropped = true;
            continue;
          }
          const had = !isEmpty(a);
          fixAttributes(a, el);
          if (had && isEmpty(a)) {
            dropped = true;
            continue;
          }
          kept.push(at);
        }
        if (kept.length !== d.attributes.length) d.attributes = kept;
      }
      // Something was taken out and nothing is left: the empty event itself
      // would still say when (a keystroke in a password field).
      return !(
        dropped &&
        !(d.adds && d.adds.length) &&
        !(d.removes && d.removes.length) &&
        !(d.texts && d.texts.length) &&
        !(d.attributes && d.attributes.length)
      );
    };

    const keepInteraction = (d: InteractionData): boolean => {
      if (!anySkipped) return true;
      if (typeof d.id === "number" && skipped(node(d.id))) return false;
      if (Array.isArray(d.positions)) {
        const kept = d.positions.filter((p) => !(p && inSkippedFrame(node(p.id))));
        if (kept.length !== d.positions.length) {
          if (kept.length === 0) return false;
          d.positions = kept;
        }
      }
      if (Array.isArray(d.ranges)) {
        for (const r of d.ranges) {
          if (r && (inSkippedFrame(node(r.start)) || inSkippedFrame(node(r.end)))) return false;
        }
      }
      return true;
    };

    try {
      if (e.type === 2) {
        walk(e.data.node);
        return true;
      }
      if (e.type !== 3) return true;
      return e.data.source === 0 ? fixMutation(e.data) : keepInteraction(e.data);
    } catch (err) {
      warnOnce(err);
      return true;
    }
  };

  return {
    selector,
    invalid,
    mediaBlockSelector,
    isPrivate,
    maskTextFn,
    maskInputFn,
    labelFor,
    titleFor,
    postProcess,
  };
}
