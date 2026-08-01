// ── Official Grok Build account ─────────────────────────────────────────────

#[tauri::command]
pub async fn account_status(
    refresh_billing: Option<bool>,
    manual_cli_path: Option<String>,
) -> Result<crate::account::AccountStatus, String> {
    let settings = store::load_settings();
    let manual = manual_cli_path
        .or(settings.manual_cli_path)
        .filter(|s| !s.is_empty());
    Ok(crate::account::account_status(manual.as_deref(), refresh_billing.unwrap_or(true)).await)
}

#[tauri::command]
pub async fn account_login(
    method: Option<String>,
    manual_cli_path: Option<String>,
) -> Result<crate::account::LoginResult, String> {
    let settings = store::load_settings();
    let manual = manual_cli_path
        .or(settings.manual_cli_path)
        .filter(|s| !s.is_empty());
    let method = method.unwrap_or_else(|| "oauth".into());
    Ok(crate::account::account_login(&method, manual.as_deref()).await)
}

/// Abort a running `grok login` (OAuth / device-code). No-op if none is running.
#[tauri::command]
pub async fn account_login_cancel() -> Result<(), String> {
    crate::account::account_login_cancel().await;
    Ok(())
}

#[tauri::command]
pub async fn account_logout(
    manual_cli_path: Option<String>,
) -> Result<crate::account::AccountProfile, String> {
    let settings = store::load_settings();
    let manual = manual_cli_path
        .or(settings.manual_cli_path)
        .filter(|s| !s.is_empty());
    crate::account::account_logout(manual.as_deref()).await
}

#[tauri::command]
pub async fn account_open_usage() -> Result<(), String> {
    crate::account::open_usage_manage().await
}

#[tauri::command]
pub async fn account_open_subscribe() -> Result<(), String> {
    crate::account::open_subscribe().await
}

// ── Multi-account profiles ─────────────────────────────────────────────────

#[tauri::command]
pub fn accounts_list() -> crate::account_profiles::AccountsListResult {
    crate::account_profiles::list_accounts()
}

#[tauri::command]
pub fn account_save_current(label: Option<String>) -> Result<crate::account_profiles::SavedAccount, String> {
    crate::account_profiles::save_current_account(label)
}

#[tauri::command]
pub async fn account_switch(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<SessionManager>>,
    id: String,
) -> Result<crate::account::AccountProfile, String> {
    let profile = crate::account_profiles::switch_account(&id)?;
    // Soft-drop live agent so next send uses the new credentials.
    let _ = mgr.disconnect(app).await;
    Ok(profile)
}

#[tauri::command]
pub fn account_remove(id: String) -> Result<(), String> {
    crate::account_profiles::remove_account(&id)
}

#[tauri::command]
pub fn account_rename(
    id: String,
    label: String,
) -> Result<crate::account_profiles::SavedAccount, String> {
    crate::account_profiles::rename_account(&id, &label)
}

/// Import a markdown/JSON transcript into a new local session (Grok web history alternative).
#[tauri::command]
pub fn session_import_transcript(
    text: String,
    title: Option<String>,
    project_id: Option<String>,
) -> Result<store::SessionMeta, String> {
    crate::session_import::import_transcript_as_session(&text, title, project_id)
}

/// Native file picker → read text transcript → import as session.
#[tauri::command]
pub async fn session_import_transcript_file(
    title: Option<String>,
    project_id: Option<String>,
) -> Result<Option<store::SessionMeta>, String> {
    let path = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Import conversation / 导入对话")
            .add_filter("Transcript", &["md", "txt", "json", "markdown"])
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = path else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read file: {e}"))?;
    let derived_title = title.or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    });
    let meta =
        crate::session_import::import_transcript_as_session(&text, derived_title, project_id)?;
    Ok(Some(meta))
}

// ── Custom providers (agent-home config.toml) ───────────────────────────────
