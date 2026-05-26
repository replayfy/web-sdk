import type { WebReplayConfig } from "./types";

export interface PresenceHandle {
  stop: () => void;
  updateDistinctId: (distinctId: string) => void;
}

/**
 * Open a Socket.IO connection to keep this session present on the dashboard.
 * Loads socket.io-client from a CDN so the SDK stays dependency-free at build time.
 */
export function startPresence(
  config: WebReplayConfig,
  sessionId: string,
  initialDistinctId?: string,
  fingerprint?: string,
): PresenceHandle {
  let stopped = false;
  let socket: {
    disconnect: () => void;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    io?: { opts?: { auth?: Record<string, unknown> } };
  } | null = null;
  let distinctId = initialDistinctId;

  const load = async () => {
    try {
      const url = new URL("/socket.io/socket.io.js", config.apiHost).toString();
      await loadScript(url);
      if (stopped) return;
      const io = (
        window as unknown as { io?: (host: string, opts?: unknown) => unknown }
      ).io;
      if (typeof io !== "function") return;
      socket = io(config.apiHost, {
        path: "/socket.io/",
        // Allow polling fallback for Safari/iOS where some configurations block
        // upgrade to websocket on the first try. socket.io will negotiate up.
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 8_000,
        reconnectionAttempts: Infinity,
        auth: {
          role: "sdk",
          apiKey: config.apiKey,
          sessionId,
          distinctId,
          fingerprint,
        },
      }) as typeof socket;
    } catch {
      /* presence is best-effort */
    }
  };
  void load();

  return {
    stop() {
      stopped = true;
      socket?.disconnect();
    },
    updateDistinctId(next) {
      distinctId = next;
      // Update reconnection auth so future reconnects carry the new id.
      if (socket?.io?.opts?.auth)
        (socket.io.opts.auth as Record<string, unknown>).distinctId = next;
      socket?.emit("sdk:identify", { distinctId: next });
    },
  };
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`,
    );
    if (existing) {
      if ((existing as HTMLScriptElement & { _loaded?: boolean })._loaded) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load socket.io client")),
      );
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      (s as HTMLScriptElement & { _loaded?: boolean })._loaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error("Failed to load socket.io client"));
    document.head.appendChild(s);
  });
}
