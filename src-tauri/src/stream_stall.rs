//! Stream stall watchdog policy (I06).
//!
//! While a turn is streaming, pure silence (no stream chunks / tool activity)
//! past a configurable timeout first **heals** stuck Host state, then may surface
//! a soft cancel/keep-waiting prompt. Long-running tools that still emit tool
//! events must not count as stalled. Hard silence ends the turn while keeping
//! journal content (less interruption, fewer false positives).

use std::time::{Duration, Instant};

/// Soft silence window default (settings `streamStallSeconds`).
/// Raised from 120 → 180 to reduce false stalls on long tool / workflow gaps.
pub const DEFAULT_STREAM_STALL_SECONDS: u32 = 180;

/// Hard clamp for settings (avoid 0 / absurd values).
pub const MIN_STREAM_STALL_SECONDS: u32 = 15;
pub const MAX_STREAM_STALL_SECONDS: u32 = 15 * 60;

/// Open tool ids with no update for this long may be pruned if journal already
/// has a terminal `tool_step` (or after hard orphan alone for leak recovery).
pub const TOOL_ORPHAN_SECONDS: u32 = 90;

/// Max soft STREAM_STALL banners per turn (then rely on hard end only).
pub const MAX_SOFT_STALL_EMITS_PER_TURN: u32 = 1;

/// Normalize user/settings value for stream stall timeout (seconds).
pub fn normalize_stream_stall_seconds(raw: u32) -> u32 {
    raw.clamp(MIN_STREAM_STALL_SECONDS, MAX_STREAM_STALL_SECONDS)
}

/// Hard end silence: at least 10 minutes, or 3× soft window (whichever larger),
/// capped at 30 minutes.
pub fn hard_stall_seconds(soft_seconds: u32) -> u32 {
    let soft = normalize_stream_stall_seconds(soft_seconds);
    let triple = soft.saturating_mul(3);
    triple.clamp(600, 30 * 60)
}

/// Stall window from settings seconds.
pub fn stall_duration(stall_seconds: u32) -> Duration {
    Duration::from_secs(u64::from(normalize_stream_stall_seconds(stall_seconds)))
}

/// Instant when a turn with `last_progress` becomes eligible for stall UI.
pub fn stall_deadline(last_progress: Instant, stall_seconds: u32) -> Instant {
    last_progress + stall_duration(stall_seconds)
}

/// True when `now` is at or past the stall deadline.
pub fn is_stream_stalled(last_progress: Instant, stall_seconds: u32, now: Instant) -> bool {
    now >= stall_deadline(last_progress, stall_seconds)
}

/// True when silence has reached the hard end window.
pub fn is_hard_stalled(last_progress: Instant, soft_seconds: u32, now: Instant) -> bool {
    let hard = hard_stall_seconds(soft_seconds);
    now >= last_progress + Duration::from_secs(u64::from(hard))
}

/// Whether the host should emit another soft `session://stream_stall` notification.
///
/// Emits on first cross into stalled, then again every full stall window while
/// silence continues — but only while `soft_emits_this_turn < MAX`.
pub fn should_emit_stall(
    last_progress: Instant,
    last_emit: Option<Instant>,
    stall_seconds: u32,
    now: Instant,
) -> bool {
    should_emit_soft_stall(last_progress, last_emit, stall_seconds, 0, now)
}

/// Soft emit gate with per-turn cap (prefer this from the watchdog).
pub fn should_emit_soft_stall(
    last_progress: Instant,
    last_emit: Option<Instant>,
    stall_seconds: u32,
    soft_emits_this_turn: u32,
    now: Instant,
) -> bool {
    if soft_emits_this_turn >= MAX_SOFT_STALL_EMITS_PER_TURN {
        return false;
    }
    if !is_stream_stalled(last_progress, stall_seconds, now) {
        return false;
    }
    match last_emit {
        None => true,
        // Re-prompt only if we still allow another soft emit this turn.
        Some(t) => {
            soft_emits_this_turn + 1 < MAX_SOFT_STALL_EMITS_PER_TURN
                && is_stream_stalled(t, stall_seconds, now)
        }
    }
}

/// Human-readable stall message (English; UI maps via i18n).
pub fn stream_stall_message(stall_seconds: u32) -> String {
    let secs = normalize_stream_stall_seconds(stall_seconds);
    format!(
        "No stream or tool progress for about {secs}s. End this turn or keep waiting."
    )
}

/// Stall copy tier for the UI (mirrors frontend `sessionPhase` tiers).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallTier {
    /// No assistant body and no tool activity this turn.
    PreFirstToken,
    /// Tools ran, still no assistant body (or only tools for a while).
    WorkingTools,
    /// Assistant body already seen — silence mid/post answer.
    PostOutput,
    /// Journal/agent look finished; Host should heal rather than scare.
    MaybeDone,
}

impl StallTier {
    pub fn as_str(self) -> &'static str {
        match self {
            StallTier::PreFirstToken => "pre_first_token",
            StallTier::WorkingTools => "working_tools",
            StallTier::PostOutput => "post_output",
            StallTier::MaybeDone => "maybe_done",
        }
    }
}

/// Infer stall tier from turn evidence (never say pre-token if tools/body exist).
pub fn stall_tier_from_evidence(
    saw_model_output: bool,
    saw_tool_activity: bool,
    terminal_candidate: bool,
) -> StallTier {
    if terminal_candidate {
        return StallTier::MaybeDone;
    }
    if saw_model_output {
        return StallTier::PostOutput;
    }
    if saw_tool_activity {
        return StallTier::WorkingTools;
    }
    StallTier::PreFirstToken
}

/// Whether an open tool id should be pruned as orphaned.
///
/// - Journal already has a terminal step for this id → safe to drop anytime after silence.
/// - Otherwise only after `TOOL_ORPHAN_SECONDS` without updates (leak recovery).
/// Host helper: prune if journal already terminal **or** aged out with no updates.
pub fn should_prune_open_tool_id(
    last_update: Instant,
    now: Instant,
    journal_has_terminal: bool,
) -> bool {
    if journal_has_terminal {
        return true;
    }
    now.duration_since(last_update) >= Duration::from_secs(u64::from(TOOL_ORPHAN_SECONDS))
}

/// Parse journal tool row id `tool-{call_id}` + `tool_step|status|…`.
pub fn journal_tool_is_terminal(content: &str) -> bool {
    let status = content
        .strip_prefix("tool_step|")
        .and_then(|rest| rest.split('|').next())
        .unwrap_or("");
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "complete" | "failed" | "error" | "cancelled" | "canceled" | "rejected"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_clamps() {
        assert_eq!(normalize_stream_stall_seconds(0), MIN_STREAM_STALL_SECONDS);
        assert_eq!(normalize_stream_stall_seconds(180), 180);
        assert_eq!(
            normalize_stream_stall_seconds(99_999),
            MAX_STREAM_STALL_SECONDS
        );
    }

    #[test]
    fn hard_is_at_least_10_min() {
        assert_eq!(hard_stall_seconds(180), 600);
        assert_eq!(hard_stall_seconds(60), 600);
        assert_eq!(hard_stall_seconds(300), 900);
    }

    #[test]
    fn not_stalled_before_deadline() {
        let t0 = Instant::now();
        let now = t0 + Duration::from_secs(60);
        assert!(!is_stream_stalled(t0, 180, now));
    }

    #[test]
    fn stalled_at_and_after_deadline() {
        let t0 = Instant::now();
        let at = t0 + Duration::from_secs(180);
        let after = at + Duration::from_secs(1);
        assert!(is_stream_stalled(t0, 180, at));
        assert!(is_stream_stalled(t0, 180, after));
    }

    #[test]
    fn tool_progress_resets_deadline() {
        let t0 = Instant::now();
        let tool = t0 + Duration::from_secs(100);
        assert!(!is_stream_stalled(tool, 180, tool + Duration::from_secs(50)));
        assert!(is_stream_stalled(tool, 180, tool + Duration::from_secs(180)));
    }

    #[test]
    fn soft_emit_capped_once_per_turn() {
        let t0 = Instant::now();
        let stall_at = t0 + Duration::from_secs(180);
        assert!(should_emit_soft_stall(t0, None, 180, 0, stall_at));
        // Already emitted once this turn — no re-spam even after full window.
        assert!(!should_emit_soft_stall(
            t0,
            Some(stall_at),
            180,
            1,
            stall_at + Duration::from_secs(180)
        ));
    }

    #[test]
    fn tier_never_pre_token_with_tools_or_body() {
        assert_eq!(
            stall_tier_from_evidence(false, false, false),
            StallTier::PreFirstToken
        );
        assert_eq!(
            stall_tier_from_evidence(false, true, false),
            StallTier::WorkingTools
        );
        assert_eq!(
            stall_tier_from_evidence(true, true, false),
            StallTier::PostOutput
        );
        assert_eq!(
            stall_tier_from_evidence(true, false, true),
            StallTier::MaybeDone
        );
    }

    #[test]
    fn journal_terminal_parse() {
        assert!(journal_tool_is_terminal("tool_step|completed||Web search:"));
        assert!(journal_tool_is_terminal("tool_step|failed||tool"));
        assert!(!journal_tool_is_terminal("tool_step|in_progress||tool"));
    }

    #[test]
    fn prune_when_journal_terminal() {
        let t0 = Instant::now();
        assert!(should_prune_open_tool_id(t0, t0, true));
        assert!(!should_prune_open_tool_id(t0, t0, false));
        assert!(should_prune_open_tool_id(
            t0,
            t0 + Duration::from_secs(TOOL_ORPHAN_SECONDS as u64),
            false
        ));
    }

    #[test]
    fn message_includes_seconds() {
        let m = stream_stall_message(180);
        assert!(m.contains("180"), "{m}");
    }

    #[test]
    fn defaults_match_spec() {
        assert_eq!(DEFAULT_STREAM_STALL_SECONDS, 180);
        assert_eq!(MIN_STREAM_STALL_SECONDS, 15);
        assert_eq!(MAX_SOFT_STALL_EMITS_PER_TURN, 1);
    }
}
