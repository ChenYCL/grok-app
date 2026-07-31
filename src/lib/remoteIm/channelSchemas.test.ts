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
    expect(secret?.helpKey).toBe("settings.remoteIm.feishu.appSecretHelp");
    const appId = feishu?.fields.find((f) => f.key === "app_id");
    expect(appId?.helpKey).toBe("settings.remoteIm.feishu.appIdHelp");
    expect(feishu?.fields.some((f) => f.key === "enable_feishu_card")).toBe(
      true,
    );
    const card = feishu?.fields.find((f) => f.key === "enable_feishu_card");
    expect(card?.helpKey).toBe("settings.remoteIm.feishu.enableCardHelp");
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
});
