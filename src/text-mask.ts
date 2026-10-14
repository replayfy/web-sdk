/**
 * Text and input masking for the replay, following the reference tracker's
 * defaults:
 *  - text inside a private region (a mask selector, or `.rr-mask`) is wiped to
 *    "*" at the same length (no trim, so the layout keeps its line lengths);
 *  - all other text has its email addresses masked at the same length ("@" and
 *    "." kept), and every digit becomes "0" when maskTextNumbers is on;
 *  - CSS text is never altered; script and noscript text never leaves readable;
 *  - input values: a password sends nothing (no value, no length); every other
 *    value is "*"-masked unless the app opted out, and even then values that
 *    look like emails or carry 4+ digits in a row, and every value inside a
 *    private region, stay masked.
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

/** True when the browser parses `sel` (an invalid selector makes rrweb treat
 *  every node as unmatched, or throw on every mutation for blockSelector).
 *  Without a DOM to ask (tests), every selector passes. */
export function validSelector(sel: string, doc?: Document | null): boolean {
  if (!doc || typeof doc.createDocumentFragment !== "function") return true;
  try {
    doc.createDocumentFragment().querySelector(sel);
    return true;
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

/** Every input type rrweb can mask. With the app's maskAllInputs off, rrweb is
 *  given all of them and maskInputFn decides per value. */
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
};

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
   *  not recorded (rrweb attaches it anyway). */
  blockSelector?: string;
}

export interface TextMasker {
  /** The joined mask entries, `.rr-mask` included. */
  readonly selector: string;
  /** A mask entry is invalid: all text is wiped (fail closed). */
  readonly invalid: boolean;
  /** Block selector for images, canvas, video and iframes inside private
   *  regions (placeholders in the replay), or undefined when none parses. */
  readonly mediaBlockSelector: string | undefined;
  isPrivate(el: Element | null | undefined): boolean;
  /** rrweb maskTextFn (rrweb passes the text's parent element, or null). */
  maskTextFn(text: string, el: Element | null): string;
  /** rrweb maskInputFn. */
  maskInputFn(text: string, el: Element): string;
  /** A click label: wiped for a private target (or one holding private
   *  content), else email/number-masked like ordinary text. */
  labelFor(label: string, el: Element | null): string;
  /** Edits an rrweb event in place before it is buffered (see below). */
  postProcess(ev: unknown, mirror: unknown): void;
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
  isShadow?: boolean;
  isShadowHost?: boolean;
  isSVG?: boolean;
}
interface MutationData {
  source?: number;
  isAttachIframe?: boolean;
  adds?: Array<{ parentId?: number; node?: SNode }>;
  texts?: Array<{ id?: number; value?: string | null }>;
  attributes?: Array<{ id?: number; attributes?: Record<string, unknown> }>;
}
interface RrEvent {
  type?: number;
  data?: { node?: SNode } & MutationData;
}
type DomLike = Element & {
  value?: string;
  type?: string;
  selected?: boolean;
  parentNode?: (Node & { host?: Element }) | null;
};

const XHTML = "http://www.w3.org/1999/xhtml";
const MEDIA = "img, canvas, video, iframe";
const lower = (s: unknown): string => (typeof s === "string" ? s.toLowerCase() : "");

type InputDecision = "hide" | "mask" | "clear";

export function createTextMasker(opts: TextMaskerOptions): TextMasker {
  const rootDoc = opts.rootDoc ?? null;
  const entries = selectorEntries([...opts.maskSelectors, ".rr-mask"]);
  const bad = entries.filter((e) => !validSelector(e, rootDoc));
  const invalid = bad.length > 0;
  if (invalid && opts.warn) opts.warn(bad);
  const selector = entries.join(", ");

  // Images, canvas, video and iframes inside a private region become rrweb
  // blocked placeholders (the reference tracker records no pixels there).
  // Built per valid entry so one entry the browser can't put inside :is()
  // doesn't cost the others theirs.
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

  const maskTextFn = (text: string, el: Element | null): string => {
    try {
      if (!text || !/\S/.test(text)) return text;
      const tag = el ? lower(el.localName) : "";
      // CSS, HTML or SVG: masking would corrupt it (url(icon@2x.png), @media).
      if (tag === "style") return text;
      // Never recorded by the reference tracker; the replayer hides them.
      if (tag === "script" || tag === "noscript") return wipeText(text);
      if (invalid) return wipeText(text);
      if (el && isPrivate(el)) return wipeText(text);
      return scrub(text);
    } catch {
      return wipeText(text);
    }
  };

  const isPassword = (el: DomLike): boolean =>
    lower(el.type) === "password" ||
    (typeof el.getAttribute === "function" && lower(el.getAttribute("type")) === "password") ||
    // rrweb marks a field that was ever type=password (a show-password toggle).
    (typeof el.hasAttribute === "function" && el.hasAttribute("data-rr-is-password"));

  const decideInput = (text: string, el: DomLike): InputDecision => {
    if (isPassword(el)) return "hide";
    if (inputs.maskAll) return "mask";
    const type = lower(el.type) || (typeof el.getAttribute === "function" ? lower(el.getAttribute("type")) : "");
    const tag = lower(el.localName || el.tagName);
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

  const labelFor = (label: string, el: Element | null): string => {
    try {
      if (!label) return label;
      return isPrivate(el) || holdsPrivate(el) ? wipeText(label) : scrub(label);
    } catch {
      return wipeText(label);
    }
  };

  // ── Post-pass on rrweb events ────────────────────────────────────────────
  // rrweb gives no hook for these, so the event is edited before it is
  // buffered (rrweb emits synchronously after its snapshot/mutation pass, so
  // its mirror still maps ids to the live nodes):
  //  - text directly under a shadow root reaches maskTextFn with no element,
  //    and the mutation path never masks it: wipe it under a private host,
  //    mask it like ordinary text otherwise;
  //  - href on any non-<link> HTML element is blanked and <meta content> is
  //    dropped (mailto: links, magic-link URLs, CSRF tokens), as the reference
  //    tracker does;
  //  - a blocked or private iframe's document is not attached;
  //  - an <option>'s `selected` is kept only when its select's value is
  //    recorded in clear (rrweb drops it for every select once selects are
  //    maskable, and records attribute changes to it raw).
  let warned = false;

  const optionInClear = (opt: DomLike | null, mustBeSelected: boolean): boolean => {
    if (!opt || typeof opt.closest !== "function") return false;
    if (mustBeSelected && !opt.selected) return false;
    const sel = opt.closest("select") as DomLike | null;
    return !!sel && decideInput(typeof opt.value === "string" ? opt.value : "", sel) === "clear";
  };

  const blockedFrame = (el: DomLike | null): boolean => {
    if (!el) return false;
    try {
      if (isPrivate(el)) return true;
      if (el.classList && el.classList.contains("rr-block")) return true;
      return !!opts.blockSelector && !!el.closest(opts.blockSelector);
    } catch {
      return true;
    }
  };

  const shadowText = (t: string, host: unknown): string =>
    !host || isPrivate(host as Element) ? wipeText(t) : maskTextFn(t, null);

  const postProcess = (ev: unknown, mirror: unknown): void => {
    const m = mirror as { getNode?: (id: number) => unknown } | null | undefined;
    if (!m || typeof m.getNode !== "function") return;
    const getNode = (id: unknown): DomLike | null =>
      typeof id === "number" ? ((m.getNode!(id) as DomLike | null) ?? null) : null;
    const e = ev as RrEvent | null;
    if (!e || !e.data) return;

    const fixElement = (n: SNode) => {
      if (n.isShadowHost && Array.isArray(n.childNodes)) {
        let host: DomLike | null = null;
        let looked = false;
        for (const c of n.childNodes) {
          if (c && c.type === 3 && c.isShadow && typeof c.textContent === "string" && c.textContent) {
            if (!looked) {
              host = getNode(n.id);
              looked = true;
            }
            c.textContent = shadowText(c.textContent, host);
          }
        }
      }
      const a = n.attributes;
      if (!a) return;
      if (n.tagName === "meta") delete a.content;
      else if (typeof a.href === "string" && a.href && !n.isSVG && n.tagName !== "link") a.href = "";
      if (n.tagName === "option" && !inputs.maskAll && !a.selected && optionInClear(getNode(n.id), true)) {
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

    try {
      if (e.type === 2) {
        walk(e.data.node);
        return;
      }
      if (e.type !== 3 || e.data.source !== 0) return;
      const d = e.data;
      for (const add of d.adds ?? []) {
        const node = add && add.node;
        if (!node) continue;
        if (d.isAttachIframe && blockedFrame(getNode(add.parentId))) {
          node.childNodes = [];
          continue;
        }
        if (node.type === 3 && node.isShadow && typeof node.textContent === "string" && node.textContent) {
          // rrweb's parentId for shadow-root children is the host.
          node.textContent = shadowText(node.textContent, getNode(add.parentId));
        }
        walk(node);
      }
      for (const t of d.texts ?? []) {
        if (!t || typeof t.value !== "string" || !t.value) continue;
        const n = getNode(t.id);
        const parent = n ? n.parentNode : null;
        if (n && n.parentElement === null && parent && parent.nodeType === 11) {
          t.value = shadowText(t.value, parent.host);
        }
      }
      for (const at of d.attributes ?? []) {
        const a = at && at.attributes;
        if (!a) continue;
        const href = typeof a.href === "string" && a.href !== "";
        const content = "content" in a;
        const selected = "selected" in a;
        if (!href && !content && !selected) continue;
        const el = getNode(at.id);
        if (!el) continue;
        const tag = lower(el.localName);
        if (content && tag === "meta") delete a.content;
        if (href && tag !== "link" && (!el.namespaceURI || el.namespaceURI === XHTML)) a.href = "";
        if (selected && tag === "option" && !optionInClear(el, false)) delete a.selected;
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        // eslint-disable-next-line no-console
        console.warn("[replay-sdk] replay privacy post-pass failed:", err);
      }
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
    postProcess,
  };
}
