/**
 * Cost rollup — aggregate **known** token usage by project / day.
 *
 * Sources (honest, never invent):
 * - Live `session://usage` samples (client ring)
 * - Optional liveMap-adjacent usage map when callers pass it
 * - Session journal compact markers (`tokensAfter`) as last-known context
 *
 * Missing usage → explicit **unknown**, not $0.
 * Dollar figures use crude `estimateCostUsd` rates — **never invoice-grade**.
 */

import {
  estimateCostUsd,
  formatCostUsd,
  type CostEstimateResult,
} from "./estimateCost";

// ── Types ──────────────────────────────────────────────────────────────

/** Where a known usage figure came from. */
export type CostRollupSource =
  | "usage"
  | "journal_compact"
  | "live"
  | "unknown";

/**
 * One known usage observation for a session on a calendar day.
 * Prefer input+output when present; total alone is still known tokens.
 */
export type CostUsageSample = {
  sessionId: string;
  /** App project id; null = orphan / no project. */
  projectId: string | null;
  projectName?: string | null;
  /** YYYY-MM-DD (local or UTC — caller chooses consistently). */
  day: string;
  modelId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  source: CostRollupSource;
  /** ISO timestamp of observation. */
  at?: string;
};

export type CostRollupSessionMeta = {
  id: string;
  projectId?: string | null;
  title?: string | null;
  modelId?: string | null;
  /** ISO updated/created — used to place session on a day for unknown counts. */
  updatedAt?: string | null;
};

export type CostRollupProjectMeta = {
  id: string;
  name?: string | null;
};

export type CostRollupBucket = {
  projectId: string | null;
  projectName: string | null;
  day: string;
  /** Distinct sessions that contributed known token figures. */
  sessionsKnown: number;
  /**
   * Sessions on this project/day with no known sample.
   * Honest gap — do not treat as zero tokens.
   */
  sessionsUnknown: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Crude estimate only; null when rates/tokens insufficient. */
  estimatedUsd: number | null;
  /**
   * `estimate` — all known sessions had rates;
   * `partial` — some tokens known but rates or sessions missing;
   * `none` — no dollars.
   */
  precision: "estimate" | "partial" | "none";
  sampleCount: number;
};

export type CostRollupView = {
  buckets: CostRollupBucket[];
  /** Sum of known totals across buckets (null if nothing known). */
  totalTokensKnown: number | null;
  totalEstimatedUsd: number | null;
  sessionsKnown: number;
  sessionsUnknown: number;
  /** True when there is nothing known and nothing unknown to report. */
  empty: boolean;
  /** Always true in product copy — never invoice-grade. */
  invoiceGrade: false;
};

export type LiveUsageMap = Record<
  string,
  {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    modelId?: string | null;
    projectId?: string | null;
    projectName?: string | null;
    at?: string | number | null;
    source?: string | null;
  }
>;

// ── Storage ring (local only) ──────────────────────────────────────────

export const COST_USAGE_SAMPLES_STORAGE_KEY = "grok.costUsageSamples";
export const COST_USAGE_SAMPLES_MAX = 400;
/** Fired on `window` after record/clear (detail = samples). */
export const COST_USAGE_SAMPLES_CHANGE_EVENT = "grok-cost-usage-samples-change";

/** Minimal storage surface so unit tests need no jsdom. */
export interface CostUsageSamplesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultStorage(): CostUsageSamplesStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  return { getItem: () => null, setItem: () => {} };
}

function notifySamplesChange(samples: CostUsageSample[]): void {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    try {
      window.dispatchEvent(
        new CustomEvent(COST_USAGE_SAMPLES_CHANGE_EVENT, { detail: samples }),
      );
    } catch {
      /* ignore */
    }
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────

export function finiteTokenCount(
  n: number | null | undefined,
): number | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Calendar day key YYYY-MM-DD.
 * Uses local timezone when `utc` is false (default).
 */
export function dayKeyFromMs(
  ms: number,
  utc: boolean = false,
): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  if (utc) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dayKeyFromIso(
  iso: string | null | undefined,
  utc: boolean = false,
): string | null {
  if (iso == null || typeof iso !== "string") return null;
  const t = Date.parse(iso.trim());
  if (!Number.isFinite(t)) {
    // Already a day key?
    const m = iso.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1]! : null;
  }
  return dayKeyFromMs(t, utc);
}

/** Coarse token display (e.g. 12.3k). Returns "—" when unknown. */
export function formatRollupTokens(
  n: number | null | undefined,
): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.floor(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export { formatCostUsd };

/**
 * Normalize a usage event / map entry into a sample, or null when no usable tokens.
 * Does **not** invent zeros.
 */
export function sampleFromUsageEvent(opts: {
  sessionId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  modelId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  source?: CostRollupSource | string | null;
  at?: string | number | null;
  nowMs?: number;
  utc?: boolean;
}): CostUsageSample | null {
  const sessionId =
    typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
  if (!sessionId) return null;

  const inputTokens = finiteTokenCount(opts.inputTokens);
  const outputTokens = finiteTokenCount(opts.outputTokens);
  let totalTokens = finiteTokenCount(opts.totalTokens);
  if (totalTokens == null && inputTokens != null && outputTokens != null) {
    totalTokens = inputTokens + outputTokens;
  }
  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    return null;
  }

  const nowMs = opts.nowMs ?? Date.now();
  let atIso: string | undefined;
  if (typeof opts.at === "number" && Number.isFinite(opts.at)) {
    atIso = new Date(opts.at).toISOString();
  } else if (typeof opts.at === "string" && opts.at.trim()) {
    atIso = opts.at.trim();
  } else {
    atIso = new Date(nowMs).toISOString();
  }
  const day = dayKeyFromIso(atIso, opts.utc) ?? dayKeyFromMs(nowMs, opts.utc);
  if (!day) return null;

  const srcRaw =
    typeof opts.source === "string" ? opts.source.trim().toLowerCase() : "";
  let source: CostRollupSource = "usage";
  if (srcRaw === "journal_compact" || srcRaw === "compact") {
    source = "journal_compact";
  } else if (srcRaw === "live") {
    source = "live";
  } else if (srcRaw === "unknown") {
    source = "unknown";
  } else if (srcRaw === "usage" || !srcRaw) {
    source = "usage";
  } else {
    // ACP kind strings (turn_usage, context_usage, …) still count as live usage.
    source = "usage";
  }

  const projectId =
    opts.projectId == null || opts.projectId === ""
      ? null
      : String(opts.projectId);
  const projectName =
    opts.projectName == null || opts.projectName === ""
      ? null
      : String(opts.projectName);
  const modelId =
    opts.modelId == null || String(opts.modelId).trim() === ""
      ? null
      : String(opts.modelId).trim();

  return {
    sessionId,
    projectId,
    projectName,
    day,
    modelId,
    inputTokens,
    outputTokens,
    totalTokens,
    source,
    at: atIso,
  };
}

/**
 * Extract last-known usage from journal messages.
 * Uses context_compact `tokensAfter` only (honest snapshot — not cumulative spend).
 * Returns null when no known figure is present (never invents).
 */
export function extractKnownUsageFromJournalMessages(
  messages: ReadonlyArray<{
    id?: string;
    role?: string;
    content?: string;
    marker?: string | null;
    compactMeta?: {
      tokensBefore?: number;
      tokensAfter?: number;
      trigger?: string;
    } | null;
    createdAt?: string | null;
  }>,
  opts: {
    sessionId: string;
    projectId?: string | null;
    projectName?: string | null;
    modelId?: string | null;
    utc?: boolean;
  },
): CostUsageSample | null {
  if (!opts.sessionId || !messages?.length) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const isCompact =
      m.marker === "context_compact" ||
      (m.role === "tool" &&
        !!(
          m.compactMeta ||
          (typeof m.content === "string" &&
            m.content.startsWith("context_compact"))
        ));
    if (!isCompact) continue;
    const tokensAfter = finiteTokenCount(m.compactMeta?.tokensAfter);
    if (tokensAfter == null) continue;
    return sampleFromUsageEvent({
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      projectName: opts.projectName,
      modelId: opts.modelId,
      totalTokens: tokensAfter,
      source: "journal_compact",
      at: m.createdAt ?? undefined,
      utc: opts.utc,
    });
  }
  return null;
}

/** Convert a live usage map into samples (one per session with known tokens). */
export function samplesFromLiveUsageMap(
  map: LiveUsageMap | null | undefined,
  opts?: {
    sessionMeta?: ReadonlyArray<CostRollupSessionMeta>;
    projectMeta?: ReadonlyArray<CostRollupProjectMeta>;
    nowMs?: number;
    utc?: boolean;
  },
): CostUsageSample[] {
  if (!map) return [];
  const sessions = opts?.sessionMeta ?? [];
  const projects = opts?.projectMeta ?? [];
  const projectNameById = new Map(
    projects.map((p) => [p.id, (p.name || "").trim() || p.id]),
  );
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const out: CostUsageSample[] = [];
  for (const [sessionId, row] of Object.entries(map)) {
    if (!row) continue;
    const meta = sessionById.get(sessionId);
    const projectId =
      row.projectId !== undefined
        ? row.projectId
        : (meta?.projectId ?? null);
    const projectName =
      row.projectName ??
      (projectId ? projectNameById.get(projectId) ?? null : null);
    const sample = sampleFromUsageEvent({
      sessionId,
      projectId,
      projectName,
      modelId: row.modelId ?? meta?.modelId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      source: row.source === "live" ? "live" : "usage",
      at: row.at ?? opts?.nowMs,
      nowMs: opts?.nowMs,
      utc: opts?.utc,
    });
    if (sample) out.push(sample);
  }
  return out;
}

/**
 * Keep one sample per session+day: prefer richer I/O split, then newer `at`.
 * Used when merging ring + live + journal extracts.
 */
export function dedupeUsageSamples(
  samples: readonly CostUsageSample[],
): CostUsageSample[] {
  const best = new Map<string, CostUsageSample>();
  for (const s of samples) {
    if (!s?.sessionId || !s.day) continue;
    const key = `${s.sessionId}\0${s.day}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, s);
      continue;
    }
    const score = (x: CostUsageSample) => {
      let n = 0;
      if (finiteTokenCount(x.inputTokens) != null) n += 2;
      if (finiteTokenCount(x.outputTokens) != null) n += 2;
      if (finiteTokenCount(x.totalTokens) != null) n += 1;
      // Prefer live usage over compact snapshot.
      if (x.source === "usage" || x.source === "live") n += 3;
      if (x.source === "journal_compact") n += 1;
      return n;
    };
    const sa = score(s);
    const sb = score(prev);
    if (sa > sb) {
      best.set(key, s);
      continue;
    }
    if (sa < sb) continue;
    const ta = s.at ? Date.parse(s.at) : 0;
    const tb = prev.at ? Date.parse(prev.at) : 0;
    if (ta >= tb) best.set(key, s);
  }
  return [...best.values()];
}

function addNullable(
  a: number | null,
  b: number | null,
): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function estimateSampleUsd(sample: CostUsageSample): CostEstimateResult {
  return estimateCostUsd(
    {
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      totalTokens: sample.totalTokens,
    },
    sample.modelId,
  );
}

/**
 * Aggregate known samples by project × day.
 * Optional `sessions` list marks sessions without samples as **unknown**.
 */
export function aggregateCostRollup(opts: {
  samples: readonly CostUsageSample[];
  sessions?: readonly CostRollupSessionMeta[];
  projects?: readonly CostRollupProjectMeta[];
  /** Only include days on/after this YYYY-MM-DD (inclusive). */
  sinceDay?: string | null;
  /** Cap number of buckets returned (newest days first). */
  maxBuckets?: number;
  utc?: boolean;
}): CostRollupView {
  const projects = opts.projects ?? [];
  const projectNameById = new Map(
    projects.map((p) => [p.id, (p.name || "").trim() || p.id]),
  );

  const samples = dedupeUsageSamples(opts.samples).filter((s) => {
    if (!opts.sinceDay) return true;
    return s.day >= opts.sinceDay;
  });

  type Acc = {
    projectId: string | null;
    projectName: string | null;
    day: string;
    sessionIds: Set<string>;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    estimatedUsd: number | null;
    rateKnown: number;
    rateMissing: number;
    sampleCount: number;
  };

  const bucketKey = (projectId: string | null, day: string) =>
    `${projectId ?? ""}\0${day}`;
  const buckets = new Map<string, Acc>();

  for (const s of samples) {
    const key = bucketKey(s.projectId, s.day);
    let acc = buckets.get(key);
    if (!acc) {
      acc = {
        projectId: s.projectId,
        projectName:
          s.projectName ??
          (s.projectId ? projectNameById.get(s.projectId) ?? null : null),
        day: s.day,
        sessionIds: new Set(),
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedUsd: null,
        rateKnown: 0,
        rateMissing: 0,
        sampleCount: 0,
      };
      buckets.set(key, acc);
    }
    if (
      !acc.projectName &&
      s.projectId &&
      projectNameById.has(s.projectId)
    ) {
      acc.projectName = projectNameById.get(s.projectId)!;
    }
    acc.sessionIds.add(s.sessionId);
    acc.sampleCount += 1;
    acc.inputTokens = addNullable(
      acc.inputTokens,
      finiteTokenCount(s.inputTokens),
    );
    acc.outputTokens = addNullable(
      acc.outputTokens,
      finiteTokenCount(s.outputTokens),
    );
    const tot =
      finiteTokenCount(s.totalTokens) ??
      (finiteTokenCount(s.inputTokens) != null &&
      finiteTokenCount(s.outputTokens) != null
        ? (s.inputTokens as number) + (s.outputTokens as number)
        : null);
    acc.totalTokens = addNullable(acc.totalTokens, tot);

    const est = estimateSampleUsd(s);
    if (est.totalUsd != null) {
      acc.estimatedUsd = (acc.estimatedUsd ?? 0) + est.totalUsd;
      acc.rateKnown += 1;
    } else if (tot != null || s.inputTokens != null || s.outputTokens != null) {
      acc.rateMissing += 1;
    }
  }

  // Unknown sessions: present on meta for a day but no known sample that day.
  const knownSessionDays = new Set(
    samples.map((s) => `${s.sessionId}\0${s.day}`),
  );
  const unknownByBucket = new Map<string, Set<string>>();

  for (const sess of opts.sessions ?? []) {
    if (!sess?.id) continue;
    const day =
      dayKeyFromIso(sess.updatedAt, opts.utc) ??
      null;
    if (!day) continue;
    if (opts.sinceDay && day < opts.sinceDay) continue;
    if (knownSessionDays.has(`${sess.id}\0${day}`)) continue;
    const projectId =
      sess.projectId == null || sess.projectId === ""
        ? null
        : String(sess.projectId);
    const key = bucketKey(projectId, day);
    let set = unknownByBucket.get(key);
    if (!set) {
      set = new Set();
      unknownByBucket.set(key, set);
    }
    set.add(sess.id);
    // Ensure bucket exists for pure-unknown project/days.
    if (!buckets.has(key)) {
      buckets.set(key, {
        projectId,
        projectName: projectId
          ? projectNameById.get(projectId) ?? null
          : null,
        day,
        sessionIds: new Set(),
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedUsd: null,
        rateKnown: 0,
        rateMissing: 0,
        sampleCount: 0,
      });
    }
  }

  let list: CostRollupBucket[] = [...buckets.values()].map((acc) => {
    const unk =
      unknownByBucket.get(bucketKey(acc.projectId, acc.day))?.size ?? 0;
    // precision describes **dollar** quality only (tokens may still be known).
    let precision: CostRollupBucket["precision"] = "none";
    if (acc.estimatedUsd != null) {
      precision =
        acc.rateMissing > 0 || unk > 0 || acc.rateKnown < acc.sampleCount
          ? "partial"
          : "estimate";
    } else if (unk > 0 && acc.totalTokens != null) {
      // Tokens known for some sessions, unknown for others — still no $ figure.
      precision = "partial";
    }
    return {
      projectId: acc.projectId,
      projectName: acc.projectName,
      day: acc.day,
      sessionsKnown: acc.sessionIds.size,
      sessionsUnknown: unk,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      totalTokens: acc.totalTokens,
      estimatedUsd: acc.estimatedUsd,
      precision,
      sampleCount: acc.sampleCount,
    };
  });

  // Newest day first, then project name.
  list.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? 1 : -1;
    const an = a.projectName || a.projectId || "";
    const bn = b.projectName || b.projectId || "";
    return an.localeCompare(bn);
  });

  const max = opts.maxBuckets;
  if (max != null && Number.isFinite(max) && max >= 0) {
    list = list.slice(0, Math.floor(max));
  }

  let totalTokensKnown: number | null = null;
  let totalEstimatedUsd: number | null = null;
  let sessionsKnown = 0;
  let sessionsUnknown = 0;
  for (const b of list) {
    totalTokensKnown = addNullable(totalTokensKnown, b.totalTokens);
    totalEstimatedUsd = addNullable(totalEstimatedUsd, b.estimatedUsd);
    sessionsKnown += b.sessionsKnown;
    sessionsUnknown += b.sessionsUnknown;
  }

  const empty =
    list.length === 0 ||
    (sessionsKnown === 0 &&
      sessionsUnknown === 0 &&
      totalTokensKnown == null);

  return {
    buckets: list,
    totalTokensKnown,
    totalEstimatedUsd,
    sessionsKnown,
    sessionsUnknown,
    empty,
    invoiceGrade: false,
  };
}

/**
 * Build a full view from ring samples + optional live map + journal samples.
 */
export function buildCostRollupView(opts: {
  samples?: readonly CostUsageSample[];
  liveMap?: LiveUsageMap | null;
  journalSamples?: readonly CostUsageSample[];
  sessions?: readonly CostRollupSessionMeta[];
  projects?: readonly CostRollupProjectMeta[];
  sinceDay?: string | null;
  maxBuckets?: number;
  nowMs?: number;
  utc?: boolean;
}): CostRollupView {
  const fromLive = samplesFromLiveUsageMap(opts.liveMap, {
    sessionMeta: opts.sessions,
    projectMeta: opts.projects,
    nowMs: opts.nowMs,
    utc: opts.utc,
  });
  const merged = dedupeUsageSamples([
    ...(opts.samples ?? []),
    ...fromLive,
    ...(opts.journalSamples ?? []),
  ]);
  return aggregateCostRollup({
    samples: merged,
    sessions: opts.sessions,
    projects: opts.projects,
    sinceDay: opts.sinceDay,
    maxBuckets: opts.maxBuckets,
    utc: opts.utc,
  });
}

/** Day key N calendar days ago from `nowMs` (inclusive window start). */
export function sinceDayDaysAgo(
  days: number,
  nowMs: number = Date.now(),
  utc: boolean = false,
): string {
  const n = Math.max(0, Math.floor(days));
  const d = new Date(nowMs);
  if (utc) {
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - (n > 0 ? n - 1 : 0));
  } else {
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (n > 0 ? n - 1 : 0));
  }
  return dayKeyFromMs(d.getTime(), utc) ?? "1970-01-01";
}

// ── Parse / load / save ring ───────────────────────────────────────────

export function parseCostUsageSample(raw: unknown): CostUsageSample | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return sampleFromUsageEvent({
    sessionId: typeof o.sessionId === "string" ? o.sessionId : null,
    projectId:
      o.projectId == null
        ? null
        : typeof o.projectId === "string"
          ? o.projectId
          : null,
    projectName:
      typeof o.projectName === "string" ? o.projectName : null,
    modelId: typeof o.modelId === "string" ? o.modelId : null,
    inputTokens:
      typeof o.inputTokens === "number" ? o.inputTokens : null,
    outputTokens:
      typeof o.outputTokens === "number" ? o.outputTokens : null,
    totalTokens:
      typeof o.totalTokens === "number" ? o.totalTokens : null,
    source: typeof o.source === "string" ? o.source : "usage",
    at: typeof o.at === "string" ? o.at : undefined,
  });
}

export function loadCostUsageSamples(
  storage: CostUsageSamplesStorage = defaultStorage(),
): CostUsageSample[] {
  try {
    const raw = storage.getItem(COST_USAGE_SAMPLES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CostUsageSample[] = [];
    for (const item of parsed) {
      const s = parseCostUsageSample(item);
      if (s) out.push(s);
    }
    return dedupeUsageSamples(out).slice(0, COST_USAGE_SAMPLES_MAX);
  } catch {
    return [];
  }
}

export function saveCostUsageSamples(
  samples: readonly CostUsageSample[],
  storage: CostUsageSamplesStorage = defaultStorage(),
): void {
  const deduped = dedupeUsageSamples(samples)
    .sort((a, b) => {
      const ta = a.at ? Date.parse(a.at) : 0;
      const tb = b.at ? Date.parse(b.at) : 0;
      return tb - ta;
    })
    .slice(0, COST_USAGE_SAMPLES_MAX);
  try {
    storage.setItem(
      COST_USAGE_SAMPLES_STORAGE_KEY,
      JSON.stringify(deduped),
    );
  } catch {
    /* private mode / quota */
  }
  notifySamplesChange(deduped);
}

/**
 * Upsert one sample into the ring (session+day dedupe). Returns new list.
 */
export function recordCostUsageSample(
  sample: CostUsageSample | null | undefined,
  storage: CostUsageSamplesStorage = defaultStorage(),
): CostUsageSample[] {
  if (!sample) return loadCostUsageSamples(storage);
  const prev = loadCostUsageSamples(storage);
  const next = dedupeUsageSamples([sample, ...prev]);
  saveCostUsageSamples(next, storage);
  return next;
}

export function clearCostUsageSamples(
  storage: CostUsageSamplesStorage = defaultStorage(),
): void {
  try {
    storage.setItem(COST_USAGE_SAMPLES_STORAGE_KEY, "[]");
  } catch {
    /* ignore */
  }
  notifySamplesChange([]);
}
