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

  it("telegram schema documents long-poll bind + proxy fields (§6.5)", () => {
    const tg = getChannelSchema("telegram")!;
    expect(tg.implemented).toBe(true);
    expect(tg.scanSupport).toBe(false);
    expect(tg.pasteSupport).toBe(true);
    expect(tg.needsPublicUrl).toBeFalsy();
    expect(tg.connectionKey).toContain("longPoll");
    const token = tg.fields.find((f) => f.key === "token");
    expect(token?.secret).toBe(true);
    expect(token?.helpKey).toBe("settings.remoteIm.telegram.tokenHelp");
    expect(tg.fields.some((f) => f.key === "proxy")).toBe(true);
    expect(tg.fields.some((f) => f.key === "proxy_username")).toBe(true);
    expect(tg.fields.some((f) => f.key === "proxy_password")).toBe(true);
    expect(tg.fields.some((f) => f.key === "thread_isolation")).toBe(true);
    expect(showsPublicUrlCallout(tg, {})).toBe(false);
  });

  it("telegram validateBindFields requires token", () => {
    const tg = getChannelSchema("telegram")!;
    expect(validateBindFields(tg, {}).ok).toBe(false);
    expect(
      validateBindFields(tg, {
        token: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      }).ok,
    ).toBe(true);
    expect(
      validateBindFields(
        tg,
        {},
        { hasCredentials: true, secretKeysFilled: new Set() },
      ).ok,
    ).toBe(true);
  });
});
