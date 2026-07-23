/**
 * Shared image UI: click → lightbox; right-click menu aligned with AttachmentCard
 * (view, reveal, copy image, copy path when a local path is known).
 * Local absolute paths are resolved via convertFileSrc automatically.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as api from "@/lib/api";
import { copyImageFromSrc } from "@/lib/copyImage";
import { resolveImageSrc, isViewableSrc } from "@/lib/imageSrc";
import { useImageViewerOptional } from "@/components/ImageViewer";
import { IconCopy, IconExternalLink, IconFolder } from "@/components/icons";
import { createT, type Locale } from "@/i18n";

export interface ImageUiLabels {
  viewImage: string;
  copyImage: string;
  /** Reveal in Finder — same copy as attach.reveal */
  reveal: string;
  /** Copy path — same copy as attach.copyPath */
  copyPath: string;
  open?: string;
}

interface ImageUiProps {
  src: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * Absolute filesystem path when known (local previews / attachments).
   * Enables Reveal + Copy path. Remote/data URLs omit these items.
   */
  path?: string;
  /** Sibling sources for gallery prev/next */
  gallery?: string[];
  labels: ImageUiLabels;
  /** Optional extra menu items at the end */
  extraMenu?: ReactNode;
  draggable?: boolean;
}

/** True when path looks like a local absolute path we can reveal/copy. */
function isLocalFsPath(path: string | undefined): path is string {
  if (!path) return false;
  if (path.startsWith("http://") || path.startsWith("https://")) return false;
  if (path.startsWith("data:") || path.startsWith("blob:")) return false;
  if (path.startsWith("asset:") || path.includes("asset.localhost")) return false;
  if (path.startsWith("media:") || path.includes("media.localhost")) return false;
  // Unix absolute or Windows drive
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

export function ImageUi({
  src,
  alt = "",
  className,
  style,
  path,
  gallery,
  labels,
  extraMenu,
  draggable = false,
}: ImageUiProps) {
  const viewer = useImageViewerOptional();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() =>
    isViewableSrc(src) ? src : null,
  );
  const localPath = isLocalFsPath(path)
    ? path
    : isLocalFsPath(src)
      ? src
      : undefined;

  useEffect(() => {
    let cancelled = false;
    if (isViewableSrc(src)) {
      setResolvedSrc(src);
      return;
    }
    void resolveImageSrc(src).then((r) => {
      if (!cancelled) setResolvedSrc(r);
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

  if (!resolvedSrc) return null;

  const openViewer = () => {
    const slides =
      gallery && gallery.length > 0
        ? gallery
        : localPath
          ? [localPath]
          : [resolvedSrc];
    const want = localPath ?? resolvedSrc;
    const idx = Math.max(
      0,
      slides.findIndex(
        (s) => s === want || s === resolvedSrc || s === localPath || s === src,
      ),
    );
    viewer.open(
      slides.map((s) => ({
        src: s,
        alt,
        title: alt || (isLocalFsPath(s) ? s.split(/[/\\]/).pop() : undefined),
      })),
      idx >= 0 ? idx : 0,
    );
  };

  const copyImage = async () => {
    await copyImageFromSrc(resolvedSrc);
  };

  const copyPath = async () => {
    if (!localPath) return;
    try {
      await navigator.clipboard.writeText(localPath);
    } catch {
      /* ignore */
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

  const left = menu ? Math.min(menu.x, window.innerWidth - 200) : 0;
  const top = menu ? Math.min(menu.y, window.innerHeight - 200) : 0;

  return (
    <>
      <img
        className={className}
        style={{ ...style, cursor: "zoom-in" }}
        src={resolvedSrc}
        alt={alt}
        draggable={draggable}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openViewer();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {menu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="menu-panel att-menu"
            style={{ left, top }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Order matches AttachmentCard image menu */}
            <button
              type="button"
              className="att-menu__item"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                openViewer();
              }}
            >
              <span className="att-menu__ico" aria-hidden>
                <IconExternalLink size={16} />
              </span>
              {labels.viewImage}
            </button>
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
                <span className="att-menu__ico" aria-hidden>
                  <IconFolder size={16} />
                </span>
                {labels.reveal}
              </button>
            )}
            <button
              type="button"
              className="att-menu__item"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void copyImage();
              }}
            >
              <span className="att-menu__ico" aria-hidden>
                <IconCopy size={16} />
              </span>
              {labels.copyImage}
            </button>
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
                <span className="att-menu__ico" aria-hidden>
                  <IconCopy size={16} />
                </span>
                {labels.copyPath}
              </button>
            )}
            {extraMenu}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Build image UI labels from locale (aligned with attach.* keys). */
export function imageUiLabels(locale: Locale): ImageUiLabels {
  const tr = createT(locale);
  return {
    viewImage: tr("image.view"),
    copyImage: tr("image.copy"),
    reveal: tr("attach.reveal"),
    copyPath: tr("attach.copyPath"),
  };
}
