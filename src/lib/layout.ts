/**
 * Layout preferences: sidebar width, aside width, aside collapsed default.
 * Durable key in localStorage (App config later).
 */

export const LAYOUT_STORAGE_KEY = "grok-app.layout";

/** Mirror phone CSS drawer breakpoint (`app.css` max-width: 820px). */
export const MIRROR_DRAWER_BREAKPOINT = 820;

export interface LayoutPrefs {
  sidebarWidth: number;
  asideWidth: number;
  /** Right pane defaults collapsed per §17.1 / autoplan Design D7. */
  asideCollapsed: boolean;
  /** Left project rail collapsed (Codex-style). */
  sidebarCollapsed: boolean;
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  sidebarWidth: 260,
  asideWidth: 360,
  /** Right resource pane starts closed; open via top-bar files icon. */
  asideCollapsed: true,
  /** Left session rail starts open; can fully hide via top-bar panel icon. */
  sidebarCollapsed: false,
};

/** True when CSS phone drawer / phone chrome rules apply (≤ 820px). */
export function isPhoneViewport(width: number): boolean {
  return Number.isFinite(width) && width <= MIRROR_DRAWER_BREAKPOINT;
}

/**
 * Mirror client on a phone-width viewport — full phone chrome (drawer, sheets).
 * Desktop (≥ 821px) never enters this path.
 */
export function isMirrorPhoneLayout(opts: {
  isMirror: boolean;
  viewportWidth: number;
}): boolean {
  return opts.isMirror && isPhoneViewport(opts.viewportWidth);
}

/**
 * On mirror phone viewports the sidebar is a full-height drawer over chat.
 * Start collapsed so first paint shows the conversation; toggle still opens it.
 */
export function withMirrorPhoneDrawerDefault(
  layout: LayoutPrefs,
  opts: { isMirror: boolean; viewportWidth: number },
): LayoutPrefs {
  if (isMirrorPhoneLayout(opts)) {
    return { ...layout, sidebarCollapsed: true };
  }
  return layout;
}

export const ASIDE_WIDTH_MIN = 240;
export const ASIDE_WIDTH_MAX = 720;

export function clampAsideWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_LAYOUT.asideWidth;
  return Math.min(ASIDE_WIDTH_MAX, Math.max(ASIDE_WIDTH_MIN, Math.round(w)));
}

export function parseLayout(raw: unknown): LayoutPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LAYOUT };
  const o = raw as Record<string, unknown>;
  return {
    sidebarWidth:
      typeof o.sidebarWidth === "number" ? o.sidebarWidth : DEFAULT_LAYOUT.sidebarWidth,
    asideWidth:
      typeof o.asideWidth === "number"
        ? clampAsideWidth(o.asideWidth)
        : DEFAULT_LAYOUT.asideWidth,
    // Cold start always closed; open state is session-only (not restored).
    asideCollapsed: DEFAULT_LAYOUT.asideCollapsed,
    sidebarCollapsed:
      typeof o.sidebarCollapsed === "boolean"
        ? o.sidebarCollapsed
        : DEFAULT_LAYOUT.sidebarCollapsed,
  };
}

export function loadLayout(storage: {
  getItem(k: string): string | null;
}): LayoutPrefs {
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    return parseLayout(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(
  storage: { setItem(k: string, v: string): void },
  layout: LayoutPrefs,
): void {
  storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}
