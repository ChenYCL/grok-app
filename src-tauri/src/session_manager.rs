//! Host session manager: real ACP default; mock only if GROK_APP_ACP=mock.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::acp_client::{AcpClient, AcpEvent, PermissionOutcome, StreamKind};
use crate::cli_probe;
use crate::error::{AgentError, AgentErrorCode};
use crate::mock_acp::{self, MockConnectMode, MockStreamHandle, StreamChunk};
use crate::permission::{
    extract_path_target, may_auto_allow, may_auto_deny, pick_option_id, scope_key, PermissionPolicy,
    SessionAllowCache,
};
use crate::session_fsm::{SessionFsm, SessionState};
use crate::store::{self, ChatMessageStored, SessionMeta};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: Option<String>,
    pub agent_session_id: Option<String>,
    pub state: SessionState,
    pub last_error: Option<AgentError>,
    pub streaming_message_id: Option<String>,
    pub backend: String,
    pub model_id: Option<String>,
    pub project_path: Option<String>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPermissionRequest {
    pub rpc_id: u64,
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub title: String,
    pub preview: String,
    pub scope_key: String,
    pub options: serde_json::Value,
}

struct LiveSession {
    app_session_id: String,
    meta: SessionMeta,
    fsm: SessionFsm,
    backend: String,
    acp: Option<Arc<AcpClient>>,
    mock_stream: Option<MockStreamHandle>,
    streaming_message_id: Option<String>,
    /// Accumulated assistant text for current turn (persisted on complete).
    stream_buf: String,
    stream_thought: String,
    model_id: Option<String>,
    project_path: Option<String>,
    allow_cache: SessionAllowCache,
    policy: PermissionPolicy,
}

pub struct SessionManager {
    inner: Mutex<Option<LiveSession>>,
    /// Max concurrent agent processes (spec: 3). Single active for P0 simplicity + limit check.
    active_count: Mutex<u32>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            active_count: Mutex::new(0),
        }
    }

    fn backend_name() -> String {
        if AcpClient::use_mock() {
            "mock_acp".into()
        } else {
            "grok_agent_stdio".into()
        }
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        let guard = self.inner.lock();
        match guard.as_ref() {
            None => SessionSnapshot {
                session_id: None,
                agent_session_id: None,
                state: SessionState::Idle,
                last_error: None,
                streaming_message_id: None,
                backend: Self::backend_name(),
                model_id: None,
                project_path: None,
                title: String::new(),
            },
            Some(s) => SessionSnapshot {
                session_id: Some(s.app_session_id.clone()),
                agent_session_id: s.meta.agent_session_id.clone(),
                state: s.fsm.state(),
                last_error: s.fsm.last_error().cloned(),
                streaming_message_id: s.streaming_message_id.clone(),
                backend: s.backend.clone(),
                model_id: s.model_id.clone(),
                project_path: s.project_path.clone(),
                title: s.meta.title.clone(),
            },
        }
    }

    fn emit_state(app: &AppHandle, snap: &SessionSnapshot) {
        let _ = app.emit("session://state", snap);
    }

    pub async fn connect(
        self: &Arc<Self>,
        app: AppHandle,
        project_path: Option<String>,
        app_session_id: Option<String>,
        mock_mode: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        // Tear down existing
        self.disconnect_inner(&app).await;

        let settings = store::load_settings();
        let policy = PermissionPolicy::parse(&settings.permission_policy);

        let cwd = project_path
            .clone()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()));

        // Ensure app session meta
        let mut meta = if let Some(id) = app_session_id {
            store::load_sessions_index()
                .into_iter()
                .find(|s| s.id == id)
                .unwrap_or_else(|| {
                    store::create_session(None, Some("New chat".into())).expect("create session")
                })
        } else {
            store::create_session(None, Some("New chat".into())).map_err(|e| e)?
        };

        {
            let mut fsm = SessionFsm::new();
            fsm.start_connect().map_err(|e| e.to_string())?;
            *self.inner.lock() = Some(LiveSession {
                app_session_id: meta.id.clone(),
                meta: meta.clone(),
                fsm,
                backend: Self::backend_name(),
                acp: None,
                mock_stream: None,
                streaming_message_id: None,
                stream_buf: String::new(),
                stream_thought: String::new(),
                model_id: settings.model_id.clone(),
                project_path: project_path.clone(),
                allow_cache: SessionAllowCache::default(),
                policy,
            });
        }
        Self::emit_state(&app, &self.snapshot());

        let use_mock = AcpClient::use_mock()
            || mock_mode.as_deref() == Some("mock")
            || mock_mode.as_deref() == Some("fail_cli_not_found");

        if use_mock {
            return self.connect_mock(app, mock_mode).await;
        }

        // Real ACP
        let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
        if !probe.found {
            {
                let mut guard = self.inner.lock();
                if let Some(s) = guard.as_mut() {
                    let _ = s.fsm.connect_failed(AgentError::new(
                        AgentErrorCode::CliNotFound,
                        "Grok Build CLI not found. Install Grok Build or set path in Settings.",
                    ));
                }
            }
            let snap = self.snapshot();
            Self::emit_state(&app, &snap);
            return Ok(snap);
        }

        let cli_path = std::path::PathBuf::from(probe.path.unwrap());

        let (client, mut events) = match AcpClient::spawn(cli_path, cwd) {
            Ok(v) => v,
            Err(e) => {
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        let _ = s.fsm.connect_failed(e);
                    }
                }
                let snap = self.snapshot();
                Self::emit_state(&app, &snap);
                return Ok(snap);
            }
        };

        {
            let mut n = self.active_count.lock();
            *n += 1;
        }

        // Event pump
        {
            let mgr = Arc::clone(self);
            let app_ev = app.clone();
            tokio::spawn(async move {
                while let Some(ev) = events.recv().await {
                    mgr.handle_acp_event(&app_ev, ev).await;
                }
            });
        }

        match client.initialize_and_new_session().await {
            Ok(agent_sid) => {
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        let _ = s.fsm.handshake_ok();
                        s.acp = Some(client);
                        s.meta.agent_session_id = Some(agent_sid);
                        s.backend = "grok_agent_stdio".into();
                        meta = s.meta.clone();
                    }
                }
                let _ = store::update_session_meta(&meta);
                let snap = self.snapshot();
                Self::emit_state(&app, &snap);
                Ok(snap)
            }
            Err(e) => {
                client.kill().await;
                {
                    let mut n = self.active_count.lock();
                    *n = n.saturating_sub(1);
                }
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        let _ = s.fsm.connect_failed(e);
                    }
                }
                let snap = self.snapshot();
                Self::emit_state(&app, &snap);
                Ok(snap)
            }
        }
    }

    async fn connect_mock(
        self: &Arc<Self>,
        app: AppHandle,
        mode: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        let mode = match mode.as_deref() {
            Some("fail_cli_not_found") => MockConnectMode::FailCliNotFound,
            _ => MockConnectMode::Success,
        };
        tokio::time::sleep(Duration::from_millis(80)).await;
        match mode {
            MockConnectMode::Success => {
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        let _ = s.fsm.handshake_ok();
                        s.backend = "mock_acp".into();
                    }
                }
                let snap = self.snapshot();
                Self::emit_state(&app, &snap);
                Ok(snap)
            }
            MockConnectMode::FailCliNotFound => {
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        let _ = s.fsm.connect_failed(AgentError::new(
                            AgentErrorCode::CliNotFound,
                            "Mock: CLI not found (GROK_APP_ACP=mock demo)",
                        ));
                        s.backend = "mock_acp".into();
                    }
                }
                let snap = self.snapshot();
                Self::emit_state(&app, &snap);
                Ok(snap)
            }
        }
    }

    async fn handle_acp_event(self: &Arc<Self>, app: &AppHandle, ev: AcpEvent) {
        match ev {
            AcpEvent::Stream {
                kind,
                text,
                message_id,
                done,
            } => {
                let (app_sid, mid) = {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        if s.streaming_message_id.is_none() {
                            s.streaming_message_id =
                                Some(message_id.unwrap_or_else(|| Uuid::new_v4().to_string()));
                        }
                        match kind {
                            StreamKind::Assistant => s.stream_buf.push_str(&text),
                            StreamKind::Thought => s.stream_thought.push_str(&text),
                        }
                        (
                            s.app_session_id.clone(),
                            s.streaming_message_id.clone().unwrap_or_default(),
                        )
                    } else {
                        return;
                    }
                };
                let payload = serde_json::json!({
                    "sessionId": app_sid,
                    "messageId": mid,
                    "text": text,
                    "done": done,
                    "kind": match kind {
                        StreamKind::Assistant => "assistant",
                        StreamKind::Thought => "thought",
                    }
                });
                let _ = app.emit("session://stream", payload);
            }
            AcpEvent::PromptComplete { stop_reason: _ } => {
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        // Persist assistant turn to independent session store
                        if !s.stream_buf.is_empty() || !s.stream_thought.is_empty() {
                            let mid = s
                                .streaming_message_id
                                .clone()
                                .unwrap_or_else(|| Uuid::new_v4().to_string());
                            let _ = store::append_message(
                                &s.app_session_id,
                                ChatMessageStored {
                                    id: mid,
                                    role: "assistant".into(),
                                    content: s.stream_buf.clone(),
                                    thought: if s.stream_thought.is_empty() {
                                        None
                                    } else {
                                        Some(s.stream_thought.clone())
                                    },
                                    created_at: chrono::Utc::now(),
                                },
                            );
                            s.meta.updated_at = chrono::Utc::now();
                            let _ = store::update_session_meta(&s.meta);
                        }
                        s.stream_buf.clear();
                        s.stream_thought.clear();
                        if s.fsm.state() == SessionState::Streaming
                            || s.fsm.state() == SessionState::AwaitingPermission
                        {
                            let _ = s.fsm.end_stream();
                        }
                        s.streaming_message_id = None;
                    }
                }
                Self::emit_state(app, &self.snapshot());
            }
            AcpEvent::PermissionRequest {
                rpc_id,
                tool_call_id,
                tool_name,
                title,
                options,
                raw,
            } => {
                let preview = raw.to_string();
                let path_target = extract_path_target(&raw);
                let sk_source = if path_target.is_empty() {
                    title.clone()
                } else {
                    path_target.clone()
                };
                let sk = scope_key(&tool_name, &sk_source);
                let (auto, auto_deny, session_id, project_path) = {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        let _ = s.fsm.await_permission();
                        // Re-read settings so mid-session chip changes apply without reconnect
                        let live = PermissionPolicy::parse(
                            &store::load_settings().permission_policy,
                        );
                        s.policy = live;
                        let root = s
                            .project_path
                            .as_ref()
                            .map(std::path::PathBuf::from);
                        let auto = may_auto_allow(
                            s.policy,
                            &s.allow_cache,
                            &sk,
                            root.as_deref(),
                            &path_target,
                            &tool_name,
                        );
                        let auto_deny = !auto && may_auto_deny(s.policy);
                        (
                            auto,
                            auto_deny,
                            s.app_session_id.clone(),
                            s.project_path.clone(),
                        )
                    } else {
                        return;
                    }
                };
                let _ = project_path; // reserved for future UI badge
                if auto {
                    let acp = self.inner.lock().as_ref().and_then(|s| s.acp.clone());
                    if let Some(acp) = acp {
                        let option_id = pick_option_id(&options, "allow_once")
                            .or_else(|| pick_option_id(&options, "allow_always"))
                            .or_else(|| pick_option_id(&options, "allow"))
                            .unwrap_or_else(|| "allow-once".into());
                        let _ = acp
                            .respond_permission(
                                rpc_id,
                                PermissionOutcome::Selected { option_id },
                            )
                            .await;
                        let mut guard = self.inner.lock();
                        if let Some(s) = guard.as_mut() {
                            if s.fsm.state() == SessionState::AwaitingPermission {
                                let _ = s.fsm.permission_resolved_continue();
                            }
                        }
                    }
                } else if auto_deny {
                    let acp = self.inner.lock().as_ref().and_then(|s| s.acp.clone());
                    if let Some(acp) = acp {
                        let option_id = pick_option_id(&options, "reject_once")
                            .or_else(|| pick_option_id(&options, "reject"))
                            .or_else(|| pick_option_id(&options, "deny"))
                            .unwrap_or_else(|| "reject-once".into());
                        let _ = acp
                            .respond_permission(
                                rpc_id,
                                PermissionOutcome::Selected { option_id },
                            )
                            .await;
                        let mut guard = self.inner.lock();
                        if let Some(s) = guard.as_mut() {
                            if s.fsm.state() == SessionState::AwaitingPermission {
                                let _ = s.fsm.permission_resolved_continue();
                            }
                        }
                    }
                } else {
                    let req = UiPermissionRequest {
                        rpc_id,
                        session_id,
                        tool_call_id,
                        tool_name,
                        title,
                        preview: preview.chars().take(2000).collect(),
                        scope_key: sk,
                        options,
                    };
                    let _ = app.emit("session://permission", &req);
                    Self::emit_state(app, &self.snapshot());
                }
            }
            AcpEvent::ToolCall {
                tool_call_id,
                title,
                kind,
                status,
                raw: _,
            } => {
                let _ = app.emit(
                    "session://tool",
                    serde_json::json!({
                        "toolCallId": tool_call_id,
                        "title": title,
                        "kind": kind,
                        "status": status,
                    }),
                );
            }
            AcpEvent::Plan { entries } => {
                let _ = app.emit("session://plan", serde_json::json!({ "entries": entries }));
            }
            AcpEvent::Error { error } => {
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        let _ = s.fsm.fail_with(error);
                    }
                }
                Self::emit_state(app, &self.snapshot());
            }
            AcpEvent::ProcessExited { .. } => {
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        // During Connecting, leave error to initialize/connect_failed
                        // (fail_all_pending already surfaces a richer stderr-backed message).
                        let has_err = s.fsm.last_error().is_some();
                        let st = s.fsm.state();
                        if !has_err
                            && matches!(
                                st,
                                SessionState::Ready
                                    | SessionState::Streaming
                                    | SessionState::AwaitingPermission
                            )
                        {
                            let _ = s.fsm.crash("Agent process exited");
                        }
                    }
                }
                {
                    let mut n = self.active_count.lock();
                    *n = n.saturating_sub(1);
                }
                Self::emit_state(app, &self.snapshot());
            }
            AcpEvent::State {
                backend,
                agent_session_id,
                model_id,
            } => {
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        s.backend = backend;
                        if let Some(id) = agent_session_id {
                            s.meta.agent_session_id = Some(id);
                        }
                        if model_id.is_some() {
                            s.model_id = model_id;
                        }
                    }
                }
                Self::emit_state(app, &self.snapshot());
            }
            AcpEvent::Stderr { line } => {
                let _ = app.emit("session://stderr", serde_json::json!({ "line": line }));
            }
        }
    }

    pub async fn send_message(
        self: &Arc<Self>,
        app: AppHandle,
        text: String,
    ) -> Result<SessionSnapshot, String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("empty message".into());
        }

        let (backend, app_sid, acp) = {
            let mut guard = self.inner.lock();
            let s = guard.as_mut().ok_or("no active session")?;
            s.fsm.begin_stream().map_err(|e| e.to_string())?;
            let mid = Uuid::new_v4().to_string();
            s.streaming_message_id = Some(mid.clone());
            s.stream_buf.clear();
            s.stream_thought.clear();
            // persist user message
            let _ = store::append_message(
                &s.app_session_id,
                ChatMessageStored {
                    id: Uuid::new_v4().to_string(),
                    role: "user".into(),
                    content: text.clone(),
                    thought: None,
                    created_at: chrono::Utc::now(),
                },
            );
            (
                s.backend.clone(),
                s.app_session_id.clone(),
                s.acp.clone(),
            )
        };
        Self::emit_state(&app, &self.snapshot());

        if backend == "mock_acp" || AcpClient::use_mock() {
            let message_id = self
                .inner
                .lock()
                .as_ref()
                .and_then(|s| s.streaming_message_id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let mgr = Arc::clone(self);
            let app_done = app.clone();
            let handle = mock_acp::spawn_fake_stream(
                app_sid,
                message_id,
                text,
                Duration::from_millis(25),
                move |chunk: StreamChunk| {
                    let _ = app_done.emit(
                        "session://stream",
                        serde_json::json!({
                            "sessionId": chunk.session_id,
                            "messageId": chunk.message_id,
                            "text": chunk.text,
                            "done": chunk.done,
                            "kind": "assistant"
                        }),
                    );
                    if chunk.done {
                        let mut guard = mgr.inner.lock();
                        if let Some(s) = guard.as_mut() {
                            s.stream_buf.push_str(&chunk.text);
                            if !s.stream_buf.is_empty() {
                                let mid = s
                                    .streaming_message_id
                                    .clone()
                                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                                let _ = store::append_message(
                                    &s.app_session_id,
                                    ChatMessageStored {
                                        id: mid,
                                        role: "assistant".into(),
                                        content: s.stream_buf.clone(),
                                        thought: None,
                                        created_at: chrono::Utc::now(),
                                    },
                                );
                            }
                            s.stream_buf.clear();
                            if s.fsm.state() == SessionState::Streaming {
                                let _ = s.fsm.end_stream();
                                s.streaming_message_id = None;
                            }
                        }
                        drop(guard);
                        SessionManager::emit_state(&app_done, &mgr.snapshot());
                    } else {
                        let mut guard = mgr.inner.lock();
                        if let Some(s) = guard.as_mut() {
                            s.stream_buf.push_str(&chunk.text);
                        }
                    }
                },
            );
            if let Some(s) = self.inner.lock().as_mut() {
                s.mock_stream = Some(handle);
            }
            return Ok(self.snapshot());
        }

        let acp = acp.ok_or("ACP client missing")?;
        let mgr = Arc::clone(self);
        let app2 = app.clone();
        tokio::spawn(async move {
            if let Err(e) = acp.prompt(&text).await {
                {
                    let mut guard = mgr.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        // Preserve classified code (e.g. NETWORK_PROVIDER on rpc timeout)
                        // instead of forcing AGENT_CRASHED.
                        let _ = s.fsm.fail_with(e);
                    }
                }
                SessionManager::emit_state(&app2, &mgr.snapshot());
            }
        });

        Ok(self.snapshot())
    }

    pub async fn stop(self: &Arc<Self>, app: AppHandle) -> Result<SessionSnapshot, String> {
        let acp = {
            let mut guard = self.inner.lock();
            let s = guard.as_mut().ok_or("no active session")?;
            if let Some(h) = s.mock_stream.take() {
                h.request_stop();
            }
            if s.fsm.state() == SessionState::Streaming
                || s.fsm.state() == SessionState::AwaitingPermission
            {
                let _ = s.fsm.end_stream();
            }
            s.streaming_message_id = None;
            s.acp.clone()
        };
        if let Some(acp) = acp {
            let _ = acp.cancel().await;
        }
        let snap = self.snapshot();
        Self::emit_state(&app, &snap);
        Ok(snap)
    }

    /// Update live session permission policy (chip / settings) without reconnect.
    pub fn set_permission_policy(&self, policy: PermissionPolicy) {
        if let Some(s) = self.inner.lock().as_mut() {
            s.policy = policy;
        }
    }

    pub async fn resolve_permission(
        self: &Arc<Self>,
        app: AppHandle,
        rpc_id: u64,
        decision: String,
        option_id: Option<String>,
        scope: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        let acp = {
            let mut guard = self.inner.lock();
            let s = guard.as_mut().ok_or("no session")?;
            // "allow_session" decision caches scope_key for H05 (works under Ask chip too)
            if decision == "allow_session" || decision == "allow_for_session" {
                if let Some(sk) = scope {
                    s.allow_cache.allow(sk);
                }
            }
            if s.fsm.state() == SessionState::AwaitingPermission {
                let _ = s.fsm.permission_resolved_continue();
            }
            s.acp.clone()
        };

        if let Some(acp) = acp {
            let outcome = match decision.as_str() {
                "cancel" => PermissionOutcome::Cancelled,
                "deny" => PermissionOutcome::Selected {
                    option_id: option_id.unwrap_or_else(|| "reject-once".into()),
                },
                _ => PermissionOutcome::Selected {
                    // Prefer client-supplied optionId from Agent options list
                    option_id: option_id.unwrap_or_else(|| "allow-once".into()),
                },
            };
            acp.respond_permission(rpc_id, outcome)
                .await
                .map_err(|e| e)?;
        }
        let snap = self.snapshot();
        Self::emit_state(&app, &snap);
        Ok(snap)
    }

    async fn disconnect_inner(&self, app: &AppHandle) {
        let acp = {
            let mut guard = self.inner.lock();
            if let Some(mut s) = guard.take() {
                if let Some(h) = s.mock_stream.take() {
                    h.request_stop();
                }
                s.acp.take()
            } else {
                None
            }
        };
        if let Some(acp) = acp {
            acp.kill().await;
            let mut n = self.active_count.lock();
            *n = n.saturating_sub(1);
        }
        Self::emit_state(app, &self.snapshot());
    }

    pub async fn disconnect(self: &Arc<Self>, app: AppHandle) -> Result<SessionSnapshot, String> {
        self.disconnect_inner(&app).await;
        Ok(self.snapshot())
    }

    pub async fn reattach(self: &Arc<Self>, app: AppHandle) -> Result<SessionSnapshot, String> {
        let (project, sid) = {
            let guard = self.inner.lock();
            match guard.as_ref() {
                Some(s) => (s.project_path.clone(), Some(s.app_session_id.clone())),
                None => (None, None),
            }
        };
        self.connect(app, project, sid, None).await
    }
}
