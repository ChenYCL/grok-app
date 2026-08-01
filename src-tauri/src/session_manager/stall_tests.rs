//! Stall heal and tool identity tests.
#![cfg(test)]

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::journal_throttle::JournalWriteThrottle;
use crate::permission::{PermissionPolicy, SessionAllowCache};
use crate::session_fsm::{SessionFsm, SessionState};
use crate::store::SessionMeta;

use super::*;

use serde_json::json;

/// Isolate store writes (`force_end` → journal/meta) from the real app home.
/// Without this, stall heal tests once rewrote production `sessions_index.json`.
fn with_temp_app_home<R>(f: impl FnOnce() -> R) -> R {
    let _lock = crate::paths::APP_HOME_ENV_LOCK.lock().unwrap();
    let tmp = std::env::temp_dir().join(format!(
        "grok-app-stall-test-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("tmp home");
    std::env::set_var("GROK_APP_HOME", &tmp);
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    std::env::remove_var("GROK_APP_HOME");
    let _ = std::fs::remove_dir_all(&tmp);
    match out {
        Ok(v) => v,
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

fn streaming_session(now: Instant, mut patch: impl FnMut(&mut LiveSession)) -> LiveSession {
    let mut fsm = SessionFsm::new();
    let _ = fsm.start_connect();
    let _ = fsm.handshake_ok();
    let _ = fsm.begin_stream();
    let mut s = LiveSession {
        app_session_id: "stall-session".into(),
        process_id: "process-stall".into(),
        meta: SessionMeta {
            id: "stall-session".into(),
            project_id: None,
            title: "Stall".into(),
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
        streaming_message_id: Some("msg-1".into()),
        active_turn_id: Some("turn-1".into()),
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
        deferred_prompt_complete: None,
        tools_this_turn: 0,
        saw_model_output: false,
        prompt_in_flight: true,
        pending_stream_emit: None,
        stream_emit_flush_gen: 0,
        last_tool_heartbeat_emit: None,
    };
    patch(&mut s);
    s
}

#[test]
fn maybe_done_soft_silence_force_ends_even_when_prompt_in_flight() {
    // Repro: X search tools finished + partial assistant text; model hung
    // on final loop with prompt_in_flight=true. Soft silence must Ready.
    with_temp_app_home(|| {
        let t0 = Instant::now();
        let mut s = streaming_session(t0, |s| {
            s.saw_model_output = true;
            s.stream_buf = "搜到了不少最新动态…".into();
            s.tools_this_turn = 4;
            s.prompt_in_flight = true;
            s.last_stream_progress = t0;
        });
        let now = t0 + Duration::from_secs(180);
        let action = SessionManager::tick_stream_stall_on_session(&mut s, None, 180, now);
        match action {
            Some(StallTickAction::HardEnded {
                reason: "maybe_done_stall_heal",
                stall_seconds: 180,
                ..
            }) => {}
            other => panic!("expected maybe_done hard end, got {other:?}"),
        }
        assert_eq!(s.fsm.state(), SessionState::Ready);
        assert!(!s.prompt_in_flight);
        assert!(s.streaming_message_id.is_none());
    });
}

#[test]
fn no_auto_end_without_this_turn_body() {
    // Prior tools only — wait for soft banner / hard window, don't assume done.
    with_temp_app_home(|| {
        let t0 = Instant::now();
        let mut s = streaming_session(t0, |s| {
            s.tools_this_turn = 2;
            s.prompt_in_flight = true;
            s.last_stream_progress = t0;
        });
        let now = t0 + Duration::from_secs(180);
        let action = SessionManager::tick_stream_stall_on_session(&mut s, None, 180, now);
        match action {
            Some(StallTickAction::SoftStall { .. }) => {}
            other => panic!("expected soft stall without body, got {other:?}"),
        }
        assert_eq!(s.fsm.state(), SessionState::Streaming);
        assert!(s.prompt_in_flight);
    });
}

#[test]
fn orphan_open_tools_pruned_then_maybe_done_auto_end() {
    // Leaked open tool ids age out (TOOL_ORPHAN_SECONDS); then maybe-done
    // heal can fire. Matches hung model after tools that never closed cleanly.
    with_temp_app_home(|| {
        let t0 = Instant::now();
        let mut s = streaming_session(t0, |s| {
            s.saw_model_output = true;
            s.open_tool_ids.insert("call_1".into());
            s.open_tool_seen_at.insert("call_1".into(), t0);
            s.tools_this_turn = 1;
            s.prompt_in_flight = true;
            s.last_stream_progress = t0;
        });
        let now = t0 + Duration::from_secs(180);
        let action = SessionManager::tick_stream_stall_on_session(&mut s, None, 180, now);
        match action {
            Some(StallTickAction::HardEnded {
                reason: "maybe_done_stall_heal",
                ..
            }) => {}
            other => panic!("expected maybe_done after orphan prune, got {other:?}"),
        }
        assert!(s.open_tool_ids.is_empty());
        assert_eq!(s.fsm.state(), SessionState::Ready);
    });
}

#[test]
fn enrich_recovers_mcp_tool_name_from_sparse_completed() {
    let raw = json!({
        "status": "completed",
        "rawOutput": {
            "type": "MCP",
            "tool_name": "x_keyword_search",
            "server_name": "official-aux",
        },
        "rawInput": {
            "variant": "UseTool",
            "tool_name": "official-aux__x_keyword_search",
        },
        "_meta": {
            "x.ai/tool": { "name": "use_tool", "kind": "use_tool" }
        }
    });
    let (kind, title) = enrich_tool_identity_from_raw(&raw, "", "");
    assert!(
        title.contains("x_keyword_search") || title.contains("official-aux"),
        "title={title}"
    );
    assert_ne!(kind, "");
    assert_ne!(title.to_ascii_lowercase(), "tool");
}

#[test]
fn enrich_recovers_search_tool_from_variant() {
    let raw = json!({
        "status": "completed",
        "rawInput": { "variant": "SearchTool", "query": "twitter x search posts" },
        "_meta": { "x.ai/tool": { "name": "search_tool" } }
    });
    let (kind, title) = enrich_tool_identity_from_raw(&raw, "", "other");
    assert_eq!(kind, "search_tool");
    assert!(
        title.contains("search") || title.contains("twitter"),
        "title={title}"
    );
}

