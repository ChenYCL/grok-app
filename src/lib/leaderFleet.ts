/**
 * Pure helpers for Settings → Runtime → Agent leader fleet
 * (`grok leader list` / `info` / `kill`).
 *
 * Host returns camelCase DTOs; field names vary by CLI version — keep parsing
 * defensive. Never surface secrets (none expected on leader info).
 */

export type LeaderProcessLike = {
  pid?: number | null;
  socketPath?: string | null;
  version?: string | null;
  classification?: string | null;
  lockPath?: string | null;
  wsUrlSuffix?: string | null;
  raw?: unknown;
};

export type LeaderInfoLike = {
  pid?: number | null;
  socketPath?: string | null;
  lockPath?: string | null;
  version?: string | null;
  protocolVersion?: string | null;
  classification?: string | null;
  uptimeMs?: number | null;
  activeToolCalls?: number | null;
  wsUrlSuffix?: string | null;
  unsupported?: boolean;
  error?: string | null;
  raw?: unknown;
};

export type LeaderDetailRow = {
  key: string;
  label: string;
  value: string;
};

/** Stable row key for list rendering. */
export function leaderRowKey(row: LeaderProcessLike, index: number): string {
  if (row.pid != null && Number.isFinite(row.pid)) return `pid-${row.pid}`;
  const sock = (row.socketPath ?? "").trim();
  if (sock) return `sock-${sock}`;
  return `idx-${index}`;
}

/** One-line summary for a list row (PID · classification · socket). */
export function formatLeaderRowSummary(row: LeaderProcessLike): string {
  const parts: string[] = [];
  if (row.pid != null && Number.isFinite(row.pid)) {
    parts.push(`PID ${Math.trunc(row.pid)}`);
  }
  const cls = (row.classification ?? "").trim();
  if (cls) parts.push(cls);
  const ver = (row.version ?? "").trim();
  if (ver) parts.push(`v${ver}`);
  const sock = (row.socketPath ?? "").trim();
  if (sock) parts.push(sock);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** Human-readable uptime from milliseconds. */
export function formatLeaderUptimeMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const DETAIL_LABELS: Record<string, string> = {
  pid: "PID",
  socketPath: "Socket",
  lockPath: "Lock",
  version: "Version",
  protocolVersion: "Protocol",
  classification: "Classification",
  uptime: "Uptime",
  activeToolCalls: "Active tools",
  wsUrlSuffix: "WS suffix",
};

/**
 * Flatten known leader-info fields into labeled rows for the details modal.
 * Prefer structured DTO fields; fall back to a short raw dump when empty.
 */
export function leaderInfoDetailRows(info: LeaderInfoLike | null | undefined): LeaderDetailRow[] {
  if (!info) return [];
  const rows: LeaderDetailRow[] = [];
  const push = (key: string, value: string | null | undefined) => {
    const v = (value ?? "").trim();
    if (!v) return;
    rows.push({ key, label: DETAIL_LABELS[key] ?? key, value: v });
  };

  if (info.pid != null && Number.isFinite(info.pid)) {
    push("pid", String(Math.trunc(info.pid)));
  }
  push("socketPath", info.socketPath ?? undefined);
  push("lockPath", info.lockPath ?? undefined);
  push("version", info.version ?? undefined);
  push("protocolVersion", info.protocolVersion ?? undefined);
  push("classification", info.classification ?? undefined);
  const up = formatLeaderUptimeMs(info.uptimeMs ?? null);
  if (up) push("uptime", up);
  if (info.activeToolCalls != null && Number.isFinite(info.activeToolCalls)) {
    push("activeToolCalls", String(Math.trunc(info.activeToolCalls)));
  }
  const suffix = (info.wsUrlSuffix ?? "").trim();
  if (suffix) push("wsUrlSuffix", suffix);

  if (rows.length === 0 && info.raw != null) {
    try {
      const pretty = JSON.stringify(info.raw, null, 2);
      if (pretty && pretty !== "{}" && pretty !== "null") {
        rows.push({ key: "raw", label: "Raw", value: pretty.slice(0, 4000) });
      }
    } catch {
      /* ignore */
    }
  }
  return rows;
}

/** Whether a list/status leaders array is non-empty. */
export function hasLeaderFleet(leaders: LeaderProcessLike[] | null | undefined): boolean {
  return Array.isArray(leaders) && leaders.length > 0;
}
