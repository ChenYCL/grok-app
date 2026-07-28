/**
 * Wallpaper source helpers — X search + Imagine gallery types and pure logic.
 */

export type WallpaperSourceKind = "x" | "imagine" | "library";

export type WallpaperGalleryItem = {
  id: string;
  thumbUrl: string;
  fullUrl: string;
  kind: "image" | "video" | string;
  width?: number | null;
  height?: number | null;
  source: WallpaperSourceKind | string;
  username?: string | null;
  postUrl?: string | null;
  textPreview?: string | null;
  likes?: number | null;
  localPath?: string | null;
  prompt?: string | null;
};

export type WallpaperSearchResult = {
  items: WallpaperGalleryItem[];
  errorCode?: string | null;
  message?: string | null;
};

export type WallpaperFetchResult = {
  path: string;
  mime: string;
  bytes: number;
  name: string;
};

export type WallpaperLibraryEntry = {
  path: string;
  name: string;
  source: string;
  kind: string;
  bytes: number;
  modifiedMs: number;
};

export type WallpaperSourceErrorCode =
  | "auth_required"
  | "cli_missing"
  | "search_failed"
  | "empty"
  | "download_failed"
  | "url_blocked"
  | "imagine_failed"
  | "timeout"
  | "generic";

/** Map host error strings / codes to a stable UI code. */
export function parseWallpaperSourceError(err: unknown): WallpaperSourceErrorCode {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "";
  const s = raw.toLowerCase();
  if (s.includes("auth_required")) return "auth_required";
  if (s.includes("cli_missing")) return "cli_missing";
  if (s.includes("url_blocked")) return "url_blocked";
  if (s.includes("download_failed") || s.includes("download")) return "download_failed";
  if (s.includes("imagine_failed") || s.includes("imagine")) return "imagine_failed";
  if (s.includes("timeout")) return "timeout";
  if (s.includes("empty")) return "empty";
  if (s.includes("search_failed") || s.includes("search")) return "search_failed";
  return "generic";
}

export function errorCodeFromSearchResult(
  result: WallpaperSearchResult,
): WallpaperSourceErrorCode | null {
  if (result.items.length > 0) return null;
  const code = (result.errorCode || "").toLowerCase();
  if (!code) return "empty";
  if (code === "auth_required") return "auth_required";
  if (code === "cli_missing") return "cli_missing";
  if (code === "search_failed") return "search_failed";
  if (code === "imagine_failed") return "imagine_failed";
  if (code === "empty") return "empty";
  if (code === "timeout") return "timeout";
  return "generic";
}

/** Deduplicate gallery items by fullUrl / localPath. */
export function dedupeGalleryItems(
  items: WallpaperGalleryItem[],
): WallpaperGalleryItem[] {
  const seen = new Set<string>();
  const out: WallpaperGalleryItem[] = [];
  for (const it of items) {
    const key = (it.localPath || it.fullUrl || it.id).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

/**
 * Load a local absolute path into a File for prepareWallpaperFromFile.
 * Uses Tauri media:// protocol when available.
 */
export async function fileFromAbsolutePath(
  absolutePath: string,
  opts?: { name?: string; mime?: string },
): Promise<File> {
  const name =
    opts?.name ||
    absolutePath.split(/[/\\]/).pop() ||
    "wallpaper.jpg";
  const mime = opts?.mime || mimeFromName(name);

  // Browser / unit tests: no Tauri
  if (
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  ) {
    throw new Error("desktop_only");
  }

  const { convertFileSrc } = await import("@tauri-apps/api/core");
  let url: string;
  try {
    url = convertFileSrc(absolutePath, "media");
  } catch {
    url = convertFileSrc(absolutePath);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`read_failed: HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const type = blob.type && blob.type !== "application/octet-stream" ? blob.type : mime;
  return new File([blob], name, { type });
}

/** Prefer local path when present (Imagine / library). */
export function resolveApplySource(
  item: WallpaperGalleryItem,
): { kind: "path"; path: string } | { kind: "url"; url: string } {
  if (item.localPath && item.localPath.trim()) {
    return { kind: "path", path: item.localPath.trim() };
  }
  // file:// from host scan
  if (item.fullUrl.startsWith("file://")) {
    const p = item.fullUrl.replace(/^file:\/\//, "");
    return { kind: "path", path: decodeURIComponent(p) };
  }
  return { kind: "url", url: item.fullUrl };
}
