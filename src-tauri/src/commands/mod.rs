//! Tauri commands — Host facade.
//!
//! Domain modules are `include!`d into this crate module so command symbols
//! stay at `commands::foo` for `generate_handler!` and cross-calls keep working
//! without path churn. Keep this facade thin (gate: ≤800 lines).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cli_probe::{self, CliProbeResult};
use crate::session_manager::{SessionManager, SessionSnapshot};
use crate::store::{self, AppSettings, Project, SessionMeta};

include!("session.rs");
include!("automation.rs");
include!("settings.rs");
include!("doctor.rs");
include!("extensions.rs");
include!("fs.rs");
include!("git.rs");
include!("account.rs");
include!("providers.rs");
include!("worktree_agents.rs");
include!("hooks_setup.rs");
include!("misc.rs");
