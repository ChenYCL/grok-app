/**
 * Variable-height virtual window for the main chat transcript.
 *
 * Designed to coexist with stick-to-bottom:
 * - When `pinToBottom`, always include the last row and build the window upward
 *   so streaming tail stays mounted.
 * - Spacers keep total scrollHeight stable so pin/escape math stays valid.
 */

/** Only virtualize long threads — short chats keep full DOM (identical UX). */
export const CHAT_VIRTUALIZE_THRESHOLD = 48;

/** Fallback height before a row is measured (px). */
export const CHAT_DEFAULT_ROW_ESTIMATE_PX = 120;

/** Cap a single estimated row so one mega-answer cannot dominate scroll math. */
export const CHAT_MAX_ROW_ESTIMATE_PX = 8000;

/** Extra px above/below the viewport when browsing history. */
export const CHAT_OVERSCAN_PX = 1200;

/** When pinned, pull in more history above the tail so pin feels continuous. */
export const CHAT_PIN_OVERSCAN_PX = 1600;

/**
 * Content-aware row estimate so tall assistant answers (diagrams, tables)
 * are not first measured as ~120px (that underestimates scrollHeight and
 * makes mid-document look "near bottom" → stick bounce).
 *
 * Media: fixed-size attachment thumbs (~64px) and inline video cards (~240px)
 * are not reflected in `contentLength` — include them so first paint is closer
 * to final height (fewer remeasure snaps near the bottom).
 */
export function estimateChatRowHeight(input: {
  contentLength?: number;
  thoughtLength?: number;
  role?: string;
  /** Message attachment cards (images/files under the bubble). */
  attachmentCount?: number;
  /** True when body likely embeds a local video card. */
  hasVideoCard?: boolean;
}): number {
  const content = Math.max(0, input.contentLength ?? 0);
  const thought = Math.max(0, input.thoughtLength ?? 0);
  const role = (input.role ?? "assistant").toLowerCase();
  // ~42 chars/line in the bubble, ~20px line height, role chrome.
  const lines = Math.ceil((content + thought * 0.5) / 42);
  const chrome = role === "user" ? 72 : role === "tool" ? 40 : 96;
  const atts = Math.max(0, input.attachmentCount ?? 0);
  // 64px thumbs + gap, wrap ~5 per row in a ~360px stack.
  const attRows = atts > 0 ? Math.ceil(atts / 5) : 0;
  const attBoost = attRows * 74;
  const videoBoost = input.hasVideoCard ? 260 : 0;
  const raw = chrome + lines * 20 + attBoost + videoBoost;
  return Math.min(
    CHAT_MAX_ROW_ESTIMATE_PX,
    Math.max(CHAT_DEFAULT_ROW_ESTIMATE_PX, raw),
  );
}

export type ChatVirtualWindow = {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
  totalHeight: number;
};

/** Cumulative offsets: offsets[i] = sum(heights[0..i)). Length = count+1. */
export function cumulativeOffsets(
  count: number,
  getHeight: (index: number) => number,
): number[] {
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let i = 0; i < count; i++) {
    const h = Math.max(0, getHeight(i));
    offsets[i + 1] = (offsets[i] ?? 0) + h;
  }
  return offsets;
}

/**
 * Compute the visible index range + spacers for a variable-height list.
 */
export function computeChatVirtualWindow(input: {
  count: number;
  getHeight: (index: number) => number;
  scrollTop: number;
  viewportHeight: number;
  overscanPx?: number;
  /** Stick-to-bottom active — force include last item, prefer tail. */
  pinToBottom?: boolean;
  /** Indices that must stay mounted (find hit, streaming assistant, …). */
  forceIndices?: readonly number[];
}): ChatVirtualWindow {
  const count = Math.max(0, Math.floor(input.count));
  if (count === 0) {
    return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0 };
  }

  const offsets = cumulativeOffsets(count, input.getHeight);
  const totalHeight = offsets[count] ?? 0;
  const viewportHeight = Math.max(0, input.viewportHeight);
  const pin = !!input.pinToBottom;
  const overscan = Math.max(
    0,
    input.overscanPx ?? (pin ? CHAT_PIN_OVERSCAN_PX : CHAT_OVERSCAN_PX),
  );

  // When pinned, treat the viewport as parked on the absolute bottom so the
  // window always covers the streaming tail even if scrollTop lags one frame.
  let viewTop = Math.max(0, input.scrollTop);
  let viewBottom = viewTop + viewportHeight;
  if (pin) {
    viewBottom = totalHeight;
    viewTop = Math.max(0, totalHeight - Math.max(viewportHeight, 1));
  }

  const rangeTop = Math.max(0, viewTop - overscan);
  const rangeBottom = Math.min(totalHeight, viewBottom + overscan);

  // First index whose bottom edge is past rangeTop.
  let start = 0;
  for (let i = 0; i < count; i++) {
    const bottom = offsets[i + 1] ?? 0;
    if (bottom > rangeTop) {
      start = i;
      break;
    }
    start = i;
  }

  // First index whose top is >= rangeBottom (exclusive end).
  let end = count;
  for (let i = start; i < count; i++) {
    const top = offsets[i] ?? 0;
    if (top >= rangeBottom) {
      end = i;
      break;
    }
  }
  if (end <= start) end = Math.min(count, start + 1);

  if (pin) {
    end = count;
  }

  // Force-include indices (find match, live assistant, last user, …).
  if (input.forceIndices?.length) {
    for (const raw of input.forceIndices) {
      const i = Math.floor(raw);
      if (i < 0 || i >= count) continue;
      if (i < start) start = i;
      if (i >= end) end = i + 1;
    }
  }

  start = Math.max(0, Math.min(start, count - 1));
  end = Math.max(start + 1, Math.min(end, count));

  const paddingTop = offsets[start] ?? 0;
  const rendered = (offsets[end] ?? 0) - paddingTop;
  const paddingBottom = Math.max(0, totalHeight - paddingTop - rendered);

  return { start, end, paddingTop, paddingBottom, totalHeight };
}

/**
 * When a row above the viewport changes height, shift scrollTop so the
 * visible content does not jump (critical when reading history / escaped).
 *
 * Important: only shift when the **entire previous row** was above the
 * viewport top. A tall media-heavy assistant often *straddles* the viewport
 * (row top above, images/video at the bottom still on screen). Treating
 * “row top above fold” as “fully above” used to add the full growth delta
 * and yank the reader toward the bottom (flash-snap near end of chat).
 */
export function scrollTopAfterHeightChange(input: {
  scrollTop: number;
  rowOffset: number;
  /** Committed height before this remeasure (used for straddle detection). */
  prevHeight: number;
  delta: number;
  pinToBottom: boolean;
}): number {
  if (input.pinToBottom) return input.scrollTop;
  if (input.delta === 0) return input.scrollTop;
  const oldBottom = input.rowOffset + Math.max(0, input.prevHeight);
  // Entire old row was strictly above the viewport → keep anchor stable.
  if (oldBottom <= input.scrollTop + 0.5) {
    return Math.max(0, input.scrollTop + input.delta);
  }
  // Straddles or sits at/below the fold — grow/shrink in place.
  return input.scrollTop;
}

/**
 * Whether a remeasure should update the height cache.
 * Ignore tiny flicker; resist shrink thrash (markdown/code reflow) that
 * oscillates padding and fights stick-to-bottom.
 */
export function shouldCommitRowHeight(
  prev: number | undefined,
  next: number,
): boolean {
  if (next < 0) return false;
  // Zero-height rows are real (inlined tool_step journal spacers). Rejecting
  // them left phantom scroll space (~40–120px × N tools) and pin-to-bottom
  // only mounted empty spacers — chat history looked blank after long agent
  // turns (tools woven into the assistant, rows still in the array).
  if (next === 0) {
    return prev == null || prev !== 0;
  }
  if (prev == null) return true;
  const delta = next - prev;
  if (Math.abs(delta) < 2) return false;
  // Allow growth freely; only accept shrinks that are meaningful and stable.
  if (delta < 0 && Math.abs(delta) < Math.max(24, prev * 0.08)) {
    return false;
  }
  return true;
}
