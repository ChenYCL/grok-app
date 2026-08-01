//! CLI update check via `grok update --check --json`.
//!
//! ## Install choice
//! When a resolved binary exists, install runs `grok update` so the CLI keeps
//! its channel (stable/alpha) and internal installer. If the binary is missing
//! or `grok update` fails, we fall back to [`crate::cli_install::install_cli_latest`]
//! (multi-mirror + checksum trust chain + progress events) — safer for first-time
//! installs and when self-update is broken.
//!
//! ## Channels (CLI ≥ 0.2.117)
//! `grok update --check --json` may report `channel` (`stable` / `alpha`).
//! Switch with `grok update --alpha` / `--stable`; pin with `--version <V>`.
//! App never invents channels — unknown/missing values surface as unknown.

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

/// Known Grok Build CLI release channels from `grok update --check --json`.
/// Do **not** invent extra channels — only map what the CLI documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliReleaseChannel {
    Stable,
    Alpha,
    /// Missing, empty, or unrecognized — UI shows unknown; no switch flag.
    Unknown,
}

impl CliReleaseChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Alpha => "alpha",
            Self::Unknown => "unknown",
        }
    }

    /// CLI flag for channel switch (`--stable` / `--alpha`), if any.
    pub fn switch_flag(self) -> Option<&'static str> {
        match self {
            Self::Stable => Some("--stable"),
            Self::Alpha => Some("--alpha"),
            Self::Unknown => None,
        }
    }
}

/// Parse a channel string from CLI JSON or user input.
/// Only `stable` / `alpha` (case-insensitive) are recognized — never invent.
pub fn parse_cli_channel(raw: Option<&str>) -> CliReleaseChannel {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return CliReleaseChannel::Unknown;
    };
    match s.to_ascii_lowercase().as_str() {
        "stable" => CliReleaseChannel::Stable,
        "alpha" => CliReleaseChannel::Alpha,
        _ => CliReleaseChannel::Unknown,
    }
}

/// Options for `grok update` install / channel switch / version pin.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CliUpdateInstallOpts {
    /// Switch release channel (`stable` / `alpha`). Mutually exclusive with pin.
    pub channel: Option<String>,
    /// Install a specific version (`--version`). Mutually exclusive with channel.
    pub version: Option<String>,
    /// Pass `--force-reinstall` when true.
    pub force: bool,
}

/// Validate version pin text for `--version` (semver-ish; no flags/path tricks).
pub fn is_valid_cli_version_pin(raw: &str) -> bool {
    let t = raw.trim();
    if t.is_empty() || t.len() > 64 {
        return false;
    }
    // Reject anything that looks like a CLI flag or path.
    if t.starts_with('-') || t.contains('/') || t.contains('\\') || t.contains(' ') {
        return false;
    }
    // Require at least one digit and only version-ish chars.
    let mut has_digit = false;
    for c in t.chars() {
        if c.is_ascii_digit() {
            has_digit = true;
            continue;
        }
        if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+' || c == '_' {
            continue;
        }
        return false;
    }
    has_digit
}

/// Build argv after the binary for `grok update …` (without the program name).
/// Pure helper — soft-fails with Err when opts are invalid or invent a channel.
pub fn build_update_args(opts: &CliUpdateInstallOpts) -> Result<Vec<String>, String> {
    let channel_raw = opts
        .channel
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let version_raw = opts
        .version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if channel_raw.is_some() && version_raw.is_some() {
        return Err("channel switch and version pin are mutually exclusive".into());
    }

    let mut args: Vec<String> = vec!["update".into()];

    if let Some(ch) = channel_raw {
        let parsed = parse_cli_channel(Some(ch));
        let flag = parsed.switch_flag().ok_or_else(|| {
            format!("unknown CLI channel `{ch}` — only stable and alpha are supported")
        })?;
        args.push(flag.into());
    } else if let Some(ver) = version_raw {
        if !is_valid_cli_version_pin(ver) {
            return Err(format!("invalid CLI version pin: {ver}"));
        }
        args.push("--version".into());
        args.push(ver.to_string());
    }

    if opts.force {
        args.push("--force-reinstall".into());
    }

    Ok(args)
}

/// Parsed `grok update --check --json` payload (camelCase).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    /// Raw channel from CLI JSON when present (`stable` / `alpha`); never invented.
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
        .rfind(|l| l.starts_with('{') && l.ends_with('}'))
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
    // Keep only recognized channel labels from CLI JSON — never invent.
    let channel = string_field(v, &["channel"]).and_then(|c| match parse_cli_channel(Some(&c)) {
        CliReleaseChannel::Unknown => None,
        known => Some(known.as_str().to_string()),
    });
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
    s.trim().trim_start_matches(['v', 'V']).to_ascii_lowercase()
}

/// Resolve CLI binary and run `update --check --json`.
pub fn check_cli_update(manual_path: Option<&str>) -> Result<CliUpdateCheck, String> {
    let probe = cli_probe::probe_cli(manual_path);
    let path = probe.path.filter(|_| probe.found).ok_or_else(|| {
        "Grok Build CLI not found — install or set the path under Runtime".to_string()
    })?;

    let output = run_cli_with_timeout(
        Path::new(&path),
        &["update", "--check", "--json"],
        CHECK_TIMEOUT,
    )?;
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

/// Install / switch CLI: prefer `grok update` (with optional channel/version),
/// else App install trust-chain for plain latest only.
///
/// Channel switch and version pin never fall back to the App trust-chain
/// (which always pulls stable latest). Soft-fail with Err instead.
pub async fn install_cli_update(
    app: tauri::AppHandle,
    opts: CliUpdateInstallOpts,
) -> Result<CliInstallResult, String> {
    let settings = crate::store::load_settings();
    let manual = settings.manual_cli_path.clone();
    let probe = cli_probe::probe_cli(manual.as_deref());

    let args = build_update_args(&opts)?;
    let specialized = opts.channel.is_some() || opts.version.is_some();
    let args_label = args.join(" ");

    if probe.found {
        if let Some(path) = probe.path.clone() {
            info!("cli_update_install: running `{path} {args_label}`");
            let args_owned = args.clone();
            match tauri::async_runtime::spawn_blocking({
                let path = path.clone();
                move || {
                    let arg_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
                    run_cli_with_timeout(Path::new(&path), &arg_refs, UPDATE_TIMEOUT)
                }
            })
            .await
            {
                Ok(Ok(stdout)) => {
                    // Re-probe after update.
                    let after = cli_probe::probe_cli(manual.as_deref());
                    let version = after
                        .version
                        .map(|v| strip_grok_prefix(&v))
                        .or_else(|| extract_version_hint(&stdout));
                    let message = if let Some(ch) = opts.channel.as_deref() {
                        format!("Switched CLI channel via `grok update --{ch}`")
                    } else if let Some(ver) = opts.version.as_deref() {
                        format!("Installed CLI {ver} via `grok update --version`")
                    } else {
                        "Updated via `grok update`".into()
                    };
                    return Ok(CliInstallResult {
                        ok: true,
                        path: after.path.or(Some(path)),
                        version,
                        mirror_used: Some("grok-update".into()),
                        message,
                        sha256: None,
                        checksum_verified: None,
                    });
                }
                Ok(Err(e)) => {
                    if specialized {
                        // Soft-fail: do not pull stable latest when user asked for channel/version.
                        return Err(format!("grok {args_label} failed: {e}"));
                    }
                    warn!(
                        "cli_update_install: grok update failed ({e}); falling back to install_cli_latest"
                    );
                }
                Err(e) => {
                    if specialized {
                        return Err(format!("grok {args_label} join error: {e}"));
                    }
                    warn!(
                        "cli_update_install: join error ({e}); falling back to install_cli_latest"
                    );
                }
            }
        }
    } else if specialized {
        return Err("Grok Build CLI not found — install or set the path under Runtime".into());
    }

    info!("cli_update_install: using cli_install trust-chain");
    let allow = crate::store::load_settings().allow_unverified_cli_install;
    let result = cli_install::install_cli_latest(app, allow).await?;
    let mut s = crate::store::load_settings();
    s.last_cli_checksum_verified = result.checksum_verified;
    let _ = crate::store::save_settings(&s);
    Ok(result)
}

fn extract_version_hint(stdout: &str) -> Option<String> {
    // Best-effort: look for a semver-looking token after update output.
    for line in stdout.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        for token in l.split_whitespace() {
            let t =
                token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-');
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
        assert_eq!(extract_json_object(s), Some("{\"a\":1}"));
    }

    #[test]
    fn parse_cli_channel_known_and_unknown() {
        assert_eq!(parse_cli_channel(Some("stable")), CliReleaseChannel::Stable);
        assert_eq!(parse_cli_channel(Some("ALPHA")), CliReleaseChannel::Alpha);
        assert_eq!(
            parse_cli_channel(Some("  alpha  ")),
            CliReleaseChannel::Alpha
        );
        assert_eq!(parse_cli_channel(None), CliReleaseChannel::Unknown);
        assert_eq!(parse_cli_channel(Some("")), CliReleaseChannel::Unknown);
        assert_eq!(parse_cli_channel(Some("beta")), CliReleaseChannel::Unknown);
        assert_eq!(
            parse_cli_channel(Some("nightly")),
            CliReleaseChannel::Unknown
        );
    }

    #[test]
    fn parse_drops_unknown_channel_field() {
        let raw = r#"{"currentVersion":"0.2.117","latestVersion":"0.2.117","updateAvailable":false,"channel":"nightly"}"#;
        let d = parse_update_check_json(raw).unwrap();
        assert!(d.channel.is_none());
    }

    #[test]
    fn parse_normalizes_alpha_channel() {
        let raw = r#"{"currentVersion":"0.2.117","latestVersion":"0.2.118-alpha.1","updateAvailable":true,"channel":"Alpha"}"#;
        let d = parse_update_check_json(raw).unwrap();
        assert_eq!(d.channel.as_deref(), Some("alpha"));
    }

    #[test]
    fn build_update_args_plain_and_force() {
        assert_eq!(
            build_update_args(&CliUpdateInstallOpts::default()).unwrap(),
            vec!["update"]
        );
        assert_eq!(
            build_update_args(&CliUpdateInstallOpts {
                force: true,
                ..Default::default()
            })
            .unwrap(),
            vec!["update", "--force-reinstall"]
        );
    }

    #[test]
    fn build_update_args_channel_switch() {
        assert_eq!(
            build_update_args(&CliUpdateInstallOpts {
                channel: Some("alpha".into()),
                ..Default::default()
            })
            .unwrap(),
            vec!["update", "--alpha"]
        );
        assert_eq!(
            build_update_args(&CliUpdateInstallOpts {
                channel: Some("STABLE".into()),
                force: true,
                ..Default::default()
            })
            .unwrap(),
            vec!["update", "--stable", "--force-reinstall"]
        );
        assert!(build_update_args(&CliUpdateInstallOpts {
            channel: Some("beta".into()),
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn build_update_args_version_pin() {
        assert_eq!(
            build_update_args(&CliUpdateInstallOpts {
                version: Some("0.2.117".into()),
                ..Default::default()
            })
            .unwrap(),
            vec!["update", "--version", "0.2.117"]
        );
        assert_eq!(
            build_update_args(&CliUpdateInstallOpts {
                version: Some("0.1.151-alpha.2".into()),
                force: true,
                ..Default::default()
            })
            .unwrap(),
            vec![
                "update",
                "--version",
                "0.1.151-alpha.2",
                "--force-reinstall"
            ]
        );
        assert!(build_update_args(&CliUpdateInstallOpts {
            version: Some("--help".into()),
            ..Default::default()
        })
        .is_err());
        assert!(build_update_args(&CliUpdateInstallOpts {
            version: Some("../etc/passwd".into()),
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn build_update_args_rejects_channel_and_version() {
        assert!(build_update_args(&CliUpdateInstallOpts {
            channel: Some("alpha".into()),
            version: Some("0.2.117".into()),
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn is_valid_cli_version_pin_samples() {
        assert!(is_valid_cli_version_pin("0.2.117"));
        assert!(is_valid_cli_version_pin("0.1.151-alpha.2"));
        assert!(!is_valid_cli_version_pin(""));
        assert!(!is_valid_cli_version_pin("  "));
        assert!(!is_valid_cli_version_pin("-alpha"));
        assert!(!is_valid_cli_version_pin("a b"));
        assert!(!is_valid_cli_version_pin("no-digits"));
    }
}
