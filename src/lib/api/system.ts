/** API domain: system */

import {
  invoke,
  isTauri,
  isDesktopHost,
} from "./host";

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
  /** Streamed SHA-256 when Host computed it. */
  sha256?: string | null;
  /**
   * `true` = published sidecar matched; `false` = installed without sidecar
   * (HTTPS allowlist + binary probe). Mismatch never returns ok.
   */
  checksumVerified?: boolean | null;
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

