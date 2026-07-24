/**
 * Unified composer command panel (+ button and `/` slash).
 * Layout matches composer-plus single-row style:
 *   [icon] Name  description…
 */

import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import type { SlashItem } from "@/lib/slashCatalog";
import {
  IconActivity,
  IconArrowsMinimize,
  IconAttach,
  IconAutomations,
  IconBox,
  IconCircleDashed,
  IconClipboardList,
  IconDoctor,
  IconNewChat,
  IconPlug,
  IconPuzzle,
  IconSettings,
  IconShieldCheck,
  IconSkills,
  IconTarget,
} from "@/components/icons";

const ICON_SIZE = 16;

export type ComposerPlusEntry =
  | { id: "upload"; kind: "upload" }
  | { id: string; kind: "slash"; item: SlashItem };

function slashItemIcon(item: SlashItem): ReactNode {
  if (item.kind === "skill") {
    return <IconPuzzle size={ICON_SIZE} />;
  }
  const key = item.action ?? item.mode ?? item.name;
  switch (key) {
    case "goal":
      return <IconTarget size={ICON_SIZE} />;
    case "plan":
      return <IconClipboardList size={ICON_SIZE} />;
    case "compact":
      return <IconArrowsMinimize size={ICON_SIZE} />;
    case "status":
      return <IconActivity size={ICON_SIZE} />;
    case "mcp":
      return <IconPlug size={ICON_SIZE} />;
    case "doctor":
      return <IconDoctor size={ICON_SIZE} />;
    case "settings":
      return <IconSettings size={ICON_SIZE} />;
    case "automations":
      return <IconAutomations size={ICON_SIZE} />;
    case "newChat":
    case "new":
      return <IconNewChat size={ICON_SIZE} />;
    case "yolo":
    case "always-approve":
      return <IconShieldCheck size={ICON_SIZE} />;
    default:
      if (item.kind === "mode") return <IconCircleDashed size={ICON_SIZE} />;
      if (item.kind === "action") return <IconBox size={ICON_SIZE} />;
      return <IconSkills size={ICON_SIZE} />;
  }
}

/** Build keyboard-nav flat list: optional upload + commands + skills. */
export function buildComposerPlusEntries(opts: {
  showUpload: boolean;
  commands: SlashItem[];
  skills: SlashItem[];
}): ComposerPlusEntry[] {
  const out: ComposerPlusEntry[] = [];
  if (opts.showUpload) out.push({ id: "upload", kind: "upload" });
  for (const item of opts.commands) {
    out.push({ id: item.id, kind: "slash", item });
  }
  for (const item of opts.skills) {
    out.push({ id: item.id, kind: "slash", item });
  }
  return out;
}

/** Whether the upload row matches a slash filter query. */
export function uploadMatchesQuery(
  query: string,
  labels: { title: string; hint: string },
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    labels.title,
    labels.hint,
    "upload",
    "file",
    "files",
    "attach",
    "folder",
    "上传",
    "文件",
    "附件",
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

export function ComposerPlusPanel({
  open,
  locale,
  style,
  panelRef,
  commands,
  skills,
  showUpload,
  skillsLoading,
  activeIndex,
  onActiveIndexChange,
  onSelectUpload,
  onSelectSlash,
  resolveTitle,
  resolveDescription,
}: {
  open: boolean;
  locale: Locale;
  style?: CSSProperties;
  panelRef?: Ref<HTMLDivElement | null>;
  commands: SlashItem[];
  skills: SlashItem[];
  showUpload: boolean;
  skillsLoading?: boolean;
  activeIndex: number;
  onActiveIndexChange: (i: number) => void;
  onSelectUpload: () => void;
  onSelectSlash: (item: SlashItem) => void;
  resolveTitle: (item: SlashItem) => string;
  resolveDescription: (item: SlashItem) => string;
}) {
  const tr = createT(locale);
  const listRef = useRef<HTMLDivElement | null>(null);

  const setRefs = (node: HTMLDivElement | null) => {
    listRef.current = node;
    if (typeof panelRef === "function") panelRef(node);
    else if (panelRef && "current" in panelRef) {
      (panelRef as { current: HTMLDivElement | null }).current = node;
    }
  };

  /**
   * Keep the active row visible by scrolling only this panel (not the page).
   * Avoid scrollIntoView — it scrolls ancestors and re-anchors the floating
   * menu (looked like the list jumping back to the top / flickering).
   */
  useEffect(() => {
    if (!open) return;
    const panel = listRef.current;
    if (!panel) return;
    const el = panel.querySelector<HTMLElement>(
      `[data-plus-idx="${activeIndex}"]`,
    );
    if (!el) return;
    const pRect = panel.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < pRect.top) {
      panel.scrollTop -= pRect.top - eRect.top;
    } else if (eRect.bottom > pRect.bottom) {
      panel.scrollTop += eRect.bottom - pRect.bottom;
    }
  }, [activeIndex, open]);

  /** When the filter result set changes, pin list to top once. */
  const filterKey = `${showUpload ? 1 : 0}:${commands.map((c) => c.id).join(",")}:${skills.map((s) => s.id).join(",")}`;
  const prevFilterKey = useRef(filterKey);
  useEffect(() => {
    if (!open) return;
    if (prevFilterKey.current === filterKey) return;
    prevFilterKey.current = filterKey;
    const panel = listRef.current;
    if (panel) panel.scrollTop = 0;
  }, [filterKey, open]);

  if (!open) return null;

  let idx = 0;

  const renderSlash = (item: SlashItem) => {
    const i = idx++;
    const active = i === activeIndex;
    const title = resolveTitle(item);
    const desc = resolveDescription(item);
    const right =
      desc.trim() ||
      (item.kind === "skill" && item.source ? item.source : "") ||
      `/${item.name}`;

    return (
      <button
        key={item.id}
        type="button"
        role="option"
        aria-selected={active}
        data-plus-idx={i}
        className={"composer-plus__item" + (active ? " is-active" : "")}
        title={desc ? `${title} — ${desc}` : title}
        onMouseEnter={() => onActiveIndexChange(i)}
        onClick={() => onSelectSlash(item)}
      >
        <span className="composer-plus__ico" aria-hidden>
          {slashItemIcon(item)}
        </span>
        <span className="composer-plus__title">{title}</span>
        {right ? <span className="composer-plus__desc">{right}</span> : null}
      </button>
    );
  };

  const empty =
    !showUpload &&
    commands.length === 0 &&
    skills.length === 0 &&
    !skillsLoading;

  return (
    <div
      ref={setRefs}
      className="menu-panel composer-plus composer-plus--portal"
      role="listbox"
      style={style}
    >
      {showUpload && (
        <>
          <div className="composer-plus__section">{tr("composer.add")}</div>
          {(() => {
            const i = idx++;
            const active = i === activeIndex;
            return (
              <button
                type="button"
                role="option"
                aria-selected={active}
                data-plus-idx={i}
                className={
                  "composer-plus__item" + (active ? " is-active" : "")
                }
                onMouseEnter={() => onActiveIndexChange(i)}
                onClick={onSelectUpload}
              >
                <span className="composer-plus__ico" aria-hidden>
                  <IconAttach size={ICON_SIZE} />
                </span>
                <span className="composer-plus__title">
                  {tr("composer.addFiles")}
                </span>
                <span className="composer-plus__desc">
                  {tr("composer.addFilesHint")}
                </span>
              </button>
            );
          })()}
        </>
      )}

      {commands.length > 0 && (
        <>
          <div className="composer-plus__section">
            {tr("slash.section.commands")}
          </div>
          {commands.map(renderSlash)}
        </>
      )}

      {(skills.length > 0 || skillsLoading) && (
        <div className="composer-plus__section">{tr("composer.skills")}</div>
      )}
      {skillsLoading && (
        <div
          className="composer-plus__item composer-plus__item--muted"
          aria-busy
        >
          <span className="composer-plus__ico" aria-hidden>
            <IconSkills size={ICON_SIZE} />
          </span>
          <span className="composer-plus__title">
            {tr("composer.skillsLoading")}
          </span>
        </div>
      )}
      {!skillsLoading && skills.map(renderSlash)}

      {empty && (
        <div className="composer-plus__item composer-plus__item--muted">
          <span className="composer-plus__title">{tr("slash.empty")}</span>
        </div>
      )}
    </div>
  );
}
