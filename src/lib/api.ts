/** Typed Tauri invoke helpers with browser fallback. */

import type { SessionSnapshot } from "./session";
import { IDLE_SNAPSHOT } from "./session";

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`Tauri required: ${cmd}`);
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

export async function sessionGetState(): Promise<SessionSnapshot> {
  if (!isTauri()) return { ...IDLE_SNAPSHOT, backend: "browser" };
  return invoke("session_get_state");
}

export async function sessionConnect(opts?: {
  projectPath?: string;
  sessionId?: string;
  mode?: string;
}): Promise<SessionSnapshot> {
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

export async function sessionSend(text: string): Promise<SessionSnapshot> {
  return invoke("session_send", { text });
}

export async function sessionStop(): Promise<SessionSnapshot> {
  return invoke("session_stop");
}

export async function sessionDisconnect(): Promise<SessionSnapshot> {
  return invoke("session_disconnect");
}

export async function sessionReattach(): Promise<SessionSnapshot> {
  return invoke("session_reattach");
}

export async function sessionResolvePermission(args: {
  rpcId: number;
  decision: string;
  optionId?: string;
  scopeKey?: string;
}): Promise<SessionSnapshot> {
  return invoke("session_resolve_permission", {
    rpcId: args.rpcId,
    decision: args.decision,
    optionId: args.optionId ?? null,
    scopeKey: args.scopeKey ?? null,
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
  }>("probe_cli", { manualPath: manualPath ?? null });
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
    }>
  >("projects_list");
}

export async function projectAdd(path: string, trust: boolean) {
  return invoke("project_add", { path, trust });
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
  size: number;
  kind: string;
  mime: string;
  text: string | null;
  base64: string | null;
  truncated: boolean;
  error: string | null;
}

/** List directory under a trusted project root (relative path, "" = root). */
export async function fsListDir(projectPath: string, relative = "") {
  return invoke<FsEntry[]>("fs_list_dir", {
    projectPath,
    relative: relative || null,
  });
}

/** Read file under project root for preview (text or base64). */
export async function fsReadFile(projectPath: string, relative: string) {
  return invoke<FsReadResult>("fs_read_file", {
    projectPath,
    relative,
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

export async function projectTrust(id: string) {
  return invoke("project_trust", { id });
}

/** Remove project from app list only (no disk / session wipe). */
export async function projectRemove(id: string) {
  return invoke("project_remove", { id });
}

export async function projectRename(id: string, name: string) {
  return invoke("project_rename", { id, name });
}

export async function projectSetPinned(id: string, pinned: boolean) {
  return invoke("project_set_pinned", { id, pinned });
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
      archived?: boolean;
    }>
  >("sessions_list");
}

export async function sessionCreate(projectId?: string, title?: string) {
  return invoke("session_create", {
    projectId: projectId ?? null,
    title: title ?? null,
  });
}

export async function sessionRename(id: string, title: string) {
  return invoke("session_rename", { id, title });
}

export async function sessionSetArchived(id: string, archived: boolean) {
  return invoke("session_set_archived", { id, archived });
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
    }>
  >("session_messages", { id });
}

export async function settingsGet() {
  return invoke<{
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
  }>("settings_get");
}

export async function settingsSet(settings: Record<string, unknown>) {
  return invoke("settings_set", { settings });
}

/** Update live Host permission policy + persist (mid-session chip). */
export async function sessionSetPolicy(policy: string) {
  if (!isTauri()) return;
  return invoke("session_set_policy", { policy });
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

export async function doctorReport() {
  return invoke<Record<string, unknown>>("doctor_report");
}

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<T>(event, (e) => handler(e.payload));
  return un;
}
