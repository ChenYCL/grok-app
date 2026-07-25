//! cloudflared quick tunnel lifecycle (DESIGN §9).
//!
//! Spawn in a **process group**, parse public URL from logs, wait for
//! `Registered tunnel connection` before declaring ready. Stop kills the
//! whole group so no orphans hold ports (REQUIREMENT known pitfall).

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::time::timeout;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// How long to wait for URL + registered connection.
const TUNNEL_READY_TIMEOUT: Duration = Duration::from_secs(90);

/// Live tunnel process (own process group on Unix).
pub struct TunnelHandle {
    child: Child,
    /// Process group / leader pid for group kill (Unix).
    pgid: Option<i32>,
    pub public_url: String,
}

impl TunnelHandle {
    pub fn public_url(&self) -> &str {
        &self.public_url
    }

    /// Non-blocking poll: true if cloudflared has exited (ephemeral tunnel died).
    pub fn poll_exited(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(status)) => {
                tracing::warn!(?status, "mirror cloudflared process exited");
                true
            }
            Ok(None) => false,
            Err(e) => {
                tracing::warn!(error = %e, "mirror cloudflared try_wait failed");
                true
            }
        }
    }

    /// Kill the tunnel process group (no orphans).
    pub fn kill_group(mut self) {
        kill_process_group(self.child.id(), self.pgid.take());
        // Best-effort reaping so we don't leave zombies.
        let _ = self.child.start_kill();
        tauri::async_runtime::spawn(async move {
            let _ = self.child.wait().await;
        });
    }
}

/// Result of starting a quick tunnel against a local loopback port.
pub struct TunnelStart {
    pub handle: TunnelHandle,
    pub public_url: String,
}

/// Spawn `cloudflared tunnel --url http://127.0.0.1:<port>`.
///
/// Returns only after logs show a public URL **and**
/// `Registered tunnel connection` (or errors out).
pub async fn start_quick_tunnel(local_port: u16) -> Result<TunnelStart, String> {
    let bin = which::which("cloudflared").map_err(|_| {
        "cloudflared not found on PATH — install cloudflared or set GROK_MIRROR_NO_TUNNEL=1"
            .to_string()
    })?;

    let url_arg = format!("http://127.0.0.1:{local_port}");
    let mut cmd = Command::new(&bin);
    cmd.arg("tunnel")
        .arg("--url")
        .arg(&url_arg)
        .arg("--no-autoupdate")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    // New process group / session so stop can kill descendants.
    #[cfg(unix)]
    {
        // SAFETY: pre_exec runs in child before exec; setsid creates a new session = process group.
        unsafe {
            cmd.pre_exec(|| {
                if libc_setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn cloudflared: {e}"))?;
    let pid = child.id();
    let pgid = pid.map(|p| p as i32);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "cloudflared stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "cloudflared stderr missing".to_string())?;

    let (tx, rx) = oneshot::channel::<Result<(String, bool), String>>();
    tauri::async_runtime::spawn(async move {
        let result = pump_tunnel_logs(stdout, stderr).await;
        let _ = tx.send(result);
    });

    let ready = timeout(TUNNEL_READY_TIMEOUT, rx).await;
    let (public_url, registered) = match ready {
        Ok(Ok(Ok(pair))) => pair,
        Ok(Ok(Err(e))) => {
            kill_process_group(pid, pgid);
            let _ = child.start_kill();
            return Err(e);
        }
        Ok(Err(_)) => {
            kill_process_group(pid, pgid);
            let _ = child.start_kill();
            return Err("cloudflared log pump closed without ready signal".into());
        }
        Err(_) => {
            kill_process_group(pid, pgid);
            let _ = child.start_kill();
            return Err(format!(
                "cloudflared did not become ready within {}s",
                TUNNEL_READY_TIMEOUT.as_secs()
            ));
        }
    };

    if !registered {
        kill_process_group(pid, pgid);
        let _ = child.start_kill();
        return Err(
            "cloudflared printed URL but never 'Registered tunnel connection'".into(),
        );
    }

    let public_url = public_url.trim_end_matches('/').to_string();

    tracing::info!(%public_url, ?pid, "mirror cloudflared tunnel registered");

    Ok(TunnelStart {
        handle: TunnelHandle {
            child,
            pgid,
            public_url: public_url.clone(),
        },
        public_url,
    })
}

/// Read stdout+stderr until we have URL and Registered, or process dies.
async fn pump_tunnel_logs(
    stdout: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    stderr: impl tokio::io::AsyncRead + Unpin + Send + 'static,
) -> Result<(String, bool), String> {
    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let tx_out = line_tx.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_out.send(line);
        }
    });
    let tx_err = line_tx;
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_err.send(line);
        }
    });

    let mut public_url: Option<String> = None;
    let mut registered = false;

    while let Some(line) = line_rx.recv().await {
        tracing::debug!(target: "mirror_tunnel", "{line}");
        if public_url.is_none() {
            if let Some(u) = extract_trycloudflare_url(&line) {
                public_url = Some(u);
            }
        }
        if line.contains("Registered tunnel connection") {
            registered = true;
        }
        if let Some(ref u) = public_url {
            if registered {
                return Ok((u.clone(), true));
            }
        }
    }

    match public_url {
        Some(u) if registered => Ok((u, true)),
        Some(u) => Ok((u, false)),
        None => Err("cloudflared exited before printing a public URL".into()),
    }
}

/// Extract first `https://*.trycloudflare.com` (or similar quick-tunnel host) from a log line.
pub fn extract_trycloudflare_url(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let t = token.trim_matches(|c: char| c == '"' || c == '\'' || c == '|' || c == ',');
        if let Some(rest) = t.strip_prefix("https://") {
            if rest.contains("trycloudflare.com")
                || rest.contains("cfargotunnel.com")
                || rest.ends_with(".cloudflareaccess.com")
            {
                let cleaned = t
                    .trim_end_matches(|c: char| {
                        matches!(c, ')' | ']' | '.' | ',' | ';' | '"' | '\'')
                    })
                    .to_string();
                if cleaned.starts_with("https://") {
                    return Some(cleaned);
                }
            }
        }
    }
    if let Some(start) = line.find("https://") {
        let rest = &line[start..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == '\'')
            .unwrap_or(rest.len());
        let candidate = rest[..end]
            .trim_end_matches(|c: char| matches!(c, ')' | ']' | '.' | ',' | ';' ));
        if candidate.contains("trycloudflare.com") || candidate.contains("cfargotunnel.com") {
            return Some(candidate.to_string());
        }
    }
    None
}

fn kill_process_group(pid: Option<u32>, pgid: Option<i32>) {
    #[cfg(unix)]
    {
        if let Some(g) = pgid.or(pid.map(|p| p as i32)) {
            // Negative pid → kill process group.
            let rc = unsafe { libc_kill(-g, 15) }; // SIGTERM
            if rc != 0 {
                tracing::debug!(pgid = g, "mirror tunnel SIGTERM group failed; trying SIGKILL");
            }
            std::thread::sleep(Duration::from_millis(200));
            let _ = unsafe { libc_kill(-g, 9) };
            return;
        }
    }
    #[cfg(windows)]
    {
        let _ = pgid;
        if let Some(p) = pid {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &p.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            return;
        }
    }
    let _ = (pid, pgid);
}

#[cfg(unix)]
fn libc_setsid() -> i32 {
    extern "C" {
        fn setsid() -> i32;
    }
    unsafe { setsid() }
}

#[cfg(unix)]
fn libc_kill(pid: i32, sig: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid, sig) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_trycloudflare_url() {
        let line = "2024-01-01 INF | https://abc-def.trycloudflare.com |";
        assert_eq!(
            extract_trycloudflare_url(line).as_deref(),
            Some("https://abc-def.trycloudflare.com")
        );
    }

    #[test]
    fn extracts_from_visit_line() {
        let line =
            "Please open the following URL and log in: https://foo-bar-baz.trycloudflare.com";
        assert_eq!(
            extract_trycloudflare_url(line).as_deref(),
            Some("https://foo-bar-baz.trycloudflare.com")
        );
    }

    #[test]
    fn no_url_returns_none() {
        assert!(extract_trycloudflare_url("Registered tunnel connection").is_none());
    }
}
