//! Grok Build workflows (`workflows_enabled`) — agent-home config sync + discovery.
//!
//! Config key (top-level, independent agent-home only):
//! - `workflows_enabled` (bool)
//!
//! Workflows are Rhai orchestration scripts run by the Grok Build CLI `workflow`
//! tool (`~/.grok/workflows/*.rhai`, project `.grok/workflows/*.rhai`). The App
//! only surfaces enable + read-only discovery — no in-app runner/editor.
//!
//! Shared mode never rewrites `~/.grok/config.toml`.

use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_home_config::{set_top_level_bool, update_config_toml_if_independent};

pub const CONFIG_KEY: &str = "workflows_enabled";

/// Normalize enable toggle (App default off).
pub fn normalize_enabled(raw: bool) -> bool {
    raw
}

/// Upsert `workflows_enabled` into a TOML-ish text blob.
pub fn set_workflows_enabled_in_toml(text: &str, enabled: bool) -> String {
    set_top_level_bool(text, CONFIG_KEY, enabled)
}

/// Write the config key into App agent-home (independent GROK_HOME only).
pub fn sync_workflows_to_agent_profile(
    session_data_mode: &str,
    enabled: bool,
) -> Result<(), String> {
    let path = update_config_toml_if_independent(session_data_mode, |existing| {
        set_workflows_enabled_in_toml(existing, enabled)
    })?;
    if let Some(path) = path {
        tracing::info!(
            "agent_workflows: synced {}={} → {}",
            CONFIG_KEY,
            enabled,
            path.display()
        );
    }
    Ok(())
}

/// Definition name = file stem (`review-changes.rhai` → `review-changes`).
pub fn workflow_name_from_file_name(file_name: &str) -> Option<String> {
    let base = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(file_name)
        .trim();
    if base.is_empty() || base.starts_with('.') {
        return None;
    }
    let lower = base.to_ascii_lowercase();
    if !lower.ends_with(".rhai") {
        return None;
    }
    let stem = &base[..base.len() - ".rhai".len()];
    let stem = stem.trim();
    if stem.is_empty() || stem.eq_ignore_ascii_case("readme") {
        return None;
    }
    Some(stem.to_string())
}

fn scan_workflow_dir(dir: &Path, scope: &str) -> Vec<WorkflowDef> {
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(workflow_name_from_file_name)
        {
            Some(n) => n,
            None => continue,
        };
        out.push(WorkflowDef {
            name,
            path: path.to_string_lossy().to_string(),
            scope: scope.to_string(),
        });
    }
    out
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDef {
    pub name: String,
    pub path: String,
    /// `project` | `user` | `agent_home`
    pub scope: String,
}

fn sort_workflows(mut items: Vec<WorkflowDef>) -> Vec<WorkflowDef> {
    items.sort_by(|a, b| {
        let sa = scope_rank(&a.scope);
        let sb = scope_rank(&b.scope);
        sa.cmp(&sb)
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
    });
    items
}

fn scope_rank(scope: &str) -> u8 {
    match scope {
        "project" => 0,
        "user" => 1,
        "agent_home" => 2,
        _ => 9,
    }
}

/// Read-only soft-fail discovery of workflow `.rhai` names.
///
/// Scans (in order, de-dup by name case-insensitive, project wins):
/// - `<project>/.grok/workflows`
/// - `~/.grok/workflows`
/// - independent agent-home `workflows/` when different from `~/.grok`
pub fn discover_workflows(
    project_path: Option<&str>,
    session_data_mode: &str,
) -> DiscoverWorkflowsResult {
    let home = crate::process_util::user_home();
    let user_dir = home.join(".grok").join("workflows");
    let project_dir = project_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|p| PathBuf::from(p).join(".grok").join("workflows"));

    let active_home = crate::paths::resolve_agent_grok_home(session_data_mode);
    let agent_home_dir = active_home.join("workflows");

    let mut items = Vec::new();
    if let Some(ref dir) = project_dir {
        items.extend(scan_workflow_dir(dir, "project"));
    }
    items.extend(scan_workflow_dir(&user_dir, "user"));
    if agent_home_dir != user_dir {
        for w in scan_workflow_dir(&agent_home_dir, "agent_home") {
            if !items
                .iter()
                .any(|e| e.name.eq_ignore_ascii_case(&w.name))
            {
                items.push(w);
            }
        }
    }

    // De-dupe: project > user > agent_home (keep first after sort).
    items = sort_workflows(items);
    let mut seen = std::collections::HashSet::new();
    items.retain(|w| {
        let key = w.name.to_ascii_lowercase();
        if seen.contains(&key) {
            false
        } else {
            seen.insert(key);
            true
        }
    });

    DiscoverWorkflowsResult {
        workflows: items,
        user_dir: user_dir.to_string_lossy().to_string(),
        project_dir: project_dir.map(|p| p.to_string_lossy().to_string()),
        agent_home_dir: if agent_home_dir != user_dir {
            Some(agent_home_dir.to_string_lossy().to_string())
        } else {
            None
        },
        create_workflow_skill: home
            .join(".grok")
            .join("bundled")
            .join("skills")
            .join("create-workflow")
            .join("SKILL.md")
            .to_string_lossy()
            .to_string(),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverWorkflowsResult {
    pub workflows: Vec<WorkflowDef>,
    pub user_dir: String,
    pub project_dir: Option<String>,
    pub agent_home_dir: Option<String>,
    /// Bundled create-workflow skill path (may not exist on disk).
    pub create_workflow_skill: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_and_name() {
        assert!(!normalize_enabled(false));
        assert!(normalize_enabled(true));
        assert_eq!(
            workflow_name_from_file_name("review-changes.rhai").as_deref(),
            Some("review-changes")
        );
        assert_eq!(
            workflow_name_from_file_name("path/to/Foo.RHAI").as_deref(),
            Some("Foo")
        );
        assert!(workflow_name_from_file_name("notes.md").is_none());
        assert!(workflow_name_from_file_name(".hidden.rhai").is_none());
        assert!(workflow_name_from_file_name("README.rhai").is_none());
        assert!(workflow_name_from_file_name("").is_none());
    }

    #[test]
    fn upserts_top_level_key() {
        let t = set_workflows_enabled_in_toml("", true);
        assert!(t.contains("workflows_enabled = true"));

        let existing = "[ui]\nyolo = false\n\n[subagents]\nenabled = true\n";
        let next = set_workflows_enabled_in_toml(existing, false);
        assert!(next.contains("workflows_enabled = false"));
        let ui_pos = next.find("[ui]").unwrap();
        let key_pos = next.find("workflows_enabled").unwrap();
        assert!(key_pos < ui_pos);
        assert!(next.contains("[subagents]"));
        assert!(next.contains("yolo = false"));

        let again = set_workflows_enabled_in_toml(&next, true);
        assert!(again.contains("workflows_enabled = true"));
        assert_eq!(again.matches("workflows_enabled").count(), 1);
    }

    #[test]
    fn shared_mode_skips_write() {
        // Should not error and must not require a real agent-home path.
        assert!(sync_workflows_to_agent_profile("shared", true).is_ok());
    }
}
