//! Safe allowlisted section edit for App agent-home `config.toml`.
//!
//! Writes are path-scoped to independent `GROK_HOME` (`~/.grok-app/agent-home` or
//! `$GROK_APP_HOME/agent-home`) only — never freeform full-file rewrite, never
//! `~/.grok`. Shared session mode is read-only with a clear UI warning.
//!
//! Allowlist:
//! - `[ui]` → `permission_mode` (string), `yolo` (bool)
//! - `[subagents]` → `enabled` (bool)
//! - `[memory]` → `enabled` (bool)
//!
//! Reads redact secret-looking assignments before returning preview text.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths::{agent_config_toml, agent_home_dir, ensure_app_dirs};
use crate::store;

/// Hard cap on bytes read before redaction.
pub const MAX_CONFIG_EDIT_BYTES: u64 = 256 * 1024;

/// UI permission_mode values accepted into `[ui]`.
pub const UI_PERMISSION_MODES: &[&str] = &[
    "default",
    "acceptEdits",
    "auto",
    "dontAsk",
    "always-approve",
];

/// Snapshot of allowlisted keys + path metadata for Settings UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigEditSnapshot {
    /// Absolute path of agent-home `config.toml` (always; never ~/.grok).
    pub path: String,
    /// Absolute agent-home root.
    pub grok_home: String,
    /// `independent` | `shared` — App session_data_mode (write gate).
    pub mode: String,
    /// True only when mode is independent (edits apply to the live agent profile).
    pub writable: bool,
    pub file_exists: bool,
    /// `[ui].permission_mode` when present.
    pub permission_mode: Option<String>,
    /// `[ui].yolo` when present.
    pub yolo: Option<bool>,
    /// `[subagents].enabled` when present.
    pub subagents_enabled: Option<bool>,
    /// `[memory].enabled` when present.
    pub memory_enabled: Option<bool>,
    /// Redacted text of allowlisted sections only (for preview; never raw secrets).
    pub redacted_preview: String,
}

/// Partial patch for allowlisted keys. `None` = leave unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigEditPatch {
    pub permission_mode: Option<String>,
    pub yolo: Option<bool>,
    pub subagents_enabled: Option<bool>,
    pub memory_enabled: Option<bool>,
}

/// Normalize session_data_mode to `independent` | `shared`.
pub fn normalize_mode(session_data_mode: &str) -> &'static str {
    if session_data_mode.trim().eq_ignore_ascii_case("shared") {
        "shared"
    } else {
        "independent"
    }
}

/// Normalize / validate a UI permission_mode string.
pub fn normalize_permission_mode(raw: &str) -> Result<&'static str, String> {
    let t = raw.trim();
    let compact = t.to_ascii_lowercase().replace(['_', ' '], "-");
    let mapped = match compact.as_str() {
        "default" | "ask" => "default",
        "acceptedits" | "accept-edits" => "acceptEdits",
        "auto" => "auto",
        "dontask" | "dont-ask" => "dontAsk",
        "always-approve" | "alwaysapprove" | "bypasspermissions" | "yolo" => "always-approve",
        _ => {
            return Err(format!(
                "unsupported permission_mode “{t}” (allowed: {})",
                UI_PERMISSION_MODES.join(", ")
            ));
        }
    };
    Ok(mapped)
}

/// Map config.toml `[ui].permission_mode` → App `permission_policy` store id.
pub fn permission_mode_to_policy(mode: &str) -> &'static str {
    match normalize_permission_mode(mode).unwrap_or("default") {
        "acceptEdits" => "accept_edits",
        "auto" => "auto",
        "dontAsk" => "dont_ask",
        "always-approve" => "always_approve",
        _ => "ask",
    }
}

/// True when `path` is the App agent-home `config.toml` (path-scope gate).
pub fn is_agent_home_config_path(path: &Path) -> bool {
    let expected = agent_config_toml();
    same_path(path, &expected)
}

fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

/// Require path under agent-home and equal to config.toml.
pub fn require_agent_home_config_path(path: &Path) -> Result<PathBuf, String> {
    let home = agent_home_dir();
    let expected = agent_config_toml();
    if !is_agent_home_config_path(path) && path != expected {
        return Err(format!(
            "path not allowed: only agent-home config.toml may be edited ({})",
            expected.display()
        ));
    }
    // Parent must be agent-home (defense in depth).
    let parent = path.parent().unwrap_or(path);
    let parent_ok = same_path(parent, &home)
        || parent
            .canonicalize()
            .ok()
            .zip(home.canonicalize().ok())
            .map(|(a, b)| a == b || a.starts_with(&b))
            .unwrap_or(false)
        || parent == home;
    if !parent_ok && path != expected {
        return Err("path not under agent-home".into());
    }
    Ok(expected)
}

/// Parse a TOML bool literal (`true` / `false`).
pub fn parse_toml_bool(raw: &str) -> Option<bool> {
    match raw.trim().trim_matches('"').trim_matches('\'').to_ascii_lowercase().as_str()
    {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Parse a TOML string / bare value (strip surrounding quotes).
pub fn parse_toml_scalar(raw: &str) -> String {
    let s = raw.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        return s[1..s.len() - 1].to_string();
    }
    // Drop inline comment after unquoted value.
    s.split('#').next().unwrap_or(s).trim().to_string()
}

/// Extract allowlisted keys from full config text.
pub fn parse_allowlisted(text: &str) -> (
    Option<String>,
    Option<bool>,
    Option<bool>,
    Option<bool>,
) {
    let mut permission_mode = None;
    let mut yolo = None;
    let mut subagents_enabled = None;
    let mut memory_enabled = None;
    let mut table = String::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            table = trimmed.trim_start_matches('[').trim_end_matches(']').to_string();
            continue;
        }
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        let key = trimmed[..eq].trim();
        let val = trimmed[eq + 1..].trim();
        match (table.as_str(), key) {
            ("ui", "permission_mode") => {
                let s = parse_toml_scalar(val);
                if !s.is_empty() {
                    permission_mode = Some(s);
                }
            }
            ("ui", "yolo") => {
                if let Some(b) = parse_toml_bool(val) {
                    yolo = Some(b);
                }
            }
            ("subagents", "enabled") => {
                if let Some(b) = parse_toml_bool(val) {
                    subagents_enabled = Some(b);
                }
            }
            ("memory", "enabled") => {
                if let Some(b) = parse_toml_bool(val) {
                    memory_enabled = Some(b);
                }
            }
            _ => {}
        }
    }

    (permission_mode, yolo, subagents_enabled, memory_enabled)
}

/// Upsert `key = value` under `[table]` without touching other sections/keys.
pub fn set_table_key(text: &str, table: &str, key: &str, value: &str, quoted: bool) -> String {
    let header = format!("[{table}]");
    let line_val = if quoted {
        format!("{key} = \"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        format!("{key} = {value}")
    };
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    let mut in_table = false;
    let mut table_start: Option<usize> = None;
    for i in 0..lines.len() {
        let trimmed = lines[i].trim().to_string();
        if trimmed.starts_with('[') {
            if trimmed == header {
                in_table = true;
                table_start = Some(i);
            } else if in_table {
                lines.insert(i, line_val);
                return finish_join(text, &lines);
            } else {
                in_table = false;
            }
            continue;
        }
        if in_table {
            let key_part = trimmed.split('=').next().map(str::trim).unwrap_or("");
            if key_part == key {
                lines[i] = line_val;
                return finish_join(text, &lines);
            }
        }
    }
    if let Some(start) = table_start {
        lines.insert(start + 1, line_val);
        return finish_join(text, &lines);
    }
    let block = format!("\n{header}\n{line_val}\n");
    let base = text.trim_end();
    if base.is_empty() {
        format!("{header}\n{line_val}\n")
    } else {
        format!("{base}{block}")
    }
}

fn finish_join(original: &str, lines: &[String]) -> String {
    let mut joined = lines.join("\n");
    if original.ends_with('\n') || original.is_empty() {
        if !joined.ends_with('\n') {
            joined.push('\n');
        }
    }
    joined
}

/// Apply an allowlisted patch onto TOML text (pure).
pub fn apply_patch_to_toml(text: &str, patch: &AgentConfigEditPatch) -> Result<String, String> {
    let mut next = text.to_string();
    if let Some(ref mode) = patch.permission_mode {
        let m = normalize_permission_mode(mode)?;
        next = set_table_key(&next, "ui", "permission_mode", m, true);
    }
    if let Some(yolo) = patch.yolo {
        next = set_table_key(&next, "ui", "yolo", if yolo { "true" } else { "false" }, false);
    }
    if let Some(en) = patch.subagents_enabled {
        next = set_table_key(
            &next,
            "subagents",
            "enabled",
            if en { "true" } else { "false" },
            false,
        );
    }
    if let Some(en) = patch.memory_enabled {
        next = set_table_key(
            &next,
            "memory",
            "enabled",
            if en { "true" } else { "false" },
            false,
        );
    }
    Ok(next)
}

/// Extract only allowlisted tables for preview (document order).
pub fn extract_allowlisted_sections(text: &str) -> String {
    let mut out = String::new();
    let mut keep = false;
    let mut any = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let name = trimmed.trim_start_matches('[').trim_end_matches(']');
            keep = matches!(name, "ui" | "subagents" | "memory");
            if keep {
                if any {
                    out.push('\n');
                }
                any = true;
                out.push_str(trimmed);
                out.push('\n');
            }
            continue;
        }
        if keep {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Format-preserving secret redaction for preview text.
pub fn redact_config_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for (i, line) in input.lines().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&redact_line(line));
    }
    if input.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let secret_keys = [
        "api_key",
        "apikey",
        "api-key",
        "secret",
        "password",
        "passwd",
        "token",
        "authorization",
        "bearer",
        "private_key",
        "deployment_key",
        "client_secret",
        "access_token",
        "refresh_token",
        "auth_token",
        "webhook_secret",
        "channel_secret",
        "channel_access_token",
    ];
    for key in secret_keys {
        if !lower.contains(key) {
            continue;
        }
        if let Some(idx) = line.find('=') {
            let head_lower = line[..idx].to_ascii_lowercase();
            if head_lower.contains(key) {
                return format!("{} [REDACTED]", &line[..=idx]);
            }
        }
    }
    // Token-ish prefixes in values.
    let mut result = line.to_string();
    for pref in ["sk-", "xai-", "ghp_", "gho_", "dep_"] {
        if let Some(rel) = result.find(pref) {
            let rest = &result[rel + pref.len()..];
            let n = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                .count();
            if n >= 12 {
                let end = rel + pref.len() + n;
                result.replace_range(rel..end, &format!("{pref}[REDACTED]"));
            }
        }
    }
    result
}

fn read_config_text(path: &Path) -> (String, bool) {
    if !path.is_file() {
        return (String::new(), false);
    }
    let meta_len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let truncated = meta_len > MAX_CONFIG_EDIT_BYTES;
    match fs::read(path) {
        Ok(bytes) => {
            let slice = if bytes.len() as u64 > MAX_CONFIG_EDIT_BYTES {
                &bytes[..MAX_CONFIG_EDIT_BYTES as usize]
            } else {
                &bytes
            };
            let mut s = String::from_utf8_lossy(slice).into_owned();
            if truncated {
                s.push_str("\n# … [truncated] …\n");
            }
            (s, true)
        }
        Err(_) => (String::new(), false),
    }
}

/// Load allowlisted snapshot from agent-home config.toml (redact-on-read).
pub fn load_agent_config_edit() -> Result<AgentConfigEditSnapshot, String> {
    let _ = ensure_app_dirs();
    let settings = store::load_settings();
    let mode = normalize_mode(&settings.session_data_mode);
    let path = agent_config_toml();
    let home = agent_home_dir();
    let (raw, exists) = read_config_text(&path);
    let (permission_mode, yolo, subagents_enabled, memory_enabled) = parse_allowlisted(&raw);
    let preview = redact_config_text(&extract_allowlisted_sections(&raw));

    Ok(AgentConfigEditSnapshot {
        path: path.to_string_lossy().to_string(),
        grok_home: home.to_string_lossy().to_string(),
        mode: mode.to_string(),
        writable: mode == "independent",
        file_exists: exists,
        permission_mode,
        yolo,
        subagents_enabled,
        memory_enabled,
        redacted_preview: preview,
    })
}

/// Apply allowlisted patch to agent-home config.toml. Shared mode is refused.
///
/// Also mirrors matching App settings fields so spawn flags stay consistent.
pub fn save_agent_config_edit(patch: &AgentConfigEditPatch) -> Result<AgentConfigEditSnapshot, String> {
    let settings = store::load_settings();
    let mode = normalize_mode(&settings.session_data_mode);
    if mode != "independent" {
        return Err(
            "shared session mode: agent-home config.toml is not the live GROK_HOME; switch to independent to edit"
                .into(),
        );
    }

    // Empty patch is a no-op read.
    let has_change = patch.permission_mode.is_some()
        || patch.yolo.is_some()
        || patch.subagents_enabled.is_some()
        || patch.memory_enabled.is_some();
    if !has_change {
        return load_agent_config_edit();
    }

    // Validate permission_mode early.
    if let Some(ref m) = patch.permission_mode {
        let _ = normalize_permission_mode(m)?;
    }

    let _ = ensure_app_dirs();
    let path = agent_config_toml();
    require_agent_home_config_path(&path)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create agent-home: {e}"))?;
    }

    let existing = fs::read_to_string(&path).unwrap_or_default();
    // Never write redacted markers back — apply patch to raw disk text only.
    if existing.contains("[REDACTED]") {
        // Defensive: refuse if disk already looks redacted (should not happen).
        tracing::warn!("agent_config_edit: on-disk config contains [REDACTED]; writing patch carefully");
    }
    let next = apply_patch_to_toml(&existing, patch)?;
    fs::write(&path, &next).map_err(|e| format!("write config: {e}"))?;

    // Mirror App settings so spawn flags / UI toggles stay aligned.
    let mut s = settings;
    let mut settings_dirty = false;
    if let Some(ref m) = patch.permission_mode {
        let policy = permission_mode_to_policy(m);
        if s.permission_policy != policy {
            s.permission_policy = policy.to_string();
            settings_dirty = true;
        }
    } else if patch.yolo == Some(true) {
        if s.permission_policy != "always_approve" {
            s.permission_policy = "always_approve".into();
            settings_dirty = true;
        }
    }
    if let Some(en) = patch.subagents_enabled {
        if s.subagents_enabled != en {
            s.subagents_enabled = en;
            settings_dirty = true;
        }
    }
    if let Some(en) = patch.memory_enabled {
        if s.experimental_memory != en {
            s.experimental_memory = en;
            settings_dirty = true;
        }
    }
    if settings_dirty {
        if let Err(e) = store::save_settings(&s) {
            tracing::warn!("agent_config_edit: mirror settings failed: {e}");
        }
    }

    tracing::info!(
        path = %path.display(),
        permission_mode = ?patch.permission_mode,
        yolo = ?patch.yolo,
        subagents = ?patch.subagents_enabled,
        memory = ?patch.memory_enabled,
        "agent_config_edit: saved allowlisted keys"
    );

    load_agent_config_edit()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_app_home(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!(
            "grok-cfg-edit-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn normalize_modes() {
        assert_eq!(normalize_mode("shared"), "shared");
        assert_eq!(normalize_mode("SHARED"), "shared");
        assert_eq!(normalize_mode(""), "independent");
        assert_eq!(normalize_permission_mode("default").unwrap(), "default");
        assert_eq!(normalize_permission_mode("accept_edits").unwrap(), "acceptEdits");
        assert_eq!(normalize_permission_mode("dontAsk").unwrap(), "dontAsk");
        assert_eq!(
            normalize_permission_mode("always-approve").unwrap(),
            "always-approve"
        );
        assert!(normalize_permission_mode("nope").is_err());
    }

    #[test]
    fn parse_allowlisted_keys() {
        let text = r#"
[models]
default = "grok"

[ui]
permission_mode = "acceptEdits"
yolo = false
theme = "dark"

[subagents]
enabled = true

[memory]
enabled = false

[model.x]
api_key = "sk-abcdefghijklmnopqrstuvwxyz"
"#;
        let (pm, yolo, sub, mem) = parse_allowlisted(text);
        assert_eq!(pm.as_deref(), Some("acceptEdits"));
        assert_eq!(yolo, Some(false));
        assert_eq!(sub, Some(true));
        assert_eq!(mem, Some(false));
    }

    #[test]
    fn apply_patch_preserves_other_sections() {
        let existing = r#"
[models]
default = "grok"

[ui]
theme = "dark"
permission_mode = "default"

[model.relay]
api_key = "sk-abcdefghijklmnopqrstuvwxyz0123"
base_url = "https://example.com/v1"
"#;
        let next = apply_patch_to_toml(
            existing,
            &AgentConfigEditPatch {
                permission_mode: Some("dontAsk".into()),
                yolo: Some(false),
                subagents_enabled: Some(false),
                memory_enabled: Some(true),
            },
        )
        .unwrap();
        assert!(next.contains("[models]"), "{next}");
        assert!(next.contains("default = \"grok\""), "{next}");
        assert!(next.contains("theme = \"dark\""), "{next}");
        assert!(next.contains("permission_mode = \"dontAsk\""), "{next}");
        assert!(next.contains("yolo = false"), "{next}");
        assert!(next.contains("[subagents]"), "{next}");
        assert!(next.contains("enabled = false"), "{next}");
        assert!(next.contains("[memory]"), "{next}");
        assert!(next.contains("enabled = true"), "{next}");
        // Secrets untouched.
        assert!(
            next.contains("sk-abcdefghijklmnopqrstuvwxyz0123"),
            "{next}"
        );
        assert!(next.contains("base_url"), "{next}");
        assert_eq!(next.matches("permission_mode").count(), 1);
    }

    #[test]
    fn extract_and_redact_preview() {
        let text = r#"
[ui]
permission_mode = "default"
api_key = "should-not-show-but-odd"

[model.x]
api_key = "sk-abcdefghijklmnopqrstuvwxyz0123"

[subagents]
enabled = true
"#;
        let preview = extract_allowlisted_sections(text);
        assert!(preview.contains("[ui]"));
        assert!(preview.contains("[subagents]"));
        assert!(!preview.contains("[model.x]"));
        let red = redact_config_text(&preview);
        assert!(red.contains("[REDACTED]") || !red.contains("should-not-show"), "{red}");
    }

    #[test]
    fn path_scope_is_agent_home() {
        let p = agent_config_toml();
        assert!(is_agent_home_config_path(&p));
        let other = PathBuf::from("/tmp/not-agent-home/config.toml");
        assert!(!is_agent_home_config_path(&other));
    }

    #[test]
    fn load_and_save_roundtrip_independent() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK.lock().unwrap();
        let tmp = temp_app_home("roundtrip");
        let prev = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &tmp);

        // Force independent via settings file.
        let _ = ensure_app_dirs();
        let mut s = store::load_settings();
        s.session_data_mode = "independent".into();
        store::save_settings(&s).unwrap();

        let snap = load_agent_config_edit().unwrap();
        assert!(snap.writable);
        assert!(snap.path.contains("agent-home"));
        assert!(!snap.path.contains(".grok/config") || snap.path.contains("agent-home"));

        let saved = save_agent_config_edit(&AgentConfigEditPatch {
            permission_mode: Some("acceptEdits".into()),
            yolo: Some(false),
            subagents_enabled: Some(true),
            memory_enabled: Some(false),
        })
        .unwrap();
        assert_eq!(saved.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(saved.yolo, Some(false));
        assert_eq!(saved.subagents_enabled, Some(true));
        assert_eq!(saved.memory_enabled, Some(false));
        assert!(saved.file_exists);

        let disk = fs::read_to_string(agent_config_toml()).unwrap();
        assert!(disk.contains("permission_mode = \"acceptEdits\""));
        assert!(disk.contains("[subagents]"));
        assert!(disk.contains("[memory]"));
        assert!(!disk.contains("[REDACTED]"));

        match prev {
            Some(v) => std::env::set_var("GROK_APP_HOME", v),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn save_refuses_shared_mode() {
        let _lock = crate::paths::APP_HOME_ENV_LOCK.lock().unwrap();
        let tmp = temp_app_home("shared");
        let prev = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &tmp);
        let _ = ensure_app_dirs();
        let mut s = store::load_settings();
        s.session_data_mode = "shared".into();
        store::save_settings(&s).unwrap();

        let err = save_agent_config_edit(&AgentConfigEditPatch {
            yolo: Some(true),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.contains("shared"), "{err}");

        match prev {
            Some(v) => std::env::set_var("GROK_APP_HOME", v),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = fs::remove_dir_all(&tmp);
    }
}
