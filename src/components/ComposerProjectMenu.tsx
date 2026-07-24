/**
 * Composer project chip — pick / clear the folder for the current session.
 * Fixes orphan chats stuck on「未选项目」after projects are added later.
 */

import { useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown, IconFolder } from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import { useFloatingMenu } from "@/lib/floatingMenu";

export type ProjectOption = {
  id: string;
  name: string;
  path: string;
  trusted: boolean;
  pathOk: boolean;
  pinned?: boolean;
};

type Props = {
  activeProject: ProjectOption | null;
  projects: ProjectOption[];
  labels: {
    noProject: string;
    pickProject: string;
    clearProject: string;
    untrusted: string;
  };
  disabled?: boolean;
  onSelect: (project: ProjectOption | null) => void;
};

export function ComposerProjectMenu({
  activeProject,
  projects,
  labels,
  disabled,
  onSelect,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const { pos, style: popStyle } = useFloatingMenu({
    open,
    triggerRef,
    panelRef: popRef,
    roots: [rootRef],
    onClose: () => setOpen(false),
    placement: "auto",
    fitContent: true,
    minWidth: 220,
    estHeight: Math.min(320, 48 + projects.length * 40),
    gap: 8,
  });

  const label = activeProject?.name ?? labels.noProject;
  const tip = activeProject?.path || labels.pickProject;

  return (
    <div ref={rootRef} className="cpm">
      <Tip label={tip} disabled={open}>
        <button
          ref={triggerRef}
          type="button"
          className={
            "chip chip--project" +
            (open ? " is-open" : "") +
            (!activeProject ? " chip--muted" : "")
          }
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <IconFolder size={14} />
          <span className="chip__label">{label}</span>
          <IconChevronDown size={12} />
        </button>
      </Tip>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            className="menu-panel cpm__pop"
            role="menu"
            style={popStyle as CSSProperties}
          >
            <div className="cpm__section">{labels.pickProject}</div>
            <button
              type="button"
              role="menuitem"
              className={
                "cpm__item" + (!activeProject ? " is-active" : "")
              }
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
            >
              <span className="cpm__item-label">{labels.noProject}</span>
              {!activeProject ? <IconCheck size={14} /> : null}
            </button>
            {projects.map((p) => {
              const active = activeProject?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className={"cpm__item" + (active ? " is-active" : "")}
                  onClick={() => {
                    onSelect(p);
                    setOpen(false);
                  }}
                >
                  <span className="cpm__item-main">
                    <span className="cpm__item-label">{p.name}</span>
                    <span className="cpm__item-path" title={p.path}>
                      {p.path}
                    </span>
                    {!p.trusted ? (
                      <span className="cpm__item-warn">{labels.untrusted}</span>
                    ) : null}
                  </span>
                  {active ? <IconCheck size={14} /> : null}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
