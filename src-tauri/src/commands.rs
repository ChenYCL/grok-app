//! Tauri commands — Host facade.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cli_probe::{self, CliProbeResult};
use crate::session_manager::{SessionManager, SessionSnapshot};
use crate::store::{self, AppSettings, Project, SecretsFile, SessionMeta};

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

#[tauri::command]
pub async fn session_send(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    text: String,
) -> Result<SessionSnapshot, String> {
    mgr.send_message(app, text).await
}

#[tauri::command]
pub async fn session_stop(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<SessionSnapshot, String> {
    mgr.stop(app).await
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
) -> Result<SessionSnapshot, String> {
    mgr.resolve_permission(app, rpc_id, decision, option_id, scope_key)
        .await
}

#[tauri::command]
pub async fn probe_cli(manual_path: Option<String>) -> Result<CliProbeResult, String> {
    Ok(cli_probe::probe_cli(manual_path.as_deref()))
}

#[tauri::command]
pub async fn projects_list() -> Result<Vec<Project>, String> {
    Ok(store::load_projects())
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

#[tauri::command]
pub async fn project_trust(id: String) -> Result<Project, String> {
    store::trust_project(&id)
}

#[tauri::command]
pub async fn project_rename(id: String, name: String) -> Result<Project, String> {
    store::rename_project(&id, &name)
}

#[tauri::command]
pub async fn project_set_pinned(id: String, pinned: bool) -> Result<Project, String> {
    store::set_project_pinned(&id, pinned)
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
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
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

#[tauri::command]
pub async fn session_create(
    project_id: Option<String>,
    title: Option<String>,
) -> Result<SessionMeta, String> {
    store::create_session(project_id, title)
}

#[tauri::command]
pub async fn session_delete(id: String) -> Result<(), String> {
    store::delete_session(&id)
}

#[tauri::command]
pub async fn session_rename(id: String, title: String) -> Result<SessionMeta, String> {
    store::rename_session(&id, &title)
}

#[tauri::command]
pub async fn session_set_archived(id: String, archived: bool) -> Result<SessionMeta, String> {
    store::set_session_archived(&id, archived)
}

#[tauri::command]
pub async fn session_messages(
    id: String,
) -> Result<Vec<store::ChatMessageStored>, String> {
    Ok(store::load_messages(&id))
}

#[tauri::command]
pub async fn settings_get() -> Result<AppSettings, String> {
    Ok(store::load_settings())
}

#[tauri::command]
pub async fn settings_set(
    mgr: State<'_, Arc<SessionManager>>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    store::save_settings(&settings)?;
    // Apply permission policy to live session immediately (chip / settings)
    mgr.set_permission_policy(crate::permission::PermissionPolicy::parse(
        &settings.permission_policy,
    ));
    Ok(settings)
}

#[tauri::command]
pub async fn session_set_policy(
    mgr: State<'_, Arc<SessionManager>>,
    policy: String,
) -> Result<(), String> {
    let p = crate::permission::PermissionPolicy::parse(&policy);
    mgr.set_permission_policy(p);
    let mut s = store::load_settings();
    s.permission_policy = p.as_str().into();
    store::save_settings(&s)?;
    Ok(())
}

#[tauri::command]
pub async fn fs_list_dir(
    project_path: String,
    relative: Option<String>,
) -> Result<Vec<crate::fs_browser::FsEntry>, String> {
    crate::fs_browser::list_dir(&project_path, relative.as_deref().unwrap_or(""))
}

#[tauri::command]
pub async fn fs_read_file(
    project_path: String,
    relative: String,
) -> Result<crate::fs_browser::FsReadResult, String> {
    crate::fs_browser::read_file(&project_path, &relative)
}

/// Auto-name a session from the first user message.
/// Returns heuristic title immediately; low-effort CLI refine emits `session://title`.
#[tauri::command]
pub async fn session_auto_title(
    app: tauri::AppHandle,
    id: String,
    first_message: String,
) -> Result<store::SessionMeta, String> {
    let meta = crate::session_title::auto_title_session_fast(&id, &first_message)?;
    crate::session_title::refine_title_in_background(app, id, first_message);
    Ok(meta)
}

#[tauri::command]
pub async fn secrets_get_masked() -> Result<serde_json::Value, String> {
    let s = store::load_secrets();
    Ok(serde_json::json!({
        "hasOfficialKey": s.official_api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false),
        "hasRelayKey": s.relay_api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false),
        "relayBaseUrl": s.relay_base_url,
        "defaultModel": s.default_model,
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
    if let Some(k) = official_api_key {
        if !k.is_empty() {
            s.official_api_key = Some(k);
        }
    }
    if let Some(u) = relay_base_url {
        s.relay_base_url = if u.is_empty() { None } else { Some(u) };
    }
    if let Some(k) = relay_api_key {
        if !k.is_empty() {
            s.relay_api_key = Some(k);
        }
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
    let home = std::env::var("HOME").unwrap_or_default();
    let auth = std::path::PathBuf::from(home).join(".grok/auth.json");
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

#[tauri::command]
pub async fn import_grok_cli_config() -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let auth = std::path::PathBuf::from(&home).join(".grok/auth.json");
    let config = std::path::PathBuf::from(&home).join(".grok/config.toml");
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
    settings.onboarding_done = true;
    store::save_settings(&settings)?;
    Ok(serde_json::json!({
        "ok": auth.is_file(),
        "messages": msg,
    }))
}

#[tauri::command]
pub async fn import_grok_go_config() -> Result<serde_json::Value, String> {
    // Common grok-go config locations (read-only)
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/Library/Application Support/com.grokgo.desktop/config.json"),
        format!("{home}/.grok-go/config.json"),
        format!("{home}/Library/Application Support/GrokGo/config.json"),
    ];
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
            settings.onboarding_done = true;
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

#[tauri::command]
pub async fn doctor_report() -> Result<serde_json::Value, String> {
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let projects = store::load_projects();
    let sessions = store::load_sessions_index();
    let secrets = store::load_secrets();
    let home = std::env::var("HOME").unwrap_or_default();
    let auth_path = format!("{home}/.grok/auth.json");
    let auth_ok = std::path::Path::new(&auth_path).is_file();
    let data_root = crate::paths::app_data_root().display().to_string();
    let log_dir = crate::paths::app_data_root()
        .join("logs")
        .display()
        .to_string();

    let report = serde_json::json!({
        "cli": {
            "found": probe.found,
            "path": probe.path,
            "version": probe.version,
            "source": probe.source,
        },
        "auth": {
            "cliAuthJson": auth_ok,
            "hasOfficialKey": secrets.official_api_key.is_some(),
            "hasRelay": secrets.relay_base_url.is_some() && secrets.relay_api_key.is_some(),
        },
        "workspace": {
            "projectCount": projects.len(),
            "sessionCount": sessions.len(),
            "dataRoot": data_root,
            "sessionDataMode": settings.session_data_mode,
        },
        "logs": { "dir": log_dir },
        "app": {
            "version": env!("CARGO_PKG_VERSION"),
            "backendDefault": if crate::acp_client::AcpClient::use_mock() { "mock_acp" } else { "grok_agent_stdio" },
            "nonOfficial": true,
            "license": "MIT",
        }
    });
    Ok(report)
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
    Ok(folder.map(|p| p.display().to_string()))
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
            PathEntry {
                path: p,
                name,
                is_dir,
                exists,
            }
        })
        .collect()
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
        std::process::Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &p])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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
        std::process::Command::new("open")
            .args(["-R", &p])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
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
        std::process::Command::new("xdg-open")
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
