/**
 * A stable per-browser fingerprint. We avoid any heavy/invasive sources —
 * just the platform-visible knobs that don't normally change without the user
 * actively switching environment. Stored under localStorage so repeated visits
 * on the same browser keep the same id (and the API can collapse N sessions
 * into 1 anonymous user).
 *
 * When identify() is called later with a different email but the same
 * fingerprint, the server treats that as a separate EndUser — different
 * account on the same browser is a legitimately different person.
 */

const STORAGE_KEY = "replay:fp";

export interface BrowserFingerprint {
  fp: string;
  cached: boolean;
}

export function getBrowserFingerprint(): BrowserFingerprint {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return { fp: existing, cached: true };
  } catch {
    /* localStorage blocked — fall through to compute */
  }
  const fp = computeFingerprint();
  try {
    localStorage.setItem(STORAGE_KEY, fp);
  } catch {
    /* ignore */
  }
  return { fp, cached: false };
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
