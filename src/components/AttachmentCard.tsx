/**
 * File / folder card for chat history and (optionally) composer.
 * Click → open with OS default; right-click → context menu.
 */

import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@/lib/attachments";
import { isImagePath } from "@/lib/attachments";
import * as api from "@/lib/api";
import {
  IconClose,
  IconCopy,
  IconFileText,
  IconFolder,
  IconPaperclip,
} from "@/components/icons";

export interface AttachmentCardLabels {
  open: string;
  reveal: string;
  copyPath: string;
  addToComposer: string;
  remove?: string;
}

interface AttachmentCardProps {
  attachment: Attachment;
  labels: AttachmentCardLabels;
  /** Compact chip-style (composer) vs message card */
  variant?: "card" | "chip";
  onAddToComposer?: (a: Attachment) => void;
  onRemove?: (a: Attachment) => void;
}

export function AttachmentCard({
  attachment,
  labels,
  variant = "card",
  onAddToComposer,
  onRemove,
}: AttachmentCardProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const isImg = !attachment.isDir && isImagePath(attachment.path);

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

  if (variant === "chip") {
    return (
      <span
        ref={rootRef as unknown as React.RefObject<HTMLSpanElement>}
        className={
          "attach-chip" + (attachment.isDir ? " attach-chip--dir" : "")
        }
        title={attachment.path}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <button
          type="button"
          className="attach-chip__main"
          onClick={() => void openPath()}
        >
          <span className="attach-chip__icon" aria-hidden>
            {attachment.isDir ? (
              <IconFolder size={14} />
            ) : isImg ? (
              <IconPaperclip size={14} />
            ) : (
              <IconFileText size={14} />
            )}
          </span>
          <span className="attach-chip__name">{attachment.name}</span>
        </button>
        {onRemove && (
          <button
            type="button"
            className="attach-chip__x"
            title={labels.remove}
            aria-label={labels.remove}
            onClick={() => onRemove(attachment)}
          >
            <IconClose size={12} />
          </button>
        )}
        {menu && (
          <AttachmentContextMenu
            x={menu.x}
            y={menu.y}
            labels={labels}
            showAdd={!!onAddToComposer}
            onOpen={() => {
              setMenu(null);
              void openPath();
            }}
            onReveal={() => {
              setMenu(null);
              void revealPath();
            }}
            onCopy={() => {
              setMenu(null);
              void copyPath();
            }}
            onAdd={() => {
              setMenu(null);
              onAddToComposer?.(attachment);
            }}
          />
        )}
      </span>
    );
  }

  return (
    <div
      ref={rootRef}
      className={
        "att-card" +
        (attachment.isDir ? " att-card--dir" : "") +
        (isImg ? " att-card--image" : "")
      }
      title={attachment.path}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <button
        type="button"
        className="att-card__btn"
        onClick={() => void openPath()}
      >
        <span className="att-card__icon" aria-hidden>
          {attachment.isDir ? (
            <IconFolder size={20} />
          ) : (
            <IconFileText size={20} />
          )}
        </span>
        <span className="att-card__meta">
          <span className="att-card__name">{attachment.name}</span>
          <span className="att-card__path">{attachment.path}</span>
        </span>
      </button>
      {menu && (
        <AttachmentContextMenu
          x={menu.x}
          y={menu.y}
          labels={labels}
          showAdd={!!onAddToComposer}
          onOpen={() => {
            setMenu(null);
            void openPath();
          }}
          onReveal={() => {
            setMenu(null);
            void revealPath();
          }}
          onCopy={() => {
            setMenu(null);
            void copyPath();
          }}
          onAdd={() => {
            setMenu(null);
            onAddToComposer?.(attachment);
          }}
        />
      )}
    </div>
  );
}

function AttachmentContextMenu({
  x,
  y,
  labels,
  showAdd,
  onOpen,
  onReveal,
  onCopy,
  onAdd,
}: {
  x: number;
  y: number;
  labels: AttachmentCardLabels;
  showAdd: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onCopy: () => void;
  onAdd: () => void;
}) {
  // Keep menu inside viewport
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 160);
  return (
    <div
      className="att-menu"
      style={{ left, top }}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button type="button" className="att-menu__item" role="menuitem" onClick={onOpen}>
        {labels.open}
      </button>
      <button type="button" className="att-menu__item" role="menuitem" onClick={onReveal}>
        {labels.reveal}
      </button>
      <button type="button" className="att-menu__item" role="menuitem" onClick={onCopy}>
        <IconCopy size={14} /> {labels.copyPath}
      </button>
      {showAdd && (
        <button type="button" className="att-menu__item" role="menuitem" onClick={onAdd}>
          <IconPaperclip size={14} /> {labels.addToComposer}
        </button>
      )}
    </div>
  );
}
