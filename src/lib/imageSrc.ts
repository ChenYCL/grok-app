/**
 * Resolve a local filesystem path (or remote URL) to something an <img> can load.
 * Prefer Tauri asset protocol for absolute paths.
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
    src.startsWith("https://asset.localhost") ||
    src.startsWith("http://asset.localhost")
  );
}

/**
 * Convert absolute local path → convertFileSrc URL.
 * Pass-through for http(s)/data/blob.
 */
export async function resolveImageSrc(pathOrUrl: string): Promise<string | null> {
  const raw = pathOrUrl.trim();
  if (!raw) return null;
  if (isViewableSrc(raw)) return raw;

  if (isTauri()) {
    try {
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      return convertFileSrc(raw);
    } catch {
      return null;
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
