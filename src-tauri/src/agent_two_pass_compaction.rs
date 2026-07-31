//! Two-pass / prefire compaction (CLI 0.2.117+) — config + env sync.
//!
//! Config key (top-level, agent-home independent mode):
//! - `two_pass_compaction_enabled` (bool)
//!
//! Env: `GROK_TWO_PASS_COMPACTION=0|1`
//!
//! No dedicated CLI flag. Shared mode never rewrites `~/.grok/config.toml`.
//! Soft-fail older CLIs: omit env when version is known &lt; 0.2.117.

use std::fs;

use crate::paths::{agent_config_toml, ensure_app_dirs};

/// First CLI that accepts the config / env surface.
pub const TWO_PASS_COMPACTION_MIN_CLI: (u64, u64, u64) = (0, 2, 117);

pub const CONFIG_KEY: &str = "two_pass_compaction_enabled";
pub const ENV_KEY: &str = "GROK_TWO_PASS_COMPACTION";

/// Normalize enable toggle (App default off).
pub fn normalize_enabled(raw: bool) -> bool {
    raw
}

/// Env value for the agent process.
pub fn spawn_env_value(enabled: bool) -> &'static str {
    if enabled {
        "1"
    } else {
        "0"
    }
}

/// `Some(true)` when CLI ≥ 0.2.117; `Some(false)` when older; `None` unparseable.
pub fn cli_supports_two_pass_compaction(raw_version: &str) -> Option<bool> {
    let token = crate::cli_probe::extract_version_token(raw_version)?;
    let parsed = crate::app_update::parse_semver(&token)?;
    Some(parsed >= TWO_PASS_COMPACTION_MIN_CLI)
}

/// Soft-fail: whether to apply the env override for this CLI version.
///
/// - Known ≥ 0.2.117 → apply
/// - Known older → omit
/// - Unknown / missing → apply (forward-compatible; env is ignored if unused)
pub fn should_apply_env(raw_cli_version: Option<&str>) -> bool {
    match raw_cli_version {
        Some(v) => cli_supports_two_pass_compaction(v) != Some(false),
        None => true,
    }
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

/// Upsert `two_pass_compaction_enabled` into a TOML-ish text blob.
pub fn set_two_pass_compaction_in_toml(text: &str, enabled: bool) -> String {
    set_top_level_assignment(text, CONFIG_KEY, &enabled.to_string())
}

/// Write the config key into App agent-home (independent GROK_HOME only).
pub fn sync_two_pass_compaction_to_agent_profile(
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
    let next = set_two_pass_compaction_in_toml(&existing, enabled);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, next).map_err(|e| e.to_string())?;
    tracing::info!(
        "agent_two_pass_compaction: synced {}={} → {}",
        CONFIG_KEY,
        enabled,
        path.display()
    );
    Ok(())
}

/// Apply env on a tokio Command (soft-gated by CLI version when provided).
pub fn apply_two_pass_compaction_to_command(
    cmd: &mut tokio::process::Command,
    enabled: bool,
    raw_cli_version: Option<&str>,
) {
    if !should_apply_env(raw_cli_version) {
        return;
    }
    cmd.env(ENV_KEY, spawn_env_value(enabled));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_and_env() {
        assert!(!normalize_enabled(false));
        assert!(normalize_enabled(true));
        assert_eq!(spawn_env_value(true), "1");
        assert_eq!(spawn_env_value(false), "0");
    }

    #[test]
    fn version_gate() {
        assert_eq!(
            cli_supports_two_pass_compaction("0.2.117"),
            Some(true)
        );
        assert_eq!(
            cli_supports_two_pass_compaction("grok 0.2.117 (f1c06093089f)"),
            Some(true)
        );
        assert_eq!(cli_supports_two_pass_compaction("0.2.116"), Some(false));
        assert_eq!(cli_supports_two_pass_compaction("0.2.100"), Some(false));
        assert_eq!(cli_supports_two_pass_compaction("nope"), None);
        assert!(should_apply_env(Some("0.2.117")));
        assert!(!should_apply_env(Some("0.2.112")));
        assert!(should_apply_env(None));
        assert!(should_apply_env(Some("garbage")));
    }

    #[test]
    fn upserts_top_level_key() {
        let t = set_two_pass_compaction_in_toml("", true);
        assert!(t.contains("two_pass_compaction_enabled = true"));

        let existing = "[ui]\nyolo = false\n\n[subagents]\nenabled = true\n";
        let next = set_two_pass_compaction_in_toml(existing, false);
        assert!(next.contains("two_pass_compaction_enabled = false"));
        let ui_pos = next.find("[ui]").unwrap();
        let key_pos = next.find("two_pass_compaction_enabled").unwrap();
        assert!(key_pos < ui_pos);
        assert!(next.contains("[subagents]"));
        assert!(next.contains("yolo = false"));

        let again = set_two_pass_compaction_in_toml(&next, true);
        assert!(again.contains("two_pass_compaction_enabled = true"));
        assert_eq!(
            again.matches("two_pass_compaction_enabled").count(),
            1
        );
    }

    #[test]
    fn shared_mode_skips_write() {
        assert!(sync_two_pass_compaction_to_agent_profile("shared", true).is_ok());
    }
}
