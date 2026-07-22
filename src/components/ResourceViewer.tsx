/**
 * Right-pane session resource viewer: project file tree + multi-format preview.
 * Click a file → full-pane preview (stack nav); back returns to tree.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as api from "@/lib/api";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconFiles,
  IconRefresh,
  IconSearch,
} from "@/components/icons";

export interface ResourceViewerProps {
  projectPath: string | null;
  projectName: string | null;
  labels: {
    title: string;
    noProject: string;
    empty: string;
    search: string;
    refresh: string;
    loading: string;
    truncated: string;
    binary: string;
    close: string;
    files: string;
    preview: string;
    back: string;
    openFailed: string;
  };
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

type ViewMode = "tree" | "preview";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ResourceViewer({
  projectPath,
  projectName,
  labels,
  onClose,
}: ResourceViewerProps) {
  const [root, setRoot] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "": true,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<api.FsReadResult | null>(null);
  const [view, setView] = useState<ViewMode>("tree");
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  const loadDir = useCallback(
    async (relative: string): Promise<TreeNode[]> => {
      if (!projectPath) return [];
      if (!api.isTauri()) {
        throw new Error("Tauri required");
      }
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
      setSelected(null);
      setPreview(null);
      setView("tree");
      return;
    }
    setLoadingTree(true);
    setError(null);
    try {
      const nodes = await loadDir("");
      setRoot(nodes);
    } catch (e) {
      setError(String(e));
      setRoot([]);
    } finally {
      setLoadingTree(false);
    }
  }, [loadDir, projectPath]);

  useEffect(() => {
    void refresh();
    setSelected(null);
    setPreview(null);
    setView("tree");
    setExpanded({ "": true });
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
            if (n.relativePath === key) {
              return { ...n, children, loaded: true };
            }
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
      setError(labels.noProject);
      return;
    }
    if (!api.isTauri()) {
      setError(labels.openFailed);
      return;
    }
    setSelected(relativePath);
    setView("preview");
    setLoadingPreview(true);
    setError(null);
    setPreview(null);
    try {
      const r = await api.fsReadFile(projectPath, relativePath);
      setPreview(r);
      // Keep errors inside the preview body only (avoid duplicate red banner).
    } catch (e) {
      setPreview(null);
      setError(`${labels.openFailed}: ${String(e)}`);
    } finally {
      setLoadingPreview(false);
    }
  };

  const backToTree = () => {
    setView("tree");
    setError(null);
  };

  const filterMatch = useCallback(
    (name: string, path: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return name.toLowerCase().includes(q) || path.toLowerCase().includes(q);
    },
    [query],
  );

  const renderTree = (nodes: TreeNode[], depth: number): ReactNode => {
    return nodes
      .filter((n) => filterMatch(n.name, n.relativePath) || n.isDir)
      .map((n) => {
        const isOpen = !!expanded[n.relativePath];
        const active = selected === n.relativePath;
        return (
          <div key={n.relativePath || n.name}>
            <button
              type="button"
              className={
                "rv-tree__row" +
                (active ? " is-active" : "") +
                (n.isDir ? " is-dir" : "")
              }
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (n.isDir) void toggleDir(n);
                else void openFile(n.relativePath);
              }}
              title={n.relativePath}
            >
              <span className="rv-tree__chev">
                {n.isDir ? (
                  isOpen ? (
                    <IconChevronDown size={12} />
                  ) : (
                    <IconChevronRight size={12} />
                  )
                ) : (
                  <span className="rv-tree__dot" />
                )}
              </span>
              <span className="rv-tree__icon">
                {n.isDir ? <IconFolder size={14} /> : <IconFiles size={14} />}
              </span>
              <span className="rv-tree__name">{n.name}</span>
              {!n.isDir && (
                <span className="rv-tree__meta">{formatSize(n.size)}</span>
              )}
            </button>
            {n.isDir && isOpen && n.children && n.children.length > 0 && (
              <div className="rv-tree__kids">
                {renderTree(n.children, depth + 1)}
              </div>
            )}
          </div>
        );
      });
  };

  const previewBody = useMemo(() => {
    if (!preview) return null;
    if (preview.error && !preview.text && !preview.base64) {
      return <div className="rv-preview__msg">{preview.error}</div>;
    }
    const dataUrl =
      preview.base64 && preview.mime
        ? `data:${preview.mime};base64,${preview.base64}`
        : null;

    switch (preview.kind) {
      case "image":
        if (preview.text && (preview.mime.includes("svg") || preview.name.endsWith(".svg"))) {
          return (
            <div
              className="rv-preview__svg"
              dangerouslySetInnerHTML={{ __html: preview.text }}
            />
          );
        }
        return dataUrl ? (
          <img className="rv-preview__img" src={dataUrl} alt={preview.name} />
        ) : (
          <div className="rv-preview__msg">{labels.binary}</div>
        );
      case "pdf":
        return dataUrl ? (
          <iframe
            className="rv-preview__frame"
            title={preview.name}
            src={dataUrl}
          />
        ) : (
          <div className="rv-preview__msg">{labels.binary}</div>
        );
      case "audio":
        return dataUrl ? (
          <audio className="rv-preview__media" controls src={dataUrl} />
        ) : null;
      case "video":
        return dataUrl ? (
          <video className="rv-preview__media" controls src={dataUrl} />
        ) : null;
      case "markdown":
        return (
          <div className="rv-preview__md">
            <MarkdownBody>{preview.text ?? ""}</MarkdownBody>
          </div>
        );
      case "html":
        return (
          <iframe
            className="rv-preview__frame"
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
          return <pre className="rv-preview__code">{pretty}</pre>;
        } catch {
          return <pre className="rv-preview__code">{preview.text}</pre>;
        }
      case "csv":
        return (
          <pre className="rv-preview__code rv-preview__csv">{preview.text}</pre>
        );
      case "office":
      case "docx":
      case "xlsx":
      case "pptx":
      case "odf":
        if (preview.text) {
          return (
            <pre className="rv-preview__code rv-preview__office">
              {preview.text}
              {preview.truncated ? `\n\n… ${labels.truncated}` : ""}
            </pre>
          );
        }
        return (
          <div className="rv-preview__msg">
            {preview.error || labels.binary}
            <div className="rv-preview__meta">
              {preview.name} · {formatSize(preview.size)}
            </div>
          </div>
        );
      case "archive":
      case "font":
      case "binary":
        return (
          <div className="rv-preview__msg">
            {preview.error || labels.binary}
            <div className="rv-preview__meta">
              {preview.name} · {formatSize(preview.size)} · {preview.mime}
            </div>
          </div>
        );
      default:
        if (preview.text) {
          return (
            <pre className="rv-preview__code">
              {preview.text}
              {preview.truncated ? `\n\n… ${labels.truncated}` : ""}
            </pre>
          );
        }
        return (
          <div className="rv-preview__msg">
            {preview.error || labels.binary}
          </div>
        );
    }
  }, [preview, labels.binary, labels.truncated]);

  if (!projectPath) {
    return (
      <div className="rv">
        <div className="rv__head">
          <strong>{labels.title}</strong>
          {onClose && (
            <button
              type="button"
              className="chrome-btn"
              onClick={onClose}
              title={labels.close}
            >
              <IconClose size={14} />
            </button>
          )}
        </div>
        <div className="rv__empty">{labels.noProject}</div>
      </div>
    );
  }

  const inPreview = view === "preview";

  return (
    <div className={"rv" + (inPreview ? " rv--preview-mode" : "")}>
      <div className="rv__head">
        <div className="rv__head-title">
          {inPreview ? (
            <>
              <button
                type="button"
                className="chrome-btn"
                title={labels.back}
                onClick={backToTree}
              >
                <IconChevronLeft size={14} />
              </button>
              <strong title={selected ?? ""}>
                {preview?.name || selected || labels.preview}
              </strong>
            </>
          ) : (
            <>
              <IconFiles size={14} />
              <strong title={projectPath}>
                {projectName || labels.title}
              </strong>
            </>
          )}
        </div>
        <div className="rv__head-actions">
          {!inPreview && (
            <>
              <button
                type="button"
                className="chrome-btn"
                title={labels.search}
                onClick={() => setShowSearch((v) => !v)}
              >
                <IconSearch size={14} />
              </button>
              <button
                type="button"
                className="chrome-btn"
                title={labels.refresh}
                onClick={() => void refresh()}
              >
                <IconRefresh size={14} />
              </button>
            </>
          )}
          {onClose && (
            <button
              type="button"
              className="chrome-btn"
              title={labels.close}
              onClick={onClose}
            >
              <IconClose size={14} />
            </button>
          )}
        </div>
      </div>

      {!inPreview && showSearch && (
        <div className="rv__search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={labels.search}
            autoFocus
          />
        </div>
      )}

      {error && <div className="rv__error">{error}</div>}

      {inPreview ? (
        <div className="rv__preview rv__preview--full">
          {loadingPreview ? (
            <div className="rv__empty">{labels.loading}</div>
          ) : preview ? (
            <>
              <div className="rv__section-label">
                {preview.relativePath} · {formatSize(preview.size)} ·{" "}
                {preview.kind}
              </div>
              <div className="rv__preview-body">{previewBody}</div>
            </>
          ) : (
            <div className="rv__empty">{labels.preview}</div>
          )}
        </div>
      ) : (
        <div className="rv__tree rv__tree--full">
          <div className="rv__section-label">{labels.files}</div>
          {loadingTree ? (
            <div className="rv__empty">{labels.loading}</div>
          ) : root.length === 0 ? (
            <div className="rv__empty">{labels.empty}</div>
          ) : (
            renderTree(root, 0)
          )}
        </div>
      )}
    </div>
  );
}
