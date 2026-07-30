import { describe, expect, it } from "vitest";
import {
  formatPluginValidateMessages,
  isLocalPluginPath,
  isPluginValidateCliTooOld,
  looksLikeUnsupportedPluginValidate,
  parsePluginValidateMessages,
  parsePluginValidateOutput,
  pluginValidateTarget,
} from "./pluginValidate";

describe("parsePluginValidateMessages", () => {
  it("splits non-empty lines; stderr before stdout; dedupes", () => {
    expect(
      parsePluginValidateMessages(
        "Plugin manifest is valid.\n  name: demo\n",
        "  name: demo\n",
      ),
    ).toEqual(["name: demo", "Plugin manifest is valid."]);
  });

  it("handles empty / null", () => {
    expect(parsePluginValidateMessages("", "")).toEqual([]);
    expect(parsePluginValidateMessages(null, undefined)).toEqual([]);
  });
});

describe("parsePluginValidateOutput", () => {
  it("ok follows exit status even when messages look soft", () => {
    const noManifest =
      "No plugin.json found. Grok discovers skills, agents, and hooks automatically from standard directories. A manifest is only needed for custom paths or metadata.";
    expect(parsePluginValidateOutput(noManifest, "", true)).toEqual({
      ok: true,
      messages: [noManifest],
    });
  });

  it("failed parse is not ok", () => {
    const err =
      "Error: Failed to load manifest: failed to parse /tmp/bad/plugin.json: missing field `name`";
    const r = parsePluginValidateOutput("", err, false);
    expect(r.ok).toBe(false);
    expect(r.messages[0]).toContain("missing field `name`");
  });
});

describe("looksLikeUnsupportedPluginValidate", () => {
  it("detects clap unrecognized subcommand", () => {
    expect(
      looksLikeUnsupportedPluginValidate(
        "error: unrecognized subcommand 'validate'\n\nUsage: grok plugin [OPTIONS] <COMMAND>",
        "",
      ),
    ).toBe(true);
  });

  it("detects unexpected argument validate", () => {
    expect(
      looksLikeUnsupportedPluginValidate(
        "error: unexpected argument 'validate' found",
        "",
      ),
    ).toBe(true);
  });

  it("ignores normal validate failures", () => {
    expect(
      looksLikeUnsupportedPluginValidate(
        "Error: Not a directory: /nope",
        "",
      ),
    ).toBe(false);
    expect(
      looksLikeUnsupportedPluginValidate(
        "Error: Failed to load manifest: missing field `name`",
        "",
      ),
    ).toBe(false);
  });
});

describe("isPluginValidateCliTooOld", () => {
  it("uses reason field", () => {
    expect(
      isPluginValidateCliTooOld({
        reason: "cli_too_old",
        messages: [],
      }),
    ).toBe(true);
  });

  it("falls back to message text", () => {
    expect(
      isPluginValidateCliTooOld({
        reason: null,
        messages: [
          "This Grok CLI does not support `plugin validate`. Update the CLI and restart the app.",
        ],
      }),
    ).toBe(true);
  });
});

describe("formatPluginValidateMessages", () => {
  it("joins lines and uses fallback", () => {
    expect(formatPluginValidateMessages(["a", "b"])).toBe("a\nb");
    expect(formatPluginValidateMessages([], "none")).toBe("none");
  });
});

describe("isLocalPluginPath", () => {
  it("accepts filesystem paths", () => {
    expect(isLocalPluginPath("/tmp/my-plugin")).toBe(true);
    expect(isLocalPluginPath("~/code/plugin")).toBe(true);
    expect(isLocalPluginPath("./plugin")).toBe(true);
    expect(isLocalPluginPath("../plugin")).toBe(true);
    expect(isLocalPluginPath("C:\\Users\\a\\plugin")).toBe(true);
    expect(isLocalPluginPath("D:/plugins/x")).toBe(true);
  });

  it("rejects git / marketplace / bare names", () => {
    expect(isLocalPluginPath("owner/repo")).toBe(false);
    expect(isLocalPluginPath("vercel@xAI Official")).toBe(false);
    expect(isLocalPluginPath("https://github.com/a/b.git")).toBe(false);
    expect(isLocalPluginPath("git@github.com:a/b.git")).toBe(false);
    expect(isLocalPluginPath("chrome-devtools-mcp")).toBe(false);
    expect(isLocalPluginPath("")).toBe(false);
  });
});

describe("pluginValidateTarget", () => {
  it("prefers path over name", () => {
    expect(
      pluginValidateTarget({
        name: "demo",
        path: "/p/demo",
      }),
    ).toBe("/p/demo");
    expect(pluginValidateTarget({ name: "demo", path: null })).toBe("demo");
  });
});
