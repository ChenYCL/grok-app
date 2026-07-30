/**
 * Reliability / Observability center — pure assembly of long-task signals.
 *
 * Aggregates busy sessions, stall / end-of-turn stall signals, and recent
 * error-deck entries from App/host state. No log scraping, no secrets.
 */

import {
  collectActivitySessions,
  type ActivitySessionRow,
  type SessionTitleLookup,
} from "./agentActivity";
import type { EndOfTurnReason } from "./endOfTurn";
import type { SessionLiveMap } from "./sessionLiveStore";

export type ReliabilityBusySession = {
  sessionId: string;
  title: string;
  status: ActivitySessionRow["status"];
  liveToolTitle: string | null;
  isCurrent: boolean;
  updatedAt: number;
};

/** Soft / hard stall or end-of-turn stall observed in UI state. */
export type ReliabilityStallKind =
  | "active"
  | "hard_end"
  | "terminal"
  | "end_of_turn";

export type ReliabilityStallSignal = {
  id: string;
  sessionId: string | null;
  title: string | null;
  kind: ReliabilityStallKind;
  stallSeconds: number | null;
  tier: string | null;
  /** Host/end-of-turn reason when known (e.g. stall). */
  reason: string | null;
  at: number;
};

export type ReliabilityErrorEntry = {
  id: string;
  code: string | null;
  /** Deck problem headline (already localized by caller when from deck). */
  problem: string;
  cause: string | null;
  sessionId: string | null;
  title: string | null;
  at: number;
  source: "session" | "local" | "deck";
};

export type ReliabilityCenterView = {
  busy: {
    count: number;
    sessions: ReliabilityBusySession[];
  };
  stalls: {
    count: number;
    signals: ReliabilityStallSignal[];
  };
  errors: {
    count: number;
    entries: ReliabilityErrorEntry[];
  };
  /** True when every card would be empty. */
  empty: boolean;
  hasBusy: boolean;
  hasStalls: boolean;
  hasErrors: boolean;
};

export const DEFAULT_RELIABILITY_MAX_BUSY = 12;
export const DEFAULT_RELIABILITY_MAX_STALLS = 8;
export const DEFAULT_RELIABILITY_MAX_ERRORS = 8;

/** Prepend an item into a capped ring (newest first). Drops exact id matches. */
export function prependReliabilityRing<T extends { id: string }>(
  list: readonly T[],
  item: T,
  max: number,
): T[] {
  const cap = Math.max(0, Math.floor(max));
  if (cap === 0) return [];
  const rest = list.filter((x) => x.id !== item.id);
  return [item, ...rest].slice(0, cap);
}

function busyFromActivity(row: ActivitySessionRow): ReliabilityBusySession {
  return {
    sessionId: row.sessionId,
    title: row.title,
    status: row.status,
    liveToolTitle: row.liveToolTitle,
    isCurrent: row.isCurrent,
    updatedAt: row.updatedAt,
  };
}

/**
 * Collect busy / connecting / permission sessions for the Reliability panel.
 * Reuses Tasks-panel activity rules.
 */
export function collectReliabilityBusySessions(opts: {
  liveMap: SessionLiveMap;
  sessions: SessionTitleLookup[];
  currentSessionId?: string | null;
  untitledLabel?: string;
  max?: number;
}): ReliabilityBusySession[] {
  const max = opts.max ?? DEFAULT_RELIABILITY_MAX_BUSY;
  return collectActivitySessions({
    liveMap: opts.liveMap,
    sessions: opts.sessions,
    currentSessionId: opts.currentSessionId,
    untitledLabel: opts.untitledLabel,
  })
    .map(busyFromActivity)
    .slice(0, Math.max(0, max));
}

function titleFor(
  sessionId: string | null | undefined,
  titleById: Map<string, string>,
  untitled: string,
): string | null {
  if (!sessionId) return null;
  return titleById.get(sessionId) || untitled;
}

/**
 * Stall signals currently visible in liveMap (terminalReason) plus optional
 * active soft-stall prompt. Does not invent history.
 */
export function collectLiveStallSignals(opts: {
  liveMap: SessionLiveMap;
  sessions: SessionTitleLookup[];
  untitledLabel?: string;
  activeStreamStall?: {
    sessionId?: string;
    stallSeconds: number;
    tier?: string;
    sawModelOutput?: boolean;
    sawToolActivity?: boolean;
  } | null;
  nowMs?: number;
}): ReliabilityStallSignal[] {
  const now = opts.nowMs ?? Date.now();
  const untitled = opts.untitledLabel || "Untitled";
  const titleById = new Map<string, string>();
  for (const s of opts.sessions) {
    const t = (s.title || "").trim();
    if (t) titleById.set(s.id, t);
  }

  const out: ReliabilityStallSignal[] = [];
  const seen = new Set<string>();

  const active = opts.activeStreamStall;
  if (active && active.stallSeconds > 0) {
    const sid = active.sessionId ?? null;
    const id = `active:${sid ?? "unknown"}:${active.stallSeconds}`;
    seen.add(id);
    out.push({
      id,
      sessionId: sid,
      title: titleFor(sid, titleById, untitled),
      kind: "active",
      stallSeconds: Math.round(active.stallSeconds),
      tier: active.tier ?? null,
      reason: "stall",
      at: now,
    });
  }

  for (const snap of Object.values(opts.liveMap)) {
    const reason = snap.terminalReason;
    if (!isStallTerminalReason(reason)) continue;
    const id = `terminal:${snap.sessionId}:${reason}:${snap.updatedAt}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      sessionId: snap.sessionId,
      title: titleFor(snap.sessionId, titleById, untitled),
      kind: "terminal",
      stallSeconds: null,
      tier: null,
      reason,
      at: snap.updatedAt || now,
    });
  }

  out.sort((a, b) => b.at - a.at);
  return out;
}

function isStallTerminalReason(
  reason: EndOfTurnReason | null | undefined,
): reason is "stall" {
  return reason === "stall";
}

/**
 * Merge live stall signals with a recent ring (hard_end / prior active).
 * Live wins order first; ring fills remaining slots without id duplicates.
 */
export function mergeStallSignals(
  live: readonly ReliabilityStallSignal[],
  recent: readonly ReliabilityStallSignal[],
  max: number = DEFAULT_RELIABILITY_MAX_STALLS,
): ReliabilityStallSignal[] {
  const cap = Math.max(0, Math.floor(max));
  if (cap === 0) return [];
  const out: ReliabilityStallSignal[] = [];
  const seen = new Set<string>();
  // Soft-dedupe: same session + kind within a short window counts once.
  const softKey = (s: ReliabilityStallSignal) =>
    `${s.kind}|${s.sessionId ?? ""}|${s.reason ?? ""}`;

  for (const s of [...live, ...recent]) {
    if (seen.has(s.id)) continue;
    // Prefer keeping the first (live-first) soft match.
    const sk = softKey(s);
    if ([...out].some((x) => softKey(x) === sk && x.kind === s.kind)) {
      // Allow multiple hard_end over time; skip only identical soft active/terminal dupes.
      if (s.kind === "active" || s.kind === "terminal") continue;
    }
    seen.add(s.id);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Merge current banner-shaped error with a recent ring.
 * Newest first; drop exact id matches; soft-dedupe same code+problem.
 */
export function mergeErrorEntries(
  current: readonly ReliabilityErrorEntry[],
  recent: readonly ReliabilityErrorEntry[],
  max: number = DEFAULT_RELIABILITY_MAX_ERRORS,
): ReliabilityErrorEntry[] {
  const cap = Math.max(0, Math.floor(max));
  if (cap === 0) return [];
  const out: ReliabilityErrorEntry[] = [];
  const seenIds = new Set<string>();
  const soft = new Set<string>();

  for (const e of [...current, ...recent]) {
    if (seenIds.has(e.id)) continue;
    const sk = `${e.code ?? ""}|${e.problem}`;
    if (soft.has(sk)) continue;
    seenIds.add(e.id);
    soft.add(sk);
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

/** Build a ring-friendly error entry from a deck-style banner. */
export function reliabilityErrorFromDeck(opts: {
  code?: string | null;
  problem: string;
  cause?: string | null;
  sessionId?: string | null;
  title?: string | null;
  source?: ReliabilityErrorEntry["source"];
  at?: number;
  /** Stable id for ring replace; default is code+problem (no timestamp). */
  id?: string;
}): ReliabilityErrorEntry {
  const at = opts.at ?? Date.now();
  const code = opts.code ?? null;
  const problem = (opts.problem || "").trim() || "Error";
  return {
    id:
      opts.id ??
      `err:${code ?? "generic"}:${problem.slice(0, 64)}`,
    code,
    problem,
    cause: opts.cause?.trim() || null,
    sessionId: opts.sessionId ?? null,
    title: opts.title ?? null,
    at,
    source: opts.source ?? "deck",
  };
}

/** Build a ring entry when Host emits stream_stall / hard_end. */
export function reliabilityStallFromEvent(opts: {
  kind: ReliabilityStallKind;
  sessionId?: string | null;
  title?: string | null;
  stallSeconds?: number | null;
  tier?: string | null;
  reason?: string | null;
  at?: number;
}): ReliabilityStallSignal {
  const at = opts.at ?? Date.now();
  const sid = opts.sessionId ?? null;
  return {
    id: `evt:${opts.kind}:${sid ?? "unknown"}:${at}`,
    sessionId: sid,
    title: opts.title ?? null,
    kind: opts.kind,
    stallSeconds:
      typeof opts.stallSeconds === "number" && opts.stallSeconds > 0
        ? Math.round(opts.stallSeconds)
        : null,
    tier: opts.tier ?? null,
    reason: opts.reason ?? "stall",
    at,
  };
}

/**
 * Assemble the Reliability center view model from already-shaped inputs.
 * Callers supply busy/stall/error lists (live + rings); this only slices and flags.
 */
export function assembleReliabilityCenter(opts: {
  busySessions?: readonly ReliabilityBusySession[];
  stallSignals?: readonly ReliabilityStallSignal[];
  errorEntries?: readonly ReliabilityErrorEntry[];
  maxBusy?: number;
  maxStalls?: number;
  maxErrors?: number;
}): ReliabilityCenterView {
  const maxBusy = opts.maxBusy ?? DEFAULT_RELIABILITY_MAX_BUSY;
  const maxStalls = opts.maxStalls ?? DEFAULT_RELIABILITY_MAX_STALLS;
  const maxErrors = opts.maxErrors ?? DEFAULT_RELIABILITY_MAX_ERRORS;

  const sessions = (opts.busySessions ?? []).slice(0, Math.max(0, maxBusy));
  const signals = (opts.stallSignals ?? []).slice(0, Math.max(0, maxStalls));
  const entries = (opts.errorEntries ?? []).slice(0, Math.max(0, maxErrors));

  const hasBusy = sessions.length > 0;
  const hasStalls = signals.length > 0;
  const hasErrors = entries.length > 0;

  return {
    busy: { count: sessions.length, sessions: [...sessions] },
    stalls: { count: signals.length, signals: [...signals] },
    errors: { count: entries.length, entries: [...entries] },
    empty: !hasBusy && !hasStalls && !hasErrors,
    hasBusy,
    hasStalls,
    hasErrors,
  };
}

/**
 * One-shot assembly from liveMap + rings + optional active stall / current error.
 * Preferred entry for App and unit tests that want full pipeline coverage.
 */
export function buildReliabilityCenter(opts: {
  liveMap: SessionLiveMap;
  sessions: SessionTitleLookup[];
  currentSessionId?: string | null;
  untitledLabel?: string;
  activeStreamStall?: {
    sessionId?: string;
    stallSeconds: number;
    tier?: string;
    sawModelOutput?: boolean;
    sawToolActivity?: boolean;
  } | null;
  recentStalls?: readonly ReliabilityStallSignal[];
  recentErrors?: readonly ReliabilityErrorEntry[];
  currentErrors?: readonly ReliabilityErrorEntry[];
  maxBusy?: number;
  maxStalls?: number;
  maxErrors?: number;
  nowMs?: number;
}): ReliabilityCenterView {
  const busySessions = collectReliabilityBusySessions({
    liveMap: opts.liveMap,
    sessions: opts.sessions,
    currentSessionId: opts.currentSessionId,
    untitledLabel: opts.untitledLabel,
    max: opts.maxBusy,
  });

  const liveStalls = collectLiveStallSignals({
    liveMap: opts.liveMap,
    sessions: opts.sessions,
    untitledLabel: opts.untitledLabel,
    activeStreamStall: opts.activeStreamStall,
    nowMs: opts.nowMs,
  });

  const stallSignals = mergeStallSignals(
    liveStalls,
    opts.recentStalls ?? [],
    opts.maxStalls ?? DEFAULT_RELIABILITY_MAX_STALLS,
  );

  const errorEntries = mergeErrorEntries(
    opts.currentErrors ?? [],
    opts.recentErrors ?? [],
    opts.maxErrors ?? DEFAULT_RELIABILITY_MAX_ERRORS,
  );

  return assembleReliabilityCenter({
    busySessions,
    stallSignals,
    errorEntries,
    maxBusy: opts.maxBusy,
    maxStalls: opts.maxStalls,
    maxErrors: opts.maxErrors,
  });
}

/** Cap for support-bundle stall timeline rows (UI view is smaller; allow a bit more headroom). */
export const STALL_TIMELINE_SNAPSHOT_MAX = 40;
/** Cap title/reason fields so the zip never carries multi-kb blobs. */
export const STALL_TIMELINE_FIELD_MAX = 200;

/** One row in the support-bundle stall timeline (known fields only). */
export type StallTimelineSnapshotSignal = {
  id: string;
  sessionId: string | null;
  title: string | null;
  kind: ReliabilityStallKind;
  stallSeconds: number | null;
  tier: string | null;
  reason: string | null;
  at: number;
};

/**
 * Redacted stall timeline for support zip export.
 * Never includes secrets, log bodies, or free-form diagnostic dumps —
 * only structured stall fields already shown in Reliability center.
 */
export type StallTimelineSnapshot = {
  kind: "stall_timeline";
  generatedAt: string;
  source: "reliability_center";
  count: number;
  signals: StallTimelineSnapshotSignal[];
};

const STALL_TIMELINE_KINDS = new Set<ReliabilityStallKind>([
  "active",
  "hard_end",
  "terminal",
  "end_of_turn",
]);

function capStallField(raw: unknown, max: number = STALL_TIMELINE_FIELD_MAX): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\u0000/g, "").trim();
  if (!t) return null;
  return t.slice(0, Math.max(0, max));
}

/**
 * Build a support-bundle-ready stall timeline from Reliability center signals.
 * Drops unknown kinds / empty ids; caps title/reason/tier; never invents data.
 */
export function buildStallTimelineSnapshot(
  signals: readonly ReliabilityStallSignal[],
  opts?: {
    nowMs?: number;
    max?: number;
    generatedAt?: string;
  },
): StallTimelineSnapshot {
  const max = Math.max(
    0,
    Math.floor(opts?.max ?? STALL_TIMELINE_SNAPSHOT_MAX),
  );
  const generatedAt =
    opts?.generatedAt ??
    new Date(opts?.nowMs ?? Date.now()).toISOString();

  const out: StallTimelineSnapshotSignal[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    if (!s || typeof s !== "object") continue;
    const kind = s.kind;
    if (!STALL_TIMELINE_KINDS.has(kind)) continue;
    const id = typeof s.id === "string" ? s.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const sidRaw = s.sessionId;
    const sessionId =
      typeof sidRaw === "string"
        ? sidRaw.trim() || null
        : sidRaw == null
          ? null
          : null;

    let stallSeconds: number | null = null;
    if (typeof s.stallSeconds === "number" && Number.isFinite(s.stallSeconds)) {
      const n = Math.round(s.stallSeconds);
      if (n > 0) stallSeconds = n;
    }

    const at =
      typeof s.at === "number" && Number.isFinite(s.at) && s.at >= 0
        ? Math.floor(s.at)
        : 0;

    out.push({
      id: id.slice(0, STALL_TIMELINE_FIELD_MAX),
      sessionId,
      title: capStallField(s.title),
      kind,
      stallSeconds,
      tier: capStallField(s.tier, 64),
      reason: capStallField(s.reason, 120) ?? "stall",
      at,
    });
    if (out.length >= max) break;
  }

  return {
    kind: "stall_timeline",
    generatedAt,
    source: "reliability_center",
    count: out.length,
    signals: out,
  };
}

/** JSON string for Host `export_support_bundle` (pretty, known fields only). */
export function serializeStallTimelineSnapshot(
  snapshot: StallTimelineSnapshot,
): string {
  return JSON.stringify(snapshot, null, 2);
}
