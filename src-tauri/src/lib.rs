//! Grok App Host — real ACP default (`grok agent stdio`).

mod account;
mod acp_client;
mod supergrok_quota;
mod cli_probe;
mod commands;
mod editors;
mod error;
mod fs_browser;
mod media_protocol;
mod mock_acp;
mod paths;
mod permission;
mod providers;
mod session_title;
#[cfg(test)]
mod permission_host_test;
#[cfg(test)]
mod integration_test;
mod session_fsm;
mod session_manager;
mod store;

use std::sync::Arc;

use session_manager::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = paths::ensure_app_dirs();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let session_mgr = Arc::new(SessionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(session_mgr)
        // Range-capable media streaming (video/audio/pdf) — never loads multi‑GB into RAM.
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, request, responder| {
            std::thread::spawn(move || {
                let response = media_protocol::handle_request(request);
                responder.respond(response);
            });
        })
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                // Transparent layers so CSS backdrop-filter / native vibrancy show through.
                // Transparent window + webview so native vibrancy / CSS blur can show.
                let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                #[cfg(target_os = "macos")]
                {
                    // Frosted glass under transparent regions (sidebar). Solid main CSS covers the rest.
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    if let Err(e) = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::Sidebar,
                        None,
                        Some(16.0),
                    ) {
                        tracing::warn!("window vibrancy: {e}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session_get_state,
            commands::session_connect,
            commands::session_send,
            commands::session_stop,
            commands::session_disconnect,
            commands::session_reattach,
            commands::session_resolve_permission,
            commands::probe_cli,
            commands::projects_list,
            commands::project_add,
            commands::project_add_dialog,
            commands::project_remove,
            commands::project_trust,
            commands::project_rename,
            commands::project_set_pinned,
            commands::project_reveal,
            commands::project_archive_sessions,
            commands::sessions_list,
            commands::session_create,
            commands::session_delete,
            commands::session_rename,
            commands::session_set_archived,
            commands::session_messages,
            commands::settings_get,
            commands::settings_set,
            commands::session_set_policy,
            commands::secrets_get_masked,
            commands::secrets_set,
            commands::provider_ping,
            commands::import_grok_cli_config,
            commands::import_grok_go_config,
            commands::doctor_report,
            commands::pick_directory,
            commands::paths_classify,
            commands::path_open,
            commands::path_reveal,
            commands::fs_list_dir,
            commands::fs_read_file,
            commands::session_auto_title,
            commands::account_status,
            commands::account_login,
            commands::account_logout,
            commands::account_open_usage,
            commands::account_open_subscribe,
            commands::providers_list,
            commands::providers_upsert,
            commands::providers_remove,
            commands::providers_set_default,
            commands::providers_activate,
            commands::providers_ping,
            commands::providers_list_models,
            commands::editors_list,
            commands::open_in_editor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Grok App");
}
