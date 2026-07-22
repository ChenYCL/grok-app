//! Probe Grok Build CLI on PATH and common locations (B01–B03).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProbeResult {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: String,
    pub candidates_tried: Vec<String>,
    /// CLI auth material present at ~/.grok/auth.json (not App secrets).
    pub cli_auth_present: bool,
}

pub fn cli_auth_json_present() -> bool {
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".grok/auth.json").is_file();
    }
    false
}

fn candidate_paths(manual: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(m) = manual {
        if !m.is_empty() {
            out.push(PathBuf::from(m));
        }
    }
    if let Ok(which) = which::which("grok") {
        out.push(which);
    }
    if let Ok(home) = std::env::var("HOME") {
        out.push(PathBuf::from(&home).join(".grok/bin/grok"));
        out.push(PathBuf::from(&home).join(".local/bin/grok"));
    }
    out.push(PathBuf::from("/usr/local/bin/grok"));
    out.push(PathBuf::from("/opt/homebrew/bin/grok"));
    // dedupe
    let mut seen = std::collections::HashSet::new();
    out.into_iter()
        .filter(|p| seen.insert(p.to_string_lossy().to_string()))
        .collect()
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = path.metadata() {
            return meta.permissions().mode() & 0o111 != 0;
        }
        false
    }
    #[cfg(not(unix))]
    {
        path.extension()
            .map(|e| e == "exe")
            .unwrap_or(true)
            && path.exists()
    }
}

fn read_version(path: &Path) -> Option<String> {
    let out = Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next()?.trim().to_string();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

pub fn probe_cli(manual_path: Option<&str>) -> CliProbeResult {
    let candidates = candidate_paths(manual_path);
    let tried: Vec<String> = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    let cli_auth_present = cli_auth_json_present();

    for (i, path) in candidates.iter().enumerate() {
        if !is_executable(path) {
            continue;
        }
        let version = read_version(path);
        let source = if manual_path.is_some() && i == 0 {
            "manual"
        } else if path.to_string_lossy().contains(".grok/bin") {
            "common_path"
        } else {
            "path"
        };
        return CliProbeResult {
            found: true,
            path: Some(path.display().to_string()),
            version,
            source: source.into(),
            candidates_tried: tried,
            cli_auth_present,
        };
    }

    CliProbeResult {
        found: false,
        path: None,
        version: None,
        source: "not_found".into(),
        candidates_tried: tried,
        cli_auth_present,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_returns_structure() {
        let r = probe_cli(None);
        assert!(!r.candidates_tried.is_empty() || r.found);
        if r.found {
            assert!(r.path.is_some());
            assert!(
                r.version.as_ref().map(|v| v.contains("grok") || !v.is_empty()).unwrap_or(true)
            );
        }
    }

    #[test]
    fn probe_finds_local_grok_when_installed() {
        let r = probe_cli(None);
        // This developer machine has grok; keep soft if CI lacks it.
        if which::which("grok").is_ok()
            || std::path::Path::new(&format!(
                "{}/.grok/bin/grok",
                std::env::var("HOME").unwrap_or_default()
            ))
            .exists()
        {
            assert!(r.found, "expected local grok, tried {:?}", r.candidates_tried);
            assert!(r.path.is_some());
        }
    }
}
