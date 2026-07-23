/**
 * Resolve a local filesystem path (or remote URL) to something an <img> can load.
 *
 * Prefer the custom `media://` protocol for absolute paths — Tauri's built-in
 * `asset://` scope often rejects real user paths (and Chinese segments), which
 * floods the console and reflows the chat on every scroll retry.
 */

import { isTauri } from "@/lib/api";

/** Already-viewable URL schemes. */
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

/**
 * Convert absolute local path → convertFileSrc URL.
 * Pass-through for http(s)/data/blob.
 *
 * Uses `media` protocol (no asset-scope gate; Range-capable).
 */
export async function resolveImageSrc(pathOrUrl: string): Promise<string | null> {
  const raw = pathOrUrl.trim();
  if (!raw) return null;
  if (isViewableSrc(raw)) return raw;

  // Ellipsis-truncated paths need host smart-open first (not convertFileSrc).
  // Callers with project context should resolve via fsOpenPath; here we only
  // handle absolute filesystem paths.
  if (raw.startsWith("...") || raw.startsWith("…") || raw.includes("/.../")) {
    return null;
  }

  // Must look like an absolute path for media protocol
  const abs =
    raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) ? raw : null;
  if (!abs) return null;

  if (isTauri()) {
    try {
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      // media protocol: registered in host, reads any absolute path without
      // assetProtocol scope denials that cause scroll-time error spam.
      return convertFileSrc(abs, "media");
    } catch {
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        return convertFileSrc(abs);
      } catch {
        return null;
      }
    }
  }

  // Browser-only dev: cannot read arbitrary local files.
  return null;
}

/** Resolve many paths; preserves order, drops failures. */
export async function resolveImageSrcs(
  paths: string[],
): Promise<{ path: string; src: string }[]> {
  const out: { path: string; src: string }[] = [];
  for (const path of paths) {
    const src = await resolveImageSrc(path);
    if (src) out.push({ path, src });
  }
  return out;
}
