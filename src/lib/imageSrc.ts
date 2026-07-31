/**
 * Resolve a local filesystem path (or remote URL) to something an <img> can load.
 *
 * Primary delivery: Host loopback HTTP media server
 *   `http://127.0.0.1:{port}/v1/media?t={token}&p={encodeURIComponent(absPath)}`
 * Token-gated + path_scope on the Host. Works for WebView, browser tools, and
 * future web clients talking to a local Host.
 *
 * Fallback (only if the media server is not ready yet): Tauri `media://` via
 * convertFileSrc — kept for cold-start races, not the steady-state path.
 *
 * Resolution is sync + cached so chat image cards never flash through a
 * zero-height state that collapses scrollHeight while reading history.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/api";

/** Cache path → viewable URL (or null on hard failure). */
const resolveCache = new Map<string, string | null>();

export type MediaServerEndpoint = {
  baseUrl: string;
  token: string;
};

let mediaEndpoint: MediaServerEndpoint | null = null;
let mediaEndpointPromise: Promise<MediaServerEndpoint | null> | null = null;

/** Already-viewable URL schemes (incl. loopback media HTTP). */
export function isViewableSrc(src: string): boolean {
  return (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:") ||
    src.startsWith("blob:") ||
    src.startsWith("asset:") ||
    src.startsWith("media:") ||
    src.startsWith("https://asset.localhost") ||
    src.startsWith("http://asset.localhost") ||
    src.startsWith("https://media.localhost") ||
    src.startsWith("http://media.localhost") ||
    src.includes("://asset.localhost") ||
    src.includes("://media.localhost")
  );
}

function looksAbsoluteFsPath(raw: string): boolean {
  return raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
}

/**
 * Build a token-gated loopback URL for an absolute filesystem path.
 * Returns null when the media server endpoint is not yet known.
 */
export function localPathToMediaHttpUrl(absPath: string): string | null {
  const ep = mediaEndpoint;
  if (!ep?.baseUrl || !ep.token) return null;
  const base = ep.baseUrl.replace(/\/$/, "");
  return `${base}/v1/media?t=${encodeURIComponent(ep.token)}&p=${encodeURIComponent(absPath)}`;
}

/** Whether the loopback media server endpoint is ready. */
export function isMediaEndpointReady(): boolean {
  return !!(mediaEndpoint?.baseUrl && mediaEndpoint?.token);
}

/**
 * Inject endpoint from Host (or tests). Clears the path→url cache so prior
 * nulls (server not ready) can re-resolve.
 */
export function setMediaEndpoint(ep: MediaServerEndpoint | null): void {
  mediaEndpoint = ep;
  resolveCache.clear();
}

/**
 * Fetch endpoint from Host once. Safe to call multiple times; concurrent
 * callers share one promise. No-op outside Tauri desktop.
 */
export async function ensureMediaEndpoint(): Promise<MediaServerEndpoint | null> {
  if (mediaEndpoint) return mediaEndpoint;
  if (!isTauri()) return null;
  if (mediaEndpointPromise) return mediaEndpointPromise;

  mediaEndpointPromise = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const ep = await invoke<MediaServerEndpoint>("media_server_endpoint");
      if (ep?.baseUrl && ep?.token) {
        setMediaEndpoint(ep);
        return ep;
      }
      return null;
    } catch {
      return null;
    } finally {
      mediaEndpointPromise = null;
    }
  })();

  return mediaEndpointPromise;
}

/**
 * Sync resolve (preferred for chat cards).
 * Returns null when the path cannot be turned into a viewable src.
 */
export function resolveImageSrcSync(pathOrUrl: string): string | null {
  const raw = pathOrUrl.trim();
  if (!raw) return null;
  if (isViewableSrc(raw)) return raw;

  if (resolveCache.has(raw)) {
    return resolveCache.get(raw) ?? null;
  }

  // Ellipsis-truncated paths need host smart-open first.
  if (raw.startsWith("...") || raw.startsWith("…") || raw.includes("/.../")) {
    resolveCache.set(raw, null);
    return null;
  }

  if (!looksAbsoluteFsPath(raw)) {
    resolveCache.set(raw, null);
    return null;
  }

  // Preferred: loopback HTTP (token + path_scope on Host).
  const httpUrl = localPathToMediaHttpUrl(raw);
  if (httpUrl) {
    resolveCache.set(raw, httpUrl);
    return httpUrl;
  }

  if (!isTauri()) {
    resolveCache.set(raw, null);
    return null;
  }

  // Cold-start fallback: custom media:// until ensureMediaEndpoint() finishes.
  try {
    const url = convertFileSrc(raw, "media");
    resolveCache.set(raw, url);
    return url;
  } catch {
    try {
      const url = convertFileSrc(raw);
      resolveCache.set(raw, url);
      return url;
    } catch {
      resolveCache.set(raw, null);
      return null;
    }
  }
}

/**
 * Async resolve — ensures media endpoint is loaded, then returns HTTP URL.
 * Prefer this for first paint after app boot when cards may mount before init.
 */
export async function resolveImageSrc(
  pathOrUrl: string,
): Promise<string | null> {
  const raw = pathOrUrl.trim();
  if (!raw) return null;
  if (isViewableSrc(raw)) return raw;
  if (looksAbsoluteFsPath(raw) && isTauri()) {
    await ensureMediaEndpoint();
    // Drop stale null cache entry from before endpoint was ready.
    if (resolveCache.get(raw) == null) {
      resolveCache.delete(raw);
    }
  }
  return resolveImageSrcSync(raw);
}

/** Resolve many paths; preserves order, drops failures. */
export async function resolveImageSrcs(
  paths: string[],
): Promise<{ path: string; src: string }[]> {
  if (paths.some(looksAbsoluteFsPath) && isTauri()) {
    await ensureMediaEndpoint();
  }
  const out: { path: string; src: string }[] = [];
  for (const path of paths) {
    const src = resolveImageSrcSync(path);
    if (src) out.push({ path, src });
  }
  return out;
}

/** Test helper — clear the resolve cache. */
export function clearImageSrcCache(): void {
  resolveCache.clear();
}

/** Test helper — reset media endpoint. */
export function resetMediaEndpointForTests(): void {
  mediaEndpoint = null;
  mediaEndpointPromise = null;
  resolveCache.clear();
}
