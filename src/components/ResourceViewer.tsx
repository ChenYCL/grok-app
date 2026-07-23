/**
 * Right resource pane — Codex-inspired workbench:
 * multi-tabs · breadcrumb toolbar · preview | file tree · open-with menu.
 * Original implementation for Grok App (Tauri + React).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as api from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import { resolvePreviewSrc } from "@/lib/filePreviewSrc";
import { HtmlBrowser } from "@/components/HtmlBrowser";
import { EmbeddedBrowser } from "@/components/EmbeddedBrowser";
import { MarkdownBody } from "@/components/MarkdownBody";
import { OverlayScroll } from "@/components/OverlayScroll";
import { FileMediaPlayer } from "@/components/FileMediaPlayer";
import { ImageUi } from "@/components/ImageUi";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconFiles,
  IconListTree,
  IconRefresh,
  IconSearch,
} from "@/components/icons";
import { OfficeDocumentPreview } from "@/components/OfficeDocumentPreview";
import { CodePreview } from "@/components/CodePreview";
import { isOfficeKind } from "@/lib/filePreviewSrc";
import { OpenLocationButton } from "@/components/OpenLocationButton";
import { Tip } from "@/components/ui/tooltip";
import { ContextMenu, type ContextMenuItem } from "@/components/ContextMenu";

const TREE_WIDTH_KEY = "grok-app.resourceTreeWidth";
const TREE_WIDTH_DEFAULT = 220;
const TREE_WIDTH_MIN = 140;
const TREE_WIDTH_MAX = 420;

function loadTreeWidth(): number {
  try {
    const n = Number(localStorage.getItem(TREE_WIDTH_KEY));
    if (Number.isFinite(n) && n >= TREE_WIDTH_MIN && n <= TREE_WIDTH_MAX) {
      return Math.round(n);
    }
  } catch {
    /* ignore */
  }
  return TREE_WIDTH_DEFAULT;
}

function clampTreeWidth(w: number, containerWidth: number): number {
  const maxByContainer = Math.max(
    TREE_WIDTH_MIN,
    Math.floor(containerWidth * 0.55),
  );
  const max = Math.min(TREE_WIDTH_MAX, maxByContainer);
  if (!Number.isFinite(w)) return TREE_WIDTH_DEFAULT;
  return Math.min(max, Math.max(TREE_WIDTH_MIN, Math.round(w)));
}

/** Request from chat (or elsewhere) to open a path/URL in this pane. */
export type ResourceOpenTarget =
  | { type: "file"; path: string; title?: string }
  | { type: "url"; url: string; title?: string };

export interface ResourceViewerProps {
  projectPath: string | null;
  projectName: string | null;
  locale: Locale;
  onClose?: () => void;
  /** When set, open the file/url then call onOpenRequestConsumed. */
  openRequest?: ResourceOpenTarget | null;
  onOpenRequestConsumed?: () => void;
  /**
   * Whether the right pane is currently shown.
   * When it becomes false, the file tree collapses and is not remembered.
   */
  paneActive?: boolean;
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
  /** External URL tab (web page). */
  url?: string;
  tabKind?: "file" | "url";
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
  openRequest,
  onOpenRequestConsumed,
  paneActive = true,
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
  // Default closed; session-only — not persisted; reset when pane hides.
  const [treeVisible, setTreeVisible] = useState(false);
  const [treeWidth, setTreeWidth] = useState(loadTreeWidth);
  const [resizingTree, setResizingTree] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  /** Open-with target for the location button (finder / editor id). */
  const [openWithTarget, setOpenWithTarget] = useState(() => {
    try {
      return localStorage.getItem("grok-app.openTarget") || "finder";
    } catch {
      return "finder";
    }
  });

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  // Closing the right pane always collapses the tree (not remembered).
  useEffect(() => {
    if (!paneActive) setTreeVisible(false);
  }, [paneActive]);

  // Drag-resize preview | file-tree split
  useEffect(() => {
    if (!resizingTree) return;
    const onMove = (e: PointerEvent) => {
      const box = splitRef.current?.getBoundingClientRect();
      if (!box) return;
      // Tree is on the right → width from pointer to container right edge
      const next = clampTreeWidth(box.right - e.clientX, box.width);
      setTreeWidth(next);
    };
    const onUp = () => {
      setResizingTree(false);
      setTreeWidth((w) => {
        try {
          localStorage.setItem(TREE_WIDTH_KEY, String(w));
        } catch {
          /* ignore */
        }
        return w;
      });
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [resizingTree]);

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

  const applyReadResult = (
    id: string,
    r: api.FsReadResult,
    src: string | null,
    relativePath: string,
  ) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              preview: r,
              mediaSrc: src,
              absolutePath: r.absolutePath || "",
              relativePath: relativePath || r.relativePath || t.relativePath,
              name: r.name || baseName(relativePath || r.absolutePath || "file"),
              loading: false,
              tabKind: "file" as const,
            }
          : t,
      ),
    );
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
    const existing = tabs.find(
      (t) => t.tabKind !== "url" && t.relativePath === relativePath,
    );
    if (existing) {
      setTabs((prev) => {
        const hit = prev.find((t) => t.id === existing.id);
        if (!hit) return prev;
        return [hit, ...prev.filter((t) => t.id !== existing.id)];
      });
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
      tabKind: "file",
    };
    // Newest tab on the left
    setTabs((prev) => [tab, ...prev]);
    setActiveId(id);
    try {
      const r = await api.fsReadFile(projectPath, relativePath);
      const src = await resolvePreviewSrc(r);
      applyReadResult(id, r, src, relativePath);
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

  /**
   * Open path from chat cards. Uses smart host resolver:
   * absolute → project-relative → suffix search under project root
   * (handles monorepo: agent writes `05-handoff/next.md` under a subfolder).
   */
  const openAbsoluteFile = useCallback(
    async (absolutePath: string, title?: string) => {
      if (!api.isTauri()) {
        setError(tr("resources.openFailed"));
        return;
      }
      const norm = absolutePath.trim();
      if (!norm) return;
      const existing = tabs.find(
        (t) =>
          t.tabKind !== "url" &&
          (t.absolutePath === norm || t.relativePath === norm),
      );
      if (existing) {
        // Move existing to front + activate (Chrome-like focus)
        setTabs((prev) => {
          const hit = prev.find((t) => t.id === existing.id);
          if (!hit) return prev;
          return [hit, ...prev.filter((t) => t.id !== existing.id)];
        });
        setActiveId(existing.id);
        return;
      }
      const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const tab: FileTab = {
        id,
        relativePath: norm,
        name: title || baseName(norm),
        absolutePath: norm,
        preview: null,
        mediaSrc: null,
        error: null,
        loading: true,
        tabKind: "file",
      };
      setTabs((prev) => [tab, ...prev]);
      setActiveId(id);
      try {
        const r = await api.fsOpenPath(norm, projectPath);
        const src = await resolvePreviewSrc(r);
        // Prefer project-relative tab key when file is under project
        let relKey = r.relativePath || baseName(norm);
        if (projectPath && r.absolutePath) {
          const root = projectPath.replace(/[/\\]+$/, "").replace(/\\/g, "/");
          const absN = r.absolutePath.replace(/\\/g, "/");
          if (absN.startsWith(root + "/")) {
            relKey = absN.slice(root.length + 1);
          }
        }
        applyReadResult(id, r, src, relKey);
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
    },
    [projectPath, tabs, tr],
  );

  const openUrl = useCallback(
    (url: string, title?: string) => {
      const u = url.trim();
      if (!u) return;
      const existing = tabs.find((t) => t.tabKind === "url" && t.url === u);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let name = title || u;
      try {
        name = title || new URL(u).hostname || u;
      } catch {
        /* keep */
      }
      const tab: FileTab = {
        id,
        relativePath: u,
        name,
        absolutePath: "",
        preview: null,
        mediaSrc: null,
        error: null,
        loading: false,
        url: u,
        tabKind: "url",
      };
      setTabs((prev) => [tab, ...prev]);
      setActiveId(id);
    },
    [tabs],
  );

  // External open requests (from chat file/url cards)
  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.type === "file") {
      void openAbsoluteFile(openRequest.path, openRequest.title);
    } else if (openRequest.type === "url") {
      openUrl(openRequest.url, openRequest.title);
    }
    onOpenRequestConsumed?.();
  }, [openRequest, openAbsoluteFile, openUrl, onOpenRequestConsumed]);

  /** Last tab gone → collapse the right pane (user can still re-open it manually). */
  const closePaneIfNoTabs = useCallback(
    (remaining: number) => {
      if (remaining === 0) onClose?.();
    },
    [onClose],
  );

  const closeTab = useCallback(
    (id: string) => {
      let remaining = -1;
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx < 0) {
          remaining = prev.length;
          return prev;
        }
        const next = prev.filter((t) => t.id !== id);
        remaining = next.length;
        if (activeId === id) {
          // Prefer neighbor on the left (newer), else right
          const neighbor = next[Math.max(0, idx - 1)] ?? next[0] ?? null;
          setActiveId(neighbor?.id ?? null);
        }
        return next;
      });
      if (remaining === 0) closePaneIfNoTabs(0);
    },
    [activeId, closePaneIfNoTabs],
  );

  /** Chrome-style: close every tab except `id`. */
  const closeOtherTabs = useCallback(
    (id: string) => {
      setTabs((prev) => prev.filter((t) => t.id === id));
      setActiveId(id);
    },
    [],
  );

  /** Close tabs visually to the right of `id` (higher index; older tabs). */
  const closeTabsToRight = useCallback(
    (id: string) => {
      let remaining = -1;
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx < 0) {
          remaining = prev.length;
          return prev;
        }
        const next = prev.slice(0, idx + 1);
        remaining = next.length;
        if (activeId && !next.some((t) => t.id === activeId)) {
          setActiveId(id);
        }
        return next;
      });
      if (remaining === 0) closePaneIfNoTabs(0);
    },
    [activeId, closePaneIfNoTabs],
  );

  /** Close tabs visually to the left of `id` (lower index; newer tabs). */
  const closeTabsToLeft = useCallback(
    (id: string) => {
      let remaining = -1;
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx < 0) {
          remaining = prev.length;
          return prev;
        }
        const next = prev.slice(idx);
        remaining = next.length;
        if (activeId && !next.some((t) => t.id === activeId)) {
          setActiveId(id);
        }
        return next;
      });
      if (remaining === 0) closePaneIfNoTabs(0);
    },
    [activeId, closePaneIfNoTabs],
  );

  const closeAllTabs = useCallback(() => {
    setTabs([]);
    setActiveId(null);
    closePaneIfNoTabs(0);
  }, [closePaneIfNoTabs]);

  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
  } | null>(null);

  const absPath = activeTab?.absolutePath || "";

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
            <Tip label={n.relativePath}>
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
            </Tip>
            {n.isDir && isOpen && n.children && n.children.length > 0 && (
              <div className="rp-tree__kids">
                {renderTree(n.children, depth + 1)}
              </div>
            )}
          </div>
        );
      });

  const previewBody = useMemo(() => {
    // URL tabs render via EmbeddedBrowser below (native Webview host).
    // Keep other kinds here so useMemo deps stay correct.
    if (activeTab?.tabKind === "url" && activeTab.url) {
      return null;
    }
    const preview = activeTab?.preview;
    if (!preview) {
      if (activeTab?.error) {
        return <div className="rp-preview__msg">{activeTab.error}</div>;
      }
      return null;
    }
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
          embedded
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
        // Do not use file:// in iframe — WKWebView/Tauri blocks it (blank page).
        // HtmlBrowser uses srcDoc (host text) or asset fetch; scripts work, full-bleed.
        return (
          <HtmlBrowser
            title={preview.name}
            absolutePath={preview.absolutePath || null}
            html={preview.text}
          />
        );
      case "json": {
        let body = preview.text ?? "";
        try {
          body = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          /* keep raw */
        }
        return (
          <CodePreview
            code={body}
            fileName={preview.name.endsWith(".json") ? preview.name : "data.json"}
            language="json"
            footer={
              preview.truncated ? tr("resources.truncated") : null
            }
          />
        );
      }
      default:
        if (preview.text) {
          return (
            <CodePreview
              code={preview.text}
              fileName={preview.name}
              footer={
                preview.truncated ? tr("resources.truncated") : null
              }
            />
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

  // No project and no open tabs → empty; allow absolute/url tabs without a project.
  if (!projectPath && tabs.length === 0) {
    return (
      <div className="rp" data-testid="resource-viewer">
        <div className="rp__chrome">
          <div className="rp__chrome-title">{tr("resources.title")}</div>
          {onClose && (
            <Tip label={tr("common.close")}>
              <button
                type="button"
                className="chrome-btn"
                onClick={onClose}
              >
                <IconClose size={14} />
              </button>
            </Tip>
          )}
        </div>
        <div className="rp__empty-state">
          <div className="rp__empty-title">{tr("main.noProject")}</div>
          <div className="rp__empty-desc">{tr("resources.needProject")}</div>
        </div>
      </div>
    );
  }

  /**
   * Single chrome row (Grok Desktop / Codex):
   *   [ file tabs … ] [ 打开位置 ] [ tree ] [ close ]
   * No breadcrumb title row — basename lives only in the tab.
   * Nested path is available via tab title attribute.
   */
  return (
    <div
      className="rp"
      data-testid="resource-viewer"
      aria-label={projectName ?? tr("resources.title")}
    >
      <div className="rp-chrome">
        <div className="rp-tabs" role="tablist" aria-label={tr("resources.files")}>
          <div className="rp-tabs__scroll">
            {tabs.length === 0 ? (
              <div className="rp-tabs__placeholder">
                <span className="rp-tabs__hint">{tr("resources.emptyPreview")}</span>
              </div>
            ) : (
              tabs.map((t) => {
                const active = t.id === activeId;
                return (
                  <Tip
                    key={t.id}
                    label={
                      active
                        ? t.relativePath || t.name
                        : `${t.name}\n${t.relativePath || ""}`
                    }
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={t.relativePath || t.name}
                      className={
                        "rp-tab" +
                        (active ? " is-active" : " is-inactive") +
                        (t.tabKind === "url" ? " rp-tab--url" : "")
                      }
                      onClick={() => setActiveId(t.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setTabMenu({
                          x: e.clientX,
                          y: e.clientY,
                          tabId: t.id,
                        });
                      }}
                    >
                      <FileKindMark
                        name={t.tabKind === "url" ? "web.html" : t.name}
                        isDir={false}
                      />
                      {active ? (
                        <>
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
                        </>
                      ) : null}
                    </button>
                  </Tip>
                );
              })
            )}
          </div>
        </div>
        <div className="rp-chrome__actions">
          {absPath ? (
            <OpenLocationButton
              path={absPath}
              target={openWithTarget}
              onTargetChange={(t) => {
                setOpenWithTarget(t);
                try {
                  localStorage.setItem("grok-app.openTarget", t);
                } catch {
                  /* ignore */
                }
              }}
              onOpenError={(e) => setError(e)}
              compact
              labels={{
                openLocation: tr("main.openLocation"),
                openHint: tr("main.openLocationHint"),
                openMenu: tr("main.openLocationMenu"),
                finder: tr("resources.revealFolder"),
                systemDefault: tr("resources.openDefault"),
                copyPath: tr("attach.copyPath"),
              }}
            />
          ) : null}
          <Tip
            label={
              treeVisible
                ? tr("resources.collapseTree")
                : tr("resources.expandTree")
            }
          >
            <button
              type="button"
              className={
                "chrome-btn main__pane-toggle" + (treeVisible ? " is-on" : "")
              }
              onClick={() => setTreeVisible((v) => !v)}
            >
              <IconListTree size={16} />
            </button>
          </Tip>
          {onClose && (
            <Tip label={tr("common.close")}>
              <button
                type="button"
                className="chrome-btn"
                onClick={onClose}
              >
                <IconClose size={14} />
              </button>
            </Tip>
          )}
        </div>
      </div>

      {error && (
        <div className="rp__error" role="alert">
          {error}
          <Tip label={tr("common.dismiss")}>
            <button
              type="button"
              className="chrome-btn"
              onClick={() => setError(null)}
            >
              <IconClose size={12} />
            </button>
          </Tip>
        </div>
      )}
      {activeTab?.error && (
        <div className="rp__error" role="alert">
          {activeTab.error}
        </div>
      )}

      {/* Split: preview | resizer | tree */}
      <div
        ref={splitRef}
        className={
          "rp-split" +
          (treeVisible ? "" : " rp-split--solo") +
          (resizingTree ? " is-resizing" : "")
        }
      >
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
          ) : activeTab.tabKind === "url" && activeTab.url ? (
            /* Native child Webview over host (GitHub etc. block iframe) */
            <div className="rp-preview-browser rp-preview-browser--url">
              <EmbeddedBrowser
                url={activeTab.url}
                title={activeTab.name}
                locale={locale}
                active
              />
            </div>
          ) : activeTab.preview?.kind === "html" ? (
            <div className="rp-preview-browser">{previewBody}</div>
          ) : activeTab.preview &&
            isOfficeKind(activeTab.preview.kind) &&
            activeTab.preview.kind !== "image" ? (
            <div className="rp-preview-office">{previewBody}</div>
          ) : activeTab.preview?.text &&
            (activeTab.preview.kind === "json" ||
              activeTab.preview.kind === "text" ||
              activeTab.preview.kind === "code" ||
              // host may classify source as generic text
              (!["markdown", "html", "image", "audio", "video"].includes(
                activeTab.preview.kind,
              ) &&
                !!activeTab.preview.text)) ? (
            <div className="rp-preview-code-host">{previewBody}</div>
          ) : (
            <OverlayScroll className="rp-preview-scroll">
              <div className="rp-preview-body">{previewBody}</div>
            </OverlayScroll>
          )}
        </div>

        {treeVisible && (
          <>
            <div
              className="rp-split__resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={tr("resources.resizeTree")}
              aria-valuenow={treeWidth}
              onPointerDown={(e) => {
                e.preventDefault();
                setResizingTree(true);
              }}
            />
            <div
              className="rp-split__tree"
              style={{
                width: treeWidth,
                flex: `0 0 ${treeWidth}px`,
                maxWidth: treeWidth,
                minWidth: TREE_WIDTH_MIN,
              }}
            >
              <div className="rp-tree-search">
                <IconSearch size={14} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tr("resources.filterPh")}
                  aria-label={tr("resources.filterPh")}
                />
                <Tip label={tr("resources.refresh")}>
                  <button
                    type="button"
                    className="chrome-btn"
                    onClick={() => void refresh()}
                  >
                    <IconRefresh size={14} />
                  </button>
                </Tip>
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
          </>
        )}
      </div>

      {/* Chrome-style tab context menu */}
      {(() => {
        const idx = tabMenu
          ? tabs.findIndex((t) => t.id === tabMenu.tabId)
          : -1;
        const hasLeft = idx > 0;
        const hasRight = idx >= 0 && idx < tabs.length - 1;
        const hasOthers = tabs.length > 1;
        const tabId = tabMenu?.tabId ?? "";
        const items: ContextMenuItem[] = [
          {
            id: "close",
            label: tr("resources.tabClose"),
            onClick: () => closeTab(tabId),
          },
          {
            id: "close-others",
            label: tr("resources.tabCloseOthers"),
            disabled: !hasOthers,
            onClick: () => closeOtherTabs(tabId),
          },
          {
            id: "close-right",
            label: tr("resources.tabCloseRight"),
            disabled: !hasRight,
            onClick: () => closeTabsToRight(tabId),
          },
          {
            id: "close-left",
            label: tr("resources.tabCloseLeft"),
            disabled: !hasLeft,
            onClick: () => closeTabsToLeft(tabId),
          },
          {
            id: "close-all",
            label: tr("resources.tabCloseAll"),
            onClick: () => closeAllTabs(),
          },
        ];
        return (
          <ContextMenu
            open={!!tabMenu}
            x={tabMenu?.x ?? 0}
            y={tabMenu?.y ?? 0}
            onClose={() => setTabMenu(null)}
            items={items}
            className="rp-tab-menu"
          />
        );
      })()}
    </div>
  );
}
