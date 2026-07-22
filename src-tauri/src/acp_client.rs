//! Real ACP client: spawn `grok agent stdio`, JSON-RPC line framing.
//! Default production transport. Mock only when GROK_APP_ACP=mock.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex as ParkingMutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tracing::{debug, error, info, warn};

use crate::error::{AgentError, AgentErrorCode};

#[derive(Debug, Clone)]
pub enum AcpEvent {
    State {
        backend: String,
        agent_session_id: Option<String>,
        model_id: Option<String>,
    },
    Stream {
        kind: StreamKind,
        text: String,
        message_id: Option<String>,
        done: bool,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        kind: String,
        status: String,
        raw: Value,
    },
    Plan {
        entries: Value,
    },
    PermissionRequest {
        rpc_id: u64,
        tool_call_id: String,
        tool_name: String,
        title: String,
        options: Value,
        raw: Value,
    },
    PromptComplete {
        stop_reason: String,
    },
    Error {
        error: AgentError,
    },
    Stderr {
        line: String,
    },
    ProcessExited {
        code: Option<i32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Assistant,
    Thought,
}

struct Pending {
    method: String,
    tx: oneshot::Sender<Result<Value, String>>,
}

const HANDSHAKE_TIMEOUT_SECS: u64 = 45;
const AUTH_TIMEOUT_SECS: u64 = 12;
const PROMPT_TIMEOUT_SECS: u64 = 600;

pub struct AcpClient {
    child: AsyncMutex<Option<Child>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    next_id: AtomicU64,
    pending: ParkingMutex<HashMap<u64, Pending>>,
    event_tx: mpsc::UnboundedSender<AcpEvent>,
    agent_session_id: ParkingMutex<Option<String>>,
    cli_path: PathBuf,
    cwd: PathBuf,
    stopped: AtomicBool,
    reader_alive: AtomicBool,
    /// Recent stderr lines for crash diagnostics (ring, newest last).
    stderr_tail: ParkingMutex<Vec<String>>,
}

impl AcpClient {
    pub fn use_mock() -> bool {
        std::env::var("GROK_APP_ACP")
            .map(|v| v.eq_ignore_ascii_case("mock"))
            .unwrap_or(false)
    }

    pub fn spawn(
        cli_path: PathBuf,
        cwd: PathBuf,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<AcpEvent>), AgentError> {
        let settings = crate::store::load_settings();
        Self::spawn_with_home(cli_path, cwd, &settings.session_data_mode)
    }

    /// Spawn `grok agent stdio` with GROK_HOME from session_data_mode.
    pub fn spawn_with_home(
        cli_path: PathBuf,
        cwd: PathBuf,
        session_data_mode: &str,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<AcpEvent>), AgentError> {
        if !cli_path.exists() {
            return Err(AgentError::new(
                AgentErrorCode::CliNotFound,
                format!("CLI not found: {}", cli_path.display()),
            ));
        }

        let (event_tx, event_rx) = mpsc::unbounded_channel();

        // GUI apps often inherit a sparse PATH; keep absolute cli_path but enrich PATH
        // so nested tools (npx, node, git) resolve when the agent shells out.
        let mut cmd = Command::new(&cli_path);
        cmd.args(["agent", "stdio"])
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(path) = enriched_path_env() {
            cmd.env("PATH", path);
        }
        // Independent profile: agent reads App agent-home/config.toml for custom providers.
        let grok_home = crate::paths::resolve_agent_grok_home(session_data_mode);
        let _ = std::fs::create_dir_all(&grok_home);
        cmd.env("GROK_HOME", &grok_home);
        tracing::info!(
            "acp: spawn GROK_HOME={} mode={}",
            grok_home.display(),
            session_data_mode
        );

        let mut child = cmd.spawn().map_err(|e| {
            AgentError::new(
                AgentErrorCode::CliNotFound,
                format!("failed to spawn grok agent stdio: {e}"),
            )
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            AgentError::new(AgentErrorCode::AgentCrashed, "no stdin on child")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AgentError::new(AgentErrorCode::AgentCrashed, "no stdout on child")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AgentError::new(AgentErrorCode::AgentCrashed, "no stderr on child")
        })?;

        let client = Arc::new(Self {
            child: AsyncMutex::new(Some(child)),
            stdin: AsyncMutex::new(Some(stdin)),
            next_id: AtomicU64::new(1),
            pending: ParkingMutex::new(HashMap::new()),
            event_tx: event_tx.clone(),
            agent_session_id: ParkingMutex::new(None),
            cli_path,
            cwd,
            stopped: AtomicBool::new(false),
            reader_alive: AtomicBool::new(true),
            stderr_tail: ParkingMutex::new(Vec::new()),
        });

        // stdout reader
        {
            let c = Arc::clone(&client);
            tokio::spawn(async move {
                // Large session/update lines (available_commands) can be multi-MB.
                let mut reader = BufReader::with_capacity(8 * 1024 * 1024, stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            c.handle_line(trimmed).await;
                        }
                        Err(e) => {
                            error!("acp stdout read error: {e}");
                            break;
                        }
                    }
                }
                c.reader_alive.store(false, Ordering::SeqCst);
                let detail = c.format_exit_detail("Agent process exited (stdout EOF)");
                c.fail_all_pending(&detail);
                let _ = c.event_tx.send(AcpEvent::ProcessExited { code: None });
            });
        }

        // stderr reader (separate tee + ring buffer)
        {
            let c = Arc::clone(&client);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let t = line.trim_end().to_string();
                            if !t.is_empty() {
                                c.push_stderr(&t);
                                let _ = c.event_tx.send(AcpEvent::Stderr { line: t });
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        Ok((client, event_rx))
    }

    fn push_stderr(&self, line: &str) {
        let mut buf = self.stderr_tail.lock();
        buf.push(line.to_string());
        const MAX: usize = 40;
        if buf.len() > MAX {
            let drain = buf.len() - MAX;
            buf.drain(0..drain);
        }
    }

    fn stderr_joined(&self) -> String {
        self.stderr_tail.lock().join(" | ")
    }

    fn format_exit_detail(&self, head: &str) -> String {
        let tail = self.stderr_joined();
        if tail.is_empty() {
            head.to_string()
        } else {
            // Cap length for UI
            let t = if tail.len() > 800 {
                format!("…{}", &tail[tail.len() - 800..])
            } else {
                tail
            };
            format!("{head}; stderr: {t}")
        }
    }

    fn fail_all_pending(&self, message: &str) {
        let pending: Vec<_> = self.pending.lock().drain().map(|(_, p)| p).collect();
        for p in pending {
            let _ = p.tx.send(Err(message.to_string()));
        }
    }

    async fn handle_line(&self, line: &str) {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                warn!("acp non-json line: {e}: {}", &line[..line.len().min(200)]);
                return;
            }
        };

        // Response to our request (result or error present)
        if let Some(id) = json_id_u64(msg.get("id")) {
            if msg.get("result").is_some() || msg.get("error").is_some() {
                if let Some(p) = self.pending.lock().remove(&id) {
                    if let Some(err) = msg.get("error") {
                        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
                        let message = err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("rpc error")
                            .to_string();
                        let data = err
                            .get("data")
                            .map(|d| d.to_string())
                            .filter(|s| s != "null" && !s.is_empty());
                        let full = match data {
                            Some(d) => format!("{message} (code {code}, data: {d})"),
                            None => format!("{message} (code {code})"),
                        };
                        let _ = p.tx.send(Err(full));
                    } else {
                        let _ = p.tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                    }
                } else {
                    warn!(
                        "acp response for unknown id={id} (no pending); method keys={:?}",
                        msg.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>())
                    );
                }
                // also surface prompt complete via result stopReason
                if let Some(sr) = msg
                    .pointer("/result/stopReason")
                    .and_then(|v| v.as_str())
                {
                    let _ = self.event_tx.send(AcpEvent::PromptComplete {
                        stop_reason: sr.to_string(),
                    });
                }
                return;
            }
        }

        // Server request / notification
        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            let req_id = json_id_u64(msg.get("id"));

            if method == "session/request_permission" {
                let rpc_id = req_id.unwrap_or(0);
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                let tool_call_id = tool_call
                    .get("toolCallId")
                    .or_else(|| tool_call.get("tool_call_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let title = tool_call
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Tool permission")
                    .to_string();
                let tool_name = tool_call
                    .get("kind")
                    .or_else(|| tool_call.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let options = params.get("options").cloned().unwrap_or(json!([]));
                let _ = self.event_tx.send(AcpEvent::PermissionRequest {
                    rpc_id,
                    tool_call_id,
                    tool_name,
                    title,
                    options,
                    raw: params,
                });
                return;
            }

            // True notifications: no id. (If id is present, must reply — never swallow.)
            if req_id.is_none() {
                if method == "session/update" {
                    self.handle_session_update(msg.get("params").unwrap_or(&Value::Null));
                } else if method == "_x.ai/session/prompt_complete" {
                    // Fallback completion signal if JSON-RPC result is delayed/missing.
                    let stop = msg
                        .pointer("/params/stopReason")
                        .or_else(|| msg.pointer("/params/stop_reason"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("end_turn")
                        .to_string();
                    self.complete_pending_prompt_fallback(&stop);
                    let _ = self.event_tx.send(AcpEvent::PromptComplete {
                        stop_reason: stop,
                    });
                } else {
                    debug!("acp notification ignored method={method}");
                }
                return;
            }

            // Unhandled server→client request with id: reply so agent does not hang.
            let id = req_id.unwrap();
            warn!("acp unhandled server request method={method} id={id}");
            let err = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Method not found: {method}"),
                }
            });
            if let Err(e) = self.write_line(&err).await {
                warn!("failed to reject unhandled method {method}: {e}");
            }
        }
    }

    /// If agent emitted prompt_complete notification but never the RPC result, free waiters.
    fn complete_pending_prompt_fallback(&self, stop_reason: &str) {
        let mut pending = self.pending.lock();
        let prompt_ids: Vec<u64> = pending
            .iter()
            .filter(|(_, p)| p.method == "session/prompt")
            .map(|(id, _)| *id)
            .collect();
        for id in prompt_ids {
            if let Some(p) = pending.remove(&id) {
                info!("acp completing session/prompt id={id} via prompt_complete fallback");
                let _ = p.tx.send(Ok(json!({ "stopReason": stop_reason })));
            }
        }
    }

    fn handle_session_update(&self, params: &Value) {
        let update = params.get("update").unwrap_or(params);
        let kind = update
            .get("sessionUpdate")
            .or_else(|| update.get("session_update"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match kind {
            "agent_message_chunk" => {
                let text = update
                    .pointer("/content/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let message_id = update
                    .get("messageId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let _ = self.event_tx.send(AcpEvent::Stream {
                    kind: StreamKind::Assistant,
                    text,
                    message_id,
                    done: false,
                });
            }
            "agent_thought_chunk" => {
                let text = update
                    .pointer("/content/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = self.event_tx.send(AcpEvent::Stream {
                    kind: StreamKind::Thought,
                    text,
                    message_id: None,
                    done: false,
                });
            }
            "plan" => {
                let entries = update.get("entries").cloned().unwrap_or(json!([]));
                let _ = self.event_tx.send(AcpEvent::Plan { entries });
            }
            "tool_call" | "tool_call_update" => {
                let tool_call_id = update
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let title = update
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let k = update
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let status = update
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = self.event_tx.send(AcpEvent::ToolCall {
                    tool_call_id,
                    title,
                    kind: k,
                    status,
                    raw: update.clone(),
                });
            }
            _ => {
                debug!("acp session/update ignored kind={kind}");
            }
        }
    }

    async fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or_else(|| "stdin closed".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_timeout(method, params, HANDSHAKE_TIMEOUT_SECS)
            .await
    }

    async fn request_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        if !self.reader_alive.load(Ordering::SeqCst) {
            return Err(format!(
                "agent stdout closed before {method}; {}",
                self.format_exit_detail("process dead")
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(
            id,
            Pending {
                method: method.to_string(),
                tx,
            },
        );
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        info!("acp → {method} id={id}");
        if let Err(e) = self.write_line(&msg).await {
            self.pending.lock().remove(&id);
            return Err(format!("write {method} failed: {e}"));
        }
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(r)) => {
                info!("acp ← {method} id={id} ok");
                r
            }
            Ok(Err(_)) => Err(format!(
                "rpc channel closed while waiting for {method} (id={id}); {}",
                self.format_exit_detail("channel closed")
            )),
            Err(_) => {
                self.pending.lock().remove(&id);
                let detail = self.format_exit_detail(&format!(
                    "rpc timeout on {method} (id={id}) after {timeout_secs}s"
                ));
                error!("{detail}");
                Err(detail)
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_line(&msg).await
    }

    pub async fn initialize_and_new_session(&self) -> Result<String, AgentError> {
        // Do not advertise client fs methods we do not implement — avoids agent
        // hanging on fs/readTextFile while we never reply.
        let init = self
            .request_timeout(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientInfo": { "name": "grok-app", "version": "0.1.0" },
                    "capabilities": {}
                }),
                HANDSHAKE_TIMEOUT_SECS,
            )
            .await
            .map_err(|e| self.map_handshake_err("initialize", e))?;

        info!(
            "acp initialized agentVersion={:?}",
            init.pointer("/_meta/agentVersion")
                .or_else(|| init.pointer("/agentVersion"))
        );

        // Best-effort cached auth — short timeout so a hung auth cannot burn 120s.
        match self
            .request_timeout(
                "authenticate",
                json!({ "methodId": "cached_token" }),
                AUTH_TIMEOUT_SECS,
            )
            .await
        {
            Ok(_) => info!("acp authenticate cached_token ok"),
            Err(e) => warn!("acp authenticate soft-fail (continuing): {e}"),
        }

        let cwd = self.cwd.to_string_lossy().to_string();
        if !self.cwd.is_dir() {
            return Err(AgentError::new(
                AgentErrorCode::AgentCrashed,
                format!("project cwd is not a directory: {cwd}"),
            ));
        }

        let result = self
            .request_timeout(
                "session/new",
                json!({
                    "cwd": cwd,
                    "mcpServers": []
                }),
                HANDSHAKE_TIMEOUT_SECS,
            )
            .await
            .map_err(|e| self.map_handshake_err("session/new", e))?;

        let sid = result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AgentError::new(
                    AgentErrorCode::AgentCrashed,
                    format!(
                        "session/new missing sessionId; keys={:?}",
                        result.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>())
                    ),
                )
            })?
            .to_string();

        *self.agent_session_id.lock() = Some(sid.clone());
        let model_id = result
            .pointer("/models/currentModelId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let _ = self.event_tx.send(AcpEvent::State {
            backend: "grok_agent_stdio".into(),
            agent_session_id: Some(sid.clone()),
            model_id,
        });

        Ok(sid)
    }

    fn map_handshake_err(&self, phase: &str, e: String) -> AgentError {
        let detail = self.format_exit_detail(&format!("{phase}: {e}"));
        let lower = detail.to_lowercase();
        if lower.contains("401")
            || lower.contains("auth")
            || lower.contains("unauthor")
            || lower.contains("login")
        {
            AgentError::new(AgentErrorCode::AuthFailed, detail)
        } else if lower.contains("network")
            || lower.contains("dns")
            || lower.contains("timeout")
            || lower.contains("5xx")
        {
            AgentError::new(AgentErrorCode::NetworkProvider, detail)
        } else {
            AgentError::new(AgentErrorCode::AgentCrashed, detail)
        }
    }

    pub async fn prompt(&self, text: &str) -> Result<(), AgentError> {
        let sid = self
            .agent_session_id
            .lock()
            .clone()
            .ok_or_else(|| AgentError::new(AgentErrorCode::AgentCrashed, "no session"))?;

        self.stopped.store(false, Ordering::SeqCst);

        // Fire and wait for completion in background via request future
        let text = text.to_string();
        let this_params = json!({
            "sessionId": sid,
            "prompt": [{ "type": "text", "text": text }]
        });

        let result = self
            .request_timeout("session/prompt", this_params, PROMPT_TIMEOUT_SECS)
            .await
            .map_err(|e| classify_rpc_error(&e))?;

        let stop = result
            .get("stopReason")
            .and_then(|v| v.as_str())
            .unwrap_or("end_turn")
            .to_string();

        let _ = self.event_tx.send(AcpEvent::Stream {
            kind: StreamKind::Assistant,
            text: String::new(),
            message_id: None,
            done: true,
        });
        let _ = self.event_tx.send(AcpEvent::PromptComplete {
            stop_reason: stop,
        });
        Ok(())
    }

    /// Cancel in-flight prompt (ACP notification — no id).
    pub async fn cancel(&self) -> Result<(), String> {
        let sid = self
            .agent_session_id
            .lock()
            .clone()
            .ok_or_else(|| "no session".to_string())?;
        self.stopped.store(true, Ordering::SeqCst);
        self.notify("session/cancel", json!({ "sessionId": sid }))
            .await
    }

    pub async fn respond_permission(
        &self,
        rpc_id: u64,
        outcome: PermissionOutcome,
    ) -> Result<(), String> {
        let result = match outcome {
            PermissionOutcome::Selected { option_id } => json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": option_id
                }
            }),
            PermissionOutcome::Cancelled => json!({
                "outcome": { "outcome": "cancelled" }
            }),
        };
        let msg = json!({
            "jsonrpc": "2.0",
            "id": rpc_id,
            "result": result,
        });
        self.write_line(&msg).await
    }

    pub fn agent_session_id(&self) -> Option<String> {
        self.agent_session_id.lock().clone()
    }

    pub async fn kill(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
        *self.stdin.lock().await = None;
    }
}

#[derive(Debug, Clone)]
pub enum PermissionOutcome {
    Selected { option_id: String },
    Cancelled,
}

fn classify_rpc_error(e: &str) -> AgentError {
    let lower = e.to_lowercase();
    if lower.contains("401") || lower.contains("auth") || lower.contains("unauthor") || lower.contains("login") {
        AgentError::new(AgentErrorCode::AuthFailed, e)
    } else if lower.contains("dns")
        || lower.contains("timeout")
        || lower.contains("network")
        || lower.contains("5xx")
        || lower.contains("rpc channel closed")
    {
        // Timeouts are usually model/network hangs, not a hard process crash.
        AgentError::new(AgentErrorCode::NetworkProvider, e)
    } else if lower.contains("not found") && lower.contains("cli") {
        AgentError::new(AgentErrorCode::CliNotFound, e)
    } else {
        AgentError::new(AgentErrorCode::AgentCrashed, e)
    }
}

fn json_id_u64(v: Option<&Value>) -> Option<u64> {
    let v = v?;
    if let Some(u) = v.as_u64() {
        return Some(u);
    }
    if let Some(i) = v.as_i64() {
        if i >= 0 {
            return Some(i as u64);
        }
    }
    if let Some(s) = v.as_str() {
        return s.parse().ok();
    }
    None
}

/// Build a PATH suitable for GUI-spawned agent processes (macOS sparse env).
fn enriched_path_env() -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let push = |parts: &mut Vec<String>, p: &str| {
        if p.is_empty() {
            return;
        }
        if !parts.iter().any(|x| x == p) {
            parts.push(p.to_string());
        }
    };
    if let Ok(cur) = std::env::var("PATH") {
        for p in cur.split(':') {
            push(&mut parts, p);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        push(&mut parts, &format!("{home}/.grok/bin"));
        push(&mut parts, &format!("{home}/.local/bin"));
        push(&mut parts, &format!("{home}/.cargo/bin"));
        push(&mut parts, &format!("{home}/.bun/bin"));
    }
    push(&mut parts, "/opt/homebrew/bin");
    push(&mut parts, "/usr/local/bin");
    push(&mut parts, "/usr/bin");
    push(&mut parts, "/bin");
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(":"))
    }
}

#[cfg(test)]
mod live_handshake_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn live_initialize_session_new_under_30s() {
        if std::env::var("GROK_APP_LIVE_ACP").ok().as_deref() != Some("1") {
            eprintln!("skip live ACP (set GROK_APP_LIVE_ACP=1)");
            return;
        }
        let cli = which::which("grok").or_else(|_| {
            let p = PathBuf::from(std::env::var("HOME").unwrap()).join(".grok/bin/grok");
            if p.exists() { Ok(p) } else { Err(which::Error::CannotFindBinaryPath) }
        }).expect("grok cli");
        let cwd = std::env::current_dir().unwrap();
        let t0 = std::time::Instant::now();
        let (client, mut events) = AcpClient::spawn(cli, cwd).expect("spawn");
        // drain events in bg
        tokio::spawn(async move {
            while let Some(ev) = events.recv().await {
                eprintln!("ev: {:?}", std::mem::discriminant(&ev));
            }
        });
        let sid = tokio::time::timeout(Duration::from_secs(45), client.initialize_and_new_session())
            .await
            .expect("overall timeout")
            .expect("handshake");
        eprintln!("OK session={} in {:?}", sid, t0.elapsed());
        client.kill().await;
        assert!(!sid.is_empty());
    }
}
