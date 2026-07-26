//! CLI update check via `grok update --check --json`.
//!
//! ## Install choice
//! When a resolved binary exists, install runs `grok update` so the CLI keeps
//! its channel (stable/alpha) and internal installer. If the binary is missing
//! or `grok update` fails, we fall back to [`crate::cli_install::install_cli_latest`]
//! (multi-mirror + checksum trust chain + progress events) — safer for first-time
//! installs and when self-update is broken.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

use crate::cli_install::{self, CliInstallResult};
use crate::cli_probe;
use crate::process_util;

const CHECK_TIMEOUT: Duration = Duration::from_secs(45);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(600);

/// Parsed `grok update --check --json` payload (camelCase).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_update: Option<bool>,
    /// CLI-reported error string when present (null in healthy responses).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Resolved binary path used for the check (App-side, not from JSON).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_path: Option<String>,
}

/// Parse stdout from `grok update --check --json` into a typed DTO.
/// Tolerant of extra fields; requires current/latest version strings.
pub fn parse_update_check_json(raw: &str) -> Result<CliUpdateCheck, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty update --check output".into());
    }
    // Some builds may print log lines before JSON — take the last JSON object line.
    let json_slice = extract_json_object(trimmed)
        .ok_or_else(|| "update --check output is not JSON".to_string())?;
    let v: Value =
        serde_json::from_str(json_slice).map_err(|e| format!("update --check parse: {e}"))?;
    parse_update_check_value(&v)
}

fn extract_json_object(s: &str) -> Option<&str> {
    let s = s.trim();
    if s.starts_with('{') {
        return Some(s);
    }
    // Walk lines; prefer the last line that looks like a JSON object.
    s.lines()
        .map(str::trim)
        .filter(|l| l.starts_with('{') && l.ends_with('}'))
        .last()
        .or_else(|| {
            let start = s.find('{')?;
            let end = s.rfind('}')?;
            if end >= start {
                Some(&s[start..=end])
            } else {
                None
            }
        })
}

fn parse_update_check_value(v: &Value) -> Result<CliUpdateCheck, String> {
    let current = string_field(v, &["currentVersion", "current_version"])
        .ok_or_else(|| "missing currentVersion".to_string())?;
    let latest = string_field(v, &["latestVersion", "latest_version"])
        .ok_or_else(|| "missing latestVersion".to_string())?;
    let update_available = bool_field(v, &["updateAvailable", "update_available"])
        .unwrap_or_else(|| versions_differ(&current, &latest));
    let channel = string_field(v, &["channel"]);
    let installer = string_field(v, &["installer"]);
    let auto_update = bool_field(v, &["autoUpdate", "auto_update"]);
    let error = string_field(v, &["error"]).filter(|s| !s.is_empty());

    Ok(CliUpdateCheck {
        current_version: current,
        latest_version: latest,
        update_available,
        channel,
        installer,
        auto_update,
        error,
        cli_path: None,
    })
}

fn string_field(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            let t = s.trim();
            if !t.is_empty() && t != "null" {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn bool_field(v: &Value, keys: &[&str]) -> Option<bool> {
    for k in keys {
        if let Some(b) = v.get(*k).and_then(|x| x.as_bool()) {
            return Some(b);
        }
    }
    None
}

fn versions_differ(a: &str, b: &str) -> bool {
    normalize_ver(a) != normalize_ver(b)
}

fn normalize_ver(s: &str) -> String {
    s.trim()
        .trim_start_matches(['v', 'V'])
        .to_ascii_lowercase()
}

/// Resolve CLI binary and run `update --check --json`.
pub fn check_cli_update(manual_path: Option<&str>) -> Result<CliUpdateCheck, String> {
    let probe = cli_probe::probe_cli(manual_path);
    let path = probe
        .path
        .filter(|_| probe.found)
        .ok_or_else(|| {
            "Grok Build CLI not found — install or set the path under Runtime".to_string()
        })?;

    let output =
        run_cli_with_timeout(Path::new(&path), &["update", "--check", "--json"], CHECK_TIMEOUT)?;
    let mut dto = parse_update_check_json(&output)?;
    dto.cli_path = Some(path);
    // Prefer probe version when JSON omits a usable current version.
    if dto.current_version.is_empty() {
        if let Some(v) = probe.version {
            dto.current_version = strip_grok_prefix(&v);
        }
    }
    Ok(dto)
}

fn strip_grok_prefix(v: &str) -> String {
    let t = v.trim();
    // e.g. "grok 0.2.111" / "Grok Build 0.2.111"
    let lower = t.to_ascii_lowercase();
    for prefix in ["grok build ", "grok "] {
        if lower.starts_with(prefix) {
            return t[prefix.len()..].trim().to_string();
        }
    }
    t.to_string()
}

/// Install latest CLI: prefer `grok update`, else App install trust-chain.
pub async fn install_cli_update(app: tauri::AppHandle) -> Result<CliInstallResult, String> {
    let settings = crate::store::load_settings();
    let manual = settings.manual_cli_path.clone();
    let probe = cli_probe::probe_cli(manual.as_deref());

    if probe.found {
        if let Some(path) = probe.path.clone() {
            info!("cli_update_install: running `{path} update`");
            match tauri::async_runtime::spawn_blocking({
                let path = path.clone();
                move || run_cli_with_timeout(Path::new(&path), &["update"], UPDATE_TIMEOUT)
            })
            .await
            {
                Ok(Ok(stdout)) => {
                    // Re-probe after update.
                    let after = cli_probe::probe_cli(manual.as_deref());
                    let version = after.version.or_else(|| extract_version_hint(&stdout));
                    return Ok(CliInstallResult {
                        ok: true,
                        path: after.path.or(Some(path)),
                        version,
                        mirror_used: Some("grok-update".into()),
                        message: "Updated via `grok update`".into(),
                        sha256: None,
                        checksum_verified: None,
                    });
                }
                Ok(Err(e)) => {
                    warn!(
                        "cli_update_install: grok update failed ({e}); falling back to install_cli_latest"
                    );
                }
                Err(e) => {
                    warn!(
                        "cli_update_install: join error ({e}); falling back to install_cli_latest"
                    );
                }
            }
        }
    }

    info!("cli_update_install: using cli_install trust-chain");
    cli_install::install_cli_latest(app).await
}

fn extract_version_hint(stdout: &str) -> Option<String> {
    // Best-effort: look for a semver-looking token after update output.
    for line in stdout.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        for token in l.split_whitespace() {
            let t = token
                .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-');
            if t.chars().filter(|c| *c == '.').count() >= 1
                && t.chars().next().is_some_and(|c| c.is_ascii_digit())
            {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn run_cli_with_timeout(bin: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let bin = bin.to_path_buf();
    let args_owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let args_label = args_owned.join(" ");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = Command::new(&bin);
        cmd.args(&args_owned);
        process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        // `grok update` downloads over the network — honor the proxy (NEW-02).
        crate::proxy::apply_to_std_command(&mut cmd);
        let result = cmd.output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if !output.status.success() {
                let err = stderr.trim();
                let out = stdout.trim();
                // Some failures still emit JSON on stdout (e.g. network error payload).
                if out.starts_with('{') {
                    return Ok(stdout);
                }
                let msg = if !err.is_empty() {
                    err.chars().take(400).collect()
                } else if !out.is_empty() {
                    out.chars().take(400).collect()
                } else {
                    format!("grok {args_label} exited with {}", output.status)
                };
                return Err(msg);
            }
            if stdout.trim().is_empty() && !stderr.trim().is_empty() {
                // Rare: JSON on stderr
                return Ok(stderr);
            }
            Ok(stdout)
        }
        Ok(Err(e)) => Err(format!("failed to run grok {args_label}: {e}")),
        Err(_) => Err(format!(
            "grok {args_label} timed out after {}s",
            timeout.as_secs()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_UP_TO_DATE: &str = r#"{
  "currentVersion": "0.2.111",
  "latestVersion": "0.2.111",
  "updateAvailable": false,
  "installer": "internal",
  "channel": "stable",
  "autoUpdate": true,
  "error": null
}"#;

    const SAMPLE_AVAILABLE: &str = r#"{"currentVersion":"0.2.100","latestVersion":"0.2.111","updateAvailable":true,"installer":"internal","channel":"stable","autoUpdate":true,"error":null}"#;

    #[test]
    fn parse_up_to_date_sample() {
        let d = parse_update_check_json(SAMPLE_UP_TO_DATE).unwrap();
        assert_eq!(d.current_version, "0.2.111");
        assert_eq!(d.latest_version, "0.2.111");
        assert!(!d.update_available);
        assert_eq!(d.channel.as_deref(), Some("stable"));
        assert_eq!(d.installer.as_deref(), Some("internal"));
        assert_eq!(d.auto_update, Some(true));
        assert!(d.error.is_none());
    }

    #[test]
    fn parse_update_available_sample() {
        let d = parse_update_check_json(SAMPLE_AVAILABLE).unwrap();
        assert!(d.update_available);
        assert_eq!(d.current_version, "0.2.100");
        assert_eq!(d.latest_version, "0.2.111");
    }

    #[test]
    fn parse_tolerates_log_prefix() {
        let raw = format!("checking…\n{SAMPLE_AVAILABLE}\n");
        let d = parse_update_check_json(&raw).unwrap();
        assert!(d.update_available);
    }

    #[test]
    fn parse_snake_case_keys() {
        let raw = r#"{"current_version":"1.0.0","latest_version":"1.1.0","update_available":true}"#;
        let d = parse_update_check_json(raw).unwrap();
        assert!(d.update_available);
        assert_eq!(d.latest_version, "1.1.0");
    }

    #[test]
    fn parse_infers_available_when_flag_missing() {
        let raw = r#"{"currentVersion":"1.0.0","latestVersion":"1.0.1"}"#;
        let d = parse_update_check_json(raw).unwrap();
        assert!(d.update_available);
    }

    #[test]
    fn parse_rejects_empty() {
        assert!(parse_update_check_json("  ").is_err());
        assert!(parse_update_check_json("not json").is_err());
    }

    #[test]
    fn extract_json_object_from_mixed() {
        let s = "info: start\n{\"a\":1}\n";
        assert_eq!(extract_json_object(s), Some(r#"{"a":1}"#));
    }
}
