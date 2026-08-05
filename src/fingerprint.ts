/**
 * A stable per-browser anonymous id. On first visit we mint a RANDOM id and
 * persist it under localStorage, so repeated visits on the same browser keep the
 * same id (and the API can collapse N sessions into 1 anonymous user). A random
 * id — not a hash of the environment — is what makes this correct at scale: a
 * pure environment fingerprint (UA/screen/tz/…) collapses every identically
 * configured browser (a whole corporate fleet, default Chrome on one laptop
 * model) into ONE anonymous user. The environment hash survives only as the
 * fallback for when localStorage is unavailable (private mode), where we have no
 * stored id to reuse and a deterministic-ish id still beats a fresh random one
 * per page load.
 *
 * When identify() is called later with a different email but the same anonymous
 * id, the server treats that as a separate EndUser — a different account on the
 * same browser is a legitimately different person.
 */

const STORAGE_KEY = "replay:fp";

export interface BrowserFingerprint {
  fp: string;
  cached: boolean;
}

export function getBrowserFingerprint(): BrowserFingerprint {
  let storageOk = true;
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return { fp: existing, cached: true };
  } catch {
    // localStorage blocked (private mode / disabled). We can neither read a
    // prior id nor persist a new random one, so fall back to the environment
    // hash — deterministic across this browser's page loads without storage.
    storageOk = false;
  }
  if (!storageOk) return { fp: computeFingerprint(), cached: false };
  // First visit with working storage: mint a collision-free random id + persist.
  const fp = randomAnonId();
  try {
    localStorage.setItem(STORAGE_KEY, fp);
  } catch {
    /* ignore — return the id for this page load anyway */
  }
  return { fp, cached: false };
}

/** A random, collision-free anonymous id. Falls back to the environment hash if
 *  crypto is somehow unavailable, so we always return a usable id. */
function randomAnonId(): string {
  try {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return (
      "fp_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    );
  } catch {
    return computeFingerprint();
  }
}

function computeFingerprint(): string {
  const parts: string[] = [];
  try {
    parts.push(`ua:${navigator.userAgent}`);
  } catch {}
  try {
    parts.push(`lang:${navigator.language}`);
  } catch {}
  try {
    parts.push(`tz:${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  } catch {}
  try {
    parts.push(`scr:${screen.width}x${screen.height}x${screen.colorDepth}`);
  } catch {}
  try {
    parts.push(`dpr:${window.devicePixelRatio}`);
  } catch {}
  try {
    parts.push(
      `platform:${(navigator as unknown as { platform?: string }).platform ?? ""}`,
    );
  } catch {}
  try {
    parts.push(`touch:${"ontouchstart" in window ? "1" : "0"}`);
  } catch {}
  try {
    parts.push(canvasFingerprint());
  } catch {
    parts.push("canvas:err");
  }
  return "fp_" + djb2(parts.join("|"));
}

function canvasFingerprint(): string {
  const c = document.createElement("canvas");
  c.width = 200;
  c.height = 50;
  const ctx = c.getContext("2d");
  if (!ctx) return "canvas:no-ctx";
  ctx.textBaseline = "top";
  ctx.font = "14px 'Arial'";
  ctx.fillStyle = "#f60";
  ctx.fillRect(0, 0, 100, 25);
  ctx.fillStyle = "#069";
  ctx.fillText("Replay-fp,0123!", 2, 2);
  ctx.strokeStyle = "rgba(102,204,0,0.7)";
  ctx.strokeText("Replay-fp,0123!", 4, 17);
  try {
    return "canvas:" + djb2(c.toDataURL());
  } catch {
    return "canvas:err";
  }
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  // Force unsigned and to a short hex string.
  return (h >>> 0).toString(36);
}
