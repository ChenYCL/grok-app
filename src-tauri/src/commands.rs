//! Tauri commands — Host facade.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cli_probe::{self, CliProbeResult};
use crate::session_manager::{SessionManager, SessionSnapshot};
use crate::store::{self, AppSettings, Project, SessionMeta};

fn windows_grok_go_config_candidates() -> Option<Vec<String>> {
    #[cfg(target_os = "windows")]
    {
        let mut out = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            out.push(format!(r"{appdata}\com.grokgo.desktop\config.json"));
            out.push(format!(r"{appdata}\GrokGo\config.json"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            out.push(format!(r"{local}\com.grokgo.desktop\config.json"));
            out.push(format!(r"{local}\GrokGo\config.json"));
        }
        return if out.is_empty() { None } else { Some(out) };
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[tauri::command]
pub async fn session_get_state(
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<SessionSnapshot, String> {
    Ok(mgr.snapshot())
}

#[tauri::command]
pub async fn session_connect(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    project_path: Option<String>,
    session_id: Option<String>,
    mode: Option<String>,
) -> Result<SessionSnapshot, String> {
    mgr.connect(app, project_path, session_id, mode).await
}

/// Send a turn. `text` goes to the agent; optional `display_text` is stored in the journal
/// (skill chips as `[[skill:name]]`) so history can re-render tags.
///
/// `session_id` binds the turn to a chat so a concurrent connect cannot route it
/// into whichever session happens to hold the live slot. Omitting it keeps the
/// legacy "current focus" behaviour for single-session callers.
#[tauri::command]
pub async fn session_send(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    text: String,
    display_text: Option<String>,
    session_id: Option<String>,
) -> Result<SessionSnapshot, String> {
    mgr.send_message(app, text, display_text, session_id).await
}

/// Inject guidance into the active turn without cancelling the running prompt.
/// `session_id` binds the interjection to a chat (live or background).
#[tauri::command]
pub async fn session_interject(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    text: String,
    display_text: Option<String>,
    attachments: Option<Vec<store::MessageAttachmentStored>>,
    session_id: Option<String>,
) -> Result<SessionSnapshot, String> {
    mgr.interject_message(app, text, display_text, attachments, session_id)
        .await
}

/// Drop last user turn on agent + local journal (edit & resend).
#[tauri::command]
pub async fn session_rewind_drop_last_user(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    session_id: Option<String>,
) -> Result<SessionSnapshot, String> {
    mgr.rewind_drop_last_user_turn(app, session_id).await
}

/// List rewind points (one per user prompt) for a session journal.
/// Omitting `session_id` uses the live host session.
#[tauri::command]
pub async fn session_rewind_points(
    mgr: State<'_, Arc<SessionManager>>,
    session_id: Option<String>,
) -> Result<Vec<crate::session_manager::RewindPointDto>, String> {
    mgr.list_rewind_points(session_id)
}

/// Rewind a session to a user-prompt index. Local journal always truncates;
/// agent `x.ai/rewind/execute` is best-effort when the session is live (`agentOk`).
#[tauri::command]
pub async fn session_rewind_execute(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    target_prompt_index: u32,
    restore_files: Option<bool>,
    session_id: Option<String>,
) -> Result<crate::session_manager::RewindExecuteResult, String> {
    mgr.rewind_to_prompt_index(
        app,
        target_prompt_index,
        restore_files.unwrap_or(false),
        session_id,
    )
    .await
}

/// Fork a session into a new chat (same project, messages up to optional cut).
///
/// When `fork_agent_session` is true and the source has an agent id, the new
/// chat carries that id with a one-shot fork flag so the next connect uses
/// CLI `--fork-session` semantics (ACP `session/fork` → new agent id).
#[tauri::command]
pub fn session_fork(
    source_id: String,
    through_user_prompt_index: Option<u32>,
    title: Option<String>,
    fork_agent_session: Option<bool>,
) -> Result<store::SessionMeta, String> {
    store::fork_session(
        &source_id,
        through_user_prompt_index,
        title,
        fork_agent_session.unwrap_or(false),
    )
}

/// Set the one-shot CLI `--fork-session` flag (new agent id on next connect).
/// Soft-respawns the live agent for this chat when the flag is armed so the
/// next connect can fork instead of reusing the warm process.
#[tauri::command]
pub async fn session_set_fork_agent_session(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    fork_agent_session: bool,
) -> Result<store::SessionMeta, String> {
    let meta = store::set_session_fork_agent_session(&id, fork_agent_session)?;
    let snap = mgr.snapshot();
    if fork_agent_session && snap.session_id.as_deref() == Some(meta.id.as_str()) {
        mgr.soft_respawn_with_reason(&app, "session_fork_agent").await;
    }
    Ok(meta)
}

#[tauri::command]
pub async fn session_stop(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    session_id: Option<String>,
) -> Result<SessionSnapshot, String> {
    mgr.stop(app, session_id).await
}

/// Approve / revise / abandon pending plan (`_x.ai/exit_plan_mode`).
#[tauri::command]
pub async fn session_resolve_plan(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    decision: String,
    feedback: Option<String>,
    rpc_id: Option<u64>,
    session_id: Option<String>,
) -> Result<SessionSnapshot, String> {
    mgr.resolve_plan(app, decision, feedback, rpc_id, session_id)
        .await
}

/// Answer or dismiss pending `_x.ai/ask_user_question`.
#[tauri::command]
pub async fn session_resolve_ask_user(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    decision: String,
    answers: Option<serde_json::Value>,
    rpc_id: Option<u64>,
    session_id: Option<String>,
) -> Result<SessionSnapshot, String> {
    mgr.resolve_ask_user(app, decision, answers, rpc_id, session_id)
        .await
}

#[tauri::command]
pub async fn session_disconnect(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<SessionSnapshot, String> {
    mgr.disconnect(app).await
}

#[tauri::command]
pub async fn session_reattach(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<SessionSnapshot, String> {
    mgr.reattach(app).await
}

#[tauri::command]
pub async fn session_resolve_permission(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    rpc_id: u64,
    decision: String,
    option_id: Option<String>,
    scope_key: Option<String>,
    session_id: Option<String>,
) -> Result<SessionSnapshot, String> {
    mgr.resolve_permission(app, rpc_id, decision, option_id, scope_key, session_id)
        .await
}

#[tauri::command]
pub async fn probe_cli(manual_path: Option<String>) -> Result<CliProbeResult, String> {
    Ok(cli_probe::probe_cli(manual_path.as_deref()))
}

/// API mode: TCP-connect to an ACP server and run the initialize handshake.
#[tauri::command]
pub async fn acp_test_connection(
    addr: String,
) -> Result<crate::acp_client::AcpProbeResult, String> {
    let addr = addr.trim();
    if addr.is_empty() {
        return Err("empty address".into());
    }
    Ok(crate::acp_client::probe_acp_server(addr).await)
}

/// Settings health check: TCP connect only (~2s). No secrets, no ACP RPC.
#[tauri::command]
pub async fn acp_server_probe(
    addr: String,
) -> Result<crate::acp_client::AcpServerProbeResult, String> {
    let addr = addr.trim();
    if addr.is_empty() {
        return Err("empty address".into());
    }
    Ok(crate::acp_client::acp_server_probe(addr).await)
}

/// Download + install latest Grok Build (multi-mirror, progress via `setup://cli-install-progress`).
///
/// `allow_unverified`: optional; when omitted, uses Settings
/// `allowUnverifiedCliInstall`. Missing published checksums are allowed by
/// default; this flag (or env) only overrides `GROK_CLI_REQUIRE_CHECKSUM`.
/// Checksum **mismatch** always aborts.
#[tauri::command]
pub async fn cli_install_latest(
    app: tauri::AppHandle,
    allow_unverified: Option<bool>,
) -> Result<crate::cli_install::CliInstallResult, String> {
    let allow = allow_unverified.unwrap_or_else(|| {
        store::load_settings().allow_unverified_cli_install
    });
    let result = crate::cli_install::install_cli_latest(app, allow).await?;
    // Remember last install verification for Doctor.
    let mut s = store::load_settings();
    s.last_cli_checksum_verified = result.checksum_verified;
    let _ = store::save_settings(&s);
    Ok(result)
}

/// Platform install command + docs URL for manual fallback.
#[tauri::command]
pub async fn cli_install_commands() -> Result<serde_json::Value, String> {
    Ok(crate::cli_install::install_commands())
}

/// Native file picker for a Grok Build binary (manual path).
#[tauri::command]
pub async fn pick_cli_binary() -> Result<Option<String>, String> {
    let file = tauri::async_runtime::spawn_blocking(|| {
        // Windows rebinds after add_filter; other platforms keep the builder immutable.
        #[cfg(target_os = "windows")]
        {
            let dlg = rfd::FileDialog::new()
                .set_title("Select Grok Build binary / 选择 Grok Build 可执行文件")
                .add_filter("Executable", &["exe", "cmd", "bat"]);
            return dlg.pick_file();
        }
        #[cfg(not(target_os = "windows"))]
        {
            rfd::FileDialog::new()
                .set_title("Select Grok Build binary / 选择 Grok Build 可执行文件")
                .pick_file()
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(file.map(|p| p.display().to_string()))
}

/// Native file picker for an agent profile (markdown / any file).
#[tauri::command]
pub async fn pick_agent_profile() -> Result<Option<String>, String> {
    let file = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Select agent profile / 选择 Agent profile 文件")
            .add_filter("Agent profile", &["md", "markdown", "json", "toml"])
            .add_filter("All files", &["*"])
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(file.map(|p| {
        crate::path_scope::grant_path(&p);
        p.display().to_string()
    }))
}

/// Query GitHub Releases for a newer App version (Settings → About).
#[tauri::command]
pub async fn app_check_update() -> Result<crate::app_update::AppUpdateCheck, String> {
    crate::app_update::check_app_update().await
}

/// Open a URL in the system browser (docs, install pages).
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    open_http_url(url.trim())
}

/// Shared http(s) open helper (also used by account login).
///
/// Windows uses `rundll32 url.dll,FileProtocolHandler` so query `&` is not
/// split by `cmd /C start`, and no console window flashes (Fixes #162).
pub fn open_http_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("empty url".into());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs allowed".into());
    }
    // Reject control characters that could smuggle extra commands.
    if url.bytes().any(|b| b == 0 || b == b'\n' || b == b'\r') {
        return Err("invalid url".into());
    }
    #[cfg(target_os = "macos")]
    {
        crate::process_util::command("open")
            .arg(url)
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        // Avoid `cmd /C start` — it re-parses `&` in query strings as command separators.
        crate::process_util::command("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        crate::process_util::command("xdg-open")
            .arg(url)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub async fn projects_list() -> Result<Vec<Project>, String> {
    Ok(store::load_projects())
}

/// Default cwd for chats without a bound project folder (`workspaces/general`).
/// Not a sidebar project — only the on-disk directory.
#[tauri::command]
pub async fn general_workspace_path() -> Result<String, String> {
    store::general_workspace_path_string()
}

#[tauri::command]
pub async fn project_add(path: String, trust: bool) -> Result<Project, String> {
    store::add_project(path, trust)
}

#[tauri::command]
pub async fn project_remove(id: String) -> Result<(), String> {
    // Unlink from app only — disk folder + sessions retained.
    store::remove_project(&id)
}

/// Update project folder path after the directory moved or was renamed.
/// Verifies the new path is a directory and sets `path_ok` true.
#[tauri::command]
pub async fn project_relocate(id: String, path: String) -> Result<Project, String> {
    store::relocate_project(&id, path)
}

#[tauri::command]
pub async fn project_trust(id: String) -> Result<Project, String> {
    store::trust_project(&id)
}

/// Set or clear the project-level permission tier (L10).
/// `policy = null` / empty / `"inherit"` → fall back to app default.
/// When this project is the live Host context, sync agent policy immediately.
#[tauri::command]
pub async fn project_set_permission_policy(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    policy: Option<String>,
) -> Result<Project, String> {
    let p = store::set_project_permission_policy(&id, policy)?;
    let (live_proj, live_sess) = mgr.current_context_ids();
    if live_proj.as_deref() == Some(id.as_str()) {
        let prefs = store::resolve_composer_prefs(Some(&id), live_sess.as_deref());
        if let Err(e) = mgr
            .apply_permission_policy(&app, &prefs.permission_policy)
            .await
        {
            tracing::warn!("project_set_permission_policy apply live: {e}");
        }
    }
    Ok(p)
}

/// Set or clear the project-level OS sandbox profile.
/// `profile = null` / empty / `"inherit"` → fall back to app Settings.
/// When this project is the live Host context, soft-respawn so the flag applies.
#[tauri::command]
pub async fn project_set_sandbox_profile(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    profile: Option<String>,
) -> Result<Project, String> {
    let p = store::set_project_sandbox_profile(&id, profile)?;
    let (live_proj, _) = mgr.current_context_ids();
    if live_proj.as_deref() == Some(id.as_str()) {
        mgr.soft_respawn_with_reason(&app, "project_sandbox").await;
    }
    Ok(p)
}

#[tauri::command]
pub async fn project_rename(id: String, name: String) -> Result<Project, String> {
    store::rename_project(&id, &name)
}

#[tauri::command]
pub async fn project_set_pinned(id: String, pinned: bool) -> Result<Project, String> {
    store::set_project_pinned(&id, pinned)
}

/// Set or clear a project sidebar accent color.
/// `color = null` / empty / `"none"` clears the accent.
/// Accepts named tokens (`blue`|`green`|…) or `#rgb`/`#rrggbb`.
#[tauri::command]
pub async fn project_set_color(id: String, color: Option<String>) -> Result<Project, String> {
    store::set_project_color(&id, color)
}

/// Reveal project folder in the OS file manager (Finder / Explorer).
#[tauri::command]
pub async fn project_reveal(id: String) -> Result<(), String> {
    let list = store::load_projects();
    let p = list
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "project not found".to_string())?;
    let path = p.path.clone();
    #[cfg(target_os = "macos")]
    {
        crate::process_util::command("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::process_util::command("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::process_util::command("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn project_archive_sessions(id: String) -> Result<usize, String> {
    store::archive_project_sessions(&id)
}

#[tauri::command]
pub async fn sessions_list() -> Result<Vec<SessionMeta>, String> {
    Ok(store::load_sessions_index())
}

/// Scan App journal messages for case-insensitive content matches.
/// Returns session id, title, snippet, match count (capped work).
#[tauri::command]
pub async fn sessions_search(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<crate::session_content_search::SessionContentHit>, String> {
    let lim = limit.unwrap_or(20).min(50) as usize;
    // Blocking disk scan — run off the async runtime.
    let q = query;
    tauri::async_runtime::spawn_blocking(move || {
        crate::session_content_search::search_sessions(&q, lim)
    })
    .await
    .map_err(|e| e.to_string())
}

/// List Grok Build CLI sessions under GROK_HOME (shared-mode discovery, E03).
#[tauri::command]
pub async fn cli_sessions_list() -> Result<Vec<crate::cli_sessions::CliSessionSummary>, String> {
    let mode = store::load_settings().session_data_mode;
    crate::cli_sessions::list_cli_sessions(&mode)
}

/// Search CLI sessions via `grok sessions search` (summaries + first prompts).
/// Falls back to local disk filter (incl. first prompt) when CLI is unavailable.
#[tauri::command]
pub async fn cli_sessions_search(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<crate::cli_sessions::CliSessionSearchHit>, String> {
    let settings = store::load_settings();
    let mode = settings.session_data_mode.clone();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let cli_path = probe.path.filter(|_| probe.found).map(std::path::PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        crate::cli_sessions::search_cli_sessions(
            &query,
            limit,
            &mode,
            cli_path.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import one CLI session (chat_history.jsonl) into the App journal.
#[tauri::command]
pub async fn cli_session_import(
    agent_session_id: String,
    dir: Option<String>,
    project_id: Option<String>,
) -> Result<SessionMeta, String> {
    let mode = store::load_settings().session_data_mode;
    crate::cli_sessions::import_cli_session(
        &agent_session_id,
        dir.as_deref(),
        project_id,
        &mode,
    )
}

/// Find the most recent CLI agent session for a project path (CLI `-c/--continue`).
/// Returns `None` when no session exists (soft-fail).
#[tauri::command]
pub async fn cli_session_find_latest_for_cwd(
    project_path: String,
) -> Result<Option<crate::cli_sessions::CliSessionSummary>, String> {
    let mode = store::load_settings().session_data_mode;
    let path = project_path;
    tauri::async_runtime::spawn_blocking(move || {
        crate::cli_sessions::find_latest_cli_session_for_cwd(&path, &mode)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// CLI `-c/--continue`: find latest agent session for project path and
/// open/import it as an App session. `None` when no agent session exists.
#[tauri::command]
pub async fn cli_session_continue_cwd(
    project_path: String,
    project_id: Option<String>,
) -> Result<Option<SessionMeta>, String> {
    let mode = store::load_settings().session_data_mode;
    tauri::async_runtime::spawn_blocking(move || {
        crate::cli_sessions::continue_cli_session_for_cwd(&project_path, project_id, &mode)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import up to `limit` not-yet-linked CLI sessions (default 50).
#[tauri::command]
pub async fn cli_sessions_import_all(limit: Option<u32>) -> Result<Vec<SessionMeta>, String> {
    let mode = store::load_settings().session_data_mode;
    let lim = limit.unwrap_or(50).min(100) as usize;
    crate::cli_sessions::import_all_cli_sessions(&mode, lim)
}

/// Delete one on-disk CLI session under active GROK_HOME (path-scoped).
/// App-linked chats are left intact.
#[tauri::command]
pub async fn cli_sessions_delete(
    agent_session_id: String,
    dir: Option<String>,
) -> Result<(), String> {
    let mode = store::load_settings().session_data_mode;
    // Blocking disk IO off the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        crate::cli_sessions::delete_cli_session(
            &agent_session_id,
            dir.as_deref(),
            &mode,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_create(
    project_id: Option<String>,
    title: Option<String>,
    scheduled: Option<bool>,
) -> Result<SessionMeta, String> {
    store::create_session(project_id, title, scheduled.unwrap_or(false))
}

#[tauri::command]
pub async fn session_set_scheduled(
    id: String,
    scheduled: bool,
) -> Result<SessionMeta, String> {
    store::set_session_scheduled(&id, scheduled)
}

/// Force-quit the process after frontend busy-session confirm (or when no confirm needed).
/// Bypasses CloseRequested so we do not re-enter the confirm loop.
#[tauri::command]
pub fn app_force_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Primary workbench window label (matches tauri.conf.json + frontend multiWindow).
const MAIN_WINDOW_LABEL: &str = "main";

/// Secondary session window label prefix (`session-<uuid>`). Matches frontend `multiWindow.ts`.
const SESSION_WINDOW_LABEL_PREFIX: &str = "session-";

/// Sanitize a session id for Tauri window labels (ASCII alnum / `-` / `_` only).
fn sanitize_session_id_for_label(session_id: &str) -> Option<&str> {
    let id = session_id.trim();
    if id.is_empty() {
        return None;
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(id)
}

fn session_window_label(session_id: &str) -> Option<String> {
    sanitize_session_id_for_label(session_id)
        .map(|id| format!("{SESSION_WINDOW_LABEL_PREFIX}{id}"))
}

/// Open (or focus) a secondary webview window for a chat (`#/session/<id>`).
///
/// Secondary windows are live-capable (send/stop/warm-connect via the shared
/// Host session-keyed agent pool). Concurrent connect demotes busy peers to
/// background (stream continues) rather than killing them. Re-opening the same
/// session focuses the existing window instead of spawning a third copy.
#[tauri::command]
pub fn open_session_window(
    app: tauri::AppHandle,
    session_id: String,
    title: Option<String>,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let sid = sanitize_session_id_for_label(&session_id)
        .ok_or_else(|| "invalid session id for window label".to_string())?;
    let label = session_window_label(sid).expect("sid already sanitized");

    let win_title = title
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|t| format!("Grok · {t}"))
        .unwrap_or_else(|| "Grok".to_string());

    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_title(&win_title);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }

    // Deep link: frontend parses `#/session/<id>` on boot (secondary live mode).
    let url = format!("index.html#/session/{sid}");
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(win_title)
        .inner_size(1000.0, 720.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .decorations(true)
        .center()
        .build()
        .map_err(|e| format!("open session window: {e}"))?;
    Ok(())
}

/// Focus (show / unminimize) the primary workbench window from a secondary pane.
#[tauri::command]
pub fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let w = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    Ok(())
}

#[cfg(test)]
mod multi_window_tests {
    use super::*;

    #[test]
    fn sanitize_session_id_accepts_uuid() {
        let id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        assert_eq!(sanitize_session_id_for_label(id), Some(id));
        assert_eq!(
            session_window_label(id).as_deref(),
            Some("session-a1b2c3d4-e5f6-7890-abcd-ef1234567890")
        );
    }

    #[test]
    fn sanitize_session_id_rejects_path_junk() {
        assert!(sanitize_session_id_for_label("").is_none());
        assert!(sanitize_session_id_for_label("bad id").is_none());
        assert!(sanitize_session_id_for_label("../x").is_none());
        assert!(sanitize_session_id_for_label("a/b").is_none());
        assert!(session_window_label(" ").is_none());
    }
}

#[tauri::command]
pub async fn session_delete(id: String) -> Result<(), String> {
    store::delete_session(&id)
}

#[tauri::command]
pub async fn session_rename(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    title: String,
) -> Result<SessionMeta, String> {
    let meta = store::rename_session(&id, &title)?;
    // Sync live session so streaming state events do not revive the old title.
    let _ = mgr.apply_title(&app, &meta.id, &meta.title);
    Ok(meta)
}

#[tauri::command]
pub async fn session_set_archived(id: String, archived: bool) -> Result<SessionMeta, String> {
    store::set_session_archived(&id, archived)
}

#[tauri::command]
pub async fn session_set_pinned(id: String, pinned: bool) -> Result<SessionMeta, String> {
    store::set_session_pinned(&id, pinned)
}

/// Attach or clear worktree path/branch on a session (sidebar WT badge).
#[tauri::command]
pub async fn session_set_worktree(
    id: String,
    worktree_path: Option<String>,
    worktree_branch: Option<String>,
) -> Result<SessionMeta, String> {
    store::set_session_worktree(&id, worktree_path, worktree_branch)
}

/// Set or clear the optional JSON Schema for structured model output.
/// When the session is live, disconnect so the next connect re-spawns with
/// top-level `grok --json-schema` (prompt-side wrap still applies immediately).
#[tauri::command]
pub async fn session_set_json_schema(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    json_schema: Option<String>,
) -> Result<SessionMeta, String> {
    let meta = store::set_session_json_schema(&id, json_schema)?;
    let snap = mgr.snapshot();
    if snap.session_id.as_deref() == Some(meta.id.as_str()) {
        let _ = mgr.disconnect(app).await;
    }
    Ok(meta)
}

/// Move session under a project (or clear project → orphan / 「其他会话」).
#[tauri::command]
pub async fn session_set_project(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    project_id: Option<String>,
) -> Result<SessionMeta, String> {
    let meta = store::set_session_project(&id, project_id)?;
    // If this session is live, drop ACP so next send reconnects with new cwd.
    let snap = mgr.snapshot();
    if snap.session_id.as_deref() == Some(meta.id.as_str()) {
        let _ = mgr.disconnect(app).await;
    }
    Ok(meta)
}

/// Set session-only plugin directories (`--plugin-dir` at next spawn).
/// Empty clears. Does not change global Extensions / installed plugins.
/// Soft-respawns the live agent when this chat is the active shell.
#[tauri::command]
pub async fn session_set_plugin_dirs(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    plugin_dirs: Vec<String>,
) -> Result<SessionMeta, String> {
    let meta = store::set_session_plugin_dirs(&id, plugin_dirs)?;
    let snap = mgr.snapshot();
    if snap.session_id.as_deref() == Some(meta.id.as_str()) {
        mgr.soft_respawn_with_reason(&app, "session_plugin_dirs").await;
    }
    Ok(meta)
}

/// Set or clear per-session extra rules (`grok --rules` at next spawn).
/// Empty / whitespace clears. Soft-respawns the live agent for this chat.
#[tauri::command]
pub async fn session_set_extra_rules(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    extra_rules: Option<String>,
) -> Result<SessionMeta, String> {
    let meta = store::set_session_extra_rules(&id, extra_rules)?;
    let snap = mgr.snapshot();
    if snap.session_id.as_deref() == Some(meta.id.as_str()) {
        mgr.soft_respawn_with_reason(&app, "session_extra_rules").await;
    }
    Ok(meta)
}

/// Set or clear per-session max agent turns (`grok --max-turns` at next spawn).
/// `None` / `0` clears (inherit global). Soft-respawns the live agent for this chat.
#[tauri::command]
pub async fn session_set_max_agent_turns(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    max_agent_turns: Option<u32>,
) -> Result<SessionMeta, String> {
    let meta = store::set_session_max_agent_turns(&id, max_agent_turns)?;
    let snap = mgr.snapshot();
    if snap.session_id.as_deref() == Some(meta.id.as_str()) {
        mgr.soft_respawn_with_reason(&app, "session_max_agent_turns")
            .await;
    }
    Ok(meta)
}

/// Set or clear per-session system prompt override
/// (`grok --system-prompt-override` at next spawn).
/// Empty / whitespace clears. Soft-respawns the live agent for this chat.
/// Never logs the prompt body (may contain secrets / PII).
#[tauri::command]
pub async fn session_set_system_prompt_override(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    system_prompt_override: Option<String>,
) -> Result<SessionMeta, String> {
    let meta = store::set_session_system_prompt_override(&id, system_prompt_override)?;
    let snap = mgr.snapshot();
    if snap.session_id.as_deref() == Some(meta.id.as_str()) {
        mgr.soft_respawn_with_reason(&app, "session_system_prompt_override")
            .await;
    }
    Ok(meta)
}

/// Set or clear per-session `--no-ask-user` override (CLI ≥ 0.2.117).
/// `None` inherits global Settings. Soft-respawns the live agent for this chat.
#[tauri::command]
pub async fn session_set_no_ask_user(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    no_ask_user: Option<bool>,
) -> Result<SessionMeta, String> {
    let meta = store::set_session_no_ask_user(&id, no_ask_user)?;
    let snap = mgr.snapshot();
    if snap.session_id.as_deref() == Some(meta.id.as_str()) {
        mgr.soft_respawn_with_reason(&app, "session_no_ask_user").await;
    }
    Ok(meta)
}

#[tauri::command]
pub async fn session_messages(
    id: String,
) -> Result<Vec<store::ChatMessageStored>, String> {
    // If Host dropped the final assistant stream, agent chat_history still has
    // it — merge before serving so reload / re-open recovers the answer.
    let _ = crate::cli_sessions::try_reconcile_linked_session(&id);
    Ok(store::load_messages(&id))
}

/// Absolute path of the agent session folder under GROK_HOME (images/, etc.).
/// Used to resolve short relative paths like `images/1.jpg` into image cards.
#[tauri::command]
pub async fn session_media_root(id: String) -> Result<Option<String>, String> {
    Ok(resolve_session_media_root(&id))
}

/// Loopback media HTTP endpoint (`baseUrl` + `token`) for local file previews.
/// Frontend builds `http://127.0.0.1:{port}/v1/media?t=…&p=…` for absolute paths.
#[tauri::command]
pub async fn media_server_endpoint(
    app: tauri::AppHandle,
) -> Result<crate::media_server::MediaServerEndpoint, String> {
    use tauri::Manager;
    let handle = app
        .try_state::<crate::media_server::MediaServerHandle>()
        .ok_or_else(|| "media server not running".to_string())?;
    Ok(handle.endpoint())
}

/// Resolve relative media refs to absolute paths that exist on disk.
/// Tries (1) agent session dir under GROK_HOME (`images/1.jpg`),
/// then (2) project cwd (skill outputs like `outputs/xhx-media-gen/foo.png`).
/// Skips missing / unsafe paths.
#[tauri::command]
pub async fn session_resolve_relative_media(
    id: String,
    relatives: Vec<String>,
) -> Result<Vec<store::MessageAttachmentStored>, String> {
    let (session_root, project_root) = resolve_media_search_roots(&id);
    if session_root.is_none() && project_root.is_none() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for rel in relatives {
        let full = session_root
            .as_ref()
            .and_then(|r| crate::paths::resolve_session_relative_media(r, &rel))
            .or_else(|| {
                project_root
                    .as_ref()
                    .and_then(|r| crate::paths::resolve_session_relative_media(r, &rel))
            });
        let Some(full) = full else {
            continue;
        };
        // Allow media:// previews for session/project skill outputs (including
        // untrusted project roots that are not in the global path_scope list).
        crate::path_scope::grant_path(&full);
        let path = full.to_string_lossy().to_string();
        if !seen.insert(path.clone()) {
            continue;
        }
        let name = full
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        out.push(store::MessageAttachmentStored {
            path,
            name,
            is_dir: false,
        });
    }
    Ok(out)
}

fn resolve_media_search_roots(
    session_id: &str,
) -> (Option<std::path::PathBuf>, Option<std::path::PathBuf>) {
    let meta = store::load_sessions_index()
        .into_iter()
        .find(|s| s.id == session_id);
    let Some(meta) = meta else {
        return (None, None);
    };
    let project_root = meta.project_id.as_ref().and_then(|pid| {
        store::load_projects()
            .into_iter()
            .find(|p| &p.id == pid)
            .map(|p| std::path::PathBuf::from(p.path))
    });
    let session_root = meta.agent_session_id.as_deref().and_then(|agent_sid| {
        let settings = store::load_settings();
        crate::paths::find_agent_session_dir(
            agent_sid,
            project_root
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .as_deref(),
            &settings.session_data_mode,
        )
    });
    (session_root, project_root)
}

fn resolve_session_media_root(session_id: &str) -> Option<String> {
    resolve_media_search_roots(session_id)
        .0
        .map(|p| p.to_string_lossy().to_string())
}

// ─── Automations ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn automations_list() -> Result<Vec<store::Automation>, String> {
    Ok(store::load_automations())
}

#[tauri::command]
pub async fn automation_create(
    input: store::AutomationInput,
) -> Result<store::Automation, String> {
    store::create_automation(input)
}

#[tauri::command]
pub async fn automation_update(
    id: String,
    input: store::AutomationInput,
) -> Result<store::Automation, String> {
    store::update_automation(&id, input)
}

#[tauri::command]
pub async fn automation_set_enabled(
    id: String,
    enabled: bool,
) -> Result<store::Automation, String> {
    store::set_automation_enabled(&id, enabled)
}

#[tauri::command]
pub async fn automation_mark_run(
    id: String,
    last_run_at: String,
    next_run_at: Option<String>,
) -> Result<store::Automation, String> {
    let last = chrono::DateTime::parse_from_rfc3339(&last_run_at)
        .map(|d| d.with_timezone(&chrono::Utc))
        .map_err(|e| e.to_string())?;
    let next = match next_run_at {
        Some(s) if !s.is_empty() => Some(
            chrono::DateTime::parse_from_rfc3339(&s)
                .map(|d| d.with_timezone(&chrono::Utc))
                .map_err(|e| e.to_string())?,
        ),
        _ => None,
    };
    store::mark_automation_run(&id, last, next)
}

#[tauri::command]
pub async fn automation_delete(id: String) -> Result<(), String> {
    store::delete_automation(&id)
}

/// Host automation_runner snapshot (tray-only ok; not a separate daemon).
#[tauri::command]
pub async fn automation_runner_status(
) -> Result<crate::automation_runner::AutomationRunnerStatus, String> {
    Ok(crate::automation_runner::status())
}

/// macOS schedules LaunchAgent helper status (honest full-app restart only).
#[tauri::command]
pub async fn schedules_launch_agent_status(
) -> Result<crate::schedules_launch_agent::SchedulesLaunchAgentStatus, String> {
    let enabled = store::load_settings().schedules_launch_agent;
    Ok(crate::schedules_launch_agent::status(enabled))
}

/// Enable/disable the optional schedules LaunchAgent helper and persist setting.
#[tauri::command]
pub async fn schedules_launch_agent_set_enabled(
    enabled: bool,
) -> Result<crate::schedules_launch_agent::SchedulesLaunchAgentStatus, String> {
    let status = if enabled {
        crate::schedules_launch_agent::enable()?
    } else {
        crate::schedules_launch_agent::disable()?
    };
    let mut settings = store::load_settings();
    // Non-macOS never claims enabled; install is a no-op there.
    settings.schedules_launch_agent = enabled && status.supported;
    store::save_settings(&settings)?;
    Ok(crate::schedules_launch_agent::status(
        settings.schedules_launch_agent,
    ))
}

/// Reveal the generated helper directory in Finder / Explorer (when present).
#[tauri::command]
pub async fn schedules_launch_agent_reveal_helper() -> Result<String, String> {
    let dir = crate::schedules_launch_agent::helper_dir();
    if !dir.is_dir() {
        // Generate files so the user can inspect without enabling the agent.
        crate::schedules_launch_agent::generate_helper_files()?;
    }
    let path = dir.display().to_string();
    path_reveal(path.clone()).await?;
    Ok(path)
}

#[tauri::command]
pub async fn settings_get() -> Result<AppSettings, String> {
    Ok(store::load_settings())
}

/// One-shot notice after corrupt store files were quarantined on load.
#[tauri::command]
pub fn store_take_quarantine() -> Option<String> {
    store::take_store_quarantine()
}

#[tauri::command]
pub async fn settings_set(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let prev = store::load_settings();
    let mut settings = settings;
    // Normalize denylist / allowlist so spawn / equality see stable lists.
    settings.disallowed_tools =
        crate::acp_client::normalize_disallowed_tools(&settings.disallowed_tools);
    settings.allowed_tools =
        crate::acp_client::normalize_allowed_tools(&settings.allowed_tools);
    // Normalize optional agent profile path (trim / drop control chars).
    settings.agent_profile_path =
        crate::agents_catalog::normalize_agent_profile_path(&settings.agent_profile_path)
            .unwrap_or_default();
    // Normalize / validate optional agents JSON (reject invalid non-empty).
    settings.agents_json =
        crate::agents_catalog::normalize_agents_json(&settings.agents_json)?;
    // Headless background-wait policy (CLI 0.2.117+); clamp timeout 1–3600.
    settings.background_wait_policy =
        crate::acp_client::normalize_background_wait_policy(&settings.background_wait_policy)
            .as_str()
            .to_string();
    settings.background_wait_timeout_sec =
        crate::acp_client::normalize_background_wait_timeout_sec(
            settings.background_wait_timeout_sec,
        );
    // Normalize compaction mode/detail enums (CLI 0.2.117+).
    settings.compaction_mode =
        crate::acp_client::normalize_compaction_mode(&settings.compaction_mode).to_string();
    settings.compaction_detail =
        crate::acp_client::normalize_compaction_detail(&settings.compaction_detail).to_string();
    // Audit ledger retention presets: 7 / 30 / 90 / 0 (unlimited).
    settings.audit_ledger_retention_days =
        crate::audit_ledger::normalize_retention_days(settings.audit_ledger_retention_days);
    let audit_retention_flip = crate::audit_ledger::normalize_retention_days(
        prev.audit_ledger_retention_days,
    ) != settings.audit_ledger_retention_days;
    let keychain_flip =
        prev.store_api_keys_in_keychain != settings.store_api_keys_in_keychain;
    let session_data_mode_changed =
        prev.session_data_mode != settings.session_data_mode;
    let memory_flip = prev.experimental_memory != settings.experimental_memory;
    let web_search_flip = prev.disable_web_search != settings.disable_web_search;
    let no_ask_user_flip = prev.no_ask_user != settings.no_ask_user;
    let disallowed_tools_flip = !crate::acp_client::disallowed_tools_equal(
        &prev.disallowed_tools,
        &settings.disallowed_tools,
    );
    let allowed_tools_flip = !crate::acp_client::allowed_tools_equal(
        &prev.allowed_tools,
        &settings.allowed_tools,
    );
    // Normalize TodoGate max fires (1–20; 0 → default 3).
    settings.todo_gate_max_fires_per_prompt =
        crate::agent_todo_gate::normalize_todo_gate_max_fires(Some(
            settings.todo_gate_max_fires_per_prompt,
        ));
    let todo_gate_flip = prev.todo_gate_enabled != settings.todo_gate_enabled
        || crate::agent_todo_gate::normalize_todo_gate_max_fires(Some(
            prev.todo_gate_max_fires_per_prompt,
        )) != settings.todo_gate_max_fires_per_prompt;
    let plan_enabled_flip = prev.plan_enabled != settings.plan_enabled;
    let use_leader_changed = prev.use_leader != settings.use_leader;
    let subagents_flip = prev.subagents_enabled != settings.subagents_enabled;
    let subagent_wt_snap_flip = prev.subagent_worktree_snapshot_enabled
        != settings.subagent_worktree_snapshot_enabled;
    let auto_wake_flip = prev.auto_wake_enabled != settings.auto_wake_enabled;
    let workflows_flip = prev.workflows_enabled != settings.workflows_enabled;
    let two_pass_compaction_flip =
        prev.two_pass_compaction_enabled != settings.two_pass_compaction_enabled;
    let preferred_agent_flip =
        prev.preferred_agent.trim() != settings.preferred_agent.trim();
    let agent_profile_flip = prev.agent_profile_path.trim() != settings.agent_profile_path.trim();
    let agents_json_flip = prev.agents_json.trim() != settings.agents_json.trim();
    let max_turns_flip = prev.max_agent_turns != settings.max_agent_turns;
    let bg_wait_flip = !crate::acp_client::background_wait_settings_equal(
        &prev.background_wait_policy,
        prev.background_wait_timeout_sec,
        &settings.background_wait_policy,
        settings.background_wait_timeout_sec,
    );
    let sandbox_flip = prev.sandbox_profile.trim() != settings.sandbox_profile.trim();
    let compaction_flip = {
        let prev_m = crate::acp_client::normalize_compaction_mode(&prev.compaction_mode);
        let next_m = settings.compaction_mode.as_str();
        let prev_d = crate::acp_client::normalize_compaction_detail(&prev.compaction_detail);
        let next_d = settings.compaction_detail.as_str();
        prev_m != next_m || prev_d != next_d
    };
    // API-mode address is a spawn-path flip (local CLI ↔ TCP). Soft-respawn so
    // the next connect uses the new target; mid-turn sessions stay skipped.
    let acp_addr_flip = {
        let a = prev
            .acp_server_addr
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let b = settings
            .acp_server_addr
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        a != b
    };
    let launch_at_login_flip = prev.launch_at_login != settings.launch_at_login;
    let schedules_launch_agent_flip =
        prev.schedules_launch_agent != settings.schedules_launch_agent;

    store::save_settings(&settings)?;

    if schedules_launch_agent_flip {
        let res = if settings.schedules_launch_agent {
            crate::schedules_launch_agent::enable()
        } else {
            crate::schedules_launch_agent::disable()
        };
        if let Err(e) = res {
            let mut rolled = settings.clone();
            rolled.schedules_launch_agent = prev.schedules_launch_agent;
            let _ = store::save_settings(&rolled);
            return Err(format!("schedules LaunchAgent: {e}"));
        }
        // Non-macOS enable is unsupported — keep flag false.
        #[cfg(not(target_os = "macos"))]
        if settings.schedules_launch_agent {
            let mut rolled = settings.clone();
            rolled.schedules_launch_agent = false;
            let _ = store::save_settings(&rolled);
            settings.schedules_launch_agent = false;
        }
    }

    if keychain_flip {
        if let Err(e) =
            crate::secrets::apply_keychain_preference(settings.store_api_keys_in_keychain)
        {
            let mut rolled = settings.clone();
            rolled.store_api_keys_in_keychain = prev.store_api_keys_in_keychain;
            let _ = store::save_settings(&rolled);
            return Err(e);
        }
    }

    if launch_at_login_flip {
        use tauri_plugin_autostart::ManagerExt;
        let autolaunch = app.autolaunch();
        let res = if settings.launch_at_login {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
        if let Err(e) = res {
            let mut rolled = settings.clone();
            rolled.launch_at_login = prev.launch_at_login;
            let _ = store::save_settings(&rolled);
            return Err(format!("launch at login: {e}"));
        }
    }

    if session_data_mode_changed {
        // Rebuild media/fs roots so shared (`~/.grok`) vs independent agent-home
        // switch takes effect for media:// previews immediately.
        crate::path_scope::refresh_from_store();
        mgr.recycle_all_agents(&app, "session_data_mode").await;
    }

    let mut need_soft_respawn = false;
    if memory_flip {
        if let Err(e) = crate::agent_memory::sync_memory_to_agent_profile(
            &settings.session_data_mode,
            settings.experimental_memory,
        ) {
            tracing::warn!("settings_set sync memory profile: {e}");
        }
        need_soft_respawn = true;
    }
    if subagents_flip {
        if let Err(e) = crate::agent_subagents::sync_subagents_to_agent_profile(
            &settings.session_data_mode,
            settings.subagents_enabled,
        ) {
            tracing::warn!("settings_set sync subagents profile: {e}");
        }
        need_soft_respawn = true;
    }
    if todo_gate_flip {
        if let Err(e) = crate::agent_todo_gate::sync_todo_gate_to_agent_profile(
            &settings.session_data_mode,
            settings.todo_gate_enabled,
            settings.todo_gate_max_fires_per_prompt,
        ) {
            tracing::warn!("settings_set sync todo_gate profile: {e}");
        }
        need_soft_respawn = true;
    }
    if subagent_wt_snap_flip {
        if let Err(e) = crate::agent_subagent_wt_snap::sync_subagent_wt_snap_to_agent_profile(
            &settings.session_data_mode,
            settings.subagent_worktree_snapshot_enabled,
        ) {
            tracing::warn!("settings_set sync subagent_wt_snap profile: {e}");
        }
        need_soft_respawn = true;
    }
    if auto_wake_flip {
        if let Err(e) = crate::agent_auto_wake::sync_auto_wake_to_agent_profile(
            &settings.session_data_mode,
            settings.auto_wake_enabled,
        ) {
            tracing::warn!("settings_set sync auto_wake profile: {e}");
        }
        need_soft_respawn = true;
    }
    if workflows_flip {
        if let Err(e) = crate::agent_workflows::sync_workflows_to_agent_profile(
            &settings.session_data_mode,
            settings.workflows_enabled,
        ) {
            tracing::warn!("settings_set sync workflows profile: {e}");
        }
        need_soft_respawn = true;
    }
    if two_pass_compaction_flip {
        if let Err(e) = crate::agent_two_pass_compaction::sync_two_pass_compaction_to_agent_profile(
            &settings.session_data_mode,
            settings.two_pass_compaction_enabled,
        ) {
            tracing::warn!("settings_set sync two_pass_compaction profile: {e}");
        }
        need_soft_respawn = true;
    }
    if web_search_flip
        || no_ask_user_flip
        || disallowed_tools_flip
        || allowed_tools_flip
        || plan_enabled_flip
        || use_leader_changed
        || preferred_agent_flip
        || agent_profile_flip
        || agents_json_flip
        || max_turns_flip
        || bg_wait_flip
        || sandbox_flip
        || compaction_flip
        || acp_addr_flip
    {
        need_soft_respawn = true;
    }
    if need_soft_respawn {
        mgr.soft_respawn_with_reason(&app, "settings_spawn").await;
    }

    if let Err(e) = mgr
        .apply_permission_policy(&app, &settings.permission_policy)
        .await
    {
        tracing::warn!("settings_set apply_permission: {e}");
    }
    if let Err(e) = crate::tray::refresh_menu(&app) {
        tracing::warn!("settings_set tray refresh: {e}");
    }
    // Apply audit ledger retention when the preset changes (soft-fail I/O).
    if audit_retention_flip {
        let days = settings.audit_ledger_retention_days;
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = crate::audit_ledger::prune_ledger(Some(days)) {
                tracing::warn!(target: "grok_app::audit_ledger", "settings prune: {e}");
            }
        })
        .await;
    }
    Ok(settings)
}

#[tauri::command]
pub async fn models_list_available() -> Result<crate::models_catalog::AvailableModelsResult, String> {
    Ok(crate::models_catalog::list_available_models())
}

#[tauri::command]
pub async fn composer_prefs_resolve(
    project_id: Option<String>,
    session_id: Option<String>,
) -> Result<store::ComposerPrefs, String> {
    Ok(store::resolve_composer_prefs(
        project_id.as_deref(),
        session_id.as_deref(),
    ))
}

/// Persist composer fields at the configured memory scope + apply live.
#[tauri::command]
pub async fn composer_prefs_set(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    project_id: Option<String>,
    session_id: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
    mode: Option<String>,
    permission_policy: Option<String>,
) -> Result<store::ComposerPrefs, String> {
    // Prefer explicit ids; fall back to live session context.
    let (live_proj, live_sess) = mgr.current_context_ids();
    let project_id = project_id.or(live_proj);
    let session_id = session_id.or(live_sess);

    let prefs = store::save_composer_prefs(
        project_id.as_deref(),
        session_id.as_deref(),
        model_id.clone(),
        effort.clone(),
        mode.clone(),
        permission_policy.clone(),
    )?;

    if let Some(ref pol) = permission_policy {
        if let Err(e) = mgr.apply_permission_policy(&app, pol).await {
            tracing::warn!("composer_prefs_set apply_permission: {e}");
        }
    }
    if let Some(mid) = model_id {
        if let Err(e) = mgr.set_model(mid).await {
            tracing::warn!("composer_prefs_set set_model soft-fail: {e}");
        }
    }
    if let Some(eff) = effort {
        if let Err(e) = mgr.set_effort_and_respawn_needed(&app, eff).await {
            tracing::warn!("composer_prefs_set set_effort soft-fail: {e}");
        }
    }
    if let Some(m) = mode {
        if let Err(e) = mgr.apply_product_mode(&app, m).await {
            tracing::warn!("composer_prefs_set apply_mode soft-fail: {e}");
        }
    }
    Ok(prefs)
}

#[tauri::command]
pub async fn session_set_policy(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    policy: String,
    project_id: Option<String>,
    session_id: Option<String>,
) -> Result<store::ComposerPrefs, String> {
    let p = crate::permission::PermissionPolicy::parse(&policy);
    let (live_proj, live_sess) = mgr.current_context_ids();
    let prefs = store::save_composer_prefs(
        project_id.or(live_proj).as_deref(),
        session_id.or(live_sess).as_deref(),
        None,
        None,
        None,
        Some(p.as_str().into()),
    )?;
    mgr.apply_permission_policy(&app, p.as_str()).await?;
    Ok(prefs)
}

#[tauri::command]
pub async fn session_set_model(
    mgr: State<'_, Arc<SessionManager>>,
    model_id: String,
    project_id: Option<String>,
    session_id: Option<String>,
) -> Result<store::ComposerPrefs, String> {
    let (live_proj, live_sess) = mgr.current_context_ids();
    let prefs = store::save_composer_prefs(
        project_id.or(live_proj).as_deref(),
        session_id.or(live_sess).as_deref(),
        Some(model_id.clone()),
        None,
        None,
        None,
    )?;
    if let Err(e) = mgr.set_model(model_id).await {
        tracing::warn!("session_set_model soft-fail: {e}");
    }
    Ok(prefs)
}

#[tauri::command]
pub async fn fs_list_dir(
    project_path: String,
    relative: Option<String>,
) -> Result<Vec<crate::fs_browser::FsEntry>, String> {
    crate::fs_browser::list_dir(&project_path, relative.as_deref().unwrap_or(""))
}

/// Project-scoped file name/path + content search (keyword / `rg` or walk).
/// Soft-fails when path missing / not a dir / untrusted. Never invents
/// embeddings or CLI code-graph results (`search_kind` is always `"keyword"`).
#[tauri::command]
pub async fn project_codebase_search(
    project_path: String,
    query: String,
    mode: Option<String>,
    limit: Option<usize>,
) -> Result<crate::project_codebase_search::CodebaseSearchResult, String> {
    let path = project_path;
    let q = query;
    let m = mode;
    tokio::task::spawn_blocking(move || {
        Ok(crate::project_codebase_search::search_project_codebase(
            &path,
            &q,
            m.as_deref(),
            limit,
        ))
    })
    .await
    .map_err(|e| format!("project codebase search task failed: {e}"))?
}

#[tauri::command]
pub async fn fs_read_file(
    project_path: String,
    relative: String,
) -> Result<crate::fs_browser::FsReadResult, String> {
    crate::fs_browser::read_file(&project_path, &relative)
}

/// Write UTF-8 text under the project root (resource pane Save).
/// Pass `expected_mtime_ms` from the last read to detect agent/external overwrites.
#[tauri::command]
pub async fn fs_write_file(
    project_path: String,
    relative: String,
    content: String,
    expected_mtime_ms: Option<u64>,
) -> Result<crate::fs_browser::FsWriteResult, String> {
    crate::fs_browser::write_text_file(
        &project_path,
        &relative,
        &content,
        expected_mtime_ms,
    )
}

/// Write UTF-8 text to an absolute path already open in the resource pane.
#[tauri::command]
pub async fn fs_write_absolute(
    path: String,
    content: String,
    expected_mtime_ms: Option<u64>,
) -> Result<crate::fs_browser::FsWriteResult, String> {
    crate::fs_browser::write_text_absolute(&path, &content, expected_mtime_ms)
}

/// Read an absolute path for resource-pane preview (chat file cards, agent outputs).
#[tauri::command]
pub async fn fs_read_absolute(
    path: String,
) -> Result<crate::fs_browser::FsReadResult, String> {
    crate::fs_browser::read_absolute_file(&path)
}

/// Smart open for chat cards: absolute / project-relative / suffix search under project.
#[tauri::command]
pub async fn fs_open_path(
    path: String,
    project_path: Option<String>,
) -> Result<crate::fs_browser::FsReadResult, String> {
    crate::fs_browser::open_path_smart(project_path.as_deref(), &path)
}

/// Auto-name a session from the first user message.
/// Returns heuristic title immediately; low-effort CLI refine emits `session://title`.
#[tauri::command]
pub async fn session_auto_title(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    first_message: String,
) -> Result<store::SessionMeta, String> {
    let meta = crate::session_title::auto_title_session_fast(&id, &first_message)?;
    // Keep Host live meta aligned so mid-stream session://state does not wipe the title.
    let _ = mgr.apply_title(&app, &meta.id, &meta.title);
    let mgr_arc = Arc::clone(&*mgr);
    crate::session_title::refine_title_in_background(app, mgr_arc, id, first_message);
    Ok(meta)
}

#[tauri::command]
pub async fn secrets_get_masked() -> Result<serde_json::Value, String> {
    // Disk + presence flags only — do not unlock Keychain on app open.
    let s = crate::secrets::load_secrets_disk_only();
    let providers = crate::providers::list_custom_providers().unwrap_or_else(|_| {
        crate::providers::ProvidersListResult {
            providers: vec![],
            default_model: None,
            active_source: "official".into(),
            active_provider_id: None,
            config_path: String::new(),
            agent_home: String::new(),
        }
    });
    let has_provider_key = providers.providers.iter().any(|p| p.has_api_key);
    let relay_base = providers
        .providers
        .iter()
        .find(|p| p.is_default)
        .or(providers.providers.first())
        .map(|p| p.base_url.clone())
        .or(s.relay_base_url.clone());
    Ok(serde_json::json!({
        "hasOfficialKey": crate::secrets::has_official_key_configured(&s),
        "hasRelayKey": has_provider_key
            || crate::secrets::has_relay_key_configured(&s),
        "relayBaseUrl": relay_base,
        "defaultModel": providers.default_model.or(s.default_model),
        "providerCount": providers.providers.len(),
        "agentHome": providers.agent_home,
        // Report user preference — do not soft-probe Keychain on cold start.
        "secretsBackend": match crate::secrets::configured_backend() {
            crate::secrets::SecretsBackendKind::Keychain => "keychain",
            crate::secrets::SecretsBackendKind::File => "file",
        },
        "storeApiKeysInKeychain": store::load_settings().store_api_keys_in_keychain,
    }))
}

#[tauri::command]
pub async fn secrets_set(
    official_api_key: Option<String>,
    relay_base_url: Option<String>,
    relay_api_key: Option<String>,
    default_model: Option<String>,
) -> Result<(), String> {
    let mut s = store::load_secrets();
    // Empty string clears the secret (needed when revoking speech/API credentials).
    if let Some(k) = official_api_key {
        s.official_api_key = if k.trim().is_empty() {
            None
        } else {
            Some(k)
        };
    }
    if let Some(u) = relay_base_url {
        s.relay_base_url = if u.is_empty() { None } else { Some(u) };
    }
    if let Some(k) = relay_api_key {
        s.relay_api_key = if k.trim().is_empty() {
            None
        } else {
            Some(k)
        };
    }
    if let Some(m) = default_model {
        s.default_model = if m.is_empty() { None } else { Some(m) };
    }
    store::save_secrets(&s)
}

#[tauri::command]
pub async fn provider_ping() -> Result<serde_json::Value, String> {
    let secrets = store::load_secrets();
    // Prefer relay if configured, else probe public xAI-ish endpoint with key presence only.
    if let (Some(base), Some(key)) = (&secrets.relay_base_url, &secrets.relay_api_key) {
        let url = format!("{}/models", base.trim_end_matches('/'));
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {key}"))
            .send()
            .await;
        return match resp {
            Ok(r) => {
                let status = r.status().as_u16();
                if status == 401 || status == 403 {
                    Ok(serde_json::json!({
                        "ok": false,
                        "class": "AUTH_FAILED",
                        "status": status,
                        "message": "Provider rejected credentials (401/403)"
                    }))
                } else if status >= 500 {
                    Ok(serde_json::json!({
                        "ok": false,
                        "class": "NETWORK_PROVIDER",
                        "status": status,
                        "message": "Provider server error"
                    }))
                } else if r.status().is_success() {
                    Ok(serde_json::json!({
                        "ok": true,
                        "class": "OK",
                        "status": status,
                        "message": "Ping OK"
                    }))
                } else {
                    Ok(serde_json::json!({
                        "ok": false,
                        "class": "NETWORK_PROVIDER",
                        "status": status,
                        "message": format!("HTTP {status}")
                    }))
                }
            }
            Err(e) => {
                let msg = e.to_string();
                let class = if msg.contains("dns") || msg.contains("resolve") {
                    "NETWORK_PROVIDER"
                } else if msg.contains("timeout") {
                    "NETWORK_PROVIDER"
                } else {
                    "NETWORK_PROVIDER"
                };
                Ok(serde_json::json!({
                    "ok": false,
                    "class": class,
                    "message": msg
                }))
            }
        };
    }

    // CLI auth present?
    let auth = crate::process_util::user_home().join(".grok").join("auth.json");
    if auth.is_file() {
        Ok(serde_json::json!({
            "ok": true,
            "class": "OK",
            "message": "CLI auth.json present (cached_token). Use Doctor + real chat to verify."
        }))
    } else if secrets.official_api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false) {
        Ok(serde_json::json!({
            "ok": true,
            "class": "OK",
            "message": "Official API key stored (not verified over network without base_url)."
        }))
    } else {
        Ok(serde_json::json!({
            "ok": false,
            "class": "AUTH_FAILED",
            "message": "No provider configured. Use Onboarding: official key, relay, or import."
        }))
    }
}

/// Mark onboarding complete after a config import. Never flips `session_data_mode`
/// (E05: import ≠ shared — user must switch mode explicitly).
fn apply_import_onboarding_done(settings: &mut AppSettings) {
    settings.onboarding_done = true;
}

#[tauri::command]
pub async fn import_grok_cli_config() -> Result<serde_json::Value, String> {
    let home = crate::process_util::user_home();
    let auth = home.join(".grok").join("auth.json");
    let config = home.join(".grok").join("config.toml");
    let mut msg = Vec::new();
    if auth.is_file() {
        msg.push("Found ~/.grok/auth.json (CLI will use cached_token)".to_string());
    } else {
        msg.push("No ~/.grok/auth.json".to_string());
    }
    if config.is_file() {
        msg.push("Found ~/.grok/config.toml".to_string());
    }
    let mut settings = store::load_settings();
    apply_import_onboarding_done(&mut settings);
    store::save_settings(&settings)?;
    Ok(serde_json::json!({
        "ok": auth.is_file(),
        "messages": msg,
    }))
}

#[tauri::command]
pub async fn import_grok_go_config() -> Result<serde_json::Value, String> {
    // Common grok-go config locations (read-only)
    let home = crate::process_util::user_home();
    let home_s = home.to_string_lossy();
    let mut candidates: Vec<String> = vec![
        format!("{home_s}/.grok-go/config.json"),
        format!("{home_s}/Library/Application Support/com.grokgo.desktop/config.json"),
        format!("{home_s}/Library/Application Support/GrokGo/config.json"),
    ];
    // Windows app-data layouts (cfg-gated; mut used only on Windows).
    if let Some(extra) = windows_grok_go_config_candidates() {
        candidates.extend(extra);
    }
    for c in candidates {
        let p = std::path::PathBuf::from(&c);
        if p.is_file() {
            let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            let v: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            // Try common keys without logging secrets
            let mut secrets = store::load_secrets();
            if let Some(key) = v
                .pointer("/apiKey")
                .or_else(|| v.pointer("/api_key"))
                .or_else(|| v.pointer("/key"))
                .and_then(|x| x.as_str())
            {
                secrets.relay_api_key = Some(key.to_string());
            }
            if let Some(base) = v
                .pointer("/baseUrl")
                .or_else(|| v.pointer("/base_url"))
                .or_else(|| v.pointer("/endpoint"))
                .and_then(|x| x.as_str())
            {
                secrets.relay_base_url = Some(base.to_string());
            }
            store::save_secrets(&secrets)?;
            let mut settings = store::load_settings();
            apply_import_onboarding_done(&mut settings);
            store::save_settings(&settings)?;
            return Ok(serde_json::json!({
                "ok": true,
                "path": c,
                "message": "Imported grok-go config (keys stored, not logged)."
            }));
        }
    }
    Err("grok-go config not found in known locations".into())
}

#[cfg(test)]
mod import_settings_tests {
    use super::*;

    #[test]
    fn import_onboarding_does_not_force_shared_mode() {
        // E05: import_grok_* must not flip session_data_mode to shared.
        let mut s = AppSettings::default();
        assert_eq!(s.session_data_mode, "independent");
        s.onboarding_done = false;
        apply_import_onboarding_done(&mut s);
        assert!(s.onboarding_done);
        assert_eq!(s.session_data_mode, "independent");

        // If user already chose shared, import still leaves it alone.
        s.session_data_mode = "shared".into();
        apply_import_onboarding_done(&mut s);
        assert_eq!(s.session_data_mode, "shared");
    }
}

/// Structured Doctor check row (UI consumes `checks`; `raw` is for copy/export).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCheck {
    id: String,
    level: String,
    title: String,
    detail: String,
    meta: serde_json::Value,
}

fn doctor_check(
    id: &str,
    level: &str,
    title: &str,
    detail: String,
    meta: serde_json::Value,
) -> DoctorCheck {
    DoctorCheck {
        id: id.into(),
        level: level.into(),
        title: title.into(),
        detail,
        meta,
    }
}

#[tauri::command]
pub async fn doctor_report() -> Result<serde_json::Value, String> {
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let projects = store::load_projects();
    let sessions = store::load_sessions_index();
    let secrets = store::load_secrets();
    let auth_path_buf = crate::process_util::user_home()
        .join(".grok")
        .join("auth.json");
    let auth_ok = auth_path_buf.is_file();
    let auth_path = auth_path_buf.display().to_string();
    let data_root_path = crate::paths::app_data_root();
    let data_root = data_root_path.display().to_string();
    let log_dir_path = data_root_path.join("logs");
    let log_dir = log_dir_path.display().to_string();
    let log_dir_exists = log_dir_path.is_dir();
    let backend_default = if crate::acp_client::AcpClient::use_mock() {
        "mock_acp"
    } else {
        "grok_agent_stdio"
    };
    let has_official_key = secrets.official_api_key.is_some();
    let has_relay = secrets.relay_base_url.is_some() && secrets.relay_api_key.is_some();
    // Never include secret values — only which backend holds them.
    let secrets_backend = match crate::secrets::active_backend() {
        crate::secrets::SecretsBackendKind::Keychain => "keychain",
        crate::secrets::SecretsBackendKind::File => "file",
    };

    // Flat snapshot for clipboard / legacy consumers (no secret values).
    let raw = serde_json::json!({
        "cli": {
            "found": probe.found,
            "path": probe.path,
            "version": probe.version,
            "source": probe.source,
        },
        "auth": {
            "cliAuthJson": auth_ok,
            "authPath": auth_path,
            "hasOfficialKey": has_official_key,
            "hasRelay": has_relay,
            "secretsBackend": secrets_backend,
        },
        "workspace": {
            "projectCount": projects.len(),
            "sessionCount": sessions.len(),
            "dataRoot": data_root,
            "sessionDataMode": settings.session_data_mode,
        },
        "logs": {
            "dir": log_dir,
            "exists": log_dir_exists,
        },
        "app": {
            "version": env!("CARGO_PKG_VERSION"),
            "backendDefault": backend_default,
            "nonOfficial": true,
            "license": "MIT",
        }
    });

    let mut checks: Vec<DoctorCheck> = Vec::with_capacity(5);

    // 1) CLI
    if probe.found {
        let ver = probe.version.as_deref().unwrap_or("unknown");
        let path = probe.path.as_deref().unwrap_or("—");
        checks.push(doctor_check(
            "cli",
            "ok",
            "Grok Build CLI",
            format!("Found {ver} ({}) at {path}", probe.source),
            serde_json::json!({
                "found": true,
                "path": probe.path,
                "version": probe.version,
                "source": probe.source,
            }),
        ));
    } else {
        checks.push(doctor_check(
            "cli",
            "fail",
            "Grok Build CLI",
            "Grok Build CLI not found. Install from Settings → Runtime or the setup wizard."
                .into(),
            serde_json::json!({
                "found": false,
                "path": probe.path,
                "version": probe.version,
                "source": probe.source,
                "candidatesTried": probe.candidates_tried,
            }),
        ));
    }

    // 2) Auth — warn if no CLI auth, official key, or relay
    let auth_sources: Vec<&str> = [
        auth_ok.then_some("cliAuthJson"),
        has_official_key.then_some("officialKey"),
        has_relay.then_some("relay"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if auth_sources.is_empty() {
        checks.push(doctor_check(
            "auth",
            "warn",
            "Authentication",
            format!(
                "No CLI auth (~/.grok/auth.json), official API key, or relay configured. Path: {auth_path}"
            ),
            serde_json::json!({
                "cliAuthJson": auth_ok,
                "authPath": auth_path,
                "hasOfficialKey": has_official_key,
                "hasRelay": has_relay,
            }),
        ));
    } else {
        checks.push(doctor_check(
            "auth",
            "ok",
            "Authentication",
            format!("Auth available via: {}", auth_sources.join(", ")),
            serde_json::json!({
                "cliAuthJson": auth_ok,
                "authPath": auth_path,
                "hasOfficialKey": has_official_key,
                "hasRelay": has_relay,
            }),
        ));
    }

    // 3) Workspace
    let data_root_ok = data_root_path.is_dir() || data_root_path.parent().is_some();
    let workspace_level = if data_root_path.exists() || data_root_ok {
        "ok"
    } else {
        "warn"
    };
    checks.push(doctor_check(
        "workspace",
        workspace_level,
        "Workspace",
        format!(
            "{} projects · {} sessions · dataRoot {data_root} · mode {}",
            projects.len(),
            sessions.len(),
            settings.session_data_mode
        ),
        serde_json::json!({
            "projectCount": projects.len(),
            "sessionCount": sessions.len(),
            "dataRoot": data_root,
            "sessionDataMode": settings.session_data_mode,
        }),
    ));

    // 4) Backend
    let (backend_level, backend_detail) = if backend_default == "mock_acp" {
        (
            "warn",
            "Using mock ACP backend (dev). Production uses grok_agent_stdio.".to_string(),
        )
    } else {
        (
            "ok",
            format!("Agent backend: {backend_default}"),
        )
    };
    checks.push(doctor_check(
        "backend",
        backend_level,
        "Backend",
        backend_detail,
        serde_json::json!({
            "backendDefault": backend_default,
            "version": env!("CARGO_PKG_VERSION"),
        }),
    ));

    // 5) Logs dir
    let (logs_level, logs_detail) = if log_dir_exists {
        ("ok", format!("Logs directory: {log_dir}"))
    } else {
        (
            "warn",
            format!("Logs directory not created yet: {log_dir}"),
        )
    };
    checks.push(doctor_check(
        "logs",
        logs_level,
        "Logs",
        logs_detail,
        serde_json::json!({
            "dir": log_dir,
            "exists": log_dir_exists,
        }),
    ));

    // Grok Build CLI `doctor --json` (terminal/clipboard/color findings).
    // Runs on a blocking pool so slow/hung CLI cannot stall the async runtime.
    let cli_doctor = tauri::async_runtime::spawn_blocking(run_cli_doctor_json)
        .await
        .unwrap_or_else(|e| {
            serde_json::json!({
                "available": false,
                "error": format!("cli doctor worker panicked: {e}"),
                "report": serde_json::Value::Null,
            })
        });

    let mut ok = 0u32;
    let mut warn = 0u32;
    let mut fail = 0u32;
    for c in &checks {
        match c.level.as_str() {
            "ok" => ok += 1,
            "warn" => warn += 1,
            "fail" => fail += 1,
            _ => {}
        }
    }

    // Flat snapshot also carries CLI doctor for support zip (no secret values).
    let mut raw = raw;
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("cliDoctor".into(), cli_doctor.clone());
    }

    Ok(serde_json::json!({
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "summary": { "ok": ok, "warn": warn, "fail": fail },
        "checks": checks,
        "cliDoctor": cli_doctor,
        "raw": raw,
    }))
}

/// Timeout for `grok doctor --json` (host env probes; keep short).
const CLI_DOCTOR_TIMEOUT_SECS: u64 = 15;

/// Run probed CLI `doctor --json`. Returns a stable envelope for the UI parser.
/// Never includes secret values — only CLI doctor facts/findings/probeNotes.
fn run_cli_doctor_json() -> serde_json::Value {
    match run_grok_cli_args(&["doctor", "--json"], CLI_DOCTOR_TIMEOUT_SECS) {
        Ok((stdout, stderr, status_ok)) => {
            let trimmed = stdout.trim();
            if trimmed.is_empty() {
                // An old CLI rejects `--json` with a raw clap error like
                // `error: unexpected argument '--'`. Surfacing that verbatim tells
                // the user nothing actionable, so map it to the real cause (NEW-03).
                if looks_like_unsupported_flag(&stderr) {
                    return serde_json::json!({
                        "available": false,
                        "error": format!(
                            "grok CLI does not support `doctor --json`; version {} or newer is required",
                            crate::cli_probe::min_cli_version_str()
                        ),
                        "reason": "cli_too_old",
                        "minVersion": crate::cli_probe::min_cli_version_str(),
                        "report": serde_json::Value::Null,
                        "exitOk": status_ok,
                    });
                }
                let detail = if stderr.trim().is_empty() {
                    "grok doctor returned no output".to_string()
                } else {
                    format!("grok doctor returned no JSON: {}", truncate_cli_err(&stderr, 240))
                };
                return serde_json::json!({
                    "available": false,
                    "error": detail,
                    "report": serde_json::Value::Null,
                    "exitOk": status_ok,
                });
            }
            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(report) => serde_json::json!({
                    "available": true,
                    "error": serde_json::Value::Null,
                    "report": report,
                    "exitOk": status_ok,
                }),
                Err(e) => serde_json::json!({
                    "available": false,
                    "error": format!("Failed to parse grok doctor JSON: {e}"),
                    "report": serde_json::Value::Null,
                    "exitOk": status_ok,
                    "stdoutPreview": truncate_cli_err(trimmed, 200),
                }),
            }
        }
        Err(e) => serde_json::json!({
            "available": false,
            "error": e,
            "report": serde_json::Value::Null,
        }),
    }
}

/// Grok endpoints probed by the network self-check (NEW-02 / NEW-07).
const NET_PROBE_TARGETS: &[(&str, &str)] = &[
    ("auth", "https://auth.x.ai/.well-known/openid-configuration"),
    ("chat", "https://cli-chat-proxy.grok.com/"),
    ("api", "https://api.x.ai/"),
];

/// Per-endpoint reachability probe through the effective proxy. Any HTTP
/// response (including 401/404) counts as reachable — we test the network
/// path, not authentication. Short curl-style probes can pass while streaming
/// fails, so this is a hint, not a guarantee.
#[tauri::command]
pub async fn network_probe() -> Result<serde_json::Value, String> {
    let client = crate::proxy::apply_to_reqwest(reqwest::Client::builder())
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("grok-app-net-probe")
        .build()
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for (key, url) in NET_PROBE_TARGETS {
        let started = std::time::Instant::now();
        let out = client.get(*url).send().await;
        let ms = started.elapsed().as_millis() as u64;
        match out {
            Ok(resp) => results.push(serde_json::json!({
                "key": key,
                "url": url,
                "ok": true,
                "status": resp.status().as_u16(),
                "millis": ms,
            })),
            Err(e) => results.push(serde_json::json!({
                "key": key,
                "url": url,
                "ok": false,
                // reqwest errors don't leak proxy credentials in Display.
                "error": e.to_string(),
                "millis": ms,
            })),
        }
    }
    let all_ok = results
        .iter()
        .all(|r| r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
    Ok(serde_json::json!({ "allOk": all_ok, "targets": results }))
}

/// Headless probe: `grok -p … --output-format streaming-json` (CLI ≥ 0.2.117).
/// Soft-gated — older CLIs get a structured "too old" result, not a hard crash.
/// Returns redacted stdout NDJSON for the Diagnostics ACP-NDJSON panel.
#[tauri::command]
pub async fn probe_streaming_acp_ndjson(
    prompt: Option<String>,
    manual_path: Option<String>,
    cwd: Option<String>,
) -> Result<crate::streaming_acp_ndjson::StreamingAcpNdjsonProbeResult, String> {
    // Blocking child wait — offload from the async runtime.
    tokio::task::spawn_blocking(move || {
        crate::streaming_acp_ndjson::run_streaming_acp_ndjson_probe(
            prompt.as_deref(),
            manual_path.as_deref(),
            cwd.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("probe task failed: {e}"))
}

/// Heuristic: stderr shapes an old CLI emits when it rejects a flag the app
/// depends on (clap's `unexpected argument` / `unrecognized option` family).
/// Used to translate raw CLI noise into a "CLI too old" diagnosis (NEW-03).
fn looks_like_unsupported_flag(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("unexpected argument")
        || s.contains("unrecognized option")
        || s.contains("unknown flag")
        || s.contains("unknown option")
        || s.contains("invalid option")
}

fn truncate_cli_err(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let head: String = t.chars().take(max).collect();
    format!("{head}…")
}

/// Write a redacted support zip (Doctor JSON + logs + optional stall timeline) and return its path.
/// Optionally opens a save dialog so the user can pick the destination.
///
/// `stall_timeline_json` is optional Reliability-center snapshot JSON (structured only).
#[tauri::command]
pub async fn export_support_bundle(
    doctor_json: Option<String>,
    stall_timeline_json: Option<String>,
) -> Result<serde_json::Value, String> {
    let doctor = if let Some(j) = doctor_json.filter(|s| !s.trim().is_empty()) {
        j
    } else {
        // Build a fresh report when the UI did not pass one.
        let report = doctor_report().await?;
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    };

    let stall = stall_timeline_json
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());

    // Zip + native save dialog must not block the async runtime (macOS rfd hangs).
    let tmp = tauri::async_runtime::spawn_blocking(move || {
        crate::support_bundle::write_support_bundle(&doctor, stall.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    save_and_reveal_file(
        tmp,
        "Save support bundle",
        "grok-app-support.zip",
        "Zip",
        &["zip"],
    )
    .await
}

/// Full session diagnostic zip: messages, meta, settings, CLI probe, agent trail, logs.
/// Redacts secrets. Opens a save dialog and reveals the file.
#[tauri::command]
pub async fn export_session_bundle(
    session_id: String,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<serde_json::Value, String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("session id is empty".into());
    }
    let runtime = mgr.diagnostic_runtime_for(&sid);
    let sid_for_zip = sid.clone();
    let tmp = tauri::async_runtime::spawn_blocking(move || {
        crate::support_bundle::write_session_bundle(&sid_for_zip, runtime)
    })
    .await
    .map_err(|e| e.to_string())??;
    let short: String = sid.chars().take(8).collect();
    let suggested = format!("grok-app-session-{short}.zip");
    save_and_reveal_file(
        tmp,
        "Save session diagnostic bundle",
        &suggested,
        "Zip",
        &["zip"],
    )
    .await
}

/// Export the Grok Build CLI session trace (`grok trace <agent_id>`).
///
/// - `local_only` (default **true** for safety): when true, pass `--local` so the
///   CLI only writes a local archive. When false, omit `--local` so the CLI may
///   also upload (network).
/// - Resolves `agent_session_id` from live/parked runtime or session meta.
/// - Opens a save dialog for the `.tar.gz` and reveals the file.
/// - Returns `{ ok, path, sizeBytes?, uploaded?, localOnly }` — never secrets/URLs.
/// Export a CLI-linked session transcript via `grok export <agentSessionId> [OUTPUT]`.
///
/// Resolves `agent_session_id` from live/parked runtime or session meta.
/// Returns markdown text for the frontend to download (blob). Callers should
/// soft-fail to the local App journal when this errors (no agent, CLI missing,
/// timeout, etc.).
#[tauri::command]
pub async fn session_cli_export(
    session_id: String,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<serde_json::Value, String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("session id is empty".into());
    }

    let live_agent = mgr.diagnostic_runtime_for(&sid).and_then(|rt| {
        rt.get("agentSessionId")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    });

    tauri::async_runtime::spawn_blocking(move || {
        session_cli_export_blocking(&sid, live_agent.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

const CLI_EXPORT_TIMEOUT_SECS: u64 = 60;

fn session_cli_export_blocking(
    session_id: &str,
    live_agent_session_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let meta = store::load_sessions_index()
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;

    let agent_sid = live_agent_session_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            meta.agent_session_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| {
            "No agent session linked. Start a conversation first so the App has an agent session id."
                .to_string()
        })?;

    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let Some(cli_path) = probe.path.filter(|_| probe.found) else {
        return Err("Grok Build CLI not found".into());
    };
    let grok_home = crate::paths::resolve_agent_grok_home(&settings.session_data_mode);

    let short: String = agent_sid.chars().take(8).collect();
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let tmp = std::env::temp_dir().join(format!("grok-export-{short}-{stamp}.md"));
    let tmp_s = tmp.to_string_lossy().to_string();

    // `grok export <SESSION_ID> [OUTPUT]` — positional output path (not -o).
    let args = vec![
        "export".to_string(),
        agent_sid.clone(),
        tmp_s.clone(),
    ];

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.args(&args);
        cmd.env("GROK_HOME", &grok_home);
        crate::process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = crate::process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        let _ = tx.send(cmd.output());
    });

    let output = match rx.recv_timeout(std::time::Duration::from_secs(CLI_EXPORT_TIMEOUT_SECS)) {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(store::redact_text(&format!("Failed to run grok export: {e}")));
        }
        Err(_) => {
            return Err(format!(
                "grok export timed out after {CLI_EXPORT_TIMEOUT_SECS}s"
            ));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "grok export failed".into()
        };
        return Err(store::redact_text(&msg)
            .trim()
            .chars()
            .take(1200)
            .collect());
    }

    // Prefer the file we asked for; fall back to stdout (CLI may print MD when path fails).
    let markdown = if tmp.is_file() {
        let body = std::fs::read_to_string(&tmp).map_err(|e| {
            store::redact_text(&format!("Failed to read grok export output: {e}"))
        })?;
        let _ = std::fs::remove_file(&tmp);
        body
    } else if !stdout.is_empty() {
        stdout
    } else {
        return Err("grok export succeeded but produced no markdown".into());
    };

    if markdown.trim().is_empty() {
        return Err("grok export produced empty markdown".into());
    }

    Ok(serde_json::json!({
        "ok": true,
        "markdown": markdown,
        "agentSessionId": agent_sid,
        "source": "cli",
    }))
}

/// Export the Grok Build CLI session trace (`grok trace <agent_id> --local`).
/// Resolves `agent_session_id` from live/parked runtime or session meta.
/// Opens a save dialog for the `.tar.gz` and reveals the file.
#[tauri::command]
pub async fn session_trace_export(
    session_id: String,
    local_only: Option<bool>,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<serde_json::Value, String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("session id is empty".into());
    }
    // Default true: local-only is the safe path; upload requires explicit false.
    let local_only = local_only.unwrap_or(true);

    // Prefer live/parked agent id (may be newer than the index), then meta.
    let live_agent = mgr.diagnostic_runtime_for(&sid).and_then(|rt| {
        rt.get("agentSessionId")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    });

    tauri::async_runtime::spawn_blocking(move || {
        session_trace_export_blocking(&sid, live_agent.as_deref(), local_only)
    })
    .await
    .map_err(|e| e.to_string())?
}

const TRACE_EXPORT_TIMEOUT_SECS: u64 = 90;
/// Upload may need extra time for network transfer of large archives.
const TRACE_EXPORT_UPLOAD_TIMEOUT_SECS: u64 = 180;

/// Detect whether CLI JSON indicates a remote upload completed.
/// Presence-only: never returns or stores remote URLs / tokens.
fn trace_cli_reports_uploaded(cli_json: Option<&serde_json::Value>) -> bool {
    let Some(v) = cli_json else {
        return false;
    };
    if v.get("uploaded").and_then(|x| x.as_bool()) == Some(true) {
        return true;
    }
    let status = v
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if matches!(
        status.as_str(),
        "uploaded" | "upload_complete" | "upload-complete" | "ok_uploaded"
    ) {
        return true;
    }
    // Remote info keys — truthy non-empty string means upload path ran.
    // Do not persist these values (may contain URLs).
    for key in ["remote_url", "upload_url", "share_url", "object_path"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if !s.trim().is_empty() {
                return true;
            }
        }
    }
    false
}

fn session_trace_export_blocking(
    session_id: &str,
    live_agent_session_id: Option<&str>,
    local_only: bool,
) -> Result<serde_json::Value, String> {
    let meta = store::load_sessions_index()
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;

    let agent_sid = live_agent_session_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            meta.agent_session_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| {
            "No agent session linked. Start a conversation first so the App has an agent session id."
                .to_string()
        })?;

    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let Some(cli_path) = probe.path.filter(|_| probe.found) else {
        return Err("Grok Build CLI not found".into());
    };
    let grok_home = crate::paths::resolve_agent_grok_home(&settings.session_data_mode);

    let short: String = agent_sid.chars().take(8).collect();
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let tmp = std::env::temp_dir().join(format!("grok-trace-{short}-{stamp}.tar.gz"));
    let tmp_s = tmp.to_string_lossy().to_string();

    // `grok trace <id>` uploads unless `--local`. Default App path keeps `--local`.
    let mut args = vec!["trace".to_string(), agent_sid.clone()];
    if local_only {
        args.push("--local".to_string());
    }
    args.push("-o".to_string());
    args.push(tmp_s.clone());
    args.push("--json".to_string());

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.args(&args);
        cmd.env("GROK_HOME", &grok_home);
        crate::process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = crate::process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        let _ = tx.send(cmd.output());
    });

    let timeout_secs = if local_only {
        TRACE_EXPORT_TIMEOUT_SECS
    } else {
        TRACE_EXPORT_UPLOAD_TIMEOUT_SECS
    };
    let output = match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(store::redact_text(&format!("Failed to run grok trace: {e}")));
        }
        Err(_) => {
            return Err(format!("grok trace timed out after {timeout_secs}s"));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "grok trace failed".into()
        };
        return Err(store::redact_text(&msg)
            .trim()
            .chars()
            .take(1200)
            .collect());
    }

    let cli_json = serde_json::from_str::<serde_json::Value>(&stdout).ok();
    // Only claim uploaded when we intentionally allowed network upload.
    let uploaded = !local_only && trace_cli_reports_uploaded(cli_json.as_ref());

    // Prefer the archive we asked for; fall back to JSON local_path from CLI.
    let archive = if tmp.is_file() {
        tmp
    } else {
        let from_json = cli_json.as_ref().and_then(|v| {
            v.get("local_path")
                .and_then(|p| p.as_str())
                .map(std::path::PathBuf::from)
        });
        match from_json {
            Some(p) if p.is_file() => p,
            _ => {
                let detail = if !stdout.is_empty() {
                    store::redact_text(&stdout)
                } else {
                    "archive file not created".into()
                };
                return Err(format!(
                    "grok trace succeeded but archive missing: {}",
                    detail.trim().chars().take(400).collect::<String>()
                ));
            }
        }
    };

    let suggested = format!("grok-trace-{short}.tar.gz");
    // Already on a blocking thread (session_trace_export spawns us).
    let mut result = save_and_reveal_file_blocking(
        archive,
        "Save session trace",
        &suggested,
        "Trace archive",
        &["tar.gz".into(), "gz".into(), "tgz".into()],
    )?;
    if let Some(obj) = result.as_object_mut() {
        obj.insert("localOnly".into(), serde_json::json!(local_only));
        // Paths-only history may note uploaded=true; never attach remote URLs.
        if uploaded {
            obj.insert("uploaded".into(), serde_json::json!(true));
        }
    }
    Ok(result)
}

/// Save arbitrary bytes via native save dialog (share-card PNG, etc.).
/// Returns `{ ok, path, cancelled }`. Cancel → `ok:false, cancelled:true` (not an error).
#[tauri::command]
pub async fn export_bytes_save(
    bytes_base64: String,
    default_name: String,
    dialog_title: Option<String>,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let raw = bytes_base64.trim();
    if raw.is_empty() {
        return Err("export payload is empty".into());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("invalid base64: {e}"))?;
    if bytes.is_empty() {
        return Err("export payload is empty".into());
    }
    // Soft cap ~40 MiB decoded — share cards stay well under this.
    if bytes.len() > 40 * 1024 * 1024 {
        return Err("export payload too large".into());
    }

    let name = default_name.trim();
    let name = if name.is_empty() {
        "export.bin".to_string()
    } else {
        // Keep basename only (no path separators).
        name.replace(['/', '\\'], "_")
    };
    let title = dialog_title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Save file")
        .to_string();
    let filter = filter_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("File")
        .to_string();
    let exts: Vec<String> = extensions
        .unwrap_or_else(|| vec!["bin".into()])
        .into_iter()
        .map(|s| s.trim().trim_start_matches('.').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let exts = if exts.is_empty() {
        vec!["bin".into()]
    } else {
        exts
    };

    tauri::async_runtime::spawn_blocking(move || {
        let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        let dest = rfd::FileDialog::new()
            .set_title(&title)
            .set_file_name(&name)
            .add_filter(&filter, &ext_refs)
            .save_file();

        let Some(path) = dest else {
            return Ok(serde_json::json!({
                "ok": false,
                "cancelled": true,
                "path": serde_json::Value::Null,
            }));
        };

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create parent dir: {e}"))?;
        }
        std::fs::write(&path, &bytes).map_err(|e| format!("write file: {e}"))?;

        let path_s = path.display().to_string();
        #[cfg(target_os = "macos")]
        {
            let _ = crate::process_util::command("open")
                .args(["-R", &path_s])
                .status();
        }
        #[cfg(target_os = "windows")]
        {
            let _ = crate::process_util::command("explorer")
                .args(["/select,", &path_s])
                .status();
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            if let Some(parent) = path.parent() {
                let _ = crate::process_util::command("xdg-open")
                    .arg(parent)
                    .spawn();
            }
        }

        Ok(serde_json::json!({
            "ok": true,
            "cancelled": false,
            "path": path_s,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save dialog + reveal. Always runs rfd/copy on a blocking thread so async
/// commands (export bundle/trace) do not hang on macOS when the dialog needs
/// main-thread affinity via spawn_blocking.
async fn save_and_reveal_file(
    tmp: std::path::PathBuf,
    dialog_title: &str,
    fallback_name: &str,
    filter_name: &str,
    extensions: &[&str],
) -> Result<serde_json::Value, String> {
    let dialog_title = dialog_title.to_string();
    let fallback_name = fallback_name.to_string();
    let filter_name = filter_name.to_string();
    let extensions: Vec<String> = extensions.iter().map(|s| (*s).to_string()).collect();

    tauri::async_runtime::spawn_blocking(move || {
        save_and_reveal_file_blocking(
            tmp,
            &dialog_title,
            &fallback_name,
            &filter_name,
            &extensions,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn save_and_reveal_file_blocking(
    tmp: std::path::PathBuf,
    dialog_title: &str,
    fallback_name: &str,
    filter_name: &str,
    extensions: &[String],
) -> Result<serde_json::Value, String> {
    let suggested = tmp
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(fallback_name)
        .to_string();
    let ext_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let dest = rfd::FileDialog::new()
        .set_title(dialog_title)
        .set_file_name(&suggested)
        .add_filter(filter_name, &ext_refs)
        .save_file();

    let final_path = if let Some(dest) = dest {
        std::fs::copy(&tmp, &dest).map_err(|e| format!("copy archive: {e}"))?;
        let _ = std::fs::remove_file(&tmp);
        dest
    } else {
        // User cancelled: keep temp zip and still return path so UI can open it.
        tmp
    };

    let path_s = final_path.display().to_string();
    // Cheap metadata only — never read archive contents into the App.
    let size_bytes = std::fs::metadata(&final_path).ok().map(|m| m.len());
    #[cfg(target_os = "macos")]
    {
        let _ = crate::process_util::command("open")
            .args(["-R", &path_s])
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = crate::process_util::command("explorer")
            .args(["/select,", &path_s])
            .status();
    }

    Ok(serde_json::json!({
        "ok": true,
        "path": path_s,
        "sizeBytes": size_bytes,
    }))
}

/// Wipe App data under the data root (sessions, projects, settings).
/// Does not touch the CLI home (`~/.grok`). Double-confirm in the UI before calling.
#[tauri::command]
pub async fn reset_app_data(
    app: tauri::AppHandle,
    keep_secrets: Option<bool>,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<serde_json::Value, String> {
    // Drop live agent first so session files are not mid-write.
    let _ = mgr.disconnect(app).await;
    let keep = keep_secrets.unwrap_or(true);
    crate::support_bundle::reset_app_data(keep)
}

// ── Skills / MCP via `grok inspect --json` ──────────────────────────────────

const INSPECT_TIMEOUT_SECS: u64 = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDto {
    pub name: String,
    pub description: String,
    /// Normalized source type string (e.g. "user", "project", "plugin").
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub user_invocable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDto {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility_status: Option<String>,
}

/// Run probed CLI: `grok inspect --json` with optional project cwd.
/// Returns (parsed JSON, error message). Never panics; empty on failure.
fn run_grok_inspect(project_path: Option<&str>) -> (Option<serde_json::Value>, Option<String>) {
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let Some(cli_path) = probe.path.filter(|_| probe.found) else {
        return (None, Some("Grok Build CLI not found".into()));
    };

    let cwd = project_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.arg("inspect").arg("--json");
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        crate::process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = crate::process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        let result = cmd.output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(INSPECT_TIMEOUT_SECS)) {
        Ok(Ok(output)) => {
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let msg = if err.is_empty() {
                    format!("grok inspect exited with {}", output.status)
                } else {
                    // Truncate; never log secrets (inspect should not print keys)
                    err.chars().take(400).collect()
                };
                return (None, Some(msg));
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            match serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                Ok(v) => (Some(v), None),
                Err(e) => (None, Some(format!("Failed to parse grok inspect JSON: {e}"))),
            }
        }
        Ok(Err(e)) => (None, Some(format!("Failed to run grok inspect: {e}"))),
        Err(_) => (None, Some(format!(
            "grok inspect timed out after {INSPECT_TIMEOUT_SECS}s"
        ))),
    }
}

fn normalize_skill_source(source: &serde_json::Value) -> (String, Option<String>) {
    if let Some(s) = source.as_str() {
        return (s.to_string(), None);
    }
    if let Some(obj) = source.as_object() {
        let ty = obj
            .get("type")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string();
        let path = obj
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        return (ty, path);
    }
    ("unknown".into(), None)
}

fn parse_skills(v: &serde_json::Value) -> Vec<SkillDto> {
    let Some(arr) = v.get("skills").and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let description = item
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let (source, path_from_source) =
            normalize_skill_source(item.get("source").unwrap_or(&serde_json::Value::Null));
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .or(path_from_source);
        // Missing field ⇒ treat as invocable. Only explicit `false` hides a skill
        // from the composer/slash picker (agent-only / disable-model-invocation).
        let user_invocable = item
            .get("userInvocable")
            .or_else(|| item.get("user_invocable"))
            .or_else(|| item.get("user-invocable"))
            .and_then(|x| x.as_bool())
            .unwrap_or(true);
        out.push(SkillDto {
            name,
            description,
            source,
            path,
            user_invocable,
        });
    }
    out
}

fn parse_mcp_servers(v: &serde_json::Value) -> Vec<McpDto> {
    let Some(arr) = v
        .get("mcpServers")
        .or_else(|| v.get("mcp"))
        .and_then(|x| x.as_array())
    else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let transport = item
            .get("transport")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let target = item
            .get("target")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let vendor = item
            .get("vendor")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let compatibility_status = item
            .get("compatibilityStatus")
            .or_else(|| item.get("compatibility_status"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        out.push(McpDto {
            name,
            transport,
            target,
            vendor,
            compatibility_status,
        });
    }
    out
}

/// List invocable skills from `grok inspect --json`.
/// Always returns Ok; on CLI missing / timeout, `skills` is empty and `error` is set.
/// Each skill includes `enabled` from App Extensions prefs (default true).
#[tauri::command]
pub async fn skills_list(project_path: Option<String>) -> Result<serde_json::Value, String> {
    let path = project_path.clone();
    let (parsed, error) = tauri::async_runtime::spawn_blocking(move || {
        run_grok_inspect(path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;

    let skills = parsed.as_ref().map(parse_skills).unwrap_or_default();
    let skills = attach_skill_enabled(skills);
    let skill_roots = crate::skill_edit::skill_roots_list(project_path.as_deref());
    let mut out = serde_json::json!({
        "skills": skills,
        "skillRoots": skill_roots,
    });
    if let Some(err) = error {
        out["error"] = serde_json::Value::String(err);
    }
    Ok(out)
}

/// Read a user-editable SKILL.md (allowlisted skills roots only).
#[tauri::command]
pub async fn skill_read(
    path: String,
    project_path: Option<String>,
) -> Result<crate::skill_edit::SkillReadResult, String> {
    let path = path.clone();
    let project_path = project_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::skill_edit::skill_read(&path, project_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a user-editable SKILL.md (allowlisted skills roots only).
#[tauri::command]
pub async fn skill_write(
    path: String,
    content: String,
    expected_mtime_ms: Option<u64>,
    project_path: Option<String>,
) -> Result<crate::skill_edit::SkillWriteResult, String> {
    let path = path.clone();
    let content = content.clone();
    let project_path = project_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::skill_edit::skill_write(
            &path,
            &content,
            expected_mtime_ms,
            project_path.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Absolute paths of allowlisted skill roots (for UI edit affordances).
#[tauri::command]
pub async fn skill_roots(project_path: Option<String>) -> Result<Vec<String>, String> {
    Ok(crate::skill_edit::skill_roots_list(project_path.as_deref()))
}

/// Scaffold a new skill directory + SKILL.md under user (path-scoped GROK_HOME)
/// or project skills root. Does not overwrite an existing SKILL.md.
#[tauri::command]
pub async fn skill_create(
    name: String,
    description: Option<String>,
    project_path: Option<String>,
    scope: Option<String>,
) -> Result<crate::skill_edit::SkillCreateResult, String> {
    let name = name.clone();
    let description = description.unwrap_or_default();
    let project_path = project_path.clone();
    let scope = scope.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::skill_edit::skill_create(
            &name,
            &description,
            project_path.as_deref(),
            scope.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List MCP servers from `grok inspect --json`.
/// Always returns Ok; on CLI missing / timeout, `servers` is empty and `error` is set.
/// Each server includes `enabled` from App Extensions prefs (default true).
#[tauri::command]
pub async fn inspect_mcp(project_path: Option<String>) -> Result<serde_json::Value, String> {
    let path = project_path.clone();
    let (parsed, error) = tauri::async_runtime::spawn_blocking(move || {
        run_grok_inspect(path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut servers = parsed.as_ref().map(parse_mcp_servers).unwrap_or_default();
    let prefs = crate::extensions::load_prefs();
    // Enrich with enable state for UI toggles.
    let mut server_json = Vec::with_capacity(servers.len());
    for s in servers.drain(..) {
        let enabled = crate::extensions::is_enabled(&prefs.mcp, &s.name);
        server_json.push(serde_json::json!({
            "name": s.name,
            "transport": s.transport,
            "target": s.target,
            "vendor": s.vendor,
            "compatibilityStatus": s.compatibility_status,
            "enabled": enabled,
        }));
    }
    let mut out = serde_json::json!({ "servers": server_json });
    if let Some(err) = error {
        out["error"] = serde_json::Value::String(err);
    }
    Ok(out)
}

// ── Project inspect summary (Settings → Runtime) ─────────────────────────────

const PROJECT_INSPECT_SKILL_SAMPLE: usize = 12;

/// Detect `<project>/.grok` when the path is a real directory.
fn project_grok_dir(project_path: Option<&str>) -> (bool, Option<String>) {
    let Some(raw) = project_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return (false, None);
    };
    let p = std::path::Path::new(raw).join(".grok");
    if p.is_dir() {
        (true, Some(p.to_string_lossy().to_string()))
    } else {
        (false, Some(p.to_string_lossy().to_string()))
    }
}

fn json_str(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn skill_source_label(source: &serde_json::Value) -> String {
    if let Some(s) = source.as_str() {
        return s.trim().to_lowercase();
    }
    if let Some(obj) = source.as_object() {
        if let Some(t) = obj.get("type").and_then(|x| x.as_str()) {
            return t.trim().to_lowercase();
        }
    }
    "unknown".into()
}

/// Build a secret-safe summary DTO from `grok inspect --json`.
/// Only known safe fields are copied — never forward raw env/headers/secrets.
fn build_project_inspect_summary(
    parsed: Option<&serde_json::Value>,
    project_path: Option<&str>,
    error: Option<String>,
    models_hints: Vec<String>,
) -> serde_json::Value {
    let (has_grok, grok_path) = project_grok_dir(project_path);
    let path_trim = project_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let mut models_hints = models_hints;
    let mut seen_models: std::collections::HashSet<String> =
        models_hints.iter().cloned().collect();
    let mut push_model = |s: String| {
        let t = s.trim().to_string();
        if t.is_empty() || seen_models.contains(&t) {
            return;
        }
        seen_models.insert(t.clone());
        models_hints.push(t);
    };

    let Some(v) = parsed else {
        return serde_json::json!({
            "projectPath": path_trim,
            "projectRoot": null,
            "projectTrusted": null,
            "cwd": null,
            "grokVersion": null,
            "channel": null,
            "hasProjectGrokDir": has_grok,
            "projectGrokPath": if has_grok { grok_path } else { None::<String> },
            "rules": [],
            "plugins": [],
            "skills": {
                "total": 0,
                "userInvocable": 0,
                "bySource": {},
                "sample": [],
                "names": [],
            },
            "mcp": [],
            "agents": [],
            "hooks": [],
            "hooksCount": 0,
            "configLayers": [],
            "modelsHints": models_hints,
            "permissions": {
                "loaded": 0,
                "sourcesCount": 0,
                "managedSettingsActive": false,
                "managedSettingsExists": null,
                "managedSettingsPath": null,
            },
            "error": error,
        });
    };

    let project_root = json_str(v.get("projectRoot"));
    let project_path_out = path_trim
        .clone()
        .or_else(|| project_root.clone());

    // Rules / project instructions — paths only.
    let mut rules = Vec::new();
    let instr = v
        .get("projectInstructions")
        .or_else(|| v.get("rules"))
        .and_then(|x| x.as_array());
    if let Some(arr) = instr {
        for item in arr {
            let path = json_str(item.get("path"));
            let Some(path) = path else { continue };
            rules.push(serde_json::json!({
                "path": path,
                "scope": json_str(item.get("scope")),
                "fileType": json_str(item.get("fileType"))
                    .or_else(|| json_str(item.get("file_type"))),
                "sizeBytes": item.get("sizeBytes").and_then(|x| x.as_u64())
                    .or_else(|| item.get("size_bytes").and_then(|x| x.as_u64())),
            }));
        }
    }

    // Plugins — no free-form blobs.
    let mut plugins = Vec::new();
    if let Some(arr) = v.get("plugins").and_then(|x| x.as_array()) {
        for item in arr {
            let name = json_str(item.get("name"));
            let Some(name) = name else { continue };
            let provides = item.get("provides").map(|p| {
                serde_json::json!({
                    "skills": p.get("skills").and_then(|x| x.as_u64()).unwrap_or(0),
                    "agents": p.get("agents").and_then(|x| x.as_u64()).unwrap_or(0),
                    "hooks": p.get("hooks").and_then(|x| x.as_bool()).unwrap_or(false),
                    "mcpServers": p.get("mcpServers")
                        .or_else(|| p.get("mcp_servers"))
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0),
                })
            });
            plugins.push(serde_json::json!({
                "name": name,
                "scope": json_str(item.get("scope")),
                "enabled": item.get("enabled").and_then(|x| x.as_bool()),
                "path": json_str(item.get("path")),
                "provides": provides,
            }));
        }
    }

    // Skills — counts + all names + short invocable sample (no descriptions).
    let mut by_source: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut user_invocable: u64 = 0;
    let mut sample_names: Vec<String> = Vec::new();
    let mut all_skill_names: Vec<String> = Vec::new();
    let skill_arr = v.get("skills").and_then(|x| x.as_array());
    let skill_total = skill_arr.map(|a| a.len()).unwrap_or(0);
    if let Some(arr) = skill_arr {
        for item in arr {
            let name = json_str(item.get("name"));
            let Some(name) = name else { continue };
            all_skill_names.push(name.clone());
            let src = skill_source_label(
                item.get("source").unwrap_or(&serde_json::Value::Null),
            );
            let count = by_source
                .get(&src)
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            by_source.insert(src, serde_json::json!(count + 1));
            let inv = item
                .get("userInvocable")
                .or_else(|| item.get("user_invocable"))
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            if inv {
                user_invocable += 1;
                sample_names.push(name);
            }
        }
    }
    sample_names.sort();
    sample_names.truncate(PROJECT_INSPECT_SKILL_SAMPLE);
    all_skill_names.sort();

    // MCP — name/transport/target/source type only (never env/headers).
    let mut mcp = Vec::new();
    let mcp_arr = v
        .get("mcpServers")
        .or_else(|| v.get("mcp"))
        .and_then(|x| x.as_array());
    if let Some(arr) = mcp_arr {
        for item in arr {
            let name = json_str(item.get("name"));
            let Some(name) = name else { continue };
            let source = item
                .get("source")
                .map(|s| skill_source_label(s))
                .filter(|s| s != "unknown");
            mcp.push(serde_json::json!({
                "name": name,
                "transport": json_str(item.get("transport")),
                "target": json_str(item.get("target")),
                "source": source,
            }));
        }
    }

    // Agents
    let mut agents = Vec::new();
    if let Some(arr) = v.get("agents").and_then(|x| x.as_array()) {
        for item in arr {
            let name = json_str(item.get("name"));
            let Some(name) = name else { continue };
            let source = skill_source_label(
                item.get("source").unwrap_or(&serde_json::Value::Null),
            );
            agents.push(serde_json::json!({
                "name": name,
                "source": source,
            }));
        }
    }

    // Hooks — event / type / target / source type only (no env / command bodies).
    let mut hooks = Vec::new();
    if let Some(arr) = v.get("hooks").and_then(|x| x.as_array()) {
        for item in arr {
            if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                hooks.push(serde_json::json!({ "event": s }));
                continue;
            }
            let Some(obj) = item.as_object() else { continue };
            let event = json_str(obj.get("event")).or_else(|| json_str(obj.get("name")));
            let hook_type = json_str(obj.get("hookType"))
                .or_else(|| json_str(obj.get("hook_type")))
                .or_else(|| json_str(obj.get("type")));
            let target = json_str(obj.get("target")).or_else(|| json_str(obj.get("path")));
            let source = obj
                .get("source")
                .map(skill_source_label)
                .or_else(|| json_str(obj.get("plugin")));
            let matcher = json_str(obj.get("matcher"));
            if event.is_none() && hook_type.is_none() && target.is_none() {
                continue;
            }
            hooks.push(serde_json::json!({
                "event": event,
                "hookType": hook_type,
                "target": target,
                "source": source,
                "matcher": matcher,
            }));
        }
    }

    // Config layers — paths only.
    let mut config_layers = Vec::new();
    if let Some(layers) = v
        .get("configSources")
        .and_then(|x| x.get("layers"))
        .and_then(|x| x.as_array())
    {
        for item in layers {
            config_layers.push(serde_json::json!({
                "role": json_str(item.get("role")),
                "path": json_str(item.get("path")),
            }));
        }
    }

    // Permissions — counts/flags only (no allowlist bodies that might embed tokens).
    let perm = v.get("permissions");
    let sources_count = perm
        .and_then(|p| p.get("sources"))
        .and_then(|x| x.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let loaded = perm
        .and_then(|p| p.get("loaded"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let managed_active = perm
        .and_then(|p| p.get("managedSettingsActive"))
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let managed_exists = perm
        .and_then(|p| p.get("managedSettingsExists"))
        .and_then(|x| x.as_bool());
    let managed_path = perm
        .and_then(|p| p.get("managedSettingsPath"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| store::redact_text(s).trim().chars().take(400).collect::<String>());

    // Models hints from inspect when present.
    if let Some(arr) = v.get("models").and_then(|x| x.as_array()) {
        for m in arr {
            if let Some(s) = m.as_str() {
                push_model(s.to_string());
            } else if let Some(id) = json_str(m.get("id"))
                .or_else(|| json_str(m.get("name")))
                .or_else(|| json_str(m.get("model")))
            {
                push_model(id);
            }
        }
    }
    if let Some(ch) = json_str(v.get("channel")) {
        if ch != "unknown" {
            push_model(format!("channel:{ch}"));
        }
    }
    if let Some(dm) = json_str(v.get("defaultModel"))
        .or_else(|| json_str(v.get("default_model")))
    {
        push_model(dm);
    }

    let hooks_count = if !hooks.is_empty() {
        hooks.len()
    } else {
        v.get("hooks")
            .and_then(|x| x.as_array())
            .map(|a| a.len())
            .unwrap_or(0)
    };

    let mut out = serde_json::json!({
        "projectPath": project_path_out,
        "projectRoot": project_root,
        "projectTrusted": v.get("projectTrusted").and_then(|x| x.as_bool()),
        "cwd": json_str(v.get("cwd")),
        "grokVersion": json_str(v.get("grokVersion"))
            .or_else(|| json_str(v.get("grok_version"))),
        "channel": json_str(v.get("channel")),
        "hasProjectGrokDir": has_grok,
        "projectGrokPath": if has_grok { grok_path } else { None::<String> },
        "rules": rules,
        "plugins": plugins,
        "skills": {
            "total": skill_total,
            "userInvocable": user_invocable,
            "bySource": by_source,
            "sample": sample_names,
            "names": all_skill_names,
        },
        "mcp": mcp,
        "agents": agents,
        "hooks": hooks,
        "hooksCount": hooks_count,
        "configLayers": config_layers,
        "modelsHints": models_hints,
        "permissions": {
            "loaded": loaded,
            "sourcesCount": sources_count,
            "managedSettingsActive": managed_active,
            "managedSettingsExists": managed_exists,
            "managedSettingsPath": managed_path,
        },
    });
    if let Some(err) = error {
        // Scrub any token-shaped substrings in error text.
        out["error"] = serde_json::Value::String(crate::store::redact_text(&err));
    } else {
        out["error"] = serde_json::Value::Null;
    }
    out
}

/// Full project inspect summary for Settings → Runtime.
/// Runs `grok inspect --json` with optional project cwd; returns a sanitized DTO
/// (plugins / skills counts / MCP / rules paths / model hints). Never includes secrets.
#[tauri::command]
pub async fn project_inspect(project_path: Option<String>) -> Result<serde_json::Value, String> {
    let path = project_path.clone();
    let (parsed, error) = tauri::async_runtime::spawn_blocking(move || {
        run_grok_inspect(path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;

    // Model ids from local cache (hints only — not secrets).
    let models_hints: Vec<String> = {
        let catalog = crate::models_catalog::list_available_models();
        let mut hints = Vec::new();
        if !catalog.default_model_id.trim().is_empty() {
            hints.push(catalog.default_model_id.clone());
        }
        for m in catalog.models.iter().take(8) {
            if !hints.iter().any(|h| h == &m.id) {
                hints.push(m.id.clone());
            }
        }
        hints
    };

    Ok(build_project_inspect_summary(
        parsed.as_ref(),
        project_path.as_deref(),
        error,
        models_hints,
    ))
}

/// List skills from `grok inspect --json`, each with App `enabled` (default true).
/// (skills_list already exists; this keeps enable flags on the existing shape.)
fn attach_skill_enabled(skills: Vec<SkillDto>) -> Vec<serde_json::Value> {
    let prefs = crate::extensions::load_prefs();
    skills
        .into_iter()
        .map(|s| {
            let enabled = crate::extensions::is_enabled(&prefs.skills, &s.name);
            serde_json::json!({
                "name": s.name,
                "description": s.description,
                "source": s.source,
                "path": s.path,
                "userInvocable": s.user_invocable,
                "enabled": enabled,
            })
        })
        .collect()
}

/// Current Extensions enable prefs (`extensions.json`).
#[tauri::command]
pub async fn extensions_get() -> Result<crate::extensions::ExtensionsPrefs, String> {
    Ok(crate::extensions::load_prefs())
}

/// Toggle one MCP server; persists prefs, syncs agent-home/config, soft-respawns.
#[tauri::command]
pub async fn extensions_set_mcp(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
    enabled: bool,
) -> Result<crate::extensions::ExtensionsPrefs, String> {
    let prefs = tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::set_mcp_enabled(&name, enabled)
    })
    .await
    .map_err(|e| e.to_string())??;
    mgr.apply_extensions_mcp_change(&app).await;
    Ok(prefs)
}

/// Toggle one skill (App filter for slash/composer); persists immediately.
#[tauri::command]
pub async fn extensions_set_skill(
    name: String,
    enabled: bool,
) -> Result<crate::extensions::ExtensionsPrefs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::set_skill_enabled(&name, enabled)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bulk-enable all listed MCP servers; soft-respawns when a live agent exists.
#[tauri::command]
pub async fn extensions_enable_all_mcp(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    names: Vec<String>,
) -> Result<crate::extensions::ExtensionsPrefs, String> {
    let prefs = tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::enable_all_mcp(&names)
    })
    .await
    .map_err(|e| e.to_string())??;
    mgr.apply_extensions_mcp_change(&app).await;
    Ok(prefs)
}

/// Bulk-enable all listed skills.
#[tauri::command]
pub async fn extensions_enable_all_skills(
    names: Vec<String>,
) -> Result<crate::extensions::ExtensionsPrefs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::enable_all_skills(&names)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Plugins via Grok Build CLI (`grok plugin …` + `inspect` + config.toml) ──
//
// Keep field semantics aligned with Grok Build:
// - install inventory: `grok plugin list --json` (status/name/version/source/…)
// - enable/disable: `~/.grok/config.toml` `[plugins].disabled` / CLI enable|disable
// - scope + component counts: `grok inspect --json` → `plugins[]`
// Do not invent a parallel store or rewrite CLI `status` values.

const PLUGIN_CMD_TIMEOUT_SECS: u64 = 30;
/// Install / update pull git or marketplace cache; allow longer than enable/list.
const PLUGIN_MUTATE_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProvidesDto {
    #[serde(default)]
    pub skills: u32,
    #[serde(default)]
    pub agents: u32,
    #[serde(default)]
    pub hooks: bool,
    #[serde(default)]
    pub mcp_servers: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDto {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Install status from `plugin list --json` (usually `"installed"`). Not enable/disable.
    pub status: String,
    /// Load state from Grok Build config (`[plugins].disabled` / enable CLI).
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_key: Option<String>,
    /// Grok Build scope: user / project / cli / custom path / marketplace name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Component inventory from `grok inspect` (skills / agents / hooks / mcp).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provides: Option<PluginProvidesDto>,
}

/// Run probed CLI with the given args. Returns (stdout, stderr, ok).
fn run_grok_cli_args(args: &[&str], timeout_secs: u64) -> Result<(String, String, bool), String> {
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let Some(cli_path) = probe.path.filter(|_| probe.found) else {
        return Err("Grok Build CLI not found".into());
    };

    let args_owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.args(&args_owned);
        crate::process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = crate::process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        let result = cmd.output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Ok((stdout, stderr, output.status.success()))
        }
        Ok(Err(e)) => Err(format!("Failed to run grok: {e}")),
        Err(_) => Err(format!("grok command timed out after {timeout_secs}s")),
    }
}

/// Path to the user-level Grok config that tracks plugin enable/disable.
/// Same file Grok Build reads for `[plugins].enabled` / `[plugins].disabled`.
fn user_grok_config_toml() -> std::path::PathBuf {
    crate::process_util::user_home().join(".grok").join("config.toml")
}

/// Parse a string-array key under `[plugins]` (single- or multi-line).
pub fn parse_plugins_toml_string_array(toml_text: &str, key: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let mut in_plugins = false;
    let mut collecting = false;
    let mut buf = String::new();
    let key_prefix = key;

    for line in toml_text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if collecting {
                break;
            }
            in_plugins = trimmed == "[plugins]";
            continue;
        }
        if !in_plugins {
            continue;
        }
        if collecting {
            buf.push(' ');
            buf.push_str(trimmed);
            if trimmed.contains(']') {
                collecting = false;
                for name in extract_toml_string_array(&buf) {
                    out.insert(name);
                }
                buf.clear();
            }
            continue;
        }
        if let Some(rest) = trimmed
            .strip_prefix(key_prefix)
            .map(str::trim)
            .and_then(|s| s.strip_prefix('='))
            .map(str::trim)
        {
            if rest.contains('[') && rest.contains(']') {
                for name in extract_toml_string_array(rest) {
                    out.insert(name);
                }
            } else if rest.contains('[') {
                collecting = true;
                buf = rest.to_string();
            }
        }
    }
    out
}

/// Grok Build config: plugin IDs or plain names listed under `[plugins].disabled`.
pub fn parse_plugins_disabled_names(toml_text: &str) -> std::collections::HashSet<String> {
    parse_plugins_toml_string_array(toml_text, "disabled")
}

fn extract_toml_string_array(s: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            let quote = c;
            let mut name = String::new();
            while let Some(ch) = chars.next() {
                if ch == quote {
                    break;
                }
                if ch == '\\' {
                    if let Some(escaped) = chars.next() {
                        name.push(escaped);
                    }
                } else {
                    name.push(ch);
                }
            }
            let n = name.trim();
            if !n.is_empty() {
                names.push(n.to_string());
            }
        }
    }
    names
}

fn load_disabled_plugin_entries() -> std::collections::HashSet<String> {
    let path = user_grok_config_toml();
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_plugins_disabled_names(&text),
        Err(_) => std::collections::HashSet::new(),
    }
}

/// Match Grok Build disabled entries: plain name or full id `scope/hash/name`.
pub fn plugin_matches_disabled(
    name: &str,
    repo_key: Option<&str>,
    disabled: &std::collections::HashSet<String>,
) -> bool {
    if disabled.is_empty() {
        return false;
    }
    if disabled.contains(name) {
        return true;
    }
    for entry in disabled {
        let e = entry.trim();
        if e.is_empty() {
            continue;
        }
        // Full plugin id: <scope>/<hash>/<name>
        if let Some((head, tail)) = e.rsplit_once('/') {
            if tail == name {
                // Optional: also match hash against repo_key suffix
                if let Some(rk) = repo_key {
                    if head.ends_with(rk) || rk.ends_with(head.rsplit_once('/').map(|(_, h)| h).unwrap_or(head)) {
                        return true;
                    }
                }
                return true;
            }
        }
        if let Some(rk) = repo_key {
            if e == rk || e.ends_with(&format!("/{rk}")) {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone, Default)]
struct InspectPluginExtra {
    scope: Option<String>,
    provides: Option<PluginProvidesDto>,
}

fn parse_inspect_plugins_map(
    inspect_json: &serde_json::Value,
) -> std::collections::HashMap<String, InspectPluginExtra> {
    let mut map = std::collections::HashMap::new();
    let Some(arr) = inspect_json.get("plugins").and_then(|x| x.as_array()) else {
        return map;
    };
    for item in arr {
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let scope = item
            .get("scope")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let provides = item.get("provides").map(|p| PluginProvidesDto {
            skills: p
                .get("skills")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
            agents: p
                .get("agents")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
            hooks: p.get("hooks").and_then(|x| x.as_bool()).unwrap_or(false),
            mcp_servers: p
                .get("mcpServers")
                .or_else(|| p.get("mcp_servers"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
        });
        let extra = InspectPluginExtra { scope, provides };
        // Key by name and path so duplicate names (e.g. two cloudflare installs) can match path.
        map.insert(name.clone(), extra.clone());
        if let Some(p) = path {
            map.insert(format!("path:{p}"), extra);
        }
    }
    map
}

fn parse_plugin_list_json(
    raw: &str,
    disabled: &std::collections::HashSet<String>,
    inspect_extra: &std::collections::HashMap<String, InspectPluginExtra>,
) -> Result<Vec<PluginDto>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Failed to parse plugin list JSON: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "plugin list JSON is not an array".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let version = item
            .get("version")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let source = item
            .get("source")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let marketplace = item
            .get("marketplace")
            .and_then(|x| {
                if x.is_null() {
                    None
                } else {
                    x.as_str()
                }
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let repo_key = item
            .get("repo_key")
            .or_else(|| item.get("repoKey"))
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        // Preserve CLI install status verbatim (do not invent "disabled" status).
        let status = item
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("installed")
            .trim()
            .to_string();
        let status = if status.is_empty() {
            "installed".to_string()
        } else {
            status
        };
        let enabled = !plugin_matches_disabled(&name, repo_key.as_deref(), disabled);

        // Prefer path-keyed inspect row, then name.
        let extra = path
            .as_ref()
            .and_then(|p| inspect_extra.get(&format!("path:{p}")))
            .or_else(|| inspect_extra.get(&name));

        // Scope: inspect first, else marketplace name, else "user" for installed-plugins paths.
        let scope = extra
            .and_then(|e| e.scope.clone())
            .or_else(|| marketplace.clone())
            .or_else(|| {
                path.as_ref().and_then(|p| {
                    if p.contains("installed-plugins") {
                        Some("user".into())
                    } else {
                        None
                    }
                })
            });

        out.push(PluginDto {
            name,
            version,
            source,
            marketplace,
            path,
            status,
            enabled,
            repo_key,
            scope,
            provides: extra.and_then(|e| e.provides.clone()),
        });
    }
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| {
                a.repo_key
                    .as_deref()
                    .unwrap_or("")
                    .cmp(b.repo_key.as_deref().unwrap_or(""))
            })
    });
    Ok(out)
}

fn collect_plugins_list() -> Result<Vec<PluginDto>, String> {
    // Parallel: install inventory + inspect enrich (scope/provides).
    let list_handle = std::thread::spawn(|| {
        run_grok_cli_args(&["plugin", "list", "--json"], PLUGIN_CMD_TIMEOUT_SECS)
    });
    let inspect_handle =
        std::thread::spawn(|| run_grok_cli_args(&["inspect", "--json"], INSPECT_TIMEOUT_SECS));

    let list_result = list_handle
        .join()
        .map_err(|_| "plugin list worker panicked".to_string())?;
    let (stdout, stderr, ok) = list_result?;
    if !ok {
        let msg: String = if !stderr.is_empty() {
            stderr.chars().take(400).collect()
        } else if !stdout.is_empty() {
            stdout.chars().take(400).collect()
        } else {
            "grok plugin list failed".into()
        };
        return Err(msg);
    }
    if stdout.is_empty() {
        return Ok(Vec::new());
    }
    let disabled = load_disabled_plugin_entries();
    // Best-effort inspect enrich. Failures leave scope/provides empty.
    let inspect_extra = match inspect_handle.join() {
        Ok(Ok((body, _, true))) if !body.is_empty() => {
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => parse_inspect_plugins_map(&v),
                Err(_) => std::collections::HashMap::new(),
            }
        }
        _ => std::collections::HashMap::new(),
    };
    parse_plugin_list_json(&stdout, &disabled, &inspect_extra)
}

/// List installed plugins (Grok Build inventory + enable state + inspect extras).
/// Always returns Ok; on CLI missing / failure, `plugins` is empty and `error` is set.
#[tauri::command]
pub async fn plugins_list() -> Result<serde_json::Value, String> {
    let result = tauri::async_runtime::spawn_blocking(collect_plugins_list)
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(plugins) => Ok(serde_json::json!({ "plugins": plugins })),
        Err(e) => Ok(serde_json::json!({
            "plugins": [],
            "error": e,
        })),
    }
}

/// Enable a plugin by name (`grok plugin enable <name>`). Soft-respawns agent.
#[tauri::command]
pub async fn plugin_enable(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "enable", &name_for_cmd],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to enable plugin {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "message": stdout.chars().take(200).collect::<String>(),
    }))
}

/// Disable a plugin by name (`grok plugin disable <name>`). Soft-respawns agent.
#[tauri::command]
pub async fn plugin_disable(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "disable", &name_for_cmd],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to disable plugin {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "message": stdout.chars().take(200).collect::<String>(),
    }))
}

/// Uninstall a plugin by name. Soft-respawns agent on success.
#[tauri::command]
pub async fn plugin_uninstall(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "uninstall", &name_for_cmd, "--confirm"],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to uninstall plugin {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "message": stdout.chars().take(200).collect::<String>(),
    }))
}

/// Plugin component inventory text (`grok plugin details <name>`).
#[tauri::command]
pub async fn plugin_details(name: String) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "details", &name_for_cmd],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to load details for {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    Ok(serde_json::json!({
        "name": name,
        "details": stdout,
    }))
}

/// Trim install source; reject empty. Accepts path, git URL, or GitHub shorthand.
pub fn normalize_plugin_install_source(source: &str) -> Result<String, String> {
    let s = source.trim();
    if s.is_empty() {
        return Err("plugin source required".into());
    }
    Ok(s.to_string())
}

/// Optional update target: empty / whitespace → update all (`None`).
pub fn normalize_plugin_update_name(name: Option<&str>) -> Option<String> {
    name.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Best-effort plugin name for `plugin enable` after install.
/// Handles `name`, `name@marketplace`, `owner/repo[@ref]`, git URLs, and paths.
pub fn plugin_name_from_install_source(source: &str) -> Option<String> {
    let s = source.trim();
    if s.is_empty() {
        return None;
    }
    // git@host:path/repo.git
    if s.starts_with("git@") {
        let leaf = s.rsplit([':', '/']).next().unwrap_or("");
        let name = leaf.trim_end_matches(".git");
        return if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        };
    }
    // https://…/repo.git
    if s.contains("://") {
        let leaf = s.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        let name = leaf.trim_end_matches(".git");
        return if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        };
    }
    // Absolute / home / Windows path
    let looks_like_path = s.starts_with('/')
        || s.starts_with('~')
        || (s.len() >= 3
            && s.as_bytes()[1] == b':'
            && (s.as_bytes()[2] == b'\\' || s.as_bytes()[2] == b'/'));
    if looks_like_path {
        let trimmed = s.trim_end_matches(['/', '\\']);
        let leaf = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
        return if leaf.is_empty() {
            None
        } else {
            Some(leaf.to_string())
        };
    }
    // name@marketplace or owner/repo@ref
    if let Some((left, _right)) = s.split_once('@') {
        if left.is_empty() {
            return None;
        }
        if !left.contains('/') {
            return Some(left.to_string());
        }
        let leaf = left.rsplit('/').next().unwrap_or("");
        return if leaf.is_empty() {
            None
        } else {
            Some(leaf.to_string())
        };
    }
    // bare name
    if !s.contains('/') {
        return Some(s.to_string());
    }
    // owner/repo
    let leaf = s.rsplit('/').next().unwrap_or("");
    if leaf.is_empty() {
        None
    } else {
        Some(leaf.to_string())
    }
}

/// Install from path / git URL / GitHub shorthand / marketplace name
/// (`grok plugin install <source> --trust`), then enable, then soft-respawn.
/// `--trust` is required for non-interactive UI; enable so skills/MCP load without a second step.
#[tauri::command]
pub async fn plugin_install(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    source: String,
) -> Result<serde_json::Value, String> {
    let source = normalize_plugin_install_source(&source)?;
    let source_for_cmd = source.clone();
    let enable_name = plugin_name_from_install_source(&source);
    let enable_name_for_cmd = enable_name.clone();
    let result = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, String, bool, Option<String>), String> {
            let (stdout, stderr, ok) = run_grok_cli_args(
                &["plugin", "install", &source_for_cmd, "--trust"],
                PLUGIN_MUTATE_TIMEOUT_SECS,
            )?;
            if !ok {
                return Ok((stdout, stderr, false, None));
            }
            // Plugins stay off until enabled — enable so the install is usable immediately.
            let mut enable_msg: Option<String> = None;
            if let Some(name) = enable_name_for_cmd {
                match run_grok_cli_args(
                    &["plugin", "enable", &name],
                    PLUGIN_CMD_TIMEOUT_SECS,
                ) {
                    Ok((e_out, e_err, e_ok)) => {
                        if e_ok {
                            enable_msg = Some(if e_out.is_empty() {
                                format!("enabled {name}")
                            } else {
                                e_out
                            });
                        } else {
                            // Install succeeded; surface enable failure as soft note.
                            let note = if !e_err.is_empty() {
                                e_err
                            } else if !e_out.is_empty() {
                                e_out
                            } else {
                                format!("installed but failed to enable {name}")
                            };
                            enable_msg = Some(note);
                        }
                    }
                    Err(e) => {
                        enable_msg = Some(format!("installed but enable failed: {e}"));
                    }
                }
            }
            Ok((stdout, stderr, true, enable_msg))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok, enable_msg) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to install plugin from {source}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    let mut message = stdout.chars().take(400).collect::<String>();
    if let Some(em) = enable_msg {
        if !message.is_empty() {
            message.push_str(" · ");
        }
        message.push_str(&em.chars().take(200).collect::<String>());
    }
    Ok(serde_json::json!({
        "ok": true,
        "name": enable_name.unwrap_or(source),
        "message": message,
    }))
}

/// Update one plugin by name, or all when `name` is null/empty (`grok plugin update [name]`).
/// Soft-respawns agent on success.
#[tauri::command]
pub async fn plugin_update(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let target = normalize_plugin_update_name(name.as_deref());
    let target_for_cmd = target.clone();
    let result = tauri::async_runtime::spawn_blocking(move || match target_for_cmd.as_deref() {
        Some(n) => run_grok_cli_args(&["plugin", "update", n], PLUGIN_MUTATE_TIMEOUT_SECS),
        None => run_grok_cli_args(&["plugin", "update"], PLUGIN_MUTATE_TIMEOUT_SECS),
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let label = target.as_deref().unwrap_or("all");
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to update plugin(s): {label}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": target.unwrap_or_default(),
        "message": stdout.chars().take(400).collect::<String>(),
    }))
}

// ── plugin validate (`grok plugin validate [path]`) ─────────────────────────

/// Split stdout + stderr into non-empty lines (stderr first, de-duped).
pub fn parse_plugin_validate_messages(stdout: &str, stderr: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for part in [stderr, stdout] {
        for line in part.lines() {
            let t = line.trim();
            if t.is_empty() || seen.contains(t) {
                continue;
            }
            seen.insert(t.to_string());
            out.push(t.to_string());
        }
    }
    out
}

/// Old CLI rejects `plugin validate` as an unknown subcommand (clap-style).
pub fn looks_like_unsupported_plugin_validate(stderr: &str, stdout: &str) -> bool {
    let s = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    if s.trim().is_empty() {
        return false;
    }
    if s.contains("unrecognized subcommand")
        || s.contains("unknown subcommand")
        || s.contains("unexpected subcommand")
        || s.contains("invalid subcommand")
    {
        return true;
    }
    if s.contains("validate")
        && (s.contains("unexpected argument")
            || s.contains("unrecognized")
            || s.contains("unknown command")
            || s.contains("unknown argument"))
    {
        return true;
    }
    false
}

/// True when `s` looks like a filesystem path (not a bare plugin name / owner/repo).
pub fn looks_like_plugin_validate_path(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    if s.starts_with("git@") || s.contains("://") {
        return false;
    }
    if s.starts_with('/')
        || s.starts_with('~')
        || s.starts_with("./")
        || s.starts_with("../")
        || s.starts_with(".\\")
        || s.starts_with("..\\")
    {
        return true;
    }
    // Windows drive: C:\… or D:/…
    let bytes = s.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    // Relative path segments with separators
    s.contains('/') || s.contains('\\')
}

/// Normalize optional path/name; empty → None (CLI defaults to `.`).
pub fn normalize_plugin_validate_target(path_or_name: Option<&str>) -> Option<String> {
    path_or_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Resolve bare plugin name to installed path via `plugin list --json` (best-effort).
fn resolve_installed_plugin_path(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let (stdout, _stderr, ok) =
        run_grok_cli_args(&["plugin", "list", "--json"], PLUGIN_CMD_TIMEOUT_SECS).ok()?;
    if !ok || stdout.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    let arr = value.as_array()?;
    // Prefer exact name match with a path; if several, first with path.
    let mut fallback: Option<String> = None;
    for item in arr {
        let n = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        if n != name {
            continue;
        }
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        if let Some(p) = path {
            return Some(p);
        }
        if fallback.is_none() {
            fallback = Some(name.to_string());
        }
    }
    fallback
}

/// Resolve validate target: path as-is; bare name → installed path when known.
pub fn resolve_plugin_validate_path(path_or_name: Option<&str>) -> Option<String> {
    let raw = normalize_plugin_validate_target(path_or_name)?;
    if looks_like_plugin_validate_path(&raw) {
        return Some(raw);
    }
    // Bare name (or name@market) — strip @marketplace for list match
    let name = raw.split_once('@').map(|(l, _)| l).unwrap_or(&raw).trim();
    if name.is_empty() {
        return Some(raw);
    }
    resolve_installed_plugin_path(name).or(Some(if name == raw {
        raw
    } else {
        name.to_string()
    }))
}

/// Validate a plugin manifest via `grok plugin validate [path]`.
///
/// - `path_or_name`: local path, installed plugin name, or omit (CLI default `.`)
/// - Always returns an envelope `{ ok, messages[] }` (never hard-fails on CLI-too-old)
/// - Soft-fail: older CLIs without `plugin validate` → `ok: false`, `reason: "cli_too_old"`
#[tauri::command]
pub async fn plugin_validate(
    path_or_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let path_or_name_owned = path_or_name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_plugin_validate_path(path_or_name_owned.as_deref());
        let run = match resolved.as_deref() {
            Some(p) => run_grok_cli_args(
                &["plugin", "validate", p],
                PLUGIN_CMD_TIMEOUT_SECS,
            ),
            None => run_grok_cli_args(&["plugin", "validate"], PLUGIN_CMD_TIMEOUT_SECS),
        };
        (resolved, run)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (resolved, run) = result;
    match run {
        Err(e) => {
            // CLI missing / spawn failure — surface as envelope so UI can show in-panel.
            let msg = e;
            let reason = if msg.to_ascii_lowercase().contains("not found") {
                Some("cli_missing")
            } else {
                None
            };
            Ok(serde_json::json!({
                "ok": false,
                "messages": [msg],
                "path": resolved,
                "reason": reason,
            }))
        }
        Ok((stdout, stderr, exit_ok)) => {
            if looks_like_unsupported_plugin_validate(&stderr, &stdout) {
                return Ok(serde_json::json!({
                    "ok": false,
                    "messages": [
                        format!(
                            "This Grok CLI does not support `plugin validate`; version {} or newer is required. Run `grok update`, then fully restart the app.",
                            crate::cli_probe::min_cli_version_str()
                        )
                    ],
                    "path": resolved,
                    "reason": "cli_too_old",
                }));
            }
            let messages = parse_plugin_validate_messages(&stdout, &stderr);
            let messages = if messages.is_empty() {
                if exit_ok {
                    vec!["Plugin manifest is valid.".to_string()]
                } else {
                    vec!["Plugin validation failed.".to_string()]
                }
            } else {
                messages
            };
            Ok(serde_json::json!({
                "ok": exit_ok,
                "messages": messages,
                "path": resolved,
                "reason": serde_json::Value::Null,
            }))
        }
    }
}

#[cfg(test)]
mod plugin_config_tests {
    use super::*;

    #[test]
    fn parse_disabled_single_line() {
        let toml = r#"
[plugins]
enabled = ["a", "b"]
disabled = ["chrome-devtools-mcp", "x"]
"#;
        let set = parse_plugins_disabled_names(toml);
        assert!(set.contains("chrome-devtools-mcp"));
        assert!(set.contains("x"));
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn parse_disabled_multiline() {
        let toml = r#"
[plugins]
enabled = [
    "cloudflare",
]
disabled = [
    "chrome-devtools-mcp",
    "playwright",
]

[marketplace]
foo = 1
"#;
        let set = parse_plugins_disabled_names(toml);
        assert!(set.contains("chrome-devtools-mcp"));
        assert!(set.contains("playwright"));
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn parse_disabled_empty() {
        let set = parse_plugins_disabled_names("[plugins]\ndisabled = []\n");
        assert!(set.is_empty());
    }

    #[test]
    fn parse_disabled_ignores_other_sections() {
        let toml = r#"
[other]
disabled = ["nope"]

[plugins]
disabled = ["yes"]
"#;
        let set = parse_plugins_disabled_names(toml);
        assert!(set.contains("yes"));
        assert!(!set.contains("nope"));
    }

    #[test]
    fn matches_full_plugin_id_like_grok_build() {
        let mut disabled = std::collections::HashSet::new();
        disabled.insert("user/a0b23c68/chrome-devtools-mcp".into());
        assert!(plugin_matches_disabled(
            "chrome-devtools-mcp",
            Some("chrome-devtools-mcp-a0b23c68"),
            &disabled
        ));
        assert!(!plugin_matches_disabled("other", None, &disabled));
    }

    #[test]
    fn list_json_keeps_cli_status_and_config_enabled() {
        let raw = r#"[
          {"status":"installed","name":"demo","repo_key":"demo-abc","version":"1.0.0","path":"/tmp/demo","source":"https://example.com/demo","marketplace":null}
        ]"#;
        let mut disabled = std::collections::HashSet::new();
        disabled.insert("demo".into());
        let empty = std::collections::HashMap::new();
        let plugins = parse_plugin_list_json(raw, &disabled, &empty).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].status, "installed"); // CLI install status preserved
        assert!(!plugins[0].enabled); // config disabled
    }

    #[test]
    fn merges_inspect_scope_and_provides() {
        let raw = r#"[
          {"status":"installed","name":"superpowers","repo_key":"superpowers-599","version":"6.1.1","path":"/p/superpowers","source":"https://github.com/obra/superpowers","marketplace":null}
        ]"#;
        let disabled = std::collections::HashSet::new();
        let mut extra = std::collections::HashMap::new();
        extra.insert(
            "path:/p/superpowers".into(),
            InspectPluginExtra {
                scope: Some("user".into()),
                provides: Some(PluginProvidesDto {
                    skills: 14,
                    agents: 0,
                    hooks: true,
                    mcp_servers: 0,
                }),
            },
        );
        let plugins = parse_plugin_list_json(raw, &disabled, &extra).unwrap();
        assert_eq!(plugins[0].scope.as_deref(), Some("user"));
        assert_eq!(plugins[0].provides.as_ref().unwrap().skills, 14);
        assert!(plugins[0].provides.as_ref().unwrap().hooks);
        assert!(plugins[0].enabled);
    }

    #[test]
    fn normalize_install_source_trims_and_rejects_empty() {
        assert_eq!(
            normalize_plugin_install_source("  owner/repo  ").unwrap(),
            "owner/repo"
        );
        assert_eq!(
            normalize_plugin_install_source("https://github.com/a/b.git").unwrap(),
            "https://github.com/a/b.git"
        );
        assert_eq!(
            normalize_plugin_install_source("/tmp/my-plugin").unwrap(),
            "/tmp/my-plugin"
        );
        assert!(normalize_plugin_install_source("").is_err());
        assert!(normalize_plugin_install_source("   ").is_err());
    }

    #[test]
    fn plugin_name_from_install_source_variants() {
        assert_eq!(
            plugin_name_from_install_source("vercel@xAI Official").as_deref(),
            Some("vercel")
        );
        assert_eq!(
            plugin_name_from_install_source("vercel").as_deref(),
            Some("vercel")
        );
        assert_eq!(
            plugin_name_from_install_source("owner/repo").as_deref(),
            Some("repo")
        );
        assert_eq!(
            plugin_name_from_install_source("owner/repo@v1").as_deref(),
            Some("repo")
        );
        assert_eq!(
            plugin_name_from_install_source("https://github.com/a/b.git").as_deref(),
            Some("b")
        );
        assert_eq!(
            plugin_name_from_install_source("git@github.com:a/b.git").as_deref(),
            Some("b")
        );
        assert_eq!(
            plugin_name_from_install_source("/tmp/my-plugin").as_deref(),
            Some("my-plugin")
        );
    }

    #[test]
    fn normalize_update_name_empty_means_all() {
        assert_eq!(
            normalize_plugin_update_name(Some("  chrome-devtools-mcp ")).as_deref(),
            Some("chrome-devtools-mcp")
        );
        assert_eq!(normalize_plugin_update_name(Some("")), None);
        assert_eq!(normalize_plugin_update_name(Some("   ")), None);
        assert_eq!(normalize_plugin_update_name(None), None);
    }

    #[test]
    fn parse_validate_messages_stderr_first_dedupe() {
        let msgs = parse_plugin_validate_messages(
            "Plugin manifest is valid.\n  name: demo\n",
            "  name: demo\n",
        );
        assert_eq!(
            msgs,
            vec![
                "name: demo".to_string(),
                "Plugin manifest is valid.".to_string()
            ]
        );
    }

    #[test]
    fn looks_like_unsupported_validate_clap() {
        assert!(looks_like_unsupported_plugin_validate(
            "error: unrecognized subcommand 'validate'\n\nUsage: grok plugin …",
            ""
        ));
        assert!(looks_like_unsupported_plugin_validate(
            "error: unexpected argument 'validate' found",
            ""
        ));
        assert!(!looks_like_unsupported_plugin_validate(
            "Error: Not a directory: /nope",
            ""
        ));
        assert!(!looks_like_unsupported_plugin_validate(
            "Error: Failed to load manifest: missing field `name`",
            ""
        ));
    }

    #[test]
    fn looks_like_validate_path_variants() {
        assert!(looks_like_plugin_validate_path("/tmp/my-plugin"));
        assert!(looks_like_plugin_validate_path("~/code/plugin"));
        assert!(looks_like_plugin_validate_path("./plugin"));
        assert!(looks_like_plugin_validate_path("C:\\Users\\a\\plugin"));
        assert!(looks_like_plugin_validate_path("owner/repo")); // has slash → path-ish for CLI
        assert!(!looks_like_plugin_validate_path("chrome-devtools-mcp"));
        assert!(!looks_like_plugin_validate_path("https://github.com/a/b.git"));
        assert!(!looks_like_plugin_validate_path("git@github.com:a/b.git"));
    }

    #[test]
    fn normalize_validate_target_empty() {
        assert_eq!(normalize_plugin_validate_target(None), None);
        assert_eq!(normalize_plugin_validate_target(Some("")), None);
        assert_eq!(normalize_plugin_validate_target(Some("  ")), None);
        assert_eq!(
            normalize_plugin_validate_target(Some("  /tmp/p  ")).as_deref(),
            Some("/tmp/p")
        );
    }
}

#[tauri::command]
pub async fn pick_directory() -> Result<Option<String>, String> {
    // rfd must run off the async runtime (main-thread dialog on macOS via spawn_blocking)
    let folder = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择项目目录 / Choose project folder")
            .pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(folder.map(|p| {
        crate::path_scope::grant_path(&p);
        p.display().to_string()
    }))
}

/// Native multi-file picker for composer attachments. Returns empty vec if cancelled.
#[tauri::command]
pub async fn pick_attach_files() -> Result<Vec<String>, String> {
    let files = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("附加文件 / Attach files")
            .pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(files
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            crate::path_scope::grant_path(&p);
            p.display().to_string()
        })
        .collect())
}

/// Native folder picker for attaching a directory as `@path` (optional).
#[tauri::command]
pub async fn pick_attach_folder() -> Result<Option<String>, String> {
    let folder = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("附加文件夹 / Attach folder")
            .pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(folder.map(|p| { crate::path_scope::grant_path(&p); p.display().to_string() }))
}

/// Save clipboard / webview File bytes into app attachments dir; return classified path.
/// Used when paste has image data without a filesystem path (screenshots, browser copy).
#[tauri::command]
pub async fn save_temp_attachment(
    bytes_base64: String,
    suggested_name: Option<String>,
    mime: Option<String>,
) -> Result<PathEntry, String> {
    use base64::Engine;
    let raw = bytes_base64.trim();
    // Accept data-URL prefix if present
    let b64 = raw
        .split(',')
        .last()
        .unwrap_or(raw)
        .trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("invalid base64: {e}"))?;
    if bytes.is_empty() {
        return Err("empty attachment payload".into());
    }
    // Cap paste size at 40 MiB to avoid runaway memory
    if bytes.len() > 40 * 1024 * 1024 {
        return Err("attachment too large (max 40 MiB)".into());
    }

    let mime = mime.unwrap_or_default().to_lowercase();
    let ext = mime_to_ext(&mime).unwrap_or_else(|| {
        suggested_name
            .as_deref()
            .and_then(|n| {
                std::path::Path::new(n)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_lowercase())
            })
            .unwrap_or_else(|| "bin".into())
    });

    let safe_name = sanitize_attachment_name(
        suggested_name.as_deref(),
        &ext,
    );
    let dir = crate::paths::attachments_paste_dir();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    let file_name = format!("{stamp}-{safe_name}");
    let path = dir.join(&file_name);
    std::fs::write(&path, &bytes).map_err(|e| format!("write attachment: {e}"))?;

    let path_str = path.display().to_string();
    Ok(PathEntry {
        path: path_str.clone(),
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or(file_name),
        is_dir: false,
        exists: true,
    })
}

/// Read an image from the OS clipboard (screenshots) and save under attachments/paste.
/// Used when the WebView paste event has no File objects (common on macOS WKWebView).
/// Returns `None` when the clipboard has no image.
#[tauri::command]
pub async fn clipboard_paste_image() -> Result<Option<PathEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| clipboard_paste_image_sync())
        .await
        .map_err(|e| format!("clipboard task: {e}"))?
}

/// Write a PNG (base64, no data: prefix) to the OS clipboard as an image.
/// WebView `navigator.clipboard.write(image/png)` is unreliable in Tauri.
#[tauri::command]
pub async fn clipboard_write_image(bytes_base64: String) -> Result<(), String> {
    let raw = bytes_base64.trim().to_string();
    if raw.is_empty() {
        return Err("clipboard image payload is empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || clipboard_write_image_sync(&raw))
        .await
        .map_err(|e| format!("clipboard write task: {e}"))?
}

fn clipboard_write_image_sync(bytes_base64: &str) -> Result<(), String> {
    use arboard::{Clipboard, ImageData};
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;
    if bytes.is_empty() {
        return Err("clipboard image payload is empty".into());
    }
    if bytes.len() > 40 * 1024 * 1024 {
        return Err("clipboard image too large (max 40 MiB)".into());
    }

    let dyn_img = image::load_from_memory(&bytes)
        .map_err(|e| format!("decode image: {e}"))?;
    let rgba = dyn_img.to_rgba8();
    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return Err("empty image".into());
    }

    let mut cb = Clipboard::new().map_err(|e| format!("clipboard open: {e}"))?;
    let data = ImageData {
        width: w as usize,
        height: h as usize,
        bytes: rgba.into_raw().into(),
    };
    cb.set_image(data)
        .map_err(|e| format!("clipboard set image: {e}"))?;
    Ok(())
}

fn clipboard_paste_image_sync() -> Result<Option<PathEntry>, String> {
    use arboard::Clipboard;

    let mut cb = Clipboard::new().map_err(|e| format!("clipboard open: {e}"))?;
    let img = match cb.get_image() {
        Ok(img) => img,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(e) => return Err(format!("clipboard image: {e}")),
    };

    let w = img.width;
    let h = img.height;
    if w == 0 || h == 0 {
        return Ok(None);
    }
    let expected = w.saturating_mul(h).saturating_mul(4);
    if img.bytes.len() < expected {
        return Err(format!(
            "clipboard image truncated ({} < {})",
            img.bytes.len(),
            expected
        ));
    }

    let png = rgba_to_png_bytes(w, h, &img.bytes[..expected])?;
    if png.len() > 40 * 1024 * 1024 {
        return Err("attachment too large (max 40 MiB)".into());
    }

    let dir = crate::paths::attachments_paste_dir();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    let file_name = format!("{stamp}-paste.png");
    let path = dir.join(&file_name);
    std::fs::write(&path, &png).map_err(|e| format!("write attachment: {e}"))?;

    Ok(Some(PathEntry {
        path: path.display().to_string(),
        name: file_name,
        is_dir: false,
        exists: true,
    }))
}

/// Encode raw RGBA8 pixels as PNG (clipboard / paste path).
fn rgba_to_png_bytes(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    use image::ImageEncoder;
    if width == 0 || height == 0 {
        return Err("empty image".into());
    }
    let expected = width.saturating_mul(height).saturating_mul(4);
    if rgba.len() < expected {
        return Err("rgba buffer too short".into());
    }
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png);
    encoder
        .write_image(
            &rgba[..expected],
            width as u32,
            height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("png encode: {e}"))?;
    if png.is_empty() {
        return Err("png encode produced empty buffer".into());
    }
    Ok(png)
}

#[cfg(test)]
mod clipboard_paste_tests {
    use super::rgba_to_png_bytes;

    #[test]
    fn rgba_one_pixel_encodes_png_signature() {
        // 1×1 opaque red
        let rgba = [255u8, 0, 0, 255];
        let png = rgba_to_png_bytes(1, 1, &rgba).expect("encode");
        assert!(png.len() > 8);
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    }

    #[test]
    fn rgba_rejects_short_buffer() {
        assert!(rgba_to_png_bytes(2, 2, &[0u8; 4]).is_err());
    }
}

fn mime_to_ext(mime: &str) -> Option<String> {
    let m = mime.split(';').next().unwrap_or(mime).trim();
    Some(
        match m {
            "image/png" => "png",
            "image/jpeg" | "image/jpg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            "image/svg+xml" => "svg",
            "image/heic" => "heic",
            "image/avif" => "avif",
            "application/pdf" => "pdf",
            "text/plain" => "txt",
            "text/markdown" => "md",
            "application/json" => "json",
            "video/mp4" => "mp4",
            "video/webm" => "webm",
            "audio/mpeg" | "audio/mp3" => "mp3",
            "audio/wav" | "audio/x-wav" => "wav",
            _ => return None,
        }
        .into(),
    )
}

fn sanitize_attachment_name(suggested: Option<&str>, ext: &str) -> String {
    let base = suggested
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("paste");
    let stem = std::path::Path::new(base)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("paste");
    let mut cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        cleaned = "paste".into();
    }
    // Cap stem length
    if cleaned.len() > 64 {
        cleaned.truncate(64);
    }
    let has_ext = std::path::Path::new(base)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case(ext))
        .unwrap_or(false);
    if has_ext {
        format!("{cleaned}.{ext}")
    } else {
        format!("{cleaned}.{ext}")
    }
}

/// Classify dropped / picked paths for drag-drop UX (file vs folder).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub exists: bool,
}

/// Normalize OS / browser path strings (file:// URLs, percent-encoding, trailing slashes).
fn normalize_fs_path(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if s.is_empty() {
        return s;
    }
    // file://localhost/Users/... or file:///Users/...
    if let Some(rest) = s.strip_prefix("file://") {
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        s = rest.to_string();
        // percent-decode common escapes (spaces, CJK, etc.)
        if s.contains('%') {
            if let Ok(decoded) = urlencoding_lite_decode(&s) {
                s = decoded;
            }
        }
    }
    // drop trailing slash except root
    while s.len() > 1 && (s.ends_with('/') || s.ends_with('\\')) {
        s.pop();
    }
    s
}

/// Minimal percent-decoder (avoid extra crate).
fn urlencoding_lite_decode(input: &str) -> Result<String, ()> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let h = |c: u8| -> Option<u8> {
                    match c {
                        b'0'..=b'9' => Some(c - b'0'),
                        b'a'..=b'f' => Some(c - b'a' + 10),
                        b'A'..=b'F' => Some(c - b'A' + 10),
                        _ => None,
                    }
                };
                match (h(bytes[i + 1]), h(bytes[i + 2])) {
                    (Some(a), Some(b)) => {
                        out.push((a << 4) | b);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

#[tauri::command]
pub fn paths_classify(paths: Vec<String>) -> Vec<PathEntry> {
    paths
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(|raw| {
            let p = normalize_fs_path(&raw);
            let pb = std::path::PathBuf::from(&p);
            let name = pb
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| p.clone());
            // Prefer metadata; if path is missing, still return entry so UI can attach it.
            let meta = std::fs::metadata(&pb).ok();
            let exists = meta.is_some();
            let is_dir = meta.map(|m| m.is_dir()).unwrap_or(false);
            // User-attached / chat-history paths often sit outside trusted project
            // roots (Desktop, Downloads, Screenshots). Grant them so media://
            // previews in the composer and thread can load.
            if exists {
                crate::path_scope::grant_path(&pb);
            }
            PathEntry {
                path: p,
                name,
                is_dir,
                exists,
            }
        })
        .collect()
}

/// Cached video cover for chat cards: path + mtime + size → JPEG under app cache.
/// Prefer disk cache; extract with ffmpeg when missing. Frontend may also save a
/// canvas capture via [`media_video_poster_save`].
#[tauri::command]
pub async fn media_video_poster(path: String) -> Result<crate::video_poster::VideoPosterResult, String> {
    tokio::task::spawn_blocking(move || crate::video_poster::ensure_video_poster(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Persist a client-captured JPEG poster (canvas) into the same cache key.
#[tauri::command]
pub async fn media_video_poster_save(
    path: String,
    jpeg_base64: String,
) -> Result<crate::video_poster::VideoPosterResult, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(jpeg_base64.trim())
            .map_err(|e| format!("invalid base64: {e}"))?;
        crate::video_poster::save_client_poster(&path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a file or folder with the OS default application.
#[tauri::command]
pub async fn path_open(path: String) -> Result<(), String> {
    let p = normalize_fs_path(&path);
    if p.is_empty() {
        return Err("empty path".into());
    }
    let pb = std::path::PathBuf::from(&p);
    if !pb.exists() {
        return Err(format!("path not found: {p}"));
    }
    #[cfg(target_os = "macos")]
    {
        crate::process_util::command("open")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::process_util::command("cmd")
            .args(["/C", "start", "", &p])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::process_util::command("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Optional git unified diff for a path under a project (session Changes panel).
/// Soft-fails: returns `available: false` when git is missing, path is outside
/// the repo, or the file has no diff — never hard-requires git.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffResult {
    pub available: bool,
    pub diff: Option<String>,
    pub relative_path: Option<String>,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn git_file_diff(
    project_path: String,
    path: String,
) -> Result<GitFileDiffResult, String> {
    let project = normalize_fs_path(&project_path);
    let target = normalize_fs_path(&path);
    if project.is_empty() || target.is_empty() {
        return Ok(GitFileDiffResult {
            available: false,
            diff: None,
            relative_path: None,
            reason: Some("empty path".into()),
        });
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Ok(GitFileDiffResult {
            available: false,
            diff: None,
            relative_path: None,
            reason: Some("project not a directory".into()),
        });
    }

    // Prefer project-relative when under root (git -C wants repo-relative paths).
    let rel = {
        let t = std::path::PathBuf::from(&target);
        match t.strip_prefix(&proj) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => {
                // Also try string prefix (macOS /var vs /private/var etc. is best-effort)
                let p = project.trim_end_matches('/').replace('\\', "/");
                let a = target.replace('\\', "/");
                if a.starts_with(&(p.clone() + "/")) {
                    a[p.len() + 1..].to_string()
                } else {
                    target.clone()
                }
            }
        }
    };
    if rel.is_empty() || rel == "." {
        return Ok(GitFileDiffResult {
            available: false,
            diff: None,
            relative_path: None,
            reason: Some("not a file path".into()),
        });
    }

    // Soft check: is git on PATH?
    let git_ok = crate::process_util::command("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !git_ok {
        return Ok(GitFileDiffResult {
            available: false,
            diff: None,
            relative_path: Some(rel),
            reason: Some("git not available".into()),
        });
    }

    // Confirm we are inside a work tree
    let inside = crate::process_util::command("git")
        .args(["-C", &project, "rev-parse", "--is-inside-work-tree"])
        .output();
    let inside_ok = inside
        .as_ref()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false);
    if !inside_ok {
        return Ok(GitFileDiffResult {
            available: false,
            diff: None,
            relative_path: Some(rel),
            reason: Some("not a git repository".into()),
        });
    }

    // Working tree + index vs HEAD (covers staged and unstaged edits).
    let out = crate::process_util::command("git")
        .args([
            "-C",
            &project,
            "diff",
            "--no-color",
            "--no-ext-diff",
            "HEAD",
            "--",
            &rel,
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        // Untracked new file: try against empty tree
        let untracked = crate::process_util::command("git")
            .args([
                "-C",
                &project,
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-index",
                "--",
                "/dev/null",
                &rel,
            ])
            .output();
        if let Ok(u) = untracked {
            // git --no-index exits 1 when files differ — still useful
            let text = String::from_utf8_lossy(&u.stdout).to_string();
            if !text.trim().is_empty() {
                return Ok(GitFileDiffResult {
                    available: true,
                    diff: Some(text.chars().take(400_000).collect()),
                    relative_path: Some(rel),
                    reason: None,
                });
            }
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Ok(GitFileDiffResult {
            available: false,
            diff: None,
            relative_path: Some(rel),
            reason: Some(if err.is_empty() {
                "git diff failed".into()
            } else {
                err.chars().take(200).collect()
            }),
        });
    }

    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() {
        // Maybe untracked
        let untracked = crate::process_util::command("git")
            .args([
                "-C",
                &project,
                "ls-files",
                "--error-unmatch",
                "--",
                &rel,
            ])
            .status();
        let tracked = untracked.map(|s| s.success()).unwrap_or(false);
        if !tracked {
            // Show full file as addition via --no-index when possible
            let abs = proj.join(&rel);
            if abs.is_file() {
                let u = crate::process_util::command("git")
                    .args([
                        "-C",
                        &project,
                        "diff",
                        "--no-color",
                        "--no-ext-diff",
                        "--no-index",
                        "--",
                        "/dev/null",
                        abs.to_string_lossy().as_ref(),
                    ])
                    .output();
                if let Ok(u) = u {
                    let t = String::from_utf8_lossy(&u.stdout).to_string();
                    if !t.trim().is_empty() {
                        return Ok(GitFileDiffResult {
                            available: true,
                            diff: Some(t.chars().take(400_000).collect()),
                            relative_path: Some(rel),
                            reason: None,
                        });
                    }
                }
            }
        }
        return Ok(GitFileDiffResult {
            available: false,
            diff: None,
            relative_path: Some(rel),
            reason: Some("no diff".into()),
        });
    }

    Ok(GitFileDiffResult {
        available: true,
        diff: Some(text.chars().take(400_000).collect()),
        relative_path: Some(rel),
        reason: None,
    })
}

// ── Workspace git status (Changes panel: Session + Workspace) ──────────────

/// Soft-check git on PATH + project is inside a work tree.
fn git_probe_work_tree(project: &str) -> Result<(), String> {
    let git_ok = crate::process_util::command("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !git_ok {
        return Err("git not available".into());
    }
    let inside = crate::process_util::command("git")
        .args(["-C", project, "rev-parse", "--is-inside-work-tree"])
        .output();
    let inside_ok = inside
        .as_ref()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false);
    if !inside_ok {
        return Err("not a git repository".into());
    }
    Ok(())
}

/// One row from `git status --porcelain=v1` for the Workspace Changes section.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    /// Repo-relative path (forward slashes).
    pub path: String,
    /// Absolute path under the project root when possible.
    pub absolute_path: String,
    /// Two-char porcelain code (e.g. ` M`, `M `, `??`, `A `).
    pub status: String,
    /// Index (staged) status char, or space.
    pub index_status: String,
    /// Worktree status char, or space.
    pub worktree_status: String,
    /// Coarse kind: modified | added | deleted | untracked | renamed | copied | typechange | conflict | ignored | unknown
    pub kind: String,
    /// Basename for list rows.
    pub name: String,
    /// Rename/copy source path when present.
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub available: bool,
    pub files: Vec<GitStatusEntry>,
    pub branch: Option<String>,
    pub reason: Option<String>,
}

/// Classify porcelain XY code into a coarse kind string (mirrors frontend helper).
fn git_status_kind(x: char, y: char) -> &'static str {
    if x == '?' && y == '?' {
        return "untracked";
    }
    if x == '!' && y == '!' {
        return "ignored";
    }
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return "conflict";
    }
    // Prefer worktree letter, then index
    for c in [y, x] {
        match c {
            'R' => return "renamed",
            'C' => return "copied",
            'A' => return "added",
            'D' => return "deleted",
            'T' => return "typechange",
            'M' => return "modified",
            _ => {}
        }
    }
    if x != ' ' || y != ' ' {
        return "modified";
    }
    "unknown"
}

fn git_entry_basename(rel: &str) -> String {
    let n = rel.replace('\\', "/");
    n.rsplit('/').next().unwrap_or(rel).to_string()
}

/// Parse one porcelain v1 line into an entry (pure; unit-tested).
#[cfg(test)]
fn parse_porcelain_line(line: &str, project: &str) -> Option<GitStatusEntry> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.len() < 3 {
        return None;
    }
    let bytes = line.as_bytes();
    // Standard: XY SPACE path…  (status is always 2 chars)
    let x = bytes[0] as char;
    let y = bytes[1] as char;
    // Must have a separator after XY
    if bytes.len() < 4 {
        return None;
    }
    // skip optional space after XY
    let rest = line[2..].trim_start();
    if rest.is_empty() {
        return None;
    }

    let (path, original_path) = if rest.contains(" -> ") {
        // rename / copy: "old -> new"
        let mut parts = rest.splitn(2, " -> ");
        let old = parts.next().unwrap_or("").trim().to_string();
        let new = parts.next().unwrap_or("").trim().to_string();
        if new.is_empty() {
            return None;
        }
        (new, if old.is_empty() { None } else { Some(old) })
    } else {
        // Unquoted path (porcelain without -z does not quote unless special chars;
        // strip surrounding quotes when present).
        let p = rest.trim().trim_matches('"').to_string();
        (p, None)
    };

    let path = path.replace('\\', "/");
    if path.is_empty() {
        return None;
    }

    let abs = join_project_rel(project, &path);

    let status = format!("{x}{y}");
    Some(GitStatusEntry {
        path: path.clone(),
        absolute_path: abs,
        status,
        index_status: x.to_string(),
        worktree_status: y.to_string(),
        kind: git_status_kind(x, y).to_string(),
        name: git_entry_basename(&path),
        original_path,
    })
}

/// Join project root + repo-relative path with `/` for UI (platform-neutral).
fn join_project_rel(project: &str, rel: &str) -> String {
    let root = project.trim_end_matches(['/', '\\']).replace('\\', "/");
    let r = rel.trim_start_matches('/').replace('\\', "/");
    if root.is_empty() {
        r
    } else if r.is_empty() {
        root
    } else {
        format!("{root}/{r}")
    }
}

/// List modified / untracked / added files under a project (Workspace Changes).
/// Soft-fails when git is missing or the path is not a repo.
#[tauri::command]
pub async fn git_status(project_path: String) -> Result<GitStatusResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Ok(GitStatusResult {
            available: false,
            files: vec![],
            branch: None,
            reason: Some("empty path".into()),
        });
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Ok(GitStatusResult {
            available: false,
            files: vec![],
            branch: None,
            reason: Some("project not a directory".into()),
        });
    }

    if let Err(reason) = git_probe_work_tree(&project) {
        return Ok(GitStatusResult {
            available: false,
            files: vec![],
            branch: None,
            reason: Some(reason),
        });
    }

    let branch = crate::process_util::command("git")
        .args(["-C", &project, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let b = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if b.is_empty() || b == "HEAD" {
                    None
                } else {
                    Some(b)
                }
            } else {
                None
            }
        });

    // Porcelain v1: untracked as `??`, no ignored noise, relative paths.
    let out = crate::process_util::command("git")
        .args([
            "-C",
            &project,
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "-z",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Ok(GitStatusResult {
            available: false,
            files: vec![],
            branch,
            reason: Some(if err.is_empty() {
                "git status failed".into()
            } else {
                err.chars().take(200).collect()
            }),
        });
    }

    // -z: records separated by NUL. Each record is `XY path` or for renames
    // `XY` + space + old + NUL + new (git uses two NUL fields for rename).
    // Actually with -z: "XY path\0" and for rename "R  oldpath\0newpath\0".
    let raw = out.stdout;
    let mut files: Vec<GitStatusEntry> = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        // find next NUL
        let end = raw[i..]
            .iter()
            .position(|&b| b == 0)
            .map(|p| i + p)
            .unwrap_or(raw.len());
        if end == i {
            break;
        }
        let chunk = String::from_utf8_lossy(&raw[i..end]).into_owned();
        i = end + 1;

        if chunk.len() < 3 {
            continue;
        }
        let x = chunk.as_bytes()[0] as char;
        let y = chunk.as_bytes()[1] as char;
        // After XY there is a space then path (when not rename split).
        let rest = chunk[2..].trim_start();

        // Rename/copy: first field is "XY oldpath", second field (next NUL record) is newpath.
        let is_rename = x == 'R' || x == 'C' || y == 'R' || y == 'C';
        let (path, original_path) = if is_rename && i < raw.len() {
            let end2 = raw[i..]
                .iter()
                .position(|&b| b == 0)
                .map(|p| i + p)
                .unwrap_or(raw.len());
            let newp = String::from_utf8_lossy(&raw[i..end2])
                .trim()
                .replace('\\', "/");
            i = end2 + 1;
            let old = rest.trim().replace('\\', "/");
            (newp, if old.is_empty() { None } else { Some(old) })
        } else {
            (rest.trim().replace('\\', "/"), None)
        };

        if path.is_empty() {
            continue;
        }

        let abs = join_project_rel(&project, &path);

        files.push(GitStatusEntry {
            path: path.clone(),
            absolute_path: abs,
            status: format!("{x}{y}"),
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            kind: git_status_kind(x, y).to_string(),
            name: git_entry_basename(&path),
            original_path,
        });
    }

    // Cap for UI responsiveness
    if files.len() > 2000 {
        files.truncate(2000);
    }

    Ok(GitStatusResult {
        available: true,
        files,
        branch,
        reason: None,
    })
}

/// File content at HEAD for a path under a project (before snapshot for diffs).
/// Soft-fails for untracked files / missing git / binary truncation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShowFileResult {
    pub available: bool,
    pub content: Option<String>,
    pub relative_path: Option<String>,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn git_show_file(
    project_path: String,
    path: String,
) -> Result<GitShowFileResult, String> {
    let project = normalize_fs_path(&project_path);
    let target = normalize_fs_path(&path);
    if project.is_empty() || target.is_empty() {
        return Ok(GitShowFileResult {
            available: false,
            content: None,
            relative_path: None,
            reason: Some("empty path".into()),
        });
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Ok(GitShowFileResult {
            available: false,
            content: None,
            relative_path: None,
            reason: Some("project not a directory".into()),
        });
    }

    let rel = {
        let t = std::path::PathBuf::from(&target);
        match t.strip_prefix(&proj) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => {
                let p = project.trim_end_matches('/').replace('\\', "/");
                let a = target.replace('\\', "/");
                if a.starts_with(&(p.clone() + "/")) {
                    a[p.len() + 1..].to_string()
                } else {
                    // path may already be repo-relative
                    target.replace('\\', "/")
                }
            }
        }
    };
    if rel.is_empty() || rel == "." {
        return Ok(GitShowFileResult {
            available: false,
            content: None,
            relative_path: None,
            reason: Some("not a file path".into()),
        });
    }

    if let Err(reason) = git_probe_work_tree(&project) {
        return Ok(GitShowFileResult {
            available: false,
            content: None,
            relative_path: Some(rel),
            reason: Some(reason),
        });
    }

    // `git show HEAD:path` — fails for untracked / missing at HEAD
    let out = crate::process_util::command("git")
        .args(["-C", &project, "show", &format!("HEAD:{rel}")])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Ok(GitShowFileResult {
            available: false,
            content: None,
            relative_path: Some(rel),
            reason: Some(if err.is_empty() {
                "not in HEAD".into()
            } else {
                err.chars().take(200).collect()
            }),
        });
    }

    // Reject obvious binary (NUL in first 8k)
    let sample_end = out.stdout.len().min(8192);
    if out.stdout[..sample_end].contains(&0) {
        return Ok(GitShowFileResult {
            available: false,
            content: None,
            relative_path: Some(rel),
            reason: Some("binary file".into()),
        });
    }

    let text = String::from_utf8_lossy(&out.stdout).to_string();
    Ok(GitShowFileResult {
        available: true,
        content: Some(text.chars().take(400_000).collect()),
        relative_path: Some(rel),
        reason: None,
    })
}

// ── Diff accept / reject / restore (Changes panel) ──────────────────────────

/// Resolve a project-relative or absolute path under the project root only.
/// Returns (canonical_project_root, relative_posix, absolute_path).
/// Pure lexical check against project; does not require the file to exist.
fn resolve_path_under_project(
    project_path: &str,
    path: &str,
) -> Result<(std::path::PathBuf, String, std::path::PathBuf), String> {
    let project = normalize_fs_path(project_path);
    let target = normalize_fs_path(path);
    if project.is_empty() || target.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    // Canonical project root when possible; always path-scoped below.
    let root = proj.canonicalize().unwrap_or(proj);

    let target_pb = std::path::PathBuf::from(&target);
    let (rel, abs) = if target_pb.is_absolute() {
        let abs_norm = target_pb.canonicalize().unwrap_or(target_pb.clone());
        let rel = match abs_norm.strip_prefix(&root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => {
                let p = root.to_string_lossy().replace('\\', "/");
                let a = abs_norm.to_string_lossy().replace('\\', "/");
                let p = p.trim_end_matches('/').to_string();
                if a.starts_with(&(p.clone() + "/")) {
                    a[p.len() + 1..].to_string()
                } else {
                    return Err("path outside project root".into());
                }
            }
        };
        if rel.is_empty() || rel == "." {
            return Err("not a file path".into());
        }
        if rel.contains("..") {
            return Err("path escapes project root".into());
        }
        (rel, abs_norm)
    } else {
        // Relative under project — reject `..` components.
        // On Windows, Path::is_absolute is false for Unix-style "/etc/passwd";
        // do not strip a leading slash and treat it as project-relative.
        if target.starts_with('/') || target.starts_with('\\') {
            return Err("path outside project root".into());
        }
        let rel = target
            .trim_start_matches("./")
            .replace('\\', "/");
        if rel.is_empty() || rel == "." {
            return Err("not a file path".into());
        }
        for comp in std::path::Path::new(&rel).components() {
            match comp {
                std::path::Component::Normal(_) | std::path::Component::CurDir => {}
                _ => return Err("path escapes project root".into()),
            }
        }
        let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        (rel, abs)
    };

    // Final guard: abs must stay under root lexically
    let abs_s = abs.to_string_lossy().replace('\\', "/");
    let root_s = root.to_string_lossy().replace('\\', "/");
    let root_prefix = root_s.trim_end_matches('/').to_string() + "/";
    if abs_s != root_s.trim_end_matches('/') && !abs_s.starts_with(&root_prefix) {
        return Err("path outside project root".into());
    }
    Ok((root, rel, abs))
}

/// Result of writing full file content under the project (accept / restore / reject-before).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyFilePatchResult {
    pub ok: bool,
    pub absolute_path: Option<String>,
    pub relative_path: Option<String>,
    pub reason: Option<String>,
}

/// Write UTF-8 content to a path under the project only (create parents if needed).
/// Used by Changes Accept / Restore and non-git reject (write before snapshot).
#[tauri::command]
pub async fn apply_file_patch(
    project_path: String,
    path: String,
    content: String,
) -> Result<ApplyFilePatchResult, String> {
    let (root, rel, abs) = match resolve_path_under_project(&project_path, &path) {
        Ok(v) => v,
        Err(reason) => {
            return Ok(ApplyFilePatchResult {
                ok: false,
                absolute_path: None,
                relative_path: None,
                reason: Some(reason),
            });
        }
    };

    // Cap size (same order as resource-pane text save)
    const MAX_BYTES: usize = 2 * 1024 * 1024;
    if content.len() > MAX_BYTES {
        return Ok(ApplyFilePatchResult {
            ok: false,
            absolute_path: Some(abs.to_string_lossy().to_string()),
            relative_path: Some(rel),
            reason: Some(format!("content too large (max {MAX_BYTES} bytes)")),
        });
    }

    if let Some(parent) = abs.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Ok(ApplyFilePatchResult {
                ok: false,
                absolute_path: Some(abs.to_string_lossy().to_string()),
                relative_path: Some(rel),
                reason: Some(format!("create parent: {e}")),
            });
        }
    }

    // Atomic-ish write via temp + rename in same directory
    let parent = abs.parent().unwrap_or(root.as_path());
    let tmp = parent.join(format!(
        ".{}.grok-patch-{}",
        abs.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file"),
        std::process::id()
    ));
    if let Err(e) = std::fs::write(&tmp, content.as_bytes()) {
        return Ok(ApplyFilePatchResult {
            ok: false,
            absolute_path: Some(abs.to_string_lossy().to_string()),
            relative_path: Some(rel),
            reason: Some(format!("write temp: {e}")),
        });
    }
    if let Err(e) = std::fs::rename(&tmp, &abs) {
        let _ = std::fs::remove_file(&tmp);
        return Ok(ApplyFilePatchResult {
            ok: false,
            absolute_path: Some(abs.to_string_lossy().to_string()),
            relative_path: Some(rel),
            reason: Some(format!("rename into place: {e}")),
        });
    }

    // Grant for media/re-open
    crate::path_scope::grant_path(&abs);

    Ok(ApplyFilePatchResult {
        ok: true,
        absolute_path: Some(abs.to_string_lossy().to_string()),
        relative_path: Some(rel),
        reason: None,
    })
}

/// Result of restoring a path to HEAD (or deleting untracked with confirm).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutFileResult {
    pub ok: bool,
    pub absolute_path: Option<String>,
    pub relative_path: Option<String>,
    /// When true, caller must re-invoke with confirm_untracked=true.
    pub needs_untracked_confirm: bool,
    pub reason: Option<String>,
    /// Action taken: restored | deleted | none
    pub action: Option<String>,
}

/// Restore path to HEAD via `git checkout -- path` (reject agent/workspace edits).
/// Soft-fails when git is missing or project is not a repo.
/// Never deletes untracked files unless `confirm_untracked` is true.
#[tauri::command]
pub async fn git_checkout_file(
    project_path: String,
    path: String,
    confirm_untracked: bool,
) -> Result<GitCheckoutFileResult, String> {
    let (root, rel, abs) = match resolve_path_under_project(&project_path, &path) {
        Ok(v) => v,
        Err(reason) => {
            return Ok(GitCheckoutFileResult {
                ok: false,
                absolute_path: None,
                relative_path: None,
                needs_untracked_confirm: false,
                reason: Some(reason),
                action: Some("none".into()),
            });
        }
    };
    let project = root.to_string_lossy().to_string();

    if let Err(reason) = git_probe_work_tree(&project) {
        return Ok(GitCheckoutFileResult {
            ok: false,
            absolute_path: Some(abs.to_string_lossy().to_string()),
            relative_path: Some(rel),
            needs_untracked_confirm: false,
            reason: Some(reason),
            action: Some("none".into()),
        });
    }

    // Is path tracked?
    let tracked = crate::process_util::command("git")
        .args(["-C", &project, "ls-files", "--error-unmatch", "--", &rel])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !tracked {
        // Untracked: only wipe with explicit confirm
        if !confirm_untracked {
            return Ok(GitCheckoutFileResult {
                ok: false,
                absolute_path: Some(abs.to_string_lossy().to_string()),
                relative_path: Some(rel),
                needs_untracked_confirm: true,
                reason: Some("untracked file requires confirm".into()),
                action: Some("none".into()),
            });
        }
        if abs.is_file() {
            if let Err(e) = std::fs::remove_file(&abs) {
                return Ok(GitCheckoutFileResult {
                    ok: false,
                    absolute_path: Some(abs.to_string_lossy().to_string()),
                    relative_path: Some(rel),
                    needs_untracked_confirm: false,
                    reason: Some(format!("delete untracked: {e}")),
                    action: Some("none".into()),
                });
            }
        } else if abs.is_dir() {
            // Refuse recursive dir wipe for safety
            return Ok(GitCheckoutFileResult {
                ok: false,
                absolute_path: Some(abs.to_string_lossy().to_string()),
                relative_path: Some(rel),
                needs_untracked_confirm: false,
                reason: Some("refusing to delete untracked directory".into()),
                action: Some("none".into()),
            });
        }
        // Already gone counts as success
        return Ok(GitCheckoutFileResult {
            ok: true,
            absolute_path: Some(abs.to_string_lossy().to_string()),
            relative_path: Some(rel),
            needs_untracked_confirm: false,
            reason: None,
            action: Some("deleted".into()),
        });
    }

    // Tracked: restore HEAD into index + worktree for this path only
    let out = crate::process_util::command("git")
        .args(["-C", &project, "checkout", "HEAD", "--", &rel])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        // Fallback: git restore (newer git)
        let out2 = crate::process_util::command("git")
            .args([
                "-C",
                &project,
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                &rel,
            ])
            .output();
        if let Ok(o2) = out2 {
            if o2.status.success() {
                return Ok(GitCheckoutFileResult {
                    ok: true,
                    absolute_path: Some(abs.to_string_lossy().to_string()),
                    relative_path: Some(rel),
                    needs_untracked_confirm: false,
                    reason: None,
                    action: Some("restored".into()),
                });
            }
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Ok(GitCheckoutFileResult {
            ok: false,
            absolute_path: Some(abs.to_string_lossy().to_string()),
            relative_path: Some(rel),
            needs_untracked_confirm: false,
            reason: Some(if err.is_empty() {
                "git checkout failed".into()
            } else {
                err.chars().take(200).collect()
            }),
            action: Some("none".into()),
        });
    }

    Ok(GitCheckoutFileResult {
        ok: true,
        absolute_path: Some(abs.to_string_lossy().to_string()),
        relative_path: Some(rel),
        needs_untracked_confirm: false,
        reason: None,
        action: Some("restored".into()),
    })
}

/// Delete a path under the project only (non-git untracked reject after confirm).
#[tauri::command]
pub async fn delete_project_file(
    project_path: String,
    path: String,
    confirm: bool,
) -> Result<GitCheckoutFileResult, String> {
    if !confirm {
        return Ok(GitCheckoutFileResult {
            ok: false,
            absolute_path: None,
            relative_path: None,
            needs_untracked_confirm: true,
            reason: Some("delete requires confirm".into()),
            action: Some("none".into()),
        });
    }
    let (_root, rel, abs) = match resolve_path_under_project(&project_path, &path) {
        Ok(v) => v,
        Err(reason) => {
            return Ok(GitCheckoutFileResult {
                ok: false,
                absolute_path: None,
                relative_path: None,
                needs_untracked_confirm: false,
                reason: Some(reason),
                action: Some("none".into()),
            });
        }
    };
    if abs.is_dir() {
        return Ok(GitCheckoutFileResult {
            ok: false,
            absolute_path: Some(abs.to_string_lossy().to_string()),
            relative_path: Some(rel),
            needs_untracked_confirm: false,
            reason: Some("refusing to delete directory".into()),
            action: Some("none".into()),
        });
    }
    if abs.is_file() {
        if let Err(e) = std::fs::remove_file(&abs) {
            return Ok(GitCheckoutFileResult {
                ok: false,
                absolute_path: Some(abs.to_string_lossy().to_string()),
                relative_path: Some(rel),
                needs_untracked_confirm: false,
                reason: Some(format!("delete: {e}")),
                action: Some("none".into()),
            });
        }
    }
    Ok(GitCheckoutFileResult {
        ok: true,
        absolute_path: Some(abs.to_string_lossy().to_string()),
        relative_path: Some(rel),
        needs_untracked_confirm: false,
        reason: None,
        action: Some("deleted".into()),
    })
}

#[cfg(test)]
mod git_status_parse_tests {
    use super::*;

    #[test]
    fn porcelain_modified_worktree() {
        let e = parse_porcelain_line(" M src/app.ts", "/proj").expect("entry");
        assert_eq!(e.path, "src/app.ts");
        assert_eq!(e.status, " M");
        assert_eq!(e.kind, "modified");
        assert_eq!(e.name, "app.ts");
        assert!(e.absolute_path.ends_with("src/app.ts"));
    }

    #[test]
    fn porcelain_untracked() {
        let e = parse_porcelain_line("?? new.md", "/proj").expect("entry");
        assert_eq!(e.kind, "untracked");
        assert_eq!(e.path, "new.md");
    }

    #[test]
    fn porcelain_added_staged() {
        let e = parse_porcelain_line("A  foo/bar.rs", "/repo").expect("entry");
        assert_eq!(e.kind, "added");
        assert_eq!(e.index_status, "A");
    }

    #[test]
    fn porcelain_rename() {
        let e = parse_porcelain_line("R  old.ts -> new.ts", "/repo").expect("entry");
        assert_eq!(e.kind, "renamed");
        assert_eq!(e.path, "new.ts");
        assert_eq!(e.original_path.as_deref(), Some("old.ts"));
    }

    #[test]
    fn porcelain_conflict() {
        let e = parse_porcelain_line("UU merge.txt", "/repo").expect("entry");
        assert_eq!(e.kind, "conflict");
    }

    #[test]
    fn porcelain_deleted() {
        let e = parse_porcelain_line(" D gone.ts", "/repo").expect("entry");
        assert_eq!(e.kind, "deleted");
    }

    #[test]
    fn kind_helpers() {
        assert_eq!(git_status_kind('?', '?'), "untracked");
        assert_eq!(git_status_kind('M', ' '), "modified");
        assert_eq!(git_status_kind(' ', 'M'), "modified");
        assert_eq!(git_status_kind('A', ' '), "added");
        assert_eq!(git_status_kind('D', ' '), "deleted");
    }

    #[test]
    fn resolve_path_under_project_relative_ok() {
        let tmp = std::env::temp_dir().join(format!(
            "grok-diff-accept-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let r = resolve_path_under_project(
            &tmp.to_string_lossy(),
            "src/hello.ts",
        );
        assert!(r.is_ok(), "{r:?}");
        let (_root, rel, abs) = r.unwrap();
        assert_eq!(rel, "src/hello.ts");
        // Path separators differ on Windows — compare POSIX form.
        let abs_posix = abs.to_string_lossy().replace('\\', "/");
        assert!(
            abs_posix.ends_with("src/hello.ts"),
            "abs={abs_posix}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_path_under_project_rejects_escape() {
        let tmp = std::env::temp_dir().join(format!(
            "grok-diff-escape-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let r = resolve_path_under_project(&tmp.to_string_lossy(), "../outside.txt");
        assert!(r.is_err(), "parent escape should fail: {r:?}");
        // Unix-style absolute must not become project-relative (Windows Path::is_absolute is false).
        let r2 = resolve_path_under_project(&tmp.to_string_lossy(), "/etc/passwd");
        assert!(r2.is_err(), "unix absolute should fail: {r2:?}");
        let r3 = resolve_path_under_project(&tmp.to_string_lossy(), "\\\\server\\share\\x");
        assert!(r3.is_err(), "unc-style should fail: {r3:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

// ── Git worktrees (issue #42) ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeEntry {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub is_main: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreesResult {
    pub available: bool,
    pub worktrees: Vec<GitWorktreeEntry>,
    pub reason: Option<String>,
    /// Absolute `~/.grok` used for CLI-aligned worktree placement / detection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_grok_home: Option<String>,
}

/// Parse `git worktree list --porcelain` (pure; unit-tested).
pub fn parse_worktree_porcelain(raw: &str) -> Vec<GitWorktreeEntry> {
    let text = raw.replace("\r\n", "\n");
    if text.trim().is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let mut path = String::new();
        let mut head: Option<String> = None;
        let mut branch: Option<String> = None;
        let mut detached = false;
        let mut locked = false;
        let mut prunable = false;

        for line in block.lines() {
            let t = line.trim_end();
            if let Some(rest) = t.strip_prefix("worktree ") {
                path = rest.trim().replace('\\', "/");
                while path.ends_with('/') && path.len() > 1 {
                    path.pop();
                }
            } else if let Some(rest) = t.strip_prefix("HEAD ") {
                let h = rest.trim();
                head = if h.is_empty() {
                    None
                } else {
                    Some(h.to_string())
                };
            } else if let Some(rest) = t.strip_prefix("branch ") {
                let r = rest.trim();
                branch = if let Some(name) = r.strip_prefix("refs/heads/") {
                    Some(name.to_string())
                } else if r.is_empty() {
                    None
                } else {
                    Some(r.to_string())
                };
            } else if t == "detached" {
                detached = true;
            } else if t.starts_with("locked") {
                locked = true;
            } else if t.starts_with("prunable") {
                prunable = true;
            }
        }

        if path.is_empty() {
            continue;
        }
        if detached {
            branch = None;
        }
        out.push(GitWorktreeEntry {
            path,
            head,
            branch,
            detached,
            is_main: out.is_empty(),
            locked,
            prunable,
        });
    }
    // First entry is main
    for (i, w) in out.iter_mut().enumerate() {
        w.is_main = i == 0;
    }
    out
}

/// List linked git worktrees for a project folder. Soft-fails without git / non-repo.
#[tauri::command]
pub async fn git_worktrees_list(project_path: String) -> Result<GitWorktreesResult, String> {
    let cli_home = shared_cli_grok_home()
        .to_string_lossy()
        .replace('\\', "/");
    let cli_grok_home = Some(normalize_fs_path(&cli_home));
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Ok(GitWorktreesResult {
            available: false,
            worktrees: vec![],
            reason: Some("empty path".into()),
            cli_grok_home,
        });
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Ok(GitWorktreesResult {
            available: false,
            worktrees: vec![],
            reason: Some("project not a directory".into()),
            cli_grok_home,
        });
    }
    if let Err(reason) = git_probe_work_tree(&project) {
        return Ok(GitWorktreesResult {
            available: false,
            worktrees: vec![],
            reason: Some(reason),
            cli_grok_home,
        });
    }

    let out = crate::process_util::command("git")
        .args(["-C", &project, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Ok(GitWorktreesResult {
            available: false,
            worktrees: vec![],
            reason: Some(if err.is_empty() {
                "git worktree list failed".into()
            } else {
                err.chars().take(200).collect()
            }),
            cli_grok_home,
        });
    }

    let raw = String::from_utf8_lossy(&out.stdout);
    let worktrees = parse_worktree_porcelain(&raw);
    Ok(GitWorktreesResult {
        available: true,
        worktrees,
        reason: None,
        cli_grok_home,
    })
}

#[cfg(test)]
mod git_worktree_parse_tests {
    use super::*;

    #[test]
    fn parses_main_and_linked() {
        let raw = "\
worktree /Users/me/repo
HEAD abcdef
branch refs/heads/main

worktree /Users/me/repo-feat
HEAD fedcba
branch refs/heads/feat/x

worktree /Users/me/repo-d
HEAD 112233
detached
";
        let list = parse_worktree_porcelain(raw);
        assert_eq!(list.len(), 3);
        assert!(list[0].is_main);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].branch.as_deref(), Some("feat/x"));
        assert!(!list[1].is_main);
        assert!(list[2].detached);
        assert!(list[2].branch.is_none());
    }

    #[test]
    fn empty_input() {
        assert!(parse_worktree_porcelain("").is_empty());
    }
}

/// Reveal a path in the system file manager (Finder / Explorer).
#[tauri::command]
pub async fn path_reveal(path: String) -> Result<(), String> {
    let p = normalize_fs_path(&path);
    if p.is_empty() {
        return Err("empty path".into());
    }
    let pb = std::path::PathBuf::from(&p);
    if !pb.exists() {
        return Err(format!("path not found: {p}"));
    }
    #[cfg(target_os = "macos")]
    {
        crate::process_util::command("open")
            .args(["-R", &p])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // explorer /select,<path> — works with spaces on modern Windows.
        crate::process_util::command("explorer")
            .arg(format!("/select,{p}"))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Open parent directory
        let parent = pb
            .parent()
            .map(|x| x.to_path_buf())
            .unwrap_or(pb.clone());
        crate::process_util::command("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Add project via native folder dialog; optional auto-trust.
#[tauri::command]
pub async fn project_add_dialog(trust: bool) -> Result<Option<Project>, String> {
    let folder = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("添加项目 / Add project")
            .pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = folder else {
        return Ok(None);
    };
    let p = store::add_project(path.display().to_string(), trust)?;
    Ok(Some(p))
}

// ── Official Grok Build account ─────────────────────────────────────────────

#[tauri::command]
pub async fn account_status(
    refresh_billing: Option<bool>,
    manual_cli_path: Option<String>,
) -> Result<crate::account::AccountStatus, String> {
    let settings = store::load_settings();
    let manual = manual_cli_path
        .or(settings.manual_cli_path)
        .filter(|s| !s.is_empty());
    Ok(crate::account::account_status(manual.as_deref(), refresh_billing.unwrap_or(true)).await)
}

#[tauri::command]
pub async fn account_login(
    method: Option<String>,
    manual_cli_path: Option<String>,
) -> Result<crate::account::LoginResult, String> {
    let settings = store::load_settings();
    let manual = manual_cli_path
        .or(settings.manual_cli_path)
        .filter(|s| !s.is_empty());
    let method = method.unwrap_or_else(|| "oauth".into());
    Ok(crate::account::account_login(&method, manual.as_deref()).await)
}

/// Abort a running `grok login` (OAuth / device-code). No-op if none is running.
#[tauri::command]
pub async fn account_login_cancel() -> Result<(), String> {
    crate::account::account_login_cancel().await;
    Ok(())
}

#[tauri::command]
pub async fn account_logout(
    manual_cli_path: Option<String>,
) -> Result<crate::account::AccountProfile, String> {
    let settings = store::load_settings();
    let manual = manual_cli_path
        .or(settings.manual_cli_path)
        .filter(|s| !s.is_empty());
    crate::account::account_logout(manual.as_deref()).await
}

#[tauri::command]
pub async fn account_open_usage() -> Result<(), String> {
    crate::account::open_usage_manage().await
}

#[tauri::command]
pub async fn account_open_subscribe() -> Result<(), String> {
    crate::account::open_subscribe().await
}

// ── Multi-account profiles ─────────────────────────────────────────────────

#[tauri::command]
pub fn accounts_list() -> crate::account_profiles::AccountsListResult {
    crate::account_profiles::list_accounts()
}

#[tauri::command]
pub fn account_save_current(label: Option<String>) -> Result<crate::account_profiles::SavedAccount, String> {
    crate::account_profiles::save_current_account(label)
}

#[tauri::command]
pub async fn account_switch(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
) -> Result<crate::account::AccountProfile, String> {
    let profile = crate::account_profiles::switch_account(&id)?;
    // Soft-drop live agent so next send uses the new credentials.
    let _ = mgr.disconnect(app).await;
    Ok(profile)
}

#[tauri::command]
pub fn account_remove(id: String) -> Result<(), String> {
    crate::account_profiles::remove_account(&id)
}

#[tauri::command]
pub fn account_rename(
    id: String,
    label: String,
) -> Result<crate::account_profiles::SavedAccount, String> {
    crate::account_profiles::rename_account(&id, &label)
}

/// Import a markdown/JSON transcript into a new local session (Grok web history alternative).
#[tauri::command]
pub fn session_import_transcript(
    text: String,
    title: Option<String>,
    project_id: Option<String>,
) -> Result<store::SessionMeta, String> {
    crate::session_import::import_transcript_as_session(&text, title, project_id)
}

/// Native file picker → read text transcript → import as session.
#[tauri::command]
pub async fn session_import_transcript_file(
    title: Option<String>,
    project_id: Option<String>,
) -> Result<Option<store::SessionMeta>, String> {
    let path = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Import conversation / 导入对话")
            .add_filter("Transcript", &["md", "txt", "json", "markdown"])
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = path else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read file: {e}"))?;
    let derived_title = title.or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    });
    let meta =
        crate::session_import::import_transcript_as_session(&text, derived_title, project_id)?;
    Ok(Some(meta))
}

// ── Custom providers (agent-home config.toml) ───────────────────────────────

/// Scan CC Switch Grok Build providers (read-only SQLite).
#[tauri::command]
pub async fn providers_cc_switch_scan(
) -> Result<crate::cc_switch_import::CcSwitchScanResult, String> {
    Ok(tauri::async_runtime::spawn_blocking(
        crate::cc_switch_import::scan_cc_switch_providers,
    )
    .await
    .map_err(|e| e.to_string())?)
}

/// Import selected CC Switch Grok Build providers into App custom providers.
#[tauri::command]
pub async fn providers_cc_switch_import(
    body: crate::cc_switch_import::CcSwitchImportRequest,
) -> Result<crate::cc_switch_import::CcSwitchImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::cc_switch_import::import_cc_switch_providers(body)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn providers_list() -> Result<crate::providers::ProvidersListResult, String> {
    // Blocking file I/O off the async runtime (migrations / repairs / list).
    tauri::async_runtime::spawn_blocking(|| {
        // One-time migration of legacy single relay secrets → multi-provider config.
        let secrets = store::load_secrets();
        let _ = crate::providers::maybe_migrate_legacy_relay(
            secrets.relay_base_url.as_deref(),
            secrets.relay_api_key.as_deref(),
            secrets.default_model.as_deref(),
        );
        // Ensure agent transport retries are high enough for flaky custom relays.
        let _ = crate::providers::ensure_models_retry_cap();
        // Fix bases saved without /v1 (causes silent multi-minute inference retries).
        let _ = crate::providers::repair_custom_base_urls();
        crate::providers::list_custom_providers()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Activate official Grok Build or a custom provider; returns updated list.
///
/// Recycles warm agents so the next send spawns with rebound auth / config
/// (no full app restart).
#[tauri::command]
pub async fn providers_activate(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    source: String,
    provider_id: Option<String>,
) -> Result<crate::providers::ProvidersListResult, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result =
            crate::providers::activate_provider(&source, provider_id.as_deref())?;
        // Composer model stays a catalog id (UI). Channel is `[models].default`.
        // When leaving a custom route, drop stale provider ids from settings.
        let mut settings = store::load_settings();
        let cur = settings.model_id.clone().unwrap_or_default();
        if result.active_source == "official" {
            if cur.is_empty()
                || crate::providers::is_custom_provider_id(&cur)
                || cur == crate::providers::OFFICIAL_DEFAULT_MODEL
            {
                settings.model_id =
                    Some(crate::providers::OFFICIAL_CATALOG_MODEL.into());
                let _ = store::save_settings(&settings);
            }
        } else if result.active_source == "custom" {
            // Keep catalog model in settings for the model picker; spawn resolves route id.
            if cur.is_empty() || crate::providers::is_custom_provider_id(&cur) {
                if let Some(p) = result
                    .active_provider_id
                    .as_ref()
                    .and_then(|id| result.providers.iter().find(|x| x.id == *id))
                {
                    let upstream = p.model.trim();
                    settings.model_id = Some(if upstream.is_empty() {
                        crate::providers::OFFICIAL_CATALOG_MODEL.into()
                    } else {
                        upstream.to_string()
                    });
                } else {
                    settings.model_id =
                        Some(crate::providers::OFFICIAL_CATALOG_MODEL.into());
                }
                let _ = store::save_settings(&settings);
            }
        }
        Ok::<_, String>(result)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Parked processes keep old GROK_HOME auth/config in memory — kill them.
    mgr.recycle_all_agents(&app, "provider_route").await;
    Ok(result)
}

#[tauri::command]
pub async fn providers_upsert(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
    model: String,
    base_url: String,
    name: Option<String>,
    api_key: Option<String>,
    api_backend: Option<String>,
    set_as_default: Option<bool>,
    create_only: Option<bool>,
    models: Option<Vec<crate::providers::ProviderModelEntry>>,
    efforts: Option<Vec<crate::providers::ProviderEffortEntry>>,
) -> Result<crate::providers::ProvidersListResult, String> {
    let set_default_flag = set_as_default.unwrap_or(false);
    let mutated_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result =
            crate::providers::upsert_custom_provider(crate::providers::UpsertProviderInput {
                id,
                model: model.clone(),
                base_url,
                name,
                api_key,
                api_backend,
                set_as_default,
                create_only,
                models,
                efforts,
            })?;
        // Keep legacy secrets in sync for Doctor / account channel display.
        if let Some(p) = result
            .providers
            .iter()
            .find(|p| p.is_default)
            .or(result.providers.first())
        {
            let mut secrets = store::load_secrets();
            secrets.relay_base_url = Some(p.base_url.clone());
            secrets.default_model = result.default_model.clone();
            // Do not copy api_key into secrets (stays only in config.toml).
            let _ = store::save_secrets(&secrets);
            if set_as_default.unwrap_or(false) {
                let mut settings = store::load_settings();
                // Composer shows upstream request model, not the route slug.
                let upstream = p.model.trim();
                settings.model_id = Some(if upstream.is_empty() {
                    crate::providers::OFFICIAL_CATALOG_MODEL.into()
                } else {
                    upstream.to_string()
                });
                let _ = store::save_settings(&settings);
            }
        }
        Ok::<_, String>(result)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Apply active-route / active-provider edits without requiring app restart.
    // Recycle (not mere park) so parked shells cannot reopen with stale OIDC.
    if crate::providers::provider_mutation_needs_agent_reload(
        set_default_flag,
        &mutated_id,
        &result,
    ) {
        mgr.recycle_all_agents(&app, "provider_route").await;
    }
    Ok(result)
}

#[tauri::command]
pub async fn providers_remove(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
) -> Result<crate::providers::ProvidersListResult, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::providers::remove_custom_provider(&id)
    })
    .await
    .map_err(|e| e.to_string())??;
    // Removing a provider (esp. the active one) must not leave warm agents on
    // a deleted route id.
    mgr.recycle_all_agents(&app, "provider_route").await;
    Ok(result)
}

#[tauri::command]
pub async fn providers_set_default(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    model_id: String,
) -> Result<crate::providers::ProvidersListResult, String> {
    // Prefer activate_provider so auth material is rebound correctly.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let id = model_id.trim().to_string();
        let list = crate::providers::list_custom_providers()?;
        let result = if list.providers.iter().any(|p| p.id == id) {
            crate::providers::activate_provider("custom", Some(&id))?
        } else {
            crate::providers::activate_provider("official", None)?
        };
        let mut settings = store::load_settings();
        if result.active_source == "custom" {
            if let Some(p) = result
                .active_provider_id
                .as_ref()
                .and_then(|pid| result.providers.iter().find(|x| x.id == *pid))
            {
                let upstream = p.model.trim();
                settings.model_id = Some(if upstream.is_empty() {
                    crate::providers::OFFICIAL_CATALOG_MODEL.into()
                } else {
                    upstream.to_string()
                });
            }
        } else {
            settings.model_id = Some(crate::providers::OFFICIAL_CATALOG_MODEL.into());
        }
        let _ = store::save_settings(&settings);
        Ok::<_, String>(result)
    })
    .await
    .map_err(|e| e.to_string())??;

    mgr.recycle_all_agents(&app, "provider_route").await;
    Ok(result)
}

#[tauri::command]
pub async fn providers_ping(
    base_url: Option<String>,
    api_key: Option<String>,
    provider_id: Option<String>,
) -> Result<crate::providers::ProviderPingResult, String> {
    crate::providers::ping_provider(base_url, api_key, provider_id).await
}

#[tauri::command]
pub async fn providers_list_models(
    base_url: String,
    api_key: Option<String>,
    provider_id: Option<String>,
) -> Result<crate::providers::RemoteModelsResult, String> {
    crate::providers::list_remote_models(base_url, api_key, provider_id).await
}

// ── Editors ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn editors_list() -> Result<crate::editors::EditorsListResult, String> {
    Ok(crate::editors::list_editors_with_icons())
}

#[tauri::command]
pub async fn open_in_editor(
    path: String,
    line: Option<u32>,
    editor: Option<String>,
) -> Result<(), String> {
    let settings = store::load_settings();
    let target = editor
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| settings.default_open_target.clone());
    crate::editors::open_in_editor(&path, line, Some(target.as_str()))
}

#[cfg(test)]
mod project_inspect_tests {
    use super::build_project_inspect_summary;

    #[test]
    fn summary_strips_mcp_env_and_skill_descriptions() {
        let raw = serde_json::json!({
            "grokVersion": "0.2.0",
            "projectRoot": "/tmp/p/",
            "projectTrusted": true,
            "skills": [{
                "name": "help",
                "description": "secret sk-abcdefghijklmnopqrstuvwxyz",
                "source": { "type": "user" },
                "userInvocable": true
            }],
            "mcpServers": [{
                "name": "ctx",
                "transport": "stdio",
                "target": "/bin/npx",
                "env": { "API_KEY": "sk-secretsecretsecret" }
            }],
            "plugins": [{ "name": "p1", "scope": "user", "enabled": true }],
            "agents": [{ "name": "explore", "source": { "type": "builtin" } }],
            "projectInstructions": [{ "path": "/tmp/p/AGENTS.md", "scope": "project" }],
            "hooks": [{
                "event": "stop",
                "hookType": "file",
                "target": "/tmp/p/.grok/hooks/stop.json",
                "source": { "type": "project" }
            }],
            "permissions": { "loaded": 0, "sources": [], "managedSettingsActive": false }
        });
        let out = build_project_inspect_summary(
            Some(&raw),
            Some("/tmp/p"),
            None,
            vec!["grok-4".into()],
        );
        let s = out.to_string();
        assert!(s.contains("\"help\""));
        assert!(s.contains("\"ctx\""));
        assert!(s.contains("AGENTS.md"));
        assert!(!s.contains("sk-secret"));
        assert!(!s.contains("API_KEY"));
        assert!(!s.contains("sk-abcdefghijklmnopqrstuvwxyz"));
        assert_eq!(out["skills"]["total"], 1);
        assert_eq!(out["skills"]["names"][0], "help");
        assert_eq!(out["mcp"][0]["name"], "ctx");
        assert!(out["mcp"][0].get("env").is_none());
        assert_eq!(out["hooksCount"], 1);
        assert_eq!(out["hooks"][0]["event"], "stop");
        assert_eq!(out["hooks"][0]["source"], "project");
        assert_eq!(out["agents"][0]["name"], "explore");
        assert!(out["modelsHints"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("grok-4")));
    }

    #[test]
    fn summary_handles_missing_inspect() {
        let out = build_project_inspect_summary(
            None,
            Some("/tmp/p"),
            Some("Grok Build CLI not found".into()),
            vec![],
        );
        assert_eq!(out["skills"]["total"], 0);
        assert_eq!(out["error"], "Grok Build CLI not found");
    }
}

// ── Community PR batch (#63–#91) ─────────────────────────

// from PR #88

/// Timeout for `grok doctor fix <id> --yes` (may rewrite shell rc / config).
const CLI_DOCTOR_FIX_TIMEOUT_SECS: u64 = 30;

// from PR #68

const MCP_DOCTOR_TIMEOUT_SECS: u64 = 90;

// from PR #77

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefDto {
    pub name: String,
    pub path: String,
    /// "project" | "user" | "bundled"
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

// from PR #64

/// Result of creating a linked worktree (`git worktree add`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeAddResult {
    /// Absolute path of the new worktree directory.
    pub path: String,
    /// Sanitized worktree / new-branch name.
    pub name: String,
    /// Optional start-point / commit-ish that was used.
    pub start_point: Option<String>,
    /// Branch checked out after add (best-effort from re-list).
    pub branch: Option<String>,
}

// from PR #83

/// Result of `git worktree prune` (gc / clean stale admin files).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeGcResult {
    /// Whether this was a dry-run (`-n`).
    pub dry_run: bool,
    /// Whether aggressive expire (`now`) was applied via force without max_age.
    pub forced: bool,
    /// Optional `--expire` value that was used.
    pub max_age: Option<String>,
    /// Combined verbose prune output (stdout + stderr, trimmed).
    pub output: String,
    /// Paths marked `prunable` in `git worktree list --porcelain` before prune.
    pub prunable: Vec<String>,
    /// Best-effort count of removals reported in prune output.
    pub pruned_count: usize,
}

// from PR #74

/// Result of `git worktree remove`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeRemoveResult {
    /// Absolute path that was removed.
    pub path: String,
    /// Whether `--force` was used.
    pub forced: bool,
}

// from PR #77

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaDefDto {
    pub name: String,
    pub path: String,
    pub scope: String,
}

// from PR #77

/// Read-only soft-fail list of discovered Grok Build workflow scripts
/// (`~/.grok/workflows` + project `.grok/workflows` + independent agent-home).
/// Never invents runners; empty dirs return an empty list.
#[tauri::command]
pub async fn workflows_list(
    project_path: Option<String>,
) -> Result<crate::agent_workflows::DiscoverWorkflowsResult, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let mode = store::load_settings().session_data_mode.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_workflows::discover_workflows(project.as_deref(), &mode)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Soft-fail headless run of a discovered Grok Build workflow by name.
///
/// There is no top-level `grok workflow` CLI subcommand; the host spawns a
/// short `grok -p` that must call the agent `workflow` tool. Default mode is
/// `validate` (`validate_only: true` smoke). Returns structured ok / reason /
/// redacted truncated log — never panics on CLI missing / timeout.
#[tauri::command]
pub async fn workflows_run(
    name: String,
    project_path: Option<String>,
    mode: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<crate::agent_workflows::WorkflowRunResult, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let mode_owned = mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_workflows::run_workflow(
            &name,
            project.as_deref(),
            mode_owned.as_deref(),
            timeout_ms,
        )
    })
    .await
    .map_err(|e| format!("workflows_run: {e}"))
}

/// List agent + persona definition files from user / project / bundled scopes.
/// Does not require the CLI binary (pure filesystem discovery under `~/.grok`,
/// active GROK_HOME / agent-home, and optional `{project}/.grok`). Always returns Ok.
#[tauri::command]
pub async fn agents_list(project_path: Option<String>) -> Result<serde_json::Value, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let home = crate::process_util::user_home();
        let grok = home.join(".grok");
        let user_agents = grok.join("agents");
        let bundled_agents = grok.join("bundled").join("agents");
        let user_personas = grok.join("personas");
        let bundled_personas = grok.join("bundled").join("personas");

        let project_agents = project.as_ref().map(|p| {
            std::path::PathBuf::from(p).join(".grok").join("agents")
        });
        let project_personas = project.as_ref().map(|p| {
            std::path::PathBuf::from(p).join(".grok").join("personas")
        });

        let settings = store::load_settings();
        let active_home =
            crate::paths::resolve_agent_grok_home(&settings.session_data_mode);
        let active_user_agents = active_home.join("agents");

        let mut agents = Vec::new();
        if let Some(ref dir) = project_agents {
            agents.extend(scan_agent_dir(dir, "project"));
        }
        agents.extend(scan_agent_dir(&user_agents, "user"));
        if active_user_agents != user_agents {
            // Independent mode: defs under agent-home count as user scope.
            for a in scan_agent_dir(&active_user_agents, "user") {
                if !agents
                    .iter()
                    .any(|e| e.scope == "user" && e.name.eq_ignore_ascii_case(&a.name))
                {
                    agents.push(a);
                }
            }
        }
        agents.extend(scan_agent_dir(&bundled_agents, "bundled"));
        let agents = sort_agent_defs(agents);

        let mut personas = Vec::new();
        if let Some(ref dir) = project_personas {
            personas.extend(scan_persona_dir(dir, "project"));
        }
        personas.extend(scan_persona_dir(&user_personas, "user"));
        personas.extend(scan_persona_dir(&bundled_personas, "bundled"));
        let personas = sort_persona_defs(personas);

        let user_agents_dir = if active_user_agents != user_agents {
            active_user_agents.to_string_lossy().to_string()
        } else {
            user_agents.to_string_lossy().to_string()
        };

        serde_json::json!({
            "agents": agents,
            "personas": personas,
            "userAgentsDir": user_agents_dir,
            "projectAgentsDir": project_agents
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            "bundledAgentsDir": bundled_agents.to_string_lossy(),
            "userPersonasDir": user_personas.to_string_lossy(),
            "projectPersonasDir": project_personas
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            "bundledPersonasDir": bundled_personas.to_string_lossy(),
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Create a SKILL-like agent definition markdown under user GROK_HOME or
/// project `.grok/agents`. Path-scoped; rejects overwrite unless `force`.
#[tauri::command]
pub async fn agents_scaffold(
    name: String,
    scope: Option<String>,
    project_path: Option<String>,
    force: Option<bool>,
    description: Option<String>,
) -> Result<crate::agents_catalog::AgentsScaffoldResult, String> {
    let scope = scope.unwrap_or_else(|| "user".into());
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        crate::agents_catalog::scaffold_agent(
            &name,
            &scope,
            project_path.as_deref(),
            force,
            description.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// from PR #83

/// Build argv for `git worktree prune` (no binary name; caller prefixes `git`).
///
/// Layout: `[-C <project>] worktree prune -v [--dry-run] [--expire <age>]`
///
/// - `dry_run` → `--dry-run` (report only)
/// - `max_age` → `--expire <max_age>` when set
/// - `force` without `max_age` → `--expire now` (prune all stale admin files now)
/// - always `-v` so dry-run preview has useful lines
///
/// Pure; unit-tested. Never goes through a shell.
pub fn build_worktree_gc_args(
    project: &str,
    dry_run: bool,
    force: bool,
    max_age: Option<&str>,
) -> Result<Vec<String>, String> {
    let project = normalize_fs_path(project);
    if project.is_empty() {
        return Err("empty path".into());
    }
    if project.starts_with('-') {
        return Err("invalid project path".into());
    }
    let expire = match sanitize_worktree_gc_max_age(max_age)? {
        Some(age) => Some(age),
        None if force => Some("now".into()),
        None => None,
    };

    let mut args: Vec<String> = vec![
        "-C".into(),
        project,
        "worktree".into(),
        "prune".into(),
        "-v".into(),
    ];
    if dry_run {
        args.push("--dry-run".into());
    }
    if let Some(age) = expire {
        args.push("--expire".into());
        args.push(age);
    }
    Ok(args)
}

// from PR #64

/// Path placement for new linked worktrees (`cli` default, or `sibling`).
pub fn normalize_worktree_layout(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.eq_ignore_ascii_case("sibling") => "sibling",
        _ => "cli",
    }
}

/// Shared CLI GROK_HOME (`~/.grok`) used for worktree placement.
/// Matches Grok Build 0.2.x `~/.grok/worktrees/<repo>/…` regardless of
/// App independent agent-home (git worktrees are filesystem layout, not session store).
pub fn shared_cli_grok_home() -> std::path::PathBuf {
    crate::process_util::user_home().join(".grok")
}

/// CLI worktrees root: `{GROK_HOME}/worktrees`.
pub fn cli_worktrees_home(grok_home: &std::path::Path) -> std::path::PathBuf {
    grok_home.join("worktrees")
}

/// Repo folder slug for CLI layout (main worktree basename).
pub fn worktree_repo_slug(main_worktree_path: &str) -> Result<String, String> {
    let main = normalize_fs_path(main_worktree_path);
    if main.is_empty() {
        return Err("empty main worktree path".into());
    }
    let main_pb = std::path::PathBuf::from(&main);
    main_pb
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "cannot derive repo folder name".to_string())
}

/// CLI-aligned path: `{GROK_HOME}/worktrees/<main_basename>/<name>`.
///
/// Example: grok_home `~/.grok`, main `/Users/me/Code/oss-grok-app`, name `feat`
/// → `~/.grok/worktrees/oss-grok-app/feat`.
///
/// Matches Grok Build 0.2.x (`grok --worktree=…`, `grok worktree list`).
pub fn build_worktree_cli_path(
    main_worktree_path: &str,
    name: &str,
    grok_home: &std::path::Path,
) -> Result<String, String> {
    let main = normalize_fs_path(main_worktree_path);
    if main.is_empty() {
        return Err("empty main worktree path".into());
    }
    let safe = sanitize_worktree_name(name)?;
    let slug = worktree_repo_slug(&main)?;
    let path = cli_worktrees_home(grok_home).join(slug).join(safe);
    let s = path.to_string_lossy().replace('\\', "/");
    let s = normalize_fs_path(&s);
    if s == main || s.is_empty() {
        return Err("resolved worktree path is invalid".into());
    }
    Ok(s)
}

/// Build sibling worktree path: `<parent>/<main_basename>-<name>`.
///
/// Example: main `/Users/me/repo` + name `feat` → `/Users/me/repo-feat`.
///
/// Optional alternative to CLI home layout — matches common
/// `git worktree add ../repo-feat` practice.
pub fn build_worktree_sibling_path(main_worktree_path: &str, name: &str) -> Result<String, String> {
    let main = normalize_fs_path(main_worktree_path);
    if main.is_empty() {
        return Err("empty main worktree path".into());
    }
    let safe = sanitize_worktree_name(name)?;
    let main_pb = std::path::PathBuf::from(&main);
    let base = main_pb
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "cannot derive repo folder name".to_string())?;
    let parent = main_pb
        .parent()
        .ok_or_else(|| "main worktree has no parent directory".to_string())?;
    let dir_name = format!("{base}-{safe}");
    let path = parent.join(dir_name);
    let s = path.to_string_lossy().replace('\\', "/");
    let s = normalize_fs_path(&s);
    if s == main || s.is_empty() {
        return Err("resolved worktree path is invalid".into());
    }
    Ok(s)
}

/// Resolve create path for layout (`cli` default, or `sibling`).
pub fn build_worktree_path_for_layout(
    layout: Option<&str>,
    main_worktree_path: &str,
    name: &str,
) -> Result<String, String> {
    match normalize_worktree_layout(layout) {
        "sibling" => build_worktree_sibling_path(main_worktree_path, name),
        _ => build_worktree_cli_path(main_worktree_path, name, &shared_cli_grok_home()),
    }
}

// from PR #88

/// Apply a CLI automatic remediation: `grok doctor fix <id> --yes`.
/// Returns redacted stdout/stderr; never throws on non-zero exit (ok=false).
#[tauri::command]
pub async fn cli_doctor_fix(id: String) -> Result<serde_json::Value, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("doctor fix id required".into());
    }
    if !is_safe_doctor_fix_id(&id) {
        return Err(format!("invalid doctor fix id: {id}"));
    }

    let id_for_cmd = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["doctor", "fix", &id_for_cmd, "--yes"],
            CLI_DOCTOR_FIX_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| format!("doctor fix worker panicked: {e}"))?;

    match result {
        Ok((stdout, stderr, exit_ok)) => Ok(serde_json::json!({
            "ok": exit_ok,
            "id": id,
            "stdout": redact_doctor_fix_output(&stdout, 2000),
            "stderr": redact_doctor_fix_output(&stderr, 800),
            "exitOk": exit_ok,
        })),
        Err(e) => {
            // Missing CLI / timeout — surface as structured failure, not panic.
            Ok(serde_json::json!({
                "ok": false,
                "id": id,
                "stdout": "",
                "stderr": redact_doctor_fix_output(&e, 400),
                "exitOk": false,
                "error": redact_doctor_fix_output(&e, 400),
            }))
        }
    }
}

// from PR #63

/// Run resolved `grok update --check --json` and return a typed DTO.
#[tauri::command]
pub async fn cli_update_check() -> Result<crate::cli_update::CliUpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let settings = store::load_settings();
        crate::cli_update::check_cli_update(settings.manual_cli_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// from PR #63 / channel UX (CLI ≥ 0.2.117)

/// Install CLI update / switch channel / pin version.
///
/// Optional `channel` (`stable`|`alpha`), `version` pin, and `force` reinstall.
/// Channel switch and version pin are mutually exclusive; unknown channels error
/// (never invented). Plain update still falls back to App install trust-chain.
#[tauri::command]
pub async fn cli_update_install(
    app: tauri::AppHandle,
    channel: Option<String>,
    version: Option<String>,
    force: Option<bool>,
) -> Result<crate::cli_install::CliInstallResult, String> {
    let opts = crate::cli_update::CliUpdateInstallOpts {
        channel,
        version,
        force: force.unwrap_or(false),
    };
    crate::cli_update::install_cli_update(app, opts).await
}

/// Recycle every warm agent process so the next send spawns fresh binaries.
/// Used after a CLI upgrade — running children keep executing the old image
/// until restarted (NEW-05). Chat history is untouched; sessions reconnect
/// lazily on the next send.
#[tauri::command]
pub async fn agents_recycle_all(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<(), String> {
    mgr.recycle_all_agents(&app, "cli_upgrade").await;
    Ok(())
}

// from PR #83

/// Count removal-like lines in `git worktree prune -v` output (best-effort).
pub fn count_worktree_prune_lines(output: &str) -> usize {
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| {
            let lower = l.to_ascii_lowercase();
            lower.contains("remov") || lower.contains("prun") || lower.starts_with("would ")
        })
        .count()
}

// from PR #77

/// Best-effort YAML frontmatter `description:` (first line / plain value).
fn extract_agent_description_from_content(content: &str) -> Option<String> {
    if !content.starts_with("---") {
        return None;
    }
    let rest = &content[3..];
    let end = rest.find("\n---")?;
    let fm = &rest[..end];
    for (i, line) in fm.lines().enumerate() {
        let trimmed = line.trim_start();
        if let Some(val) = trimmed.strip_prefix("description:") {
            let v = val.trim();
            if v == ">" || v == "|" || v == ">-" || v == "|-" {
                // Folded block: first non-empty indented line after this one.
                for next in fm.lines().skip(i + 1) {
                    if next.starts_with(' ') || next.starts_with('\t') {
                        let t = next.trim();
                        if !t.is_empty() {
                            return Some(t.to_string());
                        }
                    } else if !next.trim().is_empty() {
                        break;
                    }
                }
                return None;
            }
            if v.is_empty() {
                return None;
            }
            let unquoted = v
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                .unwrap_or(v);
            let cleaned = unquoted.split_whitespace().collect::<Vec<_>>().join(" ");
            if cleaned.is_empty() {
                return None;
            }
            return Some(cleaned);
        }
    }
    None
}

// from PR #64

/// Create a linked git worktree, then return its path.
///
/// Default layout (`cli` / omitted): `{GROK_HOME}/worktrees/<repo>/<name>`
/// aligned with Grok Build 0.2.x (`grok --worktree=…`).
/// Optional `layout = "sibling"`: `<parent>/<main_basename>-<name>`.
///
/// Args are passed to `git` as an argv array (no shell) to avoid injection.
/// - Without `start_point`: `git worktree add -b <name> <path>` (branch from HEAD).
/// - With `start_point`: `git worktree add -b <name> <path> <start_point>`.
#[tauri::command]
pub async fn git_worktree_add(
    project_path: String,
    name: String,
    start_point: Option<String>,
    layout: Option<String>,
) -> Result<GitWorktreeAddResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    git_probe_work_tree(&project)?;

    let safe_name = sanitize_worktree_name(&name)?;
    let start = sanitize_worktree_ref(start_point.as_deref())?;
    let layout_kind = normalize_worktree_layout(layout.as_deref());

    // Resolve main worktree path (first porcelain entry) for path placement.
    let list_out = crate::process_util::command("git")
        .args(["-C", &project, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !list_out.status.success() {
        let err = String::from_utf8_lossy(&list_out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "git worktree list failed".into()
        } else {
            err.chars().take(200).collect()
        });
    }
    let listed = parse_worktree_porcelain(&String::from_utf8_lossy(&list_out.stdout));
    let main_path = listed
        .first()
        .map(|w| w.path.clone())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "could not resolve main worktree path".to_string())?;

    let target = build_worktree_path_for_layout(Some(layout_kind), &main_path, &safe_name)?;
    let target_pb = std::path::PathBuf::from(&target);
    if target_pb.exists() {
        return Err(format!("path already exists: {target}"));
    }
    // Refuse if already registered as a worktree.
    if listed.iter().any(|w| {
        let p = normalize_fs_path(&w.path);
        p.eq_ignore_ascii_case(&target) || p == target
    }) {
        return Err(format!("worktree already registered: {target}"));
    }

    // CLI layout nests under ~/.grok/worktrees/<repo>/ — ensure parents exist.
    if let Some(parent) = target_pb.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!("could not create worktree parent {}: {e}", parent.display())
        })?;
    }

    // Safe argv — never go through a shell.
    // `git worktree add -b <name> <path> [start_point]`
    let mut args: Vec<String> = vec![
        "-C".into(),
        project.clone(),
        "worktree".into(),
        "add".into(),
        "-b".into(),
        safe_name.clone(),
        target.clone(),
    ];
    if let Some(ref sp) = start {
        args.push(sp.clone());
    }

    let out = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(if err.is_empty() {
            "git worktree add failed".into()
        } else {
            err.chars().take(400).collect()
        });
    }

    // Best-effort: re-list to pick up branch field for the new path.
    let branch = {
        let re = crate::process_util::command("git")
            .args(["-C", &project, "worktree", "list", "--porcelain"])
            .output()
            .ok();
        re.and_then(|o| {
            if !o.status.success() {
                return None;
            }
            let list = parse_worktree_porcelain(&String::from_utf8_lossy(&o.stdout));
            list.into_iter()
                .find(|w| {
                    let p = normalize_fs_path(&w.path);
                    p.eq_ignore_ascii_case(&target) || p == target
                })
                .and_then(|w| w.branch)
        })
        .or_else(|| Some(safe_name.clone()))
    };

    Ok(GitWorktreeAddResult {
        path: target,
        name: safe_name,
        start_point: start,
        branch,
    })
}

// from PR #83

/// Garbage-collect stale git worktree administrative files via `git worktree prune`.
///
/// Safe argv only (no shell). Soft-fails on missing git / non-repo with an Err.
/// When `dry_run` is true, nothing is deleted (`--dry-run`).
/// Optional `force` maps to `--expire now` when `max_age` is unset.
/// Optional `max_age` maps to `--expire <max_age>`.
#[tauri::command]
pub async fn git_worktree_gc(
    project_path: String,
    dry_run: bool,
    force: Option<bool>,
    max_age: Option<String>,
) -> Result<GitWorktreeGcResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    git_probe_work_tree(&project)?;

    let forced = force.unwrap_or(false);
    let age = sanitize_worktree_gc_max_age(max_age.as_deref())?;

    // Snapshot prunable entries before prune for UI preview / summary.
    let prunable = {
        let list_out = crate::process_util::command("git")
            .args(["-C", &project, "worktree", "list", "--porcelain"])
            .output()
            .map_err(|e| e.to_string())?;
        if list_out.status.success() {
            parse_worktree_porcelain(&String::from_utf8_lossy(&list_out.stdout))
                .into_iter()
                .filter(|w| w.prunable)
                .map(|w| w.path)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        }
    };

    let args = build_worktree_gc_args(
        &project,
        dry_run,
        forced,
        age.as_deref(),
    )?;

    let out = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(if err.is_empty() {
            "git worktree prune failed".into()
        } else {
            err.chars().take(400).collect()
        });
    }

    // prune -v writes progress to stderr on some git versions, stdout on others.
    let mut combined = String::new();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stdout.trim().is_empty() {
        combined.push_str(stdout.trim());
    }
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(stderr.trim());
    }
    // Prefer verbose prune lines; fall back to porcelain prunable count on dry-run.
    let mut pruned_count = count_worktree_prune_lines(&combined);
    if pruned_count == 0 && !prunable.is_empty() {
        pruned_count = prunable.len();
    }

    let used_expire = match &age {
        Some(a) => Some(a.clone()),
        None if forced => Some("now".into()),
        None => None,
    };

    Ok(GitWorktreeGcResult {
        dry_run,
        forced,
        max_age: used_expire,
        output: combined.chars().take(4000).collect(),
        prunable,
        pruned_count,
    })
}

// from PR #74

/// Remove a linked git worktree via `git worktree remove` (argv only, no shell).
///
/// Refuses the main worktree. Optional `force` maps to `--force` (dirty / locked).
#[tauri::command]
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    force: Option<bool>,
) -> Result<GitWorktreeRemoveResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    git_probe_work_tree(&project)?;

    let target = normalize_fs_path(&worktree_path);
    if target.is_empty() {
        return Err("empty worktree path".into());
    }
    // Disallow option-like paths so a crafted path cannot become a git flag.
    if target.starts_with('-') {
        return Err("invalid worktree path".into());
    }

    let list_out = crate::process_util::command("git")
        .args(["-C", &project, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !list_out.status.success() {
        let err = String::from_utf8_lossy(&list_out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "git worktree list failed".into()
        } else {
            err.chars().take(200).collect()
        });
    }
    let listed = parse_worktree_porcelain(&String::from_utf8_lossy(&list_out.stdout));
    if listed.is_empty() {
        return Err("no worktrees found".into());
    }

    refuse_remove_main_worktree(&listed, &target)?;

    let registered = listed.iter().any(|w| worktree_paths_equal(&w.path, &target));
    if !registered {
        return Err("worktree not registered for this repository".into());
    }

    // Use the path as listed by git (preserves real casing / form).
    let remove_path = listed
        .iter()
        .find(|w| worktree_paths_equal(&w.path, &target))
        .map(|w| w.path.clone())
        .unwrap_or(target.clone());

    let forced = force.unwrap_or(false);
    // Safe argv — never go through a shell.
    // `git worktree remove [--force] <path>`
    let mut args: Vec<String> = vec![
        "-C".into(),
        project,
        "worktree".into(),
        "remove".into(),
    ];
    if forced {
        args.push("--force".into());
    }
    args.push(remove_path.clone());

    let out = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(if err.is_empty() {
            "git worktree remove failed".into()
        } else {
            err.chars().take(400).collect()
        });
    }

    Ok(GitWorktreeRemoveResult {
        path: remove_path,
        forced,
    })
}

// ── Worktree ship flow (push + gh pr create) ────────────────────────────────

/// Soft-fail result of `git push -u origin HEAD` under a project path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushBranchResult {
    pub available: bool,
    pub ok: bool,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub reason: Option<String>,
}

/// Soft-fail result of `gh pr create` under a project path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPrCreateResult {
    pub available: bool,
    pub ok: bool,
    pub url: Option<String>,
    pub repo: Option<String>,
    pub base: Option<String>,
    pub head: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub reason: Option<String>,
}

fn ship_redact_output(s: &str, max: usize) -> String {
    let scrubbed = store::redact_text(s);
    let t = scrubbed.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        t.chars().take(max).collect::<String>() + "…"
    }
}

/// Parse `git@host:org/repo.git` / `https://host/org/repo.git` → `org/repo` (pure).
pub fn parse_github_owner_repo(url: &str) -> Option<String> {
    let s = url
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches(".GIT");
    if s.is_empty() {
        return None;
    }
    // SSH: git@github.com:org/repo
    if let Some(idx) = s.find(':') {
        let rest = &s[idx + 1..];
        if !rest.contains("://") && rest.contains('/') {
            let parts: Vec<&str> = rest
                .trim_start_matches('/')
                .split('/')
                .filter(|p| !p.is_empty())
                .collect();
            if parts.len() >= 2 {
                return Some(format!(
                    "{}/{}",
                    parts[parts.len() - 2],
                    parts[parts.len() - 1]
                ));
            }
        }
    }
    // HTTPS path: take last two segments
    let parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 {
        let org = parts[parts.len() - 2];
        let repo = parts[parts.len() - 1];
        if !org.is_empty() && !repo.is_empty() && !org.contains('@') {
            return Some(format!("{org}/{repo}"));
        }
    }
    None
}

fn github_owner_from_repo(owner_repo: &str) -> Option<&str> {
    let (o, _) = owner_repo.split_once('/')?;
    let o = o.trim();
    if o.is_empty() {
        None
    } else {
        Some(o)
    }
}

/// Build `gh --head` value for forks (`owner:branch`) or same-repo bare branch.
pub fn build_gh_head_ref(
    branch: &str,
    origin_owner_repo: Option<&str>,
    base_owner_repo: Option<&str>,
) -> String {
    let b = branch.trim();
    if b.is_empty() {
        return String::new();
    }
    let origin_owner = origin_owner_repo.and_then(github_owner_from_repo);
    let base_owner = base_owner_repo.and_then(github_owner_from_repo);
    match (origin_owner, base_owner) {
        (Some(o), Some(base)) if o != base => format!("{o}:{b}"),
        _ => b.to_string(),
    }
}

/// Extract first GitHub PR URL from gh stdout/stderr (pure).
pub fn parse_gh_pr_url(output: &str) -> Option<String> {
    // https://github.com/org/repo/pull/123
    let bytes = output.as_bytes();
    let needle = b"https://github.com/";
    let mut i = 0;
    while i + needle.len() < bytes.len() {
        if bytes[i..].starts_with(needle) {
            let start = i;
            let mut end = i + needle.len();
            while end < bytes.len() {
                let c = bytes[end];
                if c.is_ascii_alphanumeric()
                    || c == b'/'
                    || c == b'-'
                    || c == b'_'
                    || c == b'.'
                {
                    end += 1;
                } else {
                    break;
                }
            }
            let candidate = &output[start..end];
            if candidate.contains("/pull/") {
                // Trim trailing punctuation
                let cleaned = candidate
                    .trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
                if cleaned.contains("/pull/") {
                    return Some(cleaned.to_string());
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    None
}

/// Sanitize PR title for argv (single line, required).
pub fn sanitize_pr_title(raw: &str) -> Result<String, String> {
    let s = raw
        .replace(['\0', '\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if s.is_empty() {
        return Err("PR title is required".into());
    }
    if s.chars().count() > 256 {
        return Err("PR title too long (max 256)".into());
    }
    Ok(s)
}

/// Sanitize PR body (allow multiline; strip NUL).
pub fn sanitize_pr_body(raw: Option<&str>) -> Result<String, String> {
    let s = raw.unwrap_or("").replace('\0', "").replace("\r\n", "\n").replace('\r', "\n");
    if s.chars().count() > 65_536 {
        return Err("PR body too long".into());
    }
    Ok(s)
}

/// Sanitize `owner/repo` for `--repo`.
pub fn sanitize_github_repo_arg(raw: Option<&str>) -> Result<Option<String>, String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty());
    let Some(s) = s else {
        return Ok(None);
    };
    if s.starts_with('-') {
        return Err("repo must not start with '-'".into());
    }
    if s.len() > 200 {
        return Err("repo too long".into());
    }
    let mut parts = s.split('/');
    let org = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if parts.next().is_some() || org.is_empty() || name.is_empty() {
        return Err("repo must be owner/name".into());
    }
    if !org
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("repo must be owner/name".into());
    }
    Ok(Some(format!("{org}/{name}")))
}

fn sanitize_ship_branch(raw: Option<&str>) -> Result<Option<String>, String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty());
    let Some(s) = s else {
        return Ok(None);
    };
    if s.starts_with('-') {
        return Err("branch must not start with '-'".into());
    }
    if s.len() > 256 || s.contains('\0') || s.contains('\n') || s.contains('\r') {
        return Err("invalid branch".into());
    }
    if s == "HEAD" || s == "@" {
        return Ok(None);
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
    {
        return Err("branch contains invalid characters".into());
    }
    Ok(Some(s.to_string()))
}

/// Build argv for `git push -u origin HEAD` (no binary; pure).
pub fn build_git_push_args(project: &str) -> Result<Vec<String>, String> {
    let project = normalize_fs_path(project);
    if project.is_empty() {
        return Err("empty path".into());
    }
    if project.starts_with('-') {
        return Err("invalid project path".into());
    }
    Ok(vec![
        "-C".into(),
        project,
        "push".into(),
        "-u".into(),
        "origin".into(),
        "HEAD".into(),
    ])
}

/// Build argv for `gh pr create` (no binary; pure).
pub fn build_gh_pr_create_args(
    title: &str,
    body: &str,
    draft: bool,
    base: &str,
    head: Option<&str>,
    repo: Option<&str>,
) -> Result<Vec<String>, String> {
    let title = sanitize_pr_title(title)?;
    let body = sanitize_pr_body(Some(body))?;
    let base = sanitize_ship_branch(Some(base))?
        .unwrap_or_else(|| "main".into());
    let repo = sanitize_github_repo_arg(repo)?;
    let head = match head {
        Some(h) if !h.trim().is_empty() => {
            let h = h.trim();
            if h.starts_with('-') || h.contains('\0') || h.contains('\n') {
                return Err("invalid head".into());
            }
            Some(h.to_string())
        }
        _ => None,
    };

    let mut args = vec![
        "pr".into(),
        "create".into(),
        "--title".into(),
        title,
        "--body".into(),
        body,
    ];
    if let Some(r) = repo {
        args.push("--repo".into());
        args.push(r);
    }
    args.push("--base".into());
    args.push(base);
    if let Some(h) = head {
        args.push("--head".into());
        args.push(h);
    }
    if draft {
        args.push("--draft".into());
    }
    Ok(args)
}

fn git_remote_url(project: &str, name: &str) -> Option<String> {
    let out = crate::process_util::command("git")
        .args(["-C", project, "remote", "get-url", name])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn git_current_branch(project: &str) -> Option<String> {
    let out = crate::process_util::command("git")
        .args(["-C", project, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if b.is_empty() || b == "HEAD" {
        None
    } else {
        Some(b)
    }
}

fn probe_binary_on_path(bin: &str) -> bool {
    let mut cmd = crate::process_util::command(bin);
    if let Some(path_env) = crate::process_util::enriched_path_env() {
        cmd.env("PATH", path_env);
    }
    cmd.arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn apply_ship_process_env(cmd: &mut std::process::Command) {
    if let Some(path_env) = crate::process_util::enriched_path_env() {
        cmd.env("PATH", path_env);
    }
    #[cfg(unix)]
    {
        if std::path::Path::new("/usr/bin/ssh").exists() {
            cmd.env("GIT_SSH_COMMAND", "/usr/bin/ssh");
        }
    }
}

/// Push the current HEAD branch to `origin` (`git push -u origin HEAD`).
/// Soft-fails when git / remote / non-repo are missing (available=false).
#[tauri::command]
pub async fn git_push_branch(project_path: String) -> Result<GitPushBranchResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Ok(GitPushBranchResult {
            available: false,
            ok: false,
            branch: None,
            remote: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("empty path".into()),
        });
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Ok(GitPushBranchResult {
            available: false,
            ok: false,
            branch: None,
            remote: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("project not a directory".into()),
        });
    }
    if let Err(reason) = git_probe_work_tree(&project) {
        return Ok(GitPushBranchResult {
            available: false,
            ok: false,
            branch: None,
            remote: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some(reason),
        });
    }

    let branch = git_current_branch(&project);
    let remote = git_remote_url(&project, "origin");
    if remote.is_none() {
        return Ok(GitPushBranchResult {
            available: false,
            ok: false,
            branch,
            remote: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("no origin remote".into()),
        });
    }

    let args = build_git_push_args(&project)?;
    let project_for_cmd = project.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = crate::process_util::command("git");
        apply_ship_process_env(&mut cmd);
        cmd.args(&args)
            .current_dir(&project_for_cmd)
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let stdout = ship_redact_output(&String::from_utf8_lossy(&out.stdout), 4000);
    let stderr = ship_redact_output(&String::from_utf8_lossy(&out.stderr), 4000);
    if out.status.success() {
        Ok(GitPushBranchResult {
            available: true,
            ok: true,
            branch,
            remote,
            stdout,
            stderr,
            reason: None,
        })
    } else {
        let reason = if !stderr.is_empty() {
            stderr.chars().take(400).collect()
        } else if !stdout.is_empty() {
            stdout.chars().take(400).collect()
        } else {
            "git push failed".into()
        };
        Ok(GitPushBranchResult {
            available: true,
            ok: false,
            branch,
            remote,
            stdout,
            stderr,
            reason: Some(reason),
        })
    }
}

/// Create a GitHub pull request via `gh pr create` (argv only, no shell).
/// Soft-fails when `gh` is missing. Never reports ok without a PR URL.
#[tauri::command]
pub async fn gh_pr_create(
    project_path: String,
    title: String,
    body: Option<String>,
    draft: Option<bool>,
    base: Option<String>,
    head: Option<String>,
    repo: Option<String>,
) -> Result<GhPrCreateResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Ok(GhPrCreateResult {
            available: false,
            ok: false,
            url: None,
            repo: None,
            base: None,
            head: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("empty path".into()),
        });
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Ok(GhPrCreateResult {
            available: false,
            ok: false,
            url: None,
            repo: None,
            base: None,
            head: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("project not a directory".into()),
        });
    }
    if let Err(reason) = git_probe_work_tree(&project) {
        return Ok(GhPrCreateResult {
            available: false,
            ok: false,
            url: None,
            repo: None,
            base: None,
            head: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some(reason),
        });
    }

    if !probe_binary_on_path("gh") {
        return Ok(GhPrCreateResult {
            available: false,
            ok: false,
            url: None,
            repo: None,
            base: None,
            head: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("gh not available".into()),
        });
    }

    let branch = git_current_branch(&project);
    let origin_url = git_remote_url(&project, "origin");
    let upstream_url = git_remote_url(&project, "upstream");
    let origin_or = origin_url.as_deref().and_then(parse_github_owner_repo);
    let upstream_or = upstream_url.as_deref().and_then(parse_github_owner_repo);

    let repo_arg = match sanitize_github_repo_arg(repo.as_deref())? {
        Some(r) => Some(r),
        None => upstream_or.clone().or_else(|| origin_or.clone()),
    };
    let base_branch = sanitize_ship_branch(base.as_deref())?
        .unwrap_or_else(|| "main".into());
    let head_ref = if let Some(h) = head.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if h.starts_with('-') || h.contains('\0') || h.contains('\n') {
            return Err("invalid head".into());
        }
        Some(h.to_string())
    } else if let Some(ref b) = branch {
        let h = build_gh_head_ref(
            b,
            origin_or.as_deref(),
            repo_arg.as_deref(),
        );
        if h.is_empty() {
            None
        } else {
            Some(h)
        }
    } else {
        None
    };

    let title_s = sanitize_pr_title(&title)?;
    let body_s = sanitize_pr_body(body.as_deref())?;
    let draft_flag = draft.unwrap_or(false);
    let args = build_gh_pr_create_args(
        &title_s,
        &body_s,
        draft_flag,
        &base_branch,
        head_ref.as_deref(),
        repo_arg.as_deref(),
    )?;

    let project_for_cmd = project.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = crate::process_util::command("gh");
        apply_ship_process_env(&mut cmd);
        cmd.args(&args)
            .current_dir(&project_for_cmd)
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let stdout = ship_redact_output(&String::from_utf8_lossy(&out.stdout), 4000);
    let stderr = ship_redact_output(&String::from_utf8_lossy(&out.stderr), 4000);
    let combined = format!("{stdout}\n{stderr}");
    let url = parse_gh_pr_url(&combined);

    if out.status.success() {
        if let Some(u) = url {
            Ok(GhPrCreateResult {
                available: true,
                ok: true,
                url: Some(u),
                repo: repo_arg,
                base: Some(base_branch),
                head: head_ref,
                stdout,
                stderr,
                reason: None,
            })
        } else {
            // Never fake success without a URL.
            Ok(GhPrCreateResult {
                available: true,
                ok: false,
                url: None,
                repo: repo_arg,
                base: Some(base_branch),
                head: head_ref,
                stdout,
                stderr,
                reason: Some("gh pr create succeeded but PR URL missing".into()),
            })
        }
    } else {
        let reason = if !stderr.is_empty() {
            stderr.chars().take(400).collect()
        } else if !stdout.is_empty() {
            stdout.chars().take(400).collect()
        } else {
            "gh pr create failed".into()
        };
        Ok(GhPrCreateResult {
            available: true,
            ok: false,
            url,
            repo: repo_arg,
            base: Some(base_branch),
            head: head_ref,
            stdout,
            stderr,
            reason: Some(reason),
        })
    }
}

#[cfg(test)]
mod ship_flow_tests {
    use super::*;

    #[test]
    fn parse_github_owner_repo_ssh_https() {
        assert_eq!(
            parse_github_owner_repo("git@github.com:RongleCat/grok-app.git").as_deref(),
            Some("RongleCat/grok-app")
        );
        assert_eq!(
            parse_github_owner_repo("https://github.com/sonnemusk/grok-app.git").as_deref(),
            Some("sonnemusk/grok-app")
        );
    }

    #[test]
    fn build_gh_head_fork_vs_same() {
        assert_eq!(
            build_gh_head_ref(
                "feat/wt-ship-flow",
                Some("sonnemusk/grok-app"),
                Some("RongleCat/grok-app"),
            ),
            "sonnemusk:feat/wt-ship-flow"
        );
        assert_eq!(
            build_gh_head_ref(
                "feat/x",
                Some("RongleCat/grok-app"),
                Some("RongleCat/grok-app"),
            ),
            "feat/x"
        );
    }

    #[test]
    fn parse_gh_pr_url_extracts() {
        let out = "Creating pull request for feat/x into main in RongleCat/grok-app\n\nhttps://github.com/RongleCat/grok-app/pull/99\n";
        assert_eq!(
            parse_gh_pr_url(out).as_deref(),
            Some("https://github.com/RongleCat/grok-app/pull/99")
        );
        assert!(parse_gh_pr_url("nope").is_none());
    }

    #[test]
    fn build_git_push_args_ok() {
        let a = build_git_push_args("/Users/me/repo").unwrap();
        assert_eq!(
            a,
            vec!["-C", "/Users/me/repo", "push", "-u", "origin", "HEAD"]
        );
        assert!(build_git_push_args("").is_err());
        assert!(build_git_push_args("-C").is_err());
    }

    #[test]
    fn build_gh_pr_create_args_fork_shape() {
        let a = build_gh_pr_create_args(
            "feat: ship",
            "body",
            true,
            "main",
            Some("sonnemusk:feat/wt-ship-flow"),
            Some("RongleCat/grok-app"),
        )
        .unwrap();
        assert!(a.windows(2).any(|w| w == ["--repo", "RongleCat/grok-app"]));
        assert!(a
            .windows(2)
            .any(|w| w == ["--head", "sonnemusk:feat/wt-ship-flow"]));
        assert!(a.iter().any(|x| x == "--draft"));
        assert!(a.windows(2).any(|w| w == ["--title", "feat: ship"]));
    }

    #[test]
    fn sanitize_pr_title_required() {
        assert!(sanitize_pr_title("  ").is_err());
        assert_eq!(sanitize_pr_title("Hello\nworld").unwrap(), "Hello world");
    }
}

// from PR #78

/// Create the user or project hooks directory if missing. Returns the absolute path.
#[tauri::command]
pub async fn hooks_ensure_dir(
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let scope = scope.unwrap_or_else(|| "user".into());
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let scope_for_block = scope.clone();
    let dir = tauri::async_runtime::spawn_blocking(move || {
        crate::hooks::ensure_hooks_dir(&scope_for_block, project.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({
        "path": dir.to_string_lossy(),
        "scope": scope,
    }))
}

// from PR #78

// ── Hooks manager (list / reveal / open folder) ─────────────────────────────

/// List hook files under `~/.grok/hooks` and optionally `<project>/.grok/hooks`.
#[tauri::command]
pub async fn hooks_list(project_path: Option<String>) -> Result<crate::hooks::HooksListResult, String> {
    let path = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        crate::hooks::collect_hooks_list(path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

// from PR #78

/// Open the user or project hooks directory in the system file manager.
/// When `create` is true, creates the folder if it is missing.
#[tauri::command]
pub async fn hooks_open_dir(
    scope: Option<String>,
    project_path: Option<String>,
    create: Option<bool>,
) -> Result<serde_json::Value, String> {
    let scope = scope.unwrap_or_else(|| "user".into());
    let create = create.unwrap_or(false);
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let scope_for_block = scope.clone();
    let project_for_block = project.clone();
    let dir = tauri::async_runtime::spawn_blocking(move || {
        if create {
            crate::hooks::ensure_hooks_dir(&scope_for_block, project_for_block.as_deref())
        } else {
            let d = match scope_for_block.trim() {
                "user" | "" => crate::hooks::user_hooks_dir(),
                "project" => crate::hooks::project_hooks_dir(project_for_block.as_deref().unwrap_or(""))
                    .ok_or_else(|| "project path required for project hooks".to_string())?,
                other => return Err(format!("unknown hooks scope: {other}")),
            };
            if !d.exists() {
                return Err(format!(
                    "hooks folder not found: {} (use Create folder first)",
                    d.display()
                ));
            }
            Ok(d)
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    let path = dir.to_string_lossy().to_string();
    // Open the directory itself (not reveal-select).
    path_open(path.clone()).await?;
    Ok(serde_json::json!({ "path": path, "scope": scope }))
}

// from PR #78

/// Reveal a hook path in the system file manager (Finder / Explorer).
#[tauri::command]
pub async fn hooks_reveal(path: String) -> Result<(), String> {
    path_reveal(path).await
}

/// Real try-run of a hook script (optional JSON stdin, timeout, path-scoped to hooks dirs).
///
/// Returns a structured result; `ok` is true only when the process exited 0 without
/// timing out. Unsafe paths / invalid stdin are refused (`refused: true`) — never
/// reported as success.
#[tauri::command]
pub async fn hooks_try_run(
    path: String,
    project_path: Option<String>,
    stdin_json: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<crate::hooks::HooksTryRunResult, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        crate::hooks::try_run_hook_script(
            &path,
            project.as_deref(),
            stdin_json.as_deref(),
            timeout_secs,
        )
    })
    .await
    .map_err(|e| e.to_string())
}

// from PR #77

fn is_agent_def_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !name.starts_with('.')
        && (lower.ends_with(".md") || lower.ends_with(".markdown"))
}

// from PR #77

fn is_persona_def_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !name.starts_with('.')
        && (lower.ends_with(".toml")
            || lower.ends_with(".md")
            || lower.ends_with(".markdown"))
}

// from PR #88

/// Safe fix-id shape: short handle (`ssh-wrap`) or canonical (`terminal.ssh-wrap`).
/// Rejects flags, paths, and shell metacharacters before invoking the CLI.
fn is_safe_doctor_fix_id(id: &str) -> bool {
    let t = id.trim();
    if t.is_empty() || t.len() > 128 {
        return false;
    }
    let mut chars = t.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

// from PR #79

fn is_setup_sensitive_key(key: &str) -> bool {
    let k = key.trim().to_ascii_lowercase();
    if k.is_empty() {
        return false;
    }
    matches!(
        k.as_str(),
        "apikey"
            | "api_key"
            | "api-key"
            | "token"
            | "secret"
            | "password"
            | "passwd"
            | "authorization"
            | "auth"
            | "access_token"
            | "access-token"
            | "refresh_token"
            | "refresh-token"
            | "client_secret"
            | "client-secret"
            | "private_key"
            | "private-key"
            | "bearer"
            | "deployment_key"
            | "deployment-key"
            | "deploymentkey"
            | "xai_api_key"
            | "xai-api-key"
            | "env"
            | "environment"
            | "headers"
            | "secrets"
            | "credentials"
            | "signatures"
            | "managed_identity_signatures"
            | "managedidentitysignatures"
    ) || k.contains("api_key")
        || k.contains("api-key")
        || k.contains("apikey")
        || k.ends_with("_token")
        || k.ends_with("-token")
        || k.ends_with("_secret")
        || k.ends_with("-secret")
        || k.ends_with("_password")
        || k.contains("deployment_key")
        || k.contains("deploymentkey")
        || (k.contains("signature") && !k.contains("fingerprint"))
        || k.ends_with("_sig")
}

// from PR #68

/// Add or replace a stdio MCP server. Soft-respawns a live agent so the next
/// connect injects the new `mcpServers` set.
#[tauri::command]
pub async fn mcp_add(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    let command = command.trim().to_string();
    let args = args.unwrap_or_default();
    let env_owned = env;
    let def = tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::add_mcp_stdio(
            &name,
            &command,
            &args,
            env_owned.as_ref(),
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    mgr.apply_extensions_mcp_change(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": def.name,
        "command": def.command,
        "args": def.args,
        "transport": def.transport,
        "enabled": true,
    }))
}

// from PR #68

/// Run `grok mcp doctor --json` (optional server name) under the active GROK_HOME.
#[tauri::command]
pub async fn mcp_doctor(
    name: Option<String>,
) -> Result<crate::extensions::McpDoctorReport, String> {
    let name = name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    tauri::async_runtime::spawn_blocking(move || run_mcp_doctor(name.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

// from PR #68

/// Remove an MCP server from agent config + App prefs. Soft-respawns when live.
#[tauri::command]
pub async fn mcp_remove(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("MCP server name required".into());
    }
    let name_for_job = name.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::remove_mcp_server(&name_for_job)
    })
    .await
    .map_err(|e| e.to_string())??;

    mgr.apply_extensions_mcp_change(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
    }))
}

// from PR #74

/// Normalize a path for worktree equality checks (slash direction, no trailing
/// slash, ASCII lowercased so macOS/Windows case-insensitive volumes match).
pub fn normalize_worktree_path_key(raw: &str) -> String {
    let mut s = normalize_fs_path(raw).replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s.make_ascii_lowercase();
    s
}

// from PR #84

/// Read compact permission rules from the active GROK_HOME config.toml.
#[tauri::command]
pub async fn permission_rules_get(
) -> Result<crate::permission_rules::PermissionRulesResult, String> {
    tauri::async_runtime::spawn_blocking(crate::permission_rules::load_permission_rules)
        .await
        .map_err(|e| e.to_string())?
}

// from PR #84

/// Replace compact allow/deny/ask arrays and soft-respawn the live agent.
#[tauri::command]
pub async fn permission_rules_set(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    allow: Option<Vec<String>>,
    deny: Option<Vec<String>>,
    ask: Option<Vec<String>>,
) -> Result<crate::permission_rules::PermissionRulesResult, String> {
    let rules = crate::permission_rules::PermissionRules {
        allow: allow.unwrap_or_default(),
        deny: deny.unwrap_or_default(),
        ask: ask.unwrap_or_default(),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::permission_rules::save_permission_rules(&rules)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Grok Build reads rules at session start — soft-respawn so the next turn
    // reloads config without a full disconnect toast.
    mgr.soft_respawn(&app).await;
    Ok(result)
}

// from PR #82

/// Create root `AGENTS.md` stub when missing (idempotent).
/// IPC arg is `projectPath` (camelCase) → `project_path`.
#[tauri::command]
pub async fn project_rules_ensure_template(
    project_path: String,
) -> Result<crate::project_rules::ProjectRulesEnsureResult, String> {
    crate::project_rules::ensure_agents_template(&project_path)
}

// from PR #82

/// List existing project rule files (AGENTS.md, CLAUDE.md, `.grok/rules*`, nested AGENTS).
/// IPC arg is `projectPath` (camelCase) → `project_path`.
#[tauri::command]
pub async fn project_rules_list(
    project_path: String,
) -> Result<crate::project_rules::ProjectRulesListResult, String> {
    crate::project_rules::list_project_rules(&project_path)
}

// from PR #77

fn read_agent_description(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    // Frontmatter is near the top; cap read size.
    let take = bytes.len().min(4096);
    let content = String::from_utf8_lossy(&bytes[..take]);
    extract_agent_description_from_content(&content)
}

// from PR #88

/// Redact + cap CLI doctor fix stdout/stderr for the UI (no secrets, no huge dumps).
fn redact_doctor_fix_output(s: &str, max: usize) -> String {
    let scrubbed = store::redact_text(s);
    truncate_cli_err(&scrubbed, max)
}

// from PR #79

/// In-place redaction of secret-like keys / tokenish strings in managed setup JSON.
pub fn redact_setup_json_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                if is_setup_sensitive_key(&key) {
                    map.insert(key, serde_json::Value::String("[REDACTED]".into()));
                } else if let Some(child) = map.get_mut(&key) {
                    redact_setup_json_value(child);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                redact_setup_json_value(item);
            }
        }
        serde_json::Value::String(s) => {
            let scrubbed = store::redact_text(s);
            *s = scrubbed.trim().to_string();
        }
        _ => {}
    }
}

// from PR #74

/// Refuse removing the main (primary) worktree. Pure; unit-tested.
pub fn refuse_remove_main_worktree(
    listed: &[GitWorktreeEntry],
    worktree_path: &str,
) -> Result<(), String> {
    let target = normalize_fs_path(worktree_path);
    if target.is_empty() {
        return Err("empty worktree path".into());
    }
    let main = listed
        .iter()
        .find(|w| w.is_main)
        .or_else(|| listed.first());
    if let Some(m) = main {
        if worktree_paths_equal(&m.path, &target) {
            return Err("refusing to remove the main worktree".into());
        }
    }
    Ok(())
}

// from PR #68

/// Invoke CLI doctor with GROK_HOME matching session_data_mode.
///
/// Runs `grok mcp doctor --json [NAME]` with a hard timeout. Errors are
/// redacted/truncated so secrets never leave the host. Returns a structured
/// report (JSON-serializable) — never invents servers.
fn run_mcp_doctor(name: Option<&str>) -> Result<crate::extensions::McpDoctorReport, String> {
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let Some(cli_path) = probe.path.filter(|_| probe.found) else {
        return Err("Grok Build CLI not found".into());
    };
    let grok_home = crate::paths::resolve_agent_grok_home(&settings.session_data_mode);

    let mut args: Vec<String> = vec!["mcp".into(), "doctor".into(), "--json".into()];
    if let Some(n) = name {
        // Reject flag-like / path injection in the optional server name.
        let n = n.trim();
        if n.is_empty() {
            // no-op
        } else if n.starts_with('-') || n.contains('/') || n.contains('\\') || n.contains('\0') {
            return Err("invalid MCP server name".into());
        } else {
            args.push(n.to_string());
        }
    }

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.args(&args);
        cmd.env("GROK_HOME", &grok_home);
        crate::process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = crate::process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        let _ = tx.send(cmd.output());
    });

    match rx.recv_timeout(std::time::Duration::from_secs(MCP_DOCTOR_TIMEOUT_SECS)) {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            // Doctor may exit non-zero when servers are unhealthy — still parse JSON.
            let blob = if !stdout.is_empty() {
                stdout
            } else {
                stderr.clone()
            };
            if blob.is_empty() {
                return Err(if !stderr.is_empty() {
                    // Never surface raw secrets from CLI stderr.
                    redact_doctor_fix_output(&stderr, 400)
                } else {
                    "mcp doctor returned no output".into()
                });
            }
            Ok(crate::extensions::parse_mcp_doctor_json(&blob))
        }
        Ok(Err(e)) => Err(format!(
            "Failed to run grok mcp doctor: {}",
            redact_doctor_fix_output(&e.to_string(), 240)
        )),
        Err(_) => Err(format!(
            "grok mcp doctor timed out after {MCP_DOCTOR_TIMEOUT_SECS}s"
        )),
    }
}

// from PR #83

/// Sanitize optional `--expire` / max-age for `git worktree prune`.
///
/// Accepts common git relative dates (`now`, `2.weeks.ago`, `3.months`) and
/// simple tokens. Rejects empty, option-like (`-…`), and control characters.
/// Pure; unit-tested.
pub fn sanitize_worktree_gc_max_age(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if s.len() > 64 {
        return Err("max-age too long".into());
    }
    if s.starts_with('-') {
        return Err("max-age must not start with '-'".into());
    }
    if s.contains('\0') || s.contains('\n') || s.contains('\r') || s.contains(' ') {
        return Err("invalid max-age".into());
    }
    // Git expire: alphanumerics + . _ (e.g. 2.weeks.ago, now, 90.days).
    let ok = s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_');
    if !ok {
        return Err("max-age may only contain letters, digits, '.' and '_'".into());
    }
    Ok(Some(s.to_string()))
}

// from PR #64

/// Sanitize a user-provided worktree name for use as a path segment + branch name.
///
/// Allows letters, digits, `.`, `_`, `-`. Rejects empty, `..`, path separators,
/// and other control / shell-metacharacters. Pure; unit-tested.
pub fn sanitize_worktree_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("worktree name is required".into());
    }
    if name == "." || name == ".." {
        return Err("invalid worktree name".into());
    }
    if name.len() > 64 {
        return Err("worktree name too long (max 64)".into());
    }
    // Single path segment only — no separators, no absolute paths.
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("worktree name must not contain path separators".into());
    }
    // Branch-safe: alphanumeric + . _ - (common for feature names).
    let ok = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if !ok {
        return Err(
            "worktree name may only contain letters, digits, '.', '_' and '-'".into(),
        );
    }
    if name.starts_with('-') {
        return Err("worktree name must not start with '-'".into());
    }
    Ok(name.to_string())
}

// from PR #64

/// Optional commit-ish / branch start-point for `git worktree add`.
/// Passed as a single argv element (no shell) after light validation.
pub fn sanitize_worktree_ref(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if s.len() > 256 {
        return Err("branch / ref too long".into());
    }
    if s.contains('\0') || s.contains('\n') || s.contains('\r') {
        return Err("invalid branch / ref".into());
    }
    // Disallow option-like args so they cannot be mistaken for git flags.
    if s.starts_with('-') {
        return Err("branch / ref must not start with '-'".into());
    }
    Ok(Some(s.to_string()))
}

#[cfg(test)]
mod worktree_path_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn layout_defaults_to_cli() {
        assert_eq!(normalize_worktree_layout(None), "cli");
        assert_eq!(normalize_worktree_layout(Some("")), "cli");
        assert_eq!(normalize_worktree_layout(Some("CLI")), "cli");
        assert_eq!(normalize_worktree_layout(Some("sibling")), "sibling");
    }

    #[test]
    fn sibling_path_next_to_main() {
        assert_eq!(
            build_worktree_sibling_path("/Users/me/repo", "feat").unwrap(),
            "/Users/me/repo-feat"
        );
    }

    #[test]
    fn cli_path_under_grok_worktrees() {
        let home = Path::new("/Users/me/.grok");
        assert_eq!(
            build_worktree_cli_path("/Users/me/Code/oss-grok-app", "feat", home).unwrap(),
            "/Users/me/.grok/worktrees/oss-grok-app/feat"
        );
        assert_eq!(
            worktree_repo_slug("/Users/me/Code/oss-grok-app").unwrap(),
            "oss-grok-app"
        );
    }

    #[test]
    fn sanitize_ref_rejects_flags() {
        assert!(sanitize_worktree_ref(Some("-b")).is_err());
        assert_eq!(
            sanitize_worktree_ref(Some("  origin/main  ")).unwrap().as_deref(),
            Some("origin/main")
        );
        assert_eq!(sanitize_worktree_ref(None).unwrap(), None);
    }
}

// from PR #77

fn scan_agent_dir(dir: &std::path::Path, scope: &str) -> Vec<AgentDefDto> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !is_agent_def_file(&file_name) {
            continue;
        }
        let name = stem_name(&file_name);
        if name.is_empty() {
            continue;
        }
        let path_str = path.to_string_lossy().to_string();
        let description = read_agent_description(&path);
        out.push(AgentDefDto {
            name,
            path: path_str,
            scope: scope.to_string(),
            description,
        });
    }
    out
}

// from PR #77

fn scan_persona_dir(dir: &std::path::Path, scope: &str) -> Vec<PersonaDefDto> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !is_persona_def_file(&file_name) {
            continue;
        }
        let name = stem_name(&file_name);
        if name.is_empty() {
            continue;
        }
        out.push(PersonaDefDto {
            name,
            path: path.to_string_lossy().to_string(),
            scope: scope.to_string(),
        });
    }
    out
}

// from PR #77

fn scope_rank(scope: &str) -> u8 {
    match scope {
        "project" => 0,
        "user" => 1,
        "bundled" => 2,
        _ => 9,
    }
}

// from PR #71

/// Persist last active chat without permission/tray side-effects of `settings_set`.
/// Called on every successful open/switch so startup can restore once.
#[tauri::command]
pub async fn settings_remember_last_session(
    session_id: Option<String>,
    project_id: Option<String>,
) -> Result<(), String> {
    let mut s = store::load_settings();
    let next_session = session_id.and_then(|id| {
        let t = id.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let next_project = project_id.and_then(|id| {
        let t = id.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    if s.last_session_id == next_session && s.last_project_id == next_project {
        return Ok(());
    }
    s.last_session_id = next_session;
    s.last_project_id = next_project;
    store::save_settings(&s)
}

// from PR #79

fn setup_cli_failure_message(stdout: &str, stderr: &str, fallback: &str) -> String {
    let msg = if !stderr.trim().is_empty() {
        stderr.trim()
    } else if !stdout.trim().is_empty() {
        stdout.trim()
    } else {
        fallback
    };
    // Scrub any accidental key material in CLI diagnostics.
    store::redact_text(msg).trim().chars().take(1200).collect()
}

// from PR #79

fn setup_error_kind(msg: &str) -> &'static str {
    let m = msg.to_ascii_lowercase();
    if m.contains("cli not found") || m.contains("no such file") {
        return "cli_missing";
    }
    if m.contains("timed out") || m.contains("timeout") {
        return "timeout";
    }
    if m.contains("no deployment key")
        || m.contains("team sign-in")
        || m.contains("team login")
        || m.contains("sign in with a team")
        || m.contains("export grok_deployment_key")
    {
        return "missing_auth";
    }
    // Managed-config signature / envelope verification failures.
    if m.contains("signature rejected")
        || m.contains("signature was rejected")
        || m.contains("did not verify")
        || m.contains("could not be verified")
        || m.contains("is-managed claim")
        || m.contains("managed config signature")
        || m.contains("server envelope rejected")
    {
        return "signature_rejected";
    }
    if m.contains("deployment key was rejected")
        || m.contains("key was rejected")
        || m.contains("hasn't expired")
        || m.contains("hasnt expired")
    {
        return "rejected";
    }
    if m.contains("json") && (m.contains("parse") || m.contains("invalid")) {
        return "parse";
    }
    "other"
}

// from MANAGED-SETUP-PRO

/// Soft-fail local managed-config / signature artifact probe for Settings.
/// Always returns Ok; see [`crate::managed_setup::ManagedSetupStatus`].
#[tauri::command]
pub async fn managed_setup_status() -> Result<crate::managed_setup::ManagedSetupStatus, String> {
    tauri::async_runtime::spawn_blocking(crate::managed_setup::probe_managed_setup_status)
        .await
        .map_err(|e| format!("managed_setup_status: {e}"))
}

// from PR #79

/// `grok setup` — fetch and install managed configuration into ~/.grok.
/// Soft-respawns the agent on success so new policy is picked up.
/// Always returns Ok; failures surface as `{ ok: false, error, errorKind }`.
#[tauri::command]
pub async fn setup_install(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<serde_json::Value, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        run_grok_cli_args(&["setup"], SETUP_CMD_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (stdout, stderr, ok) = match result {
        Ok(t) => t,
        Err(e) => {
            let error = store::redact_text(&e).trim().to_string();
            let kind = setup_error_kind(&error);
            return Ok(serde_json::json!({
                "ok": false,
                "message": null,
                "error": error,
                "errorKind": kind,
            }));
        }
    };

    if !ok {
        let error =
            setup_cli_failure_message(&stdout, &stderr, "Could not install managed configuration");
        let kind = setup_error_kind(&error);
        return Ok(serde_json::json!({
            "ok": false,
            "message": null,
            "error": error,
            "errorKind": kind,
        }));
    }

    let message = {
        let raw = if !stdout.trim().is_empty() {
            stdout.trim()
        } else if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            "Applied managed configuration."
        };
        store::redact_text(raw)
            .trim()
            .chars()
            .take(800)
            .collect::<String>()
    };

    // New managed policy may change models / permissions / MCP — recycle agent.
    mgr.soft_respawn(&app).await;

    Ok(serde_json::json!({
        "ok": true,
        "message": message,
        "error": null,
        "errorKind": null,
    }))
}

// from PR #79

/// `grok setup --json` — fetch managed config preview without writing to ~/.grok.
/// Always returns Ok; failures surface as `{ ok: false, error, errorKind }`.
#[tauri::command]
pub async fn setup_preview() -> Result<serde_json::Value, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        run_grok_cli_args(&["setup", "--json"], SETUP_CMD_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (stdout, stderr, ok) = match result {
        Ok(t) => t,
        Err(e) => {
            let error = store::redact_text(&e).trim().to_string();
            let kind = setup_error_kind(&error);
            return Ok(serde_json::json!({
                "ok": false,
                "payload": null,
                "message": null,
                "error": error,
                "errorKind": kind,
            }));
        }
    };

    if !ok {
        let error = setup_cli_failure_message(
            &stdout,
            &stderr,
            "Could not fetch managed configuration",
        );
        let kind = setup_error_kind(&error);
        return Ok(serde_json::json!({
            "ok": false,
            "payload": null,
            "message": null,
            "error": error,
            "errorKind": kind,
        }));
    }

    let body = stdout.trim();
    if body.is_empty() {
        // Some CLI builds may print JSON on stderr when successful.
        let alt = stderr.trim();
        if alt.starts_with('{') || alt.starts_with('[') {
            return Ok(setup_preview_from_body(alt));
        }
        return Ok(serde_json::json!({
            "ok": true,
            "payload": null,
            "message": store::redact_text(alt).trim().chars().take(400).collect::<String>(),
            "error": null,
            "errorKind": null,
        }));
    }

    Ok(setup_preview_from_body(body))
}

// from PR #79

fn setup_preview_from_body(body: &str) -> serde_json::Value {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(mut value) => {
            redact_setup_json_value(&mut value);
            serde_json::json!({
                "ok": true,
                "payload": value,
                "message": null,
                "error": null,
                "errorKind": null,
            })
        }
        Err(_) => {
            // Not JSON — return scrubbed plain text as message only.
            let message = store::redact_text(body)
                .trim()
                .chars()
                .take(4000)
                .collect::<String>();
            serde_json::json!({
                "ok": true,
                "payload": null,
                "message": message,
                "error": null,
                "errorKind": null,
            })
        }
    }
}

// from PR #77

fn sort_agent_defs(mut agents: Vec<AgentDefDto>) -> Vec<AgentDefDto> {
    agents.sort_by(|a, b| {
        scope_rank(&a.scope)
            .cmp(&scope_rank(&b.scope))
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
    });
    agents
}

// from PR #77

fn sort_persona_defs(mut personas: Vec<PersonaDefDto>) -> Vec<PersonaDefDto> {
    personas.sort_by(|a, b| {
        scope_rank(&a.scope)
            .cmp(&scope_rank(&b.scope))
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
    });
    personas
}

// from PR #77

fn stem_name(file_name: &str) -> String {
    let path = std::path::Path::new(file_name);
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .to_string()
}

// from PR #89

/// Whether official speech (STT) auth is available for Composer dictation.
#[tauri::command]
pub async fn voice_status() -> Result<crate::voice_stt::VoiceStatusDto, String> {
    Ok(crate::voice_stt::voice_status())
}

// from PR #89

/// Transcribe base64 audio via xAI STT (official token / API key only).
#[tauri::command]
pub async fn voice_transcribe(
    audio_base64: String,
    filename: Option<String>,
    mime: Option<String>,
) -> Result<crate::voice_stt::VoiceTranscribeResult, String> {
    Ok(crate::voice_stt::voice_transcribe(audio_base64, filename, mime).await)
}

// from PR #74

/// Case-insensitive path equality after normalization (pure; unit-tested).
pub fn worktree_paths_equal(a: &str, b: &str) -> bool {
    let na = normalize_worktree_path_key(a);
    let nb = normalize_worktree_path_key(b);
    !na.is_empty() && na == nb
}

// --- recovered PR command blocks ---

const SETUP_CMD_TIMEOUT_SECS: u64 = 60;

/// Clear Grok Build cross-session memory (`grok memory clear`).
#[tauri::command]
pub async fn memory_clear(
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<crate::agent_memory::MemoryClearResult, String> {
    let settings = store::load_settings();
    let path = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);
    let scope = scope
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "workspace".into());
    tokio::task::spawn_blocking(move || {
        crate::agent_memory::clear_workspace_memory(
            path.as_deref(),
            &settings.session_data_mode,
            settings.manual_cli_path.as_deref(),
            &scope,
        )
    })
    .await
    .map_err(|e| format!("memory clear task failed: {e}"))?
}

/// List / inspect on-disk workspace memory files under agent GROK_HOME.
#[tauri::command]
pub async fn memory_list(
    cwd: Option<String>,
) -> Result<crate::agent_memory::MemoryListResult, String> {
    let settings = store::load_settings();
    let path = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);
    tokio::task::spawn_blocking(move || {
        Ok(crate::agent_memory::list_workspace_memory(
            path.as_deref(),
            &settings.session_data_mode,
        ))
    })
    .await
    .map_err(|e| format!("memory list task failed: {e}"))?
}

/// Delete a single memory file (must live under the known memory root).
#[tauri::command]
pub async fn memory_delete_file(
    path: String,
) -> Result<crate::agent_memory::MemoryDeleteResult, String> {
    let settings = store::load_settings();
    let p = std::path::PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("path is required".into());
    }
    tokio::task::spawn_blocking(move || {
        crate::agent_memory::delete_memory_file(&p, &settings.session_data_mode)
    })
    .await
    .map_err(|e| format!("memory delete task failed: {e}"))?
}

/// Read agent `config.toml` for the active session data mode (secrets redacted).
///
/// Independent → App agent-home; shared → `~/.grok/config.toml` (UI should warn).
#[tauri::command]
pub async fn agent_config_toml_read(
) -> Result<crate::agent_config_view::AgentConfigTomlReadResult, String> {
    let settings = store::load_settings();
    let mode = settings.session_data_mode.clone();
    tokio::task::spawn_blocking(move || crate::agent_config_view::read_agent_config_toml(&mode))
        .await
        .map_err(|e| format!("agent config.toml read task failed: {e}"))
}

/// Search path-scoped memory files (name + content) under agent GROK_HOME/memory.
/// Snippets are redacted; hard caps on hits and bytes read per file.
///
/// Always keyword / file-body scan — never invents embeddings client-side.
/// Agent-tool hybrid (vector + full-text) needs `[memory.embedding].model`
/// (see `memory_embed_config_get`). No host-invocable `grok memory search` CLI
/// as of 0.2.117 — when model is set, `search_kind` is `hybrid_unavailable`.
#[tauri::command]
pub async fn memory_search(
    query: String,
    cwd: Option<String>,
    limit: Option<usize>,
) -> Result<crate::agent_memory::MemorySearchResult, String> {
    let settings = store::load_settings();
    let path = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);
    let q = query;
    tokio::task::spawn_blocking(move || {
        // Soft-probe embedding.model for search_kind honesty (never runs vectors).
        let embedding_configured =
            crate::agent_memory_embed::load_memory_embed_config()
                .map(|s| s.embedding_configured)
                .unwrap_or(false);
        Ok(crate::agent_memory::search_workspace_memory_with_kind(
            &q,
            path.as_deref(),
            &settings.session_data_mode,
            limit,
            embedding_configured,
        ))
    })
    .await
    .map_err(|e| format!("memory search task failed: {e}"))?
}

/// Read allowlisted Grok Build 0.2.117 memory embedding keys from active GROK_HOME.
/// Soft-fails missing file/keys (null fields). Never invents embedding defaults.
#[tauri::command]
pub async fn memory_embed_config_get(
) -> Result<crate::agent_memory_embed::MemoryEmbedConfigSnapshot, String> {
    tauri::async_runtime::spawn_blocking(crate::agent_memory_embed::load_memory_embed_config)
        .await
        .map_err(|e| e.to_string())?
}

/// Write allowlisted memory embedding keys into agent-home config.toml only
/// (independent mode). Soft-respawns so the next turn reloads the agent profile.
#[tauri::command]
pub async fn memory_embed_config_set(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    embedding_model: Option<String>,
    clear_embedding_model: Option<bool>,
    embedding_dimensions: Option<u32>,
    embedding_provider: Option<String>,
    search_max_results: Option<u32>,
    search_min_score: Option<f64>,
    search_vector_weight: Option<f64>,
    search_text_weight: Option<f64>,
    mmr_enabled: Option<bool>,
    mmr_lambda: Option<f64>,
    temporal_decay_enabled: Option<bool>,
    temporal_decay_half_life_days: Option<f64>,
    dream_enabled: Option<bool>,
    dream_min_hours: Option<f64>,
    dream_min_sessions: Option<u32>,
    dream_check_interval_secs: Option<u64>,
    watcher_enabled: Option<bool>,
    initial_injection_enabled: Option<bool>,
    initial_injection_min_score: Option<f64>,
) -> Result<crate::agent_memory_embed::MemoryEmbedConfigSnapshot, String> {
    let patch = crate::agent_memory_embed::MemoryEmbedConfigPatch {
        embedding_model,
        clear_embedding_model,
        embedding_dimensions,
        embedding_provider,
        search_max_results,
        search_min_score,
        search_vector_weight,
        search_text_weight,
        mmr_enabled,
        mmr_lambda,
        temporal_decay_enabled,
        temporal_decay_half_life_days,
        dream_enabled,
        dream_min_hours,
        dream_min_sessions,
        dream_check_interval_secs,
        watcher_enabled,
        initial_injection_enabled,
        initial_injection_min_score,
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_memory_embed::save_memory_embed_config(&patch)
    })
    .await
    .map_err(|e| e.to_string())??;

    mgr.soft_respawn_with_reason(&app, "memory_embed_config").await;
    Ok(result)
}

/// List agent definitions available for session agent selection.
#[tauri::command]
pub async fn agents_catalog(
    project_path: Option<String>,
) -> Result<crate::agents_catalog::AgentsCatalogResult, String> {
    Ok(crate::agents_catalog::list_agents_catalog(
        project_path.as_deref(),
    ))
}

/// Read allowlisted agent-home config.toml keys (redact-on-read preview).
#[tauri::command]
pub async fn agent_config_edit_get(
) -> Result<crate::agent_config_edit::AgentConfigEditSnapshot, String> {
    tauri::async_runtime::spawn_blocking(crate::agent_config_edit::load_agent_config_edit)
        .await
        .map_err(|e| e.to_string())?
}

/// Write allowlisted keys into agent-home config.toml only (independent mode).
/// Soft-respawns so the next turn reloads profile.
#[tauri::command]
pub async fn agent_config_edit_set(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    permission_mode: Option<String>,
    yolo: Option<bool>,
    subagents_enabled: Option<bool>,
    memory_enabled: Option<bool>,
    workflows_enabled: Option<bool>,
    auto_wake_enabled: Option<bool>,
    two_pass_compaction_enabled: Option<bool>,
    lsp_tools_enabled: Option<bool>,
    codebase_indexing: Option<bool>,
    remote_fetch: Option<bool>,
) -> Result<crate::agent_config_edit::AgentConfigEditSnapshot, String> {
    let patch = crate::agent_config_edit::AgentConfigEditPatch {
        permission_mode,
        yolo,
        subagents_enabled,
        memory_enabled,
        workflows_enabled,
        auto_wake_enabled,
        two_pass_compaction_enabled,
        lsp_tools_enabled,
        codebase_indexing,
        remote_fetch,
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_config_edit::save_agent_config_edit(&patch)
    })
    .await
    .map_err(|e| e.to_string())??;

    mgr.soft_respawn_with_reason(&app, "agent_config_edit").await;
    Ok(result)
}

/// Read allowlisted privacy keys from active GROK_HOME config.toml (redacted).
/// Soft-fails missing keys as null; never invents defaults.
#[tauri::command]
pub async fn privacy_config_get(
) -> Result<crate::agent_privacy::PrivacyConfigSnapshot, String> {
    tauri::async_runtime::spawn_blocking(crate::agent_privacy::load_privacy_config)
        .await
        .map_err(|e| e.to_string())?
}

/// Write allowlisted privacy keys into agent-home config.toml only (independent mode).
/// Soft-respawns so the next turn reloads the agent profile.
#[tauri::command]
pub async fn privacy_config_set(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    telemetry: Option<bool>,
    trace_upload: Option<bool>,
    mixpanel_enabled: Option<bool>,
    disable_codebase_upload: Option<bool>,
    disable_workspace_teleport: Option<bool>,
) -> Result<crate::agent_privacy::PrivacyConfigSnapshot, String> {
    let patch = crate::agent_privacy::PrivacyConfigPatch {
        telemetry,
        trace_upload,
        mixpanel_enabled,
        disable_codebase_upload,
        disable_workspace_teleport,
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_privacy::save_privacy_config(&patch)
    })
    .await
    .map_err(|e| e.to_string())??;

    mgr.soft_respawn_with_reason(&app, "privacy_config").await;
    Ok(result)
}

/// Read `[features].codebase_indexing` from active GROK_HOME config.toml.
/// Soft-fails missing key as unset; never invents embeddings.
#[tauri::command]
pub async fn codebase_indexing_get(
) -> Result<crate::agent_codebase_indexing::CodebaseIndexingSnapshot, String> {
    tauri::async_runtime::spawn_blocking(crate::agent_codebase_indexing::load_codebase_indexing)
        .await
        .map_err(|e| e.to_string())?
}

/// Write `[features].codebase_indexing` bool into agent-home config.toml only
/// (independent mode). Soft-respawns so the next turn reloads the agent profile.
#[tauri::command]
pub async fn codebase_indexing_set(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    enabled: Option<bool>,
) -> Result<crate::agent_codebase_indexing::CodebaseIndexingSnapshot, String> {
    let patch = crate::agent_codebase_indexing::CodebaseIndexingPatch { enabled };
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_codebase_indexing::save_codebase_indexing(&patch)
    })
    .await
    .map_err(|e| e.to_string())??;

    mgr.soft_respawn_with_reason(&app, "codebase_indexing").await;
    Ok(result)
}

// marketplace
// ── Plugin marketplace (`grok plugin marketplace …` + available list) ───────
//
// Marketplace list --json currently returns sources only (no nested plugins).
// Browse installable plugins via `plugin list --json --available`.
// Install uses `plugin install <name|name@market|url> --trust` + soft-respawn.

const PLUGIN_MARKETPLACE_MUTATE_TIMEOUT_SECS: u64 = 120;


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSourceDto {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePluginDto {
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_count: Option<u32>,
    #[serde(default)]
    pub has_hooks: bool,
    #[serde(default)]
    pub has_agents: bool,
    #[serde(default)]
    pub has_mcp: bool,
}


/// Parse `grok plugin marketplace list --json` (array or `{ sources: [...] }`).
pub fn parse_marketplace_list_json(raw: &str) -> Result<Vec<MarketplaceSourceDto>, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("Failed to parse marketplace list JSON: {e}"))?;
    let arr = if let Some(a) = value.as_array() {
        a
    } else if let Some(a) = value
        .get("sources")
        .or_else(|| value.get("marketplaces"))
        .and_then(|x| x.as_array())
    {
        a
    } else {
        return Err("marketplace list JSON is not an array".into());
    };

    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let kind = item
            .get("kind")
            .or_else(|| item.get("type"))
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "git".into());
        let source = item.get("source");
        let url = source
            .and_then(|s| {
                s.get("url")
                    .or_else(|| s.get("git"))
                    .and_then(|x| x.as_str())
            })
            .or_else(|| item.get("url").and_then(|x| x.as_str()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let path = source
            .and_then(|s| s.get("path").and_then(|x| x.as_str()))
            .or_else(|| item.get("path").and_then(|x| x.as_str()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let branch = source
            .and_then(|s| s.get("branch").and_then(|x| x.as_str()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        out.push(MarketplaceSourceDto {
            name,
            kind,
            url,
            path,
            branch,
        });
    }
    Ok(out)
}


/// Fill skill/MCP/hooks/agents counts from `components` when top-level flags are empty.
/// CLI often reports skill_count=0 / has_mcp=false while `components` is populated.
fn enrich_available_from_components(
    item: &serde_json::Value,
    skill_count: Option<u32>,
    has_hooks: bool,
    has_agents: bool,
    has_mcp: bool,
) -> (Option<u32>, bool, bool, bool) {
    let Some(comps) = item.get("components") else {
        return (skill_count, has_hooks, has_agents, has_mcp);
    };
    let mut sc = skill_count;
    let mut hh = has_hooks;
    let mut ha = has_agents;
    let mut hm = has_mcp;
    if sc.unwrap_or(0) == 0 {
        if let Some(arr) = comps.get("skills").and_then(|x| x.as_array()) {
            sc = Some(arr.len() as u32);
        }
    }
    if !hh {
        if let Some(arr) = comps.get("hooks").and_then(|x| x.as_array()) {
            hh = !arr.is_empty();
        }
    }
    if !ha {
        if let Some(arr) = comps.get("agents").and_then(|x| x.as_array()) {
            ha = !arr.is_empty();
        }
    }
    if !hm {
        if let Some(arr) = comps
            .get("mcpServers")
            .or_else(|| comps.get("mcp_servers"))
            .and_then(|x| x.as_array())
        {
            hm = !arr.is_empty();
        }
    }
    (sc, hh, ha, hm)
}

/// Parse `plugin list --json --available`; keep status "available" rows only.
pub fn parse_available_plugins_json(raw: &str) -> Result<Vec<AvailablePluginDto>, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("Failed to parse available plugins JSON: {e}"))?;
    let arr = if let Some(a) = value.as_array() {
        a
    } else if let Some(a) = value.get("plugins").and_then(|x| x.as_array()) {
        a
    } else {
        return Err("available plugins JSON is not an array".into());
    };

    let mut out = Vec::new();
    for item in arr {
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let status = item
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("available")
            .trim()
            .to_string();
        if !status.eq_ignore_ascii_case("available") {
            continue;
        }
        let marketplace = item
            .get("marketplace")
            .and_then(|x| {
                if x.is_null() {
                    None
                } else {
                    x.as_str()
                }
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let description = item
            .get("description")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let version = item
            .get("version")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let skill_count = item
            .get("skill_count")
            .or_else(|| item.get("skillCount"))
            .and_then(|x| x.as_u64())
            .map(|n| n as u32);
        let has_hooks = item
            .get("has_hooks")
            .or_else(|| item.get("hasHooks"))
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let has_agents = item
            .get("has_agents")
            .or_else(|| item.get("hasAgents"))
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let has_mcp = item
            .get("has_mcp")
            .or_else(|| item.get("hasMcp"))
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let (skill_count, has_hooks, has_agents, has_mcp) =
            enrich_available_from_components(item, skill_count, has_hooks, has_agents, has_mcp);
        out.push(AvailablePluginDto {
            name,
            status,
            marketplace,
            description,
            version,
            skill_count,
            has_hooks,
            has_agents,
            has_mcp,
        });
    }
    Ok(out)
}


pub fn normalize_marketplace_add_source(source: &str) -> Result<String, String> {
    let s = source.trim();
    if s.is_empty() {
        return Err("marketplace source required".into());
    }
    Ok(s.to_string())
}

/// CLI `marketplace remove` wants a git URL or local path — resolve name → URL.
pub fn resolve_marketplace_remove_arg(
    name_or_url: &str,
    sources: &[MarketplaceSourceDto],
) -> Result<String, String> {
    let raw = name_or_url.trim();
    if raw.is_empty() {
        return Err("marketplace source name or URL required".into());
    }
    let looks_like_url = raw.contains("://")
        || raw.starts_with("git@")
        || raw.ends_with(".git");
    let looks_like_path = raw.starts_with('/')
        || raw.starts_with('~')
        || (raw.len() >= 3
            && raw.as_bytes()[1] == b':'
            && (raw.as_bytes()[2] == b'\\' || raw.as_bytes()[2] == b'/'));
    if looks_like_url || looks_like_path {
        return Ok(raw.to_string());
    }
    let lower = raw.to_ascii_lowercase();
    if let Some(src) = sources
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case(raw) || s.name.to_ascii_lowercase() == lower)
    {
        if let Some(url) = src.url.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            return Ok(url.to_string());
        }
        if let Some(path) = src.path.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            return Ok(path.to_string());
        }
    }
    Ok(raw.to_string())
}


pub fn normalize_marketplace_update_name(name: Option<&str>) -> Option<String> {
    name.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}


fn collect_marketplace_list() -> Result<Vec<MarketplaceSourceDto>, String> {
    let (stdout, stderr, ok) = run_grok_cli_args(
        &["plugin", "marketplace", "list", "--json"],
        PLUGIN_CMD_TIMEOUT_SECS,
    )?;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "grok plugin marketplace list failed".into()
        };
        return Err(msg);
    }
    parse_marketplace_list_json(&stdout)
}


fn collect_available_plugins() -> Result<Vec<AvailablePluginDto>, String> {
    let (stdout, stderr, ok) = run_grok_cli_args(
        &["plugin", "list", "--json", "--available"],
        PLUGIN_CMD_TIMEOUT_SECS,
    )?;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "grok plugin list --available failed".into()
        };
        return Err(msg);
    }
    parse_available_plugins_json(&stdout)
}


/// List configured marketplace sources. Always Ok; error field on failure.
#[tauri::command]
pub async fn marketplace_list() -> Result<serde_json::Value, String> {
    let result = tauri::async_runtime::spawn_blocking(collect_marketplace_list)
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Ok(sources) => Ok(serde_json::json!({ "sources": sources })),
        Err(error) => Ok(serde_json::json!({
            "sources": [],
            "error": error,
        })),
    }
}


/// Available (not yet installed) plugins from marketplace catalogs.
#[tauri::command]
pub async fn marketplace_available() -> Result<serde_json::Value, String> {
    let result = tauri::async_runtime::spawn_blocking(collect_available_plugins)
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Ok(plugins) => Ok(serde_json::json!({ "plugins": plugins })),
        Err(error) => Ok(serde_json::json!({
            "plugins": [],
            "error": error,
        })),
    }
}



/// Add a marketplace source (git URL, GitHub shorthand, or local path).
#[tauri::command]
pub async fn marketplace_add(source: String) -> Result<serde_json::Value, String> {
    let source = normalize_marketplace_add_source(&source)?;
    let source_for_cmd = source.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "marketplace", "add", &source_for_cmd],
            PLUGIN_MARKETPLACE_MUTATE_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    let (stdout, stderr, ok) = match result {
        Ok(t) => t,
        Err(e) => return Err(e),
    };
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to add marketplace source {source}")
        };
        return Err(msg.chars().take(400).collect());
    }
    Ok(serde_json::json!({
        "ok": true,
        "name": source,
        "message": stdout.chars().take(400).collect::<String>(),
    }))
}

/// Remove a marketplace source by name or URL (name resolved to URL for CLI).
#[tauri::command]
pub async fn marketplace_remove(name_or_url: String) -> Result<serde_json::Value, String> {
    let raw = name_or_url.trim().to_string();
    if raw.is_empty() {
        return Err("marketplace source name or URL required".into());
    }
    let sources = collect_marketplace_list().unwrap_or_default();
    let target = resolve_marketplace_remove_arg(&raw, &sources)?;
    let target_for_cmd = target.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "marketplace", "remove", &target_for_cmd],
            PLUGIN_MARKETPLACE_MUTATE_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    let (stdout, stderr, ok) = match result {
        Ok(t) => t,
        Err(e) => return Err(e),
    };
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to remove marketplace source {target}")
        };
        return Err(msg.chars().take(400).collect());
    }
    Ok(serde_json::json!({
        "ok": true,
        "name": raw,
        "removed": target,
        "message": stdout.chars().take(400).collect::<String>(),
    }))
}

/// Update one marketplace source by name, or all when `name` is null/empty.
#[tauri::command]
pub async fn marketplace_update(name: Option<String>) -> Result<serde_json::Value, String> {
    let target = normalize_marketplace_update_name(name.as_deref());
    let target_for_cmd = target.clone();
    let result = tauri::async_runtime::spawn_blocking(move || match target_for_cmd.as_deref() {
        Some(n) => run_grok_cli_args(
            &["plugin", "marketplace", "update", n],
            PLUGIN_MARKETPLACE_MUTATE_TIMEOUT_SECS,
        ),
        None => run_grok_cli_args(
            &["plugin", "marketplace", "update"],
            PLUGIN_MARKETPLACE_MUTATE_TIMEOUT_SECS,
        ),
    })
    .await
    .map_err(|e| e.to_string())?;

    let (stdout, stderr, ok) = match result {
        Ok(t) => t,
        Err(e) => return Err(e),
    };
    if !ok {
        let label = target.as_deref().unwrap_or("all");
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to update marketplace source(s): {label}")
        };
        return Err(msg.chars().take(400).collect());
    }
    Ok(serde_json::json!({
        "ok": true,
        "name": target.unwrap_or_default(),
        "message": stdout.chars().take(400).collect::<String>(),
    }))
}


// ── Wallpaper sources (X search + Imagine) ──────────────────────────────────

#[tauri::command]
pub async fn wallpaper_x_search(
    query: String,
    sort: Option<String>,
) -> Result<crate::wallpaper_source::WallpaperSearchResult, String> {
    crate::wallpaper_source::ensure_wallpaper_dirs();
    Ok(crate::wallpaper_source::x_search_async(&query, sort.as_deref()).await)
}

#[tauri::command]
pub async fn wallpaper_fetch_media(
    url: String,
    source: Option<String>,
) -> Result<crate::wallpaper_source::WallpaperFetchResult, String> {
    crate::wallpaper_source::ensure_wallpaper_dirs();
    crate::wallpaper_source::fetch_media(&url, source.as_deref()).await
}

#[tauri::command]
pub async fn wallpaper_imagine(
    prompt: String,
    aspect_ratio: Option<String>,
) -> Result<crate::wallpaper_source::WallpaperSearchResult, String> {
    crate::wallpaper_source::ensure_wallpaper_dirs();
    let aspect = aspect_ratio.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::wallpaper_source::imagine(&prompt, aspect.as_deref())
    })
    .await
    .map_err(|e| format!("wallpaper_imagine: {e}"))
}

#[tauri::command]
pub async fn wallpaper_library_list(
    limit: Option<u32>,
) -> Result<Vec<crate::wallpaper_source::WallpaperLibraryEntry>, String> {
    crate::wallpaper_source::ensure_wallpaper_dirs();
    tauri::async_runtime::spawn_blocking(move || crate::wallpaper_source::library_list(limit))
        .await
        .map_err(|e| format!("wallpaper_library_list: {e}"))?
}

/// Headless probe: `grok -p … --output-format streaming-messages-json` (CLI 0.2.117+).
/// Soft-fails older CLIs without spawning. Raw NDJSON returned to UI only — never logged.
#[tauri::command]
pub async fn streaming_messages_json_probe(
    include_partial: Option<bool>,
) -> Result<crate::streaming_messages_json::StreamingMessagesJsonProbeResult, String> {
    let include_partial = include_partial.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        crate::streaming_messages_json::probe_streaming_messages_json(include_partial)
    })
    .await
    .map_err(|e| format!("streaming_messages_json_probe: {e}"))
}

// ─── Process budget occupancy (live / background / parked) ──────────────────

/// Snapshot of warm agent process counts vs `maxConcurrentAgents`.
/// Soft-fail: returns an empty `available: false` snapshot when the manager path errors.
#[tauri::command]
pub async fn process_budget_snapshot(
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<crate::process_limits::ProcessBudgetSnapshot, String> {
    Ok(mgr.process_budget_snapshot())
}

// ─── Tool / permission audit ledger ─────────────────────────────────────────

/// Recent cross-session tool/permission audit rows (newest first). Soft-fail → [].
#[tauri::command]
pub async fn audit_ledger_list(
    limit: Option<u32>,
) -> Result<Vec<crate::audit_ledger::AuditLedgerEntry>, String> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        crate::audit_ledger::list_recent(limit)
    })
    .await
    .map_err(|e| format!("audit_ledger_list: {e}"))?)
}

/// Clear the on-disk audit ledger (`{app_data}/audit/tool_ledger.jsonl`).
#[tauri::command]
pub async fn audit_ledger_clear() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| crate::audit_ledger::clear_ledger())
        .await
        .map_err(|e| format!("audit_ledger_clear: {e}"))??;
    Ok(serde_json::json!({ "ok": true }))
}

/// Prune audit ledger by retention days (`None` → current AppSettings value).
/// Soft-fail I/O → error string for UI toast. Returns `{ ok, dropped }`.
#[tauri::command]
pub async fn audit_ledger_prune(
    retention_days: Option<u32>,
) -> Result<serde_json::Value, String> {
    let dropped = tauri::async_runtime::spawn_blocking(move || {
        crate::audit_ledger::prune_ledger(retention_days)
    })
    .await
    .map_err(|e| format!("audit_ledger_prune: {e}"))??;
    Ok(serde_json::json!({ "ok": true, "dropped": dropped }))
}

/// Export redacted JSONL via native save dialog.
/// Optional filter: `event`, `sessionId`, `fromTs`, `toTs` (camelCase).
#[tauri::command]
pub async fn audit_ledger_export(
    filter: Option<crate::audit_ledger::AuditLedgerFilter>,
) -> Result<serde_json::Value, String> {
    let filter = filter.unwrap_or_default();
    let text = tauri::async_runtime::spawn_blocking(move || {
        crate::audit_ledger::export_redacted_jsonl_filtered(&filter)
    })
    .await
    .map_err(|e| format!("audit_ledger_export: {e}"))?;
    if text.trim().is_empty() {
        return Err("audit ledger is empty".into());
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = format!("grok-app-audit-ledger-{stamp}.jsonl");
    let tmp_dir = std::env::temp_dir();
    let tmp = tmp_dir.join(&name);
    tauri::async_runtime::spawn_blocking({
        let tmp = tmp.clone();
        let text = text.clone();
        move || std::fs::write(&tmp, text).map_err(|e| format!("write temp: {e}"))
    })
    .await
    .map_err(|e| format!("audit_ledger_export: {e}"))??;

    save_and_reveal_file(
        tmp,
        "Export audit ledger",
        &name,
        "JSONL",
        &["jsonl", "json", "txt"],
    )
    .await
}

/// One-shot headless batch turn for a project cwd (`grok -p`, soft-fail).
/// Sequential multi-project dispatch lives in the FE; this runs a single project.
#[tauri::command]
pub async fn batch_agents_headless(
    project_path: String,
    prompt: String,
    timeout_ms: Option<u64>,
) -> Result<crate::batch_agents::BatchHeadlessResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::batch_agents::run_batch_headless(&project_path, &prompt, timeout_ms)
    })
    .await
    .map_err(|e| format!("batch_agents_headless: {e}"))
}

// ── X Evidence Rail (search → local evidence store → quote pack) ────────────
// Design: docs/features/x-search.md — every X search result becomes a local
// evidence row with a stable id; later turns list / re-read / quote without
// re-searching. Write path (publishing to X) intentionally absent.

#[tauri::command]
pub async fn x_evidence_search(
    query: String,
    limit: Option<u32>,
    session_tag: Option<String>,
) -> Result<crate::x_evidence::XSearchEnvelope, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::x_evidence::x_search(&query, limit, session_tag.as_deref())
    })
    .await
    .map_err(|e| format!("x_evidence_search: {e}"))
}

#[tauri::command]
pub async fn x_evidence_list(
    filter: Option<crate::x_evidence::EvidenceFilter>,
) -> Result<Vec<crate::x_evidence::EvidenceItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::x_evidence::evidence_list(&filter.unwrap_or_default())
    })
    .await
    .map_err(|e| format!("x_evidence_list: {e}"))?
}

#[tauri::command]
pub async fn x_evidence_get(
    ids: Vec<String>,
) -> Result<Vec<crate::x_evidence::EvidenceItem>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::x_evidence::evidence_get(&ids))
        .await
        .map_err(|e| format!("x_evidence_get: {e}"))?
}

#[tauri::command]
pub async fn x_evidence_stats() -> Result<crate::x_evidence::EvidenceStats, String> {
    tauri::async_runtime::spawn_blocking(crate::x_evidence::evidence_stats)
        .await
        .map_err(|e| format!("x_evidence_stats: {e}"))?
}

#[tauri::command]
pub async fn x_quote_pack(
    ids: Vec<String>,
    title: Option<String>,
) -> Result<crate::x_evidence::QuotePack, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::x_evidence::quote_pack(&ids, title.as_deref())
    })
    .await
    .map_err(|e| format!("x_quote_pack: {e}"))?
}

