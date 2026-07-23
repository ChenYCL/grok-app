/**
 * Composer draft document model: text segments + inline skill chips.
 * Storage / user bubbles use stable tokens `[[skill:name]]`.
 * Agent prompts serialize skills as `/name` (Grok Build invocable form).
 */

export type DraftSegment =
  | { type: "text"; text: string }
  | { type: "skill"; name: string };

/** Skill name character class: letters, digits, `_` `.` `:` `-`. */
export const SKILL_NAME_RE = /[a-zA-Z0-9_.:-]+/;

const SKILL_TOKEN_RE = /\[\[skill:([a-zA-Z0-9_.:-]+)\]\]/g;

/**
 * Slash names that are App/Build commands, not skill chips, when rehydrating
 * agent-form history (`/name` lines saved from session_send).
 */
const NON_SKILL_SLASH = new Set(
  [
    "goal",
    "plan",
    "compact",
    "status",
    "mcp",
    "doctor",
    "new",
    "newchat",
    "automations",
    "settings",
    "yolo",
    "always-approve",
    "loop",
    "model",
    "effort",
    "help",
    "clear",
    "resume",
    "export",
    "copy",
    "feedback",
  ].map((s) => s.toLowerCase()),
);

/**
 * Convert agent-form user text (`/skill-name\nbody`) into display tokens
 * (`[[skill:name]]\nbody`) so history bubbles can render chips.
 * Already-tokenized content is left unchanged.
 */
export function hydrateDisplayContent(content: string): string {
  if (!content) return content;
  if (content.includes("[[skill:")) return content;

  let rest = content;
  // Drop goal mode prefix from display hydration (mode is session chrome, not a chip).
  if (rest.startsWith("/goal\n")) {
    rest = rest.slice("/goal\n".length);
  } else if (rest === "/goal") {
    return content;
  }

  const nl = rest.indexOf("\n");
  const firstLine = (nl === -1 ? rest : rest.slice(0, nl)).trim();
  const body = nl === -1 ? "" : rest.slice(nl + 1);

  if (!firstLine) return content;

  const parts = firstLine.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return content;
  if (!parts.every((p) => /^\/[a-zA-Z0-9_.:-]+$/.test(p))) return content;

  const names = parts.map((p) => p.slice(1));
  // Require at least one invocable skill; skip pure built-in command lines.
  const skillNames = names.filter(
    (n) => !NON_SKILL_SLASH.has(n.toLowerCase()),
  );
  if (skillNames.length === 0) return content;
  // Only convert when every first-line token is a skill (not mixed with builtins).
  if (skillNames.length !== names.length) return content;

  const chips = skillNames.map((n) => `[[skill:${n}]]`).join("");
  if (!body) return chips;
  // Preserve body; chips sit before the rest of the message.
  return `${chips}\n${body}`;
}

/** Parse user message for display/edit (hydrates agent-form history first). */
export function parseUserMessageContent(content: string): DraftSegment[] {
  return parseStoredContent(hydrateDisplayContent(content));
}

/** Empty draft (no segments). */
export function emptyDraft(): DraftSegment[] {
  return [];
}

/** Single text segment, or empty draft when text is empty. */
export function draftFromPlainText(text: string): DraftSegment[] {
  if (!text) return [];
  return [{ type: "text", text }];
}

/**
 * Parse stored content with `[[skill:name]]` tokens into segments.
 * Invalid / incomplete tokens stay as plain text.
 */
export function parseStoredContent(content: string): DraftSegment[] {
  if (!content) return [];
  const segments: DraftSegment[] = [];
  let last = 0;
  const re = new RegExp(SKILL_TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      segments.push({ type: "text", text: content.slice(last, m.index) });
    }
    segments.push({ type: "skill", name: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < content.length) {
    segments.push({ type: "text", text: content.slice(last) });
  }
  return segments;
}

/** Serialize segments back to stored form (`[[skill:name]]` tokens). */
export function serializeStored(segments: DraftSegment[]): string {
  return segments
    .map((s) => (s.type === "text" ? s.text : `[[skill:${s.name}]]`))
    .join("");
}

/**
 * Text of text segments only (skills omitted).
 * Do not use alone for "has content" when skills may be present — use `isDraftEmpty`.
 */
export function plainTextOf(segments: DraftSegment[]): string {
  return segments
    .filter((s): s is { type: "text"; text: string } => s.type === "text")
    .map((s) => s.text)
    .join("");
}

/** Empty when there are no skills and no non-whitespace text. */
export function isDraftEmpty(segments: DraftSegment[]): boolean {
  for (const s of segments) {
    if (s.type === "skill") return false;
    if (s.type === "text" && s.text.trim() !== "") return false;
  }
  return true;
}

/**
 * Build the string sent to the agent:
 * - skills in order as `/name`, space-joined
 * - then `\n` + joined text parts (ends trimmed; internal newlines kept)
 * - `goalMode` prefixes `/goal\n`
 */
export function serializeForAgent(
  segments: DraftSegment[],
  opts?: { goalMode?: boolean },
): string {
  const skillTokens: string[] = [];
  const textParts: string[] = [];
  for (const s of segments) {
    if (s.type === "skill") skillTokens.push(`/${s.name}`);
    else textParts.push(s.text);
  }

  const skillsPart = skillTokens.join(" ");
  // Trim only leading/trailing whitespace; keep internal newlines.
  const textPart = textParts.join("").replace(/^\s+/, "").replace(/\s+$/, "");

  let body: string;
  if (skillsPart && textPart) body = `${skillsPart}\n${textPart}`;
  else if (skillsPart) body = skillsPart;
  else body = textPart;

  if (opts?.goalMode) {
    return body ? `/goal\n${body}` : "/goal";
  }
  return body;
}

/**
 * Replace the active slash range `[slashStart, slashEnd)` with a skill token
 * plus a trailing space.
 */
export function applySkillAtSlash(
  stored: string,
  slashStart: number,
  slashEnd: number,
  skillName: string,
): string {
  const token = `[[skill:${skillName}]] `;
  return stored.slice(0, slashStart) + token + stored.slice(slashEnd);
}

/**
 * Detect an active slash token at the end of `textBeforeCursor`.
 * `/` must be at index 0 or immediately after whitespace.
 * Query is the non-whitespace rest after `/`.
 * Returns null when there is no active slash (e.g. `https://`).
 */
export function detectSlashQuery(
  textBeforeCursor: string,
): { start: number; query: string } | null {
  // Trailing `/query` where `/` is at start or after whitespace.
  const m = /(^|[\s])\/([^\s]*)$/.exec(textBeforeCursor);
  if (!m) return null;
  const start = m.index + m[1]!.length;
  return { start, query: m[2]! };
}

/** Collapse consecutive text segments into one. */
export function mergeAdjacentText(segments: DraftSegment[]): DraftSegment[] {
  if (segments.length === 0) return [];
  const out: DraftSegment[] = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (s.type === "text" && prev?.type === "text") {
      out[out.length - 1] = { type: "text", text: prev.text + s.text };
    } else {
      out.push(s);
    }
  }
  return out;
}

/**
 * Simple editor projection: text as-is, skills as `[[skill:name]]`.
 * Same wire form as `serializeStored`.
 */
export function segmentsToPlainEditorText(segments: DraftSegment[]): string {
  return serializeStored(segments);
}
