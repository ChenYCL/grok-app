/**
 * Personal center entry — upward popover with settings / theme / doctor.
 * Menu is portaled to body so sidebar overflow never clips it.
 */

import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  IconDoctor,
  IconSettings,
  IconThemeMoon,
  IconThemeSun,
} from "@/components/icons";
import type { Theme } from "@/lib/theme";
import { useFloatingMenu } from "@/lib/floatingMenu";

export interface UserMenuProps {
  open: boolean;
  onClose: () => void;
  theme: Theme;
  labels: {
    settings: string;
    theme: string;
    themeLight: string;
    themeDark: string;
    doctor: string;
    local: string;
  };
  cliOk: boolean;
  authOk: boolean;
  onSettings: () => void;
  onToggleTheme: () => void;
  onDoctor: () => void;
  /** Anchor: render menu above this footer row */
  children: ReactNode;
}

export function UserMenu({
  open,
  onClose,
  theme,
  labels,
  cliOk,
  authOk,
  onSettings,
  onToggleTheme,
  onDoctor,
  children,
}: UserMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { pos, style } = useFloatingMenu({
    open,
    triggerRef,
    panelRef,
    roots: [rootRef],
    onClose,
    placement: "up",
    matchTriggerWidth: true,
    minWidth: 200,
    width: 220,
    estHeight: 200,
    gap: 6,
  });

  const panel =
    open && pos && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            className="user-menu__pop user-menu__pop--portal"
            role="menu"
            style={style}
          >
            <div className="user-menu__status">
              <span>{labels.local}</span>
              <span className="user-menu__status-meta">
                {cliOk ? "CLI ✓" : "CLI —"}
                {authOk ? " · Auth ✓" : " · Auth —"}
              </span>
            </div>
            <button
              type="button"
              className="user-menu__item"
              role="menuitem"
              onClick={() => {
                onClose();
                onSettings();
              }}
            >
              <IconSettings size={16} />
              <span>{labels.settings}</span>
            </button>
            <button
              type="button"
              className="user-menu__item"
              role="menuitem"
              onClick={() => {
                onToggleTheme();
              }}
            >
              {theme === "dark" ? (
                <IconThemeSun size={16} />
              ) : (
                <IconThemeMoon size={16} />
              )}
              <span>
                {labels.theme}
                <em>
                  {theme === "dark" ? labels.themeLight : labels.themeDark}
                </em>
              </span>
            </button>
            <button
              type="button"
              className="user-menu__item"
              role="menuitem"
              onClick={() => {
                onClose();
                onDoctor();
              }}
            >
              <IconDoctor size={16} />
              <span>{labels.doctor}</span>
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={"user-menu" + (open ? " is-open" : "")} ref={rootRef}>
      <div ref={triggerRef} className="user-menu__anchor">
        {children}
      </div>
      {panel}
    </div>
  );
}
