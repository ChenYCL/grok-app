/**
 * Built-in **in-app** browser for the resource pane / side workbench.
 *
 * Always uses a Tauri child Webview painted over this host element
 * (WKWebView / WebView2 / webkit2gtk). External Chrome processes are
 * intentionally not used — automation must target the same embedded surface.
 *
 * Stable label: `resource-browser` or `resource-browser-<instanceId>`
 * so host commands (`side_browser_*`) can drive navigate / eval / snapshot.
 *
 * Creation goes through host `side_browser_create` (not frontend `new Webview`)
 * so downloads get a native save dialog via wry/Tauri `on_download`.
 *
 * Bounds: host ResizeObserver + ancestor observers + window resize, coalesced
 * through a trailing single-flight so setPosition/setSize never interleave
 * (sidebar drag used to jitter / leave a white gap).
 *
 * Non-Tauri (dev UI only): falls back to iframe + open-external affordance.
 */

import { useEffect, useRef, useState } from "react";
import { isTauri, sideBrowserClose, sideBrowserCreate } from "@/lib/api";
import type { SideBrowserDownloadEvent } from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import { IconExternalLink, IconRefresh } from "@/components/icons";
import {
  applyFloatExcludeToBounds,
  getNativeWebviewFloatExclude,
  isNativeWebviewCovered,
  subscribeNativeWebviewCover,
  subscribeNativeWebviewFloatExclude,
} from "@/lib/nativeWebviewCover";
import {
  boundsNearlyEqual,
  clipHostRectAgainstLeftResizers,
  createTrailingSingleFlight,
  snapBounds,
  type BoundsPx,
  type HostRectPx,
} from "@/lib/nativeWebviewBounds";

/** Collect visible vertical pane resizers that may sit under this host. */
function leftPaneResizersNear(hostEl: HTMLElement): HostRectPx[] {
  const out: HostRectPx[] = [];
  const aside = hostEl.closest(".aside");
  if (!aside) return out;
  const nodes = aside.querySelectorAll(".aside-resizer");
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i] as HTMLElement;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
    } catch {
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    });
  }
  return out;
}

/** Keep the 1px aside border hairline visible under native child Webviews. */
const ASIDE_BROWSER_LEFT_INSET_PX = 1;

function hostRectForWebview(hostEl: HTMLElement): HostRectPx {
  const rect = hostEl.getBoundingClientRect();
  let base: HostRectPx = {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
  base = clipHostRectAgainstLeftResizers(base, leftPaneResizersNear(hostEl));
  // Side-pane browser only: shrink 1px from the left so the divider line shows.
  if (hostEl.closest(".aside") && base.width > ASIDE_BROWSER_LEFT_INSET_PX) {
    base = {
      ...base,
      left: base.left + ASIDE_BROWSER_LEFT_INSET_PX,
      width: base.width - ASIDE_BROWSER_LEFT_INSET_PX,
    };
  }
  return base;
}

const WEBVIEW_LABEL_DEFAULT = "resource-browser";
const DOWNLOAD_EVENT = "side-browser://download";

/** How many parent elements to observe so pane/splitter moves re-sync position. */
const ANCESTOR_OBSERVE_DEPTH = 6;

type DpiMod = typeof import("@tauri-apps/api/dpi");

let dpiModPromise: Promise<DpiMod> | null = null;

function loadDpi(): Promise<DpiMod> {
  if (!dpiModPromise) {
    dpiModPromise = import("@tauri-apps/api/dpi");
  }
  return dpiModPromise;
}

export interface EmbeddedBrowserProps {
  url: string;
  title?: string;
  locale?: Locale;
  /** When false, native webview is hidden (inactive tab / collapsed pane). */
  active?: boolean;
  className?: string;
  /**
   * Unique webview label suffix per browser tab (multi-instance).
   * Full label = `resource-browser-${instanceId}`.
   */
  instanceId?: string;
}

/** Public label scheme for automation / host commands. */
export function sideBrowserWebviewLabel(instanceId?: string | null): string {
  if (!instanceId) return WEBVIEW_LABEL_DEFAULT;
  return sanitizeLabel(`resource-browser-${instanceId}`);
}

function sanitizeLabel(s: string): string {
  return s.replace(/[^a-zA-Z0-9\-_:/]/g, "-").slice(0, 64) || "resource-browser";
}

async function openExternalUrl(url: string) {
  try {
    if (isTauri()) {
      const api = await import("@/lib/api");
      await api.openExternalUrl(url);
      return;
    }
  } catch {
    /* fall through */
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function EmbeddedBrowser({
  url,
  title,
  locale = "en",
  active = true,
  className = "",
  instanceId,
}: EmbeddedBrowserProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Dynamic import type — keep loose to avoid hard coupling on Tauri version.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webviewRef = useRef<any>(null);
  const currentUrlRef = useRef<string>("");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /** Short status for download save result (host event). */
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  /** DOM overlays (floating menus) that must paint above native Webviews. */
  const [covered, setCovered] = useState(() => isNativeWebviewCovered());
  const tr = createT(locale);
  const webviewLabel = sideBrowserWebviewLabel(instanceId);
  const activeRef = useRef(active);
  const coveredRef = useRef(covered);
  const lastBoundsRef = useRef<BoundsPx | null>(null);
  const scheduleRef = useRef<ReturnType<typeof createTrailingSingleFlight> | null>(
    null,
  );
  const applyBoundsRef = useRef<() => Promise<void>>(async () => undefined);
  const roRafRef = useRef(0);
  const downloadStatusTimerRef = useRef(0);
  activeRef.current = active;
  coveredRef.current = covered;

  const flashDownloadStatus = (msg: string) => {
    setDownloadStatus(msg);
    window.clearTimeout(downloadStatusTimerRef.current);
    downloadStatusTimerRef.current = window.setTimeout(() => {
      setDownloadStatus(null);
    }, 4200);
  };

  /**
   * Apply host rect → native webview. Always re-reads DOM at start so trailing
   * coalesced runs pick up the latest sidebar/window size.
   */
  applyBoundsRef.current = async () => {
    const el = hostRef.current;
    const wv = webviewRef.current;
    if (!el || !wv || !isTauri()) return;

    // Clip past left-edge pane resizers first (native webviews paint above DOM).
    const rect = hostRectForWebview(el);
    if (rect.width < 2 || rect.height < 2) {
      lastBoundsRef.current = null;
      try {
        await wv.hide();
      } catch {
        /* ignore */
      }
      return;
    }

    const clipped = applyFloatExcludeToBounds(
      {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      getNativeWebviewFloatExclude(),
      10,
    );

    if (clipped.width < 2 || clipped.height < 2) {
      lastBoundsRef.current = null;
      try {
        await wv.hide();
      } catch {
        /* ignore */
      }
      return;
    }

    const next = snapBounds({
      x: clipped.left,
      y: clipped.top,
      width: clipped.width,
      height: clipped.height,
    });

    const wantShow = activeRef.current && !coveredRef.current;
    const boundsSame = boundsNearlyEqual(lastBoundsRef.current, next, 0.5);

    if (boundsSame) {
      try {
        if (wantShow) await wv.show();
        else await wv.hide();
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      const { LogicalPosition, LogicalSize } = await loadDpi();
      // Position then size — one pair per apply; single-flight prevents interleave.
      await wv.setPosition(new LogicalPosition(next.x, next.y));
      await wv.setSize(new LogicalSize(next.width, next.height));
      lastBoundsRef.current = next;
      if (wantShow) await wv.show();
      else await wv.hide();
    } catch (e) {
      console.error("[EmbeddedBrowser] syncBounds", e);
    }
  };

  // Stable flight controller for this mount lifetime (always calls latest apply).
  if (!scheduleRef.current) {
    scheduleRef.current = createTrailingSingleFlight(() =>
      applyBoundsRef.current(),
    );
  }

  const scheduleSync = () => {
    scheduleRef.current?.schedule();
  };

  const scheduleSyncRaf = () => {
    cancelAnimationFrame(roRafRef.current);
    roRafRef.current = requestAnimationFrame(() => {
      scheduleSync();
    });
  };

  useEffect(() => {
    return subscribeNativeWebviewCover(setCovered);
  }, []);

  // Floating composer moved / sized — re-clip native webview without full hide.
  useEffect(() => {
    return subscribeNativeWebviewFloatExclude(() => {
      scheduleSyncRaf();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Download status from host on_download (save dialog + finish).
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<SideBrowserDownloadEvent>(
          DOWNLOAD_EVENT,
          (ev) => {
            const p = ev.payload;
            if (!p || p.label !== webviewLabel) return;
            if (p.phase === "finished") {
              if (p.success) {
                const name =
                  p.fileName ||
                  (p.path ? p.path.split(/[/\\]/).pop() : "") ||
                  "file";
                flashDownloadStatus(
                  tr("resources.browserDownloadSaved", { name }),
                );
              } else {
                flashDownloadStatus(tr("resources.browserDownloadFailed"));
              }
            } else if (p.phase === "cancelled") {
              flashDownloadStatus(tr("resources.browserDownloadCancelled"));
            }
          },
        );
        if (cancelled) off();
        else unlisten = off;
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      window.clearTimeout(downloadStatusTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webviewLabel, locale]);

  // Create / recreate native webview when URL or label changes.
  // Inactive tabs stay mounted (persist host) — hide only via active/covered.
  // Host create attaches on_download (native save dialog); JS new Webview does not.
  useEffect(() => {
    if (!isTauri()) return;
    const target = url.trim();
    if (!target) return;

    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;
    let io: IntersectionObserver | null = null;

    // New webview → force bounds re-apply even if numbers match previous instance.
    lastBoundsRef.current = null;

    const boot = async () => {
      setError(null);
      setReady(false);
      try {
        // Warm dpi module before create so first drag frames don't pay import cost.
        void loadDpi();
        const { Webview } = await import("@tauri-apps/api/webview");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { LogicalPosition, LogicalSize } = await loadDpi();
        const win = getCurrentWindow();

        try {
          await sideBrowserClose(webviewLabel);
        } catch {
          /* ignore */
        }
        try {
          const existing = await Webview.getByLabel(webviewLabel);
          if (existing) await existing.close();
        } catch {
          /* ignore */
        }
        webviewRef.current = null;
        currentUrlRef.current = "";
        if (cancelled) return;

        const el = hostRef.current;
        const rect = el ? hostRectForWebview(el) : null;
        const x = Math.round(rect?.left ?? 0);
        const y = Math.round(rect?.top ?? 0);
        const w = Math.max(Math.round(rect?.width ?? 320), 40);
        const h = Math.max(Math.round(rect?.height ?? 240), 40);

        await sideBrowserCreate({
          label: webviewLabel,
          url: target,
          windowLabel: win.label,
          x,
          y,
          width: w,
          height: h,
        });

        if (cancelled) {
          try {
            await sideBrowserClose(webviewLabel);
          } catch {
            /* ignore */
          }
          return;
        }

        const webview = await Webview.getByLabel(webviewLabel);
        if (!webview) {
          throw new Error("side browser webview missing after create");
        }

        webviewRef.current = webview;
        currentUrlRef.current = target;
        lastBoundsRef.current = { x, y, width: w, height: h };
        await webview.setPosition(new LogicalPosition(x, y));
        await webview.setSize(new LogicalSize(w, h));
        if (activeRef.current && !coveredRef.current) await webview.show();
        else await webview.hide();
        setReady(true);

        // Layout may have changed while we awaited create — apply latest once.
        scheduleSync();

        if (hostRef.current && typeof ResizeObserver !== "undefined") {
          resizeObs = new ResizeObserver(() => {
            scheduleSyncRaf();
          });
          // Host + ancestors: sidebar/aside width is often applied on a parent;
          // host size may lag a frame, and position-only moves need parent RO.
          let node: HTMLElement | null = hostRef.current;
          for (let i = 0; i < ANCESTOR_OBSERVE_DEPTH && node; i++) {
            resizeObs.observe(node);
            node = node.parentElement;
          }
        }
        if (hostRef.current && typeof IntersectionObserver !== "undefined") {
          io = new IntersectionObserver(
            (entries) => {
              const vis = entries.some(
                (e) => e.isIntersecting && e.intersectionRatio > 0.05,
              );
              const wv = webviewRef.current;
              if (!wv) return;
              if (!vis || !activeRef.current) {
                void wv.hide().catch(() => undefined);
              } else {
                scheduleSyncRaf();
              }
            },
            { threshold: [0, 0.05, 0.5, 1] },
          );
          io.observe(hostRef.current);
        }
        window.addEventListener("resize", onResize);
      } catch (e) {
        if (!cancelled) {
          console.error("[EmbeddedBrowser] create failed", e);
          setError(String(e));
          setReady(false);
        }
      }
    };

    const onResize = () => {
      scheduleSyncRaf();
    };

    void boot();

    return () => {
      cancelled = true;
      cancelAnimationFrame(roRafRef.current);
      resizeObs?.disconnect();
      io?.disconnect();
      window.removeEventListener("resize", onResize);
      const wv = webviewRef.current;
      webviewRef.current = null;
      currentUrlRef.current = "";
      lastBoundsRef.current = null;
      if (wv) {
        void wv.close().catch(() => undefined);
      } else if (isTauri()) {
        void sideBrowserClose(webviewLabel).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, webviewLabel]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !isTauri()) return;
    // Force apply (visibility may change without size change).
    lastBoundsRef.current = null;
    scheduleSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, covered]);

  // Dispose flight only on unmount (not on url change — shared scheduleRef).
  useEffect(() => {
    return () => {
      scheduleRef.current?.dispose();
      scheduleRef.current = null;
    };
  }, []);

  const openExternal = () => {
    void openExternalUrl(url);
  };

  const reload = () => {
    if (!isTauri()) return;
    const u = url;
    void (async () => {
      try {
        await sideBrowserClose(webviewLabel);
      } catch {
        /* ignore */
      }
      try {
        const { Webview } = await import("@tauri-apps/api/webview");
        const w = await Webview.getByLabel(webviewLabel);
        if (w) await w.close();
      } catch {
        /* ignore */
      }
      webviewRef.current = null;
      currentUrlRef.current = "";
      lastBoundsRef.current = null;
      setReady(false);
      setError(null);
      const el = hostRef.current;
      if (!el) return;
      try {
        const { Webview } = await import("@tauri-apps/api/webview");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { LogicalPosition, LogicalSize } = await loadDpi();
        const rect = hostRectForWebview(el);
        const x = Math.round(rect.left);
        const y = Math.round(rect.top);
        const w = Math.max(Math.round(rect.width), 40);
        const h = Math.max(Math.round(rect.height), 40);
        const win = getCurrentWindow();
        await sideBrowserCreate({
          label: webviewLabel,
          url: u,
          windowLabel: win.label,
          x,
          y,
          width: w,
          height: h,
        });
        const webview = await Webview.getByLabel(webviewLabel);
        if (!webview) {
          throw new Error("side browser webview missing after reload");
        }
        webviewRef.current = webview;
        lastBoundsRef.current = { x, y, width: w, height: h };
        await webview.setPosition(new LogicalPosition(x, y));
        await webview.setSize(new LogicalSize(w, h));
        if (activeRef.current && !coveredRef.current) await webview.show();
        else await webview.hide();
        setReady(true);
        scheduleSync();
      } catch (e) {
        setError(String(e));
      }
    })();
  };

  if (!isTauri()) {
    return (
      <div className={"embedded-browser " + className}>
        <div className="embedded-browser__bar">
          <span className="embedded-browser__url" title={url}>
            {url}
          </span>
          <button
            type="button"
            className="chrome-btn"
            onClick={openExternal}
            title={tr("resources.openExternal")}
          >
            <IconExternalLink size={14} />
          </button>
        </div>
        <iframe
          className="rp-preview__frame rp-preview__frame--browser"
          title={title || url}
          src={url}
          referrerPolicy="no-referrer"
          allow="fullscreen"
        />
        <div className="embedded-browser__hint">
          {tr("resources.browserIframeHint")}
        </div>
      </div>
    );
  }

  return (
    <div
      className={"embedded-browser embedded-browser--native " + className}
      data-webview-label={webviewLabel}
    >
      <div className="embedded-browser__bar">
        <span className="embedded-browser__url" title={url}>
          {url}
        </span>
        {downloadStatus ? (
          <span
            className="embedded-browser__download-status"
            role="status"
            title={downloadStatus}
          >
            {downloadStatus}
          </span>
        ) : null}
        <button
          type="button"
          className="chrome-btn"
          onClick={reload}
          title={tr("resources.browserReload")}
        >
          <IconRefresh size={14} />
        </button>
        <button
          type="button"
          className="chrome-btn"
          onClick={openExternal}
          title={tr("resources.openExternal")}
        >
          <IconExternalLink size={14} />
        </button>
      </div>
      <div
        ref={hostRef}
        className="embedded-browser__host"
        data-native-webview-host=""
        data-webview-label={webviewLabel}
        data-ready={ready ? "1" : "0"}
        data-webview-covered={covered ? "1" : "0"}
        aria-label={title || url}
      >
        {error ? (
          <div className="rp-preview__msg" role="alert">
            <p>{tr("resources.browserFailed")}</p>
            <p className="embedded-browser__err">{error}</p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={openExternal}
            >
              {tr("resources.openExternal")}
            </button>
          </div>
        ) : !ready ? (
          <div className="rp-preview__msg">{tr("resources.loading")}</div>
        ) : (
          <div className="embedded-browser__host-fill" aria-hidden />
        )}
      </div>
    </div>
  );
}
