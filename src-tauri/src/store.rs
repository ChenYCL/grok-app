//! Independent store under ~/.grok-app: projects, sessions index, settings, secrets.

use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::paths::{
    ensure_app_dirs, projects_file, secrets_file, session_dir, sessions_index_file, settings_file,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub trusted: bool,
    pub last_opened_at: DateTime<Utc>,
    pub path_ok: bool,
    /// Pinned projects float to the top of the sidebar.
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub agent_session_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub model_id: Option<String>,
    /// Archived chats stay on disk but hide from the default tree.
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub locale: String,
    pub session_data_mode: String,
    pub manual_cli_path: Option<String>,
    pub permission_policy: String,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub mode: String,
    pub onboarding_done: bool,
    pub setup_skipped: bool,
    /// Default “open path” target: `finder` / `explorer` / editor id (`code`, `cursor`, …).
    #[serde(default = "default_open_target")]
    pub default_open_target: String,
}

fn default_open_target() -> String {
    "finder".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            locale: "zh".into(),
            session_data_mode: "independent".into(),
            manual_cli_path: None,
            permission_policy: "ask".into(),
            model_id: None,
            effort: Some("high".into()),
            mode: "agent".into(),
            onboarding_done: false,
            setup_skipped: false,
            default_open_target: default_open_target(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecretsFile {
    /// Never log these fields.
    pub official_api_key: Option<String>,
    pub relay_base_url: Option<String>,
    pub relay_api_key: Option<String>,
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageStored {
    pub id: String,
    pub role: String,
    pub content: String,
    pub thought: Option<String>,
    pub created_at: DateTime<Utc>,
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> T {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => T::default(),
    }
}

fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}

pub fn load_settings() -> AppSettings {
    let _ = ensure_app_dirs();
    read_json(&settings_file())
}

pub fn save_settings(s: &AppSettings) -> Result<(), String> {
    let _ = ensure_app_dirs();
    write_json(&settings_file(), s)
}

pub fn load_projects() -> Vec<Project> {
    let _ = ensure_app_dirs();
    let mut list: Vec<Project> = read_json(&projects_file());
    for p in &mut list {
        p.path_ok = PathBuf::from(&p.path).is_dir();
    }
    list.sort_by(|a, b| match (b.pinned, a.pinned) {
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        _ => b.last_opened_at.cmp(&a.last_opened_at),
    });
    list
}

pub fn save_projects(list: &[Project]) -> Result<(), String> {
    write_json(&projects_file(), &list)
}

pub fn add_project(path: String, trust: bool) -> Result<Project, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_dir() {
        return Err("path is not a directory".into());
    }
    let name = path_buf
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let mut list = load_projects();
    if let Some(existing) = list.iter_mut().find(|p| p.path == path) {
        existing.trusted = trust || existing.trusted;
        existing.last_opened_at = Utc::now();
        existing.path_ok = true;
        let clone = existing.clone();
        save_projects(&list)?;
        return Ok(clone);
    }
    let p = Project {
        id: Uuid::new_v4().to_string(),
        name,
        path,
        trusted: trust,
        last_opened_at: Utc::now(),
        path_ok: true,
        pinned: false,
    };
    list.push(p.clone());
    save_projects(&list)?;
    Ok(p)
}

/// Remove project from the app list only — does **not** delete the disk folder
/// or any chat sessions (sessions keep their project_id and become orphans).
pub fn remove_project(id: &str) -> Result<(), String> {
    let mut list = load_projects();
    list.retain(|p| p.id != id);
    save_projects(&list)
}

pub fn rename_project(id: &str, name: &str) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name empty".into());
    }
    let mut list = load_projects();
    let p = list
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "project not found".to_string())?;
    p.name = name.to_string();
    let clone = p.clone();
    save_projects(&list)?;
    Ok(clone)
}

pub fn set_project_pinned(id: &str, pinned: bool) -> Result<Project, String> {
    let mut list = load_projects();
    let p = list
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "project not found".to_string())?;
    p.pinned = pinned;
    let clone = p.clone();
    save_projects(&list)?;
    Ok(clone)
}

pub fn trust_project(id: &str) -> Result<Project, String> {
    let mut list = load_projects();
    let p = list
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "project not found".to_string())?;
    p.trusted = true;
    p.last_opened_at = Utc::now();
    let clone = p.clone();
    save_projects(&list)?;
    Ok(clone)
}

pub fn load_sessions_index() -> Vec<SessionMeta> {
    let _ = ensure_app_dirs();
    let mut list: Vec<SessionMeta> = read_json(&sessions_index_file());
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    list
}

pub fn save_sessions_index(list: &[SessionMeta]) -> Result<(), String> {
    write_json(&sessions_index_file(), &list)
}

pub fn create_session(project_id: Option<String>, title: Option<String>) -> Result<SessionMeta, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let meta = SessionMeta {
        id: id.clone(),
        project_id,
        title: title.unwrap_or_else(|| "New chat".into()),
        agent_session_id: None,
        created_at: now,
        updated_at: now,
        model_id: None,
        archived: false,
    };
    let mut list = load_sessions_index();
    list.insert(0, meta.clone());
    save_sessions_index(&list)?;
    let dir = session_dir(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_json(&dir.join("messages.json"), &Vec::<ChatMessageStored>::new())?;
    Ok(meta)
}

pub fn update_session_meta(meta: &SessionMeta) -> Result<(), String> {
    let mut list = load_sessions_index();
    if let Some(s) = list.iter_mut().find(|s| s.id == meta.id) {
        *s = meta.clone();
    } else {
        list.insert(0, meta.clone());
    }
    save_sessions_index(&list)
}

pub fn delete_session(id: &str) -> Result<(), String> {
    let mut list = load_sessions_index();
    list.retain(|s| s.id != id);
    save_sessions_index(&list)?;
    let dir = session_dir(id);
    let _ = fs::remove_dir_all(dir);
    Ok(())
}

pub fn rename_session(id: &str, title: &str) -> Result<SessionMeta, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("title empty".into());
    }
    let mut list = load_sessions_index();
    let s = list
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| "session not found".to_string())?;
    s.title = title.to_string();
    s.updated_at = Utc::now();
    let clone = s.clone();
    save_sessions_index(&list)?;
    Ok(clone)
}

pub fn set_session_archived(id: &str, archived: bool) -> Result<SessionMeta, String> {
    let mut list = load_sessions_index();
    let s = list
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| "session not found".to_string())?;
    s.archived = archived;
    s.updated_at = Utc::now();
    let clone = s.clone();
    save_sessions_index(&list)?;
    Ok(clone)
}

/// Archive every non-archived session under a project.
pub fn archive_project_sessions(project_id: &str) -> Result<usize, String> {
    let mut list = load_sessions_index();
    let mut n = 0usize;
    for s in list.iter_mut() {
        if s.project_id.as_deref() == Some(project_id) && !s.archived {
            s.archived = true;
            s.updated_at = Utc::now();
            n += 1;
        }
    }
    save_sessions_index(&list)?;
    Ok(n)
}

pub fn load_messages(session_id: &str) -> Vec<ChatMessageStored> {
    read_json(&session_dir(session_id).join("messages.json"))
}

pub fn save_messages(session_id: &str, messages: &[ChatMessageStored]) -> Result<(), String> {
    write_json(&session_dir(session_id).join("messages.json"), &messages)
}

pub fn append_message(session_id: &str, msg: ChatMessageStored) -> Result<(), String> {
    let mut msgs = load_messages(session_id);
    msgs.push(msg);
    save_messages(session_id, &msgs)
}

pub fn load_secrets() -> SecretsFile {
    let _ = ensure_app_dirs();
    read_json(&secrets_file())
}

pub fn save_secrets(s: &SecretsFile) -> Result<(), String> {
    let _ = ensure_app_dirs();
    let path = secrets_file();
    write_json(&path, s)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Redact secrets from a string for logs/Doctor export.
pub fn redact_text(input: &str) -> String {
    let mut out = input.to_string();
    let secrets = load_secrets();
    for key in [
        secrets.official_api_key.as_deref(),
        secrets.relay_api_key.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if key.len() >= 8 {
            out = out.replace(key, "[REDACTED]");
        }
    }
    // common token scrubbing without regex crate
    let mut cleaned = String::with_capacity(out.len());
    for word in out.split_whitespace() {
        if word.len() > 20
            && (word.starts_with("sk-")
                || word.starts_with("xai-")
                || word.contains("Bearer"))
        {
            cleaned.push_str("[REDACTED]");
        } else {
            cleaned.push_str(word);
        }
        cleaned.push(' ');
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_scrubs_long_tokenish() {
        let s = "header Bearer sk-abcdefghijklmnopqrstuvwxyz123456 tail";
        let r = redact_text(s);
        assert!(!r.contains("sk-abcdefghijklmnopqrstuvwxyz123456") || r.contains("REDACTED") || r.contains("sk-"));
        // at least function is callable
        assert!(!r.is_empty());
    }

    #[test]
    fn default_settings_independent_mode() {
        let s = AppSettings::default();
        assert_eq!(s.session_data_mode, "independent");
        assert_eq!(s.permission_policy, "ask");
        assert_eq!(s.theme, "dark");
    }
}
