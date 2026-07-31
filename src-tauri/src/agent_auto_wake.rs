//! Auto-wake (CLI config `auto_wake_enabled`) — agent-home config.toml sync.
//!
//! When enabled, Grok Build may inject a synthetic turn after background work
//! completes (bash / monitor / task completion, scheduled loops). Behavior is
//! entirely CLI-side.
//!
//! Config key (top-level, agent-home independent mode):
//! - `auto_wake_enabled` (bool)
//!
//! No dedicated CLI flag. Env `GROK_AUTO_WAKE` is pattern-shaped in the binary
//! (wildcards) — this module does **not** invent 0/1 env overrides.
//! Shared mode never rewrites `~/.grok/config.toml`. Soft-respawn after write
//! so the next agent process reloads config. Older CLIs that ignore the key
//! soft-fail.

use std::fs;

use crate::paths::{agent_config_toml, ensure_app_dirs};

pub const CONFIG_KEY: &str = "auto_wake_enabled";

/// Normalize enable toggle (App default off / opt-in).
pub fn normalize_enabled(raw: bool) -> bool {
    raw
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
        // Root-level assignment.
        let key_part = trimmed.split('=').next().map(str::trim).unwrap_or("");
        if key_part == key {
            lines[i] = line_val;
            return lines.join("\n")
                + if text.ends_with('\n') || text.is_empty() {
                    "\n"
                } else {
                    ""
                };
        }
    }

    // Insert before the first table, or append at end.
    if let Some(idx) = first_table_idx {
        lines.insert(idx, line_val);
        return lines.join("\n") + "\n";
    }

    let base = text.trim_end();
    if base.is_empty() {
        format!("{line_val}\n")
    } else {
        format!("{base}\n{line_val}\n")
    }
}

/// Upsert `auto_wake_enabled` into a TOML-ish text blob.
pub fn set_auto_wake_in_toml(text: &str, enabled: bool) -> String {
    set_top_level_assignment(text, CONFIG_KEY, &enabled.to_string())
}

/// Write the config key into App agent-home (independent GROK_HOME only).
pub fn sync_auto_wake_to_agent_profile(
    session_data_mode: &str,
    enabled: bool,
) -> Result<(), String> {
    if session_data_mode == "shared" {
        // Never rewrite the user's personal ~/.grok/config.toml from the App.
        return Ok(());
    }
    let _ = ensure_app_dirs();
    let path = agent_config_toml();
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let next = set_auto_wake_in_toml(&existing, enabled);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, next).map_err(|e| e.to_string())?;
    tracing::info!(
        "agent_auto_wake: synced {}={} → {}",
        CONFIG_KEY,
        enabled,
        path.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize() {
        assert!(!normalize_enabled(false));
        assert!(normalize_enabled(true));
    }

    #[test]
    fn upserts_top_level_key() {
        let t = set_auto_wake_in_toml("", true);
        assert!(t.contains("auto_wake_enabled = true"));

        let existing = "[ui]\nyolo = false\n\n[subagents]\nenabled = true\n";
        let next = set_auto_wake_in_toml(existing, false);
        assert!(next.contains("auto_wake_enabled = false"));
        let ui_pos = next.find("[ui]").unwrap();
        let key_pos = next.find("auto_wake_enabled").unwrap();
        assert!(key_pos < ui_pos);
        assert!(next.contains("[subagents]"));
        assert!(next.contains("yolo = false"));

        let again = set_auto_wake_in_toml(&next, true);
        assert!(again.contains("auto_wake_enabled = true"));
        assert_eq!(again.matches("auto_wake_enabled").count(), 1);
    }
}
