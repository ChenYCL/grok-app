/**
 * Smart share-card summary + universal visual system (offline).
 *
 * No domain keyword maps (fitness/tech/…). Style is derived from content
 * *structure* + a stable content hash so every conversation gets a unique but
 * deterministic palette. Summary text is condensed from headings / lists /
 * emphasis / closing lines — topic-agnostic.
 */

import type { ShareCardMessage } from "@/lib/sessionExportImage";

/** Structural layout modes — not topic labels. */
export type ShareCardLayoutMode = "editorial" | "stack" | "compact";

export type ShareCardTheme = {
  /** Stable seed 0..1 from content hash (for debugging / chip). */
  seed: number;
  /** Accent hue in degrees 0..360. */
  hue: number;
  layout: ShareCardLayoutMode;
  bg0: string;
  bg1: string;
  accent: string;
  accentSoft: string;
  text: string;
  muted: string;
  card: string;
  bullet: string;
  badge: string;
  orbA: string;
  orbB: string;
  /** Short machine id for badge, e.g. "H172" or "LIST". */
  badgeText: string;
};

export type SmartShareSummary = {
  theme: ShareCardTheme;
  headline: string;
  subtitle: string | null;
  bullets: string[];
  takeaway: string | null;
  sourceMessageCount: number;
};

const MAX_BULLETS = 8;
const MAX_BULLET_CHARS = 96;
const MAX_HEADLINE = 48;
const MAX_TAKEAWAY = 120;

export function stripMarkdownLite(s: string): string {
  return (s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\|/g, " ")
    .replace(/[-]{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** FNV-1a 32-bit → [0, 1). Stable across runs. */
export function contentSeed(text: string): number {
  let h = 0x811c9dc5;
  const s = text || "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function hsl(h: number, s: number, l: number, a = 1): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp01(s) * 100;
  const ll = clamp01(l) * 100;
  if (a >= 1) return `hsl(${hh.toFixed(1)} ${ss.toFixed(1)}% ${ll.toFixed(1)}%)`;
  return `hsl(${hh.toFixed(1)} ${ss.toFixed(1)}% ${ll.toFixed(1)}% / ${clamp01(a).toFixed(3)})`;
}

export type ContentStructure = {
  lines: number;
  listRatio: number;
  headingRatio: number;
  codeRatio: number;
  cjkRatio: number;
  questionRatio: number;
  avgLineLen: number;
  energy: number;
};

/** Topic-agnostic structural signals from raw markdown/text. */
export function analyzeContentStructure(text: string): ContentStructure {
  const sample = (text || "").slice(0, 16_000);
  const lines = sample.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const n = Math.max(1, nonEmpty.length);

  let list = 0;
  let heading = 0;
  let codeLines = 0;
  let inFence = false;
  let q = 0;
  let lenSum = 0;
  let bang = 0;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    lenSum += t.length;
    if (t.startsWith("```")) {
      inFence = !inFence;
      codeLines += 1;
      continue;
    }
    if (inFence) {
      codeLines += 1;
      continue;
    }
    if (/^#{1,6}\s+\S/.test(t)) heading += 1;
    if (/^([-*+]|\d+\.)\s+\S/.test(t)) list += 1;
    if (/[?？]/.test(t)) q += 1;
    if (/[!！]/.test(t)) bang += 1;
  }

  let cjk = 0;
  let letters = 0;
  for (const ch of sample) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
    else if (/[A-Za-z0-9]/.test(ch)) letters += 1;
  }
  const alpha = Math.max(1, cjk + letters);

  const listRatio = list / n;
  const headingRatio = heading / n;
  const codeRatio = codeLines / Math.max(1, lines.length);
  const cjkRatio = cjk / alpha;
  const questionRatio = q / n;
  const avgLineLen = lenSum / n;
  // Energy: questions + bangs + short punchy lines
  const shortLines = nonEmpty.filter((l) => l.trim().length < 40).length / n;
  const energy = clamp01(questionRatio * 1.2 + bang / n + shortLines * 0.35);

  return {
    lines: n,
    listRatio: clamp01(listRatio),
    headingRatio: clamp01(headingRatio),
    codeRatio: clamp01(codeRatio),
    cjkRatio: clamp01(cjkRatio),
    questionRatio: clamp01(questionRatio),
    avgLineLen,
    energy,
  };
}

function pickLayout(st: ContentStructure, bulletCount: number): ShareCardLayoutMode {
  if (st.codeRatio > 0.18 || st.avgLineLen > 90) return "compact";
  if (st.listRatio > 0.28 || bulletCount >= 5) return "stack";
  if (st.headingRatio > 0.12 || st.lines > 40) return "editorial";
  return bulletCount >= 3 ? "stack" : "editorial";
}

/**
 * Build a universal palette from structure + seed.
 * Hue comes from content hash (unique per chat); sat/light from structure.
 */
export function buildThemeFromContent(
  title: string,
  corpus: string,
  bulletCount = 0,
): ShareCardTheme {
  const seed = contentSeed(`${title}\n${corpus.slice(0, 2000)}`);
  const st = analyzeContentStructure(`${title}\n${corpus}`);

  // Base hue from seed; slight structure nudges (not domain keywords).
  let hue = seed * 360;
  // Code-heavy → cooler band bias; high energy → warmer shift
  hue = (hue + st.codeRatio * 40 - st.energy * 25 + st.cjkRatio * 12) % 360;
  if (hue < 0) hue += 360;

  // Saturation: calmer for code, punchier for lists/energy
  const sat =
    0.42 +
    st.listRatio * 0.18 +
    st.energy * 0.2 -
    st.codeRatio * 0.22 +
    (1 - st.cjkRatio) * 0.04;
  const satClamped = clamp01(Math.max(0.28, Math.min(0.72, sat)));

  // Dark poster base
  const bg0 = hsl(hue, satClamped * 0.35, 0.07);
  const bg1 = hsl((hue + 28) % 360, satClamped * 0.28, 0.11);
  const accent = hsl(hue, Math.min(0.85, satClamped + 0.25), 0.62);
  const accentSoft = hsl(hue, satClamped, 0.5, 0.16);
  const text = hsl(hue, 0.12, 0.96);
  const muted = hsl(hue, satClamped * 0.35, 0.72);
  const card = hsl(hue, satClamped * 0.4, 0.18, 0.45);
  const bullet = hsl(hue, Math.min(0.9, satClamped + 0.2), 0.7);
  const badge = hsl(hue, satClamped + 0.1, 0.48);
  const orbA = hsl(hue, satClamped, 0.5, 0.32);
  const orbB = hsl((hue + 48) % 360, satClamped * 0.8, 0.45, 0.22);

  const layout = pickLayout(st, bulletCount);
  const layoutTag =
    layout === "stack" ? "LIST" : layout === "compact" ? "DENSE" : "EDIT";
  const badgeText = `${layoutTag}·${Math.round(hue)}`;

  return {
    seed,
    hue,
    layout,
    bg0,
    bg1,
    accent,
    accentSoft,
    text,
    muted,
    card,
    bullet,
    badge,
    orbA,
    orbB,
    badgeText,
  };
}

/** @deprecated Use buildThemeFromContent — kept as thin alias for callers. */
export function pickShareCardTheme(text: string): ShareCardTheme {
  return buildThemeFromContent("", text, 0);
}

function extractHeadings(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m?.[1]) out.push(stripMarkdownLite(m[1]));
  }
  return out.filter(Boolean);
}

function extractListItems(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
    if (m?.[1]) {
      const cleaned = stripMarkdownLite(m[1]);
      if (cleaned.length >= 4) out.push(cleaned);
    }
  }
  return out;
}

function extractBoldPhrases(text: string): string[] {
  const out: string[] = [];
  const re = /\*\*([^*]{2,80})\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = stripMarkdownLite(m[1]);
    if (t.length >= 4) out.push(t);
  }
  return out;
}

function extractTakeaway(text: string): string | null {
  const lines = text.split("\n");
  // Prefer lines that look like closers (structure), not fixed domain words only.
  const closerRe =
    /^(#{1,3}\s*)?(一句话|总结|要点|结论|小结|takeaway|tl;?dr|summary|bottom\s*line|key\s*point)\b/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (closerRe.test(line.trim())) {
      const after = line.split(/[：:]/).slice(1).join(":").trim();
      if (after) return truncate(stripMarkdownLite(after), MAX_TAKEAWAY);
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const cand = stripMarkdownLite(lines[j] ?? "");
        if (cand.length >= 8) return truncate(cand, MAX_TAKEAWAY);
      }
    }
  }
  // Last short paragraph as soft closer
  const paras = text
    .split(/\n{2,}/)
    .map((p) => stripMarkdownLite(p))
    .filter((p) => p.length >= 12 && p.length <= 160);
  return paras.length ? truncate(paras[paras.length - 1]!, MAX_TAKEAWAY) : null;
}

function dedupePreserve(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const key = raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    let near = false;
    for (const s of seen) {
      if (s.startsWith(key.slice(0, 24)) || key.startsWith(s.slice(0, 24))) {
        near = true;
        break;
      }
    }
    if (near) continue;
    seen.add(key);
    out.push(truncate(raw, MAX_BULLET_CHARS));
    if (out.length >= max) break;
  }
  return out;
}

export function buildSmartShareSummary(input: {
  title: string;
  messages: ShareCardMessage[];
  includeThoughts?: boolean;
}): SmartShareSummary {
  const parts: string[] = [];
  let sourceMessageCount = 0;
  for (const m of input.messages) {
    if (m.role === "tool") continue;
    const body = (m.content || "").trim();
    const thought =
      input.includeThoughts && m.thought ? String(m.thought).trim() : "";
    if (!body && !thought) continue;
    sourceMessageCount += 1;
    if (m.role === "user") parts.push(body.slice(0, 400));
    else {
      parts.push(body);
      if (thought) parts.push(thought.slice(0, 600));
    }
  }
  const corpus = parts.join("\n\n");
  const headings = extractHeadings(corpus);
  const lists = extractListItems(corpus);
  const bolds = extractBoldPhrases(corpus);

  const headline = truncate(
    stripMarkdownLite(input.title) ||
      headings[0] ||
      stripMarkdownLite(parts[0] || "").slice(0, MAX_HEADLINE) ||
      "Grok share",
    MAX_HEADLINE,
  );

  const bullets = dedupePreserve(
    [
      ...headings.filter((h) => h !== headline),
      ...lists,
      ...bolds,
      ...corpus
        .split(/[。！？\n.!?]/)
        .map((s) => stripMarkdownLite(s))
        .filter((s) => s.length >= 10 && s.length <= 90),
    ],
    MAX_BULLETS,
  );

  const safeBullets =
    bullets.length > 0
      ? bullets
      : [truncate(stripMarkdownLite(corpus) || headline, MAX_BULLET_CHARS)];

  const theme = buildThemeFromContent(input.title, corpus, safeBullets.length);

  const layoutHint =
    theme.layout === "stack"
      ? "list layout"
      : theme.layout === "compact"
        ? "dense layout"
        : "editorial";

  const subtitle =
    headings.find((h) => h !== headline)?.slice(0, 64) ||
    (sourceMessageCount > 1
      ? `${sourceMessageCount} turns · ${layoutHint}`
      : layoutHint);

  return {
    theme,
    headline,
    subtitle,
    bullets: safeBullets,
    takeaway: extractTakeaway(corpus),
    sourceMessageCount,
  };
}
