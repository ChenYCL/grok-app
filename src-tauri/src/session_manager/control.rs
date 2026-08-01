//! Policy, model, disconnect, recycle, permission resolution.

#![allow(dead_code)] // residual-clippy: set_permission_policy / tracked counts
use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::acp_client::{AcpClient, AskUserOutcome, PermissionOutcome};
use crate::permission::PermissionPolicy;
use crate::process_limits::{normalize_idle_minutes, normalize_max_concurrent};
use crate::session_fsm::SessionState;
use crate::store::{self};

use super::*;

impl SessionManager {
    pub fn set_permission_policy(&self, policy: PermissionPolicy) {
        if let Some(s) = self.inner.lock().as_mut() {
            s.policy = policy;
        }
    }

    /// Soft-drop live agent so next send re-spawns with new spawn flags / config.
    /// Keeps `agent_session_id` so reconnect can `session/load`; if load fails,
    /// journal bootstrap still fills the gap.
    ///
    /// **Never** kills a mid-turn live session (open tools / streaming). Callers
    /// that mutate MCP/prefs while busy should wait until Ready.
    /// Background busy sessions are left untouched.
    pub async fn soft_respawn(&self, app: &AppHandle) {
        self.soft_respawn_with_reason(app, "settings").await;
    }

    /// Soft-respawn and tell the UI why the agent process was reloaded.
    pub async fn soft_respawn_with_reason(&self, app: &AppHandle, reason: &str) {
        let acp = {
            let mut guard = self.inner.lock();
            if let Some(s) = guard.as_mut() {
                if s.acp.is_none() {
                    return;
                }
                if Self::live_session_is_busy(s) {
                    tracing::warn!(
                        "soft_respawn skipped: live session mid-turn sid={} state={:?}",
                        s.app_session_id,
                        s.fsm.state()
                    );
                    return;
                }
                let acp = s.acp.take();
                // Prefer resume on next connect; bootstrap only if load fails.
                s.needs_history_bootstrap = false;
                s.fsm.soft_disconnect();
                // New process gets a new id on next connect.
                s.process_id = String::new();
                acp
            } else {
                None
            }
        };
        if let Some(acp) = acp {
            acp.kill().await;
            let _ = app.emit(
                "session://agent_soft_respawn",
                serde_json::json!({ "reason": reason }),
            );
            Self::emit_state(app, &self.snapshot());
        }
    }

    /// Counts of tracked live shell / background / parked entries (alive or not).
    /// Used by diagnostics and unit tests — not the same as `active_process_count`.
    pub fn tracked_agent_map_counts(&self) -> (usize, usize, usize) {
        let live = self.inner.lock().is_some() as usize;
        let background = self.background.lock().len();
        let parked = self.parked.lock().len();
        (live, background, parked)
    }

    /// Observable process-budget occupancy for Settings / Reliability UI.
    ///
    /// Counts only **living** ACP children (same accounting as spawn capacity).
    /// Session ids only — never secrets, titles, or paths.
    pub fn process_budget_snapshot(&self) -> crate::process_limits::ProcessBudgetSnapshot {
        let settings = store::load_settings();
        let max = normalize_max_concurrent(settings.max_concurrent_agents);
        let idle = normalize_idle_minutes(settings.agent_idle_minutes);

        let mut live_ids: Vec<String> = Vec::new();
        let live = {
            let guard = self.inner.lock();
            match guard.as_ref() {
                Some(s) if s.acp.as_ref().is_some_and(|c| c.is_alive()) => {
                    live_ids.push(s.app_session_id.clone());
                    1u32
                }
                _ => 0u32,
            }
        };

        let mut background_ids: Vec<String> = Vec::new();
        let background = {
            let bg = self.background.lock();
            for (id, s) in bg.iter() {
                if s.acp.as_ref().is_some_and(|c| c.is_alive()) {
                    background_ids.push(id.clone());
                }
            }
            background_ids.len() as u32
        };

        let mut parked_ids: Vec<String> = Vec::new();
        let parked = {
            let p = self.parked.lock();
            for (id, agent) in p.iter() {
                if agent.acp.is_alive() {
                    parked_ids.push(id.clone());
                }
            }
            parked_ids.len() as u32
        };

        crate::process_limits::ProcessBudgetSnapshot::from_counts(
            live,
            background,
            parked,
            max,
            idle,
            live_ids,
            background_ids,
            parked_ids,
        )
    }

    /// Drop every warm agent process (live + background + parked).
    ///
    /// Used when `session_data_mode` flips independent↔shared so no process keeps
    /// the previous `GROK_HOME`. App session meta + journals stay; live shell is
    /// soft-disconnected and its `agent_session_id` is cleared (old agent dirs are
    /// under a different data root — reconnect should `session/new` + bootstrap).
    /// Emits `session://agents_recycled` for UI toasts.
    pub async fn recycle_all_agents(&self, app: &AppHandle, reason: &str) {
        let drained = self.drain_all_agent_slots();
        let total = drained.acps.len();
        for acp in drained.acps {
            acp.kill().await;
        }
        tracing::info!(
            "recycle_all_agents reason={reason} killed={total} (live_shell={} bg={} parked={})",
            drained.had_live_shell as u8,
            drained.background_count,
            drained.parked_count
        );
        let _ = app.emit(
            "session://agents_recycled",
            serde_json::json!({
                "reason": reason,
                "killed": total,
                "background": drained.background_count,
                "parked": drained.parked_count,
            }),
        );
        Self::emit_state(app, &self.snapshot());
    }

    /// Take live ACP + all background/parked agents out of maps (no kill).
    /// Live shell stays (soft-disconnected, agent_session_id cleared when present).
    /// Background/parked maps are emptied.
    pub(super) fn drain_all_agent_slots(&self) -> DrainedAgents {
        let mut acps: Vec<Arc<AcpClient>> = Vec::new();
        let mut had_live_shell = false;

        // Live
        {
            let mut guard = self.inner.lock();
            if let Some(s) = guard.as_mut() {
                had_live_shell = true;
                if let Some(h) = s.mock_stream.take() {
                    h.request_stop();
                }
                // Persist any in-flight assistant text before we drop the process.
                Self::maybe_flush_stream_journal(s, true, false);
                s.stream_buf.clear();
                s.stream_thought.clear();
                s.stream_last_was_assistant = false;
                s.stream_attachments.clear();
                s.journal_throttle.reset();
                s.streaming_message_id = None;
                s.active_turn_id = None;
                s.stream_message_id_locked = false;
                s.open_tool_ids.clear();
                s.terminal_tool_ids.clear();
                s.open_tool_seen_at.clear();
                s.deferred_prompt_complete = None;
                s.tools_this_turn = 0;
                s.pending_plan_rpc_id = None;
                s.pending_ask_user_rpc_id = None;
                s.provider_retry_attempt = 0;
                s.provider_retry_aborted = false;
                if let Some(acp) = s.acp.take() {
                    acps.push(acp);
                }
                s.fsm.soft_disconnect();
                s.process_id = String::new();
                // Old agent session lives under previous GROK_HOME — do not resume.
                if s.meta.agent_session_id.take().is_some() {
                    let _ = store::update_session_meta(&s.meta);
                }
                // Connect will set bootstrap from journal when session/new runs.
                s.needs_history_bootstrap = false;
            }
        }

        // Background busy streams
        let background: HashMap<String, LiveSession> = {
            let mut bg = self.background.lock();
            std::mem::take(&mut *bg)
        };
        let background_count = background.len();
        for (_, mut s) in background {
            if let Some(h) = s.mock_stream.take() {
                h.request_stop();
            }
            Self::maybe_flush_stream_journal(&mut s, true, false);
            if let Some(acp) = s.acp.take() {
                acps.push(acp);
            }
        }

        // Parked warm agents
        let parked: HashMap<String, ParkedAgent> = {
            let mut p = self.parked.lock();
            std::mem::take(&mut *p)
        };
        let parked_count = parked.len();
        for (_, p) in parked {
            acps.push(p.acp);
        }

        DrainedAgents {
            acps,
            had_live_shell,
            background_count,
            parked_count,
        }
    }

    /// Apply permission: Host policy + agent-home config + respawn when process flags change.
    pub async fn apply_permission_policy(
        &self,
        app: &AppHandle,
        policy_str: &str,
    ) -> Result<(), String> {
        let policy = PermissionPolicy::parse(policy_str);
        let settings = store::load_settings();
        let _ = crate::agent_prefs::sync_permission_to_agent_profile(
            &settings.session_data_mode,
            policy.as_str(),
        );

        let need_respawn = {
            let mut guard = self.inner.lock();
            if let Some(s) = guard.as_mut() {
                let prev = s.policy;
                s.policy = policy;
                s.meta.permission_policy = Some(policy.as_str().into());
                let _ = store::update_session_meta(&s.meta);
                // Any policy change can affect agent-side enforcement / --always-approve.
                prev != policy && s.acp.is_some()
            } else {
                false
            }
        };
        if need_respawn {
            self.soft_respawn(app).await;
        }
        Ok(())
    }

    /// Apply model id on the live ACP session (best-effort session/set_model).
    pub async fn set_model(&self, model_id: String) -> Result<(), String> {
        let model_id = model_id.trim().to_string();
        if model_id.is_empty() {
            return Err("model id empty".into());
        }
        // Store composer preference; agent receives channel-resolved id.
        let agent_model = crate::providers::agent_spawn_model_id(&model_id);
        let acp = {
            let mut guard = self.inner.lock();
            if let Some(s) = guard.as_mut() {
                s.model_id = Some(model_id.clone());
                s.meta.model_id = Some(model_id.clone());
                let _ = store::update_session_meta(&s.meta);
                s.acp.clone()
            } else {
                None
            }
        };
        if let Some(acp) = acp {
            acp.set_model(&agent_model).await?;
        }
        Ok(())
    }

    /// Apply product mode via session/set_mode; soft-respawn if agent rejects.
    pub async fn apply_product_mode(&self, app: &AppHandle, mode: String) -> Result<(), String> {
        let mode = mode.trim().to_ascii_lowercase();
        if !matches!(mode.as_str(), "agent" | "plan" | "ask") {
            return Err(format!("invalid mode: {mode}"));
        }
        let acp = {
            let mut guard = self.inner.lock();
            if let Some(s) = guard.as_mut() {
                let same = s.product_mode.as_deref() == Some(mode.as_str());
                s.product_mode = Some(mode.clone());
                s.meta.mode = Some(mode.clone());
                let _ = store::update_session_meta(&s.meta);
                if same {
                    None
                } else {
                    s.acp.clone()
                }
            } else {
                None
            }
        };
        if let Some(acp) = acp {
            if let Err(e) = acp.set_mode(&mode).await {
                tracing::warn!("set_mode failed, soft-respawn: {e}");
                self.soft_respawn(app).await;
            }
        }
        Ok(())
    }

    /// Soft-respawn when MCP enable prefs change so the next connect injects
    /// the updated `mcpServers` set (and agent-home config is re-read).
    pub async fn apply_extensions_mcp_change(&self, app: &AppHandle) {
        let live = {
            let guard = self.inner.lock();
            guard.as_ref().map(|s| s.acp.is_some()).unwrap_or(false)
        };
        if live {
            tracing::info!("extensions: MCP prefs changed — soft-respawn live agent");
            self.soft_respawn(app).await;
        }
    }

    /// Record desired effort. CLI has no mid-session set_effort RPC; soft-drop the
    /// live agent so the next connect re-spawns with `--reasoning-effort`.
    pub async fn set_effort_and_respawn_needed(
        &self,
        app: &AppHandle,
        effort: String,
    ) -> Result<(), String> {
        let effort = effort.trim().to_string();
        // Accept CLI catalog values; unknown efforts still fail closed with a clear error.
        let ok = matches!(
            effort.as_str(),
            "low" | "medium" | "high" | "xhigh" | "max" | "none"
        ) || (effort
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && (2..=32).contains(&effort.len()));
        if !ok {
            return Err(format!("invalid effort: {effort}"));
        }
        let need = {
            let mut guard = self.inner.lock();
            if let Some(s) = guard.as_mut() {
                let same = s.effort.as_deref() == Some(effort.as_str());
                s.effort = Some(effort.clone());
                s.meta.effort = Some(effort);
                let _ = store::update_session_meta(&s.meta);
                !same && s.acp.is_some()
            } else {
                false
            }
        };
        if need {
            self.soft_respawn(app).await;
        }
        Ok(())
    }

    pub fn current_context_ids(&self) -> (Option<String>, Option<String>) {
        let guard = self.inner.lock();
        match guard.as_ref() {
            Some(s) => (s.meta.project_id.clone(), Some(s.app_session_id.clone())),
            None => (None, None),
        }
    }

    /// Answer a pending tool permission for `session_id` (defaults to live).
    ///
    /// `session_id` comes from `session://permission`; background turns raise
    /// permissions too (`session://background_permission`), and their rpc id
    /// belongs to *their* ACP child. Resolving against the live slot dropped the
    /// answer on the wrong process and left the background turn stuck forever.
    pub async fn resolve_permission(
        self: &Arc<Self>,
        app: AppHandle,
        rpc_id: u64,
        decision: String,
        option_id: Option<String>,
        scope: Option<String>,
        session_id: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        let target = self.resolve_target_session(session_id)?;
        let (acp, empty_run, project_path) = self
            .with_session_mut(&target, |s| {
                Self::touch_activity_locked(s);
                // "allow_session" decision caches scope_key for H05 (works under Ask chip too)
                if decision == "allow_session" || decision == "allow_for_session" {
                    if let Some(sk) = scope {
                        s.allow_cache.allow(sk);
                    }
                }
                if s.fsm.state() == SessionState::AwaitingPermission {
                    let _ = s.fsm.permission_resolved_continue();
                }
                // Permission cleared — may finish a deferred prompt_complete (#52).
                let empty = Self::try_finish_deferred_prompt_complete(s, Some(&app)).flatten();
                (s.acp.clone(), empty, s.project_path.clone())
            })
            .ok_or("no session")?;

        if let Some(acp) = acp {
            let outcome = match decision.as_str() {
                "cancel" => PermissionOutcome::Cancelled,
                "deny" => PermissionOutcome::Selected {
                    option_id: option_id.unwrap_or_else(|| "reject".into()),
                },
                _ => PermissionOutcome::Selected {
                    // Prefer client-supplied optionId from Agent options list
                    option_id: option_id.unwrap_or_else(|| "allow_once".into()),
                },
            };
            acp.respond_permission(rpc_id, outcome).await?;
        }
        // Cross-session permission audit (user decision). Soft-fail.
        crate::audit_ledger::record_permission_resolve(
            Some(&target),
            project_path.as_deref(),
            rpc_id,
            &decision,
        );
        self.emit_for_session(&app, &target);
        Self::emit_empty_run_if_any(&app, empty_run);
        Ok(self.snapshot())
    }

    /// Session a gate answer applies to: explicit id, else the live focus slot.
    pub(super) fn resolve_target_session(
        &self,
        session_id: Option<String>,
    ) -> Result<String, String> {
        match session_id {
            Some(sid) if !sid.is_empty() => Ok(sid),
            _ => self
                .inner
                .lock()
                .as_ref()
                .map(|s| s.app_session_id.clone())
                .ok_or_else(|| "no session".to_string()),
        }
    }

    /// Resolve pending `_x.ai/exit_plan_mode` (Approve & build / request changes / abandon).
    ///
    /// `decision`: "approved" | "cancelled" | "abandoned"
    /// Optional `feedback` is sent only with cancelled (revise).
    pub async fn resolve_plan(
        &self,
        app: AppHandle,
        decision: String,
        feedback: Option<String>,
        rpc_id: Option<u64>,
        session_id: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        let target = self.resolve_target_session(session_id)?;
        let (acp, id) = self
            .with_session_mut(&target, |s| {
                Self::touch_activity_locked(s);
                let id = rpc_id.or(s.pending_plan_rpc_id.take());
                (s.acp.clone(), id)
            })
            .ok_or("no session")?;
        let id = id.ok_or_else(|| "no pending plan approval".to_string())?;
        let acp = acp.ok_or_else(|| "ACP client missing".to_string())?;
        acp.respond_exit_plan_mode(id, &decision, feedback).await?;
        let empty_run = self
            .with_session_mut(&target, |s| {
                Self::try_finish_deferred_prompt_complete(s, Some(&app)).flatten()
            })
            .flatten();
        self.emit_for_session(&app, &target);
        Self::emit_empty_run_if_any(&app, empty_run);
        Ok(self.snapshot())
    }

    /// Resolve pending `_x.ai/ask_user_question` (answers or cancel).
    ///
    /// `decision`: "accepted" | "cancelled"
    /// `answers`: object map of question text → answer string (required for accepted).
    pub async fn resolve_ask_user(
        &self,
        app: AppHandle,
        decision: String,
        answers: Option<serde_json::Value>,
        rpc_id: Option<u64>,
        session_id: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        let target = self.resolve_target_session(session_id)?;
        let (acp, id) = self
            .with_session_mut(&target, |s| {
                let id = rpc_id.or(s.pending_ask_user_rpc_id.take());
                // Clear pending id even if rpc_id was explicit.
                if rpc_id.is_some() {
                    s.pending_ask_user_rpc_id = None;
                }
                (s.acp.clone(), id)
            })
            .ok_or("no session")?;
        let id = id.ok_or_else(|| "no pending ask_user_question".to_string())?;
        let acp = acp.ok_or_else(|| "ACP client missing".to_string())?;
        let outcome = match decision.as_str() {
            "accepted" | "answered" | "accept" => {
                let answers = answers.unwrap_or_else(|| serde_json::json!({}));
                AskUserOutcome::Accepted { answers }
            }
            _ => AskUserOutcome::Cancelled,
        };
        acp.respond_ask_user_question(id, outcome).await?;
        let empty_run = self
            .with_session_mut(&target, |s| {
                Self::try_finish_deferred_prompt_complete(s, Some(&app)).flatten()
            })
            .flatten();
        self.emit_for_session(&app, &target);
        Self::emit_empty_run_if_any(&app, empty_run);
        Ok(self.snapshot())
    }

    /// Clear the live focus slot without aborting mid-turn work.
    /// - Busy (streaming / open tools) → demote to `background` (keeps ACP + pump).
    /// - Idle Ready → warm `parked`.
    /// - Only kills when there is a leftover dead/orphan acp that could not be parked.
    pub(super) async fn disconnect_inner(&self, app: &AppHandle) {
        // Prefer demote/park over kill so "new chat" / UI clear never aborts turns.
        if let Err(e) = self.try_park_live_emit(app) {
            tracing::warn!(
                "disconnect demote/park soft-fail: {} {}",
                e.code.as_str(),
                e.message
            );
        }
        // If something is still live with a healthy acp, force another demote.
        if self
            .inner
            .lock()
            .as_ref()
            .is_some_and(|s| s.acp.as_ref().is_some_and(|c| c.is_alive()))
        {
            let _ = self.try_park_live();
        }
        // Drop empty shells only; never Drop a LiveSession that still owns acp.
        let orphan = {
            let mut guard = self.inner.lock();
            match guard.as_mut() {
                Some(s) if s.acp.as_ref().is_some_and(|c| c.is_alive()) => {
                    // Still couldn't park — last resort keep process in background.
                    tracing::warn!(
                        "disconnect: forcing background for sid={}",
                        s.app_session_id
                    );
                    drop(guard);
                    let _ = self.try_park_live();
                    None
                }
                Some(s) => {
                    if let Some(h) = s.mock_stream.take() {
                        h.request_stop();
                    }
                    let acp = s.acp.take();
                    let _ = guard.take();
                    acp
                }
                None => None,
            }
        };
        if let Some(acp) = orphan {
            // Dead / non-alive client handle only.
            if !acp.is_alive() {
                acp.kill().await;
            } else {
                // Alive but unparkable — do not kill; leave Arc drop alone would kill.
                // Re-insert as anonymous? Safer to kill only if not busy — we already
                // tried demote. Keep process alive by forgetting kill.
                tracing::warn!("disconnect: orphan alive acp left without map entry — killing");
                acp.kill().await;
            }
        }
        Self::emit_state(app, &self.snapshot());
    }

    pub async fn disconnect(self: &Arc<Self>, app: AppHandle) -> Result<SessionSnapshot, String> {
        // Clear live focus without aborting background/parked multi-session work.
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

#[cfg(test)]
mod recycle_tests {
    use super::*;

    #[test]
    fn drain_all_agent_slots_clears_empty_maps() {
        let mgr = SessionManager::new();
        assert_eq!(mgr.tracked_agent_map_counts(), (0, 0, 0));
        assert_eq!(mgr.active_process_count(), 0);

        let drained = mgr.drain_all_agent_slots();
        assert!(drained.acps.is_empty());
        assert!(!drained.had_live_shell);
        assert_eq!(drained.background_count, 0);
        assert_eq!(drained.parked_count, 0);

        // Maps stay empty; safe to call again (idempotent).
        assert_eq!(mgr.tracked_agent_map_counts(), (0, 0, 0));
        assert_eq!(mgr.active_process_count(), 0);
        let again = mgr.drain_all_agent_slots();
        assert!(again.acps.is_empty());
        assert_eq!(again.background_count, 0);
        assert_eq!(again.parked_count, 0);
    }
}
