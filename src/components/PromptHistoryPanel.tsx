/**
 * Prompt history picker (Grok Build `/history`).
 * Tabs: current-session prompts + cross-session recent (localStorage ring).
 * Newest-first list + optional fuzzy filter; Enter/click selects into composer.
 */

import { useEffect, useRef, type CSSProperties, type Ref } from "react";
import {
  promptHistoryListPreview,
  type PromptHistoryEntry,
} from "@/lib/composerPromptHistory";
import { previewStoredAsSlash } from "@/lib/draftDoc";
import { IconClock } from "@/components/icons";

export type PromptHistoryScope = "session" | "recent";

export type PromptHistoryPanelLabels = {
  /** "This chat" tab */
  tabSession: string;
  /** "Recent (all chats)" tab */
  tabRecent: string;
  placeholder: string;
  empty: string;
  emptyFilter: string;
  emptyRecent: string;
  emptyRecentFilter: string;
  aria: string;
};

export type PromptHistoryPanelProps = {
  open: boolean;
  scope: PromptHistoryScope;
  onScopeChange: (scope: PromptHistoryScope) => void;
  entries: PromptHistoryEntry[];
  query: string;
  activeIndex: number;
  /** Focus the filter field on open (`/history`); leave false for empty-↑ browse. */
  focusFilter?: boolean;
  labels: PromptHistoryPanelLabels;
  onQueryChange: (q: string) => void;
  onActiveIndexChange: (i: number) => void;
  onSelect: (entry: PromptHistoryEntry) => void;
  onClose: () => void;
  style?: CSSProperties;
  panelRef?: Ref<HTMLDivElement | null>;
};

export function PromptHistoryPanel({
  open,
  scope,
  onScopeChange,
  entries,
  query,
  activeIndex,
  focusFilter = false,
  labels,
  onQueryChange,
  onActiveIndexChange,
  onSelect,
  onClose,
  style,
  panelRef,
}: PromptHistoryPanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const setRefs = (node: HTMLDivElement | null) => {
    listRef.current = node;
    if (typeof panelRef === "function") panelRef(node);
    else if (panelRef && "current" in panelRef) {
      (panelRef as { current: HTMLDivElement | null }).current = node;
    }
  };

  useEffect(() => {
    if (!open || !focusFilter) return;
    const t = window.setTimeout(() => {
      filterRef.current?.focus();
      filterRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, focusFilter]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-ph-idx="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, entries.length, scope]);

  if (!open) return null;

  const emptyText = query.trim()
    ? scope === "recent"
      ? labels.emptyRecentFilter
      : labels.emptyFilter
    : scope === "recent"
      ? labels.emptyRecent
      : labels.empty;

  return (
    <div
      className="menu-panel prompt-history"
      role="listbox"
      aria-label={labels.aria}
      style={style}
      ref={setRefs}
      data-testid="prompt-history-panel"
      data-scope={scope}
    >
      <div className="prompt-history__head">
        <div
          className="prompt-history__tabs settings-seg"
          role="tablist"
          aria-label={labels.aria}
        >
          <button
            type="button"
            role="tab"
            className={
              "settings-seg__btn prompt-history__tab" +
              (scope === "session" ? " is-on" : "")
            }
            aria-selected={scope === "session"}
            data-testid="prompt-history-tab-session"
            onClick={() => onScopeChange("session")}
          >
            {labels.tabSession}
          </button>
          <button
            type="button"
            role="tab"
            className={
              "settings-seg__btn prompt-history__tab" +
              (scope === "recent" ? " is-on" : "")
            }
            aria-selected={scope === "recent"}
            data-testid="prompt-history-tab-recent"
            onClick={() => onScopeChange("recent")}
          >
            {labels.tabRecent}
          </button>
        </div>
      </div>
      <div className="prompt-history__filter">
        <span className="prompt-history__filter-ico" aria-hidden>
          <IconClock size={14} />
        </span>
        <input
          ref={filterRef}
          type="search"
          className="prompt-history__input"
          value={query}
          placeholder={labels.placeholder}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={labels.placeholder}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (entries.length === 0) return;
              onActiveIndexChange(
                Math.min(activeIndex + 1, entries.length - 1),
              );
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              if (entries.length === 0) return;
              onActiveIndexChange(Math.max(activeIndex - 1, 0));
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              const entry = entries[activeIndex];
              if (entry) onSelect(entry);
            }
          }}
        />
      </div>
      <div className="prompt-history__list">
        {entries.length === 0 ? (
          <div className="prompt-history__empty">{emptyText}</div>
        ) : (
          entries.map((entry, i) => {
            const active = i === activeIndex;
            const preview = promptHistoryListPreview(
              previewStoredAsSlash(entry.text),
            );
            return (
              <button
                key={`${scope}:${entry.historyIndex}:${i}`}
                type="button"
                role="option"
                aria-selected={active}
                data-ph-idx={i}
                className={
                  "prompt-history__item" + (active ? " is-active" : "")
                }
                title={previewStoredAsSlash(entry.text)}
                onMouseEnter={() => onActiveIndexChange(i)}
                onClick={() => onSelect(entry)}
              >
                <span className="prompt-history__item-text">{preview}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
