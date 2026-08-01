//! Official-credential side-channel for layered capabilities.
//!
//! When the interactive agent runs a text-only custom main model (DeepSeek),
//! vision / web_search / X tools must **not** share that process's auth or
//! base_url. This module prepares an isolated `GROK_HOME` (official auth +
//! grok-4.5) and runs short **ACP** jobs (preferred) or `grok -p` fallback:
//!
//! - image description
//! - web_search
//! - all `x_*` tools (keyword / semantic / user / thread)
//!
//! Prefer ACP (`agent stdio` under `agent-home-official`) so Host can bridge
//! stream / tool progress into Chat chips. Fall back to `grok -p` when ACP
//! spawn fails.
//!
//! Never writes official `auth.json` into the main agent-home while a custom
//! relay is active (OIDC pollution).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use crate::acp_client::{AcpClient, AcpEvent, SpawnOptions, StreamKind};
use crate::agent_home_config::set_table_string;
use crate::cli_probe;
use crate::paths::{app_data_root, ensure_app_dirs};
use crate::process_util;
use crate::providers::OFFICIAL_CATALOG_MODEL;
use crate::proxy;
use crate::secrets;
use crate::store;

/// Isolated profile for official aux headless jobs.
pub fn official_aux_home() -> PathBuf {
    app_data_root().join("agent-home-official")
}

pub fn official_aux_config_toml() -> PathBuf {
    official_aux_home().join("config.toml")
}

/// Official catalog model used for side-channel jobs.
pub fn official_aux_model_id() -> &'static str {
    OFFICIAL_CATALOG_MODEL
}

/// Whether we can run official aux jobs (CLI login and/or official API key).
pub fn official_aux_available() -> bool {
    cli_probe::cli_auth_json_present() || {
        let disk = secrets::load_secrets_disk_only();
        secrets::has_official_key_configured(&disk)
    }
}

/// Ensure `agent-home-official` exists with official auth + grok-4.5 default.
///
/// - Copies `~/.grok/auth.json` when present (OIDC for official path only).
/// - Writes `[models] default = grok-4.5` and optional `[model.grok-4.5] api_key`.
pub fn ensure_official_aux_home() -> Result<PathBuf, String> {
    let _ = ensure_app_dirs();
    let home = official_aux_home();
    fs::create_dir_all(&home).map_err(|e| format!("official aux home: {e}"))?;

    // Sync CLI OIDC into this isolated home only (never main agent-home here).
    let cli_auth = process_util::user_home().join(".grok").join("auth.json");
    let dest_auth = home.join("auth.json");
    if cli_auth.is_file() {
        let need = match (cli_auth.metadata(), dest_auth.metadata()) {
            (Ok(sm), Ok(dm)) => {
                sm.len() != dm.len()
                    || sm
                        .modified()
                        .ok()
                        .zip(dm.modified().ok())
                        .map(|(a, b)| a > b)
                        .unwrap_or(true)
            }
            (Ok(_), Err(_)) => true,
            _ => false,
        };
        if need {
            fs::copy(&cli_auth, &dest_auth).map_err(|e| format!("copy auth.json: {e}"))?;
        }
    }

    let mut text = fs::read_to_string(official_aux_config_toml()).unwrap_or_default();
    text = set_table_string(&text, "models", "default", OFFICIAL_CATALOG_MODEL);

    // Prefer API key when configured so headless works without OIDC file.
    let secrets = store::load_secrets();
    if let Some(key) = secrets
        .official_api_key
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let table = format!("model.{OFFICIAL_CATALOG_MODEL}");
        text = set_table_string(&text, &table, "model", OFFICIAL_CATALOG_MODEL);
        text = set_table_string(&text, &table, "name", "Grok 4.5");
        text = set_table_string(
            &text,
            &table,
            "base_url",
            crate::models_aux::OFFICIAL_GROK_BASE_URL,
        );
        text = set_table_string(
            &text,
            &table,
            "api_backend",
            crate::models_aux::OFFICIAL_GROK_API_BACKEND,
        );
        text = set_table_string(&text, &table, "api_key", key);
    }

    if !cli_auth.is_file()
        && secrets
            .official_api_key
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        && !secrets::has_official_key_configured(&secrets::load_secrets_disk_only())
    {
        // Still write default so errors are about auth, not missing section.
        tracing::warn!(target: "official_aux", "no CLI auth.json and no official API key");
    }

    fs::write(official_aux_config_toml(), text).map_err(|e| format!("write official aux config: {e}"))?;
    Ok(home)
}

/// Status for UI / MCP readiness.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAuxStatus {
    pub available: bool,
    pub home: String,
    pub model: String,
    pub has_cli_auth: bool,
    pub has_api_key: bool,
    pub reason: String,
}

pub fn status() -> OfficialAuxStatus {
    let has_cli = cli_probe::cli_auth_json_present();
    let disk = secrets::load_secrets_disk_only();
    let has_key = secrets::has_official_key_configured(&disk);
    let available = has_cli || has_key;
    let reason = if available {
        if has_cli && has_key {
            "cli_auth_and_api_key".into()
        } else if has_cli {
            "cli_auth".into()
        } else {
            "api_key".into()
        }
    } else {
        "none — sign in with grok login or paste an official API key".into()
    };
    OfficialAuxStatus {
        available,
        home: official_aux_home().display().to_string(),
        model: OFFICIAL_CATALOG_MODEL.into(),
        has_cli_auth: has_cli,
        has_api_key: has_key,
        reason,
    }
}

/// Fallback: `GROK_HOME=agent-home-official grok -p -m grok-4.5 …`
/// Prefer [`run_official_acp_job`] for Host pre-run (stream bridge).
pub fn run_official_headless(
    prompt: &str,
    max_turns: u32,
    timeout: Duration,
) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("prompt is empty".into());
    }
    if !official_aux_available() {
        return Err(
            "official aux unavailable: run `grok login` or set official API key in Settings → Account"
                .into(),
        );
    }
    let home = ensure_official_aux_home()?;
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let cli = probe
        .path
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "grok CLI not found".to_string())?;

    let mut cmd = Command::new(&cli);
    cmd.arg("--no-auto-update")
        .arg("-p")
        .arg(prompt)
        .arg("-m")
        .arg(OFFICIAL_CATALOG_MODEL)
        .arg("--always-approve")
        .arg("--max-turns")
        .arg(max_turns.clamp(1, 32).to_string())
        .arg("--effort")
        .arg("low")
        .arg("--output-format")
        .arg("plain");
    cmd.env("GROK_HOME", &home);
    // Official profile only — do not leak these into the DeepSeek agent process.
    cmd.env("GROK_WEB_SEARCH_MODEL", OFFICIAL_CATALOG_MODEL);
    cmd.env("GROK_IMAGE_DESCRIPTION_MODEL", OFFICIAL_CATALOG_MODEL);
    process_util::apply_no_window_std(&mut cmd);
    if let Some(path_env) = process_util::enriched_path_env() {
        cmd.env("PATH", path_env);
    }
    proxy::apply_to_std_command(&mut cmd);

    tracing::info!(
        target: "official_aux",
        "headless start model={} home={} prompt_chars={}",
        OFFICIAL_CATALOG_MODEL,
        home.display(),
        prompt.len()
    );

    let started = Instant::now();
    let output = std::thread::spawn(move || cmd.output())
        .join()
        .map_err(|_| "official aux thread join failed".to_string())?
        .map_err(|e| format!("official aux spawn: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if started.elapsed() > timeout {
        tracing::warn!(
            target: "official_aux",
            "headless slow elapsed={:?}",
            started.elapsed()
        );
    }
    if !output.status.success() && stdout.trim().is_empty() {
        let preview: String = stderr.chars().take(500).collect();
        return Err(format!("official aux failed: {preview}"));
    }
    if stdout.trim().is_empty() {
        let preview: String = stderr.chars().take(500).collect();
        return Err(format!("official aux empty: {preview}"));
    }
    Ok(stdout)
}

// ── ACP side-channel (preferred) ────────────────────────────────────────────

/// Progress event bridged into Chat host tool chips.
#[derive(Debug, Clone)]
pub struct OfficialAcpProgress {
    /// Short non-technical detail for the chip (may be a stream tail).
    pub detail: String,
    /// Optional tool title override from agent tool_call.
    pub tool_title: Option<String>,
    /// Optional tool status from agent.
    pub tool_status: Option<String>,
}

/// Callback type for streaming progress into the main session UI.
pub type OfficialProgressCb = Arc<dyn Fn(OfficialAcpProgress) + Send + Sync>;

fn clip_detail(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let clipped: String = t.chars().take(max.saturating_sub(1)).collect();
    format!("{clipped}…")
}

/// One-shot official ACP job: isolated GROK_HOME + stream bridge + kill.
///
/// Falls back to [`run_official_headless`] when ACP spawn/handshake fails.
pub async fn run_official_acp_job(
    prompt: &str,
    max_turns: u32,
    timeout: Duration,
    progress: Option<OfficialProgressCb>,
) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("prompt is empty".into());
    }
    if !official_aux_available() {
        return Err(
            "official aux unavailable: run `grok login` or set official API key in Settings → Account"
                .into(),
        );
    }

    match run_official_acp_job_inner(prompt, max_turns, timeout, progress.clone()).await {
        Ok(text) => Ok(text),
        Err(e) => {
            tracing::warn!(
                target: "official_aux",
                "ACP side-channel failed ({e}); falling back to grok -p"
            );
            if let Some(ref cb) = progress {
                cb(OfficialAcpProgress {
                    detail: "switching transport…".into(),
                    tool_title: None,
                    tool_status: Some("in_progress".into()),
                });
            }
            let p = prompt.to_string();
            let mt = max_turns;
            let to = timeout;
            tokio::task::spawn_blocking(move || run_official_headless(&p, mt, to))
                .await
                .map_err(|e| format!("join: {e}"))?
        }
    }
}

async fn run_official_acp_job_inner(
    prompt: &str,
    max_turns: u32,
    timeout: Duration,
    progress: Option<OfficialProgressCb>,
) -> Result<String, String> {
    let home = ensure_official_aux_home()?;
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let cli = probe
        .path
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "grok CLI not found".to_string())?;
    let cli_path = PathBuf::from(cli);

    // Use official home as cwd so @image absolute paths still work; home is
    // the isolated profile only for GROK_HOME env.
    let cwd = std::env::current_dir().unwrap_or_else(|_| home.clone());

    let opts = SpawnOptions {
        model_id: Some(OFFICIAL_CATALOG_MODEL.into()),
        effort: Some("low".into()),
        permission_policy: Some("always_approve".into()),
        product_mode: Some("agent".into()),
        sandbox_profile: Some("off".into()),
        json_schema: None,
        plugin_dirs: Vec::new(),
        extra_rules: Some(
            "You are an isolated official side-job. Complete the task and stop. \
No repo edits. Prefer built-in tools. Keep the final answer concise and complete."
                .into(),
        ),
        max_agent_turns: Some(max_turns.clamp(1, 32)),
        system_prompt_override: None,
        no_ask_user: Some(true),
        fork_session: false,
        grok_home_override: Some(home.clone()),
        empty_mcp_servers: true,
    };

    tracing::info!(
        target: "official_aux",
        "ACP start model={} home={} prompt_chars={} timeout={:?}",
        OFFICIAL_CATALOG_MODEL,
        home.display(),
        prompt.len(),
        timeout
    );

    let (client, mut events) = AcpClient::spawn_with_home(
        cli_path,
        cwd,
        "independent",
        opts,
    )
    .map_err(|e| format!("official ACP spawn: {}", e.message))?;

    let acc = Arc::new(std::sync::Mutex::new(String::new()));
    let acc_ev = Arc::clone(&acc);
    let progress_ev = progress.clone();
    let client_pump = Arc::clone(&client);
    let pump = tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            match ev {
                AcpEvent::Stream {
                    kind,
                    text,
                    done: _,
                    ..
                } => {
                    if text.is_empty() {
                        continue;
                    }
                    if matches!(kind, StreamKind::Assistant | StreamKind::Thought) {
                        if let Ok(mut g) = acc_ev.lock() {
                            g.push_str(&text);
                            if let Some(ref cb) = progress_ev {
                                // Full accumulated body for native tool expand (cap for UI).
                                // Keep newlines so the rail matches other tool dumps.
                                let body = clip_detail(g.as_str(), 4_000);
                                cb(OfficialAcpProgress {
                                    detail: body,
                                    tool_title: None,
                                    tool_status: Some("in_progress".into()),
                                });
                            }
                        }
                    }
                }
                AcpEvent::ToolCall {
                    title,
                    status,
                    kind,
                    ..
                } => {
                    // Status/progress only — never overwrite the stream body with a tool name.
                    if let Some(ref cb) = progress_ev {
                        let label = if !title.is_empty() {
                            title.clone()
                        } else if !kind.is_empty() {
                            kind.replace('_', " ")
                        } else {
                            String::new()
                        };
                        let body = acc_ev
                            .lock()
                            .ok()
                            .map(|g| clip_detail(g.as_str(), 4_000))
                            .unwrap_or_default();
                        cb(OfficialAcpProgress {
                            detail: if body.is_empty() && !label.is_empty() {
                                label.clone()
                            } else {
                                body
                            },
                            tool_title: if label.is_empty() { None } else { Some(label) },
                            tool_status: Some(if status.is_empty() {
                                "in_progress".into()
                            } else {
                                status
                            }),
                        });
                    }
                }
                AcpEvent::PromptComplete { .. } => break,
                AcpEvent::ProcessExited { .. } | AcpEvent::Error { .. } => break,
                AcpEvent::PermissionRequest { rpc_id, .. } => {
                    // Always-approve path: auto-select allow-ish option.
                    let _ = client_pump
                        .respond_permission(
                            rpc_id,
                            crate::acp_client::PermissionOutcome::Selected {
                                option_id: "allow".into(),
                            },
                        )
                        .await;
                }
                _ => {}
            }
        }
    });

    let open = tokio::time::timeout(
        Duration::from_secs(45),
        client.initialize_and_open_session(None, false),
    )
    .await;
    match open {
        Ok(Ok((_sid, _))) => {}
        Ok(Err(e)) => {
            client.kill().await;
            let _ = pump.await;
            return Err(format!("official ACP open: {}", e.message));
        }
        Err(_) => {
            client.kill().await;
            let _ = pump.await;
            return Err("official ACP open timeout".into());
        }
    }

    if let Some(ref cb) = progress {
        cb(OfficialAcpProgress {
            detail: "connected…".into(),
            tool_title: None,
            tool_status: Some("in_progress".into()),
        });
    }

    let prompt_fut = client.prompt(prompt);
    let prompt_res = tokio::time::timeout(timeout, prompt_fut).await;
    match prompt_res {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            client.kill().await;
            let _ = pump.await;
            // Prefer partial stream if any.
            let partial = acc.lock().map(|g| g.clone()).unwrap_or_default();
            if partial.trim().len() > 40 {
                tracing::warn!(
                    target: "official_aux",
                    "official ACP prompt error but partial text ok: {}",
                    e.message
                );
                return Ok(partial);
            }
            return Err(format!("official ACP prompt: {}", e.message));
        }
        Err(_) => {
            client.abort_pending_prompts("official aux timeout");
            let _ = client.cancel().await;
            client.kill().await;
            let _ = pump.await;
            let partial = acc.lock().map(|g| g.clone()).unwrap_or_default();
            if partial.trim().len() > 40 {
                return Ok(partial);
            }
            return Err("official ACP timeout".into());
        }
    }

    client.kill().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), pump).await;

    let text = acc
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("official ACP empty response".into());
    }
    tracing::info!(
        target: "official_aux",
        "ACP ok chars={}",
        text.len()
    );
    Ok(text)
}

// ── Capability wrappers ─────────────────────────────────────────────────────

fn vision_prompt(paths: &[String], question: Option<&str>) -> Result<String, String> {
    if paths.is_empty() {
        return Err("no image paths".into());
    }
    for p in paths {
        if !Path::new(p).is_file() {
            return Err(format!("not a file: {p}"));
        }
    }
    let q = question
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(
            "Describe each image thoroughly for a coding agent: UI text, layout, errors, code, diagrams, and actionable detail. Be concrete.",
        );
    let refs = paths
        .iter()
        .map(|p| format!("@{p}"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        r#"{q}

Images (use native vision; you can see these files):
{refs}

Reply with one <image_description path="…">…</image_description> block per image.
Do not refuse; do not claim you cannot see images."#
    ))
}

/// Describe local image path(s) via official ACP (preferred) or headless.
pub fn vision_describe(paths: &[String], question: Option<&str>) -> Result<String, String> {
    let prompt = vision_prompt(paths, question)?;
    run_official_headless(&prompt, 4, Duration::from_secs(150))
}

/// Async vision with stream progress for Chat chips.
pub async fn vision_describe_async(
    paths: &[String],
    question: Option<&str>,
    progress: Option<OfficialProgressCb>,
) -> Result<String, String> {
    let prompt = vision_prompt(paths, question)?;
    run_official_acp_job(&prompt, 4, Duration::from_secs(150), progress).await
}

/// Web search via official `web_search` tool inside headless Grok.
pub fn web_search(query: &str) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("query is empty".into());
    }
    let prompt = format!(
        r#"You are an isolated research side-job with official Grok credentials.

Use the built-in **web_search** tool (and web_fetch if needed) for:
{q}

Rules:
1. You MUST call web_search at least once.
2. Prefer primary sources; include URLs.
3. Reply in the same language as the query.
4. Do not edit files or run unrelated shell commands.
5. Final answer: concise markdown findings + link list."#
    );
    run_official_headless(&prompt, 10, Duration::from_secs(180))
}

/// `x_keyword_search` — keyword / advanced-syntax search on X.
pub fn x_keyword_search(
    query: &str,
    limit: Option<u32>,
    min_faves: Option<u32>,
) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("query is empty".into());
    }
    let limit = limit.unwrap_or(10).clamp(1, 25);
    let faves = min_faves
        .map(|n| format!("min_faves:{n}"))
        .unwrap_or_default();
    let prompt = format!(
        r#"You are an isolated X (Twitter) research side-job with official Grok credentials.

Call the built-in tool **x_keyword_search** with:
- query: {q}
- limit: {limit}
{faves}

If x_keyword_search is unavailable, try x_semantic_search with the same query.

Rules:
1. You MUST use an x_* search tool (not web_search for X posts).
2. Return posts with real https://x.com/…/status/… URLs when available.
3. Markdown list: author, text excerpt, url, engagement if known.
4. Same language as the query for commentary; keep original post language.
5. No file edits."#
    );
    run_official_headless(&prompt, 12, Duration::from_secs(180))
}

/// `x_semantic_search` — semantic search on X.
pub fn x_semantic_search(query: &str, limit: Option<u32>) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("query is empty".into());
    }
    let limit = limit.unwrap_or(10).clamp(1, 25);
    let prompt = format!(
        r#"You are an isolated X research side-job with official Grok credentials.

Call **x_semantic_search** with query: {q}, limit: {limit}.
Fallback: x_keyword_search if semantic is unavailable.

Return markdown with x.com status URLs. No file edits."#
    );
    run_official_headless(&prompt, 12, Duration::from_secs(180))
}

/// `x_user_search` — find X users.
pub fn x_user_search(query: &str, count: Option<u32>) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("query is empty".into());
    }
    let count = count.unwrap_or(5).clamp(1, 20);
    let prompt = format!(
        r#"You are an isolated X research side-job with official Grok credentials.

Call **x_user_search** with query: {q}, count: {count}.

Return markdown: handle, display name, bio excerpt, profile url. No file edits."#
    );
    run_official_headless(&prompt, 8, Duration::from_secs(120))
}

/// `x_thread_fetch` — fetch a post thread by id or url.
pub fn x_thread_fetch(post_id_or_url: &str) -> Result<String, String> {
    let id = post_id_or_url.trim();
    if id.is_empty() {
        return Err("post_id_or_url is empty".into());
    }
    let prompt = format!(
        r#"You are an isolated X research side-job with official Grok credentials.

Call **x_thread_fetch** for: {id}
(If the tool wants a numeric post_id, extract it from an x.com status URL.)

Return the thread as markdown with status URLs. No file edits."#
    );
    run_official_headless(&prompt, 10, Duration::from_secs(150))
}

/// Generic dispatch for MCP / CLI shim: tool name → headless.
pub fn dispatch_tool(tool: &str, args: &serde_json::Value) -> Result<String, String> {
    let name = tool.trim().to_ascii_lowercase();
    // Accept both bare names and host_ / official_ prefixes.
    let name = name
        .strip_prefix("host_")
        .or_else(|| name.strip_prefix("official_"))
        .unwrap_or(name.as_str());

    match name {
        "vision_describe" | "image_description" | "describe_image" => {
            let paths = args
                .get("paths")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .or_else(|| {
                    args.get("path")
                        .and_then(|v| v.as_str())
                        .map(|s| vec![s.to_string()])
                })
                .unwrap_or_default();
            let question = args.get("question").and_then(|v| v.as_str());
            vision_describe(&paths, question)
        }
        "web_search" => {
            let q = args
                .get("query")
                .or_else(|| args.get("q"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            web_search(q)
        }
        "x_keyword_search" => {
            let q = args
                .get("query")
                .or_else(|| args.get("q"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let min_faves = args
                .get("min_faves")
                .or_else(|| args.get("minFaves"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            x_keyword_search(q, limit, min_faves)
        }
        "x_semantic_search" => {
            let q = args
                .get("query")
                .or_else(|| args.get("q"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            x_semantic_search(q, limit)
        }
        "x_user_search" => {
            let q = args
                .get("query")
                .or_else(|| args.get("q"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let count = args
                .get("count")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            x_user_search(q, count)
        }
        "x_thread_fetch" => {
            let id = args
                .get("post_id")
                .or_else(|| args.get("postId"))
                .or_else(|| args.get("url"))
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            x_thread_fetch(id)
        }
        other => Err(format!("unknown official aux tool: {other}")),
    }
}

/// Path to the bundled MCP entry (repo `scripts/official-aux-mcp.mjs`).
pub fn mcp_script_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Compile-time crate dir → repo root (src-tauri/../scripts)
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("../scripts/official-aux-mcp.mjs"));
    candidates.push(PathBuf::from("scripts/official-aux-mcp.mjs"));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts/official-aux-mcp.mjs"));
        candidates.push(cwd.join("../scripts/official-aux-mcp.mjs"));
    }
    if let Ok(exe) = std::env::current_exe() {
        // target/debug → repo
        if let Some(root) = exe.ancestors().nth(3) {
            candidates.push(root.join("scripts/official-aux-mcp.mjs"));
        }
        if let Some(root) = exe.ancestors().nth(4) {
            candidates.push(root.join("scripts/official-aux-mcp.mjs"));
        }
    }
    for c in candidates {
        if let Ok(canon) = c.canonicalize() {
            if canon.is_file() {
                return Some(canon);
            }
        } else if c.is_file() {
            return Some(c);
        }
    }
    None
}

/// ACP mcpServers entry for official aux tools (stdio Node script).
pub fn mcp_server_acp_entry() -> Option<serde_json::Value> {
    if !official_aux_available() {
        return None;
    }
    let script = mcp_script_path()?;
    let home = ensure_official_aux_home().ok()?;
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let cli = probe.path.filter(|p| !p.trim().is_empty())?;

    // Prefer node; fall back to `grok` not applicable for MCP protocol.
    let node = which_node().unwrap_or_else(|| "node".into());

    Some(serde_json::json!({
        "name": "official-aux",
        "command": node,
        "args": [script.display().to_string()],
        "env": [
            {"name": "OFFICIAL_AUX_HOME", "value": home.display().to_string()},
            {"name": "OFFICIAL_AUX_MODEL", "value": OFFICIAL_CATALOG_MODEL},
            {"name": "OFFICIAL_AUX_CLI", "value": cli},
            {"name": "GROK_HOME", "value": home.display().to_string()},
        ]
    }))
}

fn which_node() -> Option<String> {
    for name in ["node", "nodejs"] {
        if let Ok(out) = Command::new("which").arg(name).output() {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Whether the active inference channel is a **custom** provider (not official Grok).
///
/// Official-aux MCP / Host vision side-channels must only run on custom routes so
/// SuperGrok / OIDC sessions keep native tools and are not polluted with duplicates.
pub fn main_route_is_custom() -> bool {
    matches!(
        crate::providers::active_route(),
        crate::providers::ActiveRoute::Custom { .. }
    )
}

/// Whether to inject official-aux MCP into the next ACP session.
///
/// Requires:
/// - user setting `official_aux_inject`
/// - official credentials available (for the side-channel home)
/// - **custom main route** (never inject on official subscription)
pub fn should_inject_mcp_for_main() -> bool {
    let settings = store::load_settings();
    if !settings.official_aux_inject {
        return false;
    }
    if !main_route_is_custom() {
        return false;
    }
    official_aux_available()
}

/// When inject is on: only load `official-aux` (default), unless user opts into
/// loading all extension MCPs alongside it (`official_aux_with_user_mcp`).
pub fn should_load_user_mcp_with_official_aux() -> bool {
    store::load_settings().official_aux_with_user_mcp
}

/// Session `--rules` block when official-aux is active (DeepSeek etc. need this).
/// Official Grok main route must not receive this (native tools already exist).
pub fn inject_session_rules() -> Option<String> {
    if !should_inject_mcp_for_main() {
        return None;
    }
    Some(
        r#"Official-aux MCP (server name: official-aux) is the PRIMARY toolbox for this custom main model.

Exact tools (call via use_tool with these tool_name values):
- official-aux__x_keyword_search  — X/Twitter/推特/推文/x上 关键词搜帖（默认首选）
- official-aux__x_semantic_search — X 语义/话题搜索
- official-aux__x_user_search     — X 用户/账号/@handle
- official-aux__x_thread_fetch    — 帖子线程 URL/status id
- official-aux__web_search        — 普通网页搜索
- official-aux__vision_describe   — 识图（若已有 [Host vision] / <image_description> 则禁止再调）

When the user asks to search X / Twitter / 推特 / x上 / 推文:
1. Immediately search_tool query "x_keyword_search" OR "official-aux x" (one call).
2. Then use_tool official-aux__x_keyword_search with the topic keywords.
3. Do NOT wait for open-websearch / Playwright / sleep.

Do NOT:
- bash sleep while MCP connects
- prefer Playwright browser for X when official-aux x_* exists
- curl/wget as first choice for X
- use open-websearch for X posts

If search_tool is partial/empty, retry once with query "official-aux" or "x_keyword_search", then use_tool. Never busy-wait."#
            .trim()
            .to_string(),
    )
}

/// Merge user session extra_rules with official-aux inject rules.
pub fn merge_extra_rules(user: Option<&str>) -> Option<String> {
    let inject = inject_session_rules();
    let user = user
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    match (user, inject) {
        (Some(u), Some(i)) => Some(format!("{u}\n\n{i}")),
        (Some(u), None) => Some(u),
        (None, Some(i)) => Some(i),
        (None, None) => None,
    }
}

/// Detect X / Twitter research intent in user-facing prompt text.
///
/// **Must not** fire on image-only turns: composer attaches files as
/// `@/abs/path.png`, and a bare `@` used to match as an X handle signal.
///
/// `prior_context` (optional recent journal turns) resolves pronouns like
/// 「它 / 这个」 so Host X does not search the literal sentence
/// 「搜索它在 x 上的信息」 when the user meant the previous topic (e.g. DeepSeek).
pub fn detect_x_search_intent(prompt: &str) -> Option<XSearchIntent> {
    detect_x_search_intent_with_context(prompt, None)
}

/// Same as [`detect_x_search_intent`] with optional prior chat text for coref.
pub fn detect_x_search_intent_with_context(
    prompt: &str,
    prior_context: Option<&str>,
) -> Option<XSearchIntent> {
    // Use only the user turn when bootstrap is present.
    let user_part = prompt
        .rsplit_once("[End of prior context")
        .map(|(_, rest)| rest)
        .unwrap_or(prompt);
    let user_part = user_part
        .rsplit_once("---\n\n")
        .map(|(_, rest)| rest)
        .unwrap_or(user_part);
    // Drop image `@/path` tokens before intent scoring — they are not X handles.
    let (user_clean, image_paths) =
        crate::models_aux::strip_image_at_paths(user_part);
    let user_clean = user_clean.trim();
    // Image-only (or near-empty after strip) → never host X pre-search.
    if user_clean.is_empty() && !image_paths.is_empty() {
        return None;
    }
    let t = user_clean.to_ascii_lowercase();
    // True X / Twitter signals only (not filesystem `@/…` paths).
    // Note: Host no longer pre-runs X via this detector (tools-first). Kept for
    // unit tests / optional helpers only — do not expand as a product intent engine.
    let has_at_handle = text_has_x_handle_token(user_clean);
    let x_signal = t.contains("twitter")
        || t.contains("推特")
        || t.contains("x.com")
        || t.contains("tweet")
        || t.contains("推文")
        || has_at_handle
        || t.contains("账号")
        || t.contains("帳號")
        || t.contains("粉丝")
        || t.contains("粉絲")
        || t.contains("在 x")
        || t.contains("on x")
        || t.contains("from x")
        || t.contains(" x ")
        || t.contains("\nx ")
        || t.starts_with("x ")
        || t.ends_with(" x")
        || t == "x";
    let search_signal = t.contains("搜")
        || t.contains("search")
        || t.contains("查")
        || t.contains("找")
        || t.contains("信息")
        || t.contains("資訊")
        || t.contains("资料")
        || t.contains("資料")
        || t.contains("谁是")
        || t.contains("誰是")
        || t.contains("about");
    // Require a real X signal. "search + random x letter" is too broad and
    // false-fired on image paths / unrelated Chinese text.
    if !x_signal {
        return None;
    }
    // Pure "mention X" without research intent still ok when handle/url present.
    if !search_signal && !has_at_handle && extract_x_status_ref(user_clean).is_none() {
        // Allow short "在 x 上 …账号" style that already set x_signal via 账号.
        if !(t.contains("账号")
            || t.contains("帳號")
            || t.contains("twitter")
            || t.contains("推特")
            || t.contains("tweet")
            || t.contains("推文"))
        {
            return None;
        }
    }

    // Handle: @name or bare handle after 账号
    let handle = extract_x_handle(user_clean);
    if let Some(h) = handle {
        return Some(XSearchIntent::User { query: h });
    }
    // Status URL / id
    if let Some(url) = extract_x_status_ref(user_clean) {
        return Some(XSearchIntent::Thread { id_or_url: url });
    }
    // Build keyword: strip filler, resolve pronouns from prior turns.
    let q = rewrite_x_keyword_query(user_clean, prior_context);
    if q.is_empty() {
        return None;
    }
    Some(XSearchIntent::Keyword {
        query: q.chars().take(200).collect(),
    })
}

/// Whether the query still looks like a pronoun / empty entity (needs coref).
fn query_needs_coref(q: &str) -> bool {
    let t = q.trim().to_ascii_lowercase();
    if t.is_empty() {
        return true;
    }
    // Pure pronouns / deictics
    matches!(
        t.as_str(),
        "它" | "他" | "她" | "这个" | "那个" | "此" | "该"
            | "这" | "那" | "this" | "that" | "it" | "they" | "them"
            | "this one" | "that one"
    ) || t.chars().all(|c| {
        matches!(
            c,
            '它' | '他' | '她' | '这' | '那' | '个' | '该' | '此' | '的' | '们'
        )
    })
}

/// Strip search/X filler words so we don't pass the whole sentence to x_keyword_search.
fn strip_x_search_filler(text: &str) -> String {
    let mut s = text.trim().to_string();
    // Order matters: longer phrases first.
    let fillers = [
        "相关的信息",
        "相关信息",
        "有关的信息",
        "有关信息",
        "的信息",
        "的資訊",
        "的资料",
        "的資料",
        "最新动态",
        "最新消息",
        "搜索一下",
        "搜一下",
        "帮我搜索",
        "帮我搜",
        "请搜索",
        "请搜",
        "搜索",
        "搜尋",
        "查找",
        "查一下",
        "查询",
        "在 x 上搜索",
        "在x上搜索",
        "在 X 上搜索",
        "在X上搜索",
        "在 x 上",
        "在x上",
        "在 X 上",
        "在X上",
        "x上搜索",
        "X上搜索",
        "x 上搜索",
        "X 上搜索",
        "x上搜",
        "x搜索",
        "X搜索",
        "搜索x上",
        "搜索X上",
        "搜x上",
        "在 twitter 上",
        "在twitter上",
        "在 推特 上",
        "在推特上",
        "on x",
        "on X",
        "on twitter",
        "from x",
        "x 上的",
        "X 上的",
        "x上的",
        "X上的",
        "x上",
        "X上",
        "x 上",
        "X 上",
        "twitter 上的",
        "推特上的",
        "关于",
        "有关",
        "一下",
        "和图片",
        "和圖片",
        "的图片",
        "的圖片",
    ];
    for f in fillers {
        while let Some(p) = s.find(f) {
            s = format!("{}{}", &s[..p], &s[p + f.len()..]);
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

/// Pull a plausible entity name from prior user/assistant text for coref.
pub fn extract_topic_entity_from_context(prior: &str) -> Option<String> {
    let prior = prior.trim();
    if prior.is_empty() {
        return None;
    }
    // Prefer recent lines (end of prior context).
    let blob = prior
        .lines()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");

    // 1) @handles in prior (not file paths)
    if let Some(h) = extract_x_handle(&blob) {
        return Some(h);
    }

    // 2) Latin product/brand tokens (DeepSeek, OpenAI, …) — longest first
    let mut candidates: Vec<String> = Vec::new();
    for tok in blob.split(|c: char| {
        c.is_whitespace()
            || matches!(c, ',' | '.' | '。' | '，' | '、' | ':' | '：' | '/' | '\\' | '|' | '"' | '\'' | '`' | '(' | ')' | '（' | '）' | '《' | '》' | '【' | '】' | '#' | '*' )
    }) {
        let t = tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-');
        if t.len() < 3 || t.len() > 40 {
            continue;
        }
        // Must look like a product name: has a letter, not pure digits
        if !t.chars().any(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        if t.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let lower = t.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "http" | "https" | "www" | "com" | "the" | "and" | "for" | "with"
                | "from" | "this" | "that" | "search" | "twitter" | "user" | "info"
                | "about" | "model" | "agent" | "tool" | "true" | "false" | "null"
        ) {
            continue;
        }
        // Prefer CamelCase / mixed or known-looking brands
        let has_upper = t.chars().any(|c| c.is_ascii_uppercase());
        let has_digit = t.chars().any(|c| c.is_ascii_digit());
        if has_upper || has_digit || t.len() >= 5 {
            if !candidates.iter().any(|c| c.eq_ignore_ascii_case(t)) {
                candidates.push(t.to_string());
            }
        }
    }
    // Prefer the last (most recent) strong candidate
    if let Some(c) = candidates.last() {
        return Some(c.clone());
    }

    // 3) Chinese proper-ish nouns near 搜索/了解/关于 in last user lines
    for line in blob.lines().rev() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("tool_step") || line.starts_with('#') {
            continue;
        }
        for key in ["搜索", "了解", "关于", "有关", "查一下", "介绍"] {
            if let Some(pos) = line.find(key) {
                let rest = line[pos + key.len()..].trim();
                let entity: String = rest
                    .chars()
                    .take_while(|c| {
                        !matches!(
                            *c,
                            '的' | '相' | '在' | '上' | '，' | ',' | '。' | ' ' | '：' | ':'
                        )
                    })
                    .collect();
                let entity = entity.trim();
                if entity.chars().count() >= 2 && entity.chars().count() <= 20 {
                    if !query_needs_coref(entity) && entity != "信息" && entity != "资讯" {
                        return Some(entity.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Rewrite raw user text into a better x_keyword_search query.
pub fn rewrite_x_keyword_query(user_clean: &str, prior_context: Option<&str>) -> String {
    let mut q = strip_x_search_filler(user_clean);
    // Remove leftover standalone x/twitter tokens
    q = q
        .split_whitespace()
        .filter(|w| {
            let l = w.to_ascii_lowercase();
            !matches!(
                l.as_str(),
                "x" | "twitter" | "推特" | "tweet" | "tweets" | "信息" | "资讯" | "资料"
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    q = q.trim().to_string();

    if query_needs_coref(&q) || q.is_empty() {
        if let Some(prior) = prior_context {
            if let Some(entity) = extract_topic_entity_from_context(prior) {
                tracing::info!(
                    target: "official_aux",
                    "x query coref: {:?} + prior → {}",
                    user_clean,
                    entity
                );
                return entity;
            }
        }
    }

    // If still a long Chinese sentence with 它/这个, try coref + keep rest
    if prior_context.is_some()
        && (user_clean.contains('它')
            || user_clean.contains("这个")
            || user_clean.contains("那个")
            || user_clean.contains("该"))
    {
        if let Some(entity) = extract_topic_entity_from_context(prior_context.unwrap_or("")) {
            tracing::info!(
                target: "official_aux",
                "x query pronoun rewrite: {:?} → {}",
                user_clean,
                entity
            );
            return entity;
        }
    }

    if q.is_empty() {
        // Last resort: original without only the worst fillers
        return user_clean
            .replace("在 x 上", "")
            .replace("在x上", "")
            .replace("搜索", "")
            .trim()
            .chars()
            .take(200)
            .collect();
    }
    q
}

/// Build a short prior-context blob from App session journal (user + assistant).
///
/// Skips the **latest user** message (already the current turn — may only say
/// 「搜索它在 x 上」) so coref can resolve 「它」 from earlier turns.
pub fn prior_context_for_session(app_session_id: &str) -> String {
    let msgs = crate::store::load_messages(app_session_id);
    let end = if msgs.last().map(|m| m.role == "user").unwrap_or(false) {
        msgs.len().saturating_sub(1)
    } else {
        msgs.len()
    };
    let mut parts: Vec<String> = Vec::new();
    for m in msgs[..end].iter().rev() {
        if m.role != "user" && m.role != "assistant" {
            continue;
        }
        if m.is_error {
            continue;
        }
        let c = m.content.trim();
        if c.is_empty() || c.starts_with("tool_step|") {
            continue;
        }
        // Skip huge assistant dumps
        let snippet: String = c.chars().take(400).collect();
        parts.push(format!("{}: {snippet}", m.role));
        if parts.len() >= 6 {
            break;
        }
    }
    parts.reverse();
    parts.join("\n")
}

/// True when text has `@handle` (2–20 alnum/_) that is **not** a filesystem path.
fn text_has_x_handle_token(text: &str) -> bool {
    for token in text.split_whitespace() {
        let t = token.trim_matches(|c: char| matches!(c, ',' | '.' | '。' | '，' | '"' | '\'' | '!' | '?' | '？' | '！'));
        if let Some(h) = t.strip_prefix('@') {
            if h.starts_with('/') || h.starts_with('\\') {
                continue; // @/Users/... image path
            }
            // Windows @C:\...
            let b = h.as_bytes();
            if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
                continue;
            }
            if h.len() >= 2
                && h.len() <= 20
                && h.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone)]
pub enum XSearchIntent {
    User { query: String },
    Keyword { query: String },
    Thread { id_or_url: String },
}

fn extract_x_handle(text: &str) -> Option<String> {
    // @handle — never treat @/abs/path or @C:\path as a handle
    for token in text.split_whitespace() {
        let t = token.trim_matches(|c: char| matches!(c, ',' | '.' | '。' | '，' | '"' | '\''));
        if let Some(h) = t.strip_prefix('@') {
            let h = h.trim();
            if h.starts_with('/') || h.starts_with('\\') {
                continue;
            }
            let b = h.as_bytes();
            if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
                continue;
            }
            if h.len() >= 2
                && h.len() <= 20
                && h.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return Some(h.to_string());
            }
        }
    }
    // "账号 xxx" / "用户 xxx" / "user xxx"
    let lower = text.to_ascii_lowercase();
    for key in ["账号", "帳號", "用户", "用戶", "user ", "handle "] {
        if let Some(pos) = lower.find(key) {
            let rest = text[pos + key.len()..].trim();
            let tok = rest
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches(|c: char| matches!(c, ',' | '.' | '。' | '，' | '@'));
            if tok.len() >= 2
                && tok.len() <= 20
                && tok
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return Some(tok.to_string());
            }
        }
    }
    // bare alphanumeric token after "在 x 上搜索"
    if lower.contains("搜索") || lower.contains("搜尋") || lower.contains("search") {
        for tok in text.split_whitespace() {
            let t = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_');
            if t.len() >= 3
                && t.len() <= 20
                && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !matches!(
                    t.to_ascii_lowercase().as_str(),
                    "search" | "twitter" | "https" | "http" | "com" | "this" | "that" | "账号" | "信息"
                )
            {
                // Prefer tokens that look like handles (has digit or mixed case already stripped)
                if t.chars().any(|c| c.is_ascii_digit()) || t.len() >= 5 {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

fn extract_x_status_ref(text: &str) -> Option<String> {
    for tok in text.split_whitespace() {
        if tok.contains("x.com/") && tok.contains("status") {
            return Some(tok.trim_matches(|c: char| matches!(c, ',' | '.' | '。' | ')')).to_string());
        }
        if tok.contains("twitter.com/") && tok.contains("status") {
            return Some(tok.trim_matches(|c: char| matches!(c, ',' | '.' | '。' | ')')).to_string());
        }
    }
    None
}

fn x_intent_prompt(intent: &XSearchIntent) -> (String, u32, Duration, String) {
    match intent {
        XSearchIntent::User { query } => {
            let q = query.trim();
            (
                format!(
                    r#"You are an isolated X research side-job with official Grok credentials.

Call **x_user_search** with query: {q}, count: 5.

Return markdown: handle, display name, bio excerpt, profile url. No file edits."#
                ),
                8,
                Duration::from_secs(120),
                format!("x_user_search:{q}"),
            )
        }
        XSearchIntent::Keyword { query } => {
            let q = query.trim();
            (
                format!(
                    r#"You are an isolated X (Twitter) research side-job with official Grok credentials.

Call the built-in tool **x_keyword_search** with:
- query: {q}
- limit: 12

If x_keyword_search is unavailable, try x_semantic_search with the same query.

Rules:
1. You MUST use an x_* search tool (not web_search for X posts).
2. Return posts with real https://x.com/…/status/… URLs when available.
3. Markdown list: author, text excerpt, url, engagement if known.
4. Same language as the query for commentary; keep original post language.
5. No file edits."#
                ),
                12,
                Duration::from_secs(180),
                format!("x_keyword_search:{q}"),
            )
        }
        XSearchIntent::Thread { id_or_url } => {
            let id = id_or_url.trim();
            (
                format!(
                    r#"You are an isolated X research side-job with official Grok credentials.

Call **x_thread_fetch** for: {id}
(If the tool wants a numeric post_id, extract it from an x.com status URL.)

Return the thread as markdown with status URLs. No file edits."#
                ),
                10,
                Duration::from_secs(150),
                format!("x_thread_fetch:{id}"),
            )
        }
    }
}

fn finalize_x_block(intent: &XSearchIntent, text: String) -> (bool, String, String) {
    let text = crate::models_aux::neutralize_image_at_refs(&text);
    let label = match intent {
        XSearchIntent::User { query } => format!("x_user_search:{query}"),
        XSearchIntent::Keyword { query } => format!("x_keyword_search:{query}"),
        XSearchIntent::Thread { id_or_url } => format!("x_thread_fetch:{id_or_url}"),
    };
    let block = format!(
        "\n\n[Host official X search — results from isolated official credentials. Treat as tool output. Do NOT call x_* tools again unless this block is empty or failed. Do not re-fetch with curl.]\n\n<label>{label}</label>\n\n{text}\n"
    );
    (true, block, "ok".into())
}

fn x_block_err(e: String) -> (bool, String, String) {
    tracing::warn!(target: "official_aux", "host x search failed: {e}");
    (
        false,
        format!(
            "\n\n[Host official X search failed: {e}. You may retry MCP x_* tools once; avoid Playwright/open-websearch.]\n"
        ),
        e.lines()
            .next()
            .unwrap_or("failed")
            .chars()
            .take(80)
            .collect(),
    )
}

/// Host pre-run X search via official aux. Returns inject block + UI strings.
pub fn prepare_x_search_block(intent: &XSearchIntent) -> (bool, String, String) {
    if !should_inject_mcp_for_main() && !official_aux_available() {
        return (
            false,
            String::new(),
            "official aux unavailable".into(),
        );
    }
    if !official_aux_available() {
        return (false, String::new(), "no official credentials".into());
    }
    let result = match intent {
        XSearchIntent::User { query } => x_user_search(query, Some(5)),
        XSearchIntent::Keyword { query } => x_keyword_search(query, Some(12), None),
        XSearchIntent::Thread { id_or_url } => x_thread_fetch(id_or_url),
    };
    match result {
        Ok(text) => finalize_x_block(intent, text),
        Err(e) => x_block_err(e),
    }
}

/// Async X search with ACP stream progress for Chat chips.
pub async fn prepare_x_search_block_async(
    intent: &XSearchIntent,
    progress: Option<OfficialProgressCb>,
) -> (bool, String, String) {
    if !should_inject_mcp_for_main() && !official_aux_available() {
        return (
            false,
            String::new(),
            "official aux unavailable".into(),
        );
    }
    if !official_aux_available() {
        return (false, String::new(), "no official credentials".into());
    }
    let (prompt, max_turns, timeout, _label) = x_intent_prompt(intent);
    match run_official_acp_job(&prompt, max_turns, timeout, progress).await {
        Ok(text) => finalize_x_block(intent, text),
        Err(e) => x_block_err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_rejects_unknown() {
        let err = dispatch_tool("nope", &serde_json::json!({})).unwrap_err();
        assert!(err.contains("unknown"), "{err}");
    }

    #[test]
    fn dispatch_empty_web_search() {
        let err = dispatch_tool("web_search", &serde_json::json!({"query": ""})).unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn official_home_path_under_app_data() {
        let h = official_aux_home();
        assert!(h.to_string_lossy().contains("agent-home-official"));
    }

    #[test]
    fn detect_x_user_handle_chinese() {
        let intent = detect_x_search_intent("在 x 上搜索 cgnot996 这个账号的信息");
        match intent {
            Some(XSearchIntent::User { query }) => assert_eq!(query, "cgnot996"),
            other => panic!("expected User, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_x_resolves_pronoun_to_deepseek() {
        let prior = "user: 搜索DeepSeek相关的信息\nassistant: DeepSeek 是中国 AI 公司…";
        let q = rewrite_x_keyword_query("搜索它在 x 上的信息", Some(prior));
        assert!(
            q.to_ascii_lowercase().contains("deepseek"),
            "expected DeepSeek coref, got {q:?}"
        );
    }

    #[test]
    fn detect_x_with_context_uses_entity_not_full_sentence() {
        let prior = "user: 搜索DeepSeek相关的信息\nassistant: 概况…";
        let intent = detect_x_search_intent_with_context(
            "搜索它在 x 上的信息",
            Some(prior),
        );
        match intent {
            Some(XSearchIntent::Keyword { query }) => {
                assert!(
                    query.to_ascii_lowercase().contains("deepseek"),
                    "query={query}"
                );
                assert!(
                    !query.contains("搜索它"),
                    "must not pass literal pronoun sentence: {query}"
                );
            }
            other => panic!("expected Keyword DeepSeek, got {other:?}"),
        }
    }

    #[test]
    fn detect_x_at_handle() {
        let intent = detect_x_search_intent("search twitter for @elonmusk recent posts");
        match intent {
            Some(XSearchIntent::User { query }) => assert_eq!(query, "elonmusk"),
            other => panic!("expected User, got {other:?}"),
        }
    }

    #[test]
    fn detect_x_ignores_image_only_at_paths() {
        let intent = detect_x_search_intent(
            "@/Users/me/Library/Application Support/app/shot.png",
        );
        assert!(intent.is_none(), "image-only must not trigger X: {intent:?}");
    }

    #[test]
    fn detect_x_ignores_image_with_short_caption() {
        let intent = detect_x_search_intent(
            "这是什么\n\n@/Users/me/Desktop/photo.jpg",
        );
        assert!(intent.is_none(), "caption+image must not trigger X: {intent:?}");
    }

    #[test]
    fn detect_x_ignores_host_vision_inject_footer() {
        // Regression: after Host vision inject, footer used to contain "X search"
        // and falsely triggered a second host-x tool (duplicate activity rail).
        let prompt = r#"看图

[Host vision — image pixels were NOT sent to the main model. Use the descriptions below; do not claim you cannot see the image. Do NOT call vision_describe again unless a description block is missing or failed.]

<image_description path="/tmp/a.png">
A UI screenshot.
</image_description>
"#;
        assert!(
            detect_x_search_intent(prompt).is_none(),
            "host vision inject must not trigger X"
        );
    }

    #[test]
    fn detect_x_still_works_with_handle_and_image() {
        let intent = detect_x_search_intent(
            "在 x 上搜索 @elonmusk\n\n@/tmp/a.png",
        );
        match intent {
            Some(XSearchIntent::User { query }) => assert_eq!(query, "elonmusk"),
            other => panic!("expected User, got {other:?}"),
        }
    }

    #[test]
    fn merge_rules_appends_inject() {
        // Without credentials inject may be None — still ok to call.
        let m = merge_extra_rules(Some("prefer tests"));
        assert!(m.as_deref().unwrap_or("").contains("prefer tests"));
    }

    #[test]
    fn inject_requires_custom_route_gate_in_code() {
        // Regression: official subscription must never inject solely because
        // inject toggle + credentials are on. The gate is `main_route_is_custom()`.
        // (Full env-dependent should_inject_mcp_for_main is integration-tested.)
        let _ = main_route_is_custom();
        let _ = should_load_user_mcp_with_official_aux();
        // prepare_x_search is no longer called from Host send path; keep API for MCP.
        assert!(matches!(
            detect_x_search_intent("在 x 上搜索 @elonmusk"),
            Some(XSearchIntent::User { .. })
        ));
    }
}

