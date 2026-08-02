/**
 * Empty-state / `+` picker — vertical list (Codex image-1).
 *
 * Two presentations share item markup only; width CSS is intentionally separate:
 * - empty (default): wider card in the side pane (`.sw-picker--empty`)
 * - compact: content-width dropdown inside `.sw-plus-menu` (global menu rule)
 */

import { useMemo } from "react";
import { createT, type Locale } from "@/i18n";
import {
  IconFileDiff,
  IconFolder,
  IconTerminal,
  IconWorld,
} from "@/components/icons";
import {
  sidePickerOptions,
  type SidePickerKind,
} from "@/lib/sideWorkbench";

export type SidePickerProps = {
  locale: Locale | string;
  isGitProject: boolean;
  onPick: (kind: SidePickerKind) => void;
  compact?: boolean;
  className?: string;
};

function kindIcon(kind: SidePickerKind) {
  switch (kind) {
    case "file":
      return <IconFolder size={16} />;
    case "browser":
      return <IconWorld size={16} />;
    case "terminal":
      return <IconTerminal size={16} />;
    case "review":
      return <IconFileDiff size={16} />;
  }
}

export function SidePicker({
  locale,
  isGitProject,
  onPick,
  compact = false,
  className = "",
}: SidePickerProps) {
  const tr = useMemo(() => createT(locale as Locale), [locale]);
  const options = useMemo(
    () => sidePickerOptions({ isGitProject }),
    [isGitProject],
  );

  return (
    <div
      className={
        "sw-picker" +
        (compact ? " sw-picker--compact" : " sw-picker--empty") +
        (className ? ` ${className}` : "")
      }
      role="menu"
      aria-label={tr("side.picker.aria")}
      data-testid="side-picker"
    >
      {options.map((opt) => {
        const shortcut = opt.shortcutKey ? tr(opt.shortcutKey as never) : "";
        return (
          <button
            key={opt.kind}
            type="button"
            role="menuitem"
            className="sw-picker__item"
            data-testid={`side-picker-${opt.kind}`}
            onClick={() => onPick(opt.kind)}
          >
            <span className="sw-picker__ico" aria-hidden>
              {kindIcon(opt.kind)}
            </span>
            <span className="sw-picker__label">
              {tr(opt.labelKey as never)}
            </span>
            {shortcut ? (
              <span className="sw-picker__shortcut" aria-hidden>
                {shortcut}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
