/** Typed Tauri invoke helpers with browser fallback. */

import type { SessionSnapshot } from "./session";
import { IDLE_SNAPSHOT } from "./session";
import {
  isMirrorClient,
  mirrorEnsureTransport,
  mirrorInvoke,
  mirrorListen,
} from "./mirrorTransport";
import type {
  WallpaperFetchResult,
  WallpaperLibraryEntry,
  WallpaperSearchResult,
} from "./wallpaperSource";

export type {
  WallpaperFetchResult,
  WallpaperGalleryItem,
  WallpaperLibraryEntry,
  WallpaperSearchResult,
} from "./wallpaperSource";

export { isMirrorClient } from "./mirrorTransport";

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** Desktop WebView path (not phone mirror). Prefer over bare `isTauri()` when AC6 matters. */
export function isDesktopHost(): boolean {
  return isTauri() && !isMirrorClient();
}

/**
 * True when a host backend is reachable — desktop Tauri IPC **or** mirror WS.
 *
 * Use this to gate work that only needs "a backend exists", e.g. creating a
 * session before the first send. Only valid for commands present in
 * `CMD_TO_METHOD` (mirrorTransport.ts); anything desktop-only must keep using
 * `isTauri()` / `isDesktopHost()` so mirror clients cannot reach it (AC6).
 */
export function hasHost(): boolean {
  return isTauri() || isMirrorClient();
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isMirrorClient()) {
    return mirrorInvoke<T>(cmd, args);
  }
  if (!isTauri()) throw new Error(`Tauri required: ${cmd}`);
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

export async function sessionGetState(): Promise<SessionSnapshot> {
  if (isMirrorClient()) return invoke("session_get_state");
  if (!isTauri()) return { ...IDLE_SNAPSHOT, backend: "browser" };
  return invoke("session_get_state");
}

export async function sessionConnect(opts?: {
  projectPath?: string;
  sessionId?: string;
  mode?: string;
}): Promise<SessionSnapshot> {
  if (isMirrorClient()) {
    return invoke("session_connect", {
      projectPath: opts?.projectPath ?? null,
      sessionId: opts?.sessionId ?? null,
      mode: opts?.mode ?? null,
    });
  }
  if (!isTauri()) {
    return {
      ...IDLE_SNAPSHOT,
      sessionId: "browser",
      state: "ready",
      backend: "browser",
      title: "Browser preview",
    };
  }
  return invoke("session_connect", {
    projectPath: opts?.projectPath ?? null,
    sessionId: opts?.sessionId ?? null,
    mode: opts?.mode ?? null,
  });
}

/**
 * Send a turn to the agent.
 * @param text Agent prompt (skills as `/name`, attachments as `@path`, etc.)
 * @param displayText Optional user-bubble text for journal (e.g. `[[skill:name]]` chips).
 *                    When omitted, journal stores `text`.
 * @param sessionId Chat this turn belongs to. Always pass it in multi-session
 *   flows: Host re-focuses that chat (background/parked → live) before
 *   prompting, so a concurrent connect cannot deliver the turn to another chat.
 *   Fails with `CONNECT_FAILED` when the chat has no warm agent process.
 */
export async function sessionSend(
  text: string,
  displayText?: string | null,
  sessionId?: string | null,
): Promise<SessionSnapshot> {
  return invoke("session_send", {
    text,
    displayText: displayText ?? null,
    sessionId: sessionId ?? null,
  });
}

/**
 * Inject guidance into the active turn without cancelling the running prompt.
 * Grok Build `_x.ai/interject`. Pass `sessionId` so multi-session routing stays correct.
 */
export async function sessionInterject(
  text: string,
  displayText?: string | null,
  attachments?: { path: string; name: string; isDir?: boolean }[] | null,
  sessionId?: string | null,
): Promise<SessionSnapshot> {
  return invoke("session_interject", {
    text,
    displayText: displayText ?? null,
    attachments: attachments?.length ? attachments : null,
    sessionId: sessionId ?? null,
  });
}

/**
 * Drop last user turn (agent rewind + local journal) before edit-resend.
 * Pass `sessionId` so a concurrent connect cannot truncate another chat.
 */
export async function sessionRewindDropLastUser(
  sessionId?: string | null,
): Promise<SessionSnapshot> {
  return invoke("session_rewind_drop_last_user", {
    sessionId: sessionId ?? null,
  });
}

/** One user-prompt checkpoint on the rewind timeline. */
export interface RewindPoint {
  promptIndex: number;
  messageId?: string | null;
  preview: string;
}

/** Result of rewinding to a prompt index (local journal always applies). */
export interface RewindExecuteResult {
  snapshot: SessionSnapshot;
  /** False when agent rewind failed / unsupported / disconnected. */
  agentOk: boolean;
  agentError?: string | null;
  localOk: boolean;
  keptCount: number;
}

/** List rewind points for a session journal (live session when `sessionId` omitted). */
export async function sessionRewindPoints(
  sessionId?: string | null,
): Promise<RewindPoint[]> {
  return invoke("session_rewind_points", {
    sessionId: sessionId ?? null,
  });
}

/**
 * Rewind to a 0-based user-prompt index (keep that turn, drop after).
 * Local journal is always truncated; agent extension is best-effort when live.
 */
export async function sessionRewindExecute(
  targetPromptIndex: number,
  opts?: { restoreFiles?: boolean; sessionId?: string | null },
): Promise<RewindExecuteResult> {
  return invoke("session_rewind_execute", {
    targetPromptIndex,
    restoreFiles: opts?.restoreFiles ?? false,
    sessionId: opts?.sessionId ?? null,
  });
}

/** Fork a session into a new chat (same project; optional cut through user turn). */
export async function sessionFork(
  sourceId: string,
  opts?: {
    throughUserPromptIndex?: number | null;
    title?: string | null;
    /** CLI `--fork-session`: new agent id with parent context on next connect. */
    forkAgentSession?: boolean | null;
  },
) {
  return invoke<{
    id: string;
    projectId: string | null;
    title: string;
    updatedAt: string;
    modelId: string | null;
    archived?: boolean;
    scheduled?: boolean;
    agentSessionId?: string | null;
    forkAgentSession?: boolean;
  }>("session_fork", {
    sourceId,
    throughUserPromptIndex: opts?.throughUserPromptIndex ?? null,
    title: opts?.title ?? null,
    forkAgentSession: opts?.forkAgentSession ?? false,
  });
}

/**
 * Arm or clear the one-shot CLI `--fork-session` flag on a session.
 * Soft-respawns the live agent when arming so the next connect can fork.
 */
export async function sessionSetForkAgentSession(
  id: string,
  forkAgentSession: boolean,
) {
  return invoke<{
    id: string;
    agentSessionId?: string | null;
    forkAgentSession?: boolean;
  }>("session_set_fork_agent_session", {
    id,
    forkAgentSession,
  });
}

/** Stop a turn. Pass `sessionId` to stop a demoted (background) chat. */
export async function sessionStop(
  sessionId?: string | null,
): Promise<SessionSnapshot> {
  return invoke("session_stop", { sessionId: sessionId ?? null });
}

export async function sessionDisconnect(): Promise<SessionSnapshot> {
  return invoke("session_disconnect");
}

export async function sessionReattach(): Promise<SessionSnapshot> {
  return invoke("session_reattach");
}

/**
 * Answer a tool permission prompt.
 * @param sessionId Chat that raised it (`session://permission.sessionId`).
 *   Required for background turns — their rpc id belongs to their own ACP
 *   child, so answering against the live slot leaves them waiting forever.
 */
export async function sessionResolvePermission(args: {
  rpcId: number;
  decision: string;
  optionId?: string;
  scopeKey?: string;
  sessionId?: string | null;
}): Promise<SessionSnapshot> {
  return invoke("session_resolve_permission", {
    rpcId: args.rpcId,
    decision: args.decision,
    optionId: args.optionId ?? null,
    scopeKey: args.scopeKey ?? null,
    sessionId: args.sessionId ?? null,
  });
}

/** Approve / revise / abandon pending `_x.ai/exit_plan_mode`. */
export async function sessionResolvePlan(args: {
  decision: "approved" | "cancelled" | "abandoned" | string;
  feedback?: string | null;
  rpcId?: number | null;
  sessionId?: string | null;
}): Promise<SessionSnapshot> {
  return invoke("session_resolve_plan", {
    decision: args.decision,
    feedback: args.feedback ?? null,
    rpcId: args.rpcId ?? null,
    sessionId: args.sessionId ?? null,
  });
}

/** Answer or dismiss pending `_x.ai/ask_user_question`. */
export async function sessionResolveAskUser(args: {
  decision: "accepted" | "cancelled" | string;
  answers?: Record<string, string> | null;
  rpcId?: number | null;
  sessionId?: string | null;
}): Promise<SessionSnapshot> {
  return invoke("session_resolve_ask_user", {
    decision: args.decision,
    answers: args.answers ?? null,
    rpcId: args.rpcId ?? null,
    sessionId: args.sessionId ?? null,
  });
}

export interface NetworkProbeTarget {
  key: string;
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
  millis: number;
}

export interface NetworkProbeResult {
  allOk: boolean;
  targets: NetworkProbeTarget[];
}

/** Probe Grok endpoints through the effective proxy. */
export async function networkProbe() {
  return invoke<NetworkProbeResult>("network_probe");
}

/**
 * Headless probe for ACP-shaped NDJSON (`--output-format streaming-json`,
 * CLI ≥ 0.2.117). Soft-gated on the Host — older CLIs return supported=false.
 * Distinct from `streaming-messages-json`.
 */
export type StreamingAcpNdjsonProbeResult = {
  ok: boolean;
  supported: boolean | null;
  version: string | null;
  minVersion: string;
  binary: string | null;
  args: string[];
  usedStreamingJson: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
  durationMs: number;
};

export async function probeStreamingAcpNdjson(opts?: {
  prompt?: string;
  manualPath?: string;
  cwd?: string;
}): Promise<StreamingAcpNdjsonProbeResult> {
  return invoke<StreamingAcpNdjsonProbeResult>("probe_streaming_acp_ndjson", {
    prompt: opts?.prompt ?? null,
    manualPath: opts?.manualPath ?? null,
    cwd: opts?.cwd ?? null,
  });
}

export async function probeCli(manualPath?: string) {
  return invoke<{
    found: boolean;
    path: string | null;
    version: string | null;
    source: string;
    cliAuthPresent?: boolean;
    candidatesTried?: string[];
    /** false ⇒ CLI older than minVersion; null/undefined ⇒ version unknown. */
    versionSupported?: boolean | null;
    /** Minimum grok CLI version this app requires (from the host). */
    minVersion?: string;
  }>("probe_cli", { manualPath: manualPath ?? null });
}

export interface AcpProbeResult {
  ok: boolean;
  agentVersion?: string | null;
  model?: string | null;
  error?: string | null;
}

/** API mode: TCP-connect to an ACP server and run the initialize handshake. */
export async function acpTestConnection(addr: string) {
  return invoke<AcpProbeResult>("acp_test_connection", { addr });
}

/** TCP-only ACP server health probe (~2s). No secrets / no RPC handshake. */
export interface AcpServerProbeResult {
  ok: boolean;
  latencyMs?: number | null;
  error?: string | null;
}

export async function acpServerProbe(addr: string) {
  return invoke<AcpServerProbeResult>("acp_server_probe", { addr });
}

export interface CliInstallProgress {
  phase: string;
  message: string;
  percent?: number | null;
  bytesDownloaded?: number | null;
  totalBytes?: number | null;
  mirror?: string | null;
  version?: string | null;
}

export interface CliInstallResult {
  ok: boolean;
  path: string | null;
  version: string | null;
  mirrorUsed: string | null;
  message: string;
}

export interface CliInstallCommands {
  primary: string;
  shell: string;
  docsUrl: string;
  mirrors: string[];
}

/**
 * Download + install latest Grok Build (multi-mirror).
 * Progress via setup://cli-install-progress.
 * When `allowUnverified` is omitted, Host uses Settings `allowUnverifiedCliInstall`.
 * Missing published checksums are allowed by default; pass `allowUnverified: true`
 * to override strict `GROK_CLI_REQUIRE_CHECKSUM` mode.
 */
export async function cliInstallLatest(opts?: {
  allowUnverified?: boolean | null;
}) {
  return invoke<CliInstallResult>("cli_install_latest", {
    allowUnverified: opts?.allowUnverified ?? null,
  });
}

export async function cliInstallCommands() {
  return invoke<CliInstallCommands>("cli_install_commands");
}

export async function pickCliBinary() {
  return invoke<string | null>("pick_cli_binary");
}

/** Native file picker for Settings → Agent profile path. */
export async function pickAgentProfile() {
  return invoke<string | null>("pick_agent_profile");
}

export async function openExternalUrl(url: string) {
  return invoke<void>("open_external_url", { url });
}

/** GitHub Releases check (Settings → About). Does not auto-install. */
export type AppUpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string | null;
  htmlUrl: string;
  publishedAt: string | null;
  body: string | null;
  assetNames: string[];
  /** Best-effort platform installer URL from the release assets. */
  downloadUrl: string | null;
  downloadName: string | null;
};

export async function appCheckUpdate() {
  return invoke<AppUpdateCheck>("app_check_update");
}

/** True when this install can apply Tauri in-app updates (Linux: AppImage only). */
export async function isAutoUpdateSupported() {
  return invoke<boolean>("is_auto_update_supported");
}

/** True when the binary was built with updater pubkey + endpoint (release CI). */
export async function isUpdaterPluginEnabled() {
  return invoke<boolean>("is_updater_plugin_enabled");
}

export type UpdaterStatus = {
  platformSupported: boolean;
  pluginEnabled: boolean;
  /** `silent` | `github_manual` */
  channel: string;
  endpoint: string;
};

/** About / Doctor: which update path this binary uses. */
export async function updaterStatus() {
  return invoke<UpdaterStatus>("updater_status");
}

/** Stop agents / mirror / voice / IM before install + relaunch. */
export async function prepareForAppUpdate() {
  return invoke<void>("prepare_for_app_update");
}

export async function projectsList() {
  return invoke<
    Array<{
      id: string;
      name: string;
      path: string;
      trusted: boolean;
      pathOk: boolean;
      pinned?: boolean;
      /** Legacy flag; retired system:general is no longer listed. */
      system?: boolean;
    }>
  >("projects_list");
}

/** On-disk default cwd for orphan chats (`{app_data}/workspaces/general`). */
export async function generalWorkspacePath() {
  return invoke<string>("general_workspace_path");
}

export async function projectAdd(path: string, trust: boolean) {
  return invoke("project_add", { path, trust });
}

/** One linked git worktree from `git worktree list --porcelain`. */
export interface GitWorktreeEntry {
  path: string;
  head?: string | null;
  branch?: string | null;
  detached: boolean;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface GitWorktreesResult {
  available: boolean;
  worktrees: GitWorktreeEntry[];
  reason?: string | null;
  /** Absolute `~/.grok` for CLI-aligned worktree placement / badge detection. */
  cliGrokHome?: string | null;
}

/** List worktrees for a project folder. Soft-fails when git/repo missing. */
export async function gitWorktreesList(projectPath: string) {
  return invoke<GitWorktreesResult>("git_worktrees_list", { projectPath });
}

// ── GitHub PR hub (`gh pr list|view|checks`) ────────────────────────────────

export type {
  GitPrHubEntry,
  GitPrHubListResult,
  GitPrHubViewResult,
  GitPrCheckEntry,
  GitPrChecksResult,
  GitPrCommentEntry,
  GitPrCommentsResult,
  PrChecksSummary,
  PrChecksOverall,
} from "./gitPrHub";

/** List PRs for a project folder via `gh pr list --json`. Soft-fails when gh/git missing. */
export async function gitPrList(
  projectPath: string,
  opts?: { limit?: number | null; state?: string | null },
) {
  return invoke<import("./gitPrHub").GitPrHubListResult>("git_pr_list", {
    projectPath,
    limit: opts?.limit ?? null,
    state: opts?.state?.trim() || null,
  });
}

/** View one PR via `gh pr view <n> --json`. Soft-fails when gh/git missing. */
export async function gitPrView(projectPath: string, number: number) {
  return invoke<import("./gitPrHub").GitPrHubViewResult>("git_pr_view", {
    projectPath,
    number,
  });
}

/** List CI checks for a PR via `gh pr checks <n> --json`. Soft-fails when gh/git missing. */
export async function gitPrChecks(projectPath: string, number: number) {
  return invoke<import("./gitPrHub").GitPrChecksResult>("git_pr_checks", {
    projectPath,
    number,
  });
}

/**
 * Recent conversation comments + reviews for a PR via
 * `gh pr view <n> --json comments,reviews,url,number`. Soft-fails when gh/git missing.
 */
export async function gitPrComments(projectPath: string, number: number) {
  return invoke<import("./gitPrHub").GitPrCommentsResult>("git_pr_comments", {
    projectPath,
    number,
  });
}

/** One CLI-tracked worktree from `grok worktree list` (JSON or text). */
export interface CliWorktreeEntry {
  id: string;
  name: string;
  path: string;
  branch?: string | null;
  status?: string | null;
  kind?: string | null;
  repoName?: string | null;
  sourceRepo?: string | null;
  /** True when path exists as a directory (safe to open as cwd). */
  pathOk?: boolean;
  head?: string | null;
}

export interface CliWorktreesResult {
  available: boolean;
  worktrees: CliWorktreeEntry[];
  reason?: string | null;
  cliFound: boolean;
  /** `json` | `text` | `none` */
  source?: string | null;
}

/**
 * List Grok Build CLI-tracked worktrees (`grok worktree list --json`).
 * Soft-fails when CLI is missing or the command is unsupported.
 */
export async function cliWorktreesList(opts?: {
  all?: boolean | null;
  repo?: string | null;
}) {
  return invoke<CliWorktreesResult>("cli_worktrees_list", {
    all: opts?.all ?? null,
    repo: opts?.repo?.trim() || null,
  });
}

/** Parsed fields from `grok worktree db stats` (text or JSON). */
export interface CliWorktreeDbStats {
  total?: number | null;
  alive?: number | null;
  dead?: number | null;
  dbSize?: string | null;
  dbSizeBytes?: number | null;
}

export interface CliWorktreeDbPathResult {
  available: boolean;
  path?: string | null;
  pathOk?: boolean;
  reason?: string | null;
  cliFound: boolean;
  unsupported?: boolean;
}

export interface CliWorktreeDbStatsResult {
  available: boolean;
  stats?: CliWorktreeDbStats | null;
  summary?: string | null;
  raw?: string | null;
  reason?: string | null;
  cliFound: boolean;
  unsupported?: boolean;
  /** `json` | `text` | `none` */
  source?: string | null;
}

export interface CliWorktreeDbRebuildResult {
  ok: boolean;
  available: boolean;
  message?: string | null;
  discovered?: number | null;
  registered?: number | null;
  alreadyTracked?: number | null;
  reason?: string | null;
  cliFound: boolean;
  unsupported?: boolean;
}

/**
 * CLI worktree DB path (`grok worktree db path`, Grok Build 0.2.117+).
 * Soft-fails when CLI is missing or too old.
 */
export async function cliWorktreeDbPath() {
  return invoke<CliWorktreeDbPathResult>("cli_worktree_db_path");
}

/**
 * CLI worktree DB stats (`grok worktree db stats`, Grok Build 0.2.117+).
 * Soft-fails when CLI is missing or too old.
 */
export async function cliWorktreeDbStats() {
  return invoke<CliWorktreeDbStatsResult>("cli_worktree_db_stats");
}

/**
 * Rebuild CLI worktree DB from a filesystem scan
 * (`grok worktree db rebuild`, Grok Build 0.2.117+). Soft-fails on old CLIs.
 */
export async function cliWorktreeDbRebuild() {
  return invoke<CliWorktreeDbRebuildResult>("cli_worktree_db_rebuild");
}

/** Result of creating a linked worktree (`git worktree add`). */
export interface GitWorktreeAddResult {
  path: string;
  name: string;
  startPoint?: string | null;
  branch?: string | null;
}

/**
 * Create a linked worktree for a project folder.
 *
 * Default layout `cli`: `~/.grok/worktrees/<repo>/<name>` (Grok Build 0.2.x).
 * Optional `sibling`: `<parent>/<main_basename>-<name>`.
 * See docs/llm-wiki/git-worktrees.md.
 * Throws when not a git repo / git missing / path exists / invalid name.
 */
export async function gitWorktreeAdd(
  projectPath: string,
  name: string,
  startPoint?: string | null,
  layout?: "cli" | "sibling" | null,
) {
  return invoke<GitWorktreeAddResult>("git_worktree_add", {
    projectPath,
    name,
    startPoint: startPoint?.trim() || null,
    layout: layout === "sibling" ? "sibling" : "cli",
  });
}

/** Native folder dialog → add project. Returns null if user cancels. */
export async function projectAddDialog(trust: boolean) {
  return invoke<{
    id: string;
    name: string;
    path: string;
    trusted: boolean;
    pathOk: boolean;
  } | null>("project_add_dialog", { trust });
}

export async function pickDirectory() {
  return invoke<string | null>("pick_directory");
}

/** Native multi-file picker for composer attachments (empty if cancelled). */
export async function pickAttachFiles() {
  return invoke<string[]>("pick_attach_files");
}

/** Native folder picker for attaching a directory. */
export async function pickAttachFolder() {
  return invoke<string | null>("pick_attach_folder");
}

/**
 * Persist clipboard/webview File bytes into the app attachments dir.
 * Returns a classified path entry for `@path` agent refs.
 */
export async function saveTempAttachment(
  bytesBase64: string,
  suggestedName?: string | null,
  mime?: string | null,
) {
  return invoke<PathEntry>("save_temp_attachment", {
    bytesBase64,
    suggestedName: suggestedName ?? null,
    mime: mime ?? null,
  });
}

/**
 * Read an image from the OS clipboard (native) and save under attachments/paste.
 * Fallback when the WebView paste event has no File objects (macOS screenshots).
 * Returns null when the clipboard has no image.
 */
export async function clipboardPasteImage() {
  if (!isTauri()) return null;
  return invoke<PathEntry | null>("clipboard_paste_image");
}

export interface PathEntry {
  path: string;
  name: string;
  isDir: boolean;
  exists: boolean;
}

/** Classify absolute paths as file/dir for drag-drop. */
export async function pathsClassify(paths: string[]) {
  return invoke<PathEntry[]>("paths_classify", { paths });
}

/** Open with OS default app. */
export async function pathOpen(path: string) {
  return invoke<void>("path_open", { path });
}

/** Reveal in Finder / Explorer. */
export async function pathReveal(path: string) {
  return invoke<void>("path_reveal", { path });
}

/** Optional git unified diff for a project file (session Changes panel). */
export interface GitFileDiffResult {
  available: boolean;
  diff?: string | null;
  relativePath?: string | null;
  reason?: string | null;
}

export async function gitFileDiff(projectPath: string, path: string) {
  return invoke<GitFileDiffResult>("git_file_diff", { projectPath, path });
}

/** One workspace file from `git status --porcelain` (Changes → Workspace). */
export interface GitStatusEntry {
  path: string;
  absolutePath: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: string;
  name: string;
  originalPath?: string | null;
}

export interface GitStatusResult {
  available: boolean;
  files: GitStatusEntry[];
  branch?: string | null;
  reason?: string | null;
}

/** Soft-fail workspace git status for the project path. */
export async function gitStatus(projectPath: string) {
  return invoke<GitStatusResult>("git_status", { projectPath });
}

/** File content at HEAD (before snapshot for local unified diffs). */
export interface GitShowFileResult {
  available: boolean;
  content?: string | null;
  relativePath?: string | null;
  reason?: string | null;
}

export async function gitShowFile(projectPath: string, path: string) {
  return invoke<GitShowFileResult>("git_show_file", { projectPath, path });
}

/** Write full file content under project (Changes Accept / Restore / reject-before). */
export interface ApplyFilePatchResult {
  ok: boolean;
  absolutePath?: string | null;
  relativePath?: string | null;
  reason?: string | null;
}

export async function applyFilePatch(
  projectPath: string,
  path: string,
  content: string,
) {
  return invoke<ApplyFilePatchResult>("apply_file_patch", {
    projectPath,
    path,
    content,
  });
}

/** Restore path to HEAD or delete untracked (with confirm). */
export interface GitCheckoutFileResult {
  ok: boolean;
  absolutePath?: string | null;
  relativePath?: string | null;
  needsUntrackedConfirm?: boolean;
  reason?: string | null;
  action?: string | null;
}

export async function gitCheckoutFile(
  projectPath: string,
  path: string,
  confirmUntracked = false,
) {
  return invoke<GitCheckoutFileResult>("git_checkout_file", {
    projectPath,
    path,
    confirmUntracked,
  });
}

/** Delete a project file (non-git untracked reject after confirm). */
export async function deleteProjectFile(
  projectPath: string,
  path: string,
  confirm = false,
) {
  return invoke<GitCheckoutFileResult>("delete_project_file", {
    projectPath,
    path,
    confirm,
  });
}

export interface FsEntry {
  name: string;
  relativePath: string;
  isDir: boolean;
  size: number;
  ext: string;
}

export interface FsReadResult {
  relativePath: string;
  name: string;
  /** Absolute path for loopback media HTTP streaming (video/audio/large images). */
  absolutePath: string;
  size: number;
  kind: string;
  mime: string;
  text: string | null;
  base64: string | null;
  /** Prefer asset-protocol stream instead of base64 embed. */
  stream: boolean;
  truncated: boolean;
  error: string | null;
  /** Last modified (ms since epoch) for edit conflict checks. */
  mtimeMs?: number;
}

export interface FsWriteResult {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

/** List directory under a trusted project root (relative path, "" = root). */
export async function fsListDir(projectPath: string, relative = "") {
  return invoke<FsEntry[]>("fs_list_dir", {
    projectPath,
    relative: relative || null,
  });
}

/**
 * Project-scoped keyword file/name + content search.
 * Host uses `rg` when available, else walk with caps. Soft-fails when path
 * missing / not a dir / untrusted. `searchKind` is always `"keyword"` —
 * never invents embeddings or CLI code-graph results.
 */
export type CodebaseSearchHit = {
  path: string;
  name: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  snippet: string;
  contentMatch: boolean;
  line?: number | null;
};

export type CodebaseSearchResult = {
  hits: CodebaseSearchHit[];
  projectPath: string;
  projectPathExists: boolean;
  projectIsDir: boolean;
  query: string;
  /** name | content | all */
  mode: string;
  limit: number;
  truncated: boolean;
  /** rg | walk | none */
  engine: string;
  /** Always `"keyword"`. */
  searchKind: string;
  softFail?: string | null;
};

export async function projectCodebaseSearch(opts: {
  projectPath: string;
  query: string;
  mode?: "name" | "content" | "all" | string | null;
  limit?: number | null;
}) {
  return invoke<CodebaseSearchResult>("project_codebase_search", {
    projectPath: opts.projectPath,
    query: opts.query,
    mode: opts.mode ?? null,
    limit: opts.limit ?? null,
  });
}

/** Read file under project root for preview (text or base64). */
export async function fsReadFile(projectPath: string, relative: string) {
  return invoke<FsReadResult>("fs_read_file", {
    projectPath,
    relative,
  });
}

/** Save UTF-8 text under project root. Pass mtime from last read to detect conflicts. */
export async function fsWriteFile(
  projectPath: string,
  relative: string,
  content: string,
  expectedMtimeMs?: number | null,
) {
  return invoke<FsWriteResult>("fs_write_file", {
    projectPath,
    relative,
    content,
    expectedMtimeMs: expectedMtimeMs ?? null,
  });
}

/** Save UTF-8 text to an absolute path open in the resource pane. */
export async function fsWriteAbsolute(
  path: string,
  content: string,
  expectedMtimeMs?: number | null,
) {
  return invoke<FsWriteResult>("fs_write_absolute", {
    path,
    content,
    expectedMtimeMs: expectedMtimeMs ?? null,
  });
}

/** Read absolute filesystem path for chat → resource pane preview. */
export async function fsReadAbsolute(path: string) {
  return invoke<FsReadResult>("fs_read_absolute", { path });
}

/**
 * Smart open for chat file cards: absolute path, project-relative, or
 * suffix search under project (e.g. `05-handoff/next.md` in a subfolder).
 */
export async function fsOpenPath(path: string, projectPath?: string | null) {
  return invoke<FsReadResult>("fs_open_path", {
    path,
    projectPath: projectPath ?? null,
  });
}

/** Auto-title session from first user message (heuristic + optional low-effort CLI). */
export async function sessionAutoTitle(id: string, firstMessage: string) {
  return invoke<{
    id: string;
    title: string;
    projectId: string | null;
    updatedAt: string;
  }>("session_auto_title", { id, firstMessage });
}

/** Cached chat video cover (JPEG path under app cache). */
export type VideoPosterResult = {
  posterPath: string;
  fromCache: boolean;
};

/**
 * Get or create a still cover for a local video path.
 * Host uses disk cache keyed by path+mtime+size; extracts via ffmpeg when missing.
 */
export async function mediaVideoPoster(path: string) {
  return invoke<VideoPosterResult>("media_video_poster", { path });
}

/**
 * Persist a client canvas capture (JPEG base64, no data: prefix) into the same cache key.
 */
export async function mediaVideoPosterSave(path: string, jpegBase64: string) {
  return invoke<VideoPosterResult>("media_video_poster_save", {
    path,
    jpegBase64,
  });
}

export async function projectTrust(id: string) {
  return invoke("project_trust", { id });
}

/**
 * Set or clear a project-level permission tier (L10).
 * Pass `null` / `"inherit"` to fall back to the app default.
 * When the project is the live Host context, agent policy is synced.
 */
export async function projectSetPermissionPolicy(
  id: string,
  policy: string | null,
) {
  return invoke("project_set_permission_policy", {
    id,
    policy,
  });
}

/**
 * Set or clear a project-level OS sandbox profile.
 * Pass `null` / `"inherit"` to fall back to app Settings.
 * When the project is the live Host context, soft-respawns the agent.
 */
export async function projectSetSandboxProfile(
  id: string,
  profile: string | null,
) {
  return invoke("project_set_sandbox_profile", {
    id,
    profile,
  });
}

/** Remove project from app list only (no disk / session wipe). */
export async function projectRemove(id: string) {
  return invoke("project_remove", { id });
}

/**
 * Point project at a new directory (folder moved/renamed).
 * Host re-checks is_dir and sets pathOk true.
 */
export async function projectRelocate(id: string, path: string) {
  return invoke<{
    id: string;
    name: string;
    path: string;
    trusted: boolean;
    pathOk: boolean;
    pinned?: boolean;
  }>("project_relocate", { id, path });
}

export async function projectRename(id: string, name: string) {
  return invoke("project_rename", { id, name });
}

export async function projectSetPinned(id: string, pinned: boolean) {
  return invoke("project_set_pinned", { id, pinned });
}

/**
 * Set or clear a project sidebar accent color.
 * Pass `null` / `"none"` to clear. Accepts tokens (`blue`|…) or `#rgb`/`#rrggbb`.
 */
export async function projectSetColor(id: string, color: string | null) {
  return invoke<{
    id: string;
    name: string;
    path: string;
    trusted: boolean;
    pathOk: boolean;
    pinned?: boolean;
    color?: string | null;
  }>("project_set_color", { id, color });
}

export async function projectReveal(id: string) {
  return invoke("project_reveal", { id });
}

export async function projectArchiveSessions(id: string) {
  return invoke<number>("project_archive_sessions", { id });
}

export async function sessionsList() {
  return invoke<
    Array<{
      id: string;
      projectId: string | null;
      title: string;
      updatedAt: string;
      modelId: string | null;
      /** Per-session reasoning effort when stored on meta. */
      effort?: string | null;
      archived?: boolean;
      /** Pinned chats float to the top of the sidebar */
      pinned?: boolean;
      /** Shell automation run */
      scheduled?: boolean;
      /** Linked worktree path when this chat is worktree-bound */
      worktreePath?: string | null;
      worktreeBranch?: string | null;
      isWorktreeSession?: boolean;
      /** Optional JSON Schema for structured model output */
      jsonSchema?: string | null;
      /** Session-only plugin dirs (`--plugin-dir`); empty/omit = none */
      pluginDirs?: string[];
      /** Per-session extra rules (`--rules`); empty/omit = none */
      extraRules?: string | null;
      /** Per-session max agent turns (`--max-turns`); null/omit = inherit global */
      maxAgentTurns?: number | null;
      /** Per-session system prompt override (`--system-prompt-override`); empty/omit = none */
      systemPromptOverride?: string | null;
      /** Per-session `--no-ask-user` override; null/omit = inherit global */
      noAskUser?: boolean | null;
    }>
  >("sessions_list");
}

/** Set or clear per-session extra rules (`grok --rules`). Empty clears. */
export async function sessionSetExtraRules(
  id: string,
  extraRules: string | null,
) {
  return invoke<{
    id: string;
    title: string;
    extraRules?: string | null;
  }>("session_set_extra_rules", {
    id,
    extraRules: extraRules && extraRules.trim() ? extraRules : null,
  });
}

/**
 * Set or clear per-session max agent turns (`grok --max-turns`).
 * Pass `null` / `0` to inherit global Settings. Soft-respawns live agent.
 */
export async function sessionSetMaxAgentTurns(
  id: string,
  maxAgentTurns: number | null,
) {
  const n =
    typeof maxAgentTurns === "number" && maxAgentTurns > 0
      ? Math.min(200, Math.max(1, Math.round(maxAgentTurns)))
      : null;
  return invoke<{
    id: string;
    title: string;
    maxAgentTurns?: number | null;
  }>("session_set_max_agent_turns", {
    id,
    maxAgentTurns: n,
  });
}

/**
 * Set or clear per-session system prompt override (`grok --system-prompt-override`).
 * Empty clears. Soft-respawns live agent. Do not log the prompt body.
 */
export async function sessionSetSystemPromptOverride(
  id: string,
  systemPromptOverride: string | null,
) {
  return invoke<{
    id: string;
    title: string;
    systemPromptOverride?: string | null;
  }>("session_set_system_prompt_override", {
    id,
    systemPromptOverride:
      systemPromptOverride && systemPromptOverride.trim()
        ? systemPromptOverride
        : null,
  });
}

/**
 * Set or clear per-session `--no-ask-user` override (CLI ≥ 0.2.117).
 * Pass `null` to inherit global Settings. Soft-respawns live agent.
 */
export async function sessionSetNoAskUser(
  id: string,
  noAskUser: boolean | null,
) {
  return invoke<{
    id: string;
    title: string;
    noAskUser?: boolean | null;
  }>("session_set_no_ask_user", {
    id,
    noAskUser: typeof noAskUser === "boolean" ? noAskUser : null,
  });
}

/** Set or clear per-session JSON Schema structured output. */
export async function sessionSetJsonSchema(
  id: string,
  jsonSchema: string | null,
) {
  return invoke<{
    id: string;
    title: string;
    jsonSchema?: string | null;
  }>("session_set_json_schema", {
    id,
    jsonSchema: jsonSchema && jsonSchema.trim() ? jsonSchema : null,
  });
}

/** Journal content hit from `sessions_search`. */
export type SessionContentSearchHit = {
  id: string;
  title: string;
  projectId?: string | null;
  snippet: string;
  matchCount: number;
  updatedAt: string;
  archived?: boolean;
};

/**
 * Scan App session journals for case-insensitive content matches.
 * Empty query returns []. Caps scan work on the host.
 */
export async function sessionsSearch(query: string, limit = 20) {
  if (!query.trim()) return [] as SessionContentSearchHit[];
  if (!isTauri()) return [] as SessionContentSearchHit[];
  return invoke<SessionContentSearchHit[]>("sessions_search", {
    query,
    limit,
  });
}

/** CLI sessions under GROK_HOME (session_data_mode discovery). */
export type CliSessionSummary = {
  agentSessionId: string;
  title: string;
  cwd: string | null;
  updatedAt: string;
  dir: string;
  numMessages: number;
  alreadyLinked: boolean;
  /** App session id when already linked (one-click open). */
  appSessionId?: string | null;
  /** GROK_HOME used for discovery (path clarity). */
  sourceHome?: string;
  /** First user prompt when known (search / enriched). */
  firstPrompt?: string | null;
};

/** Hit from `grok sessions search` (or local first-prompt fallback). */
export type CliSessionSearchHit = CliSessionSummary & {
  /** CLI status token: local | remote. */
  status?: string | null;
  /** `"cli"` from `grok sessions search`, `"local"` for disk fallback. */
  source: "cli" | "local" | string;
};

export async function cliSessionsList() {
  return invoke<CliSessionSummary[]>("cli_sessions_list");
}

/**
 * Search CLI sessions (summaries + first prompts) via host
 * `grok sessions search`. Falls back to local disk filter when CLI fails.
 */
export async function cliSessionsSearch(query: string, limit?: number) {
  return invoke<CliSessionSearchHit[]>("cli_sessions_search", {
    query,
    limit: limit ?? 40,
  });
}

export async function cliSessionImport(
  agentSessionId: string,
  opts?: { dir?: string | null; projectId?: string | null },
) {
  return invoke<{
    id: string;
    title: string;
    projectId: string | null;
    updatedAt: string;
  }>("cli_session_import", {
    agentSessionId,
    dir: opts?.dir ?? null,
    projectId: opts?.projectId ?? null,
  });
}

/**
 * Find the most recent CLI agent session for a project path
 * (CLI `grok -c/--continue`). Soft-fails → null when none exist.
 */
export async function cliSessionFindLatestForCwd(projectPath: string) {
  if (!isTauri()) return null;
  const path = projectPath.trim();
  if (!path) return null;
  return invoke<CliSessionSummary | null>("cli_session_find_latest_for_cwd", {
    projectPath: path,
  });
}

/**
 * CLI `-c/--continue`: find latest agent session for project path and
 * open/import it as an App session. Soft-fails → null when none exist.
 */
export async function cliSessionContinueCwd(
  projectPath: string,
  opts?: { projectId?: string | null },
) {
  if (!isTauri()) return null;
  const path = projectPath.trim();
  if (!path) return null;
  return invoke<{
    id: string;
    title: string;
    projectId: string | null;
    updatedAt: string;
    agentSessionId?: string | null;
  } | null>("cli_session_continue_cwd", {
    projectPath: path,
    projectId: opts?.projectId ?? null,
  });
}

export async function cliSessionsImportAll(limit?: number) {
  return invoke<
    Array<{
      id: string;
      title: string;
      projectId: string | null;
      updatedAt: string;
    }>
  >("cli_sessions_import_all", { limit: limit ?? 50 });
}

/**
 * Delete one on-disk CLI session under active GROK_HOME.
 * Prefer passing `dir` from list. Does not delete App chats.
 */
export async function cliSessionDelete(
  agentSessionId: string,
  opts?: { dir?: string | null },
) {
  return invoke<void>("cli_sessions_delete", {
    agentSessionId,
    dir: opts?.dir ?? null,
  });
}

export async function sessionCreate(
  projectId?: string,
  title?: string,
  opts?: { scheduled?: boolean },
) {
  return invoke("session_create", {
    projectId: projectId ?? null,
    title: title ?? null,
    scheduled: opts?.scheduled ?? false,
  });
}

export async function sessionSetScheduled(id: string, scheduled: boolean) {
  return invoke<{
    id: string;
    title: string;
    scheduled?: boolean;
  }>("session_set_scheduled", { id, scheduled });
}

export async function sessionRename(id: string, title: string) {
  return invoke("session_rename", { id, title });
}

export async function sessionSetArchived(id: string, archived: boolean) {
  return invoke("session_set_archived", { id, archived });
}

export async function sessionSetPinned(id: string, pinned: boolean) {
  return invoke("session_set_pinned", { id, pinned });
}

/**
 * Attach or clear worktree linkage on a session (path/branch + WT badge flag).
 * Pass empty/null path to clear.
 */
export async function sessionSetWorktree(
  id: string,
  opts?: {
    worktreePath?: string | null;
    worktreeBranch?: string | null;
  },
) {
  return invoke<{
    id: string;
    title: string;
    worktreePath?: string | null;
    worktreeBranch?: string | null;
    isWorktreeSession?: boolean;
  }>("session_set_worktree", {
    id,
    worktreePath: opts?.worktreePath ?? null,
    worktreeBranch: opts?.worktreeBranch ?? null,
  });
}

/** Bind session to a project, or clear (`projectId: null`) for orphan / 其他会话. */
export async function sessionSetProject(
  id: string,
  projectId: string | null,
) {
  return invoke<{
    id: string;
    projectId: string | null;
    title: string;
  }>("session_set_project", { id, projectId });
}

/**
 * Set session-only plugin directories for spawn (`--plugin-dir`).
 * Pass `[]` to clear. Does not change global Extensions plugins.
 * Soft-respawns when this chat is the live agent.
 */
export async function sessionSetPluginDirs(id: string, pluginDirs: string[]) {
  return invoke<{
    id: string;
    title: string;
    pluginDirs?: string[];
  }>("session_set_plugin_dirs", { id, pluginDirs });
}


export async function sessionDelete(id: string) {
  return invoke("session_delete", { id });
}

export async function sessionMessages(id: string) {
  return invoke<
    Array<{
      id: string;
      role: string;
      content: string;
      thought?: string | null;
      createdAt: string;
      isError?: boolean;
      marker?: string | null;
      attachments?: Array<{
        path: string;
        name: string;
        isDir?: boolean;
      }> | null;
    }>
  >("session_messages", { id });
}

/** Agent session folder under GROK_HOME (contains images/, etc.). */
export async function sessionMediaRoot(id: string) {
  return invoke<string | null>("session_media_root", { id });
}

/** Loopback media HTTP base + token (token-gated Range streaming of local files). */
export async function mediaServerEndpoint() {
  return invoke<{ baseUrl: string; token: string }>("media_server_endpoint");
}

/**
 * Resolve short session-relative paths (`images/1.jpg`) to absolute files
 * that exist under the agent session directory.
 */
export async function sessionResolveRelativeMedia(
  id: string,
  relatives: string[],
) {
  if (!relatives.length) return [];
  return invoke<
    Array<{ path: string; name: string; isDir?: boolean }>
  >("session_resolve_relative_media", { id, relatives });
}

export type ComposerPrefsScope = "global" | "project" | "session";

export interface AppSettings {
  theme: string;
  locale: string;
  sessionDataMode: string;
  manualCliPath: string | null;
  permissionPolicy: string;
  modelId: string | null;
  effort: string | null;
  mode: string;
  onboardingDone: boolean;
  setupSkipped: boolean;
  /** First-run wizard finished (CLI gate + optional auth). */
  setupWizardCompleted?: boolean;
  /** User skipped account/provider step during setup. */
  authSetupDeferred?: boolean;
  defaultOpenTarget?: string;
  /** global | project | session — where model/permission chips are remembered */
  composerPrefsScope?: ComposerPrefsScope | string;
  /** API mode: `host:port` of a remote ACP server. When set, sessions connect
   *  over TCP instead of spawning the local CLI. Empty/unset = local spawn. */
  acpServerAddr?: string | null;
  /** Max warm/live agent processes (default 3). */
  maxConcurrentAgents?: number;
  /** Recycle idle agent processes after N minutes (default 30). */
  agentIdleMinutes?: number;
  /** Pure stream silence before cancel prompt, seconds (default 120). */
  streamStallSeconds?: number;
  /**
   * When true, headless paths that use `--output-format streaming-messages-json`
   * also pass `--include-partial-messages` (CLI 0.2.117+) for incremental
   * `stream_event` deltas. Default false. Soft-fails on older CLIs.
   * Only valid with streaming-messages-json (Remote IM upgrades format when on).
   */
  includePartialMessages?: boolean;
  /**
   * When true, App API keys go in the OS keychain.
   * Default false: keys stay in secrets.json (0600). Official login uses auth.json.
   */
  storeApiKeysInKeychain?: boolean;
  /**
   * OS-level sandbox for spawned agents: off | workspace | read-only | strict | devbox.
   * Default "off". Passed as `grok --sandbox <profile>` / GROK_SANDBOX on spawn.
   */
  sandboxProfile?: string;

  maxAgentTurns?: number | null;
  /**
   * Headless background-wait after first turn: `wait` | `no_wait` | `timeout`.
   * CLI 0.2.117+ (`--no-wait-for-background` / `--background-wait-timeout`).
   * Default `wait` (omit flags). Soft-fails on older CLIs.
   */
  backgroundWaitPolicy?: string;
  /**
   * Seconds for `--background-wait-timeout` when policy is `timeout` (1–3600).
   * Default 600.
   */
  backgroundWaitTimeoutSec?: number;
  preferredAgent?: string;
  /**
   * Optional path for `grok agent --agent-profile <PATH>`.
   * Empty = omit flag (CLI default). Soft-respawns on change.
   */
  agentProfilePath?: string;
  /**
   * Optional inline subagent definitions JSON for top-level `grok --agents <JSON>`.
   * Empty = omit flag. Must be a JSON object map when set; invalid values reject save.
   * Soft-respawns on change. Does not write into shared ~/.grok.
   */
  agentsJson?: string;
  experimentalMemory?: boolean;
  /**
   * Enable CLI TodoGate (turn-end nudge when todos still pending / in_progress).
   * Default false. Spawns with top-level `--todo-gate` (CLI 0.2.117+). Soft-respawns.
   */
  todoGateEnabled?: boolean;
  /**
   * Max TodoGate fires per prompt (1–20, default 3). Config-only key
   * `todo_gate_max_fires_per_prompt` (no CLI flag). Independent agent-home
   * writes apply; shared mode stores the App setting only (never rewrites
   * `~/.grok`). Soft-respawns on change.
   */
  todoGateMaxFiresPerPrompt?: number;
  /**
   * Compaction mode for spawned agents (CLI 0.2.117+):
   * summary | transcript | segments. Maps to `--compaction-mode` /
   * GROK_COMPACTION_MODE. Default "summary". Soft-respawns on change.
   */
  compactionMode?: string;
  /**
   * Segments detail (CLI 0.2.117+): none | minimal | balanced | verbose.
   * Only affects segments mode (`--compaction-detail` / GROK_COMPACTION_DETAIL).
   * Default "verbose". Soft-respawns on change.
   */
  compactionDetail?: string;
  /**
   * Prefire two-pass compaction (CLI 0.2.117+).
   * Default false. Writes agent-home `two_pass_compaction_enabled` in
   * independent mode; spawn sets `GROK_TWO_PASS_COMPACTION`. Soft-respawns.
   */
  twoPassCompactionEnabled?: boolean;
  disableWebSearch?: boolean;
  /**
   * When true, spawn with top-level `--no-ask-user` (CLI ≥ 0.2.117) so the
   * agent does not emit ask-user questionnaires. Default false. Soft-respawns.
   * Per-session override: `SessionMeta.noAskUser`.
   */
  noAskUser?: boolean;
  /**
   * Built-in tool ids denied via CLI `--disallowed-tools a,b`.
   * Default empty. Coexists with `disableWebSearch`; changes soft-respawn.
   */
  disallowedTools?: string[];
  /**
   * Built-in tool ids allowlisted via CLI `--tools a,b`.
   * Default empty = omit flag (CLI default all tools). When non-empty,
   * restricts the agent to listed tools. Coexists with `disallowedTools`
   * (allowlist restricts; denylist still applies). Changes soft-respawn.
   */
  allowedTools?: string[];
  planEnabled?: boolean;
  subagentsEnabled?: boolean;
  /**
   * Enable CLI subagent worktree snapshot (CLI 0.2.117+).
   * Default false. Writes agent-home `subagent_worktree_snapshot_enabled` in
   * independent mode; spawn sets `GROK_SUBAGENT_WORKTREE_SNAPSHOT`. Soft-respawns.
   */
  subagentWorktreeSnapshotEnabled?: boolean;
  /**
   * Enable CLI auto-wake (config `auto_wake_enabled`). Default false (opt-in).
   * When on, Grok Build may inject a synthetic turn after background work
   * completes (CLI-side). Independent mode writes agent-home `auto_wake_enabled`
   * only — no invented env override. Soft-respawns on change.
   */
  autoWakeEnabled?: boolean;
  /**
   * Enable Grok Build workflows (`workflows_enabled` in agent-home config).
   * Default false. Independent mode writes the top-level key; soft-respawns.
   * No in-app runner — scripts run via CLI / Rhai `workflow` tool.
   */
  workflowsEnabled?: boolean;
  useLeader?: boolean;
  /** Reopen last active chat once after launch (default false → draft new chat). */
  reopenLastSession?: boolean;
  /** Last successfully opened session id (startup restore). */
  lastSessionId?: string | null;
  /** Project of lastSessionId when it belonged to one (hint only). */
  lastProjectId?: string | null;
  /** Sidebar project folder ids the user collapsed (missing ⇒ expanded). */
  sidebarCollapsedProjectIds?: string[];
  voiceId?: string;
  voiceDictationAutoSend?: boolean;
  voiceKeepAgentsOnEnd?: boolean;
  /** Window close hides to tray when true (default). */
  closeToTray?: boolean;
  /**
   * When true (default), closing the window still hides to tray if any
   * scheduled task is enabled — so host automation_runner keeps ticking.
   * Not a daemon; full quit still pauses schedules.
   */
  keepTrayForSchedules?: boolean;
  /**
   * macOS: optional LaunchAgent helper that starts the full app at login /
   * after crash. Default false. Not a headless scheduler.
   */
  schedulesLaunchAgent?: boolean;
  /** Start the app when the user logs into the OS (default false). */
  launchAtLogin?: boolean;
  /** Desktop notification when an agent turn finishes (default true). */
  notifyOnTurnDone?: boolean;
  /** Desktop notification when the agent requests permission (default true). */
  notifyOnPermission?: boolean;
  /**
   * Allow CLI install when the mirror has no published SHA-256 (default false).
   * Mismatch always fails. Prefer fixing the mirror over enabling this.
   */
  allowUnverifiedCliInstall?: boolean;
  /** Last App-managed CLI install checksum result (`true` = verified). */
  lastCliChecksumVerified?: boolean | null;
  /**
   * Tool audit ledger retention days: `7` | `30` | `90` | `0` (unlimited).
   * Applied on write/rotate and explicit prune. Default 0.
   */
  auditLedgerRetentionDays?: number;
}

export interface ReasoningEffort {
  id: string;
  value: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface AvailableModel {
  id: string;
  label: string;
  source: string;
  isDefault?: boolean;
  /** Per-model efforts from CLI models_cache; omit/empty → static fallback. */
  reasoningEfforts?: ReasoningEffort[];
}

export interface AvailableModelsResult {
  models: AvailableModel[];
  defaultModelId: string;
  origin?: string | null;
  fetchedAt?: string | null;
}

export interface ComposerPrefs {
  modelId: string;
  effort: string;
  mode: string;
  permissionPolicy: string;
  scope: string;
  source: string;
}

export async function settingsGet() {
  return invoke<AppSettings>("settings_get");
}

/** Path of a store JSON file quarantined after corrupt parse (one-shot). */
export async function storeTakeQuarantine() {
  return invoke<string | null>("store_take_quarantine");
}

export async function modelsListAvailable() {
  return invoke<AvailableModelsResult>("models_list_available");
}

export async function composerPrefsResolve(opts?: {
  projectId?: string | null;
  sessionId?: string | null;
}) {
  return invoke<ComposerPrefs>("composer_prefs_resolve", {
    projectId: opts?.projectId ?? null,
    sessionId: opts?.sessionId ?? null,
  });
}

export async function composerPrefsSet(body: {
  projectId?: string | null;
  sessionId?: string | null;
  modelId?: string | null;
  effort?: string | null;
  mode?: string | null;
  permissionPolicy?: string | null;
}) {
  return invoke<ComposerPrefs>("composer_prefs_set", {
    projectId: body.projectId ?? null,
    sessionId: body.sessionId ?? null,
    modelId: body.modelId ?? null,
    effort: body.effort ?? null,
    mode: body.mode ?? null,
    permissionPolicy: body.permissionPolicy ?? null,
  });
}

export async function settingsSet(settings: Record<string, unknown>) {
  return invoke("settings_set", { settings });
}

/** Update live Host permission policy + persist at configured prefs scope. */
export async function sessionSetPolicy(
  policy: string,
  opts?: { projectId?: string | null; sessionId?: string | null },
) {
  if (!isTauri()) return null;
  return invoke<ComposerPrefs>("session_set_policy", {
    policy,
    projectId: opts?.projectId ?? null,
    sessionId: opts?.sessionId ?? null,
  });
}

/** Switch live agent model + persist at configured prefs scope. */
export async function sessionSetModel(
  modelId: string,
  opts?: { projectId?: string | null; sessionId?: string | null },
) {
  if (!isTauri()) return null;
  return invoke<ComposerPrefs>("session_set_model", {
    modelId,
    projectId: opts?.projectId ?? null,
    sessionId: opts?.sessionId ?? null,
  });
}

export async function secretsGetMasked() {
  return invoke<{
    hasOfficialKey: boolean;
    hasRelayKey: boolean;
    relayBaseUrl: string | null;
    defaultModel: string | null;
  }>("secrets_get_masked");
}

export async function secretsSet(body: {
  officialApiKey?: string;
  relayBaseUrl?: string;
  relayApiKey?: string;
  defaultModel?: string;
}) {
  return invoke("secrets_set", {
    officialApiKey: body.officialApiKey ?? null,
    relayBaseUrl: body.relayBaseUrl ?? null,
    relayApiKey: body.relayApiKey ?? null,
    defaultModel: body.defaultModel ?? null,
  });
}

export async function providerPing() {
  return invoke<{ ok: boolean; class: string; message: string }>("provider_ping");
}

export async function importGrokCli() {
  return invoke("import_grok_cli_config");
}

export async function importGrokGo() {
  return invoke("import_grok_go_config");
}

// ── Doctor / skills / MCP ───────────────────────────────────────────────────

export type DoctorLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  level: DoctorLevel;
  title: string;
  detail: string;
  meta?: Record<string, unknown>;
}

export interface DoctorSummary {
  ok: number;
  warn: number;
  fail: number;
}

/**
 * Host envelope for `grok doctor --json` (see `parseCliDoctorEnvelope`).
 * `report` is the raw CLI JSON blob when available.
 */
export interface CliDoctorPayload {
  available: boolean;
  error?: string | null;
  report?: Record<string, unknown> | null;
  exitOk?: boolean;
  stdoutPreview?: string;
}

export interface DoctorReport {
  generatedAt: string;
  summary: DoctorSummary;
  checks: DoctorCheck[];
  /** Flat snapshot for copy/export (no secrets). */
  raw: Record<string, unknown>;
  /** Grok Build CLI `doctor --json` envelope (optional for older hosts). */
  cliDoctor?: CliDoctorPayload | null;
}

export interface SkillDto {
  name: string;
  description: string;
  /** Normalized source type (e.g. user, project, plugin). */
  source: string;
  path?: string | null;
  userInvocable: boolean;
  /** App Extensions enable flag (default true when omitted). */
  enabled?: boolean;
}

export interface McpDto {
  name: string;
  transport?: string | null;
  target?: string | null;
  vendor?: string | null;
  compatibilityStatus?: string | null;
  /** App Extensions enable flag (default true when omitted). */
  enabled?: boolean;
}

export interface SkillsListResult {
  skills: SkillDto[];
  /** Absolute allowlisted skill roots for in-app SKILL.md editing. */
  skillRoots?: string[];
  error?: string;
}

/** Result of Host `skill_read` (allowlisted SKILL.md only). */
export interface SkillReadResult {
  path: string;
  name: string;
  content: string;
  size: number;
  mtimeMs: number;
  truncated: boolean;
}

/** Result of Host `skill_write`. */
export interface SkillWriteResult {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Result of Host `skill_create` (scaffold folder + SKILL.md). */
export interface SkillCreateResult {
  path: string;
  name: string;
  root: string;
  created: boolean;
  alreadyExisted: boolean;
}

export interface InspectMcpResult {
  servers: McpDto[];
  error?: string;
}

/** App MCP/Skills enable prefs (`extensions.json`). Missing name = enabled. */
export interface ExtensionsPrefs {
  mcp: Record<string, boolean>;
  skills: Record<string, boolean>;
}

export async function extensionsGet() {
  return invoke<ExtensionsPrefs>("extensions_get");
}

/** Toggle one MCP server; Host persists + injects on next session + soft-respawns. */
export async function extensionsSetMcp(name: string, enabled: boolean) {
  return invoke<ExtensionsPrefs>("extensions_set_mcp", { name, enabled });
}

/** Toggle one skill (slash palette filter). */
export async function extensionsSetSkill(name: string, enabled: boolean) {
  return invoke<ExtensionsPrefs>("extensions_set_skill", { name, enabled });
}

/** Bulk-enable all listed MCP servers. */
export async function extensionsEnableAllMcp(names: string[]) {
  return invoke<ExtensionsPrefs>("extensions_enable_all_mcp", { names });
}

/** Bulk-enable all listed skills. */
export async function extensionsEnableAllSkills(names: string[]) {
  return invoke<ExtensionsPrefs>("extensions_enable_all_skills", { names });
}

export async function doctorReport() {
  return invoke<DoctorReport>("doctor_report");
}

/** Result of `grok doctor fix <id> --yes` (stdout/stderr already redacted). */
export interface CliDoctorFixResult {
  ok: boolean;
  id: string;
  stdout: string;
  stderr: string;
  exitOk?: boolean;
  error?: string;
}

/**
 * Apply a CLI automatic remediation (`doctor fix <id> --yes`).
 * Prefer confirm in UI for destructive fixes first.
 */
export async function cliDoctorFix(id: string) {
  return invoke<CliDoctorFixResult>("cli_doctor_fix", { id });
}

export interface SupportBundleResult {
  ok: boolean;
  path: string;
  /** Optional file size in bytes (cheap host `stat` after save). */
  sizeBytes?: number;
}

/**
 * Result of `session_trace_export`.
 * History may record `uploaded` when the CLI reported a remote upload —
 * never secrets or remote URLs.
 */
export interface SessionTraceExportResult extends SupportBundleResult {
  /** Host default is true (`grok trace --local`). */
  localOnly?: boolean;
  /** True only when export allowed network upload and CLI reported remote info. */
  uploaded?: boolean;
}

/**
 * Build a redacted support zip (Doctor + logs + optional stall timeline)
 * and save via native dialog.
 *
 * `stallTimelineJson` is optional Reliability-center snapshot JSON
 * (structured stall signals only; host redacts secrets).
 */
export async function exportSupportBundle(
  doctorJson?: string | null,
  stallTimelineJson?: string | null,
) {
  return invoke<SupportBundleResult>("export_support_bundle", {
    doctorJson: doctorJson ?? null,
    stallTimelineJson: stallTimelineJson ?? null,
  });
}

/** One host audit ledger row (camelCase). */
export type AuditLedgerHostEntry = {
  ts: string;
  sessionId?: string | null;
  projectPath?: string | null;
  toolName: string;
  event: string;
  permission?: string | null;
  outcome?: string | null;
  summary?: string | null;
};

/** Host process-budget occupancy (live / background / parked). Soft-fail → null. */
export type ProcessBudgetHostSnapshot = {
  live?: number;
  background?: number;
  parked?: number;
  totalWarm?: number;
  busy?: number;
  maxConcurrent?: number;
  idleMinutes?: number;
  liveSessionIds?: string[];
  backgroundSessionIds?: string[];
  parkedSessionIds?: string[];
  available?: boolean;
};

/**
 * Live agent process occupancy vs `maxConcurrentAgents`.
 * Soft-fail: returns null when not in Tauri or the command errors
 * (UI maps null → unavailable empty snapshot).
 */
export async function processBudgetSnapshot(): Promise<ProcessBudgetHostSnapshot | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<ProcessBudgetHostSnapshot>("process_budget_snapshot");
  } catch {
    return null;
  }
}

/** Recent cross-session tool/permission audit rows (newest first). Soft-fail → []. */
export async function auditLedgerList(limit?: number | null) {
  if (!isTauri()) return [] as AuditLedgerHostEntry[];
  try {
    return await invoke<AuditLedgerHostEntry[]>("audit_ledger_list", {
      limit: limit ?? null,
    });
  } catch {
    return [];
  }
}

/** Clear on-disk audit ledger. */
export async function auditLedgerClear() {
  return invoke<{ ok: boolean }>("audit_ledger_clear");
}

/** Prune ledger by retention days (`null` → current AppSettings). Soft-fail. */
export async function auditLedgerPrune(retentionDays?: number | null) {
  return invoke<{ ok: boolean; dropped: number }>("audit_ledger_prune", {
    retentionDays: retentionDays ?? null,
  });
}

/** Export filter for host redacted JSONL (camelCase). */
export type AuditLedgerExportFilterArg = {
  event?: string | null;
  sessionId?: string | null;
  fromTs?: string | null;
  toTs?: string | null;
};

/** Export redacted JSONL via native save dialog (optional event/session/range). */
export async function auditLedgerExport(filter?: AuditLedgerExportFilterArg | null) {
  return invoke<SupportBundleResult>("audit_ledger_export", {
    filter: filter ?? null,
  });
}

/**
 * Full session diagnostic zip for bug reports: messages, meta, settings,
 * CLI probe, agent trail (events/history/terminal logs), optional runtime snapshot.
 * Secrets are redacted. Opens a native save dialog.
 */
export async function exportSessionBundle(sessionId: string) {
  return invoke<SupportBundleResult>("export_session_bundle", {
    sessionId,
  });
}

export interface ExportBytesSaveResult {
  ok: boolean;
  cancelled?: boolean;
  path?: string | null;
}

/**
 * Save raw bytes (base64, no data: prefix) via native save dialog.
 * Used for share-card PNG so Tauri WebView does not depend on `<a download>`.
 */
export async function exportBytesSave(opts: {
  bytesBase64: string;
  defaultName: string;
  dialogTitle?: string;
  filterName?: string;
  extensions?: string[];
}) {
  return invoke<ExportBytesSaveResult>("export_bytes_save", {
    bytesBase64: opts.bytesBase64,
    defaultName: opts.defaultName,
    dialogTitle: opts.dialogTitle ?? null,
    filterName: opts.filterName ?? null,
    extensions: opts.extensions ?? null,
  });
}

/** Put a PNG (base64, no data: prefix) on the OS clipboard via arboard. */
export async function clipboardWriteImage(bytesBase64: string) {
  return invoke<void>("clipboard_write_image", { bytesBase64 });
}

/**
 * Export Grok Build CLI session trace via `grok trace <agentSessionId>`.
 * Export Grok Build CLI session transcript via `grok export <agentSessionId> [OUTPUT]`.
 * Requires a linked agent session id. Returns markdown text for blob download.
 * Callers should soft-fail to the local App journal when this rejects.
 */
export type SessionCliExportResult = {
  ok: boolean;
  markdown?: string;
  agentSessionId?: string;
  source?: string;
};

export async function sessionCliExport(sessionId: string) {
  return invoke<SessionCliExportResult>("session_cli_export", {
    sessionId,
  });
}

/**
 * Export Grok Build CLI session trace via `grok trace <agentSessionId> --local`.
 * Requires a linked agent session id. Opens a native save dialog for the `.tar.gz`.
 *
 * @param localOnly default **true** (safe): pass `--local`. Set false to omit
 *   `--local` so the CLI may upload over the network.
 */
export async function sessionTraceExport(
  sessionId: string,
  opts?: { localOnly?: boolean },
) {
  return invoke<SessionTraceExportResult>("session_trace_export", {
    sessionId,
    localOnly: opts?.localOnly ?? true,
  });
}

export interface ResetAppDataResult {
  ok: boolean;
  dataRoot: string;
  removed: string[];
  keptSecrets: boolean;
}

/**
 * Wipe App data under the data root.
 * Does not touch ~/.grok. Confirm twice in the UI before calling.
 */
export async function resetAppData(keepSecrets = true) {
  return invoke<ResetAppDataResult>("reset_app_data", {
    keepSecrets,
  });
}

/** List skills via `grok inspect --json` (optional project cwd). */
export async function skillsList(projectPath?: string | null) {
  return invoke<SkillsListResult>("skills_list", {
    projectPath: projectPath ?? null,
  });
}

/** Absolute allowlisted skill roots (user / agent-home / project). */
export async function skillRoots(projectPath?: string | null) {
  return invoke<string[]>("skill_roots", {
    projectPath: projectPath ?? null,
  });
}

/** Read a user-editable SKILL.md (path must sit under known skills roots). */
export async function skillRead(path: string, projectPath?: string | null) {
  return invoke<SkillReadResult>("skill_read", {
    path,
    projectPath: projectPath ?? null,
  });
}

/** Write a user-editable SKILL.md (path must sit under known skills roots). */
export async function skillWrite(
  path: string,
  content: string,
  expectedMtimeMs?: number | null,
  projectPath?: string | null,
) {
  return invoke<SkillWriteResult>("skill_write", {
    path,
    content,
    expectedMtimeMs: expectedMtimeMs ?? null,
    projectPath: projectPath ?? null,
  });
}

/**
 * Scaffold a new skill (`{root}/{name}/SKILL.md`).
 * @param scope `"user"` (path-scoped GROK_HOME skills) or `"project"` (requires projectPath).
 * Does not overwrite an existing SKILL.md.
 */
export async function skillCreate(opts: {
  name: string;
  description?: string | null;
  projectPath?: string | null;
  scope?: "user" | "project" | null;
}) {
  return invoke<SkillCreateResult>("skill_create", {
    name: opts.name,
    description: opts.description ?? null,
    projectPath: opts.projectPath ?? null,
    scope: opts.scope ?? "user",
  });
}

/** List MCP servers via `grok inspect --json` (optional project cwd). */
export async function inspectMcp(projectPath?: string | null) {
  return invoke<InspectMcpResult>("inspect_mcp", {
    projectPath: projectPath ?? null,
  });
}

// ── Project inspect summary (`grok inspect --json`, secret-safe DTO) ────────

export type {
  ProjectInspectSummary,
  ProjectInspectPlugin,
  ProjectInspectMcp,
  ProjectInspectRule,
  ProjectInspectAgent,
  ProjectInspectHook,
  ProjectInspectSkills,
  ProjectInspectPermissions,
  InspectSectionId,
} from "./projectInspect";

/**
 * Sanitized project inspect summary for Settings → Runtime.
 * Optional `projectPath` is used as CLI cwd; secrets never leave the host.
 */
export async function projectInspect(projectPath?: string | null) {
  return invoke<import("./projectInspect").ProjectInspectSummary>("project_inspect", {
    projectPath: projectPath ?? null,
  });
}

// ── Plugins via `grok plugin …` ─────────────────────────────────────────────

/** Component counts from `grok inspect` plugins[].provides — Grok Build shape. */
export interface PluginProvidesDto {
  skills: number;
  agents: number;
  hooks: boolean;
  mcpServers: number;
}

export interface PluginDto {
  name: string;
  version?: string | null;
  source?: string | null;
  marketplace?: string | null;
  path?: string | null;
  /** Install status from `plugin list --json` (usually "installed"). */
  status: string;
  /** Load state from Grok Build config / enable|disable CLI. */
  enabled: boolean;
  repoKey?: string | null;
  /** Grok Build scope: user / project / cli / marketplace name. */
  scope?: string | null;
  provides?: PluginProvidesDto | null;
}

export interface PluginsListResult {
  plugins: PluginDto[];
  error?: string;
}

export interface PluginActionResult {
  ok: boolean;
  name: string;
  message?: string;
}

export interface PluginDetailsResult {
  name: string;
  details: string;
}

/** List installed plugins via `grok plugin list --json`. */
export async function pluginsList() {
  return invoke<PluginsListResult>("plugins_list");
}

/** Enable plugin (`grok plugin enable`) and soft-respawn agent. */
export async function pluginEnable(name: string) {
  return invoke<PluginActionResult>("plugin_enable", { name });
}

/** Disable plugin (`grok plugin disable`) and soft-respawn agent. */
export async function pluginDisable(name: string) {
  return invoke<PluginActionResult>("plugin_disable", { name });
}

/** Uninstall plugin (`grok plugin uninstall --confirm`) and soft-respawn agent. */
export async function pluginUninstall(name: string) {
  return invoke<PluginActionResult>("plugin_uninstall", { name });
}

/** Plugin component inventory text (`grok plugin details`). */
export async function pluginDetails(name: string) {
  return invoke<PluginDetailsResult>("plugin_details", { name });
}

/**
 * Install from path, git URL, or GitHub shorthand (`grok plugin install --trust`).
 * Soft-respawns agent on success.
 */
export async function pluginInstall(source: string) {
  return invoke<PluginActionResult>("plugin_install", { source });
}

/**
 * Update one plugin by name, or all when name is omitted/null/empty.
 * Soft-respawns agent on success.
 */
export async function pluginUpdate(name?: string | null) {
  const n = (name ?? "").trim();
  return invoke<PluginActionResult>("plugin_update", {
    name: n ? n : null,
  });
}

/** Result of `grok plugin validate` (host always returns envelope; soft-fail when CLI too old). */
export interface PluginValidateResult {
  ok: boolean;
  messages: string[];
  path?: string | null;
  /** e.g. `cli_too_old` when the probed CLI lacks `plugin validate`. */
  reason?: string | null;
}

/**
 * Validate a plugin manifest via `grok plugin validate [path|name]`.
 * Pass an installed plugin path/name, or a local path before install.
 * Soft-fails (ok:false + reason) when CLI is too old — does not throw for that case.
 */
export async function pluginValidate(pathOrName?: string | null) {
  const raw = (pathOrName ?? "").trim();
  return invoke<PluginValidateResult>("plugin_validate", {
    pathOrName: raw ? raw : null,
  });
}

// ── Official Grok Build account ─────────────────────────────────────────────

export interface AccountProfile {
  signedIn: boolean;
  authMode: string | null;
  email: string | null;
  displayName: string | null;
  userId: string | null;
  teamId: string | null;
  principalType: string | null;
  expiresAt: string | null;
  expired: boolean;
  hasRefresh: boolean;
  oidcIssuer: string | null;
}

export interface QuotaProduct {
  productId: number;
  label: string;
  usedPercent: number;
}

export interface BillingSnapshot {
  available: boolean;
  source: string;
  message: string | null;
  subscriptionTier: string | null;
  creditUsagePercent: number | null;
  remainingPercent: number | null;
  monthlyLimit: number | null;
  includedUsed: number | null;
  totalUsed: number | null;
  prepaidBalance: number | null;
  onDemandEnabled: boolean | null;
  onDemandCap: number | null;
  onDemandUsed: number | null;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  resetsAt: string | null;
  isUnifiedBillingUser: boolean | null;
  products: QuotaProduct[];
  manageUrl: string;
  subscribeUrl: string;
  fetchedAt: string | null;
}

export interface HeatmapDay {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

export interface CallLogEntry {
  id: string;
  title: string;
  model: string | null;
  projectPath: string | null;
  startedAt: string | null;
  durationSecs: number | null;
  turns: number;
  toolCalls: number;
  contextTokens: number;
  errors: number;
}

export interface AccountStatus {
  profile: AccountProfile;
  hasOfficialKey: boolean;
  hasRelayKey: boolean;
  relayBaseUrl: string | null;
  cliAuthPresent: boolean;
  cliFound: boolean;
  cliPath: string | null;
  channel: string;
  billing: BillingSnapshot;
  heatmap: HeatmapDay[];
  callLogs: CallLogEntry[];
  usageManageUrl: string;
  subscribeUrl: string;
}

export interface LoginResult {
  ok: boolean;
  method: string;
  message: string;
  deviceUrl: string | null;
  deviceCode: string | null;
  profile: AccountProfile | null;
  /** Host watchdog killed the login (auth endpoint unreachable). */
  timedOut?: boolean;
}

export async function accountStatus(opts?: {
  refreshBilling?: boolean;
  manualCliPath?: string | null;
}) {
  if (isMirrorClient()) {
    return invoke<AccountStatus>("account_status", {
      refreshBilling: opts?.refreshBilling ?? false,
      manualCliPath: opts?.manualCliPath ?? null,
    });
  }
  if (!isTauri()) {
    return {
      profile: {
        signedIn: false,
        authMode: null,
        email: null,
        displayName: null,
        userId: null,
        teamId: null,
        principalType: null,
        expiresAt: null,
        expired: false,
        hasRefresh: false,
        oidcIssuer: null,
      },
      hasOfficialKey: false,
      hasRelayKey: false,
      relayBaseUrl: null,
      cliAuthPresent: false,
      cliFound: false,
      cliPath: null,
      channel: "none",
      billing: {
        available: false,
        source: "browser",
        message: "Account requires Tauri desktop runtime",
        subscriptionTier: null,
        creditUsagePercent: null,
        remainingPercent: null,
        monthlyLimit: null,
        includedUsed: null,
        totalUsed: null,
        prepaidBalance: null,
        onDemandEnabled: null,
        onDemandCap: null,
        onDemandUsed: null,
        billingPeriodStart: null,
        billingPeriodEnd: null,
        resetsAt: null,
        isUnifiedBillingUser: null,
        products: [],
        manageUrl: "https://grok.com/?_s=usage",
        subscribeUrl: "https://grok.com/supergrok?referrer=grok-build",
        fetchedAt: null,
      },
      heatmap: [],
      callLogs: [],
      usageManageUrl: "https://grok.com/?_s=usage",
      subscribeUrl: "https://grok.com/supergrok?referrer=grok-build",
    } satisfies AccountStatus;
  }
  return invoke<AccountStatus>("account_status", {
    refreshBilling: opts?.refreshBilling ?? true,
    manualCliPath: opts?.manualCliPath ?? null,
  });
}

export async function accountLogin(method: "oauth" | "device" = "oauth") {
  return invoke<LoginResult>("account_login", { method });
}

/** Abort a running `grok login` (OAuth / device-code). No-op if none is running. */
export async function accountLoginCancel() {
  return invoke<void>("account_login_cancel");
}

export async function accountLogout() {
  return invoke<AccountProfile>("account_logout");
}

export async function accountOpenUsage() {
  if (!isTauri()) {
    window.open("https://grok.com/?_s=usage", "_blank");
    return;
  }
  return invoke<void>("account_open_usage");
}

export async function accountOpenSubscribe() {
  if (!isTauri()) {
    window.open(
      "https://grok.com/supergrok?referrer=grok-build",
      "_blank",
    );
    return;
  }
  return invoke<void>("account_open_subscribe");
}

// ── Multi-account switcher ──────────────────────────────────────────────────

export interface SavedAccount {
  id: string;
  email?: string | null;
  displayName?: string | null;
  label: string;
  updatedAt: string;
}

export interface AccountsListResult {
  profiles: SavedAccount[];
  activeId?: string | null;
}

export async function accountsList() {
  return invoke<AccountsListResult>("accounts_list");
}

export async function accountSaveCurrent(label?: string | null) {
  return invoke<SavedAccount>("account_save_current", {
    label: label ?? null,
  });
}

export async function accountSwitch(id: string) {
  return invoke<AccountProfile>("account_switch", { id });
}

export async function accountRemove(id: string) {
  return invoke<void>("account_remove", { id });
}

export async function accountRename(id: string, label: string) {
  return invoke<SavedAccount>("account_rename", { id, label });
}

/** Import markdown/JSON transcript as a new local session. */
export async function sessionImportTranscript(
  text: string,
  title?: string | null,
  projectId?: string | null,
) {
  return invoke<{
    id: string;
    title: string;
    projectId?: string | null;
  }>("session_import_transcript", {
    text,
    title: title ?? null,
    projectId: projectId ?? null,
  });
}

/** Native file picker → import transcript. Returns null if cancelled. */
export async function sessionImportTranscriptFile(
  title?: string | null,
  projectId?: string | null,
) {
  return invoke<{
    id: string;
    title: string;
    projectId?: string | null;
  } | null>("session_import_transcript_file", {
    title: title ?? null,
    projectId: projectId ?? null,
  });
}

/** Rebuild system-tray / menu-bar menu (Recent list + Usage). */
export async function trayRefresh() {
  if (!isTauri()) return;
  return invoke<void>("tray_refresh");
}

/**
 * Show busy session count on dock badge (macOS) or tray tooltip (elsewhere).
 * Pass `0` to clear. Fail-closed outside Tauri / on host errors.
 */
export async function traySetBusyCount(count: number) {
  if (!isTauri()) return;
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  try {
    await invoke<void>("tray_set_busy_count", { count: n });
  } catch {
    /* fail-closed */
  }
}

/**
 * Exit the desktop process immediately (after busy-quit confirm, or when none needed).
 * No-op outside Tauri / mirror clients.
 */
export async function appForceQuit() {
  if (!isDesktopHost()) return;
  try {
    await invoke<void>("app_force_quit");
  } catch {
    /* ignore — process may already be exiting */
  }
}

/**
 * Open (or focus) a secondary webview window for a chat (`#/session/<id>`).
 * Desktop Tauri only. Secondary is live-capable (send/stop/warm-connect via
 * the shared Host session-keyed agent pool).
 */
export async function openSessionWindow(
  sessionId: string,
  title?: string | null,
): Promise<void> {
  if (!isDesktopHost()) {
    throw new Error("openSessionWindow requires desktop Tauri");
  }
  await invoke<void>("open_session_window", {
    sessionId,
    title: title ?? null,
  });
}

/**
 * Focus (and show/unminimize) the primary workbench window.
 * Desktop Tauri only — used from secondary session windows.
 */
export async function focusMainWindow(): Promise<void> {
  if (!isDesktopHost()) {
    throw new Error("focusMainWindow requires desktop Tauri");
  }
  await invoke<void>("focus_main_window");
}

// ── Custom providers (agent-home config.toml) ───────────────────────────────

export interface ProviderModelEntry {
  /** Upstream request body model id. */
  id: string;
  /** Composer chip / menu display label. */
  name: string;
}

export interface ProviderEffortEntry {
  /** Value for `--reasoning-effort` / upstream `reasoning_effort`. */
  id: string;
  /** Composer display label (optional; falls back to id). */
  name?: string;
  isDefault?: boolean;
}

export interface CustomProvider {
  id: string;
  model: string;
  baseUrl: string;
  name: string;
  hasApiKey: boolean;
  apiBackend: string;
  isDefault: boolean;
  /** Selectable models for this channel (App-managed catalog). */
  models?: ProviderModelEntry[];
  /** Reasoning efforts for this channel (App-managed). Empty → Grok 3-tier fallback. */
  efforts?: ProviderEffortEntry[];
}

export interface ProvidersListResult {
  providers: CustomProvider[];
  defaultModel: string | null;
  /** `official` | `custom` */
  activeSource: string;
  activeProviderId: string | null;
  configPath: string;
  agentHome: string;
}

export async function providersList() {
  return invoke<ProvidersListResult>("providers_list");
}

/** CC Switch Grok Build provider preview (no full API key). */
export interface CcSwitchProviderPreview {
  sourceId: string;
  name: string;
  websiteUrl?: string | null;
  category?: string | null;
  isCurrent: boolean;
  suggestedId: string;
  model: string;
  baseUrl: string;
  apiBackend: string;
  hasApiKey: boolean;
  keyHint?: string | null;
  /** importable | official | missing_key | proxy_managed | invalid | exists */
  status: string;
  statusDetail?: string | null;
}

export interface CcSwitchScanResult {
  status: "ok" | "not_found" | "error" | string;
  dbPath?: string | null;
  triedPaths: string[];
  items: CcSwitchProviderPreview[];
  error?: string | null;
}

export interface CcSwitchImportResult {
  imported: number;
  skipped: number;
  failed: Array<{ sourceId: string; reason: string }>;
  providers?: ProvidersListResult | null;
}

/** Read-only scan of local CC Switch `cc-switch.db` (Grok Build tab). */
export async function providersCcSwitchScan() {
  return invoke<CcSwitchScanResult>("providers_cc_switch_scan");
}

/** Import selected CC Switch providers into agent-home config.toml. */
export async function providersCcSwitchImport(body: {
  sourceIds: string[];
  /** Default overwrite — same id updates key/base_url. */
  onConflict?: "skip" | "overwrite" | "rename";
  activateId?: string | null;
}) {
  return invoke<CcSwitchImportResult>("providers_cc_switch_import", {
    body: {
      sourceIds: body.sourceIds,
      onConflict: body.onConflict ?? "overwrite",
      activateId: body.activateId ?? null,
    },
  });
}

/** Switch to official Grok Build or a custom provider (writes config.toml default). */
export async function providersActivate(
  source: "official" | "custom",
  providerId?: string | null,
) {
  return invoke<ProvidersListResult>("providers_activate", {
    source,
    providerId: providerId ?? null,
  });
}

export async function providersUpsert(body: {
  id: string;
  model: string;
  baseUrl: string;
  name?: string;
  apiKey?: string;
  apiBackend?: string;
  setAsDefault?: boolean;
  createOnly?: boolean;
  models?: ProviderModelEntry[];
  efforts?: ProviderEffortEntry[];
}) {
  return invoke<ProvidersListResult>("providers_upsert", {
    id: body.id,
    model: body.model,
    baseUrl: body.baseUrl,
    name: body.name ?? null,
    apiKey: body.apiKey ?? null,
    apiBackend: body.apiBackend ?? null,
    setAsDefault: body.setAsDefault ?? null,
    createOnly: body.createOnly ?? null,
    models: body.models ?? null,
    efforts: body.efforts ?? null,
  });
}

export async function providersRemove(id: string) {
  return invoke<ProvidersListResult>("providers_remove", { id });
}

export async function providersSetDefault(modelId: string) {
  return invoke<ProvidersListResult>("providers_set_default", { modelId });
}

export async function providersPing(opts?: {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
}) {
  return invoke<{
    ok: boolean;
    latencyMs: number;
    endpoint: string;
    status?: number;
    error?: string;
  }>("providers_ping", {
    baseUrl: opts?.baseUrl ?? null,
    apiKey: opts?.apiKey ?? null,
    providerId: opts?.providerId ?? null,
  });
}

export async function providersListModels(opts: {
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
}) {
  return invoke<{
    endpoint: string;
    models: Array<{ id: string; ownedBy?: string }>;
  }>("providers_list_models", {
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey ?? null,
    providerId: opts.providerId ?? null,
  });
}

// ── Editors ─────────────────────────────────────────────────────────────────

export interface DetectedEditor {
  id: string;
  label: string;
  command: string;
  available: boolean;
  /** `data:image/png;base64,...` from host-extracted app icon when available. */
  iconDataUrl?: string | null;
}

export interface EditorsListResult {
  editors: DetectedEditor[];
  finderIcon?: string | null;
  systemIcon?: string | null;
  /** Host scan timestamp (ms), when present. */
  scannedAt?: number | null;
}

export async function editorsList() {
  return invoke<EditorsListResult>("editors_list");
}

export async function openInEditor(opts: {
  path: string;
  line?: number;
  editor?: string;
}) {
  return invoke<void>("open_in_editor", {
    path: opts.path,
    line: opts.line ?? null,
    editor: opts.editor ?? null,
  });
}

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (isMirrorClient()) {
    await mirrorEnsureTransport();
    return mirrorListen<T>(event, handler);
  }
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<T>(event, (e) => handler(e.payload));
  return un;
}

// ── Remote mirror host (desktop only — DESIGN §4.2 / §11) ───────────────────

export type MirrorPhase =
  | "stopped"
  | "starting"
  | "local"
  | "waiting_tunnel"
  | "live"
  | "tunnel_dead"
  | "error";

export type MirrorStatus = {
  running: boolean;
  publicUrl: string | null;
  localPort: number | null;
  /**
   * Full token while host is running (QR / copy). Memory-only —
   * never persist to localStorage, audit logs, or support bundles.
   */
  token: string | null;
  /** Last 6 chars of token for safe display. */
  tokenTail?: string | null;
  clients: number;
  /** Concurrent WebSocket client cap (1–16, default 4). */
  maxClients?: number;
  phase: MirrorPhase;
  error: string | null;
  /** When true, phone cannot send / resolve permissions. Default true. */
  readOnly?: boolean;
};

/** Desktop host status for Connect panel. Not available on phone mirror. */
export async function mirrorStatus(): Promise<MirrorStatus> {
  if (!isDesktopHost()) {
    return {
      running: false,
      publicUrl: null,
      localPort: null,
      token: null,
      tokenTail: null,
      clients: 0,
      maxClients: 4,
      phase: "stopped",
      error: null,
      readOnly: true,
    };
  }
  return invoke<MirrorStatus>("mirror_status");
}

export async function mirrorStart(): Promise<MirrorStatus> {
  if (!isDesktopHost()) {
    throw new Error("mirror host requires desktop app");
  }
  return invoke<MirrorStatus>("mirror_start");
}

export async function mirrorStop(): Promise<MirrorStatus> {
  if (!isDesktopHost()) {
    throw new Error("mirror host requires desktop app");
  }
  return invoke<MirrorStatus>("mirror_stop");
}

export async function mirrorRotateToken(): Promise<MirrorStatus> {
  if (!isDesktopHost()) {
    throw new Error("mirror host requires desktop app");
  }
  return invoke<MirrorStatus>("mirror_rotate_token");
}

export async function mirrorSetReadOnly(readOnly: boolean): Promise<MirrorStatus> {
  if (!isDesktopHost()) {
    throw new Error("mirror host requires desktop app");
  }
  return invoke<MirrorStatus>("mirror_set_read_only", { readOnly });
}

/** Cap concurrent phone WebSocket clients (1–16). Host-only; no secrets. */
export async function mirrorSetMaxClients(
  maxClients: number,
): Promise<MirrorStatus> {
  if (!isDesktopHost()) {
    throw new Error("mirror host requires desktop app");
  }
  return invoke<MirrorStatus>("mirror_set_max_clients", { maxClients });
}

// ── Automations (scheduled tasks) ───────────────────────────────────────────

export interface AutomationDto {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  projectId: string | null;
  modelId: string | null;
  effort: string | null;
  frequency: string;
  time: string;
  weekdays: number[];
  notify: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
}

export interface AutomationInputDto {
  title: string;
  prompt: string;
  enabled?: boolean;
  projectId?: string | null;
  modelId?: string | null;
  effort?: string | null;
  frequency?: string;
  time?: string;
  weekdays?: number[];
  notify?: string;
  nextRunAt?: string | null;
}

export async function automationsList(): Promise<AutomationDto[]> {
  if (!isTauri()) {
    const { loadAutomationsLocal } = await import("./automations");
    return loadAutomationsLocal() as AutomationDto[];
  }
  return invoke<AutomationDto[]>("automations_list");
}

export interface AutomationRunnerStatusDto {
  running: boolean;
  lastTickAt?: string | null;
  tickIntervalSecs: number;
  windowRequired: boolean;
  processRequired: boolean;
  enabledCount: number;
  keepTrayForSchedules: boolean;
  /** True when process launched with `--fire-due-schedules` (one-shot). */
  oneshotMode?: boolean;
  honesty: string;
}

export async function automationRunnerStatus(): Promise<AutomationRunnerStatusDto> {
  if (!isTauri()) {
    return {
      running: false,
      lastTickAt: null,
      tickIntervalSecs: 30,
      windowRequired: false,
      processRequired: true,
      enabledCount: 0,
      keepTrayForSchedules: true,
      oneshotMode: false,
      honesty:
        "Schedules tick only while this app process is alive (main window or tray). There is no separate background daemon. Optional one-shot: --fire-due-schedules fires at most one due task then exits.",
    };
  }
  return invoke<AutomationRunnerStatusDto>("automation_runner_status");
}

export interface SchedulesLaunchAgentStatusDto {
  supported: boolean;
  enabled: boolean;
  helperDir?: string | null;
  installedPlist?: string | null;
  installed: boolean;
  appPath?: string | null;
  honesty: string;
}

export async function schedulesLaunchAgentStatus(): Promise<SchedulesLaunchAgentStatusDto> {
  if (!isTauri()) {
    return {
      supported: false,
      enabled: false,
      installed: false,
      honesty:
        "Not a headless daemon. The LaunchAgent only starts the full Grok App.",
    };
  }
  return invoke<SchedulesLaunchAgentStatusDto>("schedules_launch_agent_status");
}

export async function schedulesLaunchAgentSetEnabled(
  enabled: boolean,
): Promise<SchedulesLaunchAgentStatusDto> {
  if (!isTauri()) {
    return schedulesLaunchAgentStatus();
  }
  return invoke<SchedulesLaunchAgentStatusDto>(
    "schedules_launch_agent_set_enabled",
    { enabled },
  );
}

export async function schedulesLaunchAgentRevealHelper(): Promise<string> {
  if (!isTauri()) {
    throw new Error("Desktop only");
  }
  return invoke<string>("schedules_launch_agent_reveal_helper");
}

export async function automationCreate(
  input: AutomationInputDto,
): Promise<AutomationDto> {
  if (!isTauri()) {
    const mod = await import("./automations");
    const list = mod.loadAutomationsLocal();
    const now = new Date().toISOString();
    const draft = {
      id: crypto.randomUUID(),
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      enabled: input.enabled ?? true,
      projectId: input.projectId ?? null,
      modelId: input.modelId ?? null,
      effort: input.effort ?? null,
      frequency: input.frequency ?? "daily",
      time: input.time ?? "09:00",
      weekdays: input.weekdays ?? [],
      notify: input.notify ?? "all",
      createdAt: now,
      updatedAt: now,
      lastRunAt: null as string | null,
      nextRunAt:
        input.nextRunAt ??
        mod.computeNextRunAt({
          frequency: input.frequency ?? "daily",
          time: input.time ?? "09:00",
          weekdays: input.weekdays ?? [],
          enabled: input.enabled ?? true,
        }),
    };
    list.unshift(draft);
    mod.saveAutomationsLocal(list);
    return draft as AutomationDto;
  }
  return invoke<AutomationDto>("automation_create", { input });
}

export async function automationUpdate(
  id: string,
  input: AutomationInputDto,
): Promise<AutomationDto> {
  if (!isTauri()) {
    const {
      loadAutomationsLocal,
      saveAutomationsLocal,
      computeNextRunAt,
    } = await import("./automations");
    const list = loadAutomationsLocal();
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error("automation not found");
    const prev = list[idx];
    const next = {
      ...prev,
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      enabled: input.enabled ?? prev.enabled,
      projectId: input.projectId !== undefined ? input.projectId : prev.projectId,
      modelId: input.modelId !== undefined ? input.modelId : prev.modelId,
      effort: input.effort !== undefined ? input.effort : prev.effort,
      frequency: input.frequency ?? prev.frequency,
      time: input.time ?? prev.time,
      weekdays: input.weekdays ?? prev.weekdays,
      notify: input.notify ?? prev.notify,
      updatedAt: new Date().toISOString(),
      nextRunAt:
        input.nextRunAt !== undefined
          ? input.nextRunAt
          : computeNextRunAt({
              frequency: input.frequency ?? prev.frequency,
              time: input.time ?? prev.time,
              weekdays: input.weekdays ?? prev.weekdays,
              enabled: input.enabled ?? prev.enabled,
            }),
    };
    list[idx] = next;
    saveAutomationsLocal(list);
    return next as AutomationDto;
  }
  return invoke<AutomationDto>("automation_update", { id, input });
}

export async function automationSetEnabled(
  id: string,
  enabled: boolean,
): Promise<AutomationDto> {
  if (!isTauri()) {
    const { loadAutomationsLocal, saveAutomationsLocal, computeNextRunAt } =
      await import("./automations");
    const list = loadAutomationsLocal();
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error("automation not found");
    const prev = list[idx];
    const next = {
      ...prev,
      enabled,
      updatedAt: new Date().toISOString(),
      nextRunAt: enabled
        ? computeNextRunAt({ ...prev, enabled: true })
        : null,
    };
    list[idx] = next;
    saveAutomationsLocal(list);
    return next as AutomationDto;
  }
  return invoke<AutomationDto>("automation_set_enabled", { id, enabled });
}

export async function automationMarkRun(
  id: string,
  lastRunAt: string,
  nextRunAt: string | null,
): Promise<AutomationDto> {
  if (!isTauri()) {
    const { loadAutomationsLocal, saveAutomationsLocal } =
      await import("./automations");
    const list = loadAutomationsLocal();
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error("automation not found");
    const next = {
      ...list[idx],
      lastRunAt,
      nextRunAt,
      updatedAt: new Date().toISOString(),
    };
    list[idx] = next;
    saveAutomationsLocal(list);
    return next as AutomationDto;
  }
  return invoke<AutomationDto>("automation_mark_run", {
    id,
    lastRunAt,
    nextRunAt,
  });
}

export async function automationDelete(id: string): Promise<void> {
  if (!isTauri()) {
    const { loadAutomationsLocal, saveAutomationsLocal } =
      await import("./automations");
    const list = loadAutomationsLocal().filter((a) => a.id !== id);
    saveAutomationsLocal(list);
    return;
  }
  return invoke<void>("automation_delete", { id });
}

export type AgentCatalogEntry = {
  name: string;
  source: string;
  description?: string | null;
  path?: string | null;
};

export type AgentsCatalogResult = {
  agents: AgentCatalogEntry[];
};

export async function agentsCatalog(projectPath?: string | null) {
  return invoke<AgentsCatalogResult>("agents_catalog", {
    projectPath: projectPath ?? null,
  });
}

/** Agent definition row from host `agents_list` (filesystem discovery). */
export type AgentDefDto = {
  name: string;
  path: string;
  /** "project" | "user" | "bundled" */
  scope: string;
  description?: string | null;
};

export type PersonaDefDto = {
  name: string;
  path: string;
  scope: string;
};

export type AgentsListResult = {
  agents: AgentDefDto[];
  personas: PersonaDefDto[];
  userAgentsDir?: string;
  projectAgentsDir?: string | null;
  bundledAgentsDir?: string;
  userPersonasDir?: string;
  projectPersonasDir?: string | null;
  bundledPersonasDir?: string;
};

/** List agent + persona definition files (no CLI required). */
export async function agentsList(projectPath?: string | null) {
  return invoke<AgentsListResult>("agents_list", {
    projectPath: projectPath ?? null,
  });
}

/** Discovered workflow script row from host `workflows_list`. */
export type WorkflowDefDto = {
  name: string;
  path: string;
  scope: string;
};

export type WorkflowsListResult = {
  workflows: WorkflowDefDto[];
  userDir?: string;
  projectDir?: string | null;
  agentHomeDir?: string | null;
  /** Bundled create-workflow skill path (may be missing on disk). */
  createWorkflowSkill?: string;
};

/**
 * Read-only soft-fail discovery of Grok Build workflow `.rhai` files.
 * No CLI required; missing dirs return an empty list.
 */
export async function workflowsList(projectPath?: string | null) {
  return invoke<WorkflowsListResult>("workflows_list", {
    projectPath: projectPath ?? null,
  });
}

/** Soft-fail headless workflow invoke result from host `workflows_run`. */
export type WorkflowRunResultDto = {
  ok: boolean;
  reason: string;
  workflowName: string;
  mode: string;
  log?: string | null;
  truncated?: boolean;
  durationMs?: number;
  cliPath?: string | null;
  cliVersion?: string | null;
  /** Always `headless_workflow_tool` — no top-level `grok workflow` subcommand. */
  invokePath?: string;
};

/**
 * Soft-fail headless run of a registered workflow by name.
 *
 * Host spawns short `grok -p` that must call the agent `workflow` tool
 * (no CLI `workflow` subcommand). Default mode `validate` = validate_only smoke.
 */
export async function workflowsRun(opts: {
  name: string;
  projectPath?: string | null;
  mode?: "validate" | "launch" | string | null;
  timeoutMs?: number | null;
}) {
  return invoke<WorkflowRunResultDto>("workflows_run", {
    name: opts.name,
    projectPath: opts.projectPath ?? null,
    mode: opts.mode ?? "validate",
    timeoutMs: opts.timeoutMs ?? null,
  });
}

export type AgentsScaffoldResult = {
  name: string;
  path: string;
  scope: string;
  created: boolean;
  overwritten: boolean;
};

/**
 * Create `{name}.md` under user GROK_HOME agents or project `.grok/agents`.
 * Rejects overwrite unless `force` is true.
 */
export async function agentsScaffold(opts: {
  name: string;
  scope?: "user" | "project" | string;
  projectPath?: string | null;
  force?: boolean;
  description?: string | null;
}) {
  return invoke<AgentsScaffoldResult>("agents_scaffold", {
    name: opts.name,
    scope: opts.scope ?? "user",
    projectPath: opts.projectPath ?? null,
    force: opts.force ?? false,
    description: opts.description ?? null,
  });
}

export type GitWorktreeGcResult = {
  dryRun?: boolean;
  force?: boolean;
  pruned?: number;
  /** Alias used by some UI call sites. */
  prunedCount?: number;
  /** Preview list of prunable worktree paths (when dry-run). */
  prunable?: any;
  stdout?: string;
  stderr?: string;
  output?: string;
};

export async function gitWorktreeGc(
  projectPathOrOpts:
    | string
    | {
        projectPath: string;
        dryRun?: boolean;
        force?: boolean;
        expire?: string | null;
      },
  forceArg?: boolean,
  dryRunArg?: boolean,
): Promise<GitWorktreeGcResult> {
  const opts =
    typeof projectPathOrOpts === "string"
      ? {
          projectPath: projectPathOrOpts,
          force: forceArg ?? false,
          dryRun: dryRunArg ?? false,
          expire: null as string | null,
        }
      : projectPathOrOpts;
  return invoke<GitWorktreeGcResult>("git_worktree_gc", {
    projectPath: opts.projectPath,
    dryRun: opts.dryRun ?? false,
    force: opts.force ?? false,
    expire: opts.expire ?? null,
  });
}

export type GitWorktreeRemoveResult = {
  path: string;
  force: boolean;
};

export async function gitWorktreeRemove(opts: {
  projectPath: string;
  worktreePath: string;
  force?: boolean;
}): Promise<GitWorktreeRemoveResult> {
  return invoke<GitWorktreeRemoveResult>("git_worktree_remove", {
    projectPath: opts.projectPath,
    worktreePath: opts.worktreePath,
    force: opts.force ?? false,
  });
}

/** Soft-fail result of `git push -u origin HEAD` (worktree ship flow). */
export type GitPushBranchResult = {
  available: boolean;
  ok: boolean;
  branch?: string | null;
  remote?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  reason?: string | null;
};

/**
 * Push the current HEAD branch to origin for a project path.
 * Soft-fails when git / origin / non-repo are missing (`available: false`).
 */
export async function gitPushBranch(
  projectPath: string,
): Promise<GitPushBranchResult> {
  return invoke<GitPushBranchResult>("git_push_branch", { projectPath });
}

/** Soft-fail result of `gh pr create` (worktree ship flow). */
export type GhPrCreateResult = {
  available: boolean;
  ok: boolean;
  url?: string | null;
  repo?: string | null;
  base?: string | null;
  head?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  reason?: string | null;
};

/**
 * Create a GitHub PR via `gh pr create` (argv only). Soft-fails without `gh`.
 * Never reports success without a PR URL.
 */
export async function ghPrCreate(opts: {
  projectPath: string;
  title: string;
  body?: string | null;
  draft?: boolean;
  base?: string | null;
  head?: string | null;
  repo?: string | null;
}): Promise<GhPrCreateResult> {
  return invoke<GhPrCreateResult>("gh_pr_create", {
    projectPath: opts.projectPath,
    title: opts.title,
    body: opts.body ?? null,
    draft: opts.draft ?? false,
    base: opts.base ?? null,
    head: opts.head ?? null,
    repo: opts.repo ?? null,
  });
}

/** Persist last active chat without full settings_set side-effects. */
export async function settingsRememberLastSession(
  sessionId?: string | null,
  projectId?: string | null,
) {
  return invoke<void>("settings_remember_last_session", {
    sessionId: sessionId ?? null,
    projectId: projectId ?? null,
  });
}

export async function memoryClear(opts?: {
  cwd?: string | null;
  scope?: "workspace" | "global" | "all";
}) {
  return invoke<{
    ok: boolean;
    stdout: string;
    stderr: string;
    cwd: string;
  }>("memory_clear", {
    cwd: opts?.cwd ?? null,
    scope: opts?.scope ?? "workspace",
  });
}

/** On-disk Grok Build memory artifact under `{GROK_HOME}/memory`. */
export type MemoryFileEntry = {
  path: string;
  name: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  preview: string;
  /** global | workspace | session | index | other */
  kind: string;
  workspaceSlug?: string | null;
  matched: boolean;
};

export type MemoryListResult = {
  entries: MemoryFileEntry[];
  memoryRoot: string;
  memoryRootExists: boolean;
  grokHome: string;
  cwd?: string | null;
  workspaceSlugs: string[];
};

/** List workspace (+ global) memory files for a project cwd. */
export async function memoryList(opts?: { cwd?: string | null }) {
  return invoke<MemoryListResult>("memory_list", {
    cwd: opts?.cwd ?? null,
  });
}

/** Delete a single memory file (host enforces path under memory root). */
export async function memoryDeleteFile(path: string) {
  return invoke<{ ok: boolean; path: string }>("memory_delete_file", {
    path,
  });
}

/** Redacted agent `config.toml` for the active session data mode. */
export type AgentConfigTomlReadResult = {
  path: string;
  exists: boolean;
  /** independent | shared */
  mode: string;
  grokHome: string;
  /** Secrets redacted by host. */
  text: string;
  /** `[table]` headers in document order. */
  sections: string[];
  truncated: boolean;
};

/** Read agent config.toml (path + redacted text). View-only. */
export async function agentConfigTomlRead() {
  return invoke<AgentConfigTomlReadResult>("agent_config_toml_read");
}

/** Content/name hit under `{GROK_HOME}/memory` (host-capped, redacted snippet). */
export type MemorySearchHit = {
  path: string;
  name: string;
  relativePath: string;
  kind: string;
  workspaceSlug?: string | null;
  size: number;
  mtimeMs: number;
  /** Redacted excerpt; empty for name-only matches. */
  snippet: string;
  contentMatch: boolean;
  matched: boolean;
};

export type MemorySearchResult = {
  hits: MemorySearchHit[];
  memoryRoot: string;
  memoryRootExists: boolean;
  grokHome: string;
  cwd?: string | null;
  query: string;
  limit: number;
  truncated: boolean;
  /**
   * App search path honesty: `keyword` | `hybrid_unavailable` | `hybrid`.
   * Always keyword-family today (no host-invocable hybrid CLI as of 0.2.117).
   * Soft-fail missing → treat as keyword.
   */
  searchKind?: string;
};

/**
 * Search path-scoped memory files (name + body) under agent GROK_HOME/memory.
 * Host enforces read/hit caps and redacts snippets.
 * Always keyword / file-body scan — never invents embeddings client-side.
 * When embedding.model is set but no host hybrid CLI exists, `searchKind` is
 * `hybrid_unavailable`. Agent-tool hybrid is configured via memoryEmbedConfig*.
 */
export async function memorySearch(opts: {
  query: string;
  cwd?: string | null;
  limit?: number;
}) {
  return invoke<MemorySearchResult>("memory_search", {
    query: opts.query,
    cwd: opts.cwd ?? null,
    limit: opts.limit ?? null,
  });
}

/**
 * Memory embedding config — allowlisted Grok Build 0.2.117 `[memory.*]` keys
 * from active GROK_HOME config.toml. Missing keys are null (soft-fail).
 * Writes only in independent agent-home mode.
 */
export type MemoryEmbedConfigSnapshot = {
  path: string;
  grokHome: string;
  mode: string;
  writable: boolean;
  fileExists: boolean;
  embeddingConfigured: boolean;
  /** Always `"keyword"` for App host browser search. */
  appSearchMode: string;
  /** `"hybrid"` when embedding.model set; else `"keyword"`. */
  cliSearchMode: string;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
  embeddingProvider?: string | null;
  searchMaxResults?: number | null;
  searchMinScore?: number | null;
  searchVectorWeight?: number | null;
  searchTextWeight?: number | null;
  mmrEnabled?: boolean | null;
  mmrLambda?: number | null;
  temporalDecayEnabled?: boolean | null;
  temporalDecayHalfLifeDays?: number | null;
  dreamEnabled?: boolean | null;
  dreamMinHours?: number | null;
  dreamMinSessions?: number | null;
  dreamCheckIntervalSecs?: number | null;
  watcherEnabled?: boolean | null;
  initialInjectionEnabled?: boolean | null;
  initialInjectionMinScore?: number | null;
  redactedPreview: string;
};

export type MemoryEmbedConfigPatch = {
  embeddingModel?: string | null;
  clearEmbeddingModel?: boolean | null;
  embeddingDimensions?: number | null;
  embeddingProvider?: string | null;
  searchMaxResults?: number | null;
  searchMinScore?: number | null;
  searchVectorWeight?: number | null;
  searchTextWeight?: number | null;
  mmrEnabled?: boolean | null;
  mmrLambda?: number | null;
  temporalDecayEnabled?: boolean | null;
  temporalDecayHalfLifeDays?: number | null;
  dreamEnabled?: boolean | null;
  dreamMinHours?: number | null;
  dreamMinSessions?: number | null;
  dreamCheckIntervalSecs?: number | null;
  watcherEnabled?: boolean | null;
  initialInjectionEnabled?: boolean | null;
  initialInjectionMinScore?: number | null;
};

export async function memoryEmbedConfigGet(): Promise<MemoryEmbedConfigSnapshot> {
  return invoke<MemoryEmbedConfigSnapshot>("memory_embed_config_get");
}

export async function memoryEmbedConfigSet(
  patch: MemoryEmbedConfigPatch,
): Promise<MemoryEmbedConfigSnapshot> {
  // Tauri maps camelCase invoke keys → snake_case command args.
  return invoke<MemoryEmbedConfigSnapshot>("memory_embed_config_set", {
    embeddingModel: patch.embeddingModel ?? null,
    clearEmbeddingModel: patch.clearEmbeddingModel ?? null,
    embeddingDimensions: patch.embeddingDimensions ?? null,
    embeddingProvider: patch.embeddingProvider ?? null,
    searchMaxResults: patch.searchMaxResults ?? null,
    searchMinScore: patch.searchMinScore ?? null,
    searchVectorWeight: patch.searchVectorWeight ?? null,
    searchTextWeight: patch.searchTextWeight ?? null,
    mmrEnabled: patch.mmrEnabled ?? null,
    mmrLambda: patch.mmrLambda ?? null,
    temporalDecayEnabled: patch.temporalDecayEnabled ?? null,
    temporalDecayHalfLifeDays: patch.temporalDecayHalfLifeDays ?? null,
    dreamEnabled: patch.dreamEnabled ?? null,
    dreamMinHours: patch.dreamMinHours ?? null,
    dreamMinSessions: patch.dreamMinSessions ?? null,
    dreamCheckIntervalSecs: patch.dreamCheckIntervalSecs ?? null,
    watcherEnabled: patch.watcherEnabled ?? null,
    initialInjectionEnabled: patch.initialInjectionEnabled ?? null,
    initialInjectionMinScore: patch.initialInjectionMinScore ?? null,
  });
}

export type HookDto = {
  name: string;
  path: string;
  scope: string;
  kind: string;
  ext?: string;
  size: number;
  mtimeMs: number;
};

export type HooksListResult = {
  hooks: HookDto[];
  userDir: string;
  userDirExists: boolean;
  projectDir?: string | null;
  projectDirExists?: boolean | null;
  docsPath?: string | null;
};

export async function hooksList(projectPath?: string | null) {
  return invoke<HooksListResult>("hooks_list", {
    projectPath: projectPath ?? null,
  });
}

export async function hooksReveal(path: string) {
  return invoke<void>("hooks_reveal", { path });
}

export async function hooksOpenDir(opts?: {
  scope?: "user" | "project" | string;
  projectPath?: string | null;
  create?: boolean;
}) {
  return invoke<{ path: string; scope: string }>("hooks_open_dir", {
    scope: opts?.scope ?? "user",
    projectPath: opts?.projectPath ?? null,
    create: opts?.create ?? false,
  });
}

export async function hooksEnsureDir(opts?: {
  scope?: "user" | "project" | string;
  projectPath?: string | null;
}) {
  return invoke<{ path: string }>("hooks_ensure_dir", {
    scope: opts?.scope ?? "user",
    projectPath: opts?.projectPath ?? null,
  });
}

/** Result of host `hooks_try_run` — real process; never invents success. */
export type HooksTryRunResult = {
  ok: boolean;
  refused: boolean;
  timedOut: boolean;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  path: string;
  scope: string;
  timeoutSecs: number;
  reason?: string | null;
  message?: string | null;
};

/**
 * Real try-run of a hook script under user/project hooks dirs only.
 * Optional JSON stdin; host redacts stdout/stderr and enforces timeout.
 */
export async function hooksTryRun(opts: {
  path: string;
  projectPath?: string | null;
  stdinJson?: string | null;
  timeoutSecs?: number | null;
}) {
  return invoke<HooksTryRunResult>("hooks_try_run", {
    path: opts.path,
    projectPath: opts.projectPath ?? null,
    stdinJson: opts.stdinJson ?? null,
    timeoutSecs: opts.timeoutSecs ?? null,
  });
}


export type SetupPreviewResult = {
  ok: boolean;
  payload?: unknown;
  message?: string | null;
  error?: string | null;
  errorKind?: string | null;
};

export type SetupInstallResult = {
  ok: boolean;
  message?: string | null;
  error?: string | null;
  errorKind?: string | null;
};

/** Soft-fail local managed-config / signature artifact probe. */
export type ManagedSetupStatusResult = {
  ok: boolean;
  cliFound: boolean;
  grokHome?: string | null;
  managedConfigPresent: boolean;
  requirementsPresent: boolean;
  configSignaturePresent: boolean;
  identitySignaturePresent: boolean;
  systemManagedConfigPresent: boolean;
  managedSettingsActive?: boolean | null;
  managedSettingsExists?: boolean | null;
  managedSettingsPath?: string | null;
  /**
   * Explicit CLI/inspect/doctor signature verification when reported.
   * Null/undefined = not reported (App never invents verified).
   */
  signatureVerified?: boolean | null;
  /** `inspect` | `doctor` when verification claim is present. */
  signatureVerifySource?: string | null;
  /** True when status is path/inspect presence only (App did not crypto-verify). */
  presenceOnly?: boolean;
  reason?: string | null;
};

export async function setupPreview() {
  return invoke<SetupPreviewResult>("setup_preview");
}

export async function setupInstall() {
  return invoke<SetupInstallResult>("setup_install");
}

/** Soft-fail: local managed files + optional inspect managed-settings flags. */
export async function managedSetupStatus() {
  return invoke<ManagedSetupStatusResult>("managed_setup_status");
}

export type MarketplaceListResult = {
  sources: Array<Record<string, unknown>>;
  error?: string | null;
};

export type MarketplaceAvailableResult = {
  plugins: Array<Record<string, unknown>>;
  error?: string | null;
};

export type MarketplaceActionResult = {
  ok: boolean;
  name?: string;
  message?: string;
  removed?: string;
  error?: string;
};

export async function marketplaceList() {
  return invoke<MarketplaceListResult>("marketplace_list");
}

export async function marketplaceAvailable() {
  return invoke<MarketplaceAvailableResult>("marketplace_available");
}

export async function marketplaceAdd(source: string) {
  return invoke<MarketplaceActionResult>("marketplace_add", { source });
}

export async function marketplaceRemove(nameOrUrl: string) {
  return invoke<MarketplaceActionResult>("marketplace_remove", { nameOrUrl });
}

export async function marketplaceUpdate(name?: string | null) {
  return invoke<MarketplaceActionResult>("marketplace_update", {
    name: name ?? null,
  });
}

export type PermissionRules = {
  path?: string;
  configPath?: string;
  allow: string[];
  deny: string[];
  ask: string[];
};

export async function permissionRulesGet() {
  return invoke<PermissionRules>("permission_rules_get");
}

export async function permissionRulesSet(rules: PermissionRules) {
  return invoke<PermissionRules>("permission_rules_set", { rules });
}

/** Allowlisted agent-home config.toml section edit (independent GROK_HOME only). */
export type AgentConfigEditSnapshot = {
  path: string;
  grokHome: string;
  mode: string;
  writable: boolean;
  fileExists: boolean;
  permissionMode?: string | null;
  yolo?: boolean | null;
  subagentsEnabled?: boolean | null;
  memoryEnabled?: boolean | null;
  /** `[workflows].enabled` — background workflows / goal driver. */
  workflowsEnabled?: boolean | null;
  /** `[features].auto_wake` — wake after background tasks. */
  autoWakeEnabled?: boolean | null;
  /** `[features].two_pass_compaction` — opt-in prefire two-pass. */
  twoPassCompactionEnabled?: boolean | null;
  /** `[features].lsp_tools`. */
  lspToolsEnabled?: boolean | null;
  /** `[features].codebase_indexing`. */
  codebaseIndexing?: boolean | null;
  /** `[features].remote_fetch` — online model-catalog fetches. */
  remoteFetch?: boolean | null;
  redactedPreview: string;
};

export type AgentConfigEditPatch = {
  permissionMode?: string | null;
  yolo?: boolean | null;
  subagentsEnabled?: boolean | null;
  memoryEnabled?: boolean | null;
  workflowsEnabled?: boolean | null;
  autoWakeEnabled?: boolean | null;
  twoPassCompactionEnabled?: boolean | null;
  lspToolsEnabled?: boolean | null;
  codebaseIndexing?: boolean | null;
  remoteFetch?: boolean | null;
};

export async function agentConfigEditGet(): Promise<AgentConfigEditSnapshot> {
  return invoke<AgentConfigEditSnapshot>("agent_config_edit_get");
}

export async function agentConfigEditSet(
  patch: AgentConfigEditPatch,
): Promise<AgentConfigEditSnapshot> {
  return invoke<AgentConfigEditSnapshot>("agent_config_edit_set", {
    permissionMode: patch.permissionMode ?? null,
    yolo: patch.yolo ?? null,
    subagentsEnabled: patch.subagentsEnabled ?? null,
    memoryEnabled: patch.memoryEnabled ?? null,
    workflowsEnabled: patch.workflowsEnabled ?? null,
    autoWakeEnabled: patch.autoWakeEnabled ?? null,
    twoPassCompactionEnabled: patch.twoPassCompactionEnabled ?? null,
    lspToolsEnabled: patch.lspToolsEnabled ?? null,
    codebaseIndexing: patch.codebaseIndexing ?? null,
    remoteFetch: patch.remoteFetch ?? null,
  });
}

/**
 * Privacy center — allowlisted Grok Build 0.2.117 privacy keys from active
 * GROK_HOME config.toml. Missing keys are null (soft-fail). Writes only in
 * independent agent-home mode.
 */
export type PrivacyConfigSnapshot = {
  path: string;
  grokHome: string;
  mode: string;
  writable: boolean;
  fileExists: boolean;
  telemetry?: boolean | null;
  traceUpload?: boolean | null;
  mixpanelEnabled?: boolean | null;
  disableCodebaseUpload?: boolean | null;
  disableWorkspaceTeleport?: boolean | null;
  redactedPreview: string;
  cliPrivacyCommand: string;
};

export type PrivacyConfigPatch = {
  telemetry?: boolean | null;
  traceUpload?: boolean | null;
  mixpanelEnabled?: boolean | null;
  disableCodebaseUpload?: boolean | null;
  disableWorkspaceTeleport?: boolean | null;
};

export async function privacyConfigGet(): Promise<PrivacyConfigSnapshot> {
  return invoke<PrivacyConfigSnapshot>("privacy_config_get");
}

export async function privacyConfigSet(
  patch: PrivacyConfigPatch,
): Promise<PrivacyConfigSnapshot> {
  // Tauri maps camelCase invoke keys → snake_case command args.
  return invoke<PrivacyConfigSnapshot>("privacy_config_set", {
    telemetry: patch.telemetry ?? null,
    traceUpload: patch.traceUpload ?? null,
    mixpanelEnabled: patch.mixpanelEnabled ?? null,
    disableCodebaseUpload: patch.disableCodebaseUpload ?? null,
    disableWorkspaceTeleport: patch.disableWorkspaceTeleport ?? null,
  });
}

/**
 * Codebase indexing — `[features].codebase_indexing` (code graph, not embeddings).
 * Missing key is unset (CLI default on). Writes only in independent agent-home.
 */
export type CodebaseIndexingSnapshot = {
  path: string;
  grokHome: string;
  mode: string;
  writable: boolean;
  fileExists: boolean;
  /** `unset` | `bool` | `custom` */
  kind: string;
  enabled?: boolean | null;
  customRaw?: string | null;
  cliDefault: boolean;
  effectiveEnabled: boolean;
  redactedPreview: string;
  /** Always false — App never invents embeddings for this surface. */
  inventsEmbeddings: boolean;
};

export type CodebaseIndexingPatch = {
  enabled?: boolean | null;
};

export async function codebaseIndexingGet(): Promise<CodebaseIndexingSnapshot> {
  return invoke<CodebaseIndexingSnapshot>("codebase_indexing_get");
}

export async function codebaseIndexingSet(
  patch: CodebaseIndexingPatch,
): Promise<CodebaseIndexingSnapshot> {
  return invoke<CodebaseIndexingSnapshot>("codebase_indexing_set", {
    enabled: patch.enabled ?? null,
  });
}

export interface VoiceSessionState {
  active: boolean;
  mode?: string;
  phase?: string | null;
  sessionId?: string | null;
  projectPath?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  error?: string | null;
  delegatedSessionIds?: string[];
  mock?: boolean;
  listening?: boolean;
  speaking?: boolean;
  /** Host: model / tool turn in progress (from voice://state). */
  thinking?: boolean;
  /** Host: in-flight Build tool name while voice → agent loop runs. */
  activeTool?: string | null;
  /**
   * Host tool-loop status token:
   * tool_running | permission_pending | completed | soft_fail | error.
   */
  toolStatus?: string | null;
  /** When true (default), ending voice does not stop delegated Build agents. */
  keepAgentsOnEnd?: boolean;
}

export async function voiceState(): Promise<VoiceSessionState> {
  return invoke<VoiceSessionState>("voice_state");
}

export async function voiceStart(opts?: {
  voiceId?: string | null;
  projectPath?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  keepAgentsOnEnd?: boolean;
}): Promise<VoiceSessionState> {
  return invoke<VoiceSessionState>("voice_start", {
    voiceId: opts?.voiceId ?? null,
    projectPath: opts?.projectPath ?? null,
    projectId: opts?.projectId ?? null,
    projectName: opts?.projectName ?? null,
    keepAgentsOnEnd: opts?.keepAgentsOnEnd ?? true,
  });
}

export async function voiceStop(): Promise<VoiceSessionState> {
  return invoke<VoiceSessionState>("voice_stop");
}

export async function voicePushPcm(pcmBase64: string): Promise<void> {
  return invoke<void>("voice_push_pcm", { pcmBase64 });
}

/**
 * Invoke a Live Voice host tool (mock / debug / demo delegate).
 * Host expects `argsJson` string; objects are serialized.
 */
export async function voiceInvokeTool(
  name: string,
  args?: string | Record<string, unknown> | null,
): Promise<unknown> {
  const argsJson =
    typeof args === "string"
      ? args
      : JSON.stringify(args ?? {});
  return invoke<unknown>("voice_invoke_tool", { name, argsJson });
}


/** Headless `--output-format streaming-messages-json` probe (CLI 0.2.117+). */
export type StreamingMessagesJsonProbeResult = {
  ok: boolean;
  reason: string;
  cliPath?: string | null;
  cliVersion?: string | null;
  versionSupported?: boolean | null;
  minVersion: string;
  outputPath?: string | null;
  rawNdjson?: string | null;
  lineCount: number;
  durationMs: number;
  includePartial: boolean;
  truncated: boolean;
};

/**
 * Spawn a short headless probe with `--output-format streaming-messages-json`.
 * Soft-fails when CLI is missing or older than 0.2.117 (no crash).
 */
export async function streamingMessagesJsonProbe(opts?: {
  includePartial?: boolean;
}): Promise<StreamingMessagesJsonProbeResult> {
  return invoke<StreamingMessagesJsonProbeResult>(
    "streaming_messages_json_probe",
    { includePartial: opts?.includePartial ?? false },
  );
}

/** One-shot headless batch turn result (Host soft-fail DTO). */
export type BatchAgentsHeadlessResult = {
  ok: boolean;
  reason?: string | null;
  text?: string | null;
  durationMs?: number | null;
  cliPath?: string | null;
  cliVersion?: string | null;
};

/**
 * Run one headless `grok -p` turn in a project cwd for multi-project batch.
 * Soft-fails (ok=false + reason) on CLI missing / path / timeout — never throws
 * for those cases. Invoke errors still reject.
 */
export async function batchAgentsHeadless(opts: {
  projectPath: string;
  prompt: string;
  timeoutMs?: number | null;
}): Promise<BatchAgentsHeadlessResult> {
  return invoke<BatchAgentsHeadlessResult>("batch_agents_headless", {
    projectPath: opts.projectPath,
    prompt: opts.prompt,
    timeoutMs: opts.timeoutMs ?? null,
  });
}

export type VoiceStatusDto = {
  available: boolean;
  reason?: string | null;
  authSource?: string | null;
};

export type VoiceTranscribeResult = {
  ok: boolean;
  text?: string | null;
  error?: string | null;
  errorClass?: string | null;
};

export async function voiceStatus() {
  return invoke<VoiceStatusDto>("voice_status");
}

export async function voiceTranscribe(opts: {
  audioBase64: string;
  filename?: string | null;
  mime?: string | null;
}) {
  return invoke<VoiceTranscribeResult>("voice_transcribe", {
    audioBase64: opts.audioBase64,
    filename: opts.filename ?? null,
    mime: opts.mime ?? null,
  });
}

export type CliUpdateCheck = {
  ok?: boolean;
  current?: string | null;
  latest?: string | null;
  currentVersion?: string | null;
  latestVersion?: string | null;
  version?: string | null;
  /** Raw channel from CLI when known (`stable` / `alpha`); omit/null = unknown. */
  channel?: string | null;
  updateAvailable?: boolean;
  message?: string | null;
  error?: string | null;
  cliPath?: string | null;
  [key: string]: unknown;
};

export type CliUpdateInstallOpts = {
  /** Switch to `stable` or `alpha` (`grok update --stable|--alpha`). */
  channel?: string | null;
  /** Pin a specific version (`grok update --version <V>`). */
  version?: string | null;
  /** Pass `--force-reinstall`. */
  force?: boolean | null;
};

export async function cliUpdateCheck() {
  return invoke<CliUpdateCheck>("cli_update_check");
}

/**
 * Install / switch / pin CLI via host `cli_update_install`.
 * Plain call = current-channel update (App trust-chain fallback).
 * Channel/version soft-fail without inventing channels.
 */
export async function cliUpdateInstall(opts?: CliUpdateInstallOpts | null) {
  return invoke<CliUpdateCheck>("cli_update_install", {
    channel: opts?.channel ?? null,
    version: opts?.version ?? null,
    force: opts?.force ?? null,
  });
}

/** Recycle all warm agent processes (e.g. after CLI upgrade). */
export async function agentsRecycleAll() {
  return invoke<void>("agents_recycle_all");
}

/**
 * Host `mcp_doctor` report — `grok mcp doctor --json [NAME]`.
 * Shape matches `extensions::McpDoctorReport` (camelCase). Pure TS helpers
 * accept this loosely via `McpDoctorReportLike`.
 */
export type McpDoctorReport = {
  ok: boolean;
  servers?: Array<Record<string, any>>;
  sources?: Array<Record<string, any>>;
  issues?: Array<Record<string, any> | string>;
  summary?: {
    total?: number;
    healthy?: number;
    unhealthy?: number;
    [key: string]: unknown;
  };
  rawText?: string | null;
  message?: string | null;
  error?: string | null;
  [key: string]: unknown;
};

export async function mcpAdd(opts: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}) {
  return invoke<{ ok: boolean; error?: string }>("mcp_add", opts);
}

export async function mcpRemove(name: string) {
  return invoke<{ ok: boolean; error?: string }>("mcp_remove", { name });
}

/**
 * Run `grok mcp doctor --json [name]` under the active GROK_HOME.
 * Optional `name` filters to one configured server — never invents servers.
 */
export async function mcpDoctor(name?: string | null) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return invoke<McpDoctorReport>("mcp_doctor", {
    name: trimmed || null,
  });
}

export type ProjectRuleEntry = {
  path?: string;
  name?: string;
  scope?: string;
  exists?: boolean;
  relativePath?: string;
  absolutePath?: string;
  kind?: string;
  created?: boolean;
  [key: string]: unknown;
};

export type ProjectRulesListResult = {
  rules?: ProjectRuleEntry[];
  hasAgentsMd?: boolean;
  [key: string]: unknown;
};

export async function projectRulesList(projectPath: string) {
  return invoke<ProjectRulesListResult | ProjectRuleEntry[]>("project_rules_list", { projectPath });
}

export async function projectRulesEnsureTemplate(projectPath: string) {
  return invoke<ProjectRuleEntry>("project_rules_ensure_template", {
    projectPath,
  });
}

// ── Agent leader / serve (Runtime) ──────────────────────────────────────────

export type LeaderProcess = {
  pid?: number | null;
  socketPath?: string | null;
  version?: string | null;
  classification?: string | null;
  lockPath?: string | null;
  wsUrlSuffix?: string | null;
  raw?: unknown;
};

export type LeaderStatus = {
  state: "stopped" | "running" | "error" | "unsupported" | string;
  socketPath: string;
  socketExists: boolean;
  socketAgeSecs?: number | null;
  pid?: number | null;
  version?: string | null;
  classification?: string | null;
  trackedPid?: number | null;
  cliFound: boolean;
  cliSupportsLeader: boolean;
  message?: string | null;
  leaders?: LeaderProcess[];
  serveHint?: string | null;
};

/** `grok leader info --json` DTO (soft-fail: unsupported/error without throw). */
export type LeaderInfo = {
  pid?: number | null;
  socketPath?: string | null;
  lockPath?: string | null;
  version?: string | null;
  protocolVersion?: string | null;
  classification?: string | null;
  uptimeMs?: number | null;
  activeToolCalls?: number | null;
  wsUrlSuffix?: string | null;
  unsupported?: boolean;
  error?: string | null;
  raw?: unknown;
};

export async function leaderStatus(): Promise<LeaderStatus> {
  return invoke<LeaderStatus>("leader_status");
}

export async function leaderStart(): Promise<LeaderStatus> {
  return invoke<LeaderStatus>("leader_start");
}

export async function leaderStop(): Promise<LeaderStatus> {
  return invoke<LeaderStatus>("leader_stop");
}

export async function leaderList(): Promise<{
  leaders: LeaderProcess[];
  error?: string;
}> {
  return invoke("leader_list");
}

/** Details for a leader (`grok leader info --json`); optional pid from list. Soft-fails. */
export async function leaderInfo(pid?: number | null): Promise<LeaderInfo> {
  return invoke<LeaderInfo>("leader_info", {
    pid: pid == null ? null : pid,
  });
}

/** Alias for stop-all (`grok leader kill`); soft-respawns when useLeader. */
export async function leaderKillAll(): Promise<{
  ok: boolean;
  state?: string;
  message?: string | null;
}> {
  return invoke("leader_kill_all");
}

// ── Agent serve (Runtime WebSocket server) ──────────────────────────────────

export type ServeStatus = {
  state: "stopped" | "running" | "error" | "unsupported" | string;
  bind: string;
  /** Optional proxy-mode upstream URL when started with `--remote`. */
  remote?: string | null;
  /** Masked secret (`••••` + last 4); never the full token. */
  secretMasked?: string | null;
  /** Last 4 chars of secret when known. */
  secretLast4?: string | null;
  /**
   * Full connection URL with secret — only present on `serve_start` response
   * (one-time copy). Status polls omit this.
   */
  connectionUrl?: string | null;
  /**
   * Full client CLI string (`grok --remote ws://…/ws --secret …`) — only on start.
   */
  connectionCli?: string | null;
  /** Masked CLI template for status polls (secret last-4 only). */
  connectionCliMasked?: string | null;
  pid?: number | null;
  trackedPid?: number | null;
  /** Local bind TCP probe only — does not check optional `--remote` upstream. */
  portOpen: boolean;
  cliFound: boolean;
  cliSupportsServe: boolean;
  /** CLI exposes `agent serve --remote` (proxy mode). */
  cliSupportsRemote?: boolean;
  message?: string | null;
};

export async function serveStatus(): Promise<ServeStatus> {
  return invoke<ServeStatus>("serve_status");
}

/**
 * Start serve; response may include one-time `connectionUrl` / `connectionCli`.
 * Optional `remote` → `grok agent serve --remote <URL>` (proxy mode).
 */
export async function serveStart(
  bind?: string | null,
  remote?: string | null,
): Promise<ServeStatus> {
  return invoke<ServeStatus>("serve_start", {
    bind: bind ?? null,
    remote: remote ?? null,
  });
}

export async function serveStop(): Promise<ServeStatus> {
  return invoke<ServeStatus>("serve_stop");
}

/**
 * TCP-only health probe for agent serve / remote bind (`host:port`, ~2s).
 * No secrets, no WebSocket handshake. Frontend must strip secrets from pasted URLs.
 */
export type ServeTcpProbeResult = {
  ok: boolean;
  latencyMs?: number | null;
  error?: string | null;
  /** Bare host:port that was probed. */
  target: string;
};

export async function serveTcpProbe(addr: string): Promise<ServeTcpProbeResult> {
  return invoke<ServeTcpProbeResult>("serve_tcp_probe", { addr });
}

// ── Wallpaper sources (X search + Imagine) ──────────────────────────────────

export async function wallpaperXSearch(
  query: string,
  sort?: "top" | "latest",
): Promise<WallpaperSearchResult> {
  return invoke<WallpaperSearchResult>("wallpaper_x_search", {
    query,
    sort: sort ?? null,
  });
}

export async function wallpaperFetchMedia(
  url: string,
  source?: string,
): Promise<WallpaperFetchResult> {
  return invoke<WallpaperFetchResult>("wallpaper_fetch_media", {
    url,
    source: source ?? null,
  });
}

export async function wallpaperImagine(
  prompt: string,
  aspectRatio?: string,
): Promise<WallpaperSearchResult> {
  return invoke<WallpaperSearchResult>("wallpaper_imagine", {
    prompt,
    aspectRatio: aspectRatio ?? null,
  });
}

export async function wallpaperLibraryList(
  limit?: number,
): Promise<WallpaperLibraryEntry[]> {
  return invoke<WallpaperLibraryEntry[]>("wallpaper_library_list", {
    limit: limit ?? null,
  });
}

// ── X Evidence Rail (search → local evidence store → quote pack) ────────────
// Design: docs/features/x-search.md — every X search result becomes a local
// evidence row with a stable id; later turns list / re-read / quote it.

export interface XEvidenceItem {
  evidenceId: string;
  statusId?: string;
  url?: string;
  author?: string;
  text?: string;
  createdAt?: string;
  likes?: number;
  query?: string;
  sessionTag?: string;
  source: string;
  verified: boolean;
  fetchedAtMs: number;
}

export interface XSearchEnvelope {
  ok: boolean;
  errorCode?: string;
  message?: string;
  query: string;
  evidence: XEvidenceItem[];
  newCount: number;
  unverifiedCount: number;
}

export interface XEvidenceFilter {
  sessionTag?: string;
  queryContains?: string;
  author?: string;
  limit?: number;
}

export interface XQuotePack {
  markdown: string;
  path?: string;
  count: number;
}

export async function xEvidenceSearch(
  query: string,
  limit?: number,
  sessionTag?: string,
): Promise<XSearchEnvelope> {
  return invoke<XSearchEnvelope>("x_evidence_search", {
    query,
    limit: limit ?? null,
    sessionTag: sessionTag ?? null,
  });
}

export async function xEvidenceList(
  filter?: XEvidenceFilter,
): Promise<XEvidenceItem[]> {
  return invoke<XEvidenceItem[]>("x_evidence_list", {
    filter: filter ?? null,
  });
}

export async function xEvidenceGet(ids: string[]): Promise<XEvidenceItem[]> {
  return invoke<XEvidenceItem[]>("x_evidence_get", { ids });
}

export async function xQuotePack(
  ids: string[],
  title?: string,
): Promise<XQuotePack> {
  return invoke<XQuotePack>("x_quote_pack", { ids, title: title ?? null });
}

export interface XEvidenceStats {
  total: number;
  todayNew: number;
  weekPacks: number;
}

export async function xEvidenceStats(): Promise<XEvidenceStats> {
  return invoke<XEvidenceStats>("x_evidence_stats");
}
