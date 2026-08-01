/**
 * Streaming render / coalesce policy for chat UI.
 *
 * Long assistant turns re-parse markdown and re-render the App shell on every
 * chunk. On integrated-GPU Retina laptops (e.g. 2019 16" Intel MBP), that
 * thrash freezes the UI after a few tool-heavy turns. These knobs batch and
 * cheapen the hot path without changing final (non-streaming) fidelity.
 */

/** Default stream→React flush interval (ms). Higher = fewer App setStates. */
export const STREAM_COALESCE_FLUSH_MS = 110;

/**
 * Virtualize the transcript once this many rows exist (tool steps count).
 * Lower than historical 48 so "a few agent turns" already window the DOM.
 */
export const CHAT_VIRTUALIZE_THRESHOLD_PERF = 16;

/**
 * While streaming, re-run ReactMarkdown at most this often (ms).
 * Smooth/plain text can still update more often; only the parse is throttled.
 */
export const STREAM_MARKDOWN_PARSE_MS = 160;

/**
 * Non-structural content notify throttle for the transcript store (ms).
 * Full text is always stored immediately; React only re-renders on this cadence.
 */
export const TRANSCRIPT_CONTENT_NOTIFY_MS = 100;

/**
 * Past this many characters while streaming, skip live markdown and show
 * plain pre-wrap until the turn settles (one full parse on done).
 */
export const STREAM_PLAIN_TEXT_CHAR_THRESHOLD = 2000;

/** Whether hardware looks like a thermally-limited laptop (Intel dual-GPU class). */
export function isLowPowerClient(
  hardwareConcurrency: number = typeof navigator !== "undefined"
    ? navigator.hardwareConcurrency || 8
    : 8,
): boolean {
  return hardwareConcurrency <= 12;
}

/** Prefer plain streaming body once content crosses the threshold. */
export function shouldUsePlainStreamBody(
  contentLength: number,
  streaming: boolean,
  threshold: number = STREAM_PLAIN_TEXT_CHAR_THRESHOLD,
): boolean {
  if (!streaming) return false;
  return contentLength >= threshold;
}

/**
 * Adaptive coalesce interval: slightly longer on low core counts (typical
 * Intel dual-socket laptop cores / thermal throttle), shorter on big machines.
 */
export function resolveStreamFlushMs(
  hardwareConcurrency: number = typeof navigator !== "undefined"
    ? navigator.hardwareConcurrency || 8
    : 8,
): number {
  if (hardwareConcurrency <= 8) return 128;
  if (hardwareConcurrency <= 12) return STREAM_COALESCE_FLUSH_MS;
  return 72;
}

/** Scale chat virtual overscan down while streaming on low-power clients. */
export function resolveStreamOverscanScale(
  streaming: boolean,
  hardwareConcurrency?: number,
): number {
  if (!streaming) return 1;
  return isLowPowerClient(hardwareConcurrency) ? 0.55 : 0.75;
}
