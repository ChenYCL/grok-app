/**
 * Viewport-aware floating menus.
 * Always pair with createPortal(..., document.body) so overflow parents never clip.
 *
 * Default width is content-sized (`fitContent`). Pass `matchTriggerWidth` when the
 * panel should be at least as wide as the trigger (e.g. account sheet).
 */

import {
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

export type FloatingPlacement = "up" | "down" | "auto";

export interface FloatingPos {
  left: number;
  top: number;
  /** Fixed width when not fit-content; 0 means content-sized. */
  width: number;
  placeAbove: boolean;
  maxHeight: number;
  /** Viewport clamp for content-sized panels. */
  maxWidth: number;
  fitContent: boolean;
}

export interface ComputeFloatingOptions {
  /**
   * Preferred fixed panel width (px). Ignored when `fitContent` is true
   * (unless used as a soft estimate for left clamping).
   */
  width?: number;
  /** Minimum width; if matchTriggerWidth, at least trigger width. */
  minWidth?: number;
  /** Stretch to at least trigger width (still allows content to grow when fitContent). */
  matchTriggerWidth?: boolean;
  /**
   * Size panel to item content + padding (no fixed width). Default true.
   * Set false only when an explicit fixed `width` is required.
   */
  fitContent?: boolean;
  /** Estimated panel height for flip heuristics. */
  estHeight?: number;
  placement?: FloatingPlacement;
  gap?: number;
  margin?: number;
}

export function computeFloatingPos(
  trigger: DOMRect,
  opts: ComputeFloatingOptions = {},
): FloatingPos {
  const gap = opts.gap ?? 6;
  const margin = opts.margin ?? 8;
  const estHeight = opts.estHeight ?? 240;
  const placement = opts.placement ?? "auto";
  const fitContent = opts.fitContent !== false;

  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  const vw = typeof g.innerWidth === "number" ? g.innerWidth : 1024;
  const vh = typeof g.innerHeight === "number" ? g.innerHeight : 768;
  const maxWidth = Math.max(120, vw - margin * 2);

  let width = 0;
  if (!fitContent) {
    width = opts.width ?? 240;
    if (opts.matchTriggerWidth) {
      width = Math.max(width, trigger.width, opts.minWidth ?? 0);
    } else if (opts.minWidth) {
      width = Math.max(width, opts.minWidth);
    }
    width = Math.min(width, maxWidth);
  } else if (opts.matchTriggerWidth) {
    // Soft floor for positioning estimates only (style uses max-content + minWidth).
    width = Math.min(
      Math.max(trigger.width, opts.minWidth ?? 0, opts.width ?? 0),
      maxWidth,
    );
  } else {
    width = Math.min(opts.width ?? opts.minWidth ?? 160, maxWidth);
  }

  const spaceAbove = trigger.top - margin;
  const spaceBelow = vh - trigger.bottom - margin;

  let placeAbove: boolean;
  if (placement === "up") placeAbove = true;
  else if (placement === "down") placeAbove = false;
  else placeAbove = spaceAbove >= estHeight || spaceAbove > spaceBelow;

  const maxHeight = Math.max(
    120,
    Math.min(estHeight + 80, placeAbove ? spaceAbove - gap : spaceBelow - gap),
  );

  // Prefer trigger left edge; clamp so estimated panel stays in viewport.
  let left = trigger.left;
  left = Math.max(margin, Math.min(left, vw - width - margin));

  if (placeAbove) {
    return {
      left,
      top: trigger.top - gap,
      width: fitContent ? 0 : width,
      placeAbove: true,
      maxHeight,
      maxWidth,
      fitContent,
    };
  }
  return {
    left,
    top: trigger.bottom + gap,
    width: fitContent ? 0 : width,
    placeAbove: false,
    maxHeight,
    maxWidth,
    fitContent,
  };
}

export function floatingStyle(
  pos: FloatingPos | null,
  extras?: { minWidth?: number },
): CSSProperties | undefined {
  if (!pos) return undefined;
  const base: CSSProperties = {
    position: "fixed",
    left: pos.left,
    top: pos.top,
    maxHeight: pos.maxHeight,
    maxWidth: pos.maxWidth,
    zIndex: 10000,
  };
  if (pos.fitContent) {
    base.width = "max-content";
    if (extras?.minWidth) base.minWidth = extras.minWidth;
  } else {
    /* Lock both width and maxWidth so content (nowrap labels) cannot expand the panel. */
    base.width = pos.width;
    base.maxWidth = Math.min(pos.width, pos.maxWidth);
    base.minWidth = 0;
    base.overflowX = "hidden";
  }
  if (pos.placeAbove) {
    base.transform = "translateY(-100%)";
  }
  return base;
}

export interface UseFloatingMenuOptions {
  open: boolean;
  /** Trigger element used for positioning. */
  triggerRef: RefObject<HTMLElement | null>;
  /** Panel element (for outside-click + ignore + overflow clamp). */
  panelRef: RefObject<HTMLElement | null>;
  /** Optional extra roots that count as "inside" (e.g. trigger wrapper). */
  roots?: Array<RefObject<HTMLElement | null>>;
  onClose: () => void;
  placement?: FloatingPlacement;
  width?: number;
  minWidth?: number;
  matchTriggerWidth?: boolean;
  /** Default true — panel width follows content. */
  fitContent?: boolean;
  estHeight?: number;
  gap?: number;
  /** Extra deps that should recompute position (e.g. nested content). */
  deps?: unknown[];
}

/**
 * Tracks open panel position and wires outside-click / Escape / scroll / resize.
 */
export function useFloatingMenu({
  open,
  triggerRef,
  panelRef,
  roots = [],
  onClose,
  placement = "auto",
  width,
  minWidth,
  matchTriggerWidth,
  fitContent = true,
  estHeight = 240,
  gap = 6,
  deps = [],
}: UseFloatingMenuOptions): {
  pos: FloatingPos | null;
  style: CSSProperties | undefined;
} {
  const [pos, setPos] = useState<FloatingPos | null>(null);
  const [triggerW, setTriggerW] = useState(0);

  const update = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTriggerW(r.width);
    setPos(
      computeFloatingPos(r, {
        width,
        minWidth,
        matchTriggerWidth,
        fitContent,
        estHeight,
        placement,
        gap,
      }),
    );
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    update();
    // Ignore scrolls that originate inside the panel (list keyboard/filter
    // scrolling). Those used to re-anchor the menu every frame → flicker.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && panelRef.current?.contains(t)) return;
      update();
    };
    const onResize = () => update();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    placement,
    width,
    minWidth,
    matchTriggerWidth,
    fitContent,
    estHeight,
    gap,
    ...deps,
  ]);

  // After paint: if content-sized panel overflows the right edge, shift left.
  useLayoutEffect(() => {
    if (!open || !pos?.fitContent) return;
    const panel = panelRef.current;
    if (!panel) return;
    const margin = 8;
    const vw =
      typeof globalThis.innerWidth === "number" ? globalThis.innerWidth : 1024;
    const r = panel.getBoundingClientRect();
    if (r.right > vw - margin) {
      const nextLeft = Math.max(margin, vw - margin - r.width);
      if (Math.abs(nextLeft - pos.left) > 0.5) {
        setPos((p) => (p ? { ...p, left: nextLeft } : p));
      }
    }
  }, [open, pos, panelRef]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      for (const r of roots) {
        if (r.current?.contains(t)) return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, triggerRef, panelRef, roots]);

  const styleMin =
    matchTriggerWidth && triggerW > 0
      ? Math.max(triggerW, minWidth ?? 0)
      : minWidth;

  return {
    pos,
    style: floatingStyle(pos, { minWidth: styleMin }),
  };
}
