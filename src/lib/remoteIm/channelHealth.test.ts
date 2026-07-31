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
      "domain=feishu",
    );
    expect(channelModeLabel("lark", { domain: "lark" })).toBe("domain=lark");
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

    const cfg = inst("feishu", {
      hasCredentials: true,
      enabled: true,
      options: { app_id: "cli_x", domain: "feishu" },
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
    expect(h1.modeLabel).toBe("domain=feishu");
    expect(h1.hintKeys.some((k) => k.includes("openAcl"))).toBe(true);

    const h2 = classifyChannelHealth({
      instance: cfg,
      bridgeRunning: true,
      bridgeLinked: true,
    });
    expect(h2.tone).toBe("connected");
    expect(h2.badgeTone).toBe("ok");
    expect(h2.bridgeLinked).toBe(true);
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

  it("wecom: deep health is mode-aware (ws vs webhook)", () => {
    expect(channelHasDeepHealth("wecom")).toBe(true);

    const bare = inst("wecom", {
      hasCredentials: false,
      enabled: false,
      options: { connect_mode: "websocket" },
    });
    const h0 = classifyChannelHealth({
      instance: bare,
      bridgeRunning: false,
    });
    expect(h0.tone).toBe("unconfigured");
    expect(h0.transport).toBe("websocket");
    expect(h0.modeLabel).toBe("mode=websocket");
    expect(h0.credentialsReady).toBe(false);
    expect(h0.hintKeys.some((k) => k.includes("wecomWs"))).toBe(true);
    expect(h0.hintKeys.some((k) => k.includes("wecomPublicUrl"))).toBe(false);

    const wsReady = inst("wecom", {
      hasCredentials: true,
      enabled: true,
      options: { connect_mode: "websocket", bot_id: "b1" },
      acl: {
        allowFrom: "*",
        requireMention: true,
        groupOnly: false,
        shareSessionInChannel: false,
      },
    });
    const h1 = classifyChannelHealth({
      instance: wsReady,
      bridgeRunning: true,
      bridgeLinked: true,
    });
    expect(h1.credentialsReady).toBe(true);
    expect(h1.tone).toBe("connected");
    expect(h1.transport).toBe("websocket");
    expect(h1.hintKeys.some((k) => k.includes("wecomWs"))).toBe(true);
    expect(h1.openAcl).toBe(true);

    // Draft mode switch to webhook without new secrets → not ready, not "connected"
    const h2 = classifyChannelHealth({
      instance: wsReady,
      bridgeRunning: true,
      bridgeLinked: true,
      draftOptions: {
        connect_mode: "webhook",
        corp_id: "ww",
        agent_id: "1",
      },
    });
    expect(h2.transport).toBe("webhook");
    expect(h2.modeLabel).toBe("mode=webhook");
    expect(h2.credentialsReady).toBe(false);
    expect(h2.tone).not.toBe("connected");
    expect(h2.hintKeys.some((k) => k.includes("wecomModeSwitch"))).toBe(true);
    expect(h2.hintKeys.some((k) => k.includes("wecomPublicUrl"))).toBe(true);
  });

  it("wecom credentialReadiness ignores corp secrets in websocket mode", () => {
    const i = inst("wecom", {
      hasCredentials: false,
      options: { connect_mode: "websocket", bot_id: "b" },
    });
    const r = credentialReadiness("wecom", i, new Set(["bot_secret"]));
    expect(r.ready).toBe(true);
    expect(r.missingKeys).not.toContain("corp_secret");
  });

  it("weixin: deep health is long-poll / ilink honest", () => {
    expect(channelHasDeepHealth("weixin")).toBe(true);
    expect(transportForChannel("weixin")).toBe("long_poll");

    const bare = inst("weixin", {
      hasCredentials: false,
      enabled: false,
      options: {},
    });
    const h0 = classifyChannelHealth({
      instance: bare,
      bridgeRunning: false,
    });
    expect(h0.tone).toBe("unconfigured");
    expect(h0.transport).toBe("long_poll");
    expect(h0.credentialsReady).toBe(false);
    expect(h0.hintKeys.some((k) => k.includes("weixinPoll"))).toBe(true);
    expect(h0.hintKeys.some((k) => k.includes("weixinNoPublicUrl"))).toBe(true);
    expect(h0.hintKeys.some((k) => k.includes("weixinMissingToken"))).toBe(
      true,
    );

    const ready = inst("weixin", {
      hasCredentials: true,
      enabled: true,
      options: { account_id: "default", proxy: "socks5://127.0.0.1:1" },
      acl: {
        allowFrom: "*",
        requireMention: true,
        groupOnly: false,
        shareSessionInChannel: false,
      },
    });
    const h1 = classifyChannelHealth({
      instance: ready,
      bridgeRunning: true,
      bridgeLinked: true,
    });
    expect(h1.credentialsReady).toBe(true);
    expect(h1.tone).toBe("connected");
    expect(h1.modeLabel).toContain("mode=ilink");
    expect(h1.modeLabel).toContain("proxy=set");
    expect(h1.hintKeys.some((k) => k.includes("weixinTextMenu"))).toBe(true);
    expect(h1.openAcl).toBe(true);
  });

  it("weixin credentialReadiness needs token or vault", () => {
    const bare = inst("weixin", { hasCredentials: false });
    expect(credentialReadiness("weixin", bare).ready).toBe(false);
    expect(
      credentialReadiness("weixin", bare, new Set(["token"])).ready,
    ).toBe(true);
    expect(
      credentialReadiness("weixin", inst("weixin", { hasCredentials: true }))
        .ready,
    ).toBe(true);
  });
});
