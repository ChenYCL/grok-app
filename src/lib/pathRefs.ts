/**
 * Detect file paths and URLs in assistant markdown for in-place cards.
 */

import {
  isImagePath,
  isMediaPath,
  isVideoPath,
  pathBasename,
  pathExt,
} from "@/lib/attachments";

const CODE_EXTS =
  "ts|tsx|js|jsx|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|sql|vue|svelte|dart|lua|r|scala|zig|toml|yaml|yml|json|jsonc|css|scss|less|md|mdx|txt|log|html|htm|xml|csv|tsv|env|ini|conf|config|docx|docm|xlsx|xlsm|pptx|pptm|pdf|odt|ods|odp|zip|tar|gz|tgz|7z|rar|wasm|map|lock|gradle|cmake|dockerfile|makefile|svg";

const FILE_EXT_RE = new RegExp(
  `\\.(?:${CODE_EXTS}|png|jpe?g|gif|webp|bmp|heic|avif|mp4|webm|mov|mkv|m4v|avi|mp3|wav|ogg|m4a|flac)$`,
  "i",
);

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

export function looksLikeFilePath(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 800) return false;
  if (isHttpUrl(t)) return false;
  if (t.includes("://")) return false;
  // Absolute
  if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) {
    return FILE_EXT_RE.test(t) || /\/[^/]+$/.test(t);
  }
  // Relative with slash + extension (project paths)
  if (
    (t.includes("/") || t.includes("\\")) &&
    FILE_EXT_RE.test(t) &&
    !t.startsWith("http")
  ) {
    return true;
  }
  // Bare filename with known extension
  if (/^[\w.-]+\.\w{1,12}$/.test(t) && FILE_EXT_RE.test(t)) {
    return true;
  }
  return false;
}

export function isAbsoluteFsPath(s: string): boolean {
  return s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s);
}

/** Join project root + relative path (posix-ish). */
export function joinProjectPath(projectRoot: string, relative: string): string {
  const root = projectRoot.replace(/[/\\]+$/, "");
  const rel = relative.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(root) || root.includes("\\")) {
    return `${root}\\${rel.replace(/\//g, "\\")}`;
  }
  return `${root}/${rel}`;
}

/**
 * Resolve a path token when we already know a verified absolute path
 * (pathMap / absolute in text). Does **not** invent paths by joining
 * projectRoot + relative — monorepo agents often write paths relative to a
 * subfolder (e.g. projects/x-ops), so naive join is often a non-existent file.
 * Relative paths stay relative; host `fs_open_path` does smart resolution.
 */
export function resolveFileToken(
  token: string,
  opts?: {
    projectPath?: string | null;
    /** token → absolute (media attachments map, etc.) */
    pathMap?: Record<string, string> | null;
  },
): string | null {
  const t = token.trim().replace(/^<|>$/g, "");
  if (!t) return null;
  if (opts?.pathMap?.[t]) return opts.pathMap[t]!;
  const norm = t.replace(/\\/g, "/");
  if (opts?.pathMap?.[norm]) return opts.pathMap[norm]!;
  if (isAbsoluteFsPath(t)) return t;
  // Relative: keep as relative token (do not join project root)
  if (looksLikeFilePath(t) && !isHttpUrl(t)) {
    if (t.includes("/") || t.includes("\\")) return norm;
    // bare filename only — too ambiguous without pathMap
    return null;
  }
  return null;
}

export type PathRefKind = "image" | "video" | "file" | "url";

export function classifyPathRef(pathOrUrl: string): PathRefKind {
  if (isHttpUrl(pathOrUrl)) return "url";
  if (isImagePath(pathOrUrl)) return "image";
  if (isVideoPath(pathOrUrl)) return "video";
  return "file";
}

export function fileSubtitle(path: string, locale: "zh" | "en" = "zh"): string {
  const ext = pathExt(path).toUpperCase();
  if (!ext) return locale === "zh" ? "文件" : "File";
  if (ext === "MD" || ext === "MDX")
    return locale === "zh" ? "文档 · MD" : "Doc · MD";
  if (ext === "HTML" || ext === "HTM") return "HTML";
  if (ext === "DOCX" || ext === "DOC")
    return locale === "zh" ? "文档 · Word" : "Doc · Word";
  if (ext === "XLSX" || ext === "XLS")
    return locale === "zh" ? "表格 · Excel" : "Sheet · Excel";
  if (ext === "PDF") return "PDF";
  if (ext === "PY") return locale === "zh" ? "代码 · Python" : "Code · Python";
  if (["TS", "TSX", "JS", "JSX"].includes(ext))
    return locale === "zh" ? "代码 · " + ext : "Code · " + ext;
  return locale === "zh" ? `文件 · ${ext}` : `File · ${ext}`;
}

export { pathBasename, isMediaPath };
