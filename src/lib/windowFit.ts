/**
 * Grow the desktop window when workbench panes need more horizontal room.
 * No-op on mirror / browser / maximized / fullscreen.
 */

import { isDesktopHost } from "@/lib/api";
import {
  requiredWorkbenchInnerWidth,
  type LayoutPrefs,
} from "@/lib/layout";

/** Small padding so chrome / scrollbars do not immediately re-clamp. */
const FIT_PAD = 8;

/**
 * Ensure the main window's logical inner width is at least `minLogicalWidth`.
 * Returns the applied width, or null when unchanged / unavailable.
 */
export async function ensureWindowInnerWidth(
  minLogicalWidth: number,
): Promise<number | null> {
  if (!isDesktopHost()) return null;
  if (!Number.isFinite(minLogicalWidth) || minLogicalWidth <= 0) return null;

  try {
    const { getCurrentWindow, currentMonitor } = await import(
      "@tauri-apps/api/window"
    );
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    const win = getCurrentWindow();

    if (await win.isMaximized()) return null;
    try {
      if (await win.isFullscreen()) return null;
    } catch {
      /* older / platform without fullscreen probe */
    }

    const physical = await win.innerSize();
    const factor = await win.scaleFactor();
    if (!(factor > 0)) return null;
    const curW = physical.width / factor;
    const curH = physical.height / factor;
    const target = Math.ceil(minLogicalWidth + FIT_PAD);
    if (curW + 0.5 >= target) return null;

    // Prefer not to exceed the current monitor work area.
    let capped = target;
    try {
      const mon = await currentMonitor();
      if (mon?.workArea && mon.scaleFactor > 0) {
        const workW = mon.workArea.size.width / mon.scaleFactor;
        if (Number.isFinite(workW) && workW > 0) {
          capped = Math.min(capped, Math.floor(workW));
        }
      }
    } catch {
      /* ignore monitor probe */
    }
    if (capped <= curW + 0.5) return null;

    await win.setSize(new LogicalSize(capped, curH));
    return capped;
  } catch {
    return null;
  }
}

/** Grow the window to fit the given workbench layout (open panes + chat floor). */
export async function ensureWindowFitsLayout(
  layout: Pick<
    LayoutPrefs,
    "sidebarCollapsed" | "sidebarWidth" | "asideCollapsed" | "asideWidth"
  >,
): Promise<number | null> {
  return ensureWindowInnerWidth(requiredWorkbenchInnerWidth(layout));
}
