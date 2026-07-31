import { describe, expect, it } from "vitest";
import {
  MAIN_WINDOW_LABEL,
  buildSessionDeepLinkHash,
  canLiveParticipate,
  canOpenSessionInNewWindow,
  isMainWindowLabel,
  isSessionWindowLabel,
  parseSessionDeepLinkHash,
  parseSessionWindowLabel,
  resolveSecondarySessionId,
  sanitizeSessionIdForLabel,
  sessionWindowLabel,
  shouldSkipAgentSpawn,
  shouldSkipWarmConnect,
} from "./multiWindow";

const UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("multiWindow", () => {
  it("sanitizes session ids for labels (UUID-safe)", () => {
    expect(sanitizeSessionIdForLabel(UUID)).toBe(UUID);
    expect(sanitizeSessionIdForLabel(`  ${UUID}  `)).toBe(UUID);
    expect(sanitizeSessionIdForLabel("")).toBeNull();
    expect(sanitizeSessionIdForLabel("bad id")).toBeNull();
    expect(sanitizeSessionIdForLabel("../etc")).toBeNull();
    expect(sanitizeSessionIdForLabel("a/b")).toBeNull();
  });

  it("builds and parses session window labels", () => {
    expect(sessionWindowLabel(UUID)).toBe(`session-${UUID}`);
    expect(parseSessionWindowLabel(`session-${UUID}`)).toBe(UUID);
    expect(parseSessionWindowLabel(MAIN_WINDOW_LABEL)).toBeNull();
    expect(parseSessionWindowLabel("session-")).toBeNull();
    expect(isSessionWindowLabel(`session-${UUID}`)).toBe(true);
    expect(isSessionWindowLabel(MAIN_WINDOW_LABEL)).toBe(false);
    expect(isMainWindowLabel(MAIN_WINDOW_LABEL)).toBe(true);
    expect(isMainWindowLabel(`session-${UUID}`)).toBe(false);
  });

  it("builds and parses #/session/<id> deep links", () => {
    expect(buildSessionDeepLinkHash(UUID)).toBe(`#/session/${UUID}`);
    expect(parseSessionDeepLinkHash(`#/session/${UUID}`)).toBe(UUID);
    expect(parseSessionDeepLinkHash(`/session/${UUID}`)).toBe(UUID);
    expect(parseSessionDeepLinkHash(`session/${UUID}`)).toBe(UUID);
    expect(parseSessionDeepLinkHash(`#/session/${UUID}?x=1`)).toBe(UUID);
    expect(parseSessionDeepLinkHash("#/settings/general")).toBeNull();
    expect(parseSessionDeepLinkHash("#/workbench")).toBeNull();
    expect(parseSessionDeepLinkHash("")).toBeNull();
    expect(buildSessionDeepLinkHash("bad id")).toBe("");
  });

  it("resolves secondary focus from hash then label", () => {
    expect(
      resolveSecondarySessionId({
        hash: `#/session/${UUID}`,
        windowLabel: "session-other",
      }),
    ).toBe(UUID);
    expect(
      resolveSecondarySessionId({
        hash: "#/workbench",
        windowLabel: `session-${UUID}`,
      }),
    ).toBe(UUID);
    expect(
      resolveSecondarySessionId({ hash: "", windowLabel: "main" }),
    ).toBeNull();
  });

  it("gates open-in-new-window to desktop main only", () => {
    expect(
      canOpenSessionInNewWindow({
        isDesktopHost: true,
        isSecondaryWindow: false,
        sessionId: UUID,
      }),
    ).toBe(true);
    expect(
      canOpenSessionInNewWindow({
        isDesktopHost: false,
        isSecondaryWindow: false,
        sessionId: UUID,
      }),
    ).toBe(false);
    expect(
      canOpenSessionInNewWindow({
        isDesktopHost: true,
        isSecondaryWindow: true,
        sessionId: UUID,
      }),
    ).toBe(false);
    expect(
      canOpenSessionInNewWindow({
        isDesktopHost: true,
        isSecondaryWindow: false,
        sessionId: "",
      }),
    ).toBe(false);
  });

  it("skips only passive warm-connect in secondary (MULTI-WIN-LITE)", () => {
    expect(shouldSkipWarmConnect(true)).toBe(true);
    expect(shouldSkipWarmConnect(false)).toBe(false);
    // Deprecated alias tracks warm-connect, not send/stop.
    expect(shouldSkipAgentSpawn(true)).toBe(true);
    expect(shouldSkipAgentSpawn(false)).toBe(false);
  });

  it("allows live send/stop from main and secondary (shared Host)", () => {
    expect(canLiveParticipate(false)).toBe(true);
    expect(canLiveParticipate(true)).toBe(true);
  });
});
