//! Unified write layer for App agent-home `config.toml`.
//!
//! Independent session-data mode (`GROK_HOME` = App agent-home) may write
//! allowlisted keys. Shared mode always refuses path resolve / strict write so
//! the App never rewrites the user's personal `~/.grok/config.toml`.
//!
//! Pure TOML helpers are line-oriented upserts (no full parse) so unrelated
//! sections and secrets stay intact.

#![allow(dead_code)] // residual-clippy: generic toml get/set helpers
use std::fs;
use std::path::PathBuf;

use crate::paths::{agent_config_toml, ensure_app_dirs};

/// Normalize session_data_mode to `independent` | `shared`.
pub fn normalize_mode(session_data_mode: &str) -> &'static str {
    if session_data_mode.trim().eq_ignore_ascii_case("shared") {
        "shared"
    } else {
        "independent"
    }
}

/// Error message when shared mode refuses a write-path resolve.
pub const SHARED_MODE_REFUSED: &str =
    "shared session mode: agent-home config.toml writes refused (never rewrite ~/.grok)";

/// Resolve App agent-home `config.toml` for writes.
///
/// - independent → `…/agent-home/config.toml` (ensures app dirs)
/// - shared → `Err` (refuse; do not return `~/.grok/config.toml`)
pub fn resolve_writable_config_path(session_data_mode: &str) -> Result<PathBuf, String> {
    if normalize_mode(session_data_mode) == "shared" {
        return Err(SHARED_MODE_REFUSED.into());
    }
    let _ = ensure_app_dirs();
    Ok(agent_config_toml())
}

fn bool_lit(v: bool) -> &'static str {
    if v {
        "true"
    } else {
        "false"
    }
}

fn finish_join(original: &str, lines: &[String]) -> String {
    let mut joined = lines.join("\n");
    if (original.ends_with('\n') || original.is_empty()) && !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

fn finish_join_always_nl(_original: &str, lines: &[String]) -> String {
    let mut joined = lines.join("\n");
    if !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// Upsert a bare top-level `key = value` assignment (not inside a `[table]`).
pub fn set_top_level_assignment(text: &str, key: &str, value: &str) -> String {
    let line_val = format!("{key} = {value}");
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    let mut in_table = false;
    let mut first_table_idx: Option<usize> = None;

    for i in 0..lines.len() {
        let trimmed = lines[i].trim().to_string();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if first_table_idx.is_none() {
                first_table_idx = Some(i);
            }
            in_table = true;
            continue;
        }
        if in_table {
            continue;
        }
        let key_part = trimmed.split('=').next().map(str::trim).unwrap_or("");
        if key_part == key {
            lines[i] = line_val;
            return finish_join(text, &lines);
        }
    }

    if let Some(idx) = first_table_idx {
        lines.insert(idx, line_val);
        return finish_join_always_nl(text, &lines);
    }

    let base = text.trim_end();
    if base.is_empty() {
        format!("{line_val}\n")
    } else {
        format!("{base}\n{line_val}\n")
    }
}

/// Upsert top-level `key = true|false`.
pub fn set_top_level_bool(text: &str, key: &str, value: bool) -> String {
    set_top_level_assignment(text, key, bool_lit(value))
}

/// Upsert top-level `key = "value"` (quoted string).
pub fn set_top_level_string(text: &str, key: &str, value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    set_top_level_assignment(text, key, &format!("\"{escaped}\""))
}

/// Upsert `key = value` under `[table]` without touching other sections/keys.
pub fn set_table_key(text: &str, table: &str, key: &str, value: &str, quoted: bool) -> String {
    let header = format!("[{table}]");
    let line_val = if quoted {
        format!(
            "{key} = \"{}\"",
            value.replace('\\', "\\\\").replace('"', "\\\"")
        )
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
                return finish_join_always_nl(text, &lines);
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
        return finish_join_always_nl(text, &lines);
    }
    let block = format!("\n{header}\n{line_val}\n");
    let base = text.trim_end();
    if base.is_empty() {
        format!("{header}\n{line_val}\n")
    } else {
        format!("{base}{block}")
    }
}

/// Upsert `[table] key = true|false`.
pub fn set_table_bool(text: &str, table: &str, key: &str, value: bool) -> String {
    set_table_key(text, table, key, bool_lit(value), false)
}

/// Pin App agent-home so Grok does **not** merge Claude/Cursor MCP catalogs.
///
/// Without this, `~/.claude.json` mcpServers (Playwright, open-websearch, …)
/// are imported by default and stall first-tool discovery for ~30s.
pub fn ensure_compat_mcp_disabled(text: &str) -> String {
    let t = set_table_bool(text, "compat.claude", "mcps", false);
    set_table_bool(&t, "compat.cursor", "mcps", false)
}

/// Write `[compat.claude/cursor] mcps = false` into independent agent-home.
pub fn apply_compat_mcp_disabled(session_data_mode: &str) -> Result<(), String> {
    update_config_toml_if_independent(session_data_mode, ensure_compat_mcp_disabled).map(|_| ())
}

/// Upsert `[table] key = "value"`.
pub fn set_table_string(text: &str, table: &str, key: &str, value: &str) -> String {
    set_table_key(text, table, key, value, true)
}

/// Parse a TOML bool literal (`true` / `false`).
pub fn parse_toml_bool(raw: &str) -> Option<bool> {
    match raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_ascii_lowercase()
        .as_str()
    {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Parse a TOML string / bare value (strip surrounding quotes; drop inline `#`).
pub fn parse_toml_scalar(raw: &str) -> String {
    let s = raw.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        return s[1..s.len() - 1].to_string();
    }
    s.split('#').next().unwrap_or(s).trim().to_string()
}

fn value_for_key_in_scope<'a>(text: &'a str, table: Option<&str>, key: &str) -> Option<&'a str> {
    let mut current = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current = trimmed
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string();
            continue;
        }
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        let k = trimmed[..eq].trim();
        if k != key {
            continue;
        }
        let in_scope = match table {
            None => current.is_empty(),
            Some(t) => current == t,
        };
        if in_scope {
            return Some(trimmed[eq + 1..].trim());
        }
    }
    None
}

/// Read top-level bool when present.
pub fn get_top_level_bool(text: &str, key: &str) -> Option<bool> {
    value_for_key_in_scope(text, None, key).and_then(parse_toml_bool)
}

/// Read `[table].key` bool when present.
pub fn get_table_bool(text: &str, table: &str, key: &str) -> Option<bool> {
    value_for_key_in_scope(text, Some(table), key).and_then(parse_toml_bool)
}

/// Read top-level string / scalar when present.
pub fn get_top_level_string(text: &str, key: &str) -> Option<String> {
    value_for_key_in_scope(text, None, key)
        .map(parse_toml_scalar)
        .filter(|s| !s.is_empty())
}

/// Read `[table].key` string / scalar when present.
pub fn get_table_string(text: &str, table: &str, key: &str) -> Option<String> {
    value_for_key_in_scope(text, Some(table), key)
        .map(parse_toml_scalar)
        .filter(|s| !s.is_empty())
}

/// Strict write: read → transform → write agent-home config.toml.
/// Shared mode → `Err` via [`resolve_writable_config_path`].
pub fn update_config_toml(
    session_data_mode: &str,
    transform: impl FnOnce(&str) -> String,
) -> Result<PathBuf, String> {
    let path = resolve_writable_config_path(session_data_mode)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create agent-home: {e}"))?;
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let next = transform(&existing);
    fs::write(&path, next).map_err(|e| format!("write config: {e}"))?;
    Ok(path)
}

/// Soft-skip shared: `Ok(None)` without touching disk.
/// Independent: apply transform and return `Ok(Some(path))`.
///
/// Prefer this for AppSettings sync helpers that keep the toggle in App state
/// when session mode is shared.
pub fn update_config_toml_if_independent(
    session_data_mode: &str,
    transform: impl FnOnce(&str) -> String,
) -> Result<Option<PathBuf>, String> {
    if normalize_mode(session_data_mode) == "shared" {
        return Ok(None);
    }
    update_config_toml(session_data_mode, transform).map(Some)
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
            "grok-agent-home-cfg-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn refuse_shared_path_resolve() {
        let err = resolve_writable_config_path("shared").unwrap_err();
        assert!(err.contains("shared"), "{err}");
        assert!(err.contains("refused") || err.contains("~/.grok"), "{err}");
        // Case-insensitive.
        assert!(resolve_writable_config_path("SHARED").is_err());
    }

    #[test]
    fn set_and_get_top_level_bool() {
        let t = set_top_level_bool("", "auto_wake_enabled", true);
        assert!(t.contains("auto_wake_enabled = true"));
        assert_eq!(get_top_level_bool(&t, "auto_wake_enabled"), Some(true));

        let existing = "[ui]\nyolo = false\n\n[subagents]\nenabled = true\n";
        let next = set_top_level_bool(existing, "workflows_enabled", false);
        assert_eq!(get_top_level_bool(&next, "workflows_enabled"), Some(false));
        let ui_pos = next.find("[ui]").unwrap();
        let key_pos = next.find("workflows_enabled").unwrap();
        assert!(key_pos < ui_pos);
        assert!(next.contains("yolo = false"));

        let again = set_top_level_bool(&next, "workflows_enabled", true);
        assert_eq!(get_top_level_bool(&again, "workflows_enabled"), Some(true));
        assert_eq!(again.matches("workflows_enabled").count(), 1);
    }

    #[test]
    fn ensure_compat_mcp_disabled_sets_both() {
        let t = ensure_compat_mcp_disabled("");
        assert_eq!(get_table_bool(&t, "compat.claude", "mcps"), Some(false));
        assert_eq!(get_table_bool(&t, "compat.cursor", "mcps"), Some(false));
        let again = ensure_compat_mcp_disabled(&t);
        assert_eq!(get_table_bool(&again, "compat.claude", "mcps"), Some(false));
    }

    fn set_and_get_table_bool_and_string() {
        let t = set_table_bool("", "memory", "enabled", true);
        assert!(t.contains("[memory]"));
        assert!(t.contains("enabled = true"));
        assert_eq!(get_table_bool(&t, "memory", "enabled"), Some(true));

        let t2 = set_table_string(&t, "ui", "permission_mode", "acceptEdits");
        assert_eq!(
            get_table_string(&t2, "ui", "permission_mode").as_deref(),
            Some("acceptEdits")
        );
        assert_eq!(get_table_bool(&t2, "memory", "enabled"), Some(true));

        let t3 = set_table_bool(&t2, "memory", "enabled", false);
        assert_eq!(get_table_bool(&t3, "memory", "enabled"), Some(false));
        assert_eq!(t3.matches("enabled =").count(), 1);
    }

    #[test]
    fn top_level_string_roundtrip() {
        let t = set_top_level_string("", "note", "plain");
        assert!(t.contains("note = \"plain\""));
        assert_eq!(get_top_level_string(&t, "note").as_deref(), Some("plain"));
    }

    #[test]
    fn shared_soft_skip_and_independent_write() {
        let _guard = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = temp_app_home("write");
        std::env::set_var("GROK_APP_HOME", &home);

        assert_eq!(
            update_config_toml_if_independent("shared", |t| set_top_level_bool(
                t,
                "auto_wake_enabled",
                true
            ))
            .unwrap(),
            None
        );
        // Strict refuse.
        assert!(update_config_toml("shared", |t| t.to_string()).is_err());

        let path = update_config_toml_if_independent("independent", |t| {
            set_top_level_bool(t, "auto_wake_enabled", true)
        })
        .unwrap()
        .expect("path");
        assert!(path.ends_with("config.toml"));
        let disk = fs::read_to_string(&path).unwrap();
        assert_eq!(get_top_level_bool(&disk, "auto_wake_enabled"), Some(true));

        std::env::remove_var("GROK_APP_HOME");
        let _ = fs::remove_dir_all(&home);
    }
}
