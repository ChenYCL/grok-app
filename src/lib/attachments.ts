/**
 * Composer attachments from drag-drop (or future pickers).
 * Sent to the agent as Grok Build `@path` references.
 */

export interface Attachment {
  path: string;
  name: string;
  isDir: boolean;
}

/** Merge new items by absolute path (dedupe). */
export function mergeAttachments(
  prev: Attachment[],
  next: Attachment[],
): Attachment[] {
  const map = new Map(prev.map((a) => [a.path, a]));
  for (const a of next) {
    if (!a.path) continue;
    map.set(a.path, a);
  }
  return Array.from(map.values());
}

/**
 * Build the text sent to the agent: user message + `@/abs/path` lines.
 * Empty user text is fine when only files are attached.
 */
export function buildAgentPrompt(
  userText: string,
  attachments: Attachment[],
): string {
  const body = userText.trim();
  if (!attachments.length) return body;
  const refs = attachments.map((a) => `@${a.path}`).join("\n");
  return body ? `${body}\n\n${refs}` : refs;
}

/** Basename without emoji. */
export function pathBasename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

/**
 * Split stored/agent message into display text + attachment list.
 * Lines that are sole `@/abs/path` (or `@path`) become attachments.
 */
export function parseAttachmentsFromContent(content: string): {
  text: string;
  attachments: Attachment[];
} {
  if (!content) return { text: "", attachments: [] };
  const lines = content.split("\n");
  const attachments: Attachment[] = [];
  const textLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // @/path or @C:\path or @path
    const m = trimmed.match(/^@((?:\/|[A-Za-z]:[\\/]).+)$/);
    if (m?.[1]) {
      const path = m[1].trim();
      attachments.push({
        path,
        name: pathBasename(path),
        isDir: false, // refined by pathsClassify when needed
      });
      continue;
    }
    // Legacy display markers from older builds
    const legacy = trimmed.match(/^\[(file|dir)\]\s+(.+)$/i);
    if (legacy?.[2] && !legacy[2].includes("/")) {
      // name-only legacy line — skip as plain text still ok
      textLines.push(line);
      continue;
    }
    textLines.push(line);
  }
  // Drop trailing blank lines left before attachment block
  while (textLines.length && textLines[textLines.length - 1]!.trim() === "") {
    textLines.pop();
  }
  return { text: textLines.join("\n"), attachments };
}

/** File extension lowercase without dot. */
export function pathExt(path: string): string {
  const base = pathBasename(path);
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i + 1).toLowerCase();
}

export function isImagePath(path: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "avif"].includes(
    pathExt(path),
  );
}
