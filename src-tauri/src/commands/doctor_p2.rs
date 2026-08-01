/// Save arbitrary bytes via native save dialog (share-card PNG, etc.).
/// Returns `{ ok, path, cancelled }`. Cancel → `ok:false, cancelled:true` (not an error).
#[tauri::command]
pub async fn export_bytes_save(
    bytes_base64: String,
    default_name: String,
    dialog_title: Option<String>,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let raw = bytes_base64.trim();
    if raw.is_empty() {
        return Err("export payload is empty".into());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("invalid base64: {e}"))?;
    if bytes.is_empty() {
        return Err("export payload is empty".into());
    }
    // Soft cap ~40 MiB decoded — share cards stay well under this.
    if bytes.len() > 40 * 1024 * 1024 {
        return Err("export payload too large".into());
    }

    let name = default_name.trim();
    let name = if name.is_empty() {
        "export.bin".to_string()
    } else {
        // Keep basename only (no path separators).
        name.replace(['/', '\\'], "_")
    };
    let title = dialog_title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Save file")
        .to_string();
    let filter = filter_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("File")
        .to_string();
    let exts: Vec<String> = extensions
        .unwrap_or_else(|| vec!["bin".into()])
        .into_iter()
        .map(|s| s.trim().trim_start_matches('.').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let exts = if exts.is_empty() {
        vec!["bin".into()]
    } else {
        exts
    };

    tauri::async_runtime::spawn_blocking(move || {
        let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        let dest = rfd::FileDialog::new()
            .set_title(&title)
            .set_file_name(&name)
            .add_filter(&filter, &ext_refs)
            .save_file();

        let Some(path) = dest else {
            return Ok(serde_json::json!({
                "ok": false,
                "cancelled": true,
                "path": serde_json::Value::Null,
            }));
        };

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create parent dir: {e}"))?;
        }
        std::fs::write(&path, &bytes).map_err(|e| format!("write file: {e}"))?;

        let path_s = path.display().to_string();
        #[cfg(target_os = "macos")]
        {
            let _ = crate::process_util::command("open")
                .args(["-R", &path_s])
                .status();
        }
        #[cfg(target_os = "windows")]
        {
            let _ = crate::process_util::command("explorer")
                .args(["/select,", &path_s])
                .status();
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            if let Some(parent) = path.parent() {
                let _ = crate::process_util::command("xdg-open")
                    .arg(parent)
                    .spawn();
            }
        }

        Ok(serde_json::json!({
            "ok": true,
            "cancelled": false,
            "path": path_s,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save dialog + reveal. Always runs rfd/copy on a blocking thread so async
/// commands (export bundle/trace) do not hang on macOS when the dialog needs
/// main-thread affinity via spawn_blocking.
async fn save_and_reveal_file(
    tmp: std::path::PathBuf,
    dialog_title: &str,
    fallback_name: &str,
    filter_name: &str,
    extensions: &[&str],
) -> Result<serde_json::Value, String> {
    let dialog_title = dialog_title.to_string();
    let fallback_name = fallback_name.to_string();
    let filter_name = filter_name.to_string();
    let extensions: Vec<String> = extensions.iter().map(|s| (*s).to_string()).collect();

    tauri::async_runtime::spawn_blocking(move || {
        save_and_reveal_file_blocking(
            tmp,
            &dialog_title,
            &fallback_name,
            &filter_name,
            &extensions,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn save_and_reveal_file_blocking(
    tmp: std::path::PathBuf,
    dialog_title: &str,
    fallback_name: &str,
    filter_name: &str,
    extensions: &[String],
) -> Result<serde_json::Value, String> {
    let suggested = tmp
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(fallback_name)
        .to_string();
    let ext_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let dest = rfd::FileDialog::new()
        .set_title(dialog_title)
        .set_file_name(&suggested)
        .add_filter(filter_name, &ext_refs)
        .save_file();

    let final_path = if let Some(dest) = dest {
        std::fs::copy(&tmp, &dest).map_err(|e| format!("copy archive: {e}"))?;
        let _ = std::fs::remove_file(&tmp);
        dest
    } else {
        // User cancelled: keep temp zip and still return path so UI can open it.
        tmp
    };

    let path_s = final_path.display().to_string();
    // Cheap metadata only — never read archive contents into the App.
    let size_bytes = std::fs::metadata(&final_path).ok().map(|m| m.len());
    #[cfg(target_os = "macos")]
    {
        let _ = crate::process_util::command("open")
            .args(["-R", &path_s])
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = crate::process_util::command("explorer")
            .args(["/select,", &path_s])
            .status();
    }

    Ok(serde_json::json!({
        "ok": true,
        "path": path_s,
        "sizeBytes": size_bytes,
    }))
}

/// Wipe App data under the data root (sessions, projects, settings).
/// Does not touch the CLI home (`~/.grok`). Double-confirm in the UI before calling.
#[tauri::command]
pub async fn reset_app_data(
    app: tauri::AppHandle,
    keep_secrets: Option<bool>,
    mgr: State<'_, Arc<SessionManager>>,
) -> Result<serde_json::Value, String> {
    // Drop live agent first so session files are not mid-write.
    let _ = mgr.disconnect(app).await;
    let keep = keep_secrets.unwrap_or(true);
    crate::support_bundle::reset_app_data(keep)
}

// ── Skills / MCP via `grok inspect --json` ──────────────────────────────────

const INSPECT_TIMEOUT_SECS: u64 = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDto {
    pub name: String,
    pub description: String,
    /// Normalized source type string (e.g. "user", "project", "plugin").
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub user_invocable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDto {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility_status: Option<String>,
}

/// Run probed CLI: `grok inspect --json` with optional project cwd.
/// Returns (parsed JSON, error message). Never panics; empty on failure.
fn run_grok_inspect(project_path: Option<&str>) -> (Option<serde_json::Value>, Option<String>) {
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    let Some(cli_path) = probe.path.filter(|_| probe.found) else {
        return (None, Some("Grok Build CLI not found".into()));
    };

    let cwd = project_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.arg("inspect").arg("--json");
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        crate::process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = crate::process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        let result = cmd.output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(INSPECT_TIMEOUT_SECS)) {
        Ok(Ok(output)) => {
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let msg = if err.is_empty() {
                    format!("grok inspect exited with {}", output.status)
                } else {
                    // Truncate; never log secrets (inspect should not print keys)
                    err.chars().take(400).collect()
                };
                return (None, Some(msg));
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            match serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                Ok(v) => (Some(v), None),
                Err(e) => (None, Some(format!("Failed to parse grok inspect JSON: {e}"))),
            }
        }
        Ok(Err(e)) => (None, Some(format!("Failed to run grok inspect: {e}"))),
        Err(_) => (None, Some(format!(
            "grok inspect timed out after {INSPECT_TIMEOUT_SECS}s"
        ))),
    }
}

fn normalize_skill_source(source: &serde_json::Value) -> (String, Option<String>) {
    if let Some(s) = source.as_str() {
        return (s.to_string(), None);
    }
    if let Some(obj) = source.as_object() {
        let ty = obj
            .get("type")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string();
        let path = obj
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        return (ty, path);
    }
    ("unknown".into(), None)
}

fn parse_skills(v: &serde_json::Value) -> Vec<SkillDto> {
    let Some(arr) = v.get("skills").and_then(|x| x.as_array()) else {
        return Vec::new();
    };
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
        let description = item
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let (source, path_from_source) =
            normalize_skill_source(item.get("source").unwrap_or(&serde_json::Value::Null));
        let path = item
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .or(path_from_source);
        // Missing field ⇒ treat as invocable. Only explicit `false` hides a skill
        // from the composer/slash picker (agent-only / disable-model-invocation).
        let user_invocable = item
            .get("userInvocable")
            .or_else(|| item.get("user_invocable"))
            .or_else(|| item.get("user-invocable"))
            .and_then(|x| x.as_bool())
            .unwrap_or(true);
        out.push(SkillDto {
            name,
            description,
            source,
            path,
            user_invocable,
        });
    }
    out
}

fn parse_mcp_servers(v: &serde_json::Value) -> Vec<McpDto> {
    let Some(arr) = v
        .get("mcpServers")
        .or_else(|| v.get("mcp"))
        .and_then(|x| x.as_array())
    else {
        return Vec::new();
    };
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
        let transport = item
            .get("transport")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let target = item
            .get("target")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let vendor = item
            .get("vendor")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let compatibility_status = item
            .get("compatibilityStatus")
            .or_else(|| item.get("compatibility_status"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        out.push(McpDto {
            name,
            transport,
            target,
            vendor,
            compatibility_status,
        });
    }
    out
}
