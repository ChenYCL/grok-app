import { describe, expect, it } from "vitest";
import {
  channelHasDeepHealth,
  channelModeLabel,
  classifyChannelHealth,
  credentialReadiness,
  sanitizeChannelError,
  transportForChannel,
  transportKeyFor,
} from "./channelHealth";
import { createDefaultInstance } from "./store";
import type { ChannelInstance } from "./types";

function inst(
  channel: ChannelInstance["channel"],
  patch: Partial<ChannelInstance> = {},
): ChannelInstance {
  return {
    ...createDefaultInstance(channel),
    ...patch,
    channel,
    options: { ...createDefaultInstance(channel).options, ...patch.options },
  };
}

describe("sanitizeChannelError", () => {
  it("redacts token/secret pairs and urls", () => {
    const s = sanitizeChannelError(
      "failed app_secret=superleak token=abc123 https://evil.example/x",
    );
    expect(s).toBeTruthy();
    expect(s!).not.toContain("superleak");
    expect(s!).not.toContain("abc123");
    expect(s!).toContain("[url]");
    expect(s!).toMatch(/••••|\[redacted\]|app_secret=••••/i);
  });

  it("returns null for empty", () => {
    expect(sanitizeChannelError("")).toBeNull();
    expect(sanitizeChannelError(null)).toBeNull();
  });
});

describe("transportForChannel", () => {
  it("feishu is websocket; telegram is long_poll", () => {
    expect(transportForChannel("feishu")).toBe("websocket");
    expect(transportForChannel("lark")).toBe("websocket");
    expect(transportForChannel("telegram")).toBe("long_poll");
    expect(transportForChannel("dingtalk")).toBe("stream");
  });

  it("wecom respects connect mode", () => {
    expect(transportForChannel("wecom", { connect_mode: "webhook" })).toBe(
      "webhook",
    );
    expect(transportForChannel("wecom", { connect_mode: "websocket" })).toBe(
      "websocket",
    );
  });

  it("transportKeyFor maps known transports", () => {
    expect(transportKeyFor("websocket")).toContain("websocket");
    expect(transportKeyFor("long_poll")).toContain("longPoll");
  });
});

describe("channelModeLabel", () => {
  it("feishu domain + telegram proxy", () => {
    expect(channelModeLabel("feishu", { domain: "feishu" })).toBe(
      "ws;domain=feishu",
    );
    expect(channelModeLabel("lark", { domain: "lark" })).toBe("ws;domain=lark");
    expect(channelModeLabel("telegram", {})).toBe("proxy=none");
    expect(channelModeLabel("telegram", { proxy: "socks5://x" })).toBe(
      "proxy=set",
    );
  });
});

describe("credentialReadiness", () => {
  it("feishu needs app_id + secret unless hasCredentials", () => {
    const bare = inst("feishu", {
      hasCredentials: false,
      options: { app_id: "" },
    });
    const r = credentialReadiness("feishu", bare);
    expect(r.ready).toBe(false);
    expect(r.missingKeys).toContain("app_id");
    expect(r.missingKeys).toContain("app_secret");

    const saved = inst("feishu", {
      hasCredentials: true,
      options: { app_id: "cli_x" },
    });
    expect(credentialReadiness("feishu", saved).ready).toBe(true);
  });

  it("feishu rejects invalid app_id format when value provided", () => {
    const bare = inst("feishu", {
      hasCredentials: false,
      options: { app_id: "bad id" },
    });
    const r = credentialReadiness(
      "feishu",
      bare,
      new Set(["app_secret"]),
      "bad id",
    );
    expect(r.ready).toBe(false);
    expect(r.missingKeys).toContain("app_id");
  });

  it("feishu requires custom_domain when domain=custom", () => {
    const i = inst("feishu", {
      hasCredentials: true,
      options: { app_id: "cli_x", domain: "custom" },
    });
    const r = credentialReadiness("feishu", i);
    expect(r.ready).toBe(false);
    expect(r.missingKeys).toContain("custom_domain");
  });

  it("telegram ready with token in form set", () => {
    const bare = inst("telegram", { hasCredentials: false });
    expect(credentialReadiness("telegram", bare).ready).toBe(false);
    expect(
      credentialReadiness("telegram", bare, new Set(["token"])).ready,
    ).toBe(true);
  });
});

describe("classifyChannelHealth", () => {
  it("feishu: unconfigured → configured → connected with deep hints", () => {
    const bare = inst("feishu", { hasCredentials: false, enabled: false });
    const h0 = classifyChannelHealth({
      instance: bare,
      bridgeRunning: false,
    });
    expect(h0.tone).toBe("unconfigured");
    expect(h0.transport).toBe("websocket");
    expect(channelHasDeepHealth("feishu")).toBe(true);
    expect(h0.hintKeys.some((k) => k.includes("needCredentials"))).toBe(true);
    expect(h0.hintKeys.some((k) => k.includes("feishuWs"))).toBe(true);
    expect(h0.hintKeys.some((k) => k.includes("feishuNoWebhook"))).toBe(true);

    const cfg = inst("feishu", {
      hasCredentials: true,
      enabled: true,
      options: { app_id: "cli_x", domain: "open.feishu.cn" },
      acl: {
        allowFrom: "*",
        requireMention: true,
        groupOnly: false,
        shareSessionInChannel: false,
      },
    });
    const h1 = classifyChannelHealth({
      instance: cfg,
      bridgeRunning: true,
      bridgeLinked: false,
    });
    expect(h1.tone).toBe("configured");
    expect(h1.openAcl).toBe(true);
    expect(h1.modeLabel).toBe("ws;domain=feishu");
    expect(h1.hintKeys.some((k) => k.includes("openAcl"))).toBe(true);
    expect(h1.hintKeys.some((k) => k.includes("feishuCardEvents"))).toBe(true);

    const h2 = classifyChannelHealth({
      instance: cfg,
      bridgeRunning: true,
      bridgeLinked: true,
    });
    expect(h2.tone).toBe("connected");
    expect(h2.badgeTone).toBe("ok");
    expect(h2.bridgeLinked).toBe(true);
  });

  it("feishu: draft invalid app_id cannot look connected", () => {
    const fs = inst("feishu", {
      hasCredentials: true,
      enabled: true,
      options: { app_id: "cli_ok" },
    });
    const h = classifyChannelHealth({
      instance: fs,
      bridgeRunning: true,
      bridgeLinked: true,
      draftOptions: { app_id: "bad id", domain: "custom" },
      appIdValue: "bad id",
    });
    expect(h.credentialsReady).toBe(false);
    expect(h.tone).not.toBe("connected");
    expect(h.hintKeys.some((k) => k.includes("feishuAppIdFormat"))).toBe(true);
  });

  it("feishu: lark domain hint + ready ws", () => {
    const lk = inst("lark", {
      hasCredentials: true,
      enabled: true,
      options: { app_id: "cli_x", domain: "open.larksuite.com" },
    });
    const h = classifyChannelHealth({
      instance: lk,
      bridgeRunning: true,
      bridgeLinked: true,
    });
    expect(h.credentialsReady).toBe(true);
    expect(h.tone).toBe("connected");
    expect(h.modeLabel).toBe("ws;domain=lark");
    expect(h.hintKeys.some((k) => k.includes("feishuLarkDomain"))).toBe(true);
    expect(h.hintKeys.some((k) => k.includes("feishuWs"))).toBe(true);
  });

  it("telegram: long_poll health with proxy and ACL hints", () => {
    expect(channelHasDeepHealth("telegram")).toBe(true);
    const tg = inst("telegram", {
      hasCredentials: true,
      enabled: true,
      options: { proxy: "socks5://127.0.0.1:1080" },
      acl: {
        allowFrom: "*",
        requireMention: true,
        groupOnly: false,
        shareSessionInChannel: false,
      },
      lastError: "auth token=LEAKME failed",
    });
    const h = classifyChannelHealth({
      instance: tg,
      bridgeRunning: true,
      bridgeLinked: true,
    });
    expect(h.tone).toBe("error");
    expect(h.transport).toBe("long_poll");
    expect(h.modeLabel).toBe("proxy=set");
    expect(h.lastError).toBeTruthy();
    expect(h.lastError!).not.toContain("LEAKME");
    expect(h.hintKeys.some((k) => k.includes("telegramPoll"))).toBe(true);
    expect(h.hintKeys.some((k) => k.includes("telegramProxy"))).toBe(true);
  });

  it("error tone when lastError set", () => {
    const i = inst("feishu", {
      hasCredentials: true,
      enabled: true,
      options: { app_id: "cli_x" },
      lastError: "ws closed",
    });
    const h = classifyChannelHealth({
      instance: i,
      bridgeRunning: true,
      bridgeLinked: true,
    });
    expect(h.tone).toBe("error");
    expect(h.badgeTone).toBe("err");
  });
});
