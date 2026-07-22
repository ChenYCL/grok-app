/**
 * Right resource pane — Codex-inspired workbench:
 * multi-tabs · breadcrumb toolbar · preview | file tree · open-with menu.
 * Original implementation for Grok App (Tauri + React).
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import * as api from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import { resolvePreviewSrc } from "@/lib/filePreviewSrc";
import { MarkdownBody } from "@/components/MarkdownBody";
import { OverlayScroll } from "@/components/OverlayScroll";
import { FileMediaPlayer } from "@/components/FileMediaPlayer";
import { ImageUi } from "@/components/ImageUi";
import { useFloatingMenu } from "@/lib/floatingMenu";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconFolder,
  IconFiles,
  IconRefresh,
  IconSearch,
} from "@/components/icons";
import { OfficeDocumentPreview } from "@/components/OfficeDocumentPreview";
import { isOfficeKind } from "@/lib/filePreviewSrc";

export interface ResourceViewerProps {
  projectPath: string | null;
  projectName: string | null;
  locale: Locale;
  onClose?: () => void;
}

interface TreeNode {
  name: string;
  relativePath: string;
  isDir: boolean;
  size: number;
  ext: string;
  children?: TreeNode[];
  loaded?: boolean;
}

interface FileTab {
  id: string;
  relativePath: string;
  name: string;
  absolutePath: string;
  preview: api.FsReadResult | null;
  mediaSrc: string | null;
  error: string | null;
  loading: boolean;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function guessOfficeKind(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".docm")) return "docx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
  if (lower.endsWith(".pptx") || lower.endsWith(".pptm")) return "pptx";
  if (lower.endsWith(".pdf")) return "pdf";
  return "docx";
}

function breadcrumbSegs(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

/** Lightweight file-kind chip for tree rows */
function FileKindMark({ name, isDir }: { name: string; isDir: boolean }) {
  if (isDir) {
    return (
      <span className="rp-kind rp-kind--dir" aria-hidden>
        <IconFolder size={14} />
      </span>
    );
  }
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() || "" : "";
  if (ext === "md" || ext === "mdx") {
    return <span className="rp-kind rp-kind--md" aria-hidden>M</span>;
  }
  if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") {
    return <span className="rp-kind rp-kind--code" aria-hidden>{"{}"}</span>;
  }
  if (ext === "json" || ext === "toml" || ext === "yaml" || ext === "yml") {
    return <span className="rp-kind rp-kind--data" aria-hidden>{"{ }"}</span>;
  }
  if (ext === "gitignore" || lower === ".gitignore") {
    return <span className="rp-kind rp-kind--git" aria-hidden>◆</span>;
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
    return <span className="rp-kind rp-kind--img" aria-hidden>▣</span>;
  }
  return (
    <span className="rp-kind rp-kind--file" aria-hidden>
      <IconFiles size={13} />
    </span>
  );
}

export function ResourceViewer({
  projectPath,
  projectName,
  locale,
  onClose,
}: ResourceViewerProps) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [root, setRoot] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "": true,
  });
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [treeVisible, setTreeVisible] = useState(true);
  const [editors, setEditors] = useState<api.DetectedEditor[]>([]);
  const [openMenu, setOpenMenu] = useState(false);
  const openBtnRef = useRef<HTMLButtonElement>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const openRootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  const { pos, style } = useFloatingMenu({
    open: openMenu,
    triggerRef: openBtnRef,
    panelRef: openMenuRef,
    roots: [openRootRef],
    onClose: () => setOpenMenu(false),
    placement: "down",
    minWidth: 200,
    width: 220,
    estHeight: 280,
  });

  useEffect(() => {
    if (!api.isTauri()) return;
    void api
      .editorsList()
      .then((r) => setEditors(r.editors ?? []))
      .catch(() => setEditors([]));
  }, []);

  const loadDir = useCallback(
    async (relative: string): Promise<TreeNode[]> => {
      if (!projectPath) return [];
      if (!api.isTauri()) throw new Error("Tauri required");
      const entries = await api.fsListDir(projectPath, relative);
      return entries.map((e) => ({
        name: e.name,
        relativePath: e.relativePath,
        isDir: e.isDir,
        size: e.size,
        ext: e.ext,
        children: e.isDir ? [] : undefined,
        loaded: !e.isDir,
      }));
    },
    [projectPath],
  );

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setRoot([]);
      return;
    }
    setLoadingTree(true);
    setError(null);
    try {
      setRoot(await loadDir(""));
    } catch (e) {
      setError(String(e));
      setRoot([]);
    } finally {
      setLoadingTree(false);
    }
  }, [loadDir, projectPath]);

  useEffect(() => {
    void refresh();
    setTabs([]);
    setActiveId(null);
    setExpanded({ "": true });
    setQuery("");
  }, [projectPath, refresh]);

  const toggleDir = async (node: TreeNode) => {
    const key = node.relativePath;
    const willOpen = !expanded[key];
    setExpanded((ex) => ({ ...ex, [key]: willOpen }));
    if (willOpen && !node.loaded) {
      try {
        const children = await loadDir(node.relativePath);
        const patch = (list: TreeNode[]): TreeNode[] =>
          list.map((n) => {
            if (n.relativePath === key) return { ...n, children, loaded: true };
            if (n.children) return { ...n, children: patch(n.children) };
            return n;
          });
        setRoot((r) => patch(r));
      } catch (e) {
        setError(String(e));
      }
    }
  };

  const openFile = async (relativePath: string) => {
    if (!projectPath) {
      setError(tr("main.noProject"));
      return;
    }
    if (!api.isTauri()) {
      setError(tr("resources.openFailed"));
      return;
    }
    const existing = tabs.find((t) => t.relativePath === relativePath);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const tab: FileTab = {
      id,
      relativePath,
      name: baseName(relativePath),
      absolutePath: "",
      preview: null,
      mediaSrc: null,
      error: null,
      loading: true,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(id);
    try {
      const r = await api.fsReadFile(projectPath, relativePath);
      const src = await resolvePreviewSrc(r);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                preview: r,
                mediaSrc: src,
                absolutePath: r.absolutePath || "",
                name: r.name || baseName(relativePath),
                loading: false,
              }
            : t,
        ),
      );
    } catch (e) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                loading: false,
                error: `${tr("resources.openFailed")}: ${String(e)}`,
              }
            : t,
        ),
      );
    }
  };

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        const neighbor = next[idx] ?? next[idx - 1] ?? null;
        setActiveId(neighbor?.id ?? null);
      }
      return next;
    });
  };

  const absPath = activeTab?.absolutePath || "";

  const openWithEditor = async (editorId?: string) => {
    if (!absPath) return;
    setOpenMenu(false);
    try {
      if (editorId) {
        await api.openInEditor({ path: absPath, editor: editorId });
      } else {
        await api.pathOpen(absPath);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const revealActive = async () => {
    if (!absPath) return;
    setOpenMenu(false);
    try {
      await api.pathReveal(absPath);
    } catch (e) {
      setError(String(e));
    }
  };

  const copyPath = async () => {
    const p = absPath || activeTab?.relativePath;
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p);
    } catch {
      /* ignore */
    }
    setOpenMenu(false);
  };

  const filterMatch = useCallback(
    (name: string, path: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return name.toLowerCase().includes(q) || path.toLowerCase().includes(q);
    },
    [query],
  );

  const renderTree = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes
      .filter((n) => filterMatch(n.name, n.relativePath) || n.isDir)
      .map((n) => {
        const isOpen = !!expanded[n.relativePath];
        const active = activeTab?.relativePath === n.relativePath;
        return (
          <div key={n.relativePath || n.name}>
            <button
              type="button"
              className={
                "rp-tree__row" +
                (active ? " is-active" : "") +
                (n.isDir ? " is-dir" : "")
              }
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={(e) => {
                e.preventDefault();
                if (n.isDir) void toggleDir(n);
                else void openFile(n.relativePath);
              }}
              title={n.relativePath}
            >
              <span className="rp-tree__chev">
                {n.isDir ? (
                  isOpen ? (
                    <IconChevronDown size={12} />
                  ) : (
                    <IconChevronRight size={12} />
                  )
                ) : (
                  <span className="rp-tree__gap" />
                )}
              </span>
              <FileKindMark name={n.name} isDir={n.isDir} />
              <span className="rp-tree__name">{n.name}</span>
            </button>
            {n.isDir && isOpen && n.children && n.children.length > 0 && (
              <div className="rp-tree__kids">
                {renderTree(n.children, depth + 1)}
              </div>
            )}
          </div>
        );
      });

  const previewBody = useMemo(() => {
    const preview = activeTab?.preview;
    if (!preview) return null;
    if (preview.error && !preview.text && !preview.base64 && !preview.stream) {
      return <div className="rp-preview__msg">{preview.error}</div>;
    }
    const mediaSrc = activeTab?.mediaSrc ?? null;
    const dataUrl =
      preview.base64 && preview.mime
        ? `data:${preview.mime};base64,${preview.base64}`
        : null;
    const src = mediaSrc || dataUrl;

    // Word / Excel / PDF rich preview
    if (
      isOfficeKind(preview.kind) &&
      preview.absolutePath &&
      preview.kind !== "image"
    ) {
      return (
        <OfficeDocumentPreview
          kind={preview.kind === "office" ? guessOfficeKind(preview.name) : preview.kind}
          absolutePath={preview.absolutePath}
          name={preview.name}
          locale={locale}
          textFallback={preview.text}
          errorFromHost={preview.error}
        />
      );
    }

    switch (preview.kind) {
      case "image":
        if (
          preview.text &&
          (preview.mime.includes("svg") || preview.name.endsWith(".svg"))
        ) {
          return (
            <div
              className="rp-preview__svg"
              dangerouslySetInnerHTML={{ __html: preview.text }}
            />
          );
        }
        return src ? (
          <ImageUi
            className="rp-preview__img"
            src={src}
            alt={preview.name}
            path={preview.absolutePath || undefined}
            labels={{
              viewImage: tr("image.view"),
              copyImage: tr("image.copy"),
              reveal: tr("attach.reveal"),
              copyPath: tr("attach.copyPath"),
            }}
          />
        ) : (
          <div className="rp-preview__msg">{tr("resources.binary")}</div>
        );
      case "pdf":
        // Handled above via OfficeDocumentPreview; keep iframe fallback
        return src ? (
          <iframe
            className="rp-preview__frame"
            title={preview.name}
            src={src}
          />
        ) : (
          <div className="rp-preview__msg">{tr("resources.binary")}</div>
        );
      case "audio":
      case "video":
        return src ? (
          <FileMediaPlayer
            kind={preview.kind}
            src={src}
            mime={preview.mime}
            title={preview.name}
            absolutePath={preview.absolutePath || undefined}
            labels={{
              loadError: tr("media.loadError"),
              openExternal: tr("media.openExternal"),
              loading: tr("resources.loading"),
            }}
          />
        ) : (
          <div className="rp-preview__msg">{tr("resources.binary")}</div>
        );
      case "markdown":
        return (
          <div className="rp-preview__md">
            <MarkdownBody>{preview.text ?? ""}</MarkdownBody>
          </div>
        );
      case "html":
        return (
          <iframe
            className="rp-preview__frame"
            title={preview.name}
            sandbox=""
            srcDoc={preview.text ?? ""}
          />
        );
      case "json":
        try {
          const pretty = JSON.stringify(
            JSON.parse(preview.text ?? "{}"),
            null,
            2,
          );
          return <pre className="rp-preview__code">{pretty}</pre>;
        } catch {
          return <pre className="rp-preview__code">{preview.text}</pre>;
        }
      default:
        if (preview.text) {
          return (
            <pre className="rp-preview__code">
              {preview.text}
              {preview.truncated ? `\n\n… ${tr("resources.truncated")}` : ""}
            </pre>
          );
        }
        return (
          <div className="rp-preview__msg">
            {preview.error || tr("resources.binary")}
            <div className="rp-preview__meta">
              {preview.name} · {formatSize(preview.size)}
            </div>
          </div>
        );
    }
  }, [activeTab, tr, locale]);

  const crumbs = activeTab
    ? breadcrumbSegs(activeTab.relativePath)
    : projectName
      ? [projectName]
      : [];

  if (!projectPath) {
    return (
      <div className="rp" data-testid="resource-viewer">
        <div className="rp__chrome">
          <div className="rp__chrome-title">{tr("resources.title")}</div>
          {onClose && (
            <button
              type="button"
              className="chrome-btn"
              onClick={onClose}
              title={tr("common.close")}
            >
              <IconClose size={14} />
            </button>
          )}
        </div>
        <div className="rp__empty-state">
          <div className="rp__empty-title">{tr("main.noProject")}</div>
          <div className="rp__empty-desc">{tr("resources.needProject")}</div>
        </div>
      </div>
    );
  }

  const openMenuEl =
    openMenu && pos && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={openMenuRef}
            className="rp-open-menu"
            role="menu"
            id={listId}
            style={style}
          >
            {editors.length === 0 ? (
              <div className="rp-open-menu__empty">{tr("resources.noEditors")}</div>
            ) : (
              editors.map((ed) => (
                <button
                  key={ed.id}
                  type="button"
                  className="rp-open-menu__item"
                  role="menuitem"
                  onClick={() => void openWithEditor(ed.id)}
                >
                  <span className="rp-open-menu__ico" aria-hidden>
                    ⌥
                  </span>
                  <span>{ed.label}</span>
                </button>
              ))
            )}
            <button
              type="button"
              className="rp-open-menu__item"
              role="menuitem"
              onClick={() => void openWithEditor(undefined)}
            >
              <span className="rp-open-menu__ico" aria-hidden>
                ↗
              </span>
              <span>{tr("resources.openDefault")}</span>
            </button>
            <div className="rp-open-menu__sep" />
            <button
              type="button"
              className="rp-open-menu__item"
              role="menuitem"
              onClick={() => void revealActive()}
            >
              <span className="rp-open-menu__ico" aria-hidden>
                ⌁
              </span>
              <span>{tr("resources.revealFolder")}</span>
            </button>
            <button
              type="button"
              className="rp-open-menu__item"
              role="menuitem"
              onClick={() => void copyPath()}
            >
              <span className="rp-open-menu__ico" aria-hidden>
                <IconCopy size={14} />
              </span>
              <span>{tr("attach.copyPath")}</span>
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="rp" data-testid="resource-viewer">
      {/* Tabs */}
      <div className="rp-tabs">
        <div className="rp-tabs__scroll">
          {tabs.length === 0 ? (
            <div className="rp-tabs__placeholder">
              <IconFiles size={14} />
              <span>{projectName || tr("resources.files")}</span>
            </div>
          ) : (
            tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={"rp-tab" + (t.id === activeId ? " is-active" : "")}
                onClick={() => setActiveId(t.id)}
                title={t.relativePath}
              >
                <FileKindMark name={t.name} isDir={false} />
                <span className="rp-tab__name">{t.name}</span>
                <span
                  className="rp-tab__x"
                  role="button"
                  tabIndex={0}
                  title={tr("resources.tabClose")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      closeTab(t.id);
                    }
                  }}
                >
                  ×
                </span>
              </button>
            ))
          )}
        </div>
        <div className="rp-tabs__actions">
          <button
            type="button"
            className="chrome-btn"
            title={
              treeVisible
                ? tr("resources.collapseTree")
                : tr("resources.expandTree")
            }
            onClick={() => setTreeVisible((v) => !v)}
          >
            {treeVisible ? "⟩" : "⟨"}
          </button>
          {onClose && (
            <button
              type="button"
              className="chrome-btn"
              title={tr("common.close")}
              onClick={onClose}
            >
              <IconClose size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="rp-toolbar">
        <div className="rp-breadcrumb" title={activeTab?.relativePath || ""}>
          {crumbs.length === 0 ? (
            <span className="rp-breadcrumb__muted">
              {tr("resources.preview")}
            </span>
          ) : (
            crumbs.map((seg, i) => (
              <span key={`${seg}-${i}`} className="rp-breadcrumb__seg">
                {i > 0 && <span className="rp-breadcrumb__sep">›</span>}
                <span
                  className={
                    i === crumbs.length - 1
                      ? "rp-breadcrumb__cur"
                      : "rp-breadcrumb__part"
                  }
                >
                  {seg}
                </span>
              </span>
            ))
          )}
        </div>
        <div className="rp-toolbar__actions">
          <button
            type="button"
            className="rp-tool-btn"
            disabled={!absPath}
            title={tr("attach.copyPath")}
            onClick={() => void copyPath()}
          >
            <IconCopy size={14} />
            <span className="rp-tool-btn__label">
              {tr("resources.copyPathShort")}
            </span>
          </button>
          <div className="rp-open" ref={openRootRef}>
            <button
              type="button"
              ref={openBtnRef}
              className="rp-open__btn"
              disabled={!absPath}
              aria-haspopup="menu"
              aria-expanded={openMenu}
              aria-controls={listId}
              onClick={() => setOpenMenu((v) => !v)}
            >
              <span>{tr("resources.open")}</span>
              <IconChevronDown size={14} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rp__error" role="alert">
          {error}
          <button
            type="button"
            className="chrome-btn"
            onClick={() => setError(null)}
            title={tr("common.dismiss")}
          >
            <IconClose size={12} />
          </button>
        </div>
      )}
      {activeTab?.error && (
        <div className="rp__error" role="alert">
          {activeTab.error}
        </div>
      )}

      {/* Split: preview | tree */}
      <div className={"rp-split" + (treeVisible ? "" : " rp-split--solo")}>
        <div className="rp-split__preview">
          {!activeTab ? (
            <div className="rp__empty-state">
              <div className="rp__empty-title">{tr("resources.emptyPreview")}</div>
              <div className="rp__empty-desc">
                {tr("resources.emptyPreviewHint")}
              </div>
            </div>
          ) : activeTab.loading ? (
            <div className="rp__empty-state">
              <div className="rp__empty-desc">{tr("resources.loading")}</div>
            </div>
          ) : activeTab.preview &&
            isOfficeKind(activeTab.preview.kind) &&
            activeTab.preview.kind !== "image" ? (
            <div className="rp-preview-office">{previewBody}</div>
          ) : (
            <OverlayScroll className="rp-preview-scroll">
              <div className="rp-preview-body">{previewBody}</div>
            </OverlayScroll>
          )}
        </div>

        {treeVisible && (
          <div className="rp-split__tree">
            <div className="rp-tree-search">
              <IconSearch size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tr("resources.filterPh")}
                aria-label={tr("resources.filterPh")}
              />
              <button
                type="button"
                className="chrome-btn"
                title={tr("resources.refresh")}
                onClick={() => void refresh()}
              >
                <IconRefresh size={14} />
              </button>
            </div>
            <OverlayScroll className="rp-tree-scroll">
              {loadingTree ? (
                <div className="rp__empty-state rp__empty-state--sm">
                  {tr("resources.loading")}
                </div>
              ) : root.length === 0 ? (
                <div className="rp__empty-state rp__empty-state--sm">
                  {tr("resources.empty")}
                </div>
              ) : (
                renderTree(root, 0)
              )}
            </OverlayScroll>
          </div>
        )}
      </div>

      {openMenuEl}
    </div>
  );
}
