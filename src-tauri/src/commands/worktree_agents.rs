// ── Community PR batch (#63–#91) ─────────────────────────

// from PR #88

/// Timeout for `grok doctor fix <id> --yes` (may rewrite shell rc / config).
const CLI_DOCTOR_FIX_TIMEOUT_SECS: u64 = 30;

// from PR #68

const MCP_DOCTOR_TIMEOUT_SECS: u64 = 90;

// from PR #77

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefDto {
    pub name: String,
    pub path: String,
    /// "project" | "user" | "bundled"
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

// from PR #64

/// Result of creating a linked worktree (`git worktree add`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeAddResult {
    /// Absolute path of the new worktree directory.
    pub path: String,
    /// Sanitized worktree / new-branch name.
    pub name: String,
    /// Optional start-point / commit-ish that was used.
    pub start_point: Option<String>,
    /// Branch checked out after add (best-effort from re-list).
    pub branch: Option<String>,
}

// from PR #83

/// Result of `git worktree prune` (gc / clean stale admin files).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeGcResult {
    /// Whether this was a dry-run (`-n`).
    pub dry_run: bool,
    /// Whether aggressive expire (`now`) was applied via force without max_age.
    pub forced: bool,
    /// Optional `--expire` value that was used.
    pub max_age: Option<String>,
    /// Combined verbose prune output (stdout + stderr, trimmed).
    pub output: String,
    /// Paths marked `prunable` in `git worktree list --porcelain` before prune.
    pub prunable: Vec<String>,
    /// Best-effort count of removals reported in prune output.
    pub pruned_count: usize,
}

// from PR #74

/// Result of `git worktree remove`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeRemoveResult {
    /// Absolute path that was removed.
    pub path: String,
    /// Whether `--force` was used.
    pub forced: bool,
}

/// One row from `git diff --name-status` (worktree compare).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCompareEntry {
    /// Status token: A, M, D, R100, C080, …
    pub status: String,
    /// Path (rename/copy destination when old_path is set).
    pub path: String,
    /// Rename/copy source path when present.
    pub old_path: Option<String>,
}

/// Soft-fail result of comparing two worktree paths / refs (`git diff --name-status`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCompareResult {
    pub available: bool,
    pub entries: Vec<GitWorktreeCompareEntry>,
    /// Raw `git diff --name-status` stdout (for client re-parse / honesty).
    pub raw: Option<String>,
    pub reason: Option<String>,
    pub base: String,
    pub other: String,
    /// Resolved left ref (branch or sha).
    pub base_ref: Option<String>,
    /// Resolved right ref (branch or sha).
    pub other_ref: Option<String>,
    /// True when host truncated the entry list (cap honesty).
    pub truncated: bool,
    /// Total entries before host cap (when truncated).
    pub total: usize,
}

// from PR #77

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaDefDto {
    pub name: String,
    pub path: String,
    pub scope: String,
}

// from PR #77

/// Read-only soft-fail list of discovered Grok Build workflow scripts
/// (`~/.grok/workflows` + project `.grok/workflows` + independent agent-home).
/// Never invents runners; empty dirs return an empty list.
#[tauri::command]
pub async fn workflows_list(
    project_path: Option<String>,
) -> Result<crate::agent_workflows::DiscoverWorkflowsResult, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let mode = store::load_settings().session_data_mode.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_workflows::discover_workflows(project.as_deref(), &mode)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Soft-fail headless run of a discovered Grok Build workflow by name.
///
/// There is no top-level `grok workflow` CLI subcommand; the host spawns a
/// short `grok -p` that must call the agent `workflow` tool. Default mode is
/// `validate` (`validate_only: true` smoke). Returns structured ok / reason /
/// redacted truncated log — never panics on CLI missing / timeout.
#[tauri::command]
pub async fn workflows_run(
    name: String,
    project_path: Option<String>,
    mode: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<crate::agent_workflows::WorkflowRunResult, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let mode_owned = mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_workflows::run_workflow(
            &name,
            project.as_deref(),
            mode_owned.as_deref(),
            timeout_ms,
        )
    })
    .await
    .map_err(|e| format!("workflows_run: {e}"))
}

/// Create a minimal `.rhai` workflow template under user or project scope.
/// Path-scoped write; refuses overwrite unless `force`. Soft-fail via Result.
#[tauri::command]
pub async fn workflows_create(
    name: String,
    scope: Option<String>,
    project_path: Option<String>,
    force: Option<bool>,
) -> Result<crate::agent_workflows::WorkflowCreateResult, String> {
    let scope = scope.unwrap_or_else(|| "user".into());
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_workflows::create_workflow_template(
            &name,
            &scope,
            project_path.as_deref(),
            force,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List agent + persona definition files from user / project / bundled scopes.
/// Does not require the CLI binary (pure filesystem discovery under `~/.grok`,
/// active GROK_HOME / agent-home, and optional `{project}/.grok`). Always returns Ok.
#[tauri::command]
pub async fn agents_list(project_path: Option<String>) -> Result<serde_json::Value, String> {
    let project = project_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let home = crate::process_util::user_home();
        let grok = home.join(".grok");
        let user_agents = grok.join("agents");
        let bundled_agents = grok.join("bundled").join("agents");
        let user_personas = grok.join("personas");
        let bundled_personas = grok.join("bundled").join("personas");

        let project_agents = project.as_ref().map(|p| {
            std::path::PathBuf::from(p).join(".grok").join("agents")
        });
        let project_personas = project.as_ref().map(|p| {
            std::path::PathBuf::from(p).join(".grok").join("personas")
        });

        let settings = store::load_settings();
        let active_home =
            crate::paths::resolve_agent_grok_home(&settings.session_data_mode);
        let active_user_agents = active_home.join("agents");

        let mut agents = Vec::new();
        if let Some(ref dir) = project_agents {
            agents.extend(scan_agent_dir(dir, "project"));
        }
        agents.extend(scan_agent_dir(&user_agents, "user"));
        if active_user_agents != user_agents {
            // Independent mode: defs under agent-home count as user scope.
            for a in scan_agent_dir(&active_user_agents, "user") {
                if !agents
                    .iter()
                    .any(|e| e.scope == "user" && e.name.eq_ignore_ascii_case(&a.name))
                {
                    agents.push(a);
                }
            }
        }
        agents.extend(scan_agent_dir(&bundled_agents, "bundled"));
        let agents = sort_agent_defs(agents);

        let mut personas = Vec::new();
        if let Some(ref dir) = project_personas {
            personas.extend(scan_persona_dir(dir, "project"));
        }
        personas.extend(scan_persona_dir(&user_personas, "user"));
        personas.extend(scan_persona_dir(&bundled_personas, "bundled"));
        let personas = sort_persona_defs(personas);

        let user_agents_dir = if active_user_agents != user_agents {
            active_user_agents.to_string_lossy().to_string()
        } else {
            user_agents.to_string_lossy().to_string()
        };

        serde_json::json!({
            "agents": agents,
            "personas": personas,
            "userAgentsDir": user_agents_dir,
            "projectAgentsDir": project_agents
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            "bundledAgentsDir": bundled_agents.to_string_lossy(),
            "userPersonasDir": user_personas.to_string_lossy(),
            "projectPersonasDir": project_personas
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            "bundledPersonasDir": bundled_personas.to_string_lossy(),
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Create a SKILL-like agent definition markdown under user GROK_HOME or
/// project `.grok/agents`. Path-scoped; rejects overwrite unless `force`.
#[tauri::command]
pub async fn agents_scaffold(
    name: String,
    scope: Option<String>,
    project_path: Option<String>,
    force: Option<bool>,
    description: Option<String>,
) -> Result<crate::agents_catalog::AgentsScaffoldResult, String> {
    let scope = scope.unwrap_or_else(|| "user".into());
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        crate::agents_catalog::scaffold_agent(
            &name,
            &scope,
            project_path.as_deref(),
            force,
            description.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// from PR #83

/// Build argv for `git worktree prune` (no binary name; caller prefixes `git`).
///
/// Layout: `[-C <project>] worktree prune -v [--dry-run] [--expire <age>]`
///
/// - `dry_run` → `--dry-run` (report only)
/// - `max_age` → `--expire <max_age>` when set
/// - `force` without `max_age` → `--expire now` (prune all stale admin files now)
/// - always `-v` so dry-run preview has useful lines
///
/// Pure; unit-tested. Never goes through a shell.
pub fn build_worktree_gc_args(
    project: &str,
    dry_run: bool,
    force: bool,
    max_age: Option<&str>,
) -> Result<Vec<String>, String> {
    let project = normalize_fs_path(project);
    if project.is_empty() {
        return Err("empty path".into());
    }
    if project.starts_with('-') {
        return Err("invalid project path".into());
    }
    let expire = match sanitize_worktree_gc_max_age(max_age)? {
        Some(age) => Some(age),
        None if force => Some("now".into()),
        None => None,
    };

    let mut args: Vec<String> = vec![
        "-C".into(),
        project,
        "worktree".into(),
        "prune".into(),
        "-v".into(),
    ];
    if dry_run {
        args.push("--dry-run".into());
    }
    if let Some(age) = expire {
        args.push("--expire".into());
        args.push(age);
    }
    Ok(args)
}

// from PR #64

/// Path placement for new linked worktrees (`cli` default, or `sibling`).
pub fn normalize_worktree_layout(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.eq_ignore_ascii_case("sibling") => "sibling",
        _ => "cli",
    }
}

/// Shared CLI GROK_HOME (`~/.grok`) used for worktree placement.
/// Matches Grok Build 0.2.x `~/.grok/worktrees/<repo>/…` regardless of
/// App independent agent-home (git worktrees are filesystem layout, not session store).
pub fn shared_cli_grok_home() -> std::path::PathBuf {
    crate::process_util::user_home().join(".grok")
}

/// CLI worktrees root: `{GROK_HOME}/worktrees`.
pub fn cli_worktrees_home(grok_home: &std::path::Path) -> std::path::PathBuf {
    grok_home.join("worktrees")
}

/// Repo folder slug for CLI layout (main worktree basename).
pub fn worktree_repo_slug(main_worktree_path: &str) -> Result<String, String> {
    let main = normalize_fs_path(main_worktree_path);
    if main.is_empty() {
        return Err("empty main worktree path".into());
    }
    let main_pb = std::path::PathBuf::from(&main);
    main_pb
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "cannot derive repo folder name".to_string())
}

/// CLI-aligned path: `{GROK_HOME}/worktrees/<main_basename>/<name>`.
///
/// Example: grok_home `~/.grok`, main `/Users/me/Code/oss-grok-app`, name `feat`
/// → `~/.grok/worktrees/oss-grok-app/feat`.
///
/// Matches Grok Build 0.2.x (`grok --worktree=…`, `grok worktree list`).
pub fn build_worktree_cli_path(
    main_worktree_path: &str,
    name: &str,
    grok_home: &std::path::Path,
) -> Result<String, String> {
    let main = normalize_fs_path(main_worktree_path);
    if main.is_empty() {
        return Err("empty main worktree path".into());
    }
    let safe = sanitize_worktree_name(name)?;
    let slug = worktree_repo_slug(&main)?;
    let path = cli_worktrees_home(grok_home).join(slug).join(safe);
    let s = path.to_string_lossy().replace('\\', "/");
    let s = normalize_fs_path(&s);
    if s == main || s.is_empty() {
        return Err("resolved worktree path is invalid".into());
    }
    Ok(s)
}

/// Build sibling worktree path: `<parent>/<main_basename>-<name>`.
///
/// Example: main `/Users/me/repo` + name `feat` → `/Users/me/repo-feat`.
///
/// Optional alternative to CLI home layout — matches common
/// `git worktree add ../repo-feat` practice.
pub fn build_worktree_sibling_path(main_worktree_path: &str, name: &str) -> Result<String, String> {
    let main = normalize_fs_path(main_worktree_path);
    if main.is_empty() {
        return Err("empty main worktree path".into());
    }
    let safe = sanitize_worktree_name(name)?;
    let main_pb = std::path::PathBuf::from(&main);
    let base = main_pb
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "cannot derive repo folder name".to_string())?;
    let parent = main_pb
        .parent()
        .ok_or_else(|| "main worktree has no parent directory".to_string())?;
    let dir_name = format!("{base}-{safe}");
    let path = parent.join(dir_name);
    let s = path.to_string_lossy().replace('\\', "/");
    let s = normalize_fs_path(&s);
    if s == main || s.is_empty() {
        return Err("resolved worktree path is invalid".into());
    }
    Ok(s)
}

/// Resolve create path for layout (`cli` default, or `sibling`).
pub fn build_worktree_path_for_layout(
    layout: Option<&str>,
    main_worktree_path: &str,
    name: &str,
) -> Result<String, String> {
    match normalize_worktree_layout(layout) {
        "sibling" => build_worktree_sibling_path(main_worktree_path, name),
        _ => build_worktree_cli_path(main_worktree_path, name, &shared_cli_grok_home()),
    }
}

// from PR #88

/// Apply a CLI automatic remediation: `grok doctor fix <id> --yes`.
/// Returns redacted stdout/stderr; never throws on non-zero exit (ok=false).
#[tauri::command]
pub async fn cli_doctor_fix(id: String) -> Result<serde_json::Value, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("doctor fix id required".into());
    }
    if !is_safe_doctor_fix_id(&id) {
        return Err(format!("invalid doctor fix id: {id}"));
    }

    let id_for_cmd = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["doctor", "fix", &id_for_cmd, "--yes"],
            CLI_DOCTOR_FIX_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| format!("doctor fix worker panicked: {e}"))?;

    match result {
        Ok((stdout, stderr, exit_ok)) => Ok(serde_json::json!({
            "ok": exit_ok,
            "id": id,
            "stdout": redact_doctor_fix_output(&stdout, 2000),
            "stderr": redact_doctor_fix_output(&stderr, 800),
            "exitOk": exit_ok,
        })),
        Err(e) => {
            // Missing CLI / timeout — surface as structured failure, not panic.
            Ok(serde_json::json!({
                "ok": false,
                "id": id,
                "stdout": "",
                "stderr": redact_doctor_fix_output(&e, 400),
                "exitOk": false,
                "error": redact_doctor_fix_output(&e, 400),
            }))
        }
    }
}

// from PR #63

/// Run resolved `grok update --check --json` and return a typed DTO.
#[tauri::command]
pub async fn cli_update_check() -> Result<crate::cli_update::CliUpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let settings = store::load_settings();
        crate::cli_update::check_cli_update(settings.manual_cli_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// from PR #63 / channel UX (CLI ≥ 0.2.117)

/// Install CLI update / switch channel / pin version.
///
/// Optional `channel` (`stable`|`alpha`), `version` pin, and `force` reinstall.
/// Channel switch and version pin are mutually exclusive; unknown channels error
/// (never invented). Plain update still falls back to App install trust-chain.
#[tauri::command]
pub async fn cli_update_install(
    app: tauri::AppHandle,
    channel: Option<String>,
    version: Option<String>,
    force: Option<bool>,
) -> Result<crate::cli_install::CliInstallResult, String> {
    let opts = crate::cli_update::CliUpdateInstallOpts {
        channel,
        version,
        force: force.unwrap_or(false),
    };
    crate::cli_update::install_cli_update(app, opts).await
}

/// Recycle every warm agent process so the next send spawns fresh binaries.
/// Used after a CLI upgrade — running children keep executing the old image
/// until restarted (NEW-05). Chat history is untouched; sessions reconnect
/// lazily on the next send.
#[tauri::command]
pub async fn agents_recycle_all(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<(), String> {
    mgr.recycle_all_agents(&app, "cli_upgrade").await;
    Ok(())
}

// from PR #83

/// Count removal-like lines in `git worktree prune -v` output (best-effort).
pub fn count_worktree_prune_lines(output: &str) -> usize {
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| {
            let lower = l.to_ascii_lowercase();
            lower.contains("remov") || lower.contains("prun") || lower.starts_with("would ")
        })
        .count()
}

// from PR #77

/// Best-effort YAML frontmatter `description:` (first line / plain value).
fn extract_agent_description_from_content(content: &str) -> Option<String> {
    if !content.starts_with("---") {
        return None;
    }
    let rest = &content[3..];
    let end = rest.find("\n---")?;
    let fm = &rest[..end];
    for (i, line) in fm.lines().enumerate() {
        let trimmed = line.trim_start();
        if let Some(val) = trimmed.strip_prefix("description:") {
            let v = val.trim();
            if v == ">" || v == "|" || v == ">-" || v == "|-" {
                // Folded block: first non-empty indented line after this one.
                for next in fm.lines().skip(i + 1) {
                    if next.starts_with(' ') || next.starts_with('\t') {
                        let t = next.trim();
                        if !t.is_empty() {
                            return Some(t.to_string());
                        }
                    } else if !next.trim().is_empty() {
                        break;
                    }
                }
                return None;
            }
            if v.is_empty() {
                return None;
            }
            let unquoted = v
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                .unwrap_or(v);
            let cleaned = unquoted.split_whitespace().collect::<Vec<_>>().join(" ");
            if cleaned.is_empty() {
                return None;
            }
            return Some(cleaned);
        }
    }
    None
}

// from PR #64

/// Create a linked git worktree, then return its path.
///
/// Default layout (`cli` / omitted): `{GROK_HOME}/worktrees/<repo>/<name>`
/// aligned with Grok Build 0.2.x (`grok --worktree=…`).
/// Optional `layout = "sibling"`: `<parent>/<main_basename>-<name>`.
///
/// Args are passed to `git` as an argv array (no shell) to avoid injection.
/// - Without `start_point`: `git worktree add -b <name> <path>` (branch from HEAD).
/// - With `start_point`: `git worktree add -b <name> <path> <start_point>`.
#[tauri::command]
pub async fn git_worktree_add(
    project_path: String,
    name: String,
    start_point: Option<String>,
    layout: Option<String>,
) -> Result<GitWorktreeAddResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    git_probe_work_tree(&project)?;

    let safe_name = sanitize_worktree_name(&name)?;
    let start = sanitize_worktree_ref(start_point.as_deref())?;
    let layout_kind = normalize_worktree_layout(layout.as_deref());

    // Resolve main worktree path (first porcelain entry) for path placement.
    let list_out = crate::process_util::command("git")
        .args(["-C", &project, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !list_out.status.success() {
        let err = String::from_utf8_lossy(&list_out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "git worktree list failed".into()
        } else {
            err.chars().take(200).collect()
        });
    }
    let listed = parse_worktree_porcelain(&String::from_utf8_lossy(&list_out.stdout));
    let main_path = listed
        .first()
        .map(|w| w.path.clone())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "could not resolve main worktree path".to_string())?;

    let target = build_worktree_path_for_layout(Some(layout_kind), &main_path, &safe_name)?;
    let target_pb = std::path::PathBuf::from(&target);
    if target_pb.exists() {
        return Err(format!("path already exists: {target}"));
    }
    // Refuse if already registered as a worktree.
    if listed.iter().any(|w| {
        let p = normalize_fs_path(&w.path);
        p.eq_ignore_ascii_case(&target) || p == target
    }) {
        return Err(format!("worktree already registered: {target}"));
    }

    // CLI layout nests under ~/.grok/worktrees/<repo>/ — ensure parents exist.
    if let Some(parent) = target_pb.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!("could not create worktree parent {}: {e}", parent.display())
        })?;
    }

    // Safe argv — never go through a shell.
    // `git worktree add -b <name> <path> [start_point]`
    let mut args: Vec<String> = vec![
        "-C".into(),
        project.clone(),
        "worktree".into(),
        "add".into(),
        "-b".into(),
        safe_name.clone(),
        target.clone(),
    ];
    if let Some(ref sp) = start {
        args.push(sp.clone());
    }

    let out = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(if err.is_empty() {
            "git worktree add failed".into()
        } else {
            err.chars().take(400).collect()
        });
    }

    // Best-effort: re-list to pick up branch field for the new path.
    let branch = {
        let re = crate::process_util::command("git")
            .args(["-C", &project, "worktree", "list", "--porcelain"])
            .output()
            .ok();
        re.and_then(|o| {
            if !o.status.success() {
                return None;
            }
            let list = parse_worktree_porcelain(&String::from_utf8_lossy(&o.stdout));
            list.into_iter()
                .find(|w| {
                    let p = normalize_fs_path(&w.path);
                    p.eq_ignore_ascii_case(&target) || p == target
                })
                .and_then(|w| w.branch)
        })
        .or_else(|| Some(safe_name.clone()))
    };

    Ok(GitWorktreeAddResult {
        path: target,
        name: safe_name,
        start_point: start,
        branch,
    })
}

// from PR #83

/// Garbage-collect stale git worktree administrative files via `git worktree prune`.
///
/// Safe argv only (no shell). Soft-fails on missing git / non-repo with an Err.
/// When `dry_run` is true, nothing is deleted (`--dry-run`).
/// Optional `force` maps to `--expire now` when `max_age` is unset.
/// Optional `max_age` maps to `--expire <max_age>`.
#[tauri::command]
pub async fn git_worktree_gc(
    project_path: String,
    dry_run: bool,
    force: Option<bool>,
    max_age: Option<String>,
) -> Result<GitWorktreeGcResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    git_probe_work_tree(&project)?;

    let forced = force.unwrap_or(false);
    let age = sanitize_worktree_gc_max_age(max_age.as_deref())?;

    // Snapshot prunable entries before prune for UI preview / summary.
    let prunable = {
        let list_out = crate::process_util::command("git")
            .args(["-C", &project, "worktree", "list", "--porcelain"])
            .output()
            .map_err(|e| e.to_string())?;
        if list_out.status.success() {
            parse_worktree_porcelain(&String::from_utf8_lossy(&list_out.stdout))
                .into_iter()
                .filter(|w| w.prunable)
                .map(|w| w.path)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        }
    };

    let args = build_worktree_gc_args(
        &project,
        dry_run,
        forced,
        age.as_deref(),
    )?;

    let out = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(if err.is_empty() {
            "git worktree prune failed".into()
        } else {
            err.chars().take(400).collect()
        });
    }

    // prune -v writes progress to stderr on some git versions, stdout on others.
    let mut combined = String::new();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stdout.trim().is_empty() {
        combined.push_str(stdout.trim());
    }
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(stderr.trim());
    }
    // Prefer verbose prune lines; fall back to porcelain prunable count on dry-run.
    let mut pruned_count = count_worktree_prune_lines(&combined);
    if pruned_count == 0 && !prunable.is_empty() {
        pruned_count = prunable.len();
    }

    let used_expire = match &age {
        Some(a) => Some(a.clone()),
        None if forced => Some("now".into()),
        None => None,
    };

    Ok(GitWorktreeGcResult {
        dry_run,
        forced,
        max_age: used_expire,
        output: combined.chars().take(4000).collect(),
        prunable,
        pruned_count,
    })
}

// from PR #74

/// Remove a linked git worktree via `git worktree remove` (argv only, no shell).
///
/// Refuses the main worktree. Optional `force` maps to `--force` (dirty / locked).
#[tauri::command]
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    force: Option<bool>,
) -> Result<GitWorktreeRemoveResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Err("empty path".into());
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Err("project not a directory".into());
    }
    git_probe_work_tree(&project)?;

    let target = normalize_fs_path(&worktree_path);
    if target.is_empty() {
        return Err("empty worktree path".into());
    }
    // Disallow option-like paths so a crafted path cannot become a git flag.
    if target.starts_with('-') {
        return Err("invalid worktree path".into());
    }

    let list_out = crate::process_util::command("git")
        .args(["-C", &project, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !list_out.status.success() {
        let err = String::from_utf8_lossy(&list_out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "git worktree list failed".into()
        } else {
            err.chars().take(200).collect()
        });
    }
    let listed = parse_worktree_porcelain(&String::from_utf8_lossy(&list_out.stdout));
    if listed.is_empty() {
        return Err("no worktrees found".into());
    }

    refuse_remove_main_worktree(&listed, &target)?;

    let registered = listed.iter().any(|w| worktree_paths_equal(&w.path, &target));
    if !registered {
        return Err("worktree not registered for this repository".into());
    }

    // Use the path as listed by git (preserves real casing / form).
    let remove_path = listed
        .iter()
        .find(|w| worktree_paths_equal(&w.path, &target))
        .map(|w| w.path.clone())
        .unwrap_or(target.clone());

    let forced = force.unwrap_or(false);
    // Safe argv — never go through a shell.
    // `git worktree remove [--force] <path>`
    let mut args: Vec<String> = vec![
        "-C".into(),
        project,
        "worktree".into(),
        "remove".into(),
    ];
    if forced {
        args.push("--force".into());
    }
    args.push(remove_path.clone());

    let out = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(if err.is_empty() {
            "git worktree remove failed".into()
        } else {
            err.chars().take(400).collect()
        });
    }

    Ok(GitWorktreeRemoveResult {
        path: remove_path,
        forced,
    })
}

/// Max name-status rows returned by the host (client may cap further for display).
const GIT_WORKTREE_COMPARE_ENTRY_CAP: usize = 2_000;

/// Soft-fail compare of two worktree paths via `git diff --name-status <base>...<other>`.
///
/// Prefer explicit branch names when provided; otherwise resolve each path's HEAD.
/// Both paths must be directories inside the same git common dir. Never merges/applies.
#[tauri::command]
pub async fn git_worktree_compare(
    base_path: String,
    other_path: String,
    base_branch: Option<String>,
    other_branch: Option<String>,
) -> Result<GitWorktreeCompareResult, String> {
    let base = normalize_fs_path(&base_path);
    let other = normalize_fs_path(&other_path);

    let empty = |reason: &str| GitWorktreeCompareResult {
        available: false,
        entries: vec![],
        raw: None,
        reason: Some(reason.into()),
        base: base.clone(),
        other: other.clone(),
        base_ref: None,
        other_ref: None,
        truncated: false,
        total: 0,
    };

    if base.is_empty() || other.is_empty() {
        return Ok(empty("missing_path"));
    }
    if worktree_paths_equal(&base, &other) {
        return Ok(empty("same_path"));
    }
    if base.starts_with('-') || other.starts_with('-') {
        return Ok(empty("invalid path"));
    }

    let base_pb = std::path::PathBuf::from(&base);
    let other_pb = std::path::PathBuf::from(&other);
    if !base_pb.is_dir() || !other_pb.is_dir() {
        return Ok(empty("missing_path"));
    }

    if let Err(reason) = git_probe_work_tree(&base) {
        return Ok(empty(&reason));
    }
    if let Err(reason) = git_probe_work_tree(&other) {
        return Ok(empty(&reason));
    }

    // Same repository (shared common dir) — refuse unrelated paths.
    let base_common = git_rev_parse_path(&base, "--git-common-dir");
    let other_common = git_rev_parse_path(&other, "--git-common-dir");
    match (base_common.as_ref(), other_common.as_ref()) {
        (Some(a), Some(b)) if !worktree_paths_equal(a, b) => {
            return Ok(empty("not same repository"));
        }
        (None, _) | (_, None) => {
            return Ok(empty("not a git repository"));
        }
        _ => {}
    }

    let base_ref = resolve_compare_ref(&base, base_branch.as_deref());
    let other_ref = resolve_compare_ref(&other, other_branch.as_deref());
    let (Some(left), Some(right)) = (base_ref.as_ref(), other_ref.as_ref()) else {
        return Ok(empty("could not resolve refs"));
    };

    // Safe argv — never go through a shell.
    // `git -C <base> diff --name-status <left>...<right>`
    let range = format!("{left}...{right}");
    let out = crate::process_util::command("git")
        .args(["-C", &base, "diff", "--name-status", &range])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Ok(GitWorktreeCompareResult {
            available: false,
            entries: vec![],
            raw: None,
            reason: Some(if err.is_empty() {
                "git diff failed".into()
            } else {
                err.chars().take(400).collect()
            }),
            base,
            other,
            base_ref: Some(left.clone()),
            other_ref: Some(right.clone()),
            truncated: false,
            total: 0,
        });
    }

    let raw_full = String::from_utf8_lossy(&out.stdout).to_string();
    let parsed = parse_name_status(&raw_full);
    let total = parsed.len();
    let truncated = total > GIT_WORKTREE_COMPARE_ENTRY_CAP;
    let entries: Vec<GitWorktreeCompareEntry> = parsed
        .into_iter()
        .take(GIT_WORKTREE_COMPARE_ENTRY_CAP)
        .collect();
    // Cap raw for IPC size honesty.
    let raw = Some(raw_full.chars().take(200_000).collect::<String>());

    Ok(GitWorktreeCompareResult {
        available: true,
        entries,
        raw,
        reason: None,
        base,
        other,
        base_ref: Some(left.clone()),
        other_ref: Some(right.clone()),
        truncated,
        total,
    })
}

/// Resolve a compare ref: prefer sanitized branch name, else `rev-parse HEAD`.
fn resolve_compare_ref(project: &str, branch: Option<&str>) -> Option<String> {
    if let Some(b) = branch.map(str::trim).filter(|s| !s.is_empty()) {
        if b.starts_with('-') || b.contains('\0') || b.contains('\n') || b.contains('\r') {
            // Fall through to HEAD — never pass option-like / control refs.
        } else if b.len() <= 256 && !b.contains("..") {
            // Verify ref resolves under this worktree.
            if let Some(full) = git_rev_parse_output(project, b) {
                // Return the user-facing branch name when it resolves (nicer UI);
                // three-dot range accepts branch names.
                let _ = full;
                return Some(b.to_string());
            }
        }
    }
    git_rev_parse_output(project, "HEAD")
}

fn git_rev_parse_output(project: &str, rev: &str) -> Option<String> {
    let out = crate::process_util::command("git")
        .args(["-C", project, "rev-parse", "--verify", rev])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// `git rev-parse <flag>` absolute-ish path (for --git-common-dir).
fn git_rev_parse_path(project: &str, flag: &str) -> Option<String> {
    let out = crate::process_util::command("git")
        .args(["-C", project, "rev-parse", flag])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    // Relative common-dir → resolve against project.
    let pb = std::path::PathBuf::from(&s);
    let abs = if pb.is_absolute() {
        pb
    } else {
        std::path::PathBuf::from(project).join(pb)
    };
    let canon = abs.canonicalize().unwrap_or(abs);
    Some(normalize_fs_path(&canon.to_string_lossy()))
}

/// Parse `git diff --name-status` stdout (mirrors frontend `parseNameStatus`).
fn parse_name_status(raw: &str) -> Vec<GitWorktreeCompareEntry> {
    let text = raw.replace("\r\n", "\n");
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = if t.contains('\t') {
            t.split('\t').collect()
        } else {
            t.split_whitespace().collect()
        };
        if parts.len() < 2 {
            continue;
        }
        let status = parts[0].trim();
        if status.is_empty() {
            continue;
        }
        if parts.len() >= 3 {
            let old = parts[1].trim().replace('\\', "/");
            let newp = parts[2].trim().replace('\\', "/");
            if old.is_empty() && newp.is_empty() {
                continue;
            }
            out.push(GitWorktreeCompareEntry {
                status: status.to_string(),
                path: if newp.is_empty() {
                    old.clone()
                } else {
                    newp
                },
                old_path: if old.is_empty() { None } else { Some(old) },
            });
        } else {
            let path = parts[1].trim().replace('\\', "/");
            if path.is_empty() {
                continue;
            }
            out.push(GitWorktreeCompareEntry {
                status: status.to_string(),
                path,
                old_path: None,
            });
        }
    }
    out
}

#[cfg(test)]
mod git_worktree_compare_parse_tests {
    use super::*;

    #[test]
    fn parse_name_status_amd() {
        let raw = "A\tsrc/new.ts\nM\tREADME.md\nD\told.txt\n";
        let list = parse_name_status(raw);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].status, "A");
        assert_eq!(list[0].path, "src/new.ts");
        assert!(list[0].old_path.is_none());
        assert_eq!(list[1].status, "M");
        assert_eq!(list[2].status, "D");
    }

    #[test]
    fn parse_name_status_rename() {
        let raw = "R100\told/a.ts\tnew/a.ts\n";
        let list = parse_name_status(raw);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status, "R100");
        assert_eq!(list[0].path, "new/a.ts");
        assert_eq!(list[0].old_path.as_deref(), Some("old/a.ts"));
    }

    #[test]
    fn parse_name_status_empty() {
        assert!(parse_name_status("").is_empty());
        assert!(parse_name_status("\n\n").is_empty());
    }
}

// ── Worktree ship flow (push + gh pr create) ────────────────────────────────

/// Soft-fail result of `git push -u origin HEAD` under a project path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushBranchResult {
    pub available: bool,
    pub ok: bool,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub reason: Option<String>,
}

/// Soft-fail result of `gh pr create` under a project path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPrCreateResult {
    pub available: bool,
    pub ok: bool,
    pub url: Option<String>,
    pub repo: Option<String>,
    pub base: Option<String>,
    pub head: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub reason: Option<String>,
}

fn ship_redact_output(s: &str, max: usize) -> String {
    let scrubbed = store::redact_text(s);
    let t = scrubbed.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        t.chars().take(max).collect::<String>() + "…"
    }
}

/// Parse `git@host:org/repo.git` / `https://host/org/repo.git` → `org/repo` (pure).
pub fn parse_github_owner_repo(url: &str) -> Option<String> {
    let s = url
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches(".GIT");
    if s.is_empty() {
        return None;
    }
    // SSH: git@github.com:org/repo
    if let Some(idx) = s.find(':') {
        let rest = &s[idx + 1..];
        if !rest.contains("://") && rest.contains('/') {
            let parts: Vec<&str> = rest
                .trim_start_matches('/')
                .split('/')
                .filter(|p| !p.is_empty())
                .collect();
            if parts.len() >= 2 {
                return Some(format!(
                    "{}/{}",
                    parts[parts.len() - 2],
                    parts[parts.len() - 1]
                ));
            }
        }
    }
    // HTTPS path: take last two segments
    let parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 {
        let org = parts[parts.len() - 2];
        let repo = parts[parts.len() - 1];
        if !org.is_empty() && !repo.is_empty() && !org.contains('@') {
            return Some(format!("{org}/{repo}"));
        }
    }
    None
}

fn github_owner_from_repo(owner_repo: &str) -> Option<&str> {
    let (o, _) = owner_repo.split_once('/')?;
    let o = o.trim();
    if o.is_empty() {
        None
    } else {
        Some(o)
    }
}

/// Build `gh --head` value for forks (`owner:branch`) or same-repo bare branch.
pub fn build_gh_head_ref(
    branch: &str,
    origin_owner_repo: Option<&str>,
    base_owner_repo: Option<&str>,
) -> String {
    let b = branch.trim();
    if b.is_empty() {
        return String::new();
    }
    let origin_owner = origin_owner_repo.and_then(github_owner_from_repo);
    let base_owner = base_owner_repo.and_then(github_owner_from_repo);
    match (origin_owner, base_owner) {
        (Some(o), Some(base)) if o != base => format!("{o}:{b}"),
        _ => b.to_string(),
    }
}

/// Extract first GitHub PR URL from gh stdout/stderr (pure).
pub fn parse_gh_pr_url(output: &str) -> Option<String> {
    // https://github.com/org/repo/pull/123
    let bytes = output.as_bytes();
    let needle = b"https://github.com/";
    let mut i = 0;
    while i + needle.len() < bytes.len() {
        if bytes[i..].starts_with(needle) {
            let start = i;
            let mut end = i + needle.len();
            while end < bytes.len() {
                let c = bytes[end];
                if c.is_ascii_alphanumeric()
                    || c == b'/'
                    || c == b'-'
                    || c == b'_'
                    || c == b'.'
                {
                    end += 1;
                } else {
                    break;
                }
            }
            let candidate = &output[start..end];
            if candidate.contains("/pull/") {
                // Trim trailing punctuation
                let cleaned = candidate
                    .trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
                if cleaned.contains("/pull/") {
                    return Some(cleaned.to_string());
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    None
}

/// Sanitize PR title for argv (single line, required).
pub fn sanitize_pr_title(raw: &str) -> Result<String, String> {
    let s = raw
        .replace(['\0', '\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if s.is_empty() {
        return Err("PR title is required".into());
    }
    if s.chars().count() > 256 {
        return Err("PR title too long (max 256)".into());
    }
    Ok(s)
}

/// Sanitize PR body (allow multiline; strip NUL).
pub fn sanitize_pr_body(raw: Option<&str>) -> Result<String, String> {
    let s = raw.unwrap_or("").replace('\0', "").replace("\r\n", "\n").replace('\r', "\n");
    if s.chars().count() > 65_536 {
        return Err("PR body too long".into());
    }
    Ok(s)
}

/// Sanitize `owner/repo` for `--repo`.
pub fn sanitize_github_repo_arg(raw: Option<&str>) -> Result<Option<String>, String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty());
    let Some(s) = s else {
        return Ok(None);
    };
    if s.starts_with('-') {
        return Err("repo must not start with '-'".into());
    }
    if s.len() > 200 {
        return Err("repo too long".into());
    }
    let mut parts = s.split('/');
    let org = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if parts.next().is_some() || org.is_empty() || name.is_empty() {
        return Err("repo must be owner/name".into());
    }
    if !org
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("repo must be owner/name".into());
    }
    Ok(Some(format!("{org}/{name}")))
}

fn sanitize_ship_branch(raw: Option<&str>) -> Result<Option<String>, String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty());
    let Some(s) = s else {
        return Ok(None);
    };
    if s.starts_with('-') {
        return Err("branch must not start with '-'".into());
    }
    if s.len() > 256 || s.contains('\0') || s.contains('\n') || s.contains('\r') {
        return Err("invalid branch".into());
    }
    if s == "HEAD" || s == "@" {
        return Ok(None);
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
    {
        return Err("branch contains invalid characters".into());
    }
    Ok(Some(s.to_string()))
}

/// Build argv for `git push -u origin HEAD` (no binary; pure).
pub fn build_git_push_args(project: &str) -> Result<Vec<String>, String> {
    let project = normalize_fs_path(project);
    if project.is_empty() {
        return Err("empty path".into());
    }
    if project.starts_with('-') {
        return Err("invalid project path".into());
    }
    Ok(vec![
        "-C".into(),
        project,
        "push".into(),
        "-u".into(),
        "origin".into(),
        "HEAD".into(),
    ])
}

/// Build argv for `gh pr create` (no binary; pure).
pub fn build_gh_pr_create_args(
    title: &str,
    body: &str,
    draft: bool,
    base: &str,
    head: Option<&str>,
    repo: Option<&str>,
) -> Result<Vec<String>, String> {
    let title = sanitize_pr_title(title)?;
    let body = sanitize_pr_body(Some(body))?;
    let base = sanitize_ship_branch(Some(base))?
        .unwrap_or_else(|| "main".into());
    let repo = sanitize_github_repo_arg(repo)?;
    let head = match head {
        Some(h) if !h.trim().is_empty() => {
            let h = h.trim();
            if h.starts_with('-') || h.contains('\0') || h.contains('\n') {
                return Err("invalid head".into());
            }
            Some(h.to_string())
        }
        _ => None,
    };

    let mut args = vec![
        "pr".into(),
        "create".into(),
        "--title".into(),
        title,
        "--body".into(),
        body,
    ];
    if let Some(r) = repo {
        args.push("--repo".into());
        args.push(r);
    }
    args.push("--base".into());
    args.push(base);
    if let Some(h) = head {
        args.push("--head".into());
        args.push(h);
    }
    if draft {
        args.push("--draft".into());
    }
    Ok(args)
}

fn git_remote_url(project: &str, name: &str) -> Option<String> {
    let out = crate::process_util::command("git")
        .args(["-C", project, "remote", "get-url", name])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn git_current_branch(project: &str) -> Option<String> {
    let out = crate::process_util::command("git")
        .args(["-C", project, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if b.is_empty() || b == "HEAD" {
        None
    } else {
        Some(b)
    }
}

fn probe_binary_on_path(bin: &str) -> bool {
    let mut cmd = crate::process_util::command(bin);
    if let Some(path_env) = crate::process_util::enriched_path_env() {
        cmd.env("PATH", path_env);
    }
    cmd.arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn apply_ship_process_env(cmd: &mut std::process::Command) {
    if let Some(path_env) = crate::process_util::enriched_path_env() {
        cmd.env("PATH", path_env);
    }
    #[cfg(unix)]
    {
        if std::path::Path::new("/usr/bin/ssh").exists() {
            cmd.env("GIT_SSH_COMMAND", "/usr/bin/ssh");
        }
    }
}

/// Push the current HEAD branch to `origin` (`git push -u origin HEAD`).
/// Soft-fails when git / remote / non-repo are missing (available=false).
#[tauri::command]
pub async fn git_push_branch(project_path: String) -> Result<GitPushBranchResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Ok(GitPushBranchResult {
            available: false,
            ok: false,
            branch: None,
            remote: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("empty path".into()),
        });
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Ok(GitPushBranchResult {
            available: false,
            ok: false,
            branch: None,
            remote: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("project not a directory".into()),
        });
    }
    if let Err(reason) = git_probe_work_tree(&project) {
        return Ok(GitPushBranchResult {
            available: false,
            ok: false,
            branch: None,
            remote: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some(reason),
        });
    }

    let branch = git_current_branch(&project);
    let remote = git_remote_url(&project, "origin");
    if remote.is_none() {
        return Ok(GitPushBranchResult {
            available: false,
            ok: false,
            branch,
            remote: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("no origin remote".into()),
        });
    }

    let args = build_git_push_args(&project)?;
    let project_for_cmd = project.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = crate::process_util::command("git");
        apply_ship_process_env(&mut cmd);
        cmd.args(&args)
            .current_dir(&project_for_cmd)
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let stdout = ship_redact_output(&String::from_utf8_lossy(&out.stdout), 4000);
    let stderr = ship_redact_output(&String::from_utf8_lossy(&out.stderr), 4000);
    if out.status.success() {
        Ok(GitPushBranchResult {
            available: true,
            ok: true,
            branch,
            remote,
            stdout,
            stderr,
            reason: None,
        })
    } else {
        let reason = if !stderr.is_empty() {
            stderr.chars().take(400).collect()
        } else if !stdout.is_empty() {
            stdout.chars().take(400).collect()
        } else {
            "git push failed".into()
        };
        Ok(GitPushBranchResult {
            available: true,
            ok: false,
            branch,
            remote,
            stdout,
            stderr,
            reason: Some(reason),
        })
    }
}

/// Create a GitHub pull request via `gh pr create` (argv only, no shell).
/// Soft-fails when `gh` is missing. Never reports ok without a PR URL.
#[tauri::command]
pub async fn gh_pr_create(
    project_path: String,
    title: String,
    body: Option<String>,
    draft: Option<bool>,
    base: Option<String>,
    head: Option<String>,
    repo: Option<String>,
) -> Result<GhPrCreateResult, String> {
    let project = normalize_fs_path(&project_path);
    if project.is_empty() {
        return Ok(GhPrCreateResult {
            available: false,
            ok: false,
            url: None,
            repo: None,
            base: None,
            head: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("empty path".into()),
        });
    }
    let proj = std::path::PathBuf::from(&project);
    if !proj.is_dir() {
        return Ok(GhPrCreateResult {
            available: false,
            ok: false,
            url: None,
            repo: None,
            base: None,
            head: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("project not a directory".into()),
        });
    }
    if let Err(reason) = git_probe_work_tree(&project) {
        return Ok(GhPrCreateResult {
            available: false,
            ok: false,
            url: None,
            repo: None,
            base: None,
            head: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some(reason),
        });
    }

    if !probe_binary_on_path("gh") {
        return Ok(GhPrCreateResult {
            available: false,
            ok: false,
            url: None,
            repo: None,
            base: None,
            head: None,
            stdout: String::new(),
            stderr: String::new(),
            reason: Some("gh not available".into()),
        });
    }

    let branch = git_current_branch(&project);
    let origin_url = git_remote_url(&project, "origin");
    let upstream_url = git_remote_url(&project, "upstream");
    let origin_or = origin_url.as_deref().and_then(parse_github_owner_repo);
    let upstream_or = upstream_url.as_deref().and_then(parse_github_owner_repo);

    let repo_arg = match sanitize_github_repo_arg(repo.as_deref())? {
        Some(r) => Some(r),
        None => upstream_or.clone().or_else(|| origin_or.clone()),
    };
    let base_branch = sanitize_ship_branch(base.as_deref())?
        .unwrap_or_else(|| "main".into());
    let head_ref = if let Some(h) = head.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if h.starts_with('-') || h.contains('\0') || h.contains('\n') {
            return Err("invalid head".into());
        }
        Some(h.to_string())
    } else if let Some(ref b) = branch {
        let h = build_gh_head_ref(
            b,
            origin_or.as_deref(),
            repo_arg.as_deref(),
        );
        if h.is_empty() {
            None
        } else {
            Some(h)
        }
    } else {
        None
    };

    let title_s = sanitize_pr_title(&title)?;
    let body_s = sanitize_pr_body(body.as_deref())?;
    let draft_flag = draft.unwrap_or(false);
    let args = build_gh_pr_create_args(
        &title_s,
        &body_s,
        draft_flag,
        &base_branch,
        head_ref.as_deref(),
        repo_arg.as_deref(),
    )?;

    let project_for_cmd = project.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = crate::process_util::command("gh");
        apply_ship_process_env(&mut cmd);
        cmd.args(&args)
            .current_dir(&project_for_cmd)
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let stdout = ship_redact_output(&String::from_utf8_lossy(&out.stdout), 4000);
    let stderr = ship_redact_output(&String::from_utf8_lossy(&out.stderr), 4000);
    let combined = format!("{stdout}\n{stderr}");
    let url = parse_gh_pr_url(&combined);

    if out.status.success() {
        if let Some(u) = url {
            Ok(GhPrCreateResult {
                available: true,
                ok: true,
                url: Some(u),
                repo: repo_arg,
                base: Some(base_branch),
                head: head_ref,
                stdout,
                stderr,
                reason: None,
            })
        } else {
            // Never fake success without a URL.
            Ok(GhPrCreateResult {
                available: true,
                ok: false,
                url: None,
                repo: repo_arg,
                base: Some(base_branch),
                head: head_ref,
                stdout,
                stderr,
                reason: Some("gh pr create succeeded but PR URL missing".into()),
            })
        }
    } else {
        let reason = if !stderr.is_empty() {
            stderr.chars().take(400).collect()
        } else if !stdout.is_empty() {
            stdout.chars().take(400).collect()
        } else {
            "gh pr create failed".into()
        };
        Ok(GhPrCreateResult {
            available: true,
            ok: false,
            url,
            repo: repo_arg,
            base: Some(base_branch),
            head: head_ref,
            stdout,
            stderr,
            reason: Some(reason),
        })
    }
}

#[cfg(test)]
mod ship_flow_tests {
    use super::*;

    #[test]
    fn parse_github_owner_repo_ssh_https() {
        assert_eq!(
            parse_github_owner_repo("git@github.com:RongleCat/grok-app.git").as_deref(),
            Some("RongleCat/grok-app")
        );
        assert_eq!(
            parse_github_owner_repo("https://github.com/sonnemusk/grok-app.git").as_deref(),
            Some("sonnemusk/grok-app")
        );
    }

    #[test]
    fn build_gh_head_fork_vs_same() {
        assert_eq!(
            build_gh_head_ref(
                "feat/wt-ship-flow",
                Some("sonnemusk/grok-app"),
                Some("RongleCat/grok-app"),
            ),
            "sonnemusk:feat/wt-ship-flow"
        );
        assert_eq!(
            build_gh_head_ref(
                "feat/x",
                Some("RongleCat/grok-app"),
                Some("RongleCat/grok-app"),
            ),
            "feat/x"
        );
    }

    #[test]
    fn parse_gh_pr_url_extracts() {
        let out = "Creating pull request for feat/x into main in RongleCat/grok-app\n\nhttps://github.com/RongleCat/grok-app/pull/99\n";
        assert_eq!(
            parse_gh_pr_url(out).as_deref(),
            Some("https://github.com/RongleCat/grok-app/pull/99")
        );
        assert!(parse_gh_pr_url("nope").is_none());
    }

    #[test]
    fn build_git_push_args_ok() {
        let a = build_git_push_args("/Users/me/repo").unwrap();
        assert_eq!(
            a,
            vec!["-C", "/Users/me/repo", "push", "-u", "origin", "HEAD"]
        );
        assert!(build_git_push_args("").is_err());
        assert!(build_git_push_args("-C").is_err());
    }

    #[test]
    fn build_gh_pr_create_args_fork_shape() {
        let a = build_gh_pr_create_args(
            "feat: ship",
            "body",
            true,
            "main",
            Some("sonnemusk:feat/wt-ship-flow"),
            Some("RongleCat/grok-app"),
        )
        .unwrap();
        assert!(a.windows(2).any(|w| w == ["--repo", "RongleCat/grok-app"]));
        assert!(a
            .windows(2)
            .any(|w| w == ["--head", "sonnemusk:feat/wt-ship-flow"]));
        assert!(a.iter().any(|x| x == "--draft"));
        assert!(a.windows(2).any(|w| w == ["--title", "feat: ship"]));
    }

    #[test]
    fn sanitize_pr_title_required() {
        assert!(sanitize_pr_title("  ").is_err());
        assert_eq!(sanitize_pr_title("Hello\nworld").unwrap(), "Hello world");
    }
}

