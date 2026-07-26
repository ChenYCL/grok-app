//! Agent process concurrency + idle recycle policy (I02 / I03).
//!
//! Pure helpers are unit-tested; SessionManager applies them at runtime.

use std::time::{Duration, Instant};

/// Spec default: warm agent processes kept for open chats.
/// Desktop machines can run more than a handful; idle parked are reclaimed first.
pub const DEFAULT_MAX_CONCURRENT_AGENTS: u32 = 8;
/// Spec default: recycle after ~30 minutes idle.
pub const DEFAULT_AGENT_IDLE_MINUTES: u32 = 30;

/// Hard clamp for settings (avoid 0 / absurd values).
/// Room for multi-session parallel turns on a workstation.
pub const MAX_CONCURRENT_AGENTS_CAP: u32 = 32;
pub const MIN_CONCURRENT_AGENTS: u32 = 1;
pub const MAX_IDLE_MINUTES_CAP: u32 = 24 * 60;
pub const MIN_IDLE_MINUTES: u32 = 1;

/// Pool size shipped before the multi-session rework (default 3, cap 8).
/// Installs from that era persisted `3` into `settings.json`, so raising
/// `DEFAULT_MAX_CONCURRENT_AGENTS` alone left them capped at three warm agents
/// — two chats plus one warm prefetch was enough to trip the limit.
pub const LEGACY_DEFAULT_MAX_CONCURRENT_AGENTS: u32 = 3;

/// Normalize user/settings value for max concurrent agent processes.
pub fn normalize_max_concurrent(raw: u32) -> u32 {
    raw.clamp(MIN_CONCURRENT_AGENTS, MAX_CONCURRENT_AGENTS_CAP)
}

/// One-time migration of a persisted pool size.
///
/// Only lifts the value when it is exactly the **legacy default** and the
/// migration has not run yet — a deliberate `3` set after the migration is
/// preserved, and any other value is never touched.
pub fn migrate_max_concurrent(stored: u32, already_migrated: bool) -> Option<u32> {
    if already_migrated {
        return None;
    }
    if stored == LEGACY_DEFAULT_MAX_CONCURRENT_AGENTS {
        return Some(DEFAULT_MAX_CONCURRENT_AGENTS);
    }
    None
}

/// Normalize idle recycle window (minutes).
pub fn normalize_idle_minutes(raw: u32) -> u32 {
    raw.clamp(MIN_IDLE_MINUTES, MAX_IDLE_MINUTES_CAP)
}

/// Idle duration from settings minutes.
pub fn idle_duration(idle_minutes: u32) -> Duration {
    Duration::from_secs(u64::from(normalize_idle_minutes(idle_minutes)) * 60)
}

/// Instant when an agent with `last_activity` becomes eligible for idle recycle.
pub fn idle_deadline(last_activity: Instant, idle_minutes: u32) -> Instant {
    last_activity + idle_duration(idle_minutes)
}

/// True when `now` is at or past the idle deadline.
pub fn is_idle_expired(last_activity: Instant, idle_minutes: u32, now: Instant) -> bool {
    now >= idle_deadline(last_activity, idle_minutes)
}

/// Whether a new process may be spawned given current live/parked count.
pub fn can_spawn_process(active_processes: u32, max_concurrent: u32) -> bool {
    active_processes < normalize_max_concurrent(max_concurrent)
}

/// How many processes must be recycled before a spawn is allowed.
pub fn processes_over_capacity(active_processes: u32, max_concurrent: u32) -> u32 {
    let max = normalize_max_concurrent(max_concurrent);
    active_processes.saturating_sub(max)
}

/// How many parked (idle) slots to free so one new process can spawn.
/// When already at capacity, free at least 1 parked agent.
pub fn parked_slots_to_free_for_spawn(active_processes: u32, max_concurrent: u32) -> u32 {
    let max = normalize_max_concurrent(max_concurrent);
    if active_processes < max {
        return 0;
    }
    // Need active < max after free → free (active - max + 1)
    active_processes.saturating_sub(max).saturating_add(1)
}

/// Human-readable limit message (English; UI maps code via i18n).
pub fn process_limit_message(max_concurrent: u32) -> String {
    let max = normalize_max_concurrent(max_concurrent);
    format!(
        "Agent process limit reached (max {max} concurrent). Idle parked chats were already reclaimed; stop a running turn or raise the limit in Settings → Runtime → Process pool."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_clamps_concurrent() {
        assert_eq!(normalize_max_concurrent(0), 1);
        assert_eq!(normalize_max_concurrent(3), 3);
        assert_eq!(normalize_max_concurrent(99), MAX_CONCURRENT_AGENTS_CAP);
    }

    #[test]
    fn normalize_clamps_idle_minutes() {
        assert_eq!(normalize_idle_minutes(0), 1);
        assert_eq!(normalize_idle_minutes(30), 30);
        assert_eq!(normalize_idle_minutes(99_999), MAX_IDLE_MINUTES_CAP);
    }

    #[test]
    fn idle_deadline_is_activity_plus_window() {
        let t0 = Instant::now();
        let d = idle_deadline(t0, 30);
        assert_eq!(d.duration_since(t0), Duration::from_secs(30 * 60));
    }

    #[test]
    fn idle_not_expired_before_deadline() {
        let t0 = Instant::now();
        let now = t0 + Duration::from_secs(10 * 60);
        assert!(!is_idle_expired(t0, 30, now));
    }

    #[test]
    fn idle_expired_at_and_after_deadline() {
        let t0 = Instant::now();
        let at = t0 + Duration::from_secs(30 * 60);
        let after = at + Duration::from_secs(1);
        assert!(is_idle_expired(t0, 30, at));
        assert!(is_idle_expired(t0, 30, after));
    }

    #[test]
    fn short_idle_window_expires_quickly() {
        let t0 = Instant::now();
        // 1 minute minimum
        assert!(!is_idle_expired(t0, 1, t0 + Duration::from_secs(59)));
        assert!(is_idle_expired(t0, 1, t0 + Duration::from_secs(60)));
    }

    #[test]
    fn can_spawn_respects_capacity() {
        assert!(can_spawn_process(0, 3));
        assert!(can_spawn_process(2, 3));
        assert!(!can_spawn_process(3, 3));
        assert!(!can_spawn_process(4, 3));
        // raw 0 normalizes to 1
        assert!(can_spawn_process(0, 0));
        assert!(!can_spawn_process(1, 0));
    }

    #[test]
    fn over_capacity_count() {
        assert_eq!(processes_over_capacity(2, 3), 0);
        assert_eq!(processes_over_capacity(3, 3), 0);
        assert_eq!(processes_over_capacity(5, 3), 2);
    }

    #[test]
    fn parked_slots_to_free_for_spawn_at_capacity() {
        assert_eq!(parked_slots_to_free_for_spawn(0, 8), 0);
        assert_eq!(parked_slots_to_free_for_spawn(7, 8), 0);
        assert_eq!(parked_slots_to_free_for_spawn(8, 8), 1);
        assert_eq!(parked_slots_to_free_for_spawn(10, 8), 3);
    }

    #[test]
    fn process_limit_message_includes_max() {
        let m = process_limit_message(8);
        assert!(m.contains('8'), "{m}");
    }

    #[test]
    fn migrates_legacy_default_pool_size_once() {
        // Stuck at the old default → lifted to the new one.
        assert_eq!(
            migrate_max_concurrent(LEGACY_DEFAULT_MAX_CONCURRENT_AGENTS, false),
            Some(DEFAULT_MAX_CONCURRENT_AGENTS)
        );
        // Runs once: a deliberate 3 set afterwards survives.
        assert_eq!(
            migrate_max_concurrent(LEGACY_DEFAULT_MAX_CONCURRENT_AGENTS, true),
            None
        );
        // Any other explicit choice is never rewritten.
        assert_eq!(migrate_max_concurrent(1, false), None);
        assert_eq!(migrate_max_concurrent(4, false), None);
        assert_eq!(migrate_max_concurrent(16, false), None);
    }

    #[test]
    fn defaults_match_spec() {
        assert_eq!(DEFAULT_MAX_CONCURRENT_AGENTS, 8);
        assert_eq!(DEFAULT_AGENT_IDLE_MINUTES, 30);
        assert_eq!(MAX_CONCURRENT_AGENTS_CAP, 32);
    }

    #[test]
    fn normalize_allows_workstation_caps() {
        assert_eq!(normalize_max_concurrent(16), 16);
        assert_eq!(normalize_max_concurrent(99), MAX_CONCURRENT_AGENTS_CAP);
    }
}
