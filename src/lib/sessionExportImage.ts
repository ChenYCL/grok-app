/**
 * Conversation → share-card PNG (Claude/ChatGPT-style export image).
 *
 * Pure builders for card model + offscreen DOM; rasterization uses canvas
 * (no runtime CDN). Footer always credits "Generated with Grok App".
 */

import { escapeHtml, type ExportableMessage } from "@/lib/sessionExport";

export const GROK_APP_SHARE_FOOTER = "Generated with Grok App";

export type ShareCardMessage = {
  role: "user" | "assistant" | "tool" | string;
  content: string;
  thought?: string;
  createdAt?: string;
};

export type ShareCardInput = {
  title: string;
  projectName?: string | null;
  sessionId?: string | null;
  exportedAt?: string;
  messages: ShareCardMessage[];
  /** Custom logo data URL; null/omit → built-in mark text. */
  logoDataUrl?: string | null;
  /** Include assistant thinking blocks (default false for share cards). */
  includeThoughts?: boolean;
  /** Max messages to render (default 40; oldest dropped first). */
  maxMessages?: number;
  /** Max chars per message body (default 4000). */
  maxBodyChars?: number;
  /** Footer line (default {@link GROK_APP_SHARE_FOOTER}). */
  footerText?: string;
  /** Card width in CSS px (default 720). */
  widthPx?: number;
};

export type ShareCardModel = {
  title: string;
  projectName: string | null;
  sessionId: string | null;
  exportedAt: string;
  messages: ShareCardMessage[];
  logoDataUrl: string | null;
  includeThoughts: boolean;
  footerText: string;
  widthPx: number;
  truncatedCount: number;
};

const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MAX_BODY = 4000;
const DEFAULT_WIDTH = 720;

function roleLabel(role: string): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Grok";
  if (role === "tool") return "Tool";
  return role;
}

function truncateBody(text: string, max: number): string {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function isToolish(m: ShareCardMessage): boolean {
  if (m.role === "tool") return true;
  const c = (m.content || "").trim();
  return c.startsWith("tool_step|") || c.startsWith("tool_step");
}

/**
 * Normalize exportable messages into a share-card model.
 * Drops empty shells and tool noise; caps length for readable cards.
 */
export function buildShareCardModel(input: ShareCardInput): ShareCardModel {
  const maxMessages = input.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxBody = input.maxBodyChars ?? DEFAULT_MAX_BODY;
  const includeThoughts = input.includeThoughts === true;
  const widthPx = input.widthPx ?? DEFAULT_WIDTH;

  const cleaned: ShareCardMessage[] = [];
  for (const m of input.messages) {
    if (isToolish(m)) continue;
    const body = truncateBody(m.content || "", maxBody);
    const thought = includeThoughts
      ? truncateBody(m.thought || "", Math.min(1200, maxBody))
      : "";
    if (!body && !thought) continue;
    cleaned.push({
      role: m.role,
      content: body,
      thought: thought || undefined,
      createdAt: m.createdAt,
    });
  }

  let truncatedCount = 0;
  let messages = cleaned;
  if (messages.length > maxMessages) {
    truncatedCount = messages.length - maxMessages;
    messages = messages.slice(messages.length - maxMessages);
  }

  const title = (input.title || "Untitled").trim() || "Untitled";
  return {
    title,
    projectName: (input.projectName || "").trim() || null,
    sessionId: input.sessionId ?? null,
    exportedAt: input.exportedAt || new Date().toISOString(),
    messages,
    logoDataUrl: input.logoDataUrl?.trim() || null,
    includeThoughts,
    footerText: (input.footerText || GROK_APP_SHARE_FOOTER).trim(),
    widthPx,
    truncatedCount,
  };
}

/** Safe download basename for PNG export. */
export function sessionExportImageFilename(
  title: string,
  sessionId?: string | null,
): string {
  const base = (title || "session")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const id = (sessionId || "").slice(0, 8);
  const name = base || "session";
  return id ? `grok-${name}-${id}.png` : `grok-${name}.png`;
}

/**
 * Build a self-contained HTML fragment for the share card (no outer document).
 * Used for preview + rasterization. All text is escaped.
 */
export function shareCardToHtml(model: ShareCardModel): string {
  const logo = model.logoDataUrl
    ? `<img class="sc-logo" src="${escapeHtml(model.logoDataUrl)}" alt="" width="36" height="36" />`
    : `<div class="sc-logo sc-logo--mark" aria-hidden="true">G</div>`;

  const metaBits: string[] = [];
  if (model.projectName) metaBits.push(escapeHtml(model.projectName));
  metaBits.push(escapeHtml(model.exportedAt.slice(0, 19).replace("T", " ")));

  const msgHtml = model.messages
    .map((m) => {
      const role = roleLabel(m.role);
      const roleClass =
        m.role === "user"
          ? "user"
          : m.role === "assistant"
            ? "assistant"
            : "other";
      const thought =
        model.includeThoughts && m.thought
          ? `<div class="sc-thought"><span class="sc-thought__label">Thinking</span><pre>${escapeHtml(m.thought)}</pre></div>`
          : "";
      const body = m.content
        ? `<pre class="sc-body">${escapeHtml(m.content)}</pre>`
        : "";
      return `<section class="sc-msg sc-msg--${roleClass}">
  <div class="sc-msg__role">${escapeHtml(role)}</div>
  ${thought}${body}
</section>`;
    })
    .join("\n");

  const more =
    model.truncatedCount > 0
      ? `<p class="sc-more">+${model.truncatedCount} earlier messages omitted</p>`
      : "";

  return `<article class="sc-card" style="width:${model.widthPx}px">
  <header class="sc-header">
    ${logo}
    <div class="sc-header__text">
      <h1 class="sc-title">${escapeHtml(model.title)}</h1>
      <p class="sc-meta">${metaBits.join(" · ")}</p>
    </div>
  </header>
  <div class="sc-thread">
${more}
${msgHtml}
  </div>
  <footer class="sc-footer">
    <span class="sc-footer__mark">${escapeHtml(model.footerText)}</span>
  </footer>
</article>`;
}

/** Inline CSS for share card (light, print-friendly, social-share friendly). */
export const SHARE_CARD_STYLES = `
.sc-card{box-sizing:border-box;background:#0b0c0f;color:#f4f4f5;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;border-radius:16px;overflow:hidden;border:1px solid #27272a;box-shadow:0 12px 40px rgba(0,0,0,.35)}
.sc-header{display:flex;align-items:center;gap:12px;padding:18px 20px 14px;background:linear-gradient(180deg,#14151a 0%,#0b0c0f 100%);border-bottom:1px solid #27272a}
.sc-logo{width:36px;height:36px;border-radius:10px;object-fit:cover;flex-shrink:0;background:#18181b}
.sc-logo--mark{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#fff;background:linear-gradient(135deg,#3b82f6,#8b5cf6)}
.sc-header__text{min-width:0;flex:1}
.sc-title{margin:0;font-size:16px;font-weight:650;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-meta{margin:4px 0 0;font-size:12px;color:#a1a1aa}
.sc-thread{padding:8px 16px 4px;max-height:none}
.sc-more{margin:8px 4px;font-size:12px;color:#71717a}
.sc-msg{margin:10px 0;padding:10px 12px;border-radius:12px}
.sc-msg--user{background:#1e293b;margin-left:24px}
.sc-msg--assistant{background:#18181b;border:1px solid #27272a;margin-right:8px}
.sc-msg--other{background:#18181b;opacity:.9}
.sc-msg__role{font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:#a1a1aa;margin-bottom:6px}
.sc-body,.sc-thought pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:13.5px;line-height:1.55;color:#e4e4e7}
.sc-thought{margin-bottom:8px;padding:8px;border-radius:8px;background:#09090b;border:1px solid #27272a}
.sc-thought__label{display:block;font-size:10px;font-weight:600;color:#71717a;margin-bottom:4px;text-transform:uppercase}
.sc-footer{display:flex;align-items:center;justify-content:flex-end;padding:12px 18px 14px;border-top:1px solid #27272a;background:#0b0c0f}
.sc-footer__mark{font-size:11px;font-weight:600;letter-spacing:.04em;color:#71717a}
`.trim();

/**
 * Map session export messages into share-card messages.
 */
export function exportableToShareMessages(
  messages: ExportableMessage[],
): ShareCardMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    thought: m.thought,
    createdAt: m.createdAt,
  }));
}

export type RasterizeShareCardOptions = {
  /** Device pixel ratio (default 2, Claude-style). */
  pixelRatio?: number;
  /** Background fill under the card (default transparent → solid card only). */
  background?: string;
};

/**
 * Draw a share card with pure Canvas 2D (no foreignObject / html-to-image).
 * Reliable in Tauri WebView; logo data URLs load as Image.
 */
export async function rasterizeShareCardPng(
  model: ShareCardModel,
  opts?: RasterizeShareCardOptions,
): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new Error("rasterizeShareCardPng requires a DOM");
  }

  const pixelRatio = opts?.pixelRatio ?? 2;
  const width = model.widthPx;
  const padX = 20;
  const contentW = width - padX * 2;
  const lineH = 20;
  const fontBody =
    '13.5px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const fontTitle =
    '650 16px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const fontMeta =
    '12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const fontRole =
    '600 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const fontFooter =
    '600 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  // Measure with an offscreen canvas context.
  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d");
  if (!mctx) throw new Error("no 2d context");

  const wrapLines = (text: string, maxWidth: number, font: string): string[] => {
    mctx.font = font;
    const paragraphs = (text || "").split("\n");
    const lines: string[] = [];
    for (const para of paragraphs) {
      if (!para) {
        lines.push("");
        continue;
      }
      const words = para.split(/(\s+)/);
      let line = "";
      for (const w of words) {
        const trial = line + w;
        if (mctx.measureText(trial).width <= maxWidth || !line) {
          line = trial;
        } else {
          lines.push(line);
          line = w.trimStart();
        }
      }
      if (line) lines.push(line);
    }
    return lines.length ? lines : [""];
  };

  type Block =
    | { kind: "header" }
    | { kind: "more"; text: string }
    | {
        kind: "msg";
        role: string;
        roleClass: string;
        bodyLines: string[];
        thoughtLines: string[];
      }
    | { kind: "footer" };

  const blocks: Block[] = [{ kind: "header" }];
  if (model.truncatedCount > 0) {
    blocks.push({
      kind: "more",
      text: `+${model.truncatedCount} earlier messages omitted`,
    });
  }
  for (const m of model.messages) {
    const role =
      m.role === "user"
        ? "You"
        : m.role === "assistant"
          ? "Grok"
          : m.role === "tool"
            ? "Tool"
            : m.role;
    const roleClass =
      m.role === "user"
        ? "user"
        : m.role === "assistant"
          ? "assistant"
          : "other";
    const bubblePad = 24;
    const bodyMax = contentW - bubblePad - 16;
    const thoughtLines =
      model.includeThoughts && m.thought
        ? wrapLines(m.thought, bodyMax - 16, fontBody)
        : [];
    const bodyLines = m.content
      ? wrapLines(m.content, bodyMax, fontBody)
      : [];
    blocks.push({ kind: "msg", role, roleClass, bodyLines, thoughtLines });
  }
  blocks.push({ kind: "footer" });

  // Layout heights.
  let height = 0;
  const headerH = 68;
  const footerH = 44;
  height += headerH;
  for (const b of blocks) {
    if (b.kind === "header" || b.kind === "footer") continue;
    if (b.kind === "more") {
      height += 28;
      continue;
    }
    const thoughtH =
      b.thoughtLines.length > 0
        ? 12 + 14 + b.thoughtLines.length * lineH + 12
        : 0;
    const bodyH = b.bodyLines.length * lineH;
    height += 10 + 14 + 6 + thoughtH + bodyH + 16;
  }
  height += footerH + 8;
  height = Math.max(height, 160);

  let logoImg: HTMLImageElement | null = null;
  if (model.logoDataUrl) {
    try {
      logoImg = await loadImage(model.logoDataUrl);
    } catch {
      logoImg = null;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.scale(pixelRatio, pixelRatio);

  // Background card
  const bg = opts?.background ?? "#0b0c0f";
  roundRect(ctx, 0, 0, width, height, 16);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = "#27272a";
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 16);
  ctx.stroke();

  let y = 0;

  // Header
  const headerGrad = ctx.createLinearGradient(0, 0, 0, headerH);
  headerGrad.addColorStop(0, "#14151a");
  headerGrad.addColorStop(1, "#0b0c0f");
  ctx.fillStyle = headerGrad;
  ctx.fillRect(0, 0, width, headerH);
  ctx.strokeStyle = "#27272a";
  ctx.beginPath();
  ctx.moveTo(0, headerH);
  ctx.lineTo(width, headerH);
  ctx.stroke();

  const logoSize = 36;
  const logoX = padX;
  const logoY = (headerH - logoSize) / 2;
  if (logoImg) {
    ctx.save();
    roundRect(ctx, logoX, logoY, logoSize, logoSize, 10);
    ctx.clip();
    ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
    ctx.restore();
  } else {
    const g = ctx.createLinearGradient(
      logoX,
      logoY,
      logoX + logoSize,
      logoY + logoSize,
    );
    g.addColorStop(0, "#3b82f6");
    g.addColorStop(1, "#8b5cf6");
    ctx.fillStyle = g;
    roundRect(ctx, logoX, logoY, logoSize, logoSize, 10);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font =
      '700 18px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("G", logoX + logoSize / 2, logoY + logoSize / 2 + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  const textX = logoX + logoSize + 12;
  ctx.fillStyle = "#f4f4f5";
  ctx.font = fontTitle;
  const title =
    model.title.length > 60 ? `${model.title.slice(0, 59)}…` : model.title;
  ctx.fillText(title, textX, logoY + 16);
  ctx.fillStyle = "#a1a1aa";
  ctx.font = fontMeta;
  const metaBits: string[] = [];
  if (model.projectName) metaBits.push(model.projectName);
  metaBits.push(model.exportedAt.slice(0, 19).replace("T", " "));
  ctx.fillText(metaBits.join(" · "), textX, logoY + 34);

  y = headerH + 8;

  for (const b of blocks) {
    if (b.kind === "header" || b.kind === "footer") continue;
    if (b.kind === "more") {
      ctx.fillStyle = "#71717a";
      ctx.font = fontMeta;
      ctx.fillText(b.text, padX + 4, y + 16);
      y += 28;
      continue;
    }

    const isUser = b.roleClass === "user";
    const left = isUser ? padX + 24 : padX;
    const right = isUser ? padX : padX + 8;
    const bubbleW = width - left - right;
    const thoughtH =
      b.thoughtLines.length > 0
        ? 12 + 14 + b.thoughtLines.length * lineH + 12
        : 0;
    const bodyH = b.bodyLines.length * lineH;
    const bubbleH = 10 + 14 + 6 + thoughtH + bodyH + 12;

    ctx.fillStyle = isUser ? "#1e293b" : "#18181b";
    roundRect(ctx, left, y, bubbleW, bubbleH, 12);
    ctx.fill();
    if (!isUser) {
      ctx.strokeStyle = "#27272a";
      ctx.stroke();
    }

    let ty = y + 18;
    ctx.fillStyle = "#a1a1aa";
    ctx.font = fontRole;
    ctx.fillText(b.role.toUpperCase(), left + 12, ty);
    ty += 12;

    if (b.thoughtLines.length > 0) {
      const th = 8 + 14 + b.thoughtLines.length * lineH + 8;
      ctx.fillStyle = "#09090b";
      roundRect(ctx, left + 10, ty, bubbleW - 20, th, 8);
      ctx.fill();
      ctx.strokeStyle = "#27272a";
      ctx.stroke();
      ctx.fillStyle = "#71717a";
      ctx.font = fontRole;
      ctx.fillText("THINKING", left + 18, ty + 14);
      ctx.fillStyle = "#e4e4e7";
      ctx.font = fontBody;
      let ly = ty + 30;
      for (const line of b.thoughtLines) {
        ctx.fillText(line, left + 18, ly);
        ly += lineH;
      }
      ty += th + 8;
    }

    ctx.fillStyle = "#e4e4e7";
    ctx.font = fontBody;
    let ly = ty + 4;
    for (const line of b.bodyLines) {
      ctx.fillText(line, left + 12, ly);
      ly += lineH;
    }

    y += bubbleH + 10;
  }

  // Footer
  const footerY = height - footerH;
  ctx.strokeStyle = "#27272a";
  ctx.beginPath();
  ctx.moveTo(0, footerY);
  ctx.lineTo(width, footerY);
  ctx.stroke();
  ctx.fillStyle = "#0b0c0f";
  ctx.fillRect(0, footerY, width, footerH);
  ctx.fillStyle = "#71717a";
  ctx.font = fontFooter;
  ctx.textAlign = "right";
  ctx.fillText(model.footerText, width - padX, footerY + 26);
  ctx.textAlign = "left";

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) throw new Error("toBlob failed");
  return blob;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/** Download a PNG blob via temporary anchor. */
export function downloadPngBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    // Delay revoke so the download can start.
    setTimeout(() => URL.revokeObjectURL(url), 2_000);
  }
}

/** Copy PNG blob to clipboard when supported. */
export async function copyPngBlob(blob: Blob): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof ClipboardItem === "undefined"
  ) {
    return false;
  }
  try {
    const isSafari = /^((?!chrome|android).)*safari/i.test(
      typeof navigator !== "undefined" ? navigator.userAgent : "",
    );
    if (isSafari) {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": Promise.resolve(blob) }),
      ]);
    } else {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
    }
    return true;
  } catch {
    return false;
  }
}
