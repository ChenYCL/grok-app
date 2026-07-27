//! Process diagnostics logging: stderr + rolling file under app data `logs/`.
//!
//! File logs enable post-mortem of mid-turn agent exits and host timeouts
//! when the GUI process is launched from Finder (no terminal).

use std::path::PathBuf;
use std::sync::OnceLock;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Kept alive for the process lifetime so the non-blocking writer drains.
static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// Default filter when `RUST_LOG` is unset.
pub const DEFAULT_ENV_FILTER: &str = "info";

/// Initialize dual-sink tracing (stderr + daily rolling file). Safe to call once.
pub fn init() {
    let _ = crate::paths::ensure_app_dirs();
    let log_dir = crate::paths::app_data_root().join("logs");

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(DEFAULT_ENV_FILTER));

    let file_appender = tracing_appender::rolling::daily(&log_dir, "app.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _ = LOG_GUARD.set(guard);

    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_target(true)
        .with_ansi(true);

    let file_layer = fmt::layer()
        .with_writer(non_blocking)
        .with_target(true)
        .with_ansi(false);

    // Prefer dual sinks; fall back to stderr-only if registry init races in tests.
    if tracing_subscriber::registry()
        .with(filter)
        .with(stderr_layer)
        .with(file_layer)
        .try_init()
        .is_err()
    {
        // Tests or a second setup call — leave existing subscriber alone.
        return;
    }

    tracing::info!(
        target: "grok_app::logging",
        path = %log_dir.display(),
        "diagnostic file logging enabled (daily rotate app.log.YYYY-MM-DD)"
    );
}

/// Absolute path of the logs directory (may not exist until first write).
pub fn logs_dir() -> PathBuf {
    crate::paths::app_data_root().join("logs")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_dir_under_app_data() {
        let dir = logs_dir();
        assert!(dir.ends_with("logs"), "{dir:?}");
    }
}
