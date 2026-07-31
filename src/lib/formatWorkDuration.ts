/**
 * Grok-official work duration labels: "38s", "1m 2s", "1h 3m".
 * Used by chat activity chrome ("Worked for …" / "Working for …").
 */

/** Format elapsed seconds the way Grok web shows them. */
export function formatWorkDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    if (m === 0 && sec === 0) return `${h}h`;
    if (sec === 0) return `${h}h ${m}m`;
    return `${h}h ${m}m ${sec}s`;
  }
  if (sec === 0) return `${m}m`;
  return `${m}m ${sec}s`;
}

/**
 * Estimate phase work duration from ISO timestamps (history reload).
 * Prefer tool span; fall back to assistant createdAt − earliest tool.
 * Returns null when timestamps are missing or inverted.
 */
export function estimateDurationSecFromTimestamps(
  times: Array<string | undefined | null>,
): number | null {
  const ms = times
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((n) => Number.isFinite(n)) as number[];
  if (ms.length < 2) {
    // Single timestamp is not enough for a span.
    return null;
  }
  const min = Math.min(...ms);
  const max = Math.max(...ms);
  const sec = Math.floor((max - min) / 1000);
  if (sec < 1) return 1;
  // Guard absurd journal clock skew.
  if (sec > 24 * 3600) return null;
  return sec;
}
