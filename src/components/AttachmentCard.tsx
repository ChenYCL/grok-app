/**
 * File / folder card for chat history and composer.
 * Images: square thumb, click → lightbox, context menu includes copy image.
 * Other files: click → OS open; right-click → context menu.
 */

import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@/lib/attachments";
import { isImagePath } from "@/lib/attachments";
import * as api from "@/lib/api";
import { resolveImageSrc } from "@/lib/imageSrc";
import { copyImageFromPath } from "@/lib/copyImage";
import { useImageViewerOptional } from "@/components/ImageViewer";
import {
  IconClose,
  IconCopy,
  IconExternalLink,
  IconFileText,
  IconFolder,
  IconPaperclip,
} from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";

export interface AttachmentCardLabels {
  open: string;
  reveal: string;
  copyPath: string;
  copyImage: string;
  addToComposer: string;
  remove?: string;
  viewImage?: string;
}

interface AttachmentCardProps {
  attachment: Attachment;
  labels: AttachmentCardLabels;
  /** Compact chip-style (composer) vs message card */
  variant?: "card" | "chip";
  onAddToComposer?: (a: Attachment) => void;
  onRemove?: (a: Attachment) => void;
  /**
   * Sibling image paths for lightbox prev/next.
   * When omitted, only the current image is shown.
   */
  galleryPaths?: string[];
}

export function AttachmentCard({
  attachment,
  labels,
  variant = "card",
  onAddToComposer,
  onRemove,
  galleryPaths,
}: AttachmentCardProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [thumbSrc, setThumbSrc] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewer = useImageViewerOptional();
  const isImg = !attachment.isDir && isImagePath(attachment.path);

  useEffect(() => {
    if (!isImg) {
      setThumbSrc(null);
      return;
    }
    let cancelled = false;
    void resolveImageSrc(attachment.path).then((src) => {
      if (!cancelled) setThumbSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [attachment.path, isImg]);

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

  const openPath = async () => {
    try {
      if (api.isTauri()) await api.pathOpen(attachment.path);
    } catch (e) {
      console.error(e);
    }
  };

  const revealPath = async () => {
    try {
      if (api.isTauri()) await api.pathReveal(attachment.path);
    } catch (e) {
      console.error(e);
    }
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(attachment.path);
    } catch {
      /* ignore */
    }
  };

  const copyImage = async () => {
    await copyImageFromPath(attachment.path);
  };

  const openInViewer = () => {
    const gallery =
      galleryPaths && galleryPaths.length > 0
        ? galleryPaths
        : [attachment.path];
    const idx = Math.max(0, gallery.indexOf(attachment.path));
    viewer.open(
      gallery.map((p) => ({ src: p, title: p.split(/[/\\]/).pop() })),
      idx,
    );
  };

  const onPrimaryClick = () => {
    if (isImg) openInViewer();
    else void openPath();
  };

  if (variant === "chip") {
    return (
      <Tip label={attachment.path}>
        <span
          ref={rootRef as unknown as React.RefObject<HTMLSpanElement>}
          className={
            "attach-chip" +
            (attachment.isDir ? " attach-chip--dir" : "") +
            (isImg ? " attach-chip--image" : "")
          }
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <button
            type="button"
            className="attach-chip__main"
            onClick={onPrimaryClick}
          >
            {isImg && thumbSrc ? (
              <img
                className="attach-chip__thumb"
                src={thumbSrc}
                alt={attachment.name}
                draggable={false}
              />
            ) : (
              <>
                <span className="attach-chip__icon" aria-hidden>
                  {attachment.isDir ? (
                    <IconFolder size={14} />
                  ) : (
                    <IconFileText size={14} />
                  )}
                </span>
                <span className="attach-chip__name">{attachment.name}</span>
              </>
            )}
          </button>
          {onRemove && labels.remove ? (
            <Tip label={labels.remove}>
              <button
                type="button"
                className="attach-chip__x"
                aria-label={labels.remove}
                onClick={() => onRemove(attachment)}
              >
                <IconClose size={12} />
              </button>
            </Tip>
          ) : onRemove ? (
            <button
              type="button"
              className="attach-chip__x"
              aria-label={labels.remove}
              onClick={() => onRemove(attachment)}
            >
              <IconClose size={12} />
            </button>
          ) : null}
          {menu && (
            <AttachmentContextMenu
              x={menu.x}
              y={menu.y}
              labels={labels}
              showAdd={!!onAddToComposer}
              showCopyImage={isImg}
              onOpen={() => {
                setMenu(null);
                if (isImg) openInViewer();
                else void openPath();
              }}
              onReveal={() => {
                setMenu(null);
                void revealPath();
              }}
              onCopyPath={() => {
                setMenu(null);
                void copyPath();
              }}
              onCopyImage={() => {
                setMenu(null);
                void copyImage();
              }}
              onAdd={() => {
                setMenu(null);
                onAddToComposer?.(attachment);
              }}
            />
          )}
        </span>
      </Tip>
    );
  }

  return (
    <Tip label={attachment.path}>
    <div
      ref={rootRef}
      className={
        "att-card" +
        (attachment.isDir ? " att-card--dir" : "") +
        (isImg ? " att-card--image" : "")
      }
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <button
        type="button"
        className={"att-card__btn" + (isImg ? " att-card__btn--image" : "")}
        onClick={onPrimaryClick}
      >
        {isImg ? (
          thumbSrc ? (
            <img
              className="att-card__thumb"
              src={thumbSrc}
              alt={attachment.name}
              draggable={false}
            />
          ) : (
            <span className="att-card__thumb att-card__thumb--placeholder">
              <IconPaperclip size={18} />
            </span>
          )
        ) : (
          <>
            <span className="att-card__icon" aria-hidden>
              {attachment.isDir ? (
                <IconFolder size={18} />
              ) : (
                <IconFileText size={18} />
              )}
            </span>
            <span className="att-card__meta">
              <span className="att-card__name">
                {attachment.name}
              </span>
            </span>
          </>
        )}
      </button>
      {menu && (
        <AttachmentContextMenu
          x={menu.x}
          y={menu.y}
          labels={labels}
          showAdd={!!onAddToComposer}
          showCopyImage={isImg}
          onOpen={() => {
            setMenu(null);
            if (isImg) openInViewer();
            else void openPath();
          }}
          onReveal={() => {
            setMenu(null);
            void revealPath();
          }}
          onCopyPath={() => {
            setMenu(null);
            void copyPath();
          }}
          onCopyImage={() => {
            setMenu(null);
            void copyImage();
          }}
          onAdd={() => {
            setMenu(null);
            onAddToComposer?.(attachment);
          }}
        />
      )}
    </div>
    </Tip>
  );
}

function AttachmentContextMenu({
  x,
  y,
  labels,
  showAdd,
  showCopyImage,
  onOpen,
  onReveal,
  onCopyPath,
  onCopyImage,
  onAdd,
}: {
  x: number;
  y: number;
  labels: AttachmentCardLabels;
  showAdd: boolean;
  showCopyImage: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onCopyImage: () => void;
  onAdd: () => void;
}) {
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 200);
  return (
    <div
      className="menu-panel att-menu"
      style={{ left, top }}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button type="button" className="att-menu__item" role="menuitem" onClick={onOpen}>
        <span className="att-menu__ico" aria-hidden>
          {showCopyImage ? <IconFileText size={16} /> : <IconExternalLink size={16} />}
        </span>
        {showCopyImage && labels.viewImage ? labels.viewImage : labels.open}
      </button>
      <button type="button" className="att-menu__item" role="menuitem" onClick={onReveal}>
        <span className="att-menu__ico" aria-hidden>
          <IconFolder size={16} />
        </span>
        {labels.reveal}
      </button>
      {showCopyImage && (
        <button
          type="button"
          className="att-menu__item"
          role="menuitem"
          onClick={onCopyImage}
        >
          <span className="att-menu__ico" aria-hidden>
            <IconCopy size={16} />
          </span>
          {labels.copyImage}
        </button>
      )}
      <button type="button" className="att-menu__item" role="menuitem" onClick={onCopyPath}>
        <span className="att-menu__ico" aria-hidden>
          <IconCopy size={16} />
        </span>
        {labels.copyPath}
      </button>
      {showAdd && (
        <button type="button" className="att-menu__item" role="menuitem" onClick={onAdd}>
          <span className="att-menu__ico" aria-hidden>
            <IconPaperclip size={16} />
          </span>
          {labels.addToComposer}
        </button>
      )}
    </div>
  );
}
