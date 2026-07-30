/**
 * Per-session sticky notes (localStorage map sessionId → text).
 *
 * Client-only scratch pad for the user. Notes are never attached to agent
 * prompts unless the user pastes them. Do not log note contents (may hold
 * secrets / personal context).
 */

export const SESSION_NOTES_STORAGE_KEY = "grok.sessionNotes";

/** Fired on `window` after a successful save (detail = sessionId keys touched or full map keys). */
export const SESSION_NOTES_CHANGE_EVENT = "grok-session-notes-change";

/** Soft cap for a single note (~2k code units). */
export const SESSION_NOTE_MAX_LENGTH = 2000;

/** Default tip preview length (characters). */
export const SESSION_NOTE_PREVIEW_LENGTH = 80;

/** Minimal storage surface so unit tests need no jsdom. */
export interface SessionNotesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultStorage(): SessionNotesStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  return { getItem: () => null, setItem: () => {} };
}

function normalizeId(sessionId: string | null | undefined): string | null {
  if (typeof sessionId !== "string") return null;
  const id = sessionId.trim();
  return id ? id : null;
}

/** Clamp note text to max length (UTF-16 code units). */
export function clampNoteText(
  text: string,
  maxLen: number = SESSION_NOTE_MAX_LENGTH,
): string {
  if (typeof text !== "string") return "";
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen);
}

/**
 * One-line preview for tooltips / aria. Collapses whitespace; truncates with ellipsis.
 * Does not log; pure transform only.
 */
export function notePreview(
  text: string | null | undefined,
  maxLen: number = SESSION_NOTE_PREVIEW_LENGTH,
): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (maxLen <= 0) return "";
  if (flat.length <= maxLen) return flat;
  if (maxLen <= 1) return "…";
  return flat.slice(0, maxLen - 1) + "…";
}

/**
 * Parse stored JSON object into sessionId → note text.
 * Invalid / empty → {}.
 */
export function parseSessionNotes(raw: unknown): Record<string, string> {
  if (raw == null || raw === "") return {};
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const id = normalizeId(k);
    if (!id) continue;
    if (typeof v !== "string") continue;
    const note = clampNoteText(v);
    if (!note.trim()) continue;
    out[id] = note;
  }
  return out;
}

/** Load full map from storage. */
export function loadSessionNotes(
  storage: SessionNotesStorage = defaultStorage(),
): Record<string, string> {
  try {
    return parseSessionNotes(storage.getItem(SESSION_NOTES_STORAGE_KEY));
  } catch {
    /* private mode */
    return {};
  }
}

/**
 * Persist full map. Empty-string notes are dropped. Sorted keys for stable JSON.
 * Dispatches SESSION_NOTES_CHANGE_EVENT with detail = sorted session ids that have notes.
 */
export function saveSessionNotes(
  map: Record<string, string>,
  storage: SessionNotesStorage = defaultStorage(),
): void {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    const id = normalizeId(k);
    if (!id) continue;
    if (typeof v !== "string") continue;
    const note = clampNoteText(v);
    if (!note.trim()) continue;
    cleaned[id] = note;
  }
  const keys = Object.keys(cleaned).sort();
  const ordered: Record<string, string> = {};
  for (const k of keys) ordered[k] = cleaned[k]!;
  try {
    if (keys.length === 0) {
      if (typeof storage.removeItem === "function") {
        storage.removeItem(SESSION_NOTES_STORAGE_KEY);
      } else {
        storage.setItem(SESSION_NOTES_STORAGE_KEY, "{}");
      }
    } else {
      storage.setItem(SESSION_NOTES_STORAGE_KEY, JSON.stringify(ordered));
    }
  } catch {
    /* private mode / quota */
    return;
  }
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    try {
      window.dispatchEvent(
        new CustomEvent(SESSION_NOTES_CHANGE_EVENT, { detail: keys }),
      );
    } catch {
      /* ignore */
    }
  }
}

/** Read note for one session ("" when missing). */
export function getNote(
  sessionId: string | null | undefined,
  storage: SessionNotesStorage = defaultStorage(),
): string {
  const id = normalizeId(sessionId);
  if (!id) return "";
  return loadSessionNotes(storage)[id] ?? "";
}

/** Whether the session has a non-empty sticky note. */
export function hasNote(
  sessionId: string | null | undefined,
  storage: SessionNotesStorage = defaultStorage(),
): boolean {
  return getNote(sessionId, storage).trim().length > 0;
}

/**
 * Set note text for a session. Empty / whitespace-only clears the entry.
 * Returns the stored text (clamped), or "" when cleared / invalid id.
 */
export function setNote(
  sessionId: string | null | undefined,
  text: string,
  storage: SessionNotesStorage = defaultStorage(),
): string {
  const id = normalizeId(sessionId);
  if (!id) return "";
  const map = loadSessionNotes(storage);
  const next = clampNoteText(typeof text === "string" ? text : "");
  if (!next.trim()) {
    delete map[id];
    saveSessionNotes(map, storage);
    return "";
  }
  map[id] = next;
  saveSessionNotes(map, storage);
  return next;
}

/** Remove note for a session. */
export function clearNote(
  sessionId: string | null | undefined,
  storage: SessionNotesStorage = defaultStorage(),
): void {
  setNote(sessionId, "", storage);
}

/** Aliases matching common load/save naming. */
export const load = loadSessionNotes;
export const save = saveSessionNotes;
