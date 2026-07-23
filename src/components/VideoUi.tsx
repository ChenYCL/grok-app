/**
 * Inline video card for chat: session-relative / local paths.
 * Plays via Tauri media:// (Range); right-click: open / reveal / copy path.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as api from "@/lib/api";
import { pathToPreviewUrl } from "@/lib/filePreviewSrc";
import { IconCopy } from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import { createT, type Locale } from "@/i18n";
import { pathBasename } from "@/lib/attachments";

export interface VideoUiLabels {
  open: string;
  reveal: string;
  copyPath: string;
  loadError?: string;
}

interface VideoUiProps {
  /** Absolute filesystem path (preferred) or already-viewable URL. */
  src: string;
  /** Absolute path for open/reveal/copy (when known). */
  path?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  labels: VideoUiLabels;
  extraMenu?: ReactNode;
}

function isLocalFsPath(path: string | undefined): path is string {
  if (!path) return false;
  if (path.startsWith("http://") || path.startsWith("https://")) return false;
  if (path.startsWith("data:") || path.startsWith("blob:")) return false;
  if (path.startsWith("asset:") || path.includes("asset.localhost")) return false;
  if (path.startsWith("media:") || path.includes("media.localhost")) return false;
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function isViewableVideoSrc(src: string): boolean {
  return (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:") ||
    src.startsWith("blob:") ||
    src.startsWith("asset:") ||
    src.startsWith("media:") ||
    src.includes("asset.localhost") ||
    src.includes("media.localhost")
  );
}

export function VideoUi({
  src,
  path,
  title = "",
  className,
  style,
  labels,
  extraMenu,
}: VideoUiProps) {
  const localPath = isLocalFsPath(path)
    ? path
    : isLocalFsPath(src)
      ? src
      : undefined;
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() =>
    isViewableVideoSrc(src) ? src : null,
  );
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (isViewableVideoSrc(src)) {
      setResolvedSrc(src);
      return;
    }
    void pathToPreviewUrl(src, "video").then((url) => {
      if (!cancelled) setResolvedSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openExternal = async () => {
    if (!localPath || !api.isTauri()) return;
    try {
      await api.pathOpen(localPath);
    } catch (e) {
      console.error(e);
    }
  };

  const revealPath = async () => {
    if (!localPath || !api.isTauri()) return;
    try {
      await api.pathReveal(localPath);
    } catch (e) {
      console.error(e);
    }
  };

  const copyPath = async () => {
    if (!localPath) return;
    try {
      await navigator.clipboard.writeText(localPath);
    } catch {
      /* ignore */
    }
  };

  const left = menu ? Math.min(menu.x, window.innerWidth - 200) : 0;
  const top = menu ? Math.min(menu.y, window.innerHeight - 220) : 0;
  const displayTitle = title || (localPath ? pathBasename(localPath) : "");

  if (!resolvedSrc) {
    return (
      <div
        className={"md-body__video-card md-body__video-card--loading " + (className || "")}
        style={style}
      >
        <span className="md-body__video-card__name">{displayTitle || "…"}</span>
      </div>
    );
  }

  return (
    <>
      <div
        className={"md-body__video-card " + (className || "")}
        style={style}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {error ? (
          <div className="md-body__video-card__error">
            <span>{labels.loadError || "Failed to load video"}</span>
            {localPath && (
              <button
                type="button"
                className="md-body__video-card__btn"
                onClick={() => void openExternal()}
              >
                {labels.open}
              </button>
            )}
          </div>
        ) : (
          <Tip label={displayTitle} disabled={!displayTitle}>
            <video
              className="md-body__video-card__el"
              src={resolvedSrc}
              controls
              playsInline
              preload="metadata"
              onError={() => setError(true)}
            />
          </Tip>
        )}
        {displayTitle ? (
          <Tip label={localPath || displayTitle}>
            <div className="md-body__video-card__caption">
              {displayTitle}
            </div>
          </Tip>
        ) : null}
      </div>
      {menu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="menu-panel att-menu"
            style={{ left, top }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {localPath && (
              <button
                type="button"
                className="att-menu__item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void openExternal();
                }}
              >
                {labels.open}
              </button>
            )}
            {localPath && (
              <button
                type="button"
                className="att-menu__item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void revealPath();
                }}
              >
                {labels.reveal}
              </button>
            )}
            {localPath && (
              <button
                type="button"
                className="att-menu__item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void copyPath();
                }}
              >
                <IconCopy size={14} /> {labels.copyPath}
              </button>
            )}
            {extraMenu}
          </div>,
          document.body,
        )}
    </>
  );
}

export function videoUiLabels(locale: Locale): VideoUiLabels {
  const tr = createT(locale);
  return {
    open: tr("attach.open"),
    reveal: tr("attach.reveal"),
    copyPath: tr("attach.copyPath"),
    loadError: tr("video.loadError"),
  };
}
