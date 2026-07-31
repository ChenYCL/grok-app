import type { ChannelInstance, ChannelStatusTone, RemoteChannelId } from "./types";
import {
  normalizeWecomConnectMode,
  validateWecomConfig,
  wecomHealthHintKeys,
  wecomRequiredNonSecretKeys,
  wecomRequiredSecretKeys,
} from "./wecomConfig";
import {
  dingtalkHealthHintKeys,
  validateDingtalkConfig,
} from "./dingtalkConfig";
import {
  telegramHealthHintKeys,
  validateTelegramConfig,
} from "./telegramConfig";
import {
  feishuHealthHintKeys,
  validateFeishuConfig,
} from "./feishuConfig";


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
  /**
   * Draft options from the open form (connect_mode, client_id, proxy URL, domain…).
   * Merged over instance.options for readiness / transport — never secrets.
   */
  draftOptions?: Record<string, unknown>;
  /**
   * When the form has a non-empty Telegram token, pass for format checks only
   * (never stored by health helpers).
   */
  tokenValue?: string | null;
  /**
   * When the form has a non-empty Feishu app_id, pass for format check only.
   */
  appIdValue?: string | null;
};

const FEISHU_LIKE: RemoteChannelId[] = ["feishu", "lark"];
const TELEGRAM_LIKE: RemoteChannelId[] = ["telegram"];
const WECOM_LIKE: RemoteChannelId[] = ["wecom"];
const DINGTALK_LIKE: RemoteChannelId[] = ["dingtalk"];

/** Required secret bind keys per channel (for readiness, not values). */
const SECRET_KEYS: Partial<Record<RemoteChannelId, string[]>> = {
  feishu: ["app_secret"],
  lark: ["app_secret"],
  telegram: ["token"],
  // DingTalk secrets are validated via dingtalkConfig
  dingtalk: ["client_secret"],
  discord: ["token"],
  slack: ["bot_token", "app_token"],
  // WeCom secrets are mode-aware — see credentialReadiness / wecomConfig
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


function maskSecretValue(raw: string): string {
  if (raw.length <= 8) return "••••";
  return `${raw.slice(0, 3)}…${raw.slice(-2)}`;
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
 *
 * WeCom is mode-aware (websocket vs webhook) via {@link validateWecomConfig}.
 */
export function credentialReadiness(
  channel: RemoteChannelId,
  instance: ChannelInstance,
  secretKeysFilled?: ReadonlySet<string>,
  /**
   * When set, treat this as the last-saved connect mode for WeCom
   * (mode switch must re-supply secrets).
   */
  savedOptions?: Record<string, unknown>,
  /** Optional raw Telegram token for format checks (never stored). */
  tokenValue?: string | null,
  /** Optional Feishu app_id for format checks (never stored). */
  appIdValue?: string | null,
): { ready: boolean; missingKeys: string[] } {
  const opts = isRecord(instance.options) ? instance.options : {};

  if (channel === "wecom") {
    const savedMode = isRecord(savedOptions)
      ? normalizeWecomConnectMode(savedOptions)
      : normalizeWecomConnectMode(opts);
    const v = validateWecomConfig({
      options: opts,
      secretKeysFilled,
      hasCredentials: instance.hasCredentials,
      savedConnectMode: savedMode,
    });
    void wecomRequiredNonSecretKeys(v.mode);
    void wecomRequiredSecretKeys(v.mode);
    return { ready: v.ok, missingKeys: [...v.missing] };
  }

  if (DINGTALK_LIKE.includes(channel)) {
    const v = validateDingtalkConfig({
      options: opts,
      secretKeysFilled,
      hasCredentials: instance.hasCredentials,
    });
    return { ready: v.ok, missingKeys: [...v.missing] };
  }

  if (TELEGRAM_LIKE.includes(channel)) {
    const v = validateTelegramConfig({
      options: opts,
      secretKeysFilled,
      hasCredentials: instance.hasCredentials,
      tokenValue,
    });
    return { ready: v.ok, missingKeys: [...v.missing] };
  }

  if (FEISHU_LIKE.includes(channel)) {
    const v = validateFeishuConfig({
      options: opts,
      secretKeysFilled,
      hasCredentials: instance.hasCredentials,
      appIdValue,
      channel,
    });
    return { ready: v.ok, missingKeys: [...v.missing] };
  }

  const missing: string[] = [];

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

  const ready =
    missing.length === 0 &&
    (instance.hasCredentials ||
      (secretKeys.length > 0 &&
        !!secretKeysFilled &&
        secretKeys.every((k) => secretKeysFilled.has(k))) ||
      secretKeys.length === 0);

  return { ready: ready && missing.length === 0, missingKeys: missing };
}

export function classifyChannelHealth(
  input: ClassifyChannelHealthInput,
): RimChannelHealthDetail {
  const { instance, bridgeRunning } = input;
  const channel = instance.channel;
  const savedOpts = isRecord(instance.options) ? instance.options : {};
  const opts = {
    ...savedOpts,
    ...(isRecord(input.draftOptions) ? input.draftOptions : {}),
  };
  // Readiness evaluates against draft-merged options for honest mode switches.
  const readinessInstance: ChannelInstance = {
    ...instance,
    options: opts,
  };
  const bridgeLinked = !!input.bridgeLinked;
  const openAcl =
    !instance.acl?.allowFrom ||
    String(instance.acl.allowFrom).trim() === "" ||
    String(instance.acl.allowFrom).trim() === "*";

  const { ready: credentialsReady, missingKeys } = credentialReadiness(
    channel,
    readinessInstance,
    input.secretKeysFilled,
    savedOpts,
  );

  // Honest status: incomplete mode-switch / missing keys cannot look "connected".
  const credsUsable =
    !!instance.hasCredentials && (credentialsReady || channel !== "wecom");

  let tone: ChannelStatusTone = "unconfigured";
  if (instance.lastError) {
    tone = "error";
  } else if (
    credsUsable &&
    instance.enabled &&
    bridgeRunning &&
    bridgeLinked
  ) {
    tone = "connected";
  } else if (credsUsable && instance.enabled && bridgeRunning) {
    // Enabled + bridge up but not yet linked — "configured" until linked
    tone = bridgeLinked ? "connected" : "configured";
  } else if (credsUsable) {
    tone = "configured";
  } else if (instance.hasCredentials && !credentialsReady) {
    // Saved vault but current mode incomplete (e.g. WeCom mode switch)
    tone = "configured";
  }

  const transport = transportForChannel(channel, opts);
  const hintKeys: string[] = [];

  if (!instance.hasCredentials && !credentialsReady) {
    hintKeys.push("settings.remoteIm.health.hint.needCredentials");
  } else if (!instance.enabled) {
    hintKeys.push("settings.remoteIm.health.hint.disabled");
  } else if (!bridgeRunning) {
    hintKeys.push("settings.remoteIm.health.hint.bridgeStopped");
  } else if (!bridgeLinked && instance.enabled && credentialsReady) {
    hintKeys.push("settings.remoteIm.health.hint.notLinked");
  }

  if (openAcl && instance.hasCredentials) {
    hintKeys.push("settings.remoteIm.health.hint.openAcl");
  }

  // Channel-specific depth (shippable for Feishu / Telegram / WeCom)
  if (instance.lastError) {
    tone = "error";
  }

  if (FEISHU_LIKE.includes(channel)) {
    const feishuV = validateFeishuConfig({
      options: opts,
      secretKeysFilled: input.secretKeysFilled,
      hasCredentials: instance.hasCredentials,
      appIdValue: input.appIdValue,
      channel,
    });
    const enableFeishuCard =
      opts.enable_feishu_card === undefined
        ? true
        : opts.enable_feishu_card === true || opts.enable_feishu_card === "true";
    for (const k of feishuHealthHintKeys(feishuV, {
      openAcl: openAcl && instance.hasCredentials,
      enableFeishuCard,
    })) {
      hintKeys.push(k);
    }
  }

  if (TELEGRAM_LIKE.includes(channel)) {
    const tgV = validateTelegramConfig({
      options: opts,
      secretKeysFilled: input.secretKeysFilled,
      hasCredentials: instance.hasCredentials,
      tokenValue: input.tokenValue,
    });
    for (const k of telegramHealthHintKeys(tgV, {
      openAcl: openAcl && instance.hasCredentials,
    })) {
      hintKeys.push(k);
    }
  }

  if (WECOM_LIKE.includes(channel)) {
    const wecomV = validateWecomConfig({
      options: opts,
      secretKeysFilled: input.secretKeysFilled,
      hasCredentials: instance.hasCredentials,
      savedConnectMode: normalizeWecomConnectMode(savedOpts),
    });
    for (const k of wecomHealthHintKeys(wecomV, {
      openAcl: openAcl && instance.hasCredentials,
      proxySet: !!optionString(opts, "proxy"),
    })) {
      hintKeys.push(k);
    }
  }

  if (DINGTALK_LIKE.includes(channel)) {
    const dingV = validateDingtalkConfig({
      options: opts,
      secretKeysFilled: input.secretKeysFilled,
      hasCredentials: instance.hasCredentials,
    });
    const enableAiCard =
      opts.enable_ai_card === undefined
        ? true
        : opts.enable_ai_card === true || opts.enable_ai_card === "true";
    for (const k of dingtalkHealthHintKeys(dingV, {
      openAcl: openAcl && instance.hasCredentials,
      enableAiCard,
    })) {
      hintKeys.push(k);
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
  return (
    FEISHU_LIKE.includes(channel) ||
    TELEGRAM_LIKE.includes(channel) ||
    WECOM_LIKE.includes(channel) ||
    DINGTALK_LIKE.includes(channel)
  );
}
