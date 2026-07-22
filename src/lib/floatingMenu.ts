/**
 * Viewport-aware floating menus.
 * Always pair with createPortal(..., document.body) so overflow parents never clip.
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
  width: number;
  placeAbove: boolean;
  maxHeight: number;
}

export interface ComputeFloatingOptions {
  /** Preferred panel width (px). Default 240. */
  width?: number;
  /** Minimum width; if matchTriggerWidth, at least trigger width. */
  minWidth?: number;
  /** Stretch to trigger width when wider than `width`. */
  matchTriggerWidth?: boolean;
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

  let width = opts.width ?? 240;
  if (opts.matchTriggerWidth) {
    width = Math.max(width, trigger.width, opts.minWidth ?? 0);
  } else if (opts.minWidth) {
    width = Math.max(width, opts.minWidth);
  }
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  const vw = typeof g.innerWidth === "number" ? g.innerWidth : 1024;
  const vh = typeof g.innerHeight === "number" ? g.innerHeight : 768;

  width = Math.min(width, vw - margin * 2);

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

  let left = trigger.left;
  left = Math.max(margin, Math.min(left, vw - width - margin));

  if (placeAbove) {
    return {
      left,
      top: trigger.top - gap,
      width,
      placeAbove: true,
      maxHeight,
    };
  }
  return {
    left,
    top: trigger.bottom + gap,
    width,
    placeAbove: false,
    maxHeight,
  };
}

export function floatingStyle(pos: FloatingPos | null): CSSProperties | undefined {
  if (!pos) return undefined;
  if (pos.placeAbove) {
    return {
      position: "fixed",
      left: pos.left,
      top: pos.top,
      width: pos.width,
      maxHeight: pos.maxHeight,
      transform: "translateY(-100%)",
      zIndex: 10000,
    };
  }
  return {
    position: "fixed",
    left: pos.left,
    top: pos.top,
    width: pos.width,
    maxHeight: pos.maxHeight,
    zIndex: 10000,
  };
}

export interface UseFloatingMenuOptions {
  open: boolean;
  /** Trigger element used for positioning. */
  triggerRef: RefObject<HTMLElement | null>;
  /** Panel element (for outside-click + ignore). */
  panelRef: RefObject<HTMLElement | null>;
  /** Optional extra roots that count as "inside" (e.g. trigger wrapper). */
  roots?: Array<RefObject<HTMLElement | null>>;
  onClose: () => void;
  placement?: FloatingPlacement;
  width?: number;
  minWidth?: number;
  matchTriggerWidth?: boolean;
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
  estHeight = 240,
  gap = 6,
  deps = [],
}: UseFloatingMenuOptions): {
  pos: FloatingPos | null;
  style: CSSProperties | undefined;
} {
  const [pos, setPos] = useState<FloatingPos | null>(null);

  const update = () => {
    const el = triggerRef.current;
    if (!el) return;
    setPos(
      computeFloatingPos(el.getBoundingClientRect(), {
        width,
        minWidth,
        matchTriggerWidth,
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
    const onScroll = () => update();
    const onResize = () => update();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placement, width, minWidth, matchTriggerWidth, estHeight, gap, ...deps]);

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

  return { pos, style: floatingStyle(pos) };
}
