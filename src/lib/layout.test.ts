import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  loadLayout,
  parseLayout,
  saveLayout,
  clampAsideWidth,
  asideChromeSafeMin,
  asideSurfaceFromPreviewKind,
  suggestAsideWidth,
  mergeAsideWidth,
  requiredWorkbenchInnerWidth,
  ASIDE_WIDTH_MIN,
  ASIDE_WIDTH_MAX,
  MAIN_CHAT_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  WINDOW_CONTROLS_INSET,
  LAYOUT_STORAGE_KEY,
  withMirrorPhoneDrawerDefault,
  MIRROR_DRAWER_BREAKPOINT,
  isPhoneViewport,
  isMirrorPhoneLayout,
} from "./layout";

describe("layout prefs", () => {
  it("defaults right pane collapsed", () => {
    expect(DEFAULT_LAYOUT.asideCollapsed).toBe(true);
  });

  it("round-trips widths; right pane always starts collapsed", () => {
    const data: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
    saveLayout(storage, {
      sidebarWidth: 280,
      asideWidth: 420,
      asideCollapsed: false,
      sidebarCollapsed: true,
    });
    expect(data[LAYOUT_STORAGE_KEY]).toBeTruthy();
    const loaded = loadLayout(storage);
    // Open state is not restored across app launches.
    expect(loaded.asideCollapsed).toBe(true);
    expect(loaded.sidebarWidth).toBe(280);
    expect(loaded.asideWidth).toBe(420);
    expect(loaded.sidebarCollapsed).toBe(true);
  });

  it("parseLayout falls back safely", () => {
    expect(parseLayout(null).asideCollapsed).toBe(true);
    expect(parseLayout(null).sidebarCollapsed).toBe(false);
  });

  it("clamps aside width to chrome-safe min / max", () => {
    expect(clampAsideWidth(100)).toBe(ASIDE_WIDTH_MIN);
    expect(clampAsideWidth(9999)).toBe(ASIDE_WIDTH_MAX);
    expect(clampAsideWidth(400)).toBe(400);
  });

  it("raises chrome-safe min when window controls are present", () => {
    const plain = asideChromeSafeMin();
    const withWin = asideChromeSafeMin({
      windowControlsInset: WINDOW_CONTROLS_INSET,
    });
    expect(withWin).toBeGreaterThan(plain);
    expect(withWin).toBeGreaterThanOrEqual(ASIDE_WIDTH_MIN + WINDOW_CONTROLS_INSET * 0.5);
    expect(
      clampAsideWidth(300, { windowControlsInset: WINDOW_CONTROLS_INSET }),
    ).toBe(withWin);
  });

  it("caps max by viewport so main chat keeps ≥400px", () => {
    const w = clampAsideWidth(700, { viewportWidth: 900 });
    // 900 - 400 chat min = 500
    expect(w).toBeLessThanOrEqual(500);
    expect(w).toBeGreaterThanOrEqual(ASIDE_WIDTH_MIN);
  });

  it("subtracts open sidebar when capping aside so chat stays ≥400px", () => {
    // 1200 viewport, 268 sidebar, 400 chat → aside max 532
    const w = clampAsideWidth(700, {
      viewportWidth: 1200,
      sidebarOccupiedWidth: 268,
    });
    expect(w).toBeLessThanOrEqual(1200 - 268 - 400);
    expect(w).toBe(532);
  });

  it("requiredWorkbenchInnerWidth sums open panes + chat floor", () => {
    expect(
      requiredWorkbenchInnerWidth({
        sidebarCollapsed: true,
        asideCollapsed: true,
      }),
    ).toBe(MAIN_CHAT_MIN_WIDTH);
    expect(
      requiredWorkbenchInnerWidth({
        sidebarCollapsed: false,
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        asideCollapsed: true,
      }),
    ).toBe(SIDEBAR_DEFAULT_WIDTH + MAIN_CHAT_MIN_WIDTH);
    expect(
      requiredWorkbenchInnerWidth({
        sidebarCollapsed: false,
        sidebarWidth: 268,
        asideCollapsed: false,
        asideWidth: 400,
      }),
    ).toBe(268 + MAIN_CHAT_MIN_WIDTH + 400);
  });

  it("maps preview kinds to surfaces", () => {
    expect(asideSurfaceFromPreviewKind("markdown")).toBe("markdown");
    expect(asideSurfaceFromPreviewKind("code")).toBe("code");
    expect(asideSurfaceFromPreviewKind("docx")).toBe("office");
    expect(asideSurfaceFromPreviewKind("pdf")).toBe("pdf");
    expect(asideSurfaceFromPreviewKind(null)).toBe("empty");
  });

  it("suggests wider pane for code / video / tree split", () => {
    const empty = suggestAsideWidth({
      surface: "empty",
      treeVisible: false,
      tabCount: 0,
    });
    const code = suggestAsideWidth({
      surface: "code",
      treeVisible: false,
      tabCount: 1,
    });
    const codeTree = suggestAsideWidth({
      surface: "code",
      treeVisible: true,
      tabCount: 1,
    });
    const video = suggestAsideWidth({
      surface: "video",
      treeVisible: false,
      tabCount: 1,
    });
    expect(code).toBeGreaterThan(empty);
    expect(codeTree).toBeGreaterThan(code);
    expect(video).toBeGreaterThanOrEqual(code);
  });

  it("mergeAsideWidth soft-grows and never drops below chrome min", () => {
    expect(mergeAsideWidth(400, 500)).toBe(500);
    expect(mergeAsideWidth(560, 420)).toBe(560); // keep wider user size
    expect(
      mergeAsideWidth(200, 200, {
        windowControlsInset: WINDOW_CONTROLS_INSET,
      }),
    ).toBe(
      asideChromeSafeMin({ windowControlsInset: WINDOW_CONTROLS_INSET }),
    );
  });

  it("mirror phone viewport starts with drawer collapsed", () => {
    const open = { ...DEFAULT_LAYOUT, sidebarCollapsed: false };
    const at390 = withMirrorPhoneDrawerDefault(open, {
      isMirror: true,
      viewportWidth: 390,
    });
    expect(at390.sidebarCollapsed).toBe(true);

    const atBreakpoint = withMirrorPhoneDrawerDefault(open, {
      isMirror: true,
      viewportWidth: MIRROR_DRAWER_BREAKPOINT,
    });
    expect(atBreakpoint.sidebarCollapsed).toBe(true);

    const desktopMirror = withMirrorPhoneDrawerDefault(open, {
      isMirror: true,
      viewportWidth: MIRROR_DRAWER_BREAKPOINT + 1,
    });
    expect(desktopMirror.sidebarCollapsed).toBe(false);

    const nonMirror = withMirrorPhoneDrawerDefault(open, {
      isMirror: false,
      viewportWidth: 390,
    });
    expect(nonMirror.sidebarCollapsed).toBe(false);
  });

  it("isPhoneViewport / isMirrorPhoneLayout gate phone chrome", () => {
    expect(isPhoneViewport(MIRROR_DRAWER_BREAKPOINT)).toBe(true);
    expect(isPhoneViewport(MIRROR_DRAWER_BREAKPOINT + 1)).toBe(false);
    expect(isMirrorPhoneLayout({ isMirror: true, viewportWidth: 390 })).toBe(
      true,
    );
    expect(isMirrorPhoneLayout({ isMirror: true, viewportWidth: 900 })).toBe(
      false,
    );
  });
});
