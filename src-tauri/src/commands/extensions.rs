
/// List invocable skills from `grok inspect --json`.
/// Always returns Ok; on CLI missing / timeout, `skills` is empty and `error` is set.
/// Each skill includes `enabled` from App Extensions prefs (default true).
#[tauri::command]
pub async fn skills_list(project_path: Option<String>) -> Result<serde_json::Value, String> {
    let path = project_path.clone();
    let (parsed, error) = tauri::async_runtime::spawn_blocking(move || {
        run_grok_inspect(path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;

    let skills = parsed.as_ref().map(parse_skills).unwrap_or_default();
    let skills = attach_skill_enabled(skills);
    let skill_roots = crate::skill_edit::skill_roots_list(project_path.as_deref());
    let mut out = serde_json::json!({
        "skills": skills,
        "skillRoots": skill_roots,
    });
    if let Some(err) = error {
        out["error"] = serde_json::Value::String(err);
    }
    Ok(out)
}

/// Read a user-editable SKILL.md (allowlisted skills roots only).
#[tauri::command]
pub async fn skill_read(
    path: String,
    project_path: Option<String>,
) -> Result<crate::skill_edit::SkillReadResult, String> {
    let path = path.clone();
    let project_path = project_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::skill_edit::skill_read(&path, project_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a user-editable SKILL.md (allowlisted skills roots only).
#[tauri::command]
pub async fn skill_write(
    path: String,
    content: String,
    expected_mtime_ms: Option<u64>,
    project_path: Option<String>,
) -> Result<crate::skill_edit::SkillWriteResult, String> {
    let path = path.clone();
    let content = content.clone();
    let project_path = project_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::skill_edit::skill_write(
            &path,
            &content,
            expected_mtime_ms,
            project_path.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Absolute paths of allowlisted skill roots (for UI edit affordances).
#[tauri::command]
pub async fn skill_roots(project_path: Option<String>) -> Result<Vec<String>, String> {
    Ok(crate::skill_edit::skill_roots_list(project_path.as_deref()))
}

/// Scaffold a new skill directory + SKILL.md under user (path-scoped GROK_HOME)
/// or project skills root. Does not overwrite an existing SKILL.md.
#[tauri::command]
pub async fn skill_create(
    name: String,
    description: Option<String>,
    project_path: Option<String>,
    scope: Option<String>,
) -> Result<crate::skill_edit::SkillCreateResult, String> {
    let name = name.clone();
    let description = description.unwrap_or_default();
    let project_path = project_path.clone();
    let scope = scope.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::skill_edit::skill_create(
            &name,
            &description,
            project_path.as_deref(),
            scope.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List MCP servers from `grok inspect --json`.
/// Always returns Ok; on CLI missing / timeout, `servers` is empty and `error` is set.
/// Each server includes `enabled` from App Extensions prefs (default true).
#[tauri::command]
pub async fn inspect_mcp(project_path: Option<String>) -> Result<serde_json::Value, String> {
    let path = project_path.clone();
    let (parsed, error) = tauri::async_runtime::spawn_blocking(move || {
        run_grok_inspect(path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut servers = parsed.as_ref().map(parse_mcp_servers).unwrap_or_default();
    let prefs = crate::extensions::load_prefs();
    // Enrich with enable state for UI toggles.
    let mut server_json = Vec::with_capacity(servers.len());
    for s in servers.drain(..) {
        let enabled = crate::extensions::is_enabled(&prefs.mcp, &s.name);
        server_json.push(serde_json::json!({
            "name": s.name,
            "transport": s.transport,
            "target": s.target,
            "vendor": s.vendor,
            "compatibilityStatus": s.compatibility_status,
            "enabled": enabled,
        }));
    }
    let mut out = serde_json::json!({ "servers": server_json });
    if let Some(err) = error {
        out["error"] = serde_json::Value::String(err);
    }
    Ok(out)
}

// ── Project inspect summary (Settings → Runtime) ─────────────────────────────

const PROJECT_INSPECT_SKILL_SAMPLE: usize = 12;

/// Detect `<project>/.grok` when the path is a real directory.
fn project_grok_dir(project_path: Option<&str>) -> (bool, Option<String>) {
    let Some(raw) = project_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return (false, None);
    };
    let p = std::path::Path::new(raw).join(".grok");
    if p.is_dir() {
        (true, Some(p.to_string_lossy().to_string()))
    } else {
        (false, Some(p.to_string_lossy().to_string()))
    }
}

fn json_str(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn skill_source_label(source: &serde_json::Value) -> String {
    if let Some(s) = source.as_str() {
        return s.trim().to_lowercase();
    }
    if let Some(obj) = source.as_object() {
        if let Some(t) = obj.get("type").and_then(|x| x.as_str()) {
            return t.trim().to_lowercase();
        }
    }
    "unknown".into()
}

/// Build a secret-safe summary DTO from `grok inspect --json`.
/// Only known safe fields are copied — never forward raw env/headers/secrets.
fn build_project_inspect_summary(
    parsed: Option<&serde_json::Value>,
    project_path: Option<&str>,
    error: Option<String>,
    models_hints: Vec<String>,
) -> serde_json::Value {
    let (has_grok, grok_path) = project_grok_dir(project_path);
    let path_trim = project_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let mut models_hints = models_hints;
    let mut seen_models: std::collections::HashSet<String> =
        models_hints.iter().cloned().collect();
    let mut push_model = |s: String| {
        let t = s.trim().to_string();
        if t.is_empty() || seen_models.contains(&t) {
            return;
        }
        seen_models.insert(t.clone());
        models_hints.push(t);
    };

    let Some(v) = parsed else {
        return serde_json::json!({
            "projectPath": path_trim,
            "projectRoot": null,
            "projectTrusted": null,
            "cwd": null,
            "grokVersion": null,
            "channel": null,
            "hasProjectGrokDir": has_grok,
            "projectGrokPath": if has_grok { grok_path } else { None::<String> },
            "rules": [],
            "plugins": [],
            "skills": {
                "total": 0,
                "userInvocable": 0,
                "bySource": {},
                "sample": [],
                "names": [],
            },
            "mcp": [],
            "agents": [],
            "hooks": [],
            "hooksCount": 0,
            "configLayers": [],
            "modelsHints": models_hints,
            "permissions": {
                "loaded": 0,
                "sourcesCount": 0,
                "managedSettingsActive": false,
                "managedSettingsExists": null,
                "managedSettingsPath": null,
            },
            "error": error,
        });
    };

    let project_root = json_str(v.get("projectRoot"));
    let project_path_out = path_trim
        .clone()
        .or_else(|| project_root.clone());

    // Rules / project instructions — paths only.
    let mut rules = Vec::new();
    let instr = v
        .get("projectInstructions")
        .or_else(|| v.get("rules"))
        .and_then(|x| x.as_array());
    if let Some(arr) = instr {
        for item in arr {
            let path = json_str(item.get("path"));
            let Some(path) = path else { continue };
            rules.push(serde_json::json!({
                "path": path,
                "scope": json_str(item.get("scope")),
                "fileType": json_str(item.get("fileType"))
                    .or_else(|| json_str(item.get("file_type"))),
                "sizeBytes": item.get("sizeBytes").and_then(|x| x.as_u64())
                    .or_else(|| item.get("size_bytes").and_then(|x| x.as_u64())),
            }));
        }
    }

    // Plugins — no free-form blobs.
    let mut plugins = Vec::new();
    if let Some(arr) = v.get("plugins").and_then(|x| x.as_array()) {
        for item in arr {
            let name = json_str(item.get("name"));
            let Some(name) = name else { continue };
            let provides = item.get("provides").map(|p| {
                serde_json::json!({
                    "skills": p.get("skills").and_then(|x| x.as_u64()).unwrap_or(0),
                    "agents": p.get("agents").and_then(|x| x.as_u64()).unwrap_or(0),
                    "hooks": p.get("hooks").and_then(|x| x.as_bool()).unwrap_or(false),
                    "mcpServers": p.get("mcpServers")
                        .or_else(|| p.get("mcp_servers"))
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0),
                })
            });
            plugins.push(serde_json::json!({
                "name": name,
                "scope": json_str(item.get("scope")),
                "enabled": item.get("enabled").and_then(|x| x.as_bool()),
                "path": json_str(item.get("path")),
                "provides": provides,
            }));
        }
    }

    // Skills — counts + all names + short invocable sample (no descriptions).
    let mut by_source: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut user_invocable: u64 = 0;
    let mut sample_names: Vec<String> = Vec::new();
    let mut all_skill_names: Vec<String> = Vec::new();
    let skill_arr = v.get("skills").and_then(|x| x.as_array());
    let skill_total = skill_arr.map(|a| a.len()).unwrap_or(0);
    if let Some(arr) = skill_arr {
        for item in arr {
            let name = json_str(item.get("name"));
            let Some(name) = name else { continue };
            all_skill_names.push(name.clone());
            let src = skill_source_label(
                item.get("source").unwrap_or(&serde_json::Value::Null),
            );
            let count = by_source
                .get(&src)
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            by_source.insert(src, serde_json::json!(count + 1));
            let inv = item
                .get("userInvocable")
                .or_else(|| item.get("user_invocable"))
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            if inv {
                user_invocable += 1;
                sample_names.push(name);
            }
        }
    }
    sample_names.sort();
    sample_names.truncate(PROJECT_INSPECT_SKILL_SAMPLE);
    all_skill_names.sort();

    // MCP — name/transport/target/source type only (never env/headers).
    let mut mcp = Vec::new();
    let mcp_arr = v
        .get("mcpServers")
        .or_else(|| v.get("mcp"))
        .and_then(|x| x.as_array());
    if let Some(arr) = mcp_arr {
        for item in arr {
            let name = json_str(item.get("name"));
            let Some(name) = name else { continue };
            let source = item
                .get("source")
                .map(|s| skill_source_label(s))
                .filter(|s| s != "unknown");
            mcp.push(serde_json::json!({
                "name": name,
                "transport": json_str(item.get("transport")),
                "target": json_str(item.get("target")),
                "source": source,
            }));
        }
    }

    // Agents
    let mut agents = Vec::new();
    if let Some(arr) = v.get("agents").and_then(|x| x.as_array()) {
        for item in arr {
            let name = json_str(item.get("name"));
            let Some(name) = name else { continue };
            let source = skill_source_label(
                item.get("source").unwrap_or(&serde_json::Value::Null),
            );
            agents.push(serde_json::json!({
                "name": name,
                "source": source,
            }));
        }
    }

    // Hooks — event / type / target / source type only (no env / command bodies).
    let mut hooks = Vec::new();
    if let Some(arr) = v.get("hooks").and_then(|x| x.as_array()) {
        for item in arr {
            if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                hooks.push(serde_json::json!({ "event": s }));
                continue;
            }
            let Some(obj) = item.as_object() else { continue };
            let event = json_str(obj.get("event")).or_else(|| json_str(obj.get("name")));
            let hook_type = json_str(obj.get("hookType"))
                .or_else(|| json_str(obj.get("hook_type")))
                .or_else(|| json_str(obj.get("type")));
            let target = json_str(obj.get("target")).or_else(|| json_str(obj.get("path")));
            let source = obj
                .get("source")
                .map(skill_source_label)
                .or_else(|| json_str(obj.get("plugin")));
            let matcher = json_str(obj.get("matcher"));
            if event.is_none() && hook_type.is_none() && target.is_none() {
                continue;
            }
            hooks.push(serde_json::json!({
                "event": event,
                "hookType": hook_type,
                "target": target,
                "source": source,
                "matcher": matcher,
            }));
        }
    }

    // Config layers — paths only.
    let mut config_layers = Vec::new();
    if let Some(layers) = v
        .get("configSources")
        .and_then(|x| x.get("layers"))
        .and_then(|x| x.as_array())
    {
        for item in layers {
            config_layers.push(serde_json::json!({
                "role": json_str(item.get("role")),
                "path": json_str(item.get("path")),
            }));
        }
    }

    // Permissions — counts/flags only (no allowlist bodies that might embed tokens).
    let perm = v.get("permissions");
    let sources_count = perm
        .and_then(|p| p.get("sources"))
        .and_then(|x| x.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let loaded = perm
        .and_then(|p| p.get("loaded"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let managed_active = perm
        .and_then(|p| p.get("managedSettingsActive"))
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let managed_exists = perm
        .and_then(|p| p.get("managedSettingsExists"))
        .and_then(|x| x.as_bool());
    let managed_path = perm
        .and_then(|p| p.get("managedSettingsPath"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| store::redact_text(s).trim().chars().take(400).collect::<String>());

    // Models hints from inspect when present.
    if let Some(arr) = v.get("models").and_then(|x| x.as_array()) {
        for m in arr {
            if let Some(s) = m.as_str() {
                push_model(s.to_string());
            } else if let Some(id) = json_str(m.get("id"))
                .or_else(|| json_str(m.get("name")))
                .or_else(|| json_str(m.get("model")))
            {
                push_model(id);
            }
        }
    }
    if let Some(ch) = json_str(v.get("channel")) {
        if ch != "unknown" {
            push_model(format!("channel:{ch}"));
        }
    }
    if let Some(dm) = json_str(v.get("defaultModel"))
        .or_else(|| json_str(v.get("default_model")))
    {
        push_model(dm);
    }

    let hooks_count = if !hooks.is_empty() {
        hooks.len()
    } else {
        v.get("hooks")
            .and_then(|x| x.as_array())
            .map(|a| a.len())
            .unwrap_or(0)
    };

    let mut out = serde_json::json!({
        "projectPath": project_path_out,
        "projectRoot": project_root,
        "projectTrusted": v.get("projectTrusted").and_then(|x| x.as_bool()),
        "cwd": json_str(v.get("cwd")),
        "grokVersion": json_str(v.get("grokVersion"))
            .or_else(|| json_str(v.get("grok_version"))),
        "channel": json_str(v.get("channel")),
        "hasProjectGrokDir": has_grok,
        "projectGrokPath": if has_grok { grok_path } else { None::<String> },
        "rules": rules,
        "plugins": plugins,
        "skills": {
            "total": skill_total,
            "userInvocable": user_invocable,
            "bySource": by_source,
            "sample": sample_names,
            "names": all_skill_names,
        },
        "mcp": mcp,
        "agents": agents,
        "hooks": hooks,
        "hooksCount": hooks_count,
        "configLayers": config_layers,
        "modelsHints": models_hints,
        "permissions": {
            "loaded": loaded,
            "sourcesCount": sources_count,
            "managedSettingsActive": managed_active,
            "managedSettingsExists": managed_exists,
            "managedSettingsPath": managed_path,
        },
    });
    if let Some(err) = error {
        // Scrub any token-shaped substrings in error text.
        out["error"] = serde_json::Value::String(crate::store::redact_text(&err));
    } else {
        out["error"] = serde_json::Value::Null;
    }
    out
}

/// Full project inspect summary for Settings → Runtime.
/// Runs `grok inspect --json` with optional project cwd; returns a sanitized DTO
/// (plugins / skills counts / MCP / rules paths / model hints). Never includes secrets.
#[tauri::command]
pub async fn project_inspect(project_path: Option<String>) -> Result<serde_json::Value, String> {
    let path = project_path.clone();
    let (parsed, error) = tauri::async_runtime::spawn_blocking(move || {
        run_grok_inspect(path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;

    // Model ids from local cache (hints only — not secrets).
    let models_hints: Vec<String> = {
        let catalog = crate::models_catalog::list_available_models();
        let mut hints = Vec::new();
        if !catalog.default_model_id.trim().is_empty() {
            hints.push(catalog.default_model_id.clone());
        }
        for m in catalog.models.iter().take(8) {
            if !hints.iter().any(|h| h == &m.id) {
                hints.push(m.id.clone());
            }
        }
        hints
    };

    Ok(build_project_inspect_summary(
        parsed.as_ref(),
        project_path.as_deref(),
        error,
        models_hints,
    ))
}

/// List skills from `grok inspect --json`, each with App `enabled` (default true).
/// (skills_list already exists; this keeps enable flags on the existing shape.)
fn attach_skill_enabled(skills: Vec<SkillDto>) -> Vec<serde_json::Value> {
    let prefs = crate::extensions::load_prefs();
    skills
        .into_iter()
        .map(|s| {
            let enabled = crate::extensions::is_enabled(&prefs.skills, &s.name);
            serde_json::json!({
                "name": s.name,
                "description": s.description,
                "source": s.source,
                "path": s.path,
                "userInvocable": s.user_invocable,
                "enabled": enabled,
            })
        })
        .collect()
}

/// Current Extensions enable prefs (`extensions.json`).
#[tauri::command]
pub async fn extensions_get() -> Result<crate::extensions::ExtensionsPrefs, String> {
    Ok(crate::extensions::load_prefs())
}

/// Toggle one MCP server; persists prefs, syncs agent-home/config, soft-respawns.
#[tauri::command]
pub async fn extensions_set_mcp(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
    enabled: bool,
) -> Result<crate::extensions::ExtensionsPrefs, String> {
    let prefs = tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::set_mcp_enabled(&name, enabled)
    })
    .await
    .map_err(|e| e.to_string())??;
    mgr.apply_extensions_mcp_change(&app).await;
    Ok(prefs)
}

/// Toggle one skill (App filter for slash/composer); persists immediately.
#[tauri::command]
pub async fn extensions_set_skill(
    name: String,
    enabled: bool,
) -> Result<crate::extensions::ExtensionsPrefs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::set_skill_enabled(&name, enabled)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bulk-enable all listed MCP servers; soft-respawns when a live agent exists.
#[tauri::command]
pub async fn extensions_enable_all_mcp(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    names: Vec<String>,
) -> Result<crate::extensions::ExtensionsPrefs, String> {
    let prefs = tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::enable_all_mcp(&names)
    })
    .await
    .map_err(|e| e.to_string())??;
    mgr.apply_extensions_mcp_change(&app).await;
    Ok(prefs)
}

/// Bulk-enable all listed skills.
#[tauri::command]
pub async fn extensions_enable_all_skills(
    names: Vec<String>,
) -> Result<crate::extensions::ExtensionsPrefs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::extensions::enable_all_skills(&names)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Plugins via Grok Build CLI (`grok plugin …` + `inspect` + config.toml) ──
//
// Keep field semantics aligned with Grok Build:
// - install inventory: `grok plugin list --json` (status/name/version/source/…)
// - enable/disable: `~/.grok/config.toml` `[plugins].disabled` / CLI enable|disable
// - scope + component counts: `grok inspect --json` → `plugins[]`
// Do not invent a parallel store or rewrite CLI `status` values.

const PLUGIN_CMD_TIMEOUT_SECS: u64 = 30;
/// Install / update pull git or marketplace cache; allow longer than enable/list.
const PLUGIN_MUTATE_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProvidesDto {
    #[serde(default)]
    pub skills: u32,
    #[serde(default)]
    pub agents: u32,
    #[serde(default)]
    pub hooks: bool,
    #[serde(default)]
    pub mcp_servers: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDto {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Install status from `plugin list --json` (usually `"installed"`). Not enable/disable.
    pub status: String,
    /// Load state from Grok Build config (`[plugins].disabled` / enable CLI).
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_key: Option<String>,
    /// Grok Build scope: user / project / cli / custom path / marketplace name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Component inventory from `grok inspect` (skills / agents / hooks / mcp).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provides: Option<PluginProvidesDto>,
}

/// Run probed CLI with the given args. Returns (stdout, stderr, ok).
fn run_grok_cli_args(args: &[&str], timeout_secs: u64) -> Result<(String, String, bool), String> {
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let Some(cli_path) = probe.path.filter(|_| probe.found) else {
        return Err("Grok Build CLI not found".into());
    };

    let args_owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.args(&args_owned);
        crate::process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = crate::process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        let result = cmd.output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Ok((stdout, stderr, output.status.success()))
        }
        Ok(Err(e)) => Err(format!("Failed to run grok: {e}")),
        Err(_) => Err(format!("grok command timed out after {timeout_secs}s")),
    }
}

/// Path to the user-level Grok config that tracks plugin enable/disable.
/// Same file Grok Build reads for `[plugins].enabled` / `[plugins].disabled`.
fn user_grok_config_toml() -> std::path::PathBuf {
    crate::process_util::user_home().join(".grok").join("config.toml")
}

/// Parse a string-array key under `[plugins]` (single- or multi-line).
pub fn parse_plugins_toml_string_array(toml_text: &str, key: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let mut in_plugins = false;
    let mut collecting = false;
    let mut buf = String::new();
    let key_prefix = key;

    for line in toml_text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if collecting {
                break;
            }
            in_plugins = trimmed == "[plugins]";
            continue;
        }
        if !in_plugins {
            continue;
        }
        if collecting {
            buf.push(' ');
            buf.push_str(trimmed);
            if trimmed.contains(']') {
                collecting = false;
                for name in extract_toml_string_array(&buf) {
                    out.insert(name);
                }
                buf.clear();
            }
            continue;
        }
        if let Some(rest) = trimmed
            .strip_prefix(key_prefix)
            .map(str::trim)
            .and_then(|s| s.strip_prefix('='))
            .map(str::trim)
        {
            if rest.contains('[') && rest.contains(']') {
                for name in extract_toml_string_array(rest) {
                    out.insert(name);
                }
            } else if rest.contains('[') {
                collecting = true;
                buf = rest.to_string();
            }
        }
    }
    out
}

/// Grok Build config: plugin IDs or plain names listed under `[plugins].disabled`.
pub fn parse_plugins_disabled_names(toml_text: &str) -> std::collections::HashSet<String> {
    parse_plugins_toml_string_array(toml_text, "disabled")
}

fn extract_toml_string_array(s: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            let quote = c;
            let mut name = String::new();
            while let Some(ch) = chars.next() {
                if ch == quote {
                    break;
                }
                if ch == '\\' {
                    if let Some(escaped) = chars.next() {
                        name.push(escaped);
                    }
                } else {
                    name.push(ch);
                }
            }
            let n = name.trim();
            if !n.is_empty() {
                names.push(n.to_string());
            }
        }
    }
    names
}

fn load_disabled_plugin_entries() -> std::collections::HashSet<String> {
    let path = user_grok_config_toml();
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_plugins_disabled_names(&text),
        Err(_) => std::collections::HashSet::new(),
    }
}

/// Match Grok Build disabled entries: plain name or full id `scope/hash/name`.
pub fn plugin_matches_disabled(
    name: &str,
    repo_key: Option<&str>,
    disabled: &std::collections::HashSet<String>,
) -> bool {
    if disabled.is_empty() {
        return false;
    }
    if disabled.contains(name) {
        return true;
    }
    for entry in disabled {
        let e = entry.trim();
        if e.is_empty() {
            continue;
        }
        // Full plugin id: <scope>/<hash>/<name>
        if let Some((head, tail)) = e.rsplit_once('/') {
            if tail == name {
                // Optional: also match hash against repo_key suffix
                if let Some(rk) = repo_key {
                    if head.ends_with(rk) || rk.ends_with(head.rsplit_once('/').map(|(_, h)| h).unwrap_or(head)) {
                        return true;
                    }
                }
                return true;
            }
        }
        if let Some(rk) = repo_key {
            if e == rk || e.ends_with(&format!("/{rk}")) {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone, Default)]
struct InspectPluginExtra {
    scope: Option<String>,
    provides: Option<PluginProvidesDto>,
}

fn parse_inspect_plugins_map(
    inspect_json: &serde_json::Value,
) -> std::collections::HashMap<String, InspectPluginExtra> {
    let mut map = std::collections::HashMap::new();
    let Some(arr) = inspect_json.get("plugins").and_then(|x| x.as_array()) else {
        return map;
    };
    for item in arr {
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let scope = item
            .get("scope")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let provides = item.get("provides").map(|p| PluginProvidesDto {
            skills: p
                .get("skills")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
            agents: p
                .get("agents")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
            hooks: p.get("hooks").and_then(|x| x.as_bool()).unwrap_or(false),
            mcp_servers: p
                .get("mcpServers")
                .or_else(|| p.get("mcp_servers"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
        });
        let extra = InspectPluginExtra { scope, provides };
        // Key by name and path so duplicate names (e.g. two cloudflare installs) can match path.
        map.insert(name.clone(), extra.clone());
        if let Some(p) = path {
            map.insert(format!("path:{p}"), extra);
        }
    }
    map
}

fn parse_plugin_list_json(
    raw: &str,
    disabled: &std::collections::HashSet<String>,
    inspect_extra: &std::collections::HashMap<String, InspectPluginExtra>,
) -> Result<Vec<PluginDto>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Failed to parse plugin list JSON: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "plugin list JSON is not an array".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let version = item
            .get("version")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let source = item
            .get("source")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let marketplace = item
            .get("marketplace")
            .and_then(|x| {
                if x.is_null() {
                    None
                } else {
                    x.as_str()
                }
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let repo_key = item
            .get("repo_key")
            .or_else(|| item.get("repoKey"))
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        // Preserve CLI install status verbatim (do not invent "disabled" status).
        let status = item
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("installed")
            .trim()
            .to_string();
        let status = if status.is_empty() {
            "installed".to_string()
        } else {
            status
        };
        let enabled = !plugin_matches_disabled(&name, repo_key.as_deref(), disabled);

        // Prefer path-keyed inspect row, then name.
        let extra = path
            .as_ref()
            .and_then(|p| inspect_extra.get(&format!("path:{p}")))
            .or_else(|| inspect_extra.get(&name));

        // Scope: inspect first, else marketplace name, else "user" for installed-plugins paths.
        let scope = extra
            .and_then(|e| e.scope.clone())
            .or_else(|| marketplace.clone())
            .or_else(|| {
                path.as_ref().and_then(|p| {
                    if p.contains("installed-plugins") {
                        Some("user".into())
                    } else {
                        None
                    }
                })
            });

        out.push(PluginDto {
            name,
            version,
            source,
            marketplace,
            path,
            status,
            enabled,
            repo_key,
            scope,
            provides: extra.and_then(|e| e.provides.clone()),
        });
    }
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| {
                a.repo_key
                    .as_deref()
                    .unwrap_or("")
                    .cmp(b.repo_key.as_deref().unwrap_or(""))
            })
    });
    Ok(out)
}

fn collect_plugins_list() -> Result<Vec<PluginDto>, String> {
    // Parallel: install inventory + inspect enrich (scope/provides).
    let list_handle = std::thread::spawn(|| {
        run_grok_cli_args(&["plugin", "list", "--json"], PLUGIN_CMD_TIMEOUT_SECS)
    });
    let inspect_handle =
        std::thread::spawn(|| run_grok_cli_args(&["inspect", "--json"], INSPECT_TIMEOUT_SECS));

    let list_result = list_handle
        .join()
        .map_err(|_| "plugin list worker panicked".to_string())?;
    let (stdout, stderr, ok) = list_result?;
    if !ok {
        let msg: String = if !stderr.is_empty() {
            stderr.chars().take(400).collect()
        } else if !stdout.is_empty() {
            stdout.chars().take(400).collect()
        } else {
            "grok plugin list failed".into()
        };
        return Err(msg);
    }
    if stdout.is_empty() {
        return Ok(Vec::new());
    }
    let disabled = load_disabled_plugin_entries();
    // Best-effort inspect enrich. Failures leave scope/provides empty.
    let inspect_extra = match inspect_handle.join() {
        Ok(Ok((body, _, true))) if !body.is_empty() => {
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => parse_inspect_plugins_map(&v),
                Err(_) => std::collections::HashMap::new(),
            }
        }
        _ => std::collections::HashMap::new(),
    };
    parse_plugin_list_json(&stdout, &disabled, &inspect_extra)
}

/// List installed plugins (Grok Build inventory + enable state + inspect extras).
/// Always returns Ok; on CLI missing / failure, `plugins` is empty and `error` is set.
#[tauri::command]
pub async fn plugins_list() -> Result<serde_json::Value, String> {
    let result = tauri::async_runtime::spawn_blocking(collect_plugins_list)
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(plugins) => Ok(serde_json::json!({ "plugins": plugins })),
        Err(e) => Ok(serde_json::json!({
            "plugins": [],
            "error": e,
        })),
    }
}

/// Enable a plugin by name (`grok plugin enable <name>`). Soft-respawns agent.
#[tauri::command]
pub async fn plugin_enable(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "enable", &name_for_cmd],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to enable plugin {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "message": stdout.chars().take(200).collect::<String>(),
    }))
}

/// Disable a plugin by name (`grok plugin disable <name>`). Soft-respawns agent.
#[tauri::command]
pub async fn plugin_disable(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "disable", &name_for_cmd],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to disable plugin {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "message": stdout.chars().take(200).collect::<String>(),
    }))
}

/// Uninstall a plugin by name. Soft-respawns agent on success.
#[tauri::command]
pub async fn plugin_uninstall(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "uninstall", &name_for_cmd, "--confirm"],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to uninstall plugin {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "message": stdout.chars().take(200).collect::<String>(),
    }))
}

/// Plugin component inventory text (`grok plugin details <name>`).
#[tauri::command]
pub async fn plugin_details(name: String) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin name required".into());
    }
    let name_for_cmd = name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_grok_cli_args(
            &["plugin", "details", &name_for_cmd],
            PLUGIN_CMD_TIMEOUT_SECS,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to load details for {name}")
        };
        return Err(msg.chars().take(400).collect());
    }
    Ok(serde_json::json!({
        "name": name,
        "details": stdout,
    }))
}

/// Trim install source; reject empty. Accepts path, git URL, or GitHub shorthand.
pub fn normalize_plugin_install_source(source: &str) -> Result<String, String> {
    let s = source.trim();
    if s.is_empty() {
        return Err("plugin source required".into());
    }
    Ok(s.to_string())
}

/// Optional update target: empty / whitespace → update all (`None`).
pub fn normalize_plugin_update_name(name: Option<&str>) -> Option<String> {
    name.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Best-effort plugin name for `plugin enable` after install.
/// Handles `name`, `name@marketplace`, `owner/repo[@ref]`, git URLs, and paths.
pub fn plugin_name_from_install_source(source: &str) -> Option<String> {
    let s = source.trim();
    if s.is_empty() {
        return None;
    }
    // git@host:path/repo.git
    if s.starts_with("git@") {
        let leaf = s.rsplit([':', '/']).next().unwrap_or("");
        let name = leaf.trim_end_matches(".git");
        return if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        };
    }
    // https://…/repo.git
    if s.contains("://") {
        let leaf = s.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        let name = leaf.trim_end_matches(".git");
        return if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        };
    }
    // Absolute / home / Windows path
    let looks_like_path = s.starts_with('/')
        || s.starts_with('~')
        || (s.len() >= 3
            && s.as_bytes()[1] == b':'
            && (s.as_bytes()[2] == b'\\' || s.as_bytes()[2] == b'/'));
    if looks_like_path {
        let trimmed = s.trim_end_matches(['/', '\\']);
        let leaf = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
        return if leaf.is_empty() {
            None
        } else {
            Some(leaf.to_string())
        };
    }
    // name@marketplace or owner/repo@ref
    if let Some((left, _right)) = s.split_once('@') {
        if left.is_empty() {
            return None;
        }
        if !left.contains('/') {
            return Some(left.to_string());
        }
        let leaf = left.rsplit('/').next().unwrap_or("");
        return if leaf.is_empty() {
            None
        } else {
            Some(leaf.to_string())
        };
    }
    // bare name
    if !s.contains('/') {
        return Some(s.to_string());
    }
    // owner/repo
    let leaf = s.rsplit('/').next().unwrap_or("");
    if leaf.is_empty() {
        None
    } else {
        Some(leaf.to_string())
    }
}

/// Install from path / git URL / GitHub shorthand / marketplace name
/// (`grok plugin install <source> --trust`), then enable, then soft-respawn.
/// `--trust` is required for non-interactive UI; enable so skills/MCP load without a second step.
#[tauri::command]
pub async fn plugin_install(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    source: String,
) -> Result<serde_json::Value, String> {
    let source = normalize_plugin_install_source(&source)?;
    let source_for_cmd = source.clone();
    let enable_name = plugin_name_from_install_source(&source);
    let enable_name_for_cmd = enable_name.clone();
    let result = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, String, bool, Option<String>), String> {
            let (stdout, stderr, ok) = run_grok_cli_args(
                &["plugin", "install", &source_for_cmd, "--trust"],
                PLUGIN_MUTATE_TIMEOUT_SECS,
            )?;
            if !ok {
                return Ok((stdout, stderr, false, None));
            }
            // Plugins stay off until enabled — enable so the install is usable immediately.
            let mut enable_msg: Option<String> = None;
            if let Some(name) = enable_name_for_cmd {
                match run_grok_cli_args(
                    &["plugin", "enable", &name],
                    PLUGIN_CMD_TIMEOUT_SECS,
                ) {
                    Ok((e_out, e_err, e_ok)) => {
                        if e_ok {
                            enable_msg = Some(if e_out.is_empty() {
                                format!("enabled {name}")
                            } else {
                                e_out
                            });
                        } else {
                            // Install succeeded; surface enable failure as soft note.
                            let note = if !e_err.is_empty() {
                                e_err
                            } else if !e_out.is_empty() {
                                e_out
                            } else {
                                format!("installed but failed to enable {name}")
                            };
                            enable_msg = Some(note);
                        }
                    }
                    Err(e) => {
                        enable_msg = Some(format!("installed but enable failed: {e}"));
                    }
                }
            }
            Ok((stdout, stderr, true, enable_msg))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok, enable_msg) = result;
    if !ok {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to install plugin from {source}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    let mut message = stdout.chars().take(400).collect::<String>();
    if let Some(em) = enable_msg {
        if !message.is_empty() {
            message.push_str(" · ");
        }
        message.push_str(&em.chars().take(200).collect::<String>());
    }
    Ok(serde_json::json!({
        "ok": true,
        "name": enable_name.unwrap_or(source),
        "message": message,
    }))
}

/// Update one plugin by name, or all when `name` is null/empty (`grok plugin update [name]`).
/// Soft-respawns agent on success.
#[tauri::command]
pub async fn plugin_update(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let target = normalize_plugin_update_name(name.as_deref());
    let target_for_cmd = target.clone();
    let result = tauri::async_runtime::spawn_blocking(move || match target_for_cmd.as_deref() {
        Some(n) => run_grok_cli_args(&["plugin", "update", n], PLUGIN_MUTATE_TIMEOUT_SECS),
        None => run_grok_cli_args(&["plugin", "update"], PLUGIN_MUTATE_TIMEOUT_SECS),
    })
    .await
    .map_err(|e| e.to_string())??;

    let (stdout, stderr, ok) = result;
    if !ok {
        let label = target.as_deref().unwrap_or("all");
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("failed to update plugin(s): {label}")
        };
        return Err(msg.chars().take(400).collect());
    }
    mgr.soft_respawn(&app).await;
    Ok(serde_json::json!({
        "ok": true,
        "name": target.unwrap_or_default(),
        "message": stdout.chars().take(400).collect::<String>(),
    }))
}

// ── plugin validate (`grok plugin validate [path]`) ─────────────────────────

/// Split stdout + stderr into non-empty lines (stderr first, de-duped).
pub fn parse_plugin_validate_messages(stdout: &str, stderr: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for part in [stderr, stdout] {
        for line in part.lines() {
            let t = line.trim();
            if t.is_empty() || seen.contains(t) {
                continue;
            }
            seen.insert(t.to_string());
            out.push(t.to_string());
        }
    }
    out
}

/// Old CLI rejects `plugin validate` as an unknown subcommand (clap-style).
pub fn looks_like_unsupported_plugin_validate(stderr: &str, stdout: &str) -> bool {
    let s = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    if s.trim().is_empty() {
        return false;
    }
    if s.contains("unrecognized subcommand")
        || s.contains("unknown subcommand")
        || s.contains("unexpected subcommand")
        || s.contains("invalid subcommand")
    {
        return true;
    }
    if s.contains("validate")
        && (s.contains("unexpected argument")
            || s.contains("unrecognized")
            || s.contains("unknown command")
            || s.contains("unknown argument"))
    {
        return true;
    }
    false
}

/// True when `s` looks like a filesystem path (not a bare plugin name / owner/repo).
pub fn looks_like_plugin_validate_path(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    if s.starts_with("git@") || s.contains("://") {
        return false;
    }
    if s.starts_with('/')
        || s.starts_with('~')
        || s.starts_with("./")
        || s.starts_with("../")
        || s.starts_with(".\\")
        || s.starts_with("..\\")
    {
        return true;
    }
    // Windows drive: C:\… or D:/…
    let bytes = s.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    // Relative path segments with separators
    s.contains('/') || s.contains('\\')
}

/// Normalize optional path/name; empty → None (CLI defaults to `.`).
pub fn normalize_plugin_validate_target(path_or_name: Option<&str>) -> Option<String> {
    path_or_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Resolve bare plugin name to installed path via `plugin list --json` (best-effort).
fn resolve_installed_plugin_path(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let (stdout, _stderr, ok) =
        run_grok_cli_args(&["plugin", "list", "--json"], PLUGIN_CMD_TIMEOUT_SECS).ok()?;
    if !ok || stdout.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    let arr = value.as_array()?;
    // Prefer exact name match with a path; if several, first with path.
    let mut fallback: Option<String> = None;
    for item in arr {
        let n = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        if n != name {
            continue;
        }
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        if let Some(p) = path {
            return Some(p);
        }
        if fallback.is_none() {
            fallback = Some(name.to_string());
        }
    }
    fallback
}

/// Resolve validate target: path as-is; bare name → installed path when known.
pub fn resolve_plugin_validate_path(path_or_name: Option<&str>) -> Option<String> {
    let raw = normalize_plugin_validate_target(path_or_name)?;
    if looks_like_plugin_validate_path(&raw) {
        return Some(raw);
    }
    // Bare name (or name@market) — strip @marketplace for list match
    let name = raw.split_once('@').map(|(l, _)| l).unwrap_or(&raw).trim();
    if name.is_empty() {
        return Some(raw);
    }
    resolve_installed_plugin_path(name).or(Some(if name == raw {
        raw
    } else {
        name.to_string()
    }))
}

/// Validate a plugin manifest via `grok plugin validate [path]`.
///
/// - `path_or_name`: local path, installed plugin name, or omit (CLI default `.`)
/// - Always returns an envelope `{ ok, messages[] }` (never hard-fails on CLI-too-old)
/// - Soft-fail: older CLIs without `plugin validate` → `ok: false`, `reason: "cli_too_old"`
#[tauri::command]
pub async fn plugin_validate(
    path_or_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let path_or_name_owned = path_or_name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_plugin_validate_path(path_or_name_owned.as_deref());
        let run = match resolved.as_deref() {
            Some(p) => run_grok_cli_args(
                &["plugin", "validate", p],
                PLUGIN_CMD_TIMEOUT_SECS,
            ),
            None => run_grok_cli_args(&["plugin", "validate"], PLUGIN_CMD_TIMEOUT_SECS),
        };
        (resolved, run)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (resolved, run) = result;
    match run {
        Err(e) => {
            // CLI missing / spawn failure — surface as envelope so UI can show in-panel.
            let msg = e;
            let reason = if msg.to_ascii_lowercase().contains("not found") {
                Some("cli_missing")
            } else {
                None
            };
            Ok(serde_json::json!({
                "ok": false,
                "messages": [msg],
                "path": resolved,
                "reason": reason,
            }))
        }
        Ok((stdout, stderr, exit_ok)) => {
            if looks_like_unsupported_plugin_validate(&stderr, &stdout) {
                return Ok(serde_json::json!({
                    "ok": false,
                    "messages": [
                        format!(
                            "This Grok CLI does not support `plugin validate`; version {} or newer is required. Run `grok update`, then fully restart the app.",
                            crate::cli_probe::min_cli_version_str()
                        )
                    ],
                    "path": resolved,
                    "reason": "cli_too_old",
                }));
            }
            let messages = parse_plugin_validate_messages(&stdout, &stderr);
            let messages = if messages.is_empty() {
                if exit_ok {
                    vec!["Plugin manifest is valid.".to_string()]
                } else {
                    vec!["Plugin validation failed.".to_string()]
                }
            } else {
                messages
            };
            Ok(serde_json::json!({
                "ok": exit_ok,
                "messages": messages,
                "path": resolved,
                "reason": serde_json::Value::Null,
            }))
        }
    }
}

#[cfg(test)]
mod plugin_config_tests {
    use super::*;

    #[test]
    fn parse_disabled_single_line() {
        let toml = r#"
[plugins]
enabled = ["a", "b"]
disabled = ["chrome-devtools-mcp", "x"]
"#;
        let set = parse_plugins_disabled_names(toml);
        assert!(set.contains("chrome-devtools-mcp"));
        assert!(set.contains("x"));
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn parse_disabled_multiline() {
        let toml = r#"
[plugins]
enabled = [
    "cloudflare",
]
disabled = [
    "chrome-devtools-mcp",
    "playwright",
]

[marketplace]
foo = 1
"#;
        let set = parse_plugins_disabled_names(toml);
        assert!(set.contains("chrome-devtools-mcp"));
        assert!(set.contains("playwright"));
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn parse_disabled_empty() {
        let set = parse_plugins_disabled_names("[plugins]\ndisabled = []\n");
        assert!(set.is_empty());
    }

    #[test]
    fn parse_disabled_ignores_other_sections() {
        let toml = r#"
[other]
disabled = ["nope"]

[plugins]
disabled = ["yes"]
"#;
        let set = parse_plugins_disabled_names(toml);
        assert!(set.contains("yes"));
        assert!(!set.contains("nope"));
    }

    #[test]
    fn matches_full_plugin_id_like_grok_build() {
        let mut disabled = std::collections::HashSet::new();
        disabled.insert("user/a0b23c68/chrome-devtools-mcp".into());
        assert!(plugin_matches_disabled(
            "chrome-devtools-mcp",
            Some("chrome-devtools-mcp-a0b23c68"),
            &disabled
        ));
        assert!(!plugin_matches_disabled("other", None, &disabled));
    }

    #[test]
    fn list_json_keeps_cli_status_and_config_enabled() {
        let raw = r#"[
          {"status":"installed","name":"demo","repo_key":"demo-abc","version":"1.0.0","path":"/tmp/demo","source":"https://example.com/demo","marketplace":null}
        ]"#;
        let mut disabled = std::collections::HashSet::new();
        disabled.insert("demo".into());
        let empty = std::collections::HashMap::new();
        let plugins = parse_plugin_list_json(raw, &disabled, &empty).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].status, "installed"); // CLI install status preserved
        assert!(!plugins[0].enabled); // config disabled
    }

    #[test]
    fn merges_inspect_scope_and_provides() {
        let raw = r#"[
          {"status":"installed","name":"superpowers","repo_key":"superpowers-599","version":"6.1.1","path":"/p/superpowers","source":"https://github.com/obra/superpowers","marketplace":null}
        ]"#;
        let disabled = std::collections::HashSet::new();
        let mut extra = std::collections::HashMap::new();
        extra.insert(
            "path:/p/superpowers".into(),
            InspectPluginExtra {
                scope: Some("user".into()),
                provides: Some(PluginProvidesDto {
                    skills: 14,
                    agents: 0,
                    hooks: true,
                    mcp_servers: 0,
                }),
            },
        );
        let plugins = parse_plugin_list_json(raw, &disabled, &extra).unwrap();
        assert_eq!(plugins[0].scope.as_deref(), Some("user"));
        assert_eq!(plugins[0].provides.as_ref().unwrap().skills, 14);
        assert!(plugins[0].provides.as_ref().unwrap().hooks);
        assert!(plugins[0].enabled);
    }

    #[test]
    fn normalize_install_source_trims_and_rejects_empty() {
        assert_eq!(
            normalize_plugin_install_source("  owner/repo  ").unwrap(),
            "owner/repo"
        );
        assert_eq!(
            normalize_plugin_install_source("https://github.com/a/b.git").unwrap(),
            "https://github.com/a/b.git"
        );
        assert_eq!(
            normalize_plugin_install_source("/tmp/my-plugin").unwrap(),
            "/tmp/my-plugin"
        );
        assert!(normalize_plugin_install_source("").is_err());
        assert!(normalize_plugin_install_source("   ").is_err());
    }

    #[test]
    fn plugin_name_from_install_source_variants() {
        assert_eq!(
            plugin_name_from_install_source("vercel@xAI Official").as_deref(),
            Some("vercel")
        );
        assert_eq!(
            plugin_name_from_install_source("vercel").as_deref(),
            Some("vercel")
        );
        assert_eq!(
            plugin_name_from_install_source("owner/repo").as_deref(),
            Some("repo")
        );
        assert_eq!(
            plugin_name_from_install_source("owner/repo@v1").as_deref(),
            Some("repo")
        );
        assert_eq!(
            plugin_name_from_install_source("https://github.com/a/b.git").as_deref(),
            Some("b")
        );
        assert_eq!(
            plugin_name_from_install_source("git@github.com:a/b.git").as_deref(),
            Some("b")
        );
        assert_eq!(
            plugin_name_from_install_source("/tmp/my-plugin").as_deref(),
            Some("my-plugin")
        );
    }

    #[test]
    fn normalize_update_name_empty_means_all() {
        assert_eq!(
            normalize_plugin_update_name(Some("  chrome-devtools-mcp ")).as_deref(),
            Some("chrome-devtools-mcp")
        );
        assert_eq!(normalize_plugin_update_name(Some("")), None);
        assert_eq!(normalize_plugin_update_name(Some("   ")), None);
        assert_eq!(normalize_plugin_update_name(None), None);
    }

    #[test]
    fn parse_validate_messages_stderr_first_dedupe() {
        let msgs = parse_plugin_validate_messages(
            "Plugin manifest is valid.\n  name: demo\n",
            "  name: demo\n",
        );
        assert_eq!(
            msgs,
            vec![
                "name: demo".to_string(),
                "Plugin manifest is valid.".to_string()
            ]
        );
    }

    #[test]
    fn looks_like_unsupported_validate_clap() {
        assert!(looks_like_unsupported_plugin_validate(
            "error: unrecognized subcommand 'validate'\n\nUsage: grok plugin …",
            ""
        ));
        assert!(looks_like_unsupported_plugin_validate(
            "error: unexpected argument 'validate' found",
            ""
        ));
        assert!(!looks_like_unsupported_plugin_validate(
            "Error: Not a directory: /nope",
            ""
        ));
        assert!(!looks_like_unsupported_plugin_validate(
            "Error: Failed to load manifest: missing field `name`",
            ""
        ));
    }

    #[test]
    fn looks_like_validate_path_variants() {
        assert!(looks_like_plugin_validate_path("/tmp/my-plugin"));
        assert!(looks_like_plugin_validate_path("~/code/plugin"));
        assert!(looks_like_plugin_validate_path("./plugin"));
        assert!(looks_like_plugin_validate_path("C:\\Users\\a\\plugin"));
        assert!(looks_like_plugin_validate_path("owner/repo")); // has slash → path-ish for CLI
        assert!(!looks_like_plugin_validate_path("chrome-devtools-mcp"));
        assert!(!looks_like_plugin_validate_path("https://github.com/a/b.git"));
        assert!(!looks_like_plugin_validate_path("git@github.com:a/b.git"));
    }

    #[test]
    fn normalize_validate_target_empty() {
        assert_eq!(normalize_plugin_validate_target(None), None);
        assert_eq!(normalize_plugin_validate_target(Some("")), None);
        assert_eq!(normalize_plugin_validate_target(Some("  ")), None);
        assert_eq!(
            normalize_plugin_validate_target(Some("  /tmp/p  ")).as_deref(),
            Some("/tmp/p")
        );
    }
}

