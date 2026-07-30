/**
 * User preference: filter chat transcript paint list.
 * localStorage-only — does not touch Host AppSettings.
 *
 * - all (default): show tool steps / activity chrome (existing paint filter only)
 * - conversation: hide tool_step rows (and callers hide inlined tool chrome)
 */

import type { ChatMessage } from "./session";
import { filterTranscriptMessages, isToolStepMessage } from "./session";

export const TRANSCRIPT_FILTER_STORAGE_KEY = "grok.transcriptFilter";

/** Fired on `window` after a successful save (detail = TranscriptFilterMode). */
export const TRANSCRIPT_FILTER_CHANGE_EVENT = "grok-transcript-filter-change";

export type TranscriptFilterMode = "all" | "conversation";

export const DEFAULT_TRANSCRIPT_FILTER: TranscriptFilterMode = "all";

/** Minimal storage surface so unit tests need no jsdom. */
export interface TranscriptFilterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): TranscriptFilterStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  return { getItem: () => null, setItem: () => {} };
}

/** Parse stored value; invalid / empty → default `all`. */
export function parseTranscriptFilterPref(raw: unknown): TranscriptFilterMode {
  if (raw === "conversation" || raw === "conversation_only") {
    return "conversation";
  }
  if (raw === "all" || raw === "full") return "all";
  return DEFAULT_TRANSCRIPT_FILTER;
}

export function loadTranscriptFilterPref(
  storage: TranscriptFilterStorage = defaultStorage(),
): TranscriptFilterMode {
  try {
    return parseTranscriptFilterPref(
      storage.getItem(TRANSCRIPT_FILTER_STORAGE_KEY),
    );
  } catch {
    /* private mode */
    return DEFAULT_TRANSCRIPT_FILTER;
  }
}

export function saveTranscriptFilterPref(
  mode: TranscriptFilterMode,
  storage: TranscriptFilterStorage = defaultStorage(),
): void {
  const next: TranscriptFilterMode =
    mode === "conversation" ? "conversation" : "all";
  try {
    storage.setItem(TRANSCRIPT_FILTER_STORAGE_KEY, next);
  } catch {
    /* private mode / quota */
  }
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    try {
      window.dispatchEvent(
        new CustomEvent(TRANSCRIPT_FILTER_CHANGE_EVENT, { detail: next }),
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * Pure paint-list filter for the chat transcript.
 *
 * Always drops tool_step journal rows already woven into an assistant timeline
 * (virtualization hygiene — same as {@link filterTranscriptMessages}).
 *
 * When `mode === "conversation"`, also drops every remaining tool_step row so
 * the virtual list only keeps user / assistant / errors / non-tool chrome
 * (compact banners, end-of-turn markers, etc.). Inlined TimelineToolRow chrome
 * inside assistant bubbles is suppressed by the thread renderer, not here.
 */
export function filterMessagesForTranscript(
  messages: ChatMessage[],
  mode: TranscriptFilterMode = DEFAULT_TRANSCRIPT_FILTER,
): ChatMessage[] {
  const base = filterTranscriptMessages(messages);
  if (mode !== "conversation") return base;
  return base.filter((m) => !isToolStepMessage(m));
}

/** True when the thread should paint tool steps / live tool chrome. */
export function shouldShowTranscriptToolChrome(
  mode: TranscriptFilterMode,
): boolean {
  return mode !== "conversation";
}
