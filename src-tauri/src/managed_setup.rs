//! Managed configuration status probe (`grok setup` companion).
//!
//! Surfaces **honest local artifact presence** under GROK_HOME (and system
//! paths when applicable) plus optional `grok inspect` managed-settings flags.
//! Never reads signature *contents* — only file existence.
//! Soft-fails when CLI / inspect is unavailable.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cli_probe;
use crate::paths::resolve_agent_grok_home;
use crate::process_util;
use crate::store;

const INSPECT_TIMEOUT_SECS: u64 = 12;

/// Soft-fail envelope for Settings → Runtime → Managed setup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSetupStatus {
    /// Always true for a completed probe (including soft-fail).
    pub ok: bool,
    pub cli_found: bool,
    /// Active GROK_HOME used for user-level managed files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grok_home: Option<String>,
    pub managed_config_present: bool,
    pub requirements_present: bool,
    /// `managed_config.sig.json` exists (content never loaded).
    pub config_signature_present: bool,
    /// `managed_identity.sig.json` exists (content never loaded).
    pub identity_signature_present: bool,
    /// System managed config (e.g. `/etc/grok/managed_config.toml` on Unix).
    pub system_managed_config_present: bool,
    /// From `grok inspect --json` when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_settings_active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_settings_exists: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_settings_path: Option<String>,
    /// Soft-fail note (inspect skipped / CLI missing, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/// Known managed artifact basenames under a GROK_HOME (or system) dir.
pub const MANAGED_CONFIG_TOML: &str = "managed_config.toml";
pub const REQUIREMENTS_TOML: &str = "requirements.toml";
pub const MANAGED_CONFIG_SIG: &str = "managed_config.sig.json";
pub const MANAGED_IDENTITY_SIG: &str = "managed_identity.sig.json";

/// True when `path` exists and is a regular file (follows symlinks).
pub fn path_is_file(path: &Path) -> bool {
    path.is_file()
}

/// Probe user-level managed artifacts under `grok_home` (existence only).
pub fn probe_user_managed_files(grok_home: &Path) -> (bool, bool, bool, bool) {
    (
        path_is_file(&grok_home.join(MANAGED_CONFIG_TOML)),
        path_is_file(&grok_home.join(REQUIREMENTS_TOML)),
        path_is_file(&grok_home.join(MANAGED_CONFIG_SIG)),
        path_is_file(&grok_home.join(MANAGED_IDENTITY_SIG)),
    )
}

/// System managed config path when the platform has a conventional location.
pub fn system_managed_config_path() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        Some(PathBuf::from("/etc/grok").join(MANAGED_CONFIG_TOML))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// Extract managed-settings flags from a full `grok inspect --json` root.
/// Paths only — never secret bodies.
pub fn extract_managed_settings_from_inspect(
    root: &serde_json::Value,
) -> (Option<bool>, Option<bool>, Option<String>) {
    let perm = root.get("permissions");
    let active = perm
        .and_then(|p| p.get("managedSettingsActive"))
        .and_then(|v| v.as_bool());
    let exists = perm
        .and_then(|p| p.get("managedSettingsExists"))
        .and_then(|v| v.as_bool());
    let path = perm
        .and_then(|p| p.get("managedSettingsPath"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| crate::store::redact_text(s).trim().chars().take(400).collect());
    (active, exists, path)
}

/// Build a status DTO from pure inputs (tests do not need disk / CLI).
pub fn build_managed_setup_status(
    cli_found: bool,
    grok_home: Option<&Path>,
    user_files: (bool, bool, bool, bool),
    system_managed: bool,
    inspect: Option<&serde_json::Value>,
    reason: Option<String>,
) -> ManagedSetupStatus {
    let (cfg, req, cfg_sig, id_sig) = user_files;
    let (active, exists, path) = match inspect {
        Some(v) => extract_managed_settings_from_inspect(v),
        None => (None, None, None),
    };
    ManagedSetupStatus {
        ok: true,
        cli_found,
        grok_home: grok_home.map(|p| p.display().to_string()),
        managed_config_present: cfg,
        requirements_present: req,
        config_signature_present: cfg_sig,
        identity_signature_present: id_sig,
        system_managed_config_present: system_managed,
        managed_settings_active: active,
        managed_settings_exists: exists,
        managed_settings_path: path,
        reason,
    }
}

// ── Host probe ──────────────────────────────────────────────────────────────

fn run_inspect_json_soft(cli_path: &Path) -> Result<serde_json::Value, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let cli = cli_path.to_path_buf();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&cli);
        cmd.args(["inspect", "--json"]);
        process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        let _ = tx.send(cmd.output());
    });
    match rx.recv_timeout(Duration::from_secs(INSPECT_TIMEOUT_SECS)) {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let body = if !stdout.is_empty() {
                stdout
            } else {
                stderr
            };
            if body.is_empty() {
                return Err("inspect returned no output".into());
            }
            serde_json::from_str(&body).map_err(|e| format!("inspect json: {e}"))
        }
        Ok(Err(e)) => Err(format!("inspect spawn: {e}")),
        Err(_) => Err(format!("inspect timed out after {INSPECT_TIMEOUT_SECS}s")),
    }
}

/// Soft-fail status probe used by Settings → Managed setup.
pub fn probe_managed_setup_status() -> ManagedSetupStatus {
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let cli_found = probe.found;
    let grok_home = resolve_agent_grok_home(&settings.session_data_mode);
    let user_files = probe_user_managed_files(&grok_home);
    let system_managed = system_managed_config_path()
        .map(|p| path_is_file(&p))
        .unwrap_or(false);

    let mut reason: Option<String> = None;
    let mut inspect_val: Option<serde_json::Value> = None;

    if let Some(cli_path) = probe.path.filter(|_| probe.found) {
        match run_inspect_json_soft(Path::new(&cli_path)) {
            Ok(v) => inspect_val = Some(v),
            Err(e) => {
                reason = Some(format!("inspect soft-fail: {}", store::redact_text(&e)));
            }
        }
    } else {
        reason = Some("Grok Build CLI not found; local files only".into());
    }

    build_managed_setup_status(
        cli_found,
        Some(&grok_home),
        user_files,
        system_managed,
        inspect_val.as_ref(),
        reason,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("grok-app-managed-setup-{nanos}"));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn probe_user_files_detects_artifacts() {
        let dir = tmp_dir();
        fs::write(dir.join(MANAGED_CONFIG_TOML), "x = 1\n").unwrap();
        fs::write(dir.join(MANAGED_CONFIG_SIG), r#"{"ok":true}"#).unwrap();
        let (cfg, req, cfg_sig, id_sig) = probe_user_managed_files(&dir);
        assert!(cfg);
        assert!(!req);
        assert!(cfg_sig);
        assert!(!id_sig);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_managed_settings_from_inspect_json() {
        let v = serde_json::json!({
            "permissions": {
                "managedSettingsActive": true,
                "managedSettingsExists": false,
                "managedSettingsPath": "/Library/Application Support/ClaudeCode/managed-settings.json"
            }
        });
        let (active, exists, path) = extract_managed_settings_from_inspect(&v);
        assert_eq!(active, Some(true));
        assert_eq!(exists, Some(false));
        assert!(path.unwrap().contains("managed-settings.json"));
    }

    #[test]
    fn build_status_soft_fail_without_inspect() {
        let st = build_managed_setup_status(
            false,
            Some(Path::new("/tmp/fake-grok")),
            (false, false, false, false),
            false,
            None,
            Some("CLI missing".into()),
        );
        assert!(st.ok);
        assert!(!st.cli_found);
        assert_eq!(st.reason.as_deref(), Some("CLI missing"));
        assert!(st.managed_settings_active.is_none());
    }
}
