//! Media path extract tests.
#![cfg(test)]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::acp_client::{
    should_abort_provider_retry, AcpClient, AcpEvent, AskUserOutcome, PermissionOutcome,
    StreamKind, HOST_PROVIDER_MAX_RETRIES,
};
use crate::cli_probe;
use crate::error::{AgentError, AgentErrorCode};
use crate::journal_throttle::{is_paragraph_break, JournalWriteThrottle};
use crate::stream_emit::{
    should_flush_stream_emit, stream_emit_can_merge, DEFAULT_STREAM_EMIT_MAX_CHARS,
    DEFAULT_STREAM_EMIT_MS,
};
use crate::tool_heartbeat::should_emit_tool_heartbeat;
use crate::mock_acp::{self, MockConnectMode, MockStreamHandle, StreamChunk};
use crate::permission::{
    extract_path_target, extract_shell_command, may_auto_allow, may_auto_deny, pick_option_id,
    scope_key, PermissionPolicy, SessionAllowCache,
};
use crate::process_limits::{
    can_spawn_process, is_idle_expired, normalize_idle_minutes, normalize_max_concurrent,
    parked_slots_to_free_for_spawn, process_limit_message,
};
use crate::session_fsm::{SessionFsm, SessionState};
use crate::store::{self, ChatMessageStored, MessageAttachmentStored, SessionMeta};
use crate::stream_stall::{
    hard_stall_seconds, is_hard_stalled, is_stream_stalled, journal_tool_is_terminal,
    normalize_stream_stall_seconds, should_auto_end_maybe_done, should_emit_soft_stall,
    should_prune_open_tool_id, stall_tier_from_evidence, stream_stall_message, StallTier,
};
use crate::turn_complete::{
    is_terminal_tool_status, note_tool_open_status, release_tool_from_open,
    should_defer_prompt_complete,
};

use super::*;


use serde_json::json;

#[test]
fn extracts_backtick_path_from_mcp_okay_output() {
    let raw = json!({
        "status": "completed",
        "rawOutput": {
            "type": "MCP",
            "tool_name": "image_edit",
            "server_name": "official-aux",
            "output": {
                "OkayOutput": "已完成 image_edit。\n\n**输出文件路径：**\n\n`/tmp/demo/images/1.jpg`\n\n（会话内相对路径：images/1.jpg）"
            }
        }
    });
    assert_eq!(
        extract_generated_media_path(&raw).as_deref(),
        Some("/tmp/demo/images/1.jpg")
    );
}

#[test]
fn extracts_path_from_content_text_markdown() {
    let raw = json!({
        "content": [{
            "type": "content",
            "content": {
                "type": "text",
                "text": "saved to /Users/me/out/pixel.png for you"
            }
        }]
    });
    assert_eq!(
        extract_generated_media_path(&raw).as_deref(),
        Some("/Users/me/out/pixel.png")
    );
}

