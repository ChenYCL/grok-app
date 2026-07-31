import { describe, expect, it } from "vitest";
import {
  CHANNEL_SCHEMAS,
  REQUIRED_CHANNEL_IDS,
  RETIRED_CHANNEL_IDS,
  filterActiveChannels,
  getChannelSchema,
  isRetiredChannel,
  parseIdSecretPair,
  showsPublicUrlCallout,
  validateBindFields,
  visibleFields,
} from "./channelSchemas";

describe("remoteIm channelSchemas", () => {
  it("includes every required sidebar channel id", () => {
    const ids = new Set(CHANNEL_SCHEMAS.map((c) => c.id));
    for (const id of REQUIRED_CHANNEL_IDS) {
      expect(ids.has(id), `missing channel ${id}`).toBe(true);
    }
  });

  it("excludes retired WPS channels from REQUIRED_CHANNEL_IDS", () => {
    for (const id of RETIRED_CHANNEL_IDS) {
      expect(REQUIRED_CHANNEL_IDS).not.toContain(id);
    }
    expect(isRetiredChannel("wps-xiezuo")).toBe(true);
    expect(isRetiredChannel("wps-agentspace")).toBe(true);
    expect(isRetiredChannel("feishu")).toBe(false);
    expect(isRetiredChannel(getChannelSchema("wps-xiezuo"))).toBe(true);
    expect(isRetiredChannel(null)).toBe(false);
  });

  it("marks WPS schemas retired/unsupported and not bindable", () => {
    for (const id of RETIRED_CHANNEL_IDS) {
      const s = getChannelSchema(id)!;
      expect(s.retired).toBe(true);
      expect(s.unsupported).toBe(true);
      expect(s.implemented).toBe(false);
      expect(validateBindFields(s, { app_id: "x", app_secret: "y" }).ok).toBe(
        false,
      );
      expect(validateBindFields(s, { app_id: "x", app_secret: "y" }).missing).toContain(
        "_retired",
      );
    }
  });

  it("filterActiveChannels hides retired unless legacy instances exist", () => {
    const active = filterActiveChannels();
    expect(active.some((c) => c.id === "wps-xiezuo")).toBe(false);
    expect(active.some((c) => c.id === "wps-agentspace")).toBe(false);
    expect(active.some((c) => c.id === "feishu")).toBe(true);
    expect(active.every((c) => !isRetiredChannel(c))).toBe(true);

    const withLegacy = filterActiveChannels(CHANNEL_SCHEMAS, {
      includeRetiredWithInstances: true,
      instances: [{ channel: "wps-xiezuo" }],
    });
    expect(withLegacy.some((c) => c.id === "wps-xiezuo")).toBe(true);
    expect(withLegacy.some((c) => c.id === "wps-agentspace")).toBe(false);
  });

  it("orders domestic then overseas then other groups", () => {
    const groups = CHANNEL_SCHEMAS.map((c) => c.group);
    const firstOverseas = groups.indexOf("overseas");
    const firstOther = groups.indexOf("other");
    const lastDomestic = groups.lastIndexOf("domestic");
    expect(lastDomestic).toBeLessThan(firstOverseas);
    expect(firstOverseas).toBeLessThan(firstOther);
  });

  it("feishu has §6.1 bind fields app_id and app_secret as password", () => {
    const feishu = getChannelSchema("feishu");
    expect(feishu?.implemented).toBe(true);
    expect(feishu?.scanSupport).toBe(true);
    const secret = feishu?.fields.find((f) => f.key === "app_secret");
    expect(secret?.control).toBe("password");
    expect(secret?.secret).toBe(true);
    expect(feishu?.fields.some((f) => f.key === "app_id")).toBe(true);
    expect(feishu?.fields.some((f) => f.key === "enable_feishu_card")).toBe(
      true,
    );
  });

  it("wecom switches fields by connect_mode", () => {
    const wecom = getChannelSchema("wecom")!;
    const ws = visibleFields(wecom, { connect_mode: "websocket" }, "bind");
    expect(ws.some((f) => f.key === "bot_id")).toBe(true);
    expect(ws.some((f) => f.key === "corp_id")).toBe(false);
    const wh = visibleFields(wecom, { connect_mode: "webhook" }, "bind");
    expect(wh.some((f) => f.key === "corp_id")).toBe(true);
    expect(wh.some((f) => f.key === "bot_id")).toBe(false);
  });

  it("wecom public-URL callout only in webhook mode (§6.8)", () => {
    const wecom = getChannelSchema("wecom")!;
    expect(wecom.needsPublicUrl).toBe(true);
    expect(
      showsPublicUrlCallout(wecom, { connect_mode: "websocket" }),
    ).toBe(false);
    expect(
      showsPublicUrlCallout(wecom, { connect_mode: "webhook" }),
    ).toBe(true);
  });

  it("weixin §6.9: long-poll, scan+paste, token bind field help", () => {
    const wx = getChannelSchema("weixin")!;
    expect(wx.implemented).toBe(true);
    expect(wx.scanSupport).toBe(true);
    expect(wx.pasteSupport).toBe(true);
    expect(wx.connectionKey).toContain("longPoll");
    expect(wx.needsPublicUrl).toBeFalsy();
    expect(showsPublicUrlCallout(wx, {})).toBe(false);
    const token = wx.fields.find((f) => f.key === "token");
    expect(token?.secret).toBe(true);
    expect(token?.helpKey).toBe("settings.remoteIm.weixin.tokenHelp");
    expect(wx.fields.some((f) => f.key === "long_poll_timeout_ms")).toBe(true);
    expect(
      validateBindFields(wx, {}, { hasCredentials: false }).ok,
    ).toBe(false);
    expect(
      validateBindFields(wx, {}, {
        hasCredentials: false,
        secretKeysFilled: new Set(["token"]),
      }).ok,
    ).toBe(true);
  });

  it("wecom validateBindFields is mode-aware and honest on mode switch", () => {
    const wecom = getChannelSchema("wecom")!;
    expect(
      validateBindFields(wecom, {
        connect_mode: "websocket",
        bot_id: "b1",
        bot_secret: "s1",
      }).ok,
    ).toBe(true);
    expect(
      validateBindFields(wecom, {
        connect_mode: "webhook",
        corp_id: "ww",
        agent_id: "1",
        corp_secret: "cs",
        callback_token: "ct",
      }).ok,
    ).toBe(true);

    // Incomplete webhook
    expect(
      validateBindFields(wecom, {
        connect_mode: "webhook",
        corp_id: "ww",
      }).ok,
    ).toBe(false);

    // Vault reuse only for secrets that were already visible under saved mode
    const switched = validateBindFields(
      wecom,
      {
        connect_mode: "webhook",
        corp_id: "ww",
        agent_id: "1",
      },
      {
        hasCredentials: true,
        savedValues: { connect_mode: "websocket", bot_id: "b" },
      },
    );
    expect(switched.ok).toBe(false);
    expect(switched.missing).toContain("corp_secret");
    expect(switched.missing).toContain("callback_token");

    const sameMode = validateBindFields(
      wecom,
      {
        connect_mode: "websocket",
        bot_id: "b1",
      },
      {
        hasCredentials: true,
        savedValues: { connect_mode: "websocket", bot_id: "b1" },
      },
    );
    expect(sameMode.ok).toBe(true);
  });

  it("wecom schema documents mode help + §6.8 fields", () => {
    const wecom = getChannelSchema("wecom")!;
    expect(wecom.implemented).toBe(true);
    expect(wecom.scanSupport).toBe(false);
    expect(wecom.pasteSupport).toBe(true);
    const mode = wecom.fields.find((f) => f.key === "connect_mode");
    expect(mode?.helpKey).toBe("settings.remoteIm.wecom.modeHelp");
    expect(wecom.fields.some((f) => f.key === "encoding_aes_key")).toBe(true);
    expect(wecom.fields.some((f) => f.key === "enable_markdown")).toBe(true);
  });

  it("slack requires dual Socket Mode tokens and never needs public URL", () => {
    const slack = getChannelSchema("slack")!;
    expect(slack.implemented).toBe(true);
    expect(slack.scanSupport).toBe(false);
    expect(slack.pasteSupport).toBe(true);
    expect(slack.needsPublicUrl).toBeFalsy();
    expect(showsPublicUrlCallout(slack, {})).toBe(false);
    expect(slack.connectionKey).toContain("socketMode");

    const bot = slack.fields.find((f) => f.key === "bot_token");
    const app = slack.fields.find((f) => f.key === "app_token");
    expect(bot?.secret).toBe(true);
    expect(bot?.required).toBe(true);
    expect(bot?.helpKey).toBe("settings.remoteIm.slack.botTokenHelp");
    expect(app?.secret).toBe(true);
    expect(app?.required).toBe(true);
    expect(app?.helpKey).toBe("settings.remoteIm.slack.appTokenHelp");

    expect(
      validateBindFields(slack, {
        bot_token: ["xoxb", "1"].join("-"),
        app_token: ["xapp", "1"].join("-"),
      }).ok,
    ).toBe(true);
    expect(
      validateBindFields(slack, { bot_token: ["xoxb", "1"].join("-") }).ok,
    ).toBe(false);
    expect(
      validateBindFields(slack, {}, { hasCredentials: true }).ok,
  it("qq OneBot schema: required ws_url, optional token, forward WS, no public URL", () => {
    const qq = getChannelSchema("qq")!;
    expect(qq.implemented).toBe(true);
    expect(qq.scanSupport).toBe(false);
    expect(qq.pasteSupport).toBe(true);
    expect(qq.connectionKey).toContain("forwardWs");
    const ws = qq.fields.find((f) => f.key === "ws_url");
    expect(ws?.required).toBe(true);
    expect(ws?.secret).not.toBe(true);
    expect(ws?.helpKey).toBe("settings.remoteIm.qq.wsUrlHelp");
    const tok = qq.fields.find((f) => f.key === "token");
    expect(tok?.secret).toBe(true);
    expect(tok?.required).not.toBe(true);
    expect(tok?.helpKey).toBe("settings.remoteIm.qq.tokenHelp");
    expect(showsPublicUrlCallout(qq, {})).toBe(false);
    expect(validateBindFields(qq, {}).ok).toBe(false);
    expect(
      validateBindFields(qq, { ws_url: "ws://127.0.0.1:3001" }).ok,
    ).toBe(true);
    // Token optional
    expect(
      validateBindFields(qq, {
        ws_url: "ws://127.0.0.1:3001",
        token: "optional",
      }).ok,
    ).toBe(true);
  it("qqbot official schema: app_id + app_secret, gateway, default INTERACTION, no public URL", () => {
    const qqbot = getChannelSchema("qqbot")!;
    expect(qqbot.implemented).toBe(true);
    expect(qqbot.scanSupport).toBe(false);
    expect(qqbot.pasteSupport).toBe(true);
    expect(qqbot.connectionKey).toContain("gateway");
    const appId = qqbot.fields.find((f) => f.key === "app_id");
    expect(appId?.required).toBe(true);
    expect(appId?.secret).not.toBe(true);
    expect(appId?.helpKey).toBe("settings.remoteIm.qqbot.appIdHelp");
    const secret = qqbot.fields.find((f) => f.key === "app_secret");
    expect(secret?.required).toBe(true);
    expect(secret?.secret).toBe(true);
    expect(secret?.helpKey).toBe("settings.remoteIm.qqbot.appSecretHelp");
    const intents = qqbot.fields.find((f) => f.key === "intents");
    expect(intents?.required).not.toBe(true);
    expect(intents?.helpKey).toBe("settings.remoteIm.qqbot.intentsHelp");
    expect(showsPublicUrlCallout(qqbot, {})).toBe(false);
    expect(validateBindFields(qqbot, {}).ok).toBe(false);
    expect(
      validateBindFields(qqbot, {
        app_id: "102012345",
        app_secret: "sec",
      }).ok,
    ).toBe(true);
    // Distinct from OneBot `qq`
    const qq = getChannelSchema("qq")!;
    expect(qq.connectionKey).toContain("forwardWs");
    expect(qqbot.id).not.toBe(qq.id);
  });

  it("LINE always shows public-URL callout when flagged", () => {
    const line = getChannelSchema("line")!;
    expect(line.needsPublicUrl).toBe(true);
    expect(line.implemented).toBe(true);
    expect(line.pasteSupport).toBe(true);
    expect(line.scanSupport).toBe(false);
    expect(showsPublicUrlCallout(line, {})).toBe(true);
    expect(line.fields.some((f) => f.key === "channel_secret")).toBe(true);
    expect(line.fields.some((f) => f.key === "channel_access_token")).toBe(
      true,
    );
    expect(line.fields.find((f) => f.key === "port")?.defaultValue).toBe(8081);
    expect(
      line.fields.find((f) => f.key === "callback_path")?.defaultValue,
    ).toBe("/line/callback");
    expect(line.fields.find((f) => f.key === "channel_secret")?.helpKey).toBe(
      "settings.remoteIm.line.channelSecretHelp",
    );
  });

  it("feishu never shows public-URL callout", () => {
    const feishu = getChannelSchema("feishu")!;
    expect(showsPublicUrlCallout(feishu, {})).toBe(false);
  });

  it("weibo §6.13: app_id + app_secret + advanced endpoints, no public URL", () => {
    const weibo = getChannelSchema("weibo")!;
    expect(weibo.implemented).toBe(true);
    expect(weibo.scanSupport).toBe(false);
    expect(weibo.pasteSupport).toBe(true);
    expect(showsPublicUrlCallout(weibo, {})).toBe(false);
    expect(weibo.fields.some((f) => f.key === "app_id" && f.required)).toBe(
      true,
    );
    const secret = weibo.fields.find((f) => f.key === "app_secret");
    expect(secret?.secret).toBe(true);
    expect(secret?.control).toBe("password");
    expect(weibo.fields.some((f) => f.key === "token_endpoint")).toBe(true);
    expect(weibo.fields.some((f) => f.key === "ws_endpoint")).toBe(true);
    expect(weibo.fields.find((f) => f.key === "app_id")?.helpKey).toBe(
      "settings.remoteIm.weibo.appIdHelp",
    );
  });


  it("rejects credential submit when schema not implemented", () => {
    const fake = {
      ...getChannelSchema("line")!,
      implemented: false,
    };
    const r = validateBindFields(fake, {
      channel_secret: "x",
      channel_access_token: "y",
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("_not_implemented");
  });

  it("validates required feishu bind fields", () => {
    const feishu = getChannelSchema("feishu")!;
    expect(validateBindFields(feishu, {}).ok).toBe(false);
    expect(
      validateBindFields(feishu, {
        app_id: "cli_x",
        app_secret: "sec",
        domain: "open.feishu.cn",
      }).ok,
    ).toBe(true);
  });

  it("parses cli_id:secret paste pairs", () => {
    expect(parseIdSecretPair("cli_abc:s3cret")).toEqual({
      app_id: "cli_abc",
      app_secret: "s3cret",
    });
    expect(parseIdSecretPair("nope")).toBeNull();
  });

  it("marks secret fields with password control for implemented channels", () => {
    for (const schema of CHANNEL_SCHEMAS.filter((c) => c.implemented)) {
      for (const f of schema.fields) {
        if (f.secret) {
          expect(f.control, `${schema.id}.${f.key}`).toBe("password");
        }
      }
    }
  });
});
