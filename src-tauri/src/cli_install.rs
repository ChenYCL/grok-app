//! Install / update Grok Build CLI with multi-mirror download fallback.
//!
//! Mirrors mirror the official installer (`https://x.ai/cli/install.sh`):
//! 1. Cloudflare-fronted `https://x.ai/cli`
//! 2. Direct GCS `https://storage.googleapis.com/grok-build-public-artifacts/cli`
//!
//! Each mirror is retried a few times before falling through. Progress is emitted
//! on `setup://cli-install-progress` for the setup wizard UI.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

use crate::cli_probe;
use crate::process_util::{self, user_home};

/// Official artifact bases (order = preference). Keep in sync with xAI install.sh.
const MIRROR_BASES: &[&str] = &[
    "https://x.ai/cli",
    "https://storage.googleapis.com/grok-build-public-artifacts/cli",
];

const CHANNEL: &str = "stable";
const MIRROR_ATTEMPTS: u32 = 2;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallProgress {
    pub phase: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mirror: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallResult {
    pub ok: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub mirror_used: Option<String>,
    pub message: String,
}

fn emit(app: &AppHandle, p: CliInstallProgress) {
    let _ = app.emit("setup://cli-install-progress", &p);
}

fn platform_triple() -> Result<(&'static str, &'static str), String> {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("Unsupported OS for Grok Build auto-install".into());
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        return Err("Unsupported CPU architecture for Grok Build auto-install".into());
    };
    Ok((os, arch))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(format!("GrokApp/{}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())
}

fn mirror_host(base: &str) -> String {
    base.trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or(base)
        .to_string()
}

async fn fetch_version_text(client: &reqwest::Client, base: &str) -> Result<String, String> {
    let url = format!("{}/{CHANNEL}", base.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("version probe {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("version probe {url}: HTTP {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let version = text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(|c: char| c.is_whitespace() || c == '\r')
        .to_string();
    if version.is_empty()
        || !version
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
    {
        return Err(format!("invalid version pointer from {url}: {text:?}"));
    }
    Ok(version)
}

async fn resolve_version(
    app: &AppHandle,
    client: &reqwest::Client,
) -> Result<(String, String), String> {
    emit(
        app,
        CliInstallProgress {
            phase: "resolving".into(),
            message: "Resolving latest Grok Build version…".into(),
            percent: Some(0.0),
            bytes_downloaded: None,
            total_bytes: None,
            mirror: None,
            version: None,
        },
    );

    let mut errors = Vec::new();
    for base in MIRROR_BASES {
        for attempt in 1..=MIRROR_ATTEMPTS {
            emit(
                app,
                CliInstallProgress {
                    phase: "resolving".into(),
                    message: format!(
                        "Trying {} (attempt {attempt}/{MIRROR_ATTEMPTS})…",
                        mirror_host(base)
                    ),
                    percent: Some(2.0),
                    bytes_downloaded: None,
                    total_bytes: None,
                    mirror: Some((*base).into()),
                    version: None,
                },
            );
            match fetch_version_text(client, base).await {
                Ok(v) => {
                    info!("cli_install: version {v} via {base}");
                    return Ok((v, (*base).to_string()));
                }
                Err(e) => {
                    warn!("cli_install version fail base={base} attempt={attempt}: {e}");
                    errors.push(e);
                    if attempt < MIRROR_ATTEMPTS {
                        tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
                    }
                }
            }
        }
    }
    Err(format!(
        "Could not resolve Grok Build version from any mirror. {}",
        errors.last().cloned().unwrap_or_default()
    ))
}

async fn download_to_file(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    version: &str,
    mirror: &str,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download {url}: HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let mut stream = resp.bytes_stream();
    let mut file = fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut downloaded: u64 = 0;
    let mut last_emit = 0u64;

    emit(
        app,
        CliInstallProgress {
            phase: "downloading".into(),
            message: format!("Downloading from {}…", mirror_host(mirror)),
            percent: Some(5.0),
            bytes_downloaded: Some(0),
            total_bytes: total,
            mirror: Some(mirror.into()),
            version: Some(version.into()),
        },
    );

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download stream: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("write download: {e}"))?;
        downloaded += chunk.len() as u64;
        // Throttle UI events (~every 256 KiB or completion).
        if downloaded.saturating_sub(last_emit) >= 256 * 1024 || total == Some(downloaded) {
            last_emit = downloaded;
            let percent = match total {
                Some(t) if t > 0 => 5.0 + (downloaded as f64 / t as f64) * 85.0,
                _ => 5.0 + (downloaded as f64 / (120.0 * 1024.0 * 1024.0)).min(1.0) * 85.0,
            };
            emit(
                app,
                CliInstallProgress {
                    phase: "downloading".into(),
                    message: format!(
                        "Downloading… {}",
                        format_bytes_pair(downloaded, total)
                    ),
                    percent: Some(percent.min(90.0)),
                    bytes_downloaded: Some(downloaded),
                    total_bytes: total,
                    mirror: Some(mirror.into()),
                    version: Some(version.into()),
                },
            );
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    if downloaded == 0 {
        let _ = fs::remove_file(dest);
        return Err("download produced empty file".into());
    }
    if let Some(t) = total {
        if downloaded != t {
            let _ = fs::remove_file(dest);
            return Err(format!("download size mismatch: got {downloaded}, expected {t}"));
        }
    }
    Ok(())
}

fn format_bytes_pair(done: u64, total: Option<u64>) -> String {
    match total {
        Some(t) => format!("{} / {}", format_bytes(done), format_bytes(t)),
        None => format_bytes(done),
    }
}

fn format_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let f = n as f64;
    if f >= MB {
        format!("{:.1} MB", f / MB)
    } else if f >= KB {
        format!("{:.0} KB", f / KB)
    } else {
        format!("{n} B")
    }
}

fn verify_binary(path: &Path) -> Result<String, String> {
    if !process_util::looks_runnable(path) {
        return Err(format!("not a runnable file: {}", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = fs::metadata(path).map_err(|e| e.to_string())?;
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
    }
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--version");
    process_util::apply_no_window_std(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run downloaded binary: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "downloaded binary --version failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if line.is_empty() {
        Err("downloaded binary returned empty --version".into())
    } else {
        Ok(line)
    }
}

fn link_install(download_path: &Path, version: &str) -> Result<PathBuf, String> {
    let home = user_home();
    let download_dir = home.join(".grok").join("downloads");
    let bin_dir = home.join(".grok").join("bin");
    fs::create_dir_all(&download_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

    let (os, arch) = platform_triple()?;
    let platform = format!("{os}-{arch}");

    #[cfg(target_os = "windows")]
    let final_name = format!("grok-{version}-{platform}.exe");
    #[cfg(not(target_os = "windows"))]
    let final_name = format!("grok-{version}-{platform}");

    let final_download = download_dir.join(&final_name);
    if final_download != *download_path {
        let _ = fs::remove_file(&final_download);
        if fs::rename(download_path, &final_download).is_err() {
            fs::copy(download_path, &final_download)
                .map_err(|e| format!("place binary: {e}"))?;
            let _ = fs::remove_file(download_path);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let grok_exe = bin_dir.join("grok.exe");
        let agent_exe = bin_dir.join("agent.exe");
        for target in [&grok_exe, &agent_exe] {
            let old = PathBuf::from(format!("{}.old", target.display()));
            let _ = fs::remove_file(&old);
            if fs::copy(&final_download, target).is_err() {
                // Locked by running process — rename aside then retry
                let _ = fs::rename(target, &old);
                if let Err(e2) = fs::copy(&final_download, target) {
                    let _ = fs::rename(&old, target);
                    return Err(format!("install {}: {e2}", target.display()));
                }
            }
        }
        return Ok(grok_exe);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let link_target = if download_dir.parent() == bin_dir.parent() {
            PathBuf::from(format!("../downloads/{}", final_name))
        } else {
            final_download.clone()
        };
        let grok_link = bin_dir.join("grok");
        let agent_link = bin_dir.join("agent");
        // Remove existing file/symlink then recreate
        let _ = fs::remove_file(&grok_link);
        let _ = fs::remove_file(&agent_link);
        std::os::unix::fs::symlink(&link_target, &grok_link)
            .map_err(|e| format!("symlink grok: {e}"))?;
        std::os::unix::fs::symlink(&link_target, &agent_link)
            .map_err(|e| format!("symlink agent: {e}"))?;
        Ok(grok_link)
    }
}

async fn try_download_all_mirrors(
    app: &AppHandle,
    client: &reqwest::Client,
    version: &str,
    preferred_mirror: &str,
) -> Result<(PathBuf, String), String> {
    let (os, arch) = platform_triple()?;
    let platform = format!("{os}-{arch}");
    let mut bases: Vec<&str> = Vec::new();
    // Preferred first, then others
    bases.push(preferred_mirror);
    for b in MIRROR_BASES {
        if *b != preferred_mirror {
            bases.push(*b);
        }
    }

    let tmp_dir = user_home().join(".grok").join("downloads");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let tmp_path = tmp_dir.join(format!(
        "grok-{}-{}-{}.part",
        version,
        platform,
        std::process::id()
    ));

    let mut errors = Vec::new();
    for base in bases {
        let artifact = format!(
            "{}/grok-{version}-{platform}{}",
            base.trim_end_matches('/'),
            if cfg!(target_os = "windows") {
                ".exe"
            } else {
                ""
            }
        );
        // Windows also tries extension-less fallback like install.sh
        let candidates: Vec<String> = if cfg!(target_os = "windows") {
            vec![
                artifact.clone(),
                format!(
                    "{}/grok-{version}-{platform}",
                    base.trim_end_matches('/')
                ),
            ]
        } else {
            vec![artifact]
        };

        for attempt in 1..=MIRROR_ATTEMPTS {
            for url in &candidates {
                emit(
                    app,
                    CliInstallProgress {
                        phase: "downloading".into(),
                        message: format!(
                            "Mirror {} · attempt {attempt}/{MIRROR_ATTEMPTS}",
                            mirror_host(base)
                        ),
                        percent: Some(5.0),
                        bytes_downloaded: Some(0),
                        total_bytes: None,
                        mirror: Some(base.into()),
                        version: Some(version.into()),
                    },
                );
                let _ = fs::remove_file(&tmp_path);
                match download_to_file(app, client, url, &tmp_path, version, base).await {
                    Ok(()) => return Ok((tmp_path, base.to_string())),
                    Err(e) => {
                        warn!("cli_install download fail url={url}: {e}");
                        errors.push(e);
                        let _ = fs::remove_file(&tmp_path);
                    }
                }
            }
            if attempt < MIRROR_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
            }
        }
    }
    Err(format!(
        "All mirrors failed. Last error: {}",
        errors.last().cloned().unwrap_or_else(|| "unknown".into())
    ))
}

/// Download latest stable Grok Build and install into `~/.grok`.
pub async fn install_cli_latest(app: AppHandle) -> Result<CliInstallResult, String> {
    let client = http_client()?;
    let (version, preferred) = resolve_version(&app, &client).await?;

    emit(
        &app,
        CliInstallProgress {
            phase: "downloading".into(),
            message: format!("Found Grok Build v{version}"),
            percent: Some(4.0),
            bytes_downloaded: None,
            total_bytes: None,
            mirror: Some(preferred.clone()),
            version: Some(version.clone()),
        },
    );

    let (tmp_path, mirror_used) =
        try_download_all_mirrors(&app, &client, &version, &preferred).await?;

    emit(
        &app,
        CliInstallProgress {
            phase: "verifying".into(),
            message: "Verifying binary…".into(),
            percent: Some(92.0),
            bytes_downloaded: None,
            total_bytes: None,
            mirror: Some(mirror_used.clone()),
            version: Some(version.clone()),
        },
    );

    let ver_line = match verify_binary(&tmp_path) {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            return Err(e);
        }
    };

    emit(
        &app,
        CliInstallProgress {
            phase: "linking".into(),
            message: "Installing to ~/.grok/bin…".into(),
            percent: Some(96.0),
            bytes_downloaded: None,
            total_bytes: None,
            mirror: Some(mirror_used.clone()),
            version: Some(version.clone()),
        },
    );

    let linked = link_install(&tmp_path, &version)?;
    let probe = cli_probe::probe_cli(Some(linked.to_string_lossy().as_ref()));
    let path = probe
        .path
        .or_else(|| Some(linked.display().to_string()));
    let version_out = probe.version.or(Some(ver_line));

    emit(
        &app,
        CliInstallProgress {
            phase: "done".into(),
            message: format!(
                "Installed {}",
                version_out.as_deref().unwrap_or(&version)
            ),
            percent: Some(100.0),
            bytes_downloaded: None,
            total_bytes: None,
            mirror: Some(mirror_used.clone()),
            version: version_out.clone(),
        },
    );

    Ok(CliInstallResult {
        ok: true,
        path,
        version: version_out,
        mirror_used: Some(mirror_used),
        message: "Grok Build installed".into(),
    })
}

/// Install command strings for copy-paste fallback (platform-specific).
pub fn install_commands() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        serde_json::json!({
            "primary": "irm https://x.ai/cli/install.ps1 | iex",
            "shell": "powershell",
            "docsUrl": "https://docs.x.ai/build/overview",
            "mirrors": MIRROR_BASES,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        serde_json::json!({
            "primary": "curl -fsSL https://x.ai/cli/install.sh | bash",
            "shell": "bash",
            "docsUrl": "https://docs.x.ai/build/overview",
            "mirrors": MIRROR_BASES,
        })
    }
}
