/**
 * Pure helpers for bulk-archive-by-age (sidebar / Settings).
 * Filters only — host archive is still `session_set_archived`.
 */

/** Supported thresholds in the “Archive older than…” picker. */
export const ARCHIVE_AGE_DAY_OPTIONS = [7, 30, 90] as const;

export type ArchiveAgeDays = (typeof ARCHIVE_AGE_DAY_OPTIONS)[number];

export type ArchiveAgeSessionLike = {
  id: string;
  updatedAt: string;
  archived?: boolean;
  pinned?: boolean;
};

/** Milliseconds for `days` full days (UTC-safe wall-clock delta). */
export function daysToMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/**
 * True when `updatedAt` is strictly older than `days` before `now`.
 * Invalid / empty timestamps never match (safe: do not archive unknowns).
 */
export function isSessionOlderThanDays(
  updatedAt: string | undefined | null,
  days: number,
  now: Date | number = Date.now(),
): boolean {
  if (!updatedAt || !Number.isFinite(days) || days <= 0) return false;
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(nowMs)) return false;
  return t < nowMs - daysToMs(days);
}

/**
 * Sessions eligible for bulk archive-by-age:
 * - not already archived
 * - not pinned
 * - `updatedAt` strictly older than `days` before `now`
 *
 * Preserves input order.
 */
export function filterSessionsOlderThanDays<T extends ArchiveAgeSessionLike>(
  sessions: readonly T[],
  days: number,
  now: Date | number = Date.now(),
): T[] {
  if (!Number.isFinite(days) || days <= 0) return [];
  return sessions.filter(
    (s) =>
      !s.archived &&
      !s.pinned &&
      isSessionOlderThanDays(s.updatedAt, days, now),
  );
}
