/**
 * Clearer per-channel health for Remote IM UI.
 *
 * Pure helpers — no I/O. Classifies credential readiness, connection mode,
 * ACL posture, and bridge link for channels already in the GUI.
 * At least Feishu/Lark (WebSocket) and Telegram (long poll) get typed detail;
 * other implemented channels get a shared baseline.
 *
 * Never surfaces raw secrets — only redacted lastError snippets.
 */

import type {
  ChannelInstance,
  ChannelStatusTone,
  RemoteChannelId,
} from "./types";
import { maskSecretValue } from "./secretsApi";

/** Health tone for badges / callouts (maps to RimBadge). */
export type RimChannelHealthTone = "ok" | "warn" | "err" | "neutral";

/** Connection transport family for human-readable health. */
export type RimChannelTransport =
  | "websocket"
  | "stream"
  | "long_poll"
  | "socket_mode"
  | "gateway"
  | "webhook"
  | "forward_ws"
  | "mixed"
  | "unknown";

export type RimChannelHealthDetail = {
  channel: RemoteChannelId;
  /** Sidebar / header status light */
  tone: ChannelStatusTone;
  /** Badge tone for RimBadge */
  badgeTone: RimChannelHealthTone;
  /** i18n key for primary status label */
  statusKey: string;
  /** Transport family */
  transport: RimChannelTransport;
  /** i18n key for transport line */
  transportKey: string;
  /** Human options summary (non-secret), e.g. domain=feishu */
  modeLabel: string | null;
  /** True when credentials are present (masked) */
  hasCredentials: boolean;
  /** True when instance enabled */
  enabled: boolean;
  /** Bridge reports this instance as connected */
  bridgeLinked: boolean;
  /** ACL allow_from is open (*) — warn when enabled */
  openAcl: boolean;
  /** Credential completeness for channel-specific required secret keys */
  credentialsReady: boolean;
  /** Missing bind keys (option keys, never secret values) */
  missingKeys: string[];
  /** Sanitized last error (redacted) */
  lastError: string | null;
  /** Short guidance keys (i18n) for UI bullets */
  hintKeys: string[];
};

export type ClassifyChannelHealthInput = {
  instance: ChannelInstance;
  /** Bridge is running or listening */
  bridgeRunning: boolean;
  /** Instance id appears in bridge.connectedChannels */
  bridgeLinked?: boolean;
  /**
   * Optional: which secret field keys are filled in the form right now.
   * Used only for incomplete-form hints — never stores values.
   */
  secretKeysFilled?: ReadonlySet<string>;
};

const FEISHU_LIKE: RemoteChannelId[] = ["feishu", "lark"];
const TELEGRAM_LIKE: RemoteChannelId[] = ["telegram"];

/** Required secret bind keys per channel (for readiness, not values). */
const SECRET_KEYS: Partial<Record<RemoteChannelId, string[]>> = {
  feishu: ["app_secret"],
  lark: ["app_secret"],
  telegram: ["token"],
  dingtalk: ["client_secret"],
  discord: ["token"],
  slack: ["bot_token", "app_token"],
  wecom: ["bot_secret", "corp_secret", "callback_token"],
  weixin: ["token"],
  matrix: ["access_token"],
  line: ["channel_secret", "channel_access_token"],
};

const NON_SECRET_REQUIRED: Partial<Record<RemoteChannelId, string[]>> = {
  feishu: ["app_id"],
  lark: ["app_id"],
  telegram: [],
  dingtalk: ["client_id"],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Redact secret-looking substrings from error text. */
export function sanitizeChannelError(raw: unknown): string | null {
  if (raw == null) return null;
  let s = String(raw).replace(/[\u0000-\u001f]/g, "").trim();
  if (!s) return null;
  // token=... / secret=... pairs
  s = s.replace(
    /\b([A-Za-z0-9_]*(?:secret|token|password|key)[A-Za-z0-9_]*)\s*[:=]\s*([^\s,;]+)/gi,
    (_, k: string) => `${k}=••••`,
  );
  s = s.replace(
    /\b((?:sk|xai|xoxb|xapp|ghp|gho)-[A-Za-z0-9._-]{6,})\b/gi,
    (m) => maskSecretValue(m),
  );
  s = s.replace(/https?:\/\/[^\s]+/gi, "[url]");
  if (s.length > 240) s = s.slice(0, 237) + "…";
  return s;
}

export function transportForChannel(
  channel: RemoteChannelId,
  options?: Record<string, unknown>,
): RimChannelTransport {
  const opts = options ?? {};
  switch (channel) {
    case "feishu":
    case "lark":
    case "wps-xiezuo":
    case "weibo":
      return "websocket";
    case "dingtalk":
      return "stream";
    case "telegram":
    case "weixin":
    case "matrix":
      return "long_poll";
    case "slack":
      return "socket_mode";
    case "discord":
    case "qqbot":
      return "gateway";
    case "line":
      return "webhook";
    case "qq":
      return "forward_ws";
    case "wecom": {
      const mode = String(opts.connect_mode ?? opts.mode ?? "websocket");
      return mode === "webhook" ? "webhook" : "websocket";
    }
    default:
      return "unknown";
  }
}

export function transportKeyFor(
  transport: RimChannelTransport,
): string {
  switch (transport) {
    case "websocket":
      return "settings.remoteIm.conn.websocket";
    case "stream":
      return "settings.remoteIm.conn.stream";
    case "long_poll":
      return "settings.remoteIm.conn.longPoll";
    case "socket_mode":
      return "settings.remoteIm.conn.socketMode";
    case "gateway":
      return "settings.remoteIm.conn.gateway";
    case "webhook":
      return "settings.remoteIm.conn.webhook";
    case "forward_ws":
      return "settings.remoteIm.conn.forwardWs";
    case "mixed":
      return "settings.remoteIm.conn.wsOrWebhook";
    default:
      return "settings.remoteIm.conn.websocket";
  }
}

/** Channel-specific non-secret mode summary for health card. */
export function channelModeLabel(
  channel: RemoteChannelId,
  options: Record<string, unknown>,
): string | null {
  if (FEISHU_LIKE.includes(channel)) {
    const domain = String(options.domain ?? "feishu");
    if (domain === "lark") return "domain=lark";
    if (domain === "custom") {
      const custom = String(options.custom_domain ?? "").trim();
      return custom ? `domain=custom` : "domain=custom";
    }
    return "domain=feishu";
  }
  if (TELEGRAM_LIKE.includes(channel)) {
    const proxy = String(options.proxy ?? "").trim();
    return proxy ? "proxy=set" : "proxy=none";
  }
  if (channel === "wecom") {
    const mode = String(options.connect_mode ?? options.mode ?? "websocket");
    return `mode=${mode === "webhook" ? "webhook" : "websocket"}`;
  }
  if (channel === "dingtalk") {
    return "mode=stream";
  }
  return null;
}

function optionString(
  options: Record<string, unknown>,
  key: string,
): string {
  const v = options[key];
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Check non-secret required bind fields + optional in-form secret keys.
 * Does not read secret values — only presence of keys in secretKeysFilled
 * or hasCredentials flag.
 */
export function credentialReadiness(
  channel: RemoteChannelId,
  instance: ChannelInstance,
  secretKeysFilled?: ReadonlySet<string>,
): { ready: boolean; missingKeys: string[] } {
  const missing: string[] = [];
  const opts = isRecord(instance.options) ? instance.options : {};

  for (const k of NON_SECRET_REQUIRED[channel] ?? []) {
    if (!optionString(opts, k)) missing.push(k);
  }

  const secretKeys = SECRET_KEYS[channel] ?? [];
  if (!instance.hasCredentials) {
    for (const k of secretKeys) {
      if (!secretKeysFilled || !secretKeysFilled.has(k)) {
        missing.push(k);
      }
    }
  }

  // Feishu needs app_id always when binding
  if (FEISHU_LIKE.includes(channel) && !optionString(opts, "app_id")) {
    if (!missing.includes("app_id")) missing.push("app_id");
  }

  const ready =
    missing.length === 0 &&
    (instance.hasCredentials ||
      (secretKeys.length > 0 &&
        !!secretKeysFilled &&
        secretKeys.every((k) => secretKeysFilled.has(k))) ||
      secretKeys.length === 0);

  return { ready: ready && missing.length === 0, missingKeys: missing };
}

function toneToBadge(tone: ChannelStatusTone): RimChannelHealthTone {
  switch (tone) {
    case "connected":
      return "ok";
    case "configured":
      return "warn";
    case "error":
      return "err";
    default:
      return "neutral";
  }
}

function statusKeyFor(tone: ChannelStatusTone): string {
  return `settings.remoteIm.status.${tone}`;
}

/**
 * Classify health for a channel instance.
 * Feishu/Lark and Telegram get richer mode + ACL + credential hints;
 * all channels get baseline tone / error / bridge link.
 */
export function classifyChannelHealth(
  input: ClassifyChannelHealthInput,
): RimChannelHealthDetail {
  const { instance, bridgeRunning } = input;
  const channel = instance.channel;
  const opts = isRecord(instance.options) ? instance.options : {};
  const bridgeLinked = !!input.bridgeLinked;
  const openAcl =
    !instance.acl?.allowFrom ||
    String(instance.acl.allowFrom).trim() === "" ||
    String(instance.acl.allowFrom).trim() === "*";

  const { ready: credentialsReady, missingKeys } = credentialReadiness(
    channel,
    instance,
    input.secretKeysFilled,
  );

  let tone: ChannelStatusTone = "unconfigured";
  if (instance.lastError) {
    tone = "error";
  } else if (
    instance.hasCredentials &&
    instance.enabled &&
    bridgeRunning &&
    bridgeLinked
  ) {
    tone = "connected";
  } else if (
    instance.hasCredentials &&
    instance.enabled &&
    bridgeRunning
  ) {
    // Enabled + bridge up but not yet linked — still "connected" intent
    // or "configured" if bridge not reporting this id
    tone = bridgeLinked ? "connected" : "configured";
  } else if (instance.hasCredentials) {
    tone = "configured";
  }

  const transport = transportForChannel(channel, opts);
  const hintKeys: string[] = [];

  if (!instance.hasCredentials) {
    hintKeys.push("settings.remoteIm.health.hint.needCredentials");
  } else if (!instance.enabled) {
    hintKeys.push("settings.remoteIm.health.hint.disabled");
  } else if (!bridgeRunning) {
    hintKeys.push("settings.remoteIm.health.hint.bridgeStopped");
  } else if (!bridgeLinked && instance.enabled) {
    hintKeys.push("settings.remoteIm.health.hint.notLinked");
  }

  if (openAcl && instance.hasCredentials) {
    hintKeys.push("settings.remoteIm.health.hint.openAcl");
  }

  // Channel-specific depth (shippable for ≥2 types in UI)
  if (FEISHU_LIKE.includes(channel)) {
    if (!optionString(opts, "app_id") && !instance.hasCredentials) {
      hintKeys.push("settings.remoteIm.health.hint.feishuAppId");
    }
    const domain = String(opts.domain ?? "feishu");
    if (domain === "lark") {
      hintKeys.push("settings.remoteIm.health.hint.feishuLarkDomain");
    }
    hintKeys.push("settings.remoteIm.health.hint.feishuWs");
  }

  if (TELEGRAM_LIKE.includes(channel)) {
    hintKeys.push("settings.remoteIm.health.hint.telegramPoll");
    if (optionString(opts, "proxy")) {
      hintKeys.push("settings.remoteIm.health.hint.telegramProxy");
    }
    if (openAcl && instance.hasCredentials) {
      // Telegram open ACL is especially risky
      hintKeys.push("settings.remoteIm.health.hint.telegramAcl");
    }
  }

  // Dedup preserve order
  const seen = new Set<string>();
  const uniqueHints = hintKeys.filter((k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    channel,
    tone,
    badgeTone: toneToBadge(tone),
    statusKey: statusKeyFor(tone),
    transport,
    transportKey: transportKeyFor(transport),
    modeLabel: channelModeLabel(channel, opts),
    hasCredentials: !!instance.hasCredentials,
    enabled: !!instance.enabled,
    bridgeLinked,
    openAcl,
    credentialsReady,
    missingKeys,
    lastError: sanitizeChannelError(instance.lastError),
    hintKeys: uniqueHints.slice(0, 6),
  };
}

/** True when this channel gets the deeper health card (not just badge). */
export function channelHasDeepHealth(channel: RemoteChannelId): boolean {
  return FEISHU_LIKE.includes(channel) || TELEGRAM_LIKE.includes(channel);
}
