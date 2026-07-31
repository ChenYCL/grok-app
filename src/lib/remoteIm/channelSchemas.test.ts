import { describe, expect, it } from "vitest";
import {
  CHANNEL_SCHEMAS,
  REQUIRED_CHANNEL_IDS,
  getChannelSchema,
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
    ).toBe(true);
  });

  it("LINE always shows public-URL callout when flagged", () => {
    const line = getChannelSchema("line")!;
    expect(showsPublicUrlCallout(line, {})).toBe(true);
  });

  it("feishu never shows public-URL callout", () => {
    const feishu = getChannelSchema("feishu")!;
    expect(showsPublicUrlCallout(feishu, {})).toBe(false);
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
