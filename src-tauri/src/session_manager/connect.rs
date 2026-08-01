//! Session connect / mock connect / event-routing helpers.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use uuid::Uuid;

use crate::acp_client::{AcpClient, AcpEvent};
use crate::cli_probe;
use crate::error::{AgentError, AgentErrorCode};
use crate::journal_throttle::JournalWriteThrottle;
use crate::mock_acp::MockConnectMode;
use crate::permission::{PermissionPolicy, SessionAllowCache};
use crate::process_limits::{can_spawn_process, normalize_max_concurrent, process_limit_message};
use crate::session_fsm::{SessionFsm, SessionState};
use crate::store::{self};

use super::*;

impl SessionManager {
    pub async fn connect(
        self: &Arc<Self>,
        app: AppHandle,
        project_path: Option<String>,
        app_session_id: Option<String>,
        mock_mode: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        let _connect_guard = self.connect_lock.lock().await;
        self.connect_inner(app, project_path, app_session_id, mock_mode)
            .await
    }

    pub(super) async fn connect_inner(
        self: &Arc<Self>,
        app: AppHandle,
        project_path: Option<String>,
        app_session_id: Option<String>,
        mock_mode: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        let settings = store::load_settings();
        let max_concurrent = normalize_max_concurrent(settings.max_concurrent_agents);
        self.sweep_dead_parked();

        // Ensure app session meta — never panic on disk/index races.
        let mut meta = if let Some(id) = app_session_id {
            if let Some(existing) = store::load_sessions_index()
                .into_iter()
                .find(|s| s.id == id)
            {
                existing
            } else {
                store::create_session(None, Some("New chat".into()), false)
                    .map_err(|e| format!("create session: {e}"))?
            }
        } else {
            store::create_session(None, Some("New chat".into()), false)
                .map_err(|e| format!("create session: {e}"))?
        };

        // Orphan / missing project_id → keep null (shows under "其他会话").
        // Clear retired system:general bindings if any slip through.
        if meta.project_id.as_deref() == Some(store::GENERAL_PROJECT_ID)
            || meta
                .project_id
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(false)
        {
            meta.project_id = None;
            let _ = store::update_session_meta(&meta);
        }

        // Resolve cwd: explicit path → session's project path → general workspace.
        // Never use process cwd (Dock-launched macOS apps often have cwd `/`).
        let cwd = {
            let from_arg = project_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(std::path::PathBuf::from);
            let from_meta = meta.project_id.as_deref().and_then(|pid| {
                if pid == store::GENERAL_PROJECT_ID {
                    return None;
                }
                store::load_projects()
                    .into_iter()
                    .find(|p| p.id == pid)
                    .map(|p| std::path::PathBuf::from(p.path))
            });
            from_arg.or(from_meta).unwrap_or_else(|| {
                let _ = store::ensure_general_workspace_dir();
                crate::paths::general_workspace_dir()
            })
        };
        let project_path = Some(cwd.to_string_lossy().to_string());

        tracing::info!(
            target: "session",
            session = %meta.id,
            resume_agent = ?meta.agent_session_id,
            cwd = %cwd.display(),
            "connect open_start"
        );

        // Resolve model / effort / permission / mode for this project+session scope.
        let prefs =
            store::resolve_composer_prefs(meta.project_id.as_deref(), Some(meta.id.as_str()));
        let policy = PermissionPolicy::parse(&prefs.permission_policy);
        let agent_model = crate::providers::agent_spawn_model_id(&prefs.model_id);

        // Pending CLI --fork-session: must cold-spawn so open can call session/fork.
        // Never no-op / unpark a warm process that still holds the source agent id.
        let pending_fork = meta.fork_agent_session
            && meta
                .agent_session_id
                .as_deref()
                .map(str::trim)
                .is_some_and(|s| !s.is_empty());
        if pending_fork {
            // Drop live/bg/parked shells for this App session so cold spawn can fork.
            let acp_to_kill = {
                let mut guard = self.inner.lock();
                if let Some(s) = guard.as_mut() {
                    if s.app_session_id == meta.id {
                        if Self::live_session_is_busy(s) {
                            tracing::warn!(
                                "connect fork pending but live mid-turn; deferring fork sid={}",
                                meta.id
                            );
                            return Ok(self.snapshot());
                        }
                        let acp = s.acp.take();
                        s.needs_history_bootstrap = false;
                        s.fsm.soft_disconnect();
                        s.process_id = String::new();
                        acp
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            let bg_acp = self
                .background
                .lock()
                .remove(&meta.id)
                .and_then(|mut bg| bg.acp.take());
            let parked_acp = self.parked.lock().remove(&meta.id).map(|p| p.acp);
            if let Some(acp) = acp_to_kill {
                acp.kill().await;
            }
            if let Some(acp) = bg_acp {
                acp.kill().await;
            }
            if let Some(acp) = parked_acp {
                acp.kill().await;
            }
            tracing::info!(
                target: "session",
                session = %meta.id,
                "connect pending fork_agent_session — forced cold spawn"
            );
        }

        // Already live on this App session with a healthy agent → no-op.
        // Includes mid-turn (streaming / open tools): never respawn or cancel.
        // Never no-op on Disconnected/Idle — leftover busy flags after fail_with
        // must not block reconnect (see `should_preserve_live_process`).
        if !pending_fork {
            let mut guard = self.inner.lock();
            if let Some(s) = guard.as_mut() {
                if s.app_session_id == meta.id && s.acp.as_ref().is_some_and(|c| c.is_alive()) {
                    let preserve = Self::should_preserve_live_process(s);
                    let ready_match = matches!(s.fsm.state(), SessionState::Ready)
                        && !Self::live_session_is_busy(s)
                        && s.project_path == project_path
                        && s.effort.as_deref() == Some(prefs.effort.as_str());
                    if preserve || ready_match {
                        Self::touch_activity_locked(s);
                        tracing::info!(
                            "acp connect no-op: already live session={} state={:?} busy={} preserve={}",
                            meta.id,
                            s.fsm.state(),
                            Self::live_session_is_busy(s),
                            preserve
                        );
                        return Ok(self.snapshot());
                    }
                }
            }
        }

        // Target already streaming in background → promote to focus.
        if !pending_fork && self.background.lock().contains_key(&meta.id) {
            if let Err(e) = self.try_park_live_emit(&app) {
                Self::emit_process_limit(&app, Some(&meta.id), max_concurrent);
                return Err(format!("{}: {}", e.code.as_str(), e.message));
            }
            if let Some(live) = self.background.lock().remove(&meta.id) {
                *self.inner.lock() = Some(live);
                let snap = self.snapshot();
                Self::emit_state(&app, &snap);
                tracing::info!("acp promoted background session to live sid={}", meta.id);
                return Ok(snap);
            }
        }

        // Target already parked (warm multi-session) → unpark.
        if !pending_fork && self.parked.lock().contains_key(&meta.id) {
            // Park current live if needed (busy → demote to background / park).
            if let Err(e) = self.try_park_live_emit(&app) {
                Self::emit_process_limit(&app, Some(&meta.id), max_concurrent);
                return Err(format!("{}: {}", e.code.as_str(), e.message));
            }
            if let Some(live) = self.unpark_to_live(&meta.id) {
                // Refresh prefs on shell (model may have changed in UI).
                let mut live = live;
                live.model_id = Some(prefs.model_id.clone());
                live.effort = Some(prefs.effort.clone());
                live.product_mode = Some(prefs.mode.clone());
                live.policy = policy;
                live.project_path = project_path.clone();
                live.meta.model_id = Some(prefs.model_id.clone());
                live.meta.mode = Some(prefs.mode.clone());
                live.meta.effort = Some(prefs.effort.clone());
                live.meta.permission_policy = Some(prefs.permission_policy.clone());
                // Best-effort align agent process to channel prefs.
                if let Some(acp) = live.acp.clone() {
                    if let Err(e) = acp.set_model(&agent_model).await {
                        tracing::warn!("acp set_model on unpark soft-fail: {e}");
                    }
                    if let Err(e) = acp.set_mode(&prefs.mode).await {
                        tracing::warn!("acp set_mode on unpark soft-fail: {e}");
                    }
                }
                *self.inner.lock() = Some(live);
                let snap = self.snapshot();
                Self::emit_state(&app, &snap);
                tracing::info!("acp unparked warm session={}", meta.id);
                return Ok(snap);
            }
            // Parked process died — fall through to cold spawn.
        }

        // Multi-session: never steal another App session's process (no same-cwd
        // rebind). Each chat keeps its own ACP child — park Ready / background
        // busy, then unpark or cold-spawn for the target.
        {
            let live_sid = self.inner.lock().as_ref().map(|s| s.app_session_id.clone());
            if live_sid.as_deref() != Some(meta.id.as_str()) {
                if let Err(e) = self.try_park_live_emit(&app) {
                    Self::emit_process_limit(&app, Some(&meta.id), max_concurrent);
                    return Err(format!("{}: {}", e.code.as_str(), e.message));
                }
                // Never Drop a shell that still holds a live ACP — re-park/demote.
                {
                    let still_busy = self.inner.lock().as_ref().is_some_and(|s| {
                        s.acp.as_ref().is_some_and(|c| c.is_alive())
                            && (Self::live_session_is_busy(s)
                                || matches!(s.fsm.state(), SessionState::Ready))
                    });
                    if still_busy {
                        // try_park should have moved it; force another demote/park.
                        let _ = self.try_park_live();
                    }
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_ref() {
                        // Only drop empty / dead shells (no acp).
                        if s.acp.as_ref().is_none_or(|c| !c.is_alive()) {
                            let _ = guard.take();
                        } else if s.app_session_id != meta.id {
                            // Safety: never leave a foreign session in live when connecting.
                            drop(guard);
                            let _ = self.try_park_live();
                        }
                    }
                }
            } else {
                // Same session reconnect / flag change — kill any leftover process.
                // Mid-turn preserves the process (no-op above). Terminal Disconnected
                // with leftover busy flags must still tear down so the next spawn works.
                let leftover = {
                    let mut guard = self.inner.lock();
                    let preserve = guard
                        .as_ref()
                        .is_some_and(Self::should_preserve_live_process);
                    if preserve {
                        None
                    } else {
                        guard.take().and_then(|mut s| s.acp.take())
                    }
                };
                if let Some(acp) = leftover {
                    acp.kill().await;
                }
            }
            Self::emit_state(&app, &self.snapshot());
        }

        // Independent GROK_HOME: push permission into agent config before spawn so
        // dontAsk / acceptEdits / YOLO apply agent-side (not only Host).
        if let Err(e) = crate::agent_prefs::sync_permission_to_agent_profile(
            &settings.session_data_mode,
            &prefs.permission_policy,
        ) {
            tracing::warn!("sync agent permission prefs: {e}");
        }

        // Fresh process id per connect (each App session owns its ACP child).
        let process_id = Uuid::new_v4().to_string();
        {
            let mut fsm = SessionFsm::new();
            fsm.start_connect().map_err(|e| e.to_string())?;
            let now = Instant::now();
            *self.inner.lock() = Some(LiveSession {
                app_session_id: meta.id.clone(),
                process_id: process_id.clone(),
                meta: meta.clone(),
                fsm,
                backend: Self::backend_name(),
                acp: None,
                mock_stream: None,
                streaming_message_id: None,
                active_turn_id: None,
                stream_message_id_locked: false,
                stream_buf: String::new(),
                stream_thought: String::new(),
                stream_last_was_assistant: false,
                stream_attachments: Vec::new(),
                model_id: Some(prefs.model_id.clone()),
                effort: Some(prefs.effort.clone()),
                product_mode: Some(prefs.mode.clone()),
                project_path: project_path.clone(),
                allow_cache: SessionAllowCache::default(),
                policy,
                provider_retry_attempt: 0,
                provider_retry_aborted: false,
                needs_history_bootstrap: false,
                pending_plan_rpc_id: None,
                pending_ask_user_rpc_id: None,
                last_activity: now,
                last_stream_progress: now,
                last_stall_emit: None,
                stall_soft_emits: 0,
                journal_throttle: JournalWriteThrottle::with_default_interval(),
                open_tool_ids: HashSet::new(),
                open_tool_seen_at: HashMap::new(),
                terminal_tool_ids: HashSet::new(),
                deferred_prompt_complete: None,
                tools_this_turn: 0,
                saw_model_output: false,
                prompt_in_flight: false,
                pending_stream_emit: None,
                stream_emit_flush_gen: 0,
                last_tool_heartbeat_emit: None,
            });
        }
        Self::emit_state(&app, &self.snapshot());

        let use_mock = AcpClient::use_mock()
            || mock_mode.as_deref() == Some("mock")
            || mock_mode.as_deref() == Some("fail_cli_not_found");

        if use_mock {
            return self.connect_mock(app, mock_mode).await;
        }

        // Remember prior agent session for resume (before we overwrite meta).
        let resume_agent_sid = meta.agent_session_id.clone();
        let journal_has_history = store::load_messages(&meta.id).iter().any(|m| {
            (m.role == "user" || m.role == "assistant")
                && !m.content.trim().is_empty()
                && !m.is_error
        });

        // Capacity: reclaim idle parked first (they fill the pool when browsing
        // chats). Never kill background-busy turns. Live shell has no acp yet.
        self.reclaim_parked_until_can_spawn(&app, max_concurrent)
            .await;
        let active = self.active_process_count();
        let busy = self.busy_process_count();
        if !can_spawn_process(active, max_concurrent) {
            tracing::warn!(
                "process limit: cannot spawn session={} active={} busy={} parked={} max={}",
                meta.id,
                active,
                busy,
                self.parked.lock().len(),
                max_concurrent
            );
            let err = AgentError::new(
                AgentErrorCode::ProcessLimit,
                process_limit_message(max_concurrent),
            );
            {
                let mut guard = self.inner.lock();
                if let Some(s) = guard.as_mut() {
                    let _ = s.fsm.connect_failed(err.clone());
                }
            }
            Self::emit_process_limit(&app, Some(&meta.id), max_concurrent);
            let snap = self.snapshot();
            Self::emit_state(&app, &snap);
            return Ok(snap);
        }

        // Real ACP cold spawn (one process per App session — no cross-session rebind).
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
        // Effective sandbox: project override > app Settings (affects --sandbox / GROK_SANDBOX).
        let project_sandbox = meta.project_id.as_deref().and_then(|pid| {
            store::load_projects()
                .into_iter()
                .find(|p| p.id == pid)
                .and_then(|p| p.sandbox_profile)
        });
        let effective_sandbox =
            store::resolve_sandbox_profile(&settings.sandbox_profile, project_sandbox.as_deref());
        // One-shot CLI --fork-session: only when meta asks and we have a source id.
        let fork_agent = meta.fork_agent_session
            && resume_agent_sid
                .as_deref()
                .map(str::trim)
                .is_some_and(|s| !s.is_empty());
        let spawn_opts = crate::acp_client::SpawnOptions {
            model_id: Some(agent_model.clone()),
            effort: Some(prefs.effort.clone()),
            permission_policy: Some(prefs.permission_policy.clone()),
            product_mode: Some(prefs.mode.clone()),
            sandbox_profile: Some(effective_sandbox),
            json_schema: meta
                .json_schema
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            plugin_dirs: meta.plugin_dirs.clone(),
            extra_rules: crate::official_aux::merge_extra_rules(
                meta.extra_rules
                    .as_ref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty()),
            ),
            max_agent_turns: meta.max_agent_turns,
            system_prompt_override: meta
                .system_prompt_override
                .as_ref()
                .map(|s| s.to_string())
                .and_then(|s| crate::store::sanitize_system_prompt_override(Some(s))),
            no_ask_user: meta.no_ask_user,
            fork_session: fork_agent,
            grok_home_override: None,
            empty_mcp_servers: false,
        };

        let (client, mut events) = match AcpClient::spawn_with_options(cli_path, cwd, spawn_opts) {
            Ok(v) => {
                tracing::info!(
                    target: "session",
                    session = %meta.id,
                    process = %process_id,
                    fork_session = fork_agent,
                    "connect spawn_ok"
                );
                v
            }
            Err(e) => {
                tracing::warn!(
                    target: "session",
                    session = %meta.id,
                    code = e.code.as_str(),
                    error = %e.message,
                    "connect spawn_fail"
                );
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

        // Event pump tagged with process_id (multi-process routing).
        {
            let mgr = Arc::clone(self);
            let app_ev = app.clone();
            let pid = process_id.clone();
            tokio::spawn(async move {
                while let Some(ev) = events.recv().await {
                    mgr.handle_acp_event(&app_ev, &pid, ev).await;
                }
            });
        }

        tracing::info!(
            target: "session",
            session = %meta.id,
            resume_agent = ?resume_agent_sid,
            fork_session = fork_agent,
            "connect session_open_begin"
        );
        let open_result = client
            .initialize_and_open_session(resume_agent_sid.as_deref(), fork_agent)
            .await;

        // One-shot flag: clear whether fork succeeded or fell through to new/load.
        if meta.fork_agent_session {
            let _ = store::clear_session_fork_agent_session(&meta.id);
        }

        match open_result {
            Ok((agent_sid, resumed)) => {
                // Align live agent model / product mode with active channel.
                if let Err(e) = client.set_model(&agent_model).await {
                    tracing::warn!("acp set_model after session open soft-fail: {e}");
                }
                if let Err(e) = client.set_mode(&prefs.mode).await {
                    tracing::warn!("acp set_mode after session open soft-fail: {e}");
                }
                // Native resume / successful fork = full agent context. Fresh
                // session + existing UI journal → bootstrap history into the next prompt.
                let need_bootstrap = !resumed && journal_has_history;
                if resumed {
                    tracing::info!(
                        target: "session",
                        session = %meta.id,
                        agent = %agent_sid,
                        forked = fork_agent,
                        "connect session_open_ok resumed=true (full context)"
                    );
                } else if need_bootstrap {
                    tracing::info!(
                        target: "session",
                        session = %meta.id,
                        agent = %agent_sid,
                        "connect session_open_ok resumed=false; will bootstrap journal on first send"
                    );
                } else {
                    tracing::info!(
                        target: "session",
                        session = %meta.id,
                        agent = %agent_sid,
                        "connect session_open_ok resumed=false"
                    );
                }
                {
                    let mut guard = self.inner.lock();
                    if let Some(s) = guard.as_mut() {
                        let _ = s.fsm.handshake_ok();
                        s.acp = Some(client);
                        s.process_id = process_id;
                        s.meta.agent_session_id = Some(agent_sid);
                        s.meta.fork_agent_session = false;
                        s.meta.model_id = Some(prefs.model_id.clone());
                        s.meta.mode = Some(prefs.mode.clone());
                        s.meta.effort = Some(prefs.effort.clone());
                        s.meta.permission_policy = Some(prefs.permission_policy.clone());
                        s.model_id = Some(prefs.model_id.clone());
                        s.effort = Some(prefs.effort.clone());
                        s.product_mode = Some(prefs.mode.clone());
                        s.backend = "grok_agent_stdio".into();
                        s.needs_history_bootstrap = need_bootstrap;
                        Self::touch_activity_locked(s);
                        meta = s.meta.clone();
                    }
                }
                let _ = store::update_session_meta(&meta);
                let snap = self.snapshot();
                Self::emit_state(&app, &snap);
                Ok(snap)
            }
            Err(e) => {
                tracing::warn!(
                    target: "session",
                    session = %meta.id,
                    code = e.code.as_str(),
                    error = %e.message,
                    "connect session_open_fail"
                );
                client.kill().await;
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

    pub(super) async fn connect_mock(
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

    /// Move a parked agent back into `background` because its process is still
    /// emitting turn events. Parked means "idle Ready, safe to reclaim" — an
    /// agent that is still talking must never sit there, or its output is
    /// dropped (parked agents get no event routing) while the turn completes
    /// agent-side. Returns true when the session is now in `background`.
    pub(super) fn rescue_parked_to_background(&self, process_id: &str) -> Option<String> {
        let key = {
            let parked = self.parked.lock();
            parked
                .iter()
                .find(|(_, p)| p.process_id == process_id)
                .map(|(k, _)| k.clone())
        }?;
        let p = self.parked.lock().remove(&key)?;
        tracing::warn!(
            "acp rescue: parked session still streaming → background sid={} process={}",
            p.app_session_id,
            p.process_id
        );
        let mut fsm = SessionFsm::new();
        let _ = fsm.start_connect();
        let _ = fsm.handshake_ok();
        let now = Instant::now();
        let live = LiveSession {
            app_session_id: p.app_session_id.clone(),
            process_id: p.process_id,
            meta: p.meta,
            fsm,
            backend: p.backend,
            acp: Some(p.acp),
            mock_stream: None,
            streaming_message_id: None,
            active_turn_id: None,
            stream_message_id_locked: false,
            stream_buf: String::new(),
            stream_thought: String::new(),
            stream_last_was_assistant: false,
            stream_attachments: Vec::new(),
            model_id: p.model_id,
            effort: p.effort,
            product_mode: p.product_mode,
            project_path: p.project_path,
            allow_cache: SessionAllowCache::default(),
            policy: p.policy,
            provider_retry_attempt: 0,
            provider_retry_aborted: false,
            needs_history_bootstrap: p.needs_history_bootstrap,
            pending_plan_rpc_id: None,
            pending_ask_user_rpc_id: None,
            last_activity: now,
            last_stream_progress: now,
            last_stall_emit: None,
            stall_soft_emits: 0,
            journal_throttle: JournalWriteThrottle::with_default_interval(),
            open_tool_ids: HashSet::new(),
            open_tool_seen_at: HashMap::new(),
            terminal_tool_ids: HashSet::new(),
            deferred_prompt_complete: None,
            tools_this_turn: 0,
            saw_model_output: false,
            // The agent is mid-turn; keep it un-parkable until the turn ends.
            prompt_in_flight: true,
            pending_stream_emit: None,
            stream_emit_flush_gen: 0,
            last_tool_heartbeat_emit: None,
        };
        let sid = live.app_session_id.clone();
        self.background.lock().insert(sid.clone(), live);
        Some(sid)
    }

    /// Short event name for diagnostics (no payload — journals stay readable).
    pub(super) fn event_kind_name(ev: &AcpEvent) -> &'static str {
        match ev {
            AcpEvent::State { .. } => "state",
            AcpEvent::Stream { .. } => "stream",
            AcpEvent::ToolCall { .. } => "tool_call",
            AcpEvent::ToolOpenReleased { .. } => "tool_open_released",
            AcpEvent::Plan { .. } => "plan",
            AcpEvent::AskUserQuestion { .. } => "ask_user",
            AcpEvent::PermissionRequest { .. } => "permission",
            AcpEvent::PromptComplete { .. } => "prompt_complete",
            AcpEvent::RetryState { .. } => "retry_state",
            AcpEvent::ContextCompact { .. } => "context_compact",
            AcpEvent::UsageReported { .. } => "usage",
            AcpEvent::Error { .. } => "error",
            AcpEvent::ProcessExited { .. } => "process_exited",
            AcpEvent::Stderr { .. } => "stderr",
            AcpEvent::HookActivity { .. } => "hook_activity",
            AcpEvent::GoalUpdated { .. } => "goal_updated",
        }
    }

    /// Turn-bearing events must reach their session; bookkeeping ones may be dropped.
    pub(super) fn event_carries_turn_output(ev: &AcpEvent) -> bool {
        matches!(
            ev,
            AcpEvent::Stream { .. }
                | AcpEvent::ToolCall { .. }
                | AcpEvent::ToolOpenReleased { .. }
                | AcpEvent::PromptComplete { .. }
                | AcpEvent::PermissionRequest { .. }
                | AcpEvent::Plan { .. }
                | AcpEvent::AskUserQuestion { .. }
                | AcpEvent::Error { .. }
                | AcpEvent::ProcessExited { .. }
        )
    }
}

#[cfg(test)]
mod connect_preserve_tests {
    use super::*;
    use crate::store::SessionMeta;

    #[test]
    fn disconnected_never_preserves_even_when_busy_flags_stuck() {
        // Real log: `state=Disconnected busy=true` after 502 — must reconnect.
        assert!(!connect_should_preserve_live_process(
            SessionState::Disconnected,
            true
        ));
        assert!(!connect_should_preserve_live_process(
            SessionState::Idle,
            true
        ));
    }

    #[test]
    fn streaming_and_connecting_always_preserve() {
        assert!(connect_should_preserve_live_process(
            SessionState::Streaming,
            false
        ));
        assert!(connect_should_preserve_live_process(
            SessionState::AwaitingPermission,
            false
        ));
        assert!(connect_should_preserve_live_process(
            SessionState::Connecting,
            false
        ));
    }

    #[test]
    fn ready_preserves_only_when_busy() {
        assert!(connect_should_preserve_live_process(
            SessionState::Ready,
            true
        ));
        assert!(!connect_should_preserve_live_process(
            SessionState::Ready,
            false
        ));
    }

    #[test]
    fn release_failed_turn_markers_unblocks_reconnect_after_fail_with() {
        // Repro: early prompt_complete(stop=error) sets deferred while prompt RPC
        // is still in flight; then 502 fail_with → Disconnected. Before the fix,
        // deferred stayed set → live_session_is_busy + connect no-op forever.
        let mut fsm = SessionFsm::new();
        let _ = fsm.start_connect();
        let _ = fsm.handshake_ok();
        let _ = fsm.begin_stream();
        let now = Instant::now();
        let mut s = LiveSession {
            app_session_id: "session-stuck".into(),
            process_id: "process-stuck".into(),
            meta: SessionMeta {
                id: "session-stuck".into(),
                project_id: None,
                title: "Stuck".into(),
                agent_session_id: Some("agent-1".into()),
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
                model_id: None,
                archived: false,
                pinned: false,
                effort: None,
                mode: None,
                permission_policy: None,
                json_schema: None,
                scheduled: false,
                worktree_path: None,
                worktree_branch: None,
                is_worktree_session: false,
                plugin_dirs: Vec::new(),
                extra_rules: None,
                max_agent_turns: None,
                system_prompt_override: None,
                fork_agent_session: false,
                no_ask_user: None,
            },
            fsm,
            backend: "grok_agent_stdio".into(),
            acp: None,
            mock_stream: None,
            streaming_message_id: Some("a-err".into()),
            active_turn_id: Some("turn-err".into()),
            stream_message_id_locked: false,
            stream_buf: String::new(),
            stream_thought: String::new(),
            stream_last_was_assistant: false,
            stream_attachments: Vec::new(),
            model_id: None,
            effort: None,
            product_mode: None,
            project_path: Some("/tmp".into()),
            allow_cache: SessionAllowCache::default(),
            policy: PermissionPolicy::default(),
            provider_retry_attempt: 0,
            provider_retry_aborted: false,
            needs_history_bootstrap: false,
            pending_plan_rpc_id: None,
            pending_ask_user_rpc_id: None,
            last_activity: now,
            last_stream_progress: now,
            last_stall_emit: None,
            stall_soft_emits: 0,
            journal_throttle: JournalWriteThrottle::with_default_interval(),
            open_tool_ids: HashSet::new(),
            open_tool_seen_at: HashMap::new(),
            terminal_tool_ids: HashSet::new(),
            deferred_prompt_complete: Some("error".into()),
            tools_this_turn: 0,
            saw_model_output: false,
            prompt_in_flight: true,
            pending_stream_emit: None,
            stream_emit_flush_gen: 0,
            last_tool_heartbeat_emit: None,
        };

        assert!(SessionManager::live_session_is_busy(&s));
        let _ = s.fsm.fail_with(AgentError::new(
            AgentErrorCode::NetworkProvider,
            "502 Bad Gateway",
        ));
        // Fail alone leaves deferred → still "busy" under the old policy.
        assert!(SessionManager::live_session_is_busy(&s));
        assert!(!SessionManager::should_preserve_live_process(&s));

        SessionManager::release_failed_turn_markers(&mut s);
        assert!(!SessionManager::live_session_is_busy(&s));
        assert!(s.deferred_prompt_complete.is_none());
        assert!(!s.prompt_in_flight);
        assert!(s.streaming_message_id.is_none());
        assert!(!SessionManager::should_preserve_live_process(&s));
    }
}
