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
import {
  formatMediaLoadErrorMessage,
  mediaLoadErrorLabelMap,
  resolveMediaLoadError,
} from "@/lib/mediaLoadPro";
import { HtmlBrowser } from "@/components/HtmlBrowser";
import { EmbeddedBrowser } from "@/components/EmbeddedBrowser";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownTiptapEditor } from "@/components/MarkdownTiptapEditor";
import { OverlayScroll } from "@/components/OverlayScroll";
import { FileMediaPlayer } from "@/components/FileMediaPlayer";
import { ImageUi } from "@/components/ImageUi";
import { detectAppPlatform, revealInOsLabel } from "@/lib/appPlatform";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconClose,
  IconCopy,
  IconEdit,
  IconExternalLink,
  IconFileDiff,
  IconFolder,
  IconFiles,
  IconListTree,
  IconPlan,
  IconRefresh,
  IconRewind,
  IconSearch,
  IconUpload,
} from "@/components/icons";
import { PlanReviewPanel } from "@/components/PlanReviewPanel";
import type { PlanReviewState } from "@/lib/planBody";
import {
  resolvePlanResourceEmptyState,
  shouldAutoLeavePlanSideMode,
  shouldShowPlanChromeButton,
} from "@/lib/planModePro";
import { OfficeDocumentPreview } from "@/components/OfficeDocumentPreview";
import { CodePreview } from "@/components/CodePreview";
import { isOfficeKind } from "@/lib/filePreviewSrc";
import { OpenLocationButton } from "@/components/OpenLocationButton";
import { Tip } from "@/components/ui/tooltip";
import { ContextMenu, type ContextMenuItem } from "@/components/ContextMenu";
import { GlassModal } from "@/components/GlassModal";
import type { MessageKey } from "@/i18n";
import {
  buildUnifiedDiff,
  changeListKey,
  nextChangeListKey,
  normalizePath,
  pathBaseName,
  pathRelativeToProject,
  sessionFileLineDelta,
  type SessionFileChange,
} from "@/lib/sessionChanges";
import {
  applySelectedHunks,
  batchSummaryVars,
  needsUntrackedWipeConfirm,
  parseUnifiedDiff,
  planBatchAccept,
  planBatchReject,
  planBatchRemainingHunks,
  planFileAccept,
  planFileReject,
  planFileRestore,
  rejectSelectedHunks,
  remainingHunkIndices,
  summarizeBatchResults,
  type BatchDiffPlan,
  type BatchDiffResultItem,
  type BatchFileInput,
  type UnifiedHunk,
} from "@/lib/diffAccept";
import {
  filterWorkspaceGitEntries,
  normalizeWorkspaceGitEntries,
  resolveWorkspaceAbsolutePath,
  workspaceGitKindBadge,
  workspaceGitKindMessageKey,
  type WorkspaceGitFile,
} from "@/lib/workspaceGit";
import {
  defaultResourceEditMode,
  isFsWriteConflict,
  isResourceDraftDirty,
  isResourceTextEditable,
} from "@/lib/resourceEdit";
import {
  asideSurfaceFromPreviewKind,
  type AsideLayoutHint,
  type AsideSurface,
} from "@/lib/layout";

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
  | { type: "url"; url: string; title?: string }
  /** Open the Changes side panel (session + workspace diffs). */
  | { type: "changes"; path?: string };

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
  /**
   * Files written/edited by agent tools in the active session (Changes panel).
   */
  sessionChanges?: SessionFileChange[];
  /**
   * Active session messages (optional; used by some side-pane helpers).
   * Accepted for forward-compat with App; not required for core file/plan UI.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionMessages?: any[];
  /**
   * Live plan snapshot for Plan review mode (exit_plan_mode / progress).
   */
  plan?: PlanReviewState | null;
  /** Increment / change to force switch into Plan mode (详情 / auto-open). */
  planFocusKey?: number | null;
  /**
   * PLAN-MODE-PRO empty-state context (composer mode, settings, hard-dismiss).
   * When omitted, empty panel falls back to the generic planEmpty copy.
   */
  planChrome?: {
    /** Composer access mode (`plan` | `agent` | …). */
    composerMode?: string;
    /** Settings: allow plan mode (false → spawn --no-plan). Default true. */
    planEnabled?: boolean;
    /** User hard-dismissed this plan cycle. */
    userClosed?: boolean;
    /** Local plan history archive is non-empty. */
    hasHistory?: boolean;
  } | null;
  onApprovePlan?: () => void;
  /** Optional revision note when requesting changes (empty allowed). */
  onRequestPlanChanges?: (note?: string) => void;
  onDismissPlan?: () => void;
  /** Open local plan review history archive (session menu / Resources). */
  onOpenPlanHistory?: () => void;
  /**
   * Ship flow from Changes → Workspace (push branch + open PR).
   * Parent opens in-app Ship dialog; never window.confirm.
   */
  onShip?: () => void;
  /**
   * Content-aware right-pane layout hint (preview kind, tree open, tabs).
   * App soft-grows aside width so chrome icons never collide with window controls.
   */
  onAsideLayoutHint?: (hint: AsideLayoutHint) => void;
}

type SideMode = "files" | "changes" | "plan";

type DiffLayout = "unified" | "split";

type DiffViewState = {
  path: string;
  name: string;
  loading: boolean;
  /** Unified diff text when available. */
  unified: string | null;
  /** Fallback: full after content only. */
  afterOnly: string | null;
  error: string | null;
  source: "payload" | "git" | "head" | "after" | null;
  /** Snapshots for side-by-side when both sides are known. */
  beforeText?: string | null;
  afterText?: string | null;
};

function emptyDiffView(
  path: string,
  name: string,
  loading: boolean,
): DiffViewState {
  return {
    path,
    name,
    loading,
    unified: null,
    afterOnly: null,
    error: null,
    source: null,
    beforeText: null,
    afterText: null,
  };
}

type ChangeSelectionSource = "session" | "workspace";

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
  /** Editable buffer (text kinds only). */
  draftText?: string | null;
  /** Last loaded/saved text — dirty = draft !== baseline. */
  baselineText?: string | null;
  mtimeMs?: number | null;
  /** true = textarea editor; false = preview (markdown default). */
  editMode?: boolean;
  saving?: boolean;
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
  sessionChanges = [],
  plan = null,
  planFocusKey = null,
  planChrome = null,
  onApprovePlan,
  onRequestPlanChanges,
  onDismissPlan,
  onOpenPlanHistory,
  onShip,
  onAsideLayoutHint,
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
  const [sideMode, setSideMode] = useState<SideMode>("files");
  const lastPlanFocusKey = useRef<number | null>(null);
  /** User opened Plan via open-in-resources / planFocus — keep empty states. */
  const [userPinnedPlanSide, setUserPinnedPlanSide] = useState(false);

  const planResourceEmpty = useMemo(
    () =>
      resolvePlanResourceEmptyState({
        planVisible: !!plan?.visible,
        planEnabled: planChrome?.planEnabled !== false,
        userClosed: !!planChrome?.userClosed,
        composerMode: planChrome?.composerMode ?? "agent",
        hasHistory: !!planChrome?.hasHistory,
      }),
    [
      plan?.visible,
      planChrome?.planEnabled,
      planChrome?.userClosed,
      planChrome?.composerMode,
      planChrome?.hasHistory,
    ],
  );
  const [treeWidth, setTreeWidth] = useState(loadTreeWidth);
  const [resizingTree, setResizingTree] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(
    null,
  );
  /** Tab id waiting for conflict resolve (reload vs overwrite). */
  const [conflictTabId, setConflictTabId] = useState<string | null>(null);
  /** Close tab while dirty — confirm discard. */
  const [discardTabId, setDiscardTabId] = useState<string | null>(null);
  const [selectedChangeSource, setSelectedChangeSource] =
    useState<ChangeSelectionSource | null>(null);
  const [diffView, setDiffView] = useState<DiffViewState | null>(null);
  /** Unified vs side-by-side when both before/after snapshots exist. */
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("unified");
  const changesListRef = useRef<HTMLDivElement>(null);
  const diffLoadSeq = useRef(0);
  const workspaceLoadSeq = useRef(0);
  /** Workspace git status (project-wide), independent of session tool edits. */
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceGitFile[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceAvailable, setWorkspaceAvailable] = useState(false);
  const [workspaceReason, setWorkspaceReason] = useState<string | null>(null);
  const [workspaceBranch, setWorkspaceBranch] = useState<string | null>(null);
  const [pathCopyFlash, setPathCopyFlash] = useState(false);
  /** Accept / reject / restore in flight. */
  const [diffActionBusy, setDiffActionBusy] = useState(false);
  /** Batch accept/reject progress (null when idle). */
  const [batchProgress, setBatchProgress] = useState<{
    action: "accept" | "reject";
    current: number;
    total: number;
  } | null>(null);
  /** Soft success / partial summary (dismissible; not a hard error). */
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  /** Per-path decision badge after accept/reject. */
  const [diffDecisionByPath, setDiffDecisionByPath] = useState<
    Record<string, "accepted" | "rejected">
  >({});
  /** After-content snapshots kept for Restore after reject. */
  const [restorableAfterByPath, setRestorableAfterByPath] = useState<
    Record<string, string>
  >({});
  /** In-app confirm for destructive reject. */
  const [rejectConfirm, setRejectConfirm] = useState<{
    path: string;
    name: string;
    untracked: boolean;
  } | null>(null);
  /** In-app confirm for batch reject (session / remaining hunks). */
  const [batchRejectConfirm, setBatchRejectConfirm] = useState<{
    plan: BatchDiffPlan;
    untracked: boolean;
  } | null>(null);
  /** In-app confirm for file-scoped reject-all-remaining hunks. */
  const [batchHunkRejectConfirm, setBatchHunkRejectConfirm] = useState(false);
  /** Open-with target for the location button (finder / editor id). */
  const [openWithTarget, setOpenWithTarget] = useState(() => {
    try {
      return localStorage.getItem("grok-app.openTarget") || "finder";
    } catch {
      return "finder";
    }
  });

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const changeCount = sessionChanges.length;
  const workspaceCount = workspaceFiles.length;
  const totalChangeBadge = changeCount + workspaceCount;
  const filteredChanges = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessionChanges;
    return sessionChanges.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.path.toLowerCase().includes(q) ||
        (c.toolKind || "").toLowerCase().includes(q),
    );
  }, [sessionChanges, query]);
  const filteredWorkspace = useMemo(
    () => filterWorkspaceGitEntries(workspaceFiles, query),
    [workspaceFiles, query],
  );

  /** Flat j/k order: session rows then workspace rows (filtered). */
  const changeNavKeys = useMemo(() => {
    const keys: string[] = [];
    for (const c of filteredChanges) {
      keys.push(changeListKey("session", c.path));
    }
    for (const w of filteredWorkspace) {
      const abs =
        normalizePath(w.absolutePath) ||
        resolveWorkspaceAbsolutePath(projectPath, w.path) ||
        w.path;
      keys.push(changeListKey("workspace", abs || w.path));
    }
    return keys;
  }, [filteredChanges, filteredWorkspace, projectPath]);

  const selectedChangeKey = useMemo(() => {
    if (!selectedChangePath || !selectedChangeSource) return null;
    return changeListKey(selectedChangeSource, selectedChangePath);
  }, [selectedChangePath, selectedChangeSource]);

  const canShowChangesTab =
    workspaceAvailable || changeCount > 0 || sideMode === "changes";

  // Report content surface → App soft-grows the aside so chrome stays usable.
  const activePreviewKind = activeTab?.preview?.kind ?? null;
  const activeTabKind = activeTab?.tabKind ?? null;
  useEffect(() => {
    if (!onAsideLayoutHint || !paneActive) return;
    let surface: AsideSurface = "empty";
    if (sideMode === "plan" && plan?.visible) {
      surface = "plan";
    } else if (sideMode === "changes" && diffView) {
      surface = "diff";
    } else if (activeTabKind === "url") {
      surface = "url";
    } else if (activePreviewKind) {
      surface = asideSurfaceFromPreviewKind(activePreviewKind);
    } else if (activeTabKind) {
      surface = "unknown";
    }
    onAsideLayoutHint({
      surface,
      treeVisible,
      tabCount: tabs.length,
    });
  }, [
    onAsideLayoutHint,
    paneActive,
    sideMode,
    plan?.visible,
    diffView,
    activePreviewKind,
    activeTabKind,
    treeVisible,
    tabs.length,
  ]);

  // Closing the right pane always collapses the tree (not remembered).
  // Also leave Plan workbench when the pane hides without a live plan, so the
  // next open is files — not a stale empty Plan panel after hard-dismiss.
  useEffect(() => {
    if (!paneActive) {
      setTreeVisible(false);
      if (sideMode === "plan" && (!plan || !plan.visible)) {
        setSideMode("files");
      }
    }
  }, [paneActive, sideMode, plan]);

  const refreshWorkspaceStatus = useCallback(async () => {
    if (!projectPath || !api.isTauri()) {
      setWorkspaceFiles([]);
      setWorkspaceAvailable(false);
      setWorkspaceBranch(null);
      setWorkspaceReason(null);
      setWorkspaceLoading(false);
      return;
    }
    const seq = ++workspaceLoadSeq.current;
    setWorkspaceLoading(true);
    try {
      const res = await api.gitStatus(projectPath);
      if (seq !== workspaceLoadSeq.current) return;
      if (!res.available) {
        setWorkspaceFiles([]);
        setWorkspaceAvailable(false);
        setWorkspaceBranch(res.branch ?? null);
        setWorkspaceReason(res.reason ?? "unavailable");
      } else {
        setWorkspaceFiles(
          normalizeWorkspaceGitEntries(res.files ?? [], projectPath),
        );
        setWorkspaceAvailable(true);
        setWorkspaceBranch(res.branch ?? null);
        setWorkspaceReason(null);
      }
    } catch (e) {
      if (seq !== workspaceLoadSeq.current) return;
      setWorkspaceFiles([]);
      setWorkspaceAvailable(false);
      setWorkspaceBranch(null);
      setWorkspaceReason(String(e));
    } finally {
      if (seq === workspaceLoadSeq.current) setWorkspaceLoading(false);
    }
  }, [projectPath]);

  // Prefetch workspace git status for badge + Changes panel (soft; project change).
  useEffect(() => {
    void refreshWorkspaceStatus();
  }, [projectPath, refreshWorkspaceStatus]);

  // Drop selection if neither session nor workspace still lists the path.
  useEffect(() => {
    if (!selectedChangePath) return;
    const n = normalizePath(selectedChangePath);
    const inSession = sessionChanges.some(
      (c) => normalizePath(c.path) === n,
    );
    const inWorkspace = workspaceFiles.some(
      (c) =>
        normalizePath(c.path) === n ||
        normalizePath(c.absolutePath) === n,
    );
    if (!inSession && !inWorkspace) {
      setSelectedChangePath(null);
      setSelectedChangeSource(null);
      setDiffView(null);
    }
  }, [sessionChanges, workspaceFiles, selectedChangePath]);

  const loadChangeDiff = useCallback(
    async (change: SessionFileChange) => {
      const path = normalizePath(change.path);
      if (!path) return;
      const seq = ++diffLoadSeq.current;
      const name = change.name || pathBaseName(path);
      setSelectedChangePath(path);
      setSelectedChangeSource("session");
      setDiffView(emptyDiffView(path, name, true));

      const relName =
        pathRelativeToProject(path, projectPath) || name;

      // 1) Tool payload before/after → local unified diff
      if (
        typeof change.before === "string" &&
        typeof change.after === "string"
      ) {
        const unified = buildUnifiedDiff(relName, change.before, change.after);
        if (seq !== diffLoadSeq.current) return;
        setDiffView({
          path,
          name,
          loading: false,
          unified,
          afterOnly: null,
          error: null,
          source: "payload",
          beforeText: change.before,
          afterText: change.after,
        });
        return;
      }

      // 2) Optional git diff under project
      if (projectPath && api.isTauri()) {
        try {
          const g = await api.gitFileDiff(projectPath, path);
          if (seq !== diffLoadSeq.current) return;
          if (g.available && g.diff?.trim()) {
            setDiffView({
              path,
              name,
              loading: false,
              unified: g.diff,
              afterOnly: null,
              error: null,
              source: "git",
              beforeText: null,
              afterText: null,
            });
            return;
          }
        } catch {
          /* soft-fail; try after content */
        }
      }

      // 3) Payload after-only, or read current file
      let afterText =
        typeof change.after === "string" && change.after.length > 0
          ? change.after
          : null;
      if (!afterText && api.isTauri()) {
        try {
          const r = await api.fsOpenPath(path, projectPath);
          if (r.text) afterText = r.text;
        } catch {
          /* ignore */
        }
      }

      // 3b) HEAD content via git_show_file + after → local unified diff
      if (
        afterText != null &&
        typeof change.before !== "string" &&
        projectPath &&
        api.isTauri()
      ) {
        try {
          const head = await api.gitShowFile(projectPath, path);
          if (seq !== diffLoadSeq.current) return;
          if (head.available && typeof head.content === "string") {
            const unified = buildUnifiedDiff(relName, head.content, afterText);
            setDiffView({
              path,
              name,
              loading: false,
              unified,
              afterOnly: null,
              error: null,
              source: "head",
              beforeText: head.content,
              afterText,
            });
            return;
          }
        } catch {
          /* soft-fail */
        }
      }

      if (seq !== diffLoadSeq.current) return;

      if (
        typeof change.before === "string" &&
        afterText != null
      ) {
        const unified = buildUnifiedDiff(relName, change.before, afterText);
        setDiffView({
          path,
          name,
          loading: false,
          unified,
          afterOnly: null,
          error: null,
          source: "payload",
          beforeText: change.before,
          afterText,
        });
        return;
      }

      if (afterText != null) {
        setDiffView({
          path,
          name,
          loading: false,
          unified: null,
          afterOnly: afterText,
          error: null,
          source: "after",
          beforeText: null,
          afterText,
        });
        return;
      }

      setDiffView(emptyDiffView(path, name, false));
    },
    [projectPath],
  );

  const loadWorkspaceDiff = useCallback(
    async (entry: WorkspaceGitFile) => {
      const abs =
        normalizePath(entry.absolutePath) ||
        resolveWorkspaceAbsolutePath(projectPath, entry.path);
      const path = abs || normalizePath(entry.path);
      if (!path) return;
      const seq = ++diffLoadSeq.current;
      const name = entry.name || pathBaseName(path);
      setSelectedChangePath(path);
      setSelectedChangeSource("workspace");
      setDiffView(emptyDiffView(path, name, true));

      const relName = entry.path || pathBaseName(path);

      // Prefer git unified diff for workspace rows
      if (projectPath && api.isTauri()) {
        try {
          const g = await api.gitFileDiff(projectPath, path);
          if (seq !== diffLoadSeq.current) return;
          if (g.available && g.diff?.trim()) {
            // Also try to load sides for optional split view
            let beforeText: string | null = null;
            let afterText: string | null = null;
            try {
              const [head, cur] = await Promise.all([
                api.gitShowFile(projectPath, path).catch(() => null),
                api.fsOpenPath(path, projectPath).catch(() => null),
              ]);
              if (head?.available && typeof head.content === "string") {
                beforeText = head.content;
              }
              if (cur?.text != null) afterText = cur.text;
            } catch {
              /* optional */
            }
            if (seq !== diffLoadSeq.current) return;
            setDiffView({
              path,
              name,
              loading: false,
              unified: g.diff,
              afterOnly: null,
              error: null,
              source: "git",
              beforeText,
              afterText,
            });
            return;
          }
        } catch {
          /* soft-fail */
        }

        // HEAD + working tree for local unified when porcelain has no unified text
        try {
          const [head, cur] = await Promise.all([
            api.gitShowFile(projectPath, path).catch(() => null),
            api.fsOpenPath(path, projectPath).catch(() => null),
          ]);
          if (seq !== diffLoadSeq.current) return;
          const afterText = cur?.text ?? null;
          if (head?.available && typeof head.content === "string" && afterText != null) {
            const unified = buildUnifiedDiff(relName, head.content, afterText);
            setDiffView({
              path,
              name,
              loading: false,
              unified,
              afterOnly: null,
              error: null,
              source: "head",
              beforeText: head.content,
              afterText,
            });
            return;
          }
          if (afterText != null) {
            // Untracked / new: show full file as after-only / +diff
            const isNew =
              entry.kind === "untracked" || entry.kind === "added";
            setDiffView({
              path,
              name,
              loading: false,
              unified: isNew ? buildUnifiedDiff(relName, "", afterText) : null,
              afterOnly: isNew ? null : afterText,
              error: null,
              source: isNew ? "git" : "after",
              beforeText: isNew ? "" : null,
              afterText,
            });
            return;
          }
        } catch {
          /* soft-fail */
        }
      }

      if (seq !== diffLoadSeq.current) return;
      setDiffView(emptyDiffView(path, name, false));
    },
    [projectPath],
  );

  const openChangeInEditor = useCallback(async (path: string) => {
    if (!path || !api.isTauri()) return;
    try {
      await api.openInEditor({ path });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const revealChangePath = useCallback(async (path: string) => {
    if (!path || !api.isTauri()) return;
    try {
      await api.pathReveal(path);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const copyChangePath = useCallback(async (path: string) => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setPathCopyFlash(true);
      window.setTimeout(() => setPathCopyFlash(false), 1200);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const workspaceKindLabel = useCallback(
    (kind: string) =>
      tr(workspaceGitKindMessageKey(kind) as MessageKey),
    [tr],
  );

  const workspaceUnavailableLabel = useCallback(() => {
    const r = (workspaceReason || "").toLowerCase();
    if (r.includes("not a git") || r.includes("not a git repository")) {
      return tr("changes.workspace.noRepo");
    }
    if (r.includes("git not available") || r.includes("not available")) {
      return tr("changes.workspace.noGit");
    }
    return tr("changes.workspace.unavailable");
  }, [tr, workspaceReason]);

  /** Resolve workspace kind for a path (session-only → modified). */
  const kindForPath = useCallback(
    (path: string): string => {
      const n = normalizePath(path);
      if (!n) return "modified";
      const w = workspaceFiles.find(
        (f) =>
          normalizePath(f.absolutePath) === n ||
          normalizePath(f.path) === n ||
          resolveWorkspaceAbsolutePath(projectPath, f.path) === n,
      );
      if (w) return w.kind;
      return "modified";
    },
    [workspaceFiles, projectPath],
  );

  const rememberRestorable = useCallback((path: string, after: string | null | undefined) => {
    if (typeof after !== "string") return;
    const key = normalizePath(path);
    if (!key) return;
    setRestorableAfterByPath((prev) =>
      prev[key] === after ? prev : { ...prev, [key]: after },
    );
  }, []);

  const markDecision = useCallback(
    (path: string, decision: "accepted" | "rejected") => {
      const key = normalizePath(path);
      if (!key) return;
      setDiffDecisionByPath((prev) => ({ ...prev, [key]: decision }));
    },
    [],
  );

  const runAcceptFile = useCallback(
    async (path: string, afterOverride?: string | null) => {
      if (!projectPath || !api.isTauri()) {
        setError(tr("changes.needProject"));
        return;
      }
      const key = normalizePath(path);
      const after =
        afterOverride ??
        (typeof diffView?.afterText === "string" ? diffView.afterText : null) ??
        restorableAfterByPath[key] ??
        null;
      if (typeof after === "string") {
        rememberRestorable(path, after);
      }
      const plan = planFileAccept({ after });
      setDiffActionBusy(true);
      setError(null);
      try {
        if (plan.mode === "write_after") {
          const res = await api.applyFilePatch(projectPath, path, plan.content);
          if (!res.ok) {
            setError(
              tr("changes.actionFailed", {
                reason: res.reason || "write failed",
              }),
            );
            return;
          }
        } else if (plan.mode === "unavailable") {
          setError(tr("changes.actionUnavailable", { reason: plan.reason }));
          return;
        }
        // keep_current: success with no disk write
        markDecision(path, "accepted");
        void refreshWorkspaceStatus();
      } catch (e) {
        setError(tr("changes.actionFailed", { reason: String(e) }));
      } finally {
        setDiffActionBusy(false);
      }
    },
    [
      projectPath,
      diffView,
      restorableAfterByPath,
      rememberRestorable,
      markDecision,
      refreshWorkspaceStatus,
      tr,
    ],
  );

  const executeRejectFile = useCallback(
    async (path: string, confirmed: boolean) => {
      if (!projectPath || !api.isTauri()) {
        setError(tr("changes.needProject"));
        return;
      }
      const key = normalizePath(path);
      const after =
        (typeof diffView?.afterText === "string" ? diffView.afterText : null) ??
        restorableAfterByPath[key] ??
        null;
      if (typeof after === "string") {
        rememberRestorable(path, after);
      }
      const before =
        typeof diffView?.beforeText === "string" &&
        normalizePath(diffView.path) === key
          ? diffView.beforeText
          : null;
      const kind = kindForPath(path);
      const plan = planFileReject({
        hasGitRepo: workspaceAvailable,
        kind,
        before,
        fileExists: true,
      });
      setDiffActionBusy(true);
      setError(null);
      try {
        if (plan.mode === "git") {
          if (plan.confirmUntracked && !confirmed) {
            setRejectConfirm({
              path,
              name: pathBaseName(path),
              untracked: true,
            });
            return;
          }
          const res = await api.gitCheckoutFile(
            projectPath,
            path,
            plan.confirmUntracked && confirmed,
          );
          if (res.needsUntrackedConfirm) {
            setRejectConfirm({
              path,
              name: pathBaseName(path),
              untracked: true,
            });
            return;
          }
          if (!res.ok) {
            // Soft-fail non-git / checkout errors → try before write when available
            const reason = (res.reason || "").toLowerCase();
            const softGit =
              reason.includes("not a git") ||
              reason.includes("git not available") ||
              reason.includes("not available");
            if (softGit && typeof before === "string") {
              const w = await api.applyFilePatch(projectPath, path, before);
              if (!w.ok) {
                setError(
                  tr("changes.actionFailed", {
                    reason: w.reason || res.reason || "reject failed",
                  }),
                );
                return;
              }
            } else {
              setError(
                tr("changes.actionFailed", {
                  reason: res.reason || "reject failed",
                }),
              );
              return;
            }
          }
        } else if (plan.mode === "write_before") {
          if (!confirmed && needsUntrackedWipeConfirm(kind)) {
            setRejectConfirm({
              path,
              name: pathBaseName(path),
              untracked: true,
            });
            return;
          }
          const res = await api.applyFilePatch(
            projectPath,
            path,
            plan.content,
          );
          if (!res.ok) {
            setError(
              tr("changes.actionFailed", {
                reason: res.reason || "write failed",
              }),
            );
            return;
          }
        } else if (plan.mode === "delete") {
          if (!confirmed) {
            setRejectConfirm({
              path,
              name: pathBaseName(path),
              untracked: true,
            });
            return;
          }
          const res = await api.deleteProjectFile(projectPath, path, true);
          if (!res.ok) {
            setError(
              tr("changes.actionFailed", {
                reason: res.reason || "delete failed",
              }),
            );
            return;
          }
        } else {
          setError(
            tr("changes.actionUnavailable", { reason: plan.reason }),
          );
          return;
        }
        markDecision(path, "rejected");
        setRejectConfirm(null);
        void refreshWorkspaceStatus();
        // Refresh diff preview after reject
        if (diffView && normalizePath(diffView.path) === key) {
          setDiffView((prev) =>
            prev
              ? {
                  ...prev,
                  afterText:
                    typeof before === "string" ? before : prev.afterText,
                  unified: null,
                  source: "after",
                }
              : prev,
          );
        }
      } catch (e) {
        setError(tr("changes.actionFailed", { reason: String(e) }));
      } finally {
        setDiffActionBusy(false);
      }
    },
    [
      projectPath,
      diffView,
      restorableAfterByPath,
      kindForPath,
      workspaceAvailable,
      rememberRestorable,
      markDecision,
      refreshWorkspaceStatus,
      tr,
    ],
  );

  const requestRejectFile = useCallback(
    (path: string) => {
      const kind = kindForPath(path);
      // Confirm all rejects; untracked wipe gets a stronger copy.
      setRejectConfirm({
        path,
        name: pathBaseName(path),
        untracked: needsUntrackedWipeConfirm(kind),
      });
    },
    [kindForPath],
  );

  const runRestoreFile = useCallback(
    async (path: string) => {
      if (!projectPath || !api.isTauri()) {
        setError(tr("changes.needProject"));
        return;
      }
      const key = normalizePath(path);
      const after =
        restorableAfterByPath[key] ??
        (typeof diffView?.afterText === "string" ? diffView.afterText : null);
      const plan = planFileRestore({ after });
      if (plan.mode !== "write_after") {
        setError(
          tr("changes.actionUnavailable", {
            reason: plan.mode === "unavailable" ? plan.reason : "no snapshot",
          }),
        );
        return;
      }
      setDiffActionBusy(true);
      setError(null);
      try {
        const res = await api.applyFilePatch(projectPath, path, plan.content);
        if (!res.ok) {
          setError(
            tr("changes.actionFailed", {
              reason: res.reason || "restore failed",
            }),
          );
          return;
        }
        markDecision(path, "accepted");
        void refreshWorkspaceStatus();
      } catch (e) {
        setError(tr("changes.actionFailed", { reason: String(e) }));
      } finally {
        setDiffActionBusy(false);
      }
    },
    [
      projectPath,
      restorableAfterByPath,
      diffView,
      markDecision,
      refreshWorkspaceStatus,
      tr,
    ],
  );

  /** Parsed hunks when unified text is available (for per-hunk actions). */
  const diffHunks: UnifiedHunk[] = useMemo(() => {
    if (!diffView?.unified) return [];
    return parseUnifiedDiff(diffView.unified).hunks;
  }, [diffView?.unified]);

  const runAcceptHunk = useCallback(
    async (hunkIndex: number) => {
      if (!projectPath || !api.isTauri() || !diffView) return;
      const before =
        typeof diffView.beforeText === "string" ? diffView.beforeText : null;
      if (before == null || diffHunks.length === 0) {
        setError(
          tr("changes.actionUnavailable", {
            reason: "hunk apply needs before snapshot",
          }),
        );
        return;
      }
      const result = applySelectedHunks(before, diffHunks, [hunkIndex]);
      if (!result.ok) {
        setError(tr("changes.actionFailed", { reason: result.error }));
        return;
      }
      // If other hunks should stay applied, start from full after and only
      // re-apply is wrong — accept one hunk from original means original+hunk.
      // When working tree already has all hunks, accepting one is keep_current
      // for that hunk. Prefer: write original+selected only when rejecting rest
      // is not desired. File-level accept is primary; hunk accept applies just
      // that hunk onto before (partial accept).
      setDiffActionBusy(true);
      try {
        const res = await api.applyFilePatch(
          projectPath,
          diffView.path,
          result.content,
        );
        if (!res.ok) {
          setError(
            tr("changes.actionFailed", {
              reason: res.reason || "hunk write failed",
            }),
          );
          return;
        }
        rememberRestorable(diffView.path, result.content);
        void refreshWorkspaceStatus();
      } catch (e) {
        setError(tr("changes.actionFailed", { reason: String(e) }));
      } finally {
        setDiffActionBusy(false);
      }
    },
    [
      projectPath,
      diffView,
      diffHunks,
      rememberRestorable,
      refreshWorkspaceStatus,
      tr,
    ],
  );

  const runRejectHunk = useCallback(
    async (hunkIndex: number) => {
      if (!projectPath || !api.isTauri() || !diffView) return;
      const current =
        typeof diffView.afterText === "string" ? diffView.afterText : null;
      if (current == null || diffHunks.length === 0) {
        setError(
          tr("changes.actionUnavailable", {
            reason: "hunk reject needs after snapshot",
          }),
        );
        return;
      }
      rememberRestorable(diffView.path, current);
      const result = rejectSelectedHunks(current, diffHunks, [hunkIndex]);
      if (!result.ok) {
        setError(tr("changes.actionFailed", { reason: result.error }));
        return;
      }
      setDiffActionBusy(true);
      try {
        const res = await api.applyFilePatch(
          projectPath,
          diffView.path,
          result.content,
        );
        if (!res.ok) {
          setError(
            tr("changes.actionFailed", {
              reason: res.reason || "hunk write failed",
            }),
          );
          return;
        }
        setDiffView((prev) =>
          prev
            ? {
                ...prev,
                afterText: result.content,
                unified:
                  typeof prev.beforeText === "string"
                    ? buildUnifiedDiff(
                        pathRelativeToProject(prev.path, projectPath) ||
                          prev.name,
                        prev.beforeText,
                        result.content,
                      )
                    : prev.unified,
              }
            : prev,
        );
        void refreshWorkspaceStatus();
      } catch (e) {
        setError(tr("changes.actionFailed", { reason: String(e) }));
      } finally {
        setDiffActionBusy(false);
      }
    },
    [
      projectPath,
      diffView,
      diffHunks,
      rememberRestorable,
      refreshWorkspaceStatus,
      tr,
    ],
  );

  /** Build BatchFileInput list for session (or single-file) remaining. */
  const buildSessionBatchInputs = useCallback((): BatchFileInput[] => {
    return sessionChanges.map((c) => {
      const key = normalizePath(c.path);
      return {
        path: c.path,
        name: c.name,
        kind: kindForPath(c.path),
        after: typeof c.after === "string" ? c.after : null,
        before: typeof c.before === "string" ? c.before : null,
        decision: key ? (diffDecisionByPath[key] ?? null) : null,
        fileExists: true,
      };
    });
  }, [sessionChanges, kindForPath, diffDecisionByPath]);

  /** Host write for one accept plan entry (no busy flag). */
  const hostAcceptOne = useCallback(
    async (
      path: string,
      after: string | null | undefined,
    ): Promise<BatchDiffResultItem> => {
      const name = pathBaseName(path);
      try {
        const plan = planFileAccept({ after });
        if (plan.mode === "write_after") {
          const res = await api.applyFilePatch(projectPath!, path, plan.content);
          if (!res.ok) {
            return {
              path,
              name,
              status: "soft_fail",
              reason: res.reason || "write failed",
            };
          }
          rememberRestorable(path, plan.content);
        } else if (plan.mode === "unavailable") {
          return { path, name, status: "skipped", reason: plan.reason };
        }
        markDecision(path, "accepted");
        return { path, name, status: "ok" };
      } catch (e) {
        return { path, name, status: "error", reason: String(e) };
      }
    },
    [projectPath, rememberRestorable, markDecision],
  );

  /** Host reject for one file (confirmed when wipe already approved). */
  const hostRejectOne = useCallback(
    async (
      path: string,
      opts: {
        confirmed: boolean;
        kind?: string | null;
        before?: string | null;
        after?: string | null;
      },
    ): Promise<BatchDiffResultItem> => {
      const name = pathBaseName(path);
      try {
        if (typeof opts.after === "string") {
          rememberRestorable(path, opts.after);
        }
        const plan = planFileReject({
          hasGitRepo: workspaceAvailable,
          kind: opts.kind,
          before: opts.before,
          fileExists: true,
        });
        if (plan.mode === "git") {
          if (plan.confirmUntracked && !opts.confirmed) {
            return {
              path,
              name,
              status: "skipped",
              reason: "needs untracked confirm",
            };
          }
          const res = await api.gitCheckoutFile(
            projectPath!,
            path,
            plan.confirmUntracked && opts.confirmed,
          );
          if (res.needsUntrackedConfirm) {
            return {
              path,
              name,
              status: "skipped",
              reason: "needs untracked confirm",
            };
          }
          if (!res.ok) {
            const reason = (res.reason || "").toLowerCase();
            const softGit =
              reason.includes("not a git") ||
              reason.includes("git not available") ||
              reason.includes("not available");
            if (softGit && typeof opts.before === "string") {
              const w = await api.applyFilePatch(
                projectPath!,
                path,
                opts.before,
              );
              if (!w.ok) {
                return {
                  path,
                  name,
                  status: "soft_fail",
                  reason: w.reason || res.reason || "reject failed",
                };
              }
            } else {
              return {
                path,
                name,
                status: "soft_fail",
                reason: res.reason || "reject failed",
              };
            }
          }
        } else if (plan.mode === "write_before") {
          const res = await api.applyFilePatch(
            projectPath!,
            path,
            plan.content,
          );
          if (!res.ok) {
            return {
              path,
              name,
              status: "soft_fail",
              reason: res.reason || "write failed",
            };
          }
        } else if (plan.mode === "delete") {
          if (!opts.confirmed) {
            return {
              path,
              name,
              status: "skipped",
              reason: "needs untracked confirm",
            };
          }
          const res = await api.deleteProjectFile(projectPath!, path, true);
          if (!res.ok) {
            return {
              path,
              name,
              status: "soft_fail",
              reason: res.reason || "delete failed",
            };
          }
        } else {
          return { path, name, status: "skipped", reason: plan.reason };
        }
        markDecision(path, "rejected");
        return { path, name, status: "ok" };
      } catch (e) {
        return { path, name, status: "error", reason: String(e) };
      }
    },
    [projectPath, workspaceAvailable, rememberRestorable, markDecision],
  );

  const publishBatchSummary = useCallback(
    (action: "accept" | "reject", items: BatchDiffResultItem[]) => {
      const summary = summarizeBatchResults(action, items);
      const vars = batchSummaryVars(summary);
      if (summary.error + summary.softFail > 0) {
        setError(
          tr(
            action === "accept"
              ? "changes.batchAcceptSummary"
              : "changes.batchRejectSummary",
            vars,
          ),
        );
        setBatchStatus(null);
      } else {
        setError(null);
        setBatchStatus(
          tr(
            action === "accept"
              ? "changes.batchAcceptSummary"
              : "changes.batchRejectSummary",
            vars,
          ),
        );
      }
    },
    [tr],
  );

  const executeBatchAccept = useCallback(
    async (plan: BatchDiffPlan) => {
      if (!projectPath || !api.isTauri() || !plan.canRun) return;
      setDiffActionBusy(true);
      setBatchStatus(null);
      setError(null);
      const results: BatchDiffResultItem[] = plan.skipped.map((e) => ({
        path: e.path,
        name: e.name,
        status: "skipped" as const,
        reason:
          e.outcome.kind === "skip"
            ? e.outcome.reason
            : undefined,
      }));
      const total = plan.run.length;
      let current = 0;
      setBatchProgress({ action: "accept", current: 0, total });
      try {
        for (const entry of plan.run) {
          current += 1;
          setBatchProgress({ action: "accept", current, total });
          const after =
            entry.outcome.kind === "run" &&
            entry.outcome.run.action === "accept" &&
            entry.outcome.run.plan.mode === "write_after"
              ? entry.outcome.run.plan.content
              : sessionChanges.find(
                  (c) => normalizePath(c.path) === normalizePath(entry.path),
                )?.after ?? null;
          const r = await hostAcceptOne(entry.path, after);
          results.push(r);
        }
        publishBatchSummary("accept", results);
        void refreshWorkspaceStatus();
      } finally {
        setBatchProgress(null);
        setDiffActionBusy(false);
      }
    },
    [
      projectPath,
      hostAcceptOne,
      publishBatchSummary,
      refreshWorkspaceStatus,
      sessionChanges,
    ],
  );

  const executeBatchReject = useCallback(
    async (plan: BatchDiffPlan, confirmed: boolean) => {
      if (!projectPath || !api.isTauri() || !plan.canRun) return;
      setBatchRejectConfirm(null);
      setDiffActionBusy(true);
      setBatchStatus(null);
      setError(null);
      const results: BatchDiffResultItem[] = plan.skipped.map((e) => ({
        path: e.path,
        name: e.name,
        status: "skipped" as const,
        reason:
          e.outcome.kind === "skip" ? e.outcome.reason : undefined,
      }));
      const total = plan.run.length;
      let current = 0;
      setBatchProgress({ action: "reject", current: 0, total });
      try {
        for (const entry of plan.run) {
          current += 1;
          setBatchProgress({ action: "reject", current, total });
          const sc = sessionChanges.find(
            (c) => normalizePath(c.path) === normalizePath(entry.path),
          );
          const needsWipe =
            entry.outcome.kind === "run" &&
            entry.outcome.run.action === "reject" &&
            entry.outcome.run.needsUntrackedConfirm;
          const r = await hostRejectOne(entry.path, {
            confirmed: confirmed || !needsWipe,
            kind: entry.kind,
            before: typeof sc?.before === "string" ? sc.before : null,
            after: typeof sc?.after === "string" ? sc.after : null,
          });
          results.push(r);
        }
        publishBatchSummary("reject", results);
        void refreshWorkspaceStatus();
      } finally {
        setBatchProgress(null);
        setDiffActionBusy(false);
      }
    },
    [
      projectPath,
      hostRejectOne,
      publishBatchSummary,
      refreshWorkspaceStatus,
      sessionChanges,
    ],
  );

  const requestBatchAcceptSession = useCallback(() => {
    if (!projectPath || !api.isTauri() || diffActionBusy) return;
    const plan = planBatchAccept(buildSessionBatchInputs(), {
      scope: "session",
    });
    if (!plan.canRun) {
      setBatchStatus(tr("changes.batchNothingRemaining"));
      return;
    }
    void executeBatchAccept(plan);
  }, [
    projectPath,
    diffActionBusy,
    buildSessionBatchInputs,
    executeBatchAccept,
    tr,
  ]);

  const requestBatchRejectSession = useCallback(() => {
    if (!projectPath || !api.isTauri() || diffActionBusy) return;
    const plan = planBatchReject(buildSessionBatchInputs(), {
      hasGitRepo: workspaceAvailable,
      scope: "session",
    });
    if (!plan.canRun) {
      setBatchStatus(tr("changes.batchNothingRemaining"));
      return;
    }
    // Always confirm batch reject; stronger copy when untracked wipes included.
    setBatchRejectConfirm({
      plan,
      untracked: plan.untrackedConfirmCount > 0,
    });
  }, [
    projectPath,
    diffActionBusy,
    buildSessionBatchInputs,
    workspaceAvailable,
    tr,
  ]);

  const remainingHunkCount = useMemo(
    () => remainingHunkIndices(diffHunks.length, []).length,
    [diffHunks.length],
  );

  const runBatchRemainingHunks = useCallback(
    async (action: "accept" | "reject") => {
      if (!projectPath || !api.isTauri() || !diffView || diffActionBusy) return;
      const plan = planBatchRemainingHunks({
        action,
        hunks: diffHunks,
        before:
          typeof diffView.beforeText === "string" ? diffView.beforeText : null,
        after:
          typeof diffView.afterText === "string" ? diffView.afterText : null,
      });
      if (!plan.ok) {
        setError(
          tr("changes.actionUnavailable", {
            reason: plan.detail || plan.reason,
          }),
        );
        return;
      }
      setDiffActionBusy(true);
      setBatchStatus(null);
      setError(null);
      setBatchProgress({
        action,
        current: 0,
        total: plan.indices.length,
      });
      try {
        if (action === "reject") {
          rememberRestorable(diffView.path, diffView.afterText);
        }
        const res = await api.applyFilePatch(
          projectPath,
          diffView.path,
          plan.content,
        );
        setBatchProgress({
          action,
          current: plan.indices.length,
          total: plan.indices.length,
        });
        if (!res.ok) {
          setError(
            tr("changes.actionFailed", {
              reason: res.reason || "hunk batch write failed",
            }),
          );
          return;
        }
        if (action === "accept") {
          rememberRestorable(diffView.path, plan.content);
          markDecision(diffView.path, "accepted");
        } else {
          markDecision(diffView.path, "rejected");
        }
        setDiffView((prev) => {
          if (!prev) return prev;
          const before =
            typeof prev.beforeText === "string" ? prev.beforeText : null;
          const rel =
            pathRelativeToProject(prev.path, projectPath) || prev.name;
          return {
            ...prev,
            afterText: plan.content,
            unified:
              before != null
                ? buildUnifiedDiff(rel, before, plan.content)
                : prev.unified,
          };
        });
        setBatchStatus(
          tr(
            action === "accept"
              ? "changes.batchHunksAcceptDone"
              : "changes.batchHunksRejectDone",
            { n: String(plan.indices.length) },
          ),
        );
        void refreshWorkspaceStatus();
      } catch (e) {
        setError(tr("changes.actionFailed", { reason: String(e) }));
      } finally {
        setBatchProgress(null);
        setDiffActionBusy(false);
        setBatchHunkRejectConfirm(false);
      }
    },
    [
      projectPath,
      diffView,
      diffHunks,
      diffActionBusy,
      rememberRestorable,
      markDecision,
      refreshWorkspaceStatus,
      tr,
    ],
  );

  const requestBatchAcceptHunks = useCallback(() => {
    void runBatchRemainingHunks("accept");
  }, [runBatchRemainingHunks]);

  const requestBatchRejectHunks = useCallback(() => {
    if (!diffView || remainingHunkCount === 0 || diffActionBusy) return;
    setBatchHunkRejectConfirm(true);
  }, [diffView, remainingHunkCount, diffActionBusy]);

  const showSidePanel = (mode: SideMode) => {
    // Plan mode uses full-width review (no side tree).
    if (mode === "plan") {
      setSideMode("plan");
      setTreeVisible(false);
      setUserPinnedPlanSide(true);
      return;
    }
    // Leaving Plan unpins empty-state hold.
    setUserPinnedPlanSide(false);
    if (treeVisible && sideMode === mode) {
      setTreeVisible(false);
      return;
    }
    setSideMode(mode);
    setTreeVisible(true);
  };

  // External “open plan in resources” (详情 / auto-open on review / plan mode).
  useEffect(() => {
    if (planFocusKey == null) return;
    if (lastPlanFocusKey.current === planFocusKey) return;
    lastPlanFocusKey.current = planFocusKey;
    setSideMode("plan");
    setTreeVisible(false);
    setUserPinnedPlanSide(true);
  }, [planFocusKey]);

  // Plan hard-dismissed while viewing plan → files only when not user-pinned
  // (open-in-resources keeps the empty state reachable).
  useEffect(() => {
    if (
      shouldAutoLeavePlanSideMode({
        sideModeIsPlan: sideMode === "plan",
        planVisible: !!plan?.visible,
        userPinnedPlanSide,
      })
    ) {
      setSideMode("files");
    }
  }, [plan, sideMode, userPinnedPlanSide]);

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
    const editable = isResourceTextEditable({
      kind: r.kind,
      text: r.text,
      truncated: r.truncated,
      error: r.error,
    });
    const text = r.text ?? null;
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
              draftText: editable ? text : null,
              baselineText: editable ? text : null,
              mtimeMs: typeof r.mtimeMs === "number" ? r.mtimeMs : null,
              editMode: editable ? defaultResourceEditMode(r.kind) : false,
              saving: false,
            }
          : t,
      ),
    );
  };

  const activeTabEditable = useMemo(() => {
    if (!activeTab?.preview || activeTab.tabKind === "url") return false;
    return isResourceTextEditable({
      kind: activeTab.preview.kind,
      text: activeTab.baselineText ?? activeTab.preview.text,
      truncated: activeTab.preview.truncated,
      error: activeTab.preview.error,
    });
  }, [activeTab]);

  const updateActiveDraft = useCallback((text: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeId ? { ...t, draftText: text } : t,
      ),
    );
  }, [activeId]);

  const revertActiveDraft = useCallback(() => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeId && t.baselineText != null
          ? { ...t, draftText: t.baselineText }
          : t,
      ),
    );
  }, [activeId]);

  const toggleActiveEditMode = useCallback(() => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeId ? { ...t, editMode: !t.editMode } : t,
      ),
    );
  }, [activeId]);

  const reloadActiveFile = useCallback(async () => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab || tab.tabKind === "url" || !api.isTauri()) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tab.id ? { ...t, loading: true, error: null } : t,
      ),
    );
    try {
      let r: api.FsReadResult;
      if (projectPath && tab.relativePath && !tab.relativePath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(tab.relativePath)) {
        r = await api.fsReadFile(projectPath, tab.relativePath);
      } else if (tab.absolutePath) {
        r = await api.fsReadAbsolute(tab.absolutePath);
      } else {
        r = await api.fsOpenPath(tab.relativePath, projectPath);
      }
      const src = await resolvePreviewSrc(r);
      applyReadResult(tab.id, r, src, tab.relativePath);
    } catch (e) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                loading: false,
                error: `${tr("resources.openFailed")}: ${String(e)}`,
              }
            : t,
        ),
      );
    }
  }, [activeId, projectPath, tabs, tr]);

  const saveActiveFile = useCallback(
    async (opts?: { force?: boolean }) => {
      const tab = tabs.find((t) => t.id === activeId);
      if (!tab || tab.tabKind === "url" || tab.draftText == null) return;
      if (!api.isTauri()) {
        setError(tr("resources.saveFailed"));
        return;
      }
      if (!isResourceDraftDirty(tab.draftText, tab.baselineText) && !opts?.force) {
        return;
      }
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id ? { ...t, saving: true, error: null } : t,
        ),
      );
      setError(null);
      try {
        const expected = opts?.force ? null : tab.mtimeMs ?? null;
        const underProject =
          !!projectPath &&
          tab.relativePath &&
          !tab.relativePath.startsWith("/") &&
          !/^[A-Za-z]:[\\/]/.test(tab.relativePath) &&
          (tab.absolutePath
            ? normalizePath(tab.absolutePath).startsWith(
                normalizePath(projectPath) + "/",
              ) ||
              normalizePath(tab.absolutePath) === normalizePath(projectPath)
            : true);

        let w: api.FsWriteResult;
        if (underProject && projectPath) {
          w = await api.fsWriteFile(
            projectPath,
            tab.relativePath,
            tab.draftText,
            expected,
          );
        } else if (tab.absolutePath) {
          w = await api.fsWriteAbsolute(
            tab.absolutePath,
            tab.draftText,
            expected,
          );
        } else {
          throw new Error(tr("resources.saveNoPath"));
        }

        const savedText = tab.draftText ?? "";
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tab.id
              ? {
                  ...t,
                  saving: false,
                  baselineText: savedText,
                  draftText: savedText,
                  mtimeMs: w.mtimeMs,
                  absolutePath: w.absolutePath || t.absolutePath,
                  preview: t.preview
                    ? {
                        ...t.preview,
                        text: savedText,
                        size: w.size,
                        mtimeMs: w.mtimeMs,
                        truncated: false,
                      }
                    : t.preview,
                }
              : t,
          ),
        );
      } catch (e) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tab.id ? { ...t, saving: false } : t,
          ),
        );
        if (isFsWriteConflict(e)) {
          setConflictTabId(tab.id);
        } else {
          setError(String(e) || tr("resources.saveFailed"));
        }
      }
    },
    [activeId, projectPath, tabs, tr],
  );

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

  const openChangeInPane = useCallback(
    (path: string) => {
      const p = normalizePath(path);
      if (!p) return;
      void openAbsoluteFile(p, pathBaseName(p));
    },
    [openAbsoluteFile],
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

  /** Force-open Changes side panel (never toggle off — used by chip / deep links). */
  const openChangesPanel = useCallback(() => {
    setSideMode("changes");
    setTreeVisible(true);
    // Focus list on next paint so j/k works without an extra click.
    requestAnimationFrame(() => {
      changesListRef.current?.focus({ preventScroll: true });
    });
  }, []);

  // External open requests (from chat file/url cards, session-changes chip, …)
  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.type === "file") {
      // Leave plan workbench so file preview is not hidden behind Plan UI.
      setSideMode("files");
      void openAbsoluteFile(openRequest.path, openRequest.title);
    } else if (openRequest.type === "url") {
      setSideMode("files");
      openUrl(openRequest.url, openRequest.title);
    } else if (openRequest.type === "changes") {
      openChangesPanel();
      const want = openRequest.path ? normalizePath(openRequest.path) : "";
      if (want) {
        const sc = sessionChanges.find(
          (c) =>
            normalizePath(c.path) === want ||
            pathRelativeToProject(c.path, projectPath) === want,
        );
        if (sc) {
          void loadChangeDiff(sc);
        } else {
          const w = workspaceFiles.find((entry) => {
            const abs =
              normalizePath(entry.absolutePath) ||
              resolveWorkspaceAbsolutePath(projectPath, entry.path);
            return (
              abs === want ||
              normalizePath(entry.path) === want ||
              pathBaseName(entry.path) === pathBaseName(want)
            );
          });
          if (w) {
            void loadWorkspaceDiff(w);
          } else {
            // Fall back: open the file so the user still lands on something useful.
            void openAbsoluteFile(want, pathBaseName(want));
          }
        }
      }
    }
    onOpenRequestConsumed?.();
  }, [
    openRequest,
    openAbsoluteFile,
    openUrl,
    openChangesPanel,
    onOpenRequestConsumed,
    sessionChanges,
    workspaceFiles,
    projectPath,
    loadChangeDiff,
    loadWorkspaceDiff,
  ]);

  // j/k in Changes list (when list is focused or focus is within the side tree).
  useEffect(() => {
    if (!treeVisible || sideMode !== "changes") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "k" && e.key !== "Enter") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = (target.tagName || "").toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target.isContentEditable
      ) {
        return;
      }
      const listEl = changesListRef.current;
      const treeEl = listEl?.closest(".rp-split__tree") ?? null;
      const within =
        (listEl && listEl.contains(target)) ||
        (treeEl && treeEl.contains(target)) ||
        document.activeElement === listEl;
      if (!within) return;

      if (e.key === "Enter") {
        if (selectedChangePath) {
          e.preventDefault();
          openChangeInPane(selectedChangePath);
        }
        return;
      }

      const dir = e.key === "j" ? "next" : "prev";
      const nextKey = nextChangeListKey(changeNavKeys, selectedChangeKey, dir);
      if (!nextKey || nextKey === selectedChangeKey) return;
      e.preventDefault();
      if (nextKey.startsWith("session:")) {
        const path = nextKey.slice("session:".length);
        const hit = filteredChanges.find(
          (c) => normalizePath(c.path) === path,
        );
        if (hit) void loadChangeDiff(hit);
      } else if (nextKey.startsWith("workspace:")) {
        const path = nextKey.slice("workspace:".length);
        const hit = filteredWorkspace.find((w) => {
          const abs =
            normalizePath(w.absolutePath) ||
            resolveWorkspaceAbsolutePath(projectPath, w.path) ||
            normalizePath(w.path);
          return abs === path || normalizePath(w.path) === path;
        });
        if (hit) void loadWorkspaceDiff(hit);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    treeVisible,
    sideMode,
    changeNavKeys,
    selectedChangeKey,
    selectedChangePath,
    filteredChanges,
    filteredWorkspace,
    projectPath,
    loadChangeDiff,
    loadWorkspaceDiff,
    openChangeInPane,
  ]);

  /** Last tab gone → collapse the right pane (user can still re-open it manually). */
  const closePaneIfNoTabs = useCallback(
    (remaining: number) => {
      if (remaining === 0) onClose?.();
    },
    [onClose],
  );

  const closeTabForced = useCallback(
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

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab && isResourceDraftDirty(tab.draftText, tab.baselineText)) {
        setDiscardTabId(id);
        return;
      }
      closeTabForced(id);
    },
    [closeTabForced, tabs],
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

  const absPath =
    (diffView && sideMode === "changes" ? diffView.path : "") ||
    activeTab?.absolutePath ||
    "";

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

  const changeStatusLabel = useCallback(
    (status: string) => {
      const s = (status || "").toLowerCase();
      if (s === "completed") return tr("changes.status.completed");
      if (s === "failed" || s === "error") return tr("changes.status.failed");
      if (s === "in_progress" || s === "running")
        return tr("changes.status.in_progress");
      if (s === "pending") return tr("changes.status.pending");
      return status || "";
    },
    [tr],
  );

  const previewBody = useMemo(() => {
    // Session / workspace change diff takes over the preview in Changes mode.
    if (sideMode === "changes" && diffView) {
      if (diffView.loading) {
        return (
          <div className="rp-preview__msg">{tr("changes.loadingDiff")}</div>
        );
      }

      const srcLabel =
        diffView.source === "git"
          ? tr("changes.sourceGit")
          : diffView.source === "head"
            ? tr("changes.sourceHead")
            : diffView.source === "payload"
              ? tr("changes.sourcePayload")
              : diffView.source === "after"
                ? tr("changes.sourceAfter")
                : null;
      const hasSplitSides =
        typeof diffView.beforeText === "string" &&
        typeof diffView.afterText === "string";
      const showSplit = diffLayout === "split" && hasSplitSides;

      const pathKey = normalizePath(diffView.path);
      const decision = pathKey ? diffDecisionByPath[pathKey] : undefined;
      const canRestore =
        !!pathKey &&
        (typeof restorableAfterByPath[pathKey] === "string" ||
          typeof diffView.afterText === "string");
      const tauriReady = !!projectPath && api.isTauri();

      const toolbar = (
        <div className="rp-diff-toolbar" role="toolbar" aria-label={tr("changes.title")}>
          <span className="rp-diff-toolbar__name" title={diffView.path}>
            {diffView.name}
          </span>
          {srcLabel ? (
            <span className="rp-diff-toolbar__source">{srcLabel}</span>
          ) : null}
          {decision === "accepted" ? (
            <span className="rp-diff-toolbar__decision is-accept">
              {tr("changes.acceptDone")}
            </span>
          ) : null}
          {decision === "rejected" ? (
            <span className="rp-diff-toolbar__decision is-reject">
              {tr("changes.rejectDone")}
            </span>
          ) : null}
          <span className="rp-diff-toolbar__spacer" />
          {hasSplitSides ? (
            <div className="rp-diff-toolbar__toggle" role="group">
              <button
                type="button"
                className={
                  "rp-diff-toolbar__btn" +
                  (diffLayout === "unified" ? " is-active" : "")
                }
                aria-pressed={diffLayout === "unified"}
                onClick={() => setDiffLayout("unified")}
              >
                {tr("changes.viewUnified")}
              </button>
              <button
                type="button"
                className={
                  "rp-diff-toolbar__btn" +
                  (diffLayout === "split" ? " is-active" : "")
                }
                aria-pressed={diffLayout === "split"}
                onClick={() => setDiffLayout("split")}
              >
                {tr("changes.viewSplit")}
              </button>
            </div>
          ) : null}
          <div className="rp-diff-toolbar__actions" role="group">
            <Tip label={tr("changes.acceptTip")}>
              <button
                type="button"
                className="chrome-btn rp-diff-action rp-diff-action--accept"
                disabled={!tauriReady || diffActionBusy}
                onClick={() => void runAcceptFile(diffView.path)}
                aria-label={tr("changes.accept")}
                data-testid="changes-accept"
              >
                <IconCheck size={14} />
              </button>
            </Tip>
            <Tip label={tr("changes.rejectTip")}>
              <button
                type="button"
                className="chrome-btn rp-diff-action rp-diff-action--reject"
                disabled={!tauriReady || diffActionBusy}
                onClick={() => requestRejectFile(diffView.path)}
                aria-label={tr("changes.reject")}
                data-testid="changes-reject"
              >
                <IconClose size={14} />
              </button>
            </Tip>
            <Tip label={tr("changes.restoreTip")}>
              <button
                type="button"
                className="chrome-btn rp-diff-action rp-diff-action--restore"
                disabled={!tauriReady || diffActionBusy || !canRestore}
                onClick={() => void runRestoreFile(diffView.path)}
                aria-label={tr("changes.restore")}
                data-testid="changes-restore"
              >
                <IconRewind size={14} />
              </button>
            </Tip>
          </div>
          <Tip label={tr("changes.openFile")}>
            <button
              type="button"
              className="chrome-btn"
              onClick={() => openChangeInPane(diffView.path)}
              aria-label={tr("changes.openFile")}
            >
              <IconFiles size={14} />
            </button>
          </Tip>
          <Tip label={tr("changes.openInEditor")}>
            <button
              type="button"
              className="chrome-btn"
              onClick={() => void openChangeInEditor(diffView.path)}
              aria-label={tr("changes.openInEditor")}
            >
              <IconExternalLink size={14} />
            </button>
          </Tip>
          <Tip label={tr("changes.reveal")}>
            <button
              type="button"
              className="chrome-btn"
              onClick={() => void revealChangePath(diffView.path)}
              aria-label={tr("changes.reveal")}
            >
              <IconFolder size={14} />
            </button>
          </Tip>
          <Tip label={pathCopyFlash ? tr("changes.pathCopied") : tr("changes.copyPath")}>
            <button
              type="button"
              className="chrome-btn"
              onClick={() => void copyChangePath(diffView.path)}
              aria-label={tr("changes.copyPath")}
            >
              <IconCopy size={14} />
            </button>
          </Tip>
        </div>
      );

      const hunkBar =
        diffHunks.length > 0 &&
        typeof diffView.beforeText === "string" &&
        typeof diffView.afterText === "string" ? (
          <div
            className="rp-diff-hunks"
            role="toolbar"
            aria-label={tr("changes.hunks")}
          >
            <span className="rp-diff-hunks__label">{tr("changes.hunks")}</span>
            {remainingHunkCount > 1 ? (
              <div className="rp-diff-hunks__batch" role="group">
                <Tip label={tr("changes.acceptAllHunksTip")}>
                  <button
                    type="button"
                    className="chrome-btn rp-diff-action rp-diff-action--accept rp-changes-batch-btn"
                    disabled={!tauriReady || diffActionBusy}
                    data-testid="changes-accept-all-hunks"
                    onClick={() => requestBatchAcceptHunks()}
                    aria-label={tr("changes.acceptAllHunks")}
                  >
                    <IconCheck size={12} />
                    <span>{tr("changes.acceptAllRemainingShort")}</span>
                  </button>
                </Tip>
                <Tip label={tr("changes.rejectAllHunksTip")}>
                  <button
                    type="button"
                    className="chrome-btn rp-diff-action rp-diff-action--reject rp-changes-batch-btn"
                    disabled={!tauriReady || diffActionBusy}
                    data-testid="changes-reject-all-hunks"
                    onClick={() => requestBatchRejectHunks()}
                    aria-label={tr("changes.rejectAllHunks")}
                  >
                    <IconClose size={12} />
                    <span>{tr("changes.rejectAllRemainingShort")}</span>
                  </button>
                </Tip>
              </div>
            ) : null}
            {diffHunks.map((h, idx) => (
              <div key={`${h.header}-${idx}`} className="rp-diff-hunks__row">
                <span className="rp-diff-hunks__name" title={h.header}>
                  {tr("changes.hunkLabel", { n: String(idx + 1) })}
                </span>
                <Tip label={tr("changes.acceptHunkTip")}>
                  <button
                    type="button"
                    className="chrome-btn rp-diff-action rp-diff-action--accept"
                    disabled={!tauriReady || diffActionBusy}
                    onClick={() => void runAcceptHunk(idx)}
                    aria-label={tr("changes.acceptHunk")}
                  >
                    <IconCheck size={12} />
                  </button>
                </Tip>
                <Tip label={tr("changes.rejectHunkTip")}>
                  <button
                    type="button"
                    className="chrome-btn rp-diff-action rp-diff-action--reject"
                    disabled={!tauriReady || diffActionBusy}
                    onClick={() => void runRejectHunk(idx)}
                    aria-label={tr("changes.rejectHunk")}
                  >
                    <IconClose size={12} />
                  </button>
                </Tip>
              </div>
            ))}
          </div>
        ) : null;

      if (showSplit) {
        return (
          <div className="rp-diff-host">
            {toolbar}
            {hunkBar}
            <div className="rp-diff-split">
              <div className="rp-diff-split__pane">
                <div className="rp-diff-split__label">
                  {tr("changes.split.before")}
                </div>
                <CodePreview
                  code={diffView.beforeText ?? ""}
                  fileName={diffView.name}
                  className="rp-diff-split__code"
                />
              </div>
              <div className="rp-diff-split__pane">
                <div className="rp-diff-split__label">
                  {tr("changes.split.after")}
                </div>
                <CodePreview
                  code={diffView.afterText ?? ""}
                  fileName={diffView.name}
                  className="rp-diff-split__code"
                />
              </div>
            </div>
          </div>
        );
      }

      if (diffView.unified) {
        return (
          <div className="rp-diff-host">
            {toolbar}
            {hunkBar}
            <CodePreview
              code={diffView.unified}
              fileName={`${diffView.name}.diff`}
              language="diff"
              footer={srcLabel}
            />
          </div>
        );
      }
      if (diffView.afterOnly) {
        return (
          <div className="rp-diff-host">
            {toolbar}
            <CodePreview
              code={diffView.afterOnly}
              fileName={diffView.name}
              footer={tr("changes.afterOnly")}
            />
          </div>
        );
      }
      return (
        <div className="rp-changes-empty">
          <div className="rp-changes-empty__title">{tr("changes.noDiff")}</div>
          <div className="rp-changes-empty__hint">{tr("changes.noDiffHint")}</div>
          <div className="rp-changes-empty__actions">
            <button
              type="button"
              className="rp-tool-btn"
              onClick={() => openChangeInPane(diffView.path)}
            >
              <IconFiles size={14} />
              <span className="rp-tool-btn__label">
                {tr("changes.openFile")}
              </span>
            </button>
            <button
              type="button"
              className="rp-tool-btn"
              onClick={() => void openChangeInEditor(diffView.path)}
            >
              <IconExternalLink size={14} />
              <span className="rp-tool-btn__label">
                {tr("changes.openInEditor")}
              </span>
            </button>
            <button
              type="button"
              className="rp-tool-btn"
              onClick={() => void revealChangePath(diffView.path)}
            >
              <IconFolder size={14} />
              <span className="rp-tool-btn__label">{tr("changes.reveal")}</span>
            </button>
            <button
              type="button"
              className="rp-tool-btn"
              onClick={() => void copyChangePath(diffView.path)}
            >
              <IconCopy size={14} />
              <span className="rp-tool-btn__label">
                {pathCopyFlash
                  ? tr("changes.pathCopied")
                  : tr("changes.copyPath")}
              </span>
            </button>
          </div>
        </div>
      );
    }

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
      // Soft-fail: classified media.err.* copy instead of raw host dumps.
      const resolved = resolveMediaLoadError(preview.error, "preview");
      return (
        <div className="rp-preview__msg">
          {formatMediaLoadErrorMessage(resolved, tr)}
        </div>
      );
    }
    const mediaSrc = activeTab?.mediaSrc ?? null;
    const dataUrl =
      preview.base64 && preview.mime
        ? `data:${preview.mime};base64,${preview.base64}`
        : null;
    const src = mediaSrc || dataUrl;

    // Text editor shell: full-height pane + in-content toolbar (not chrome).
    // Markdown defaults to preview; other editable kinds open the source editor.
    const canEdit = isResourceTextEditable({
      kind: preview.kind,
      text: activeTab?.baselineText ?? preview.text,
      truncated: preview.truncated,
      error: preview.error,
    });
    if (canEdit && activeTab && activeTab.draftText != null) {
      const draftText = activeTab.draftText;
      const isMarkdown = preview.kind === "markdown";
      const showEditor = activeTab.editMode || !isMarkdown;
      const dirty = isResourceDraftDirty(draftText, activeTab.baselineText);
      return (
        <div className="rp-editor">
          <div
            className="rp-editor__toolbar"
            role="toolbar"
            aria-label={tr("resources.editorToolbar")}
          >
            {isMarkdown ? (
              <Tip
                label={
                  activeTab.editMode
                    ? tr("resources.previewMode")
                    : tr("resources.editMode")
                }
              >
                <button
                  type="button"
                  className={
                    "rp-editor__tool-btn" +
                    (activeTab.editMode ? " is-on" : "")
                  }
                  disabled={!!activeTab.saving}
                  onClick={toggleActiveEditMode}
                  aria-pressed={!!activeTab.editMode}
                  aria-label={
                    activeTab.editMode
                      ? tr("resources.previewMode")
                      : tr("resources.editMode")
                  }
                >
                  <IconEdit size={14} />
                  <span className="rp-editor__tool-btn-label">
                    {activeTab.editMode
                      ? tr("resources.previewMode")
                      : tr("resources.editMode")}
                  </span>
                </button>
              </Tip>
            ) : null}
            <div className="rp-editor__toolbar-spacer" />
            {dirty ? (
              <Tip label={tr("resources.revert")}>
                <button
                  type="button"
                  className="rp-editor__tool-btn"
                  disabled={!!activeTab.saving}
                  onClick={() => revertActiveDraft()}
                >
                  {tr("resources.revert")}
                </button>
              </Tip>
            ) : null}
            <Tip label={tr("resources.save")}>
              <button
                type="button"
                className={
                  "rp-editor__tool-btn rp-editor__tool-btn--save" +
                  (dirty ? " is-dirty" : "")
                }
                disabled={!!activeTab.saving || !dirty}
                onClick={() => void saveActiveFile()}
              >
                {activeTab.saving
                  ? tr("resources.saving")
                  : tr("resources.save")}
              </button>
            </Tip>
            {dirty ? (
              <span className="rp-editor__dirty-label" role="status">
                {tr("resources.unsaved")}
              </span>
            ) : null}
          </div>
          {preview.truncated ? (
            <div className="rp-editor__banner" role="status">
              {tr("resources.truncated")}
            </div>
          ) : null}
          {showEditor ? (
            isMarkdown ? (
              <MarkdownTiptapEditor
                key={activeTab.id}
                value={draftText}
                onChange={updateActiveDraft}
                onSave={() => void saveActiveFile()}
                disabled={!!activeTab.saving}
                labels={{
                  bold: tr("resources.mdFmt.bold"),
                  italic: tr("resources.mdFmt.italic"),
                  strike: tr("resources.mdFmt.strike"),
                  code: tr("resources.mdFmt.code"),
                  h1: tr("resources.mdFmt.h1"),
                  h2: tr("resources.mdFmt.h2"),
                  h3: tr("resources.mdFmt.h3"),
                  bulletList: tr("resources.mdFmt.bulletList"),
                  orderedList: tr("resources.mdFmt.orderedList"),
                  blockquote: tr("resources.mdFmt.blockquote"),
                  link: tr("resources.mdFmt.link"),
                  hr: tr("resources.mdFmt.hr"),
                  linkPlaceholder: tr("resources.mdFmt.linkPlaceholder"),
                  linkApply: tr("resources.mdFmt.linkApply"),
                  placeholder: tr("resources.mdFmt.placeholder"),
                  editorAria: tr("resources.editorAria", {
                    name: preview.name,
                  }),
                }}
              />
            ) : (
              <textarea
                className="rp-editor__textarea"
                value={draftText}
                spellCheck={preview.kind === "text"}
                disabled={!!activeTab.saving}
                aria-label={tr("resources.editorAria", { name: preview.name })}
                onChange={(e) => updateActiveDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                    e.preventDefault();
                    void saveActiveFile();
                    return;
                  }
                  if (
                    e.key === "Tab" &&
                    !e.metaKey &&
                    !e.ctrlKey &&
                    !e.altKey
                  ) {
                    e.preventDefault();
                    const el = e.currentTarget;
                    const start = el.selectionStart;
                    const end = el.selectionEnd;
                    const next =
                      draftText.slice(0, start) +
                      "  " +
                      draftText.slice(end);
                    updateActiveDraft(next);
                    requestAnimationFrame(() => {
                      el.selectionStart = el.selectionEnd = start + 2;
                    });
                  }
                }}
              />
            )
          ) : (
            <OverlayScroll className="rp-editor__preview-scroll">
              <div className="rp-editor__preview-body rp-preview__md">
                <MarkdownBody>
                  {draftText || preview.text || ""}
                </MarkdownBody>
              </div>
            </OverlayScroll>
          )}
        </div>
      );
    }

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
        // Render SVG via <img>/media URL so the webview image sandbox blocks scripts.
        return src ? (
          <ImageUi
            layout="pane"
            className="rp-preview__img"
            src={src}
            alt={preview.name}
            path={preview.absolutePath || undefined}
            labels={{
              viewImage: tr("image.view"),
              copyImage: tr("image.copy"),
              reveal: revealInOsLabel(tr),
              copyPath: tr("attach.copyPath"),
              loadFailed: tr("media.err.other"),
              loadFailedByKind: mediaLoadErrorLabelMap(tr),
            }}
          />
        ) : (
          <div className="rp-preview__msg">
            {preview.error
              ? formatMediaLoadErrorMessage(
                  resolveMediaLoadError(preview.error, "preview"),
                  tr,
                )
              : tr("media.err.mediaServerUnavailable")}
          </div>
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
              t: tr,
            }}
          />
        ) : (
          <div className="rp-preview__msg">{tr("resources.binary")}</div>
        );
      case "markdown":
        return (
          <div className="rp-preview__md">
            <MarkdownBody>
              {activeTab?.draftText ?? preview.text ?? ""}
            </MarkdownBody>
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
            {preview.error
              ? formatMediaLoadErrorMessage(
                  resolveMediaLoadError(preview.error, "preview"),
                  tr,
                )
              : tr("resources.binary")}
            <div className="rp-preview__meta">
              {preview.name} · {formatSize(preview.size)}
            </div>
          </div>
        );
    }
  }, [
    activeTab,
    tr,
    locale,
    sideMode,
    diffView,
    diffLayout,
    openChangeInEditor,
    openChangeInPane,
    revealChangePath,
    copyChangePath,
    pathCopyFlash,
    updateActiveDraft,
    saveActiveFile,
    revertActiveDraft,
    toggleActiveEditMode,
    projectPath,
    diffDecisionByPath,
    restorableAfterByPath,
    diffActionBusy,
    diffHunks,
    runAcceptFile,
    requestRejectFile,
    runRestoreFile,
    runAcceptHunk,
    runRejectHunk,
    remainingHunkCount,
    requestBatchAcceptHunks,
    requestBatchRejectHunks,
  ]);

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
                          <span className="rp-tab__name">
                            {isResourceDraftDirty(t.draftText, t.baselineText)
                              ? `• ${t.name}`
                              : t.name}
                          </span>
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
                      ) : isResourceDraftDirty(t.draftText, t.baselineText) ? (
                        <span className="rp-tab__dirty" aria-hidden>
                          •
                        </span>
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
              platform={detectAppPlatform()}
              labels={{
                openLocation: tr("main.openLocation"),
                openHint: tr("main.openLocationHint"),
                openMenu: tr("main.openLocationMenu"),
                finder: revealInOsLabel(tr),
                systemDefault: tr("resources.openDefault"),
                copyPath: tr("attach.copyPath"),
              }}
            />
          ) : null}
          {shouldShowPlanChromeButton({
            planVisible: !!plan?.visible,
            composerMode: planChrome?.composerMode ?? "agent",
            userClosed: !!planChrome?.userClosed,
            userPinnedPlanSide,
          }) ? (
            <Tip label={tr("resources.plan")}>
              <button
                type="button"
                className={
                  "chrome-btn main__pane-toggle rp-chrome__plan-btn" +
                  (sideMode === "plan" ? " is-on" : "")
                }
                onClick={() => showSidePanel("plan")}
                aria-label={tr("resources.plan")}
                data-testid="resources-plan-chrome-btn"
              >
                <IconPlan size={16} />
              </button>
            </Tip>
          ) : null}
          {onOpenPlanHistory ? (
            <Tip label={tr("plan.history")}>
              <button
                type="button"
                className="chrome-btn main__pane-toggle"
                onClick={onOpenPlanHistory}
                aria-label={tr("plan.history")}
              >
                <IconClock size={16} />
              </button>
            </Tip>
          ) : null}
          {canShowChangesTab ? (
            <Tip
              label={
                treeVisible && sideMode === "changes"
                  ? tr("changes.hidePanel")
                  : tr("changes.showPanel")
              }
            >
              <button
                type="button"
                className={
                  "chrome-btn main__pane-toggle rp-chrome__changes-btn" +
                  (treeVisible && sideMode === "changes" ? " is-on" : "")
                }
                onClick={() => showSidePanel("changes")}
                aria-label={tr("changes.title")}
              >
                <IconFileDiff size={16} />
                {totalChangeBadge > 0 ? (
                  <span className="rp-chrome__badge" aria-hidden>
                    {totalChangeBadge > 99 ? "99+" : totalChangeBadge}
                  </span>
                ) : null}
              </button>
            </Tip>
          ) : null}
          <Tip
            label={
              treeVisible && sideMode === "files"
                ? tr("resources.collapseTree")
                : tr("resources.expandTree")
            }
          >
            <button
              type="button"
              className={
                "chrome-btn main__pane-toggle" +
                (treeVisible && sideMode === "files" ? " is-on" : "")
              }
              onClick={() => showSidePanel("files")}
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
      {batchProgress ? (
        <div
          className="rp__status"
          role="status"
          aria-live="polite"
          data-testid="changes-batch-progress"
        >
          {tr("changes.batchProgress", {
            action:
              batchProgress.action === "accept"
                ? tr("changes.accept")
                : tr("changes.reject"),
            current: String(batchProgress.current),
            total: String(batchProgress.total),
          })}
        </div>
      ) : batchStatus && !error ? (
        <div className="rp__status" role="status" data-testid="changes-batch-status">
          {batchStatus}
          <Tip label={tr("common.dismiss")}>
            <button
              type="button"
              className="chrome-btn"
              onClick={() => setBatchStatus(null)}
            >
              <IconClose size={12} />
            </button>
          </Tip>
        </div>
      ) : null}
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
          {sideMode === "plan" && plan?.visible ? (
            <PlanReviewPanel
              plan={plan}
              forceExpandKey={planFocusKey}
              labels={{
                ready: tr("plan.ready"),
                waiting: tr("plan.waiting"),
                progress: tr("planBar.progress"),
                done: tr("planBar.done"),
                empty: tr("plan.empty"),
                approve: tr("plan.approve"),
                changes: tr("plan.changes"),
                dismiss: tr("plan.dismiss"),
                steps: tr("plan.steps"),
                fraction: tr("planBar.fraction"),
                expandDetails: tr("plan.expandDetails"),
                collapseDetails: tr("plan.collapseDetails"),
                current: tr("planBar.current"),
              }}
              onApprove={onApprovePlan}
              onRequestChanges={onRequestPlanChanges}
              onDismiss={onDismissPlan}
            />
          ) : sideMode === "plan" ? (
            <div
              className={
                "rp__empty-state plan-resource-empty plan-resource-empty--" +
                (planResourceEmpty?.kind ?? "idle")
              }
              data-testid="plan-resource-empty"
              data-empty-kind={planResourceEmpty?.kind ?? "idle"}
              role="status"
            >
              <div className="rp__empty-title plan-resource-empty__title">
                {tr(planResourceEmpty?.titleKey ?? "resources.plan")}
              </div>
              <div className="rp__empty-desc plan-resource-empty__hint">
                {tr(planResourceEmpty?.hintKey ?? "resources.planEmpty")}
              </div>
              {(planResourceEmpty?.showHistoryCta ?? false) &&
              onOpenPlanHistory ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm plan-resource-empty__cta"
                  onClick={onOpenPlanHistory}
                  data-testid="plan-resource-empty-history"
                >
                  {tr("plan.history")}
                </button>
              ) : null}
            </div>
          ) : sideMode === "changes" && diffView ? (
            diffView.loading ? (
              <div className="rp__empty-state">
                <div className="rp__empty-desc">{tr("changes.loadingDiff")}</div>
              </div>
            ) : diffView.unified || diffView.afterOnly ? (
              <div className="rp-preview-code-host">{previewBody}</div>
            ) : (
              <div className="rp__empty-state">{previewBody}</div>
            )
          ) : !activeTab ? (
            <div className="rp__empty-state">
              <div className="rp__empty-title">
                {sideMode === "changes" &&
                changeCount === 0 &&
                workspaceCount === 0
                  ? tr("changes.empty")
                  : sideMode === "changes"
                    ? tr("changes.pickTitle")
                    : tr("resources.emptyPreview")}
              </div>
              <div className="rp__empty-desc">
                {sideMode === "changes" &&
                changeCount === 0 &&
                workspaceCount === 0
                  ? tr("changes.emptyHint")
                  : sideMode === "changes"
                    ? tr("changes.pickHint")
                    : tr("resources.emptyPreviewHint")}
              </div>
              {sideMode === "changes" &&
              (changeCount > 0 || workspaceCount > 0) ? (
                <div className="rp__empty-desc rp__empty-desc--muted">
                  {tr("changes.navHint")}
                </div>
              ) : null}
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
          ) : activeTabEditable && activeTab.preview ? (
            /* Full-height editor shell (toolbar + textarea / md preview) */
            <div className="rp-preview-code-host rp-preview-editor-host">
              {previewBody}
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
              <div className="rp-side-modes" role="tablist" aria-label={tr("resources.title")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sideMode === "files"}
                  className={
                    "rp-side-modes__btn" + (sideMode === "files" ? " is-active" : "")
                  }
                  onClick={() => setSideMode("files")}
                >
                  {tr("changes.files")}
                </button>
                {canShowChangesTab ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sideMode === "changes"}
                    className={
                      "rp-side-modes__btn" +
                      (sideMode === "changes" ? " is-active" : "")
                    }
                    onClick={() => setSideMode("changes")}
                  >
                    {tr("changes.title")}
                    {totalChangeBadge > 0 ? (
                      <span className="rp-side-modes__count">
                        {totalChangeBadge}
                      </span>
                    ) : null}
                  </button>
                ) : null}
                {plan?.visible ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sideMode === "plan"}
                    className={
                      "rp-side-modes__btn" +
                      (sideMode === "plan" ? " is-active" : "")
                    }
                    onClick={() => showSidePanel("plan")}
                  >
                    {tr("resources.plan")}
                  </button>
                ) : null}
              </div>
              <div className="rp-tree-search">
                <IconSearch size={14} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tr("resources.filterPh")}
                  aria-label={tr("resources.filterPh")}
                />
                {sideMode === "files" ? (
                  <Tip label={tr("resources.refresh")}>
                    <button
                      type="button"
                      className="chrome-btn"
                      onClick={() => void refresh()}
                    >
                      <IconRefresh size={14} />
                    </button>
                  </Tip>
                ) : (
                  <Tip label={tr("changes.workspace.refresh")}>
                    <button
                      type="button"
                      className="chrome-btn"
                      onClick={() => void refreshWorkspaceStatus()}
                      disabled={workspaceLoading}
                    >
                      <IconRefresh size={14} />
                    </button>
                  </Tip>
                )}
              </div>
              <OverlayScroll className="rp-tree-scroll">
                {sideMode === "changes" ? (
                  <div
                    className="rp-changes-list"
                    role="list"
                    ref={changesListRef}
                    tabIndex={0}
                    aria-label={tr("changes.title")}
                    data-testid="changes-list"
                  >
                    {/* ── Session (agent tool edits) ── */}
                    <div className="rp-changes-section">
                      <div className="rp-changes-section__head">
                        <span className="rp-changes-section__title">
                          {tr("changes.section.session")}
                        </span>
                        {changeCount > 0 ? (
                          <span className="rp-changes-section__count">
                            {changeCount}
                          </span>
                        ) : null}
                        {changeCount > 0 ? (
                          <div
                            className="rp-changes-section__batch"
                            role="group"
                            aria-label={tr("changes.batchGroup")}
                          >
                            <Tip label={tr("changes.acceptAllRemainingTip")}>
                              <button
                                type="button"
                                className="chrome-btn rp-diff-action rp-diff-action--accept rp-changes-batch-btn"
                                disabled={
                                  !projectPath ||
                                  !api.isTauri() ||
                                  diffActionBusy
                                }
                                data-testid="changes-accept-all"
                                onClick={() => requestBatchAcceptSession()}
                                aria-label={tr("changes.acceptAllRemaining")}
                              >
                                <IconCheck size={12} />
                                <span>{tr("changes.acceptAllRemainingShort")}</span>
                              </button>
                            </Tip>
                            <Tip label={tr("changes.rejectAllRemainingTip")}>
                              <button
                                type="button"
                                className="chrome-btn rp-diff-action rp-diff-action--reject rp-changes-batch-btn"
                                disabled={
                                  !projectPath ||
                                  !api.isTauri() ||
                                  diffActionBusy
                                }
                                data-testid="changes-reject-all"
                                onClick={() => requestBatchRejectSession()}
                                aria-label={tr("changes.rejectAllRemaining")}
                              >
                                <IconClose size={12} />
                                <span>{tr("changes.rejectAllRemainingShort")}</span>
                              </button>
                            </Tip>
                          </div>
                        ) : null}
                      </div>

                      {filteredChanges.length === 0 ? (
                        <div className="rp-changes-section__empty">
                          {query.trim()
                            ? tr("changes.filterEmpty")
                            : tr("changes.empty")}
                        </div>
                      ) : (
                        filteredChanges.map((c) => {
                          const active =
                            selectedChangeSource === "session" &&
                            selectedChangePath != null &&
                            normalizePath(c.path) ===
                              normalizePath(selectedChangePath);
                          const rel =
                            pathRelativeToProject(c.path, projectPath) ||
                            c.path;
                          const delta = sessionFileLineDelta(c);
                          return (
                            <div
                              key={changeListKey("session", c.path)}
                              className={
                                "rp-changes-row" +
                                (active ? " is-active" : "")
                              }
                              role="listitem"
                              aria-selected={active}
                            >
                              <button
                                type="button"
                                className="rp-changes-row__main"
                                title={c.path}
                                onClick={() => void loadChangeDiff(c)}
                              >
                                <FileKindMark name={c.name} isDir={false} />
                                <span className="rp-changes-row__meta">
                                  <span className="rp-changes-row__name-row">
                                    <span className="rp-changes-row__name">
                                      {c.name}
                                    </span>
                                    {delta ? (
                                      <span
                                        className="rp-changes-row__delta"
                                        aria-label={tr("changes.lineDelta", {
                                          a: String(delta.added),
                                          d: String(delta.removed),
                                        })}
                                      >
                                        <span className="rp-changes-row__add">
                                          +{delta.added}
                                        </span>
                                        <span className="rp-changes-row__del">
                                          −{delta.removed}
                                        </span>
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="rp-changes-row__path">
                                    {rel}
                                  </span>
                                  <span className="rp-changes-row__kind">
                                    {c.toolKind}
                                    {c.status
                                      ? ` · ${changeStatusLabel(c.status)}`
                                      : ""}
                                  </span>
                                </span>
                              </button>
                              <div className="rp-changes-row__actions">
                                <Tip label={tr("changes.acceptTip")}>
                                  <button
                                    type="button"
                                    className="chrome-btn rp-diff-action rp-diff-action--accept"
                                    disabled={
                                      !projectPath ||
                                      !api.isTauri() ||
                                      diffActionBusy
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void runAcceptFile(
                                        c.path,
                                        typeof c.after === "string"
                                          ? c.after
                                          : null,
                                      );
                                    }}
                                    aria-label={tr("changes.accept")}
                                  >
                                    <IconCheck size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.rejectTip")}>
                                  <button
                                    type="button"
                                    className="chrome-btn rp-diff-action rp-diff-action--reject"
                                    disabled={
                                      !projectPath ||
                                      !api.isTauri() ||
                                      diffActionBusy
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      // Prefer session after snapshot for restore later
                                      if (typeof c.after === "string") {
                                        rememberRestorable(c.path, c.after);
                                      }
                                      requestRejectFile(c.path);
                                    }}
                                    aria-label={tr("changes.reject")}
                                  >
                                    <IconClose size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.openFile")}>
                                  <button
                                    type="button"
                                    className="chrome-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openChangeInPane(c.path);
                                    }}
                                  >
                                    <IconFiles size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.openInEditor")}>
                                  <button
                                    type="button"
                                    className="chrome-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void openChangeInEditor(c.path);
                                    }}
                                  >
                                    <IconExternalLink size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.reveal")}>
                                  <button
                                    type="button"
                                    className="chrome-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void revealChangePath(c.path);
                                    }}
                                  >
                                    <IconFolder size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.copyPath")}>
                                  <button
                                    type="button"
                                    className="chrome-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void copyChangePath(c.path);
                                    }}
                                  >
                                    <IconCopy size={13} />
                                  </button>
                                </Tip>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* ── Workspace (git status) ── */}
                    <div className="rp-changes-section">
                      <div className="rp-changes-section__head">
                        <span className="rp-changes-section__title">
                          {tr("changes.section.workspace")}
                        </span>
                        {workspaceCount > 0 ? (
                          <span className="rp-changes-section__count">
                            {workspaceCount}
                          </span>
                        ) : null}
                        {workspaceBranch ? (
                          <span
                            className="rp-changes-section__branch"
                            title={tr("changes.workspace.branch", {
                              branch: workspaceBranch,
                            })}
                          >
                            {workspaceBranch}
                          </span>
                        ) : null}
                        {onShip && workspaceAvailable && workspaceBranch ? (
                          <Tip label={tr("composer.worktreeShipTip")}>
                            <button
                              type="button"
                              className="chrome-btn rp-changes-section__ship"
                              onClick={() => onShip()}
                              aria-label={tr("composer.worktreeShip")}
                              data-testid="changes-workspace-ship"
                            >
                              <IconUpload size={13} />
                              <span>{tr("composer.worktreeShip")}</span>
                            </button>
                          </Tip>
                        ) : null}
                      </div>
                      {workspaceLoading && workspaceFiles.length === 0 ? (
                        <div className="rp-changes-section__empty">
                          {tr("changes.workspace.loading")}
                        </div>
                      ) : !workspaceAvailable ? (
                        <div className="rp-changes-section__empty">
                          {workspaceUnavailableLabel()}
                        </div>
                      ) : filteredWorkspace.length === 0 ? (
                        <div className="rp-changes-section__empty">
                          {query.trim()
                            ? tr("changes.filterEmpty")
                            : tr("changes.workspace.empty")}
                        </div>
                      ) : (
                        filteredWorkspace.map((w) => {
                          const abs =
                            normalizePath(w.absolutePath) ||
                            resolveWorkspaceAbsolutePath(
                              projectPath,
                              w.path,
                            );
                          const active =
                            selectedChangeSource === "workspace" &&
                            selectedChangePath != null &&
                            (normalizePath(selectedChangePath) === abs ||
                              normalizePath(selectedChangePath) ===
                                normalizePath(w.path));
                          return (
                            <div
                              key={changeListKey(
                                "workspace",
                                abs || w.path,
                              )}
                              className={
                                "rp-changes-row" +
                                (active ? " is-active" : "")
                              }
                              role="listitem"
                              aria-selected={active}
                            >
                              <button
                                type="button"
                                className="rp-changes-row__main"
                                title={abs || w.path}
                                onClick={() => void loadWorkspaceDiff(w)}
                              >
                                <span
                                  className={
                                    "rp-changes-badge rp-changes-badge--" +
                                    w.kind
                                  }
                                  aria-hidden
                                >
                                  {workspaceGitKindBadge(w.kind)}
                                </span>
                                <span className="rp-changes-row__meta">
                                  <span className="rp-changes-row__name">
                                    {w.name}
                                  </span>
                                  <span className="rp-changes-row__path">
                                    {w.path}
                                  </span>
                                  <span className="rp-changes-row__kind">
                                    {workspaceKindLabel(w.kind)}
                                    {w.status.trim()
                                      ? ` · ${w.status}`
                                      : ""}
                                  </span>
                                </span>
                              </button>
                              <div className="rp-changes-row__actions">
                                <Tip label={tr("changes.acceptTip")}>
                                  <button
                                    type="button"
                                    className="chrome-btn rp-diff-action rp-diff-action--accept"
                                    disabled={
                                      !projectPath ||
                                      !api.isTauri() ||
                                      diffActionBusy
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void runAcceptFile(abs || w.path);
                                    }}
                                    aria-label={tr("changes.accept")}
                                  >
                                    <IconCheck size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.rejectTip")}>
                                  <button
                                    type="button"
                                    className="chrome-btn rp-diff-action rp-diff-action--reject"
                                    disabled={
                                      !projectPath ||
                                      !api.isTauri() ||
                                      diffActionBusy
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      requestRejectFile(abs || w.path);
                                    }}
                                    aria-label={tr("changes.reject")}
                                  >
                                    <IconClose size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.openFile")}>
                                  <button
                                    type="button"
                                    className="chrome-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openChangeInPane(abs || w.path);
                                    }}
                                  >
                                    <IconFiles size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.openInEditor")}>
                                  <button
                                    type="button"
                                    className="chrome-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void openChangeInEditor(abs || w.path);
                                    }}
                                  >
                                    <IconExternalLink size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.reveal")}>
                                  <button
                                    type="button"
                                    className="chrome-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void revealChangePath(abs || w.path);
                                    }}
                                  >
                                    <IconFolder size={13} />
                                  </button>
                                </Tip>
                                <Tip label={tr("changes.copyPath")}>
                                  <button
                                    type="button"
                                    className="chrome-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void copyChangePath(abs || w.path);
                                    }}
                                  >
                                    <IconCopy size={13} />
                                  </button>
                                </Tip>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : loadingTree ? (
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

      <GlassModal
        open={!!conflictTabId}
        onClose={() => setConflictTabId(null)}
        title={tr("resources.conflictTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setConflictTabId(null);
                void reloadActiveFile();
              }}
            >
              {tr("resources.conflictReload")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => {
                setConflictTabId(null);
                void saveActiveFile({ force: true });
              }}
            >
              {tr("resources.conflictOverwrite")}
            </button>
          </>
        }
      >
        <p className="rp-modal-copy">{tr("resources.conflictBody")}</p>
      </GlassModal>

      <GlassModal
        open={!!discardTabId}
        onClose={() => setDiscardTabId(null)}
        title={tr("resources.discardTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setDiscardTabId(null)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => {
                const id = discardTabId;
                setDiscardTabId(null);
                if (id) closeTabForced(id);
              }}
            >
              {tr("resources.discardConfirm")}
            </button>
          </>
        }
      >
        <p className="rp-modal-copy">{tr("resources.discardBody")}</p>
      </GlassModal>

      <GlassModal
        open={!!rejectConfirm}
        onClose={() => setRejectConfirm(null)}
        title={
          rejectConfirm?.untracked
            ? tr("changes.rejectConfirmUntrackedTitle")
            : tr("changes.rejectConfirmTitle")
        }
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setRejectConfirm(null)}
              disabled={diffActionBusy}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid btn--danger"
              data-testid="changes-reject-confirm"
              disabled={diffActionBusy}
              onClick={() => {
                const p = rejectConfirm?.path;
                if (p) void executeRejectFile(p, true);
              }}
            >
              {diffActionBusy
                ? tr("changes.actionBusy")
                : tr("changes.rejectConfirmAction")}
            </button>
          </>
        }
      >
        <p className="rp-modal-copy">
          {rejectConfirm?.untracked
            ? tr("changes.rejectConfirmUntrackedBody", {
                name: rejectConfirm.name,
              })
            : tr("changes.rejectConfirmBody")}
        </p>
      </GlassModal>

      <GlassModal
        open={!!batchRejectConfirm}
        onClose={() => setBatchRejectConfirm(null)}
        title={
          batchRejectConfirm?.untracked
            ? tr("changes.batchRejectConfirmUntrackedTitle")
            : tr("changes.batchRejectConfirmTitle")
        }
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setBatchRejectConfirm(null)}
              disabled={diffActionBusy}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid btn--danger"
              data-testid="changes-batch-reject-confirm"
              disabled={diffActionBusy}
              onClick={() => {
                const p = batchRejectConfirm?.plan;
                if (p) void executeBatchReject(p, true);
              }}
            >
              {diffActionBusy
                ? tr("changes.actionBusy")
                : tr("changes.rejectAllRemaining")}
            </button>
          </>
        }
      >
        <p className="rp-modal-copy">
          {batchRejectConfirm?.untracked
            ? tr("changes.batchRejectConfirmUntrackedBody", {
                n: String(batchRejectConfirm.plan.runCount),
                u: String(batchRejectConfirm.plan.untrackedConfirmCount),
              })
            : tr("changes.batchRejectConfirmBody", {
                n: String(batchRejectConfirm?.plan.runCount ?? 0),
              })}
        </p>
      </GlassModal>

      <GlassModal
        open={batchHunkRejectConfirm}
        onClose={() => setBatchHunkRejectConfirm(false)}
        title={tr("changes.batchHunksRejectConfirmTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setBatchHunkRejectConfirm(false)}
              disabled={diffActionBusy}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid btn--danger"
              data-testid="changes-batch-hunks-reject-confirm"
              disabled={diffActionBusy}
              onClick={() => void runBatchRemainingHunks("reject")}
            >
              {diffActionBusy
                ? tr("changes.actionBusy")
                : tr("changes.rejectAllHunks")}
            </button>
          </>
        }
      >
        <p className="rp-modal-copy">
          {tr("changes.batchHunksRejectConfirmBody", {
            n: String(remainingHunkCount),
            name: diffView?.name ?? "",
          })}
        </p>
      </GlassModal>
    </div>
  );
}
