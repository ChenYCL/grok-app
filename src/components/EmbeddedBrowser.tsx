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
 * Non-Tauri (dev UI only): falls back to iframe + open-external affordance.
 */

import { useEffect, useRef, useState } from "react";
import { isTauri } from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import { IconExternalLink, IconRefresh } from "@/components/icons";
import {
  applyFloatExcludeToBounds,
  getNativeWebviewFloatExclude,
  isNativeWebviewCovered,
  subscribeNativeWebviewCover,
  subscribeNativeWebviewFloatExclude,
} from "@/lib/nativeWebviewCover";

const WEBVIEW_LABEL_DEFAULT = "resource-browser";

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
  /** DOM overlays (floating menus) that must paint above native Webviews. */
  const [covered, setCovered] = useState(() => isNativeWebviewCovered());
  const tr = createT(locale);
  const webviewLabel = sideBrowserWebviewLabel(instanceId);
  const activeRef = useRef(active);
  const coveredRef = useRef(covered);
  activeRef.current = active;
  coveredRef.current = covered;

  const syncBounds = async () => {
    const el = hostRef.current;
    const wv = webviewRef.current;
    if (!el || !wv || !isTauri()) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      try {
        await wv.hide();
      } catch {
        /* ignore */
      }
      return;
    }
    // Shrink away from long-lived float UI (composer) so the page stays visible.
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
      try {
        await wv.hide();
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
      await wv.setPosition(new LogicalPosition(clipped.left, clipped.top));
      await wv.setSize(new LogicalSize(clipped.width, clipped.height));
      if (activeRef.current && !coveredRef.current) await wv.show();
      else await wv.hide();
    } catch (e) {
      console.error("[EmbeddedBrowser] syncBounds", e);
    }
  };

  useEffect(() => {
    return subscribeNativeWebviewCover(setCovered);
  }, []);

  // Floating composer moved / sized — re-clip native webview without full hide.
  useEffect(() => {
    return subscribeNativeWebviewFloatExclude(() => {
      void syncBounds();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Create / recreate native webview when URL or label changes.
  // Inactive tabs stay mounted (persist host) — hide only via active/covered.
  useEffect(() => {
    if (!isTauri()) return;
    const target = url.trim();
    if (!target) return;

    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;
    let roFrame = 0;
    let io: IntersectionObserver | null = null;

    const boot = async () => {
      setError(null);
      setReady(false);
      try {
        const { Webview } = await import("@tauri-apps/api/webview");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { LogicalPosition, LogicalSize } = await import(
          "@tauri-apps/api/dpi"
        );
        const win = getCurrentWindow();

        const existing = await Webview.getByLabel(webviewLabel);
        if (existing) {
          try {
            await existing.close();
          } catch {
            /* ignore */
          }
        }
        webviewRef.current = null;
        currentUrlRef.current = "";
        if (cancelled) return;

        const el = hostRef.current;
        const rect = el?.getBoundingClientRect();
        const x = rect?.left ?? 0;
        const y = rect?.top ?? 0;
        const w = Math.max(rect?.width ?? 320, 40);
        const h = Math.max(rect?.height ?? 240, 40);

        const webview = new Webview(win, webviewLabel, {
          url: target,
          x,
          y,
          width: w,
          height: h,
          focus: true,
          acceptFirstMouse: true,
        });

        await new Promise<void>((resolve, reject) => {
          const t = window.setTimeout(
            () => reject(new Error("webview create timeout")),
            8000,
          );
          void webview.once("tauri://created", () => {
            window.clearTimeout(t);
            resolve();
          });
          void webview.once("tauri://error", (e) => {
            window.clearTimeout(t);
            reject(e.payload ?? e);
          });
        });

        if (cancelled) {
          try {
            await webview.close();
          } catch {
            /* ignore */
          }
          return;
        }

        webviewRef.current = webview;
        currentUrlRef.current = target;
        await webview.setPosition(new LogicalPosition(x, y));
        await webview.setSize(new LogicalSize(w, h));
        if (activeRef.current && !coveredRef.current) await webview.show();
        else await webview.hide();
        setReady(true);

        if (hostRef.current && typeof ResizeObserver !== "undefined") {
          resizeObs = new ResizeObserver(() => {
            cancelAnimationFrame(roFrame);
            roFrame = requestAnimationFrame(() => {
              void syncBounds();
            });
          });
          resizeObs.observe(hostRef.current);
        }
        if (hostRef.current && typeof IntersectionObserver !== "undefined") {
          io = new IntersectionObserver(
            (entries) => {
              const vis = entries.some(
                (e) => e.isIntersecting && e.intersectionRatio > 0.05,
              );
              const wv = webviewRef.current;
              if (!wv) return;
              if (!vis || !activeRef.current) void wv.hide().catch(() => undefined);
              else void syncBounds();
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
      void syncBounds();
    };

    void boot();

    return () => {
      cancelled = true;
      cancelAnimationFrame(roFrame);
      resizeObs?.disconnect();
      io?.disconnect();
      window.removeEventListener("resize", onResize);
      const wv = webviewRef.current;
      webviewRef.current = null;
      currentUrlRef.current = "";
      if (wv) {
        void wv.close().catch(() => undefined);
      } else if (isTauri()) {
        void import("@tauri-apps/api/webview")
          .then(({ Webview }) => Webview.getByLabel(webviewLabel))
          .then((w) => w?.close())
          .catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, webviewLabel]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !isTauri()) return;
    if (active && !covered) {
      void syncBounds().then(() => wv.show()).catch(() => undefined);
    } else {
      void wv.hide().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, covered]);

  const openExternal = () => {
    void openExternalUrl(url);
  };

  const reload = () => {
    if (!isTauri()) return;
    const u = url;
    void (async () => {
      try {
        const { Webview } = await import("@tauri-apps/api/webview");
        const w = await Webview.getByLabel(webviewLabel);
        if (w) await w.close();
      } catch {
        /* ignore */
      }
      webviewRef.current = null;
      currentUrlRef.current = "";
      setReady(false);
      setError(null);
      const el = hostRef.current;
      if (!el) return;
      try {
        const { Webview } = await import("@tauri-apps/api/webview");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { LogicalPosition, LogicalSize } = await import(
          "@tauri-apps/api/dpi"
        );
        const rect = el.getBoundingClientRect();
        const webview = new Webview(getCurrentWindow(), webviewLabel, {
          url: u,
          x: rect.left,
          y: rect.top,
          width: Math.max(rect.width, 40),
          height: Math.max(rect.height, 40),
          focus: true,
        });
        await new Promise<void>((resolve, reject) => {
          void webview.once("tauri://created", () => resolve());
          void webview.once("tauri://error", (e) => reject(e));
        });
        webviewRef.current = webview;
        await webview.setPosition(new LogicalPosition(rect.left, rect.top));
        await webview.setSize(
          new LogicalSize(Math.max(rect.width, 40), Math.max(rect.height, 40)),
        );
        if (activeRef.current && !coveredRef.current) await webview.show();
        else await webview.hide();
        setReady(true);
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
