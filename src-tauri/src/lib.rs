//! Grok App Host — real ACP default (`grok agent stdio`).

mod account;

mod account_profiles;

mod acp_client;

#[cfg(test)]
mod acp_golden_test;

mod agent_auto_wake;

mod agent_codebase_indexing;

mod agent_config_edit;

mod agent_config_view;

mod agent_home_config;

mod agent_memory;

mod agent_memory_embed;

mod agent_prefs;

mod agent_privacy;

mod agent_subagent_wt_snap;

mod agent_subagents;

mod agent_todo_gate;

mod agent_two_pass_compaction;

mod agent_workflows;

mod agents_catalog;

mod app_update;

mod audit_ledger;

mod automation_runner;

mod batch_agents;

mod cc_switch_import;

mod cli_install;

mod cli_probe;

mod cli_sessions;

mod cli_update;

mod cli_worktrees;

mod side_browser_host;

mod commands;

mod editors;

mod error;

mod extensions;
mod mcp_oauth;

mod fs_browser;

mod git_pr_hub;

mod hooks;

#[cfg(test)]
mod integration_test;

mod journal_throttle;

mod leader;

mod logging;

mod managed_setup;

mod media_protocol;

mod media_server;

mod mirror;

mod mock_acp;

mod models_aux;

mod models_catalog;

mod official_aux;

mod path_scope;

mod paths;

mod permission;

#[cfg(test)]
mod permission_host_test;

mod permission_rules;

mod process_limits;

mod process_util;

mod project_codebase_search;

mod project_rules;

mod providers;

mod proxy;

mod relay_stream_proxy;

mod pty_host;

mod remote_im;

mod schedules_launch_agent;

mod secrets;

mod serve;

mod session_content_search;

mod session_fsm;

mod session_import;

mod session_manager;

mod session_title;

mod skill_edit;

mod store;

mod store_lock;

mod stream_emit;

mod stream_stall;

mod streaming_acp_ndjson;

mod streaming_messages_json;

mod supergrok_quota;

mod support_bundle;

mod tool_heartbeat;

mod tray;

mod tray_i18n;

mod turn_complete;

mod updater;

mod video_poster;

mod voice_auth;

mod voice_host;

mod voice_stt;

mod voice_tools;

mod wallpaper_source;

#[cfg(windows)]
mod win_shell;

mod x_evidence;

use std::sync::Arc;

use mirror::MirrorHost;

use session_manager::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = paths::ensure_app_dirs();

    logging::init();

    // Windows: AppUserModelID before window/taskbar so Show Desktop / jump lists

    // treat us as a normal app (matches NSIS shortcut AUMID).

    #[cfg(windows)]
    win_shell::set_process_app_user_model_id();

    let session_mgr = Arc::new(SessionManager::new());

    let mirror_host = Arc::new(MirrorHost::from_env());

    let voice_host = Arc::new(voice_host::VoiceHost::new());

    let remote_im_state = Arc::new(remote_im::RemoteImState {
        inner: tokio::sync::Mutex::new(remote_im::BridgeRuntime::default()),
    });

    // Attach `tauri-plugin-updater` only when release CI injected GROK_UPDATER_*

    // (build.rs → cfg) and this is a non-debug binary. Crate is always linked for ACL.

    fn maybe_register_updater(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
        #[cfg(grok_updater_enabled)]
        {
            if !cfg!(debug_assertions) {
                return builder.plugin(tauri_plugin_updater::Builder::new().build());
            }
        }

        builder
    }

    let builder = tauri::Builder::default()
        // Must be registered first so a second process exits and focuses the primary window.
        // One-shot `--fire-due-schedules`: do not steal focus; ask primary to fire once.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let fire_due = argv.iter().any(|a| a == automation_runner::FIRE_DUE_FLAG);

            if fire_due {
                use tauri::Manager;

                if let Some(mgr) = app.try_state::<Arc<SessionManager>>() {
                    let h = app.clone();

                    let m = mgr.inner().clone();

                    tauri::async_runtime::spawn(async move {
                        let outcome = automation_runner::fire_due_once(&h, &m).await;

                        tracing::info!(

                            target: "automation_runner",

                            kind = %outcome.kind,

                            "secondary-instance oneshot relayed to primary"

                        );
                    });
                }

                return;
            }

            // Same restore path as tray Open — taskbar + shell styles included.

            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        // Always register process so release builds can relaunch after install.
        .plugin(tauri_plugin_process::init())
        // Login-item plugin only; never auto-enable. Enable/disable is driven by
        // AppSettings.launch_at_login in setup + settings_set. Safe for `cargo test`
        // (tests never call run(); init does not touch the OS login list).
        .plugin(tauri_plugin_autostart::Builder::new().build());

    // Register the updater only in configured release builds; omit it locally.

    // Requires GROK_UPDATER_* env at compile time (build.rs) + non-debug binary.

    let builder = maybe_register_updater(builder);

    builder

        .manage(session_mgr)

        .manage(mirror_host)

        .manage(voice_host)

        .manage(remote_im_state)

        // Range-capable media streaming (video/audio/pdf) — never loads multi‑GB into RAM.

        // Bounded pool + catch_unwind: unbounded spawn + protocol panics have aborted the

        // whole process (SIGABRT / "panic in a function that cannot unwind") when chat

        // fan-out many concurrent Range/image loads (e.g. large session mp4 + QC frames).

        .register_asynchronous_uri_scheme_protocol("media", |_ctx, request, responder| {

            media_protocol::dispatch(request, responder);

        })

        // Close button / Alt+F4: hide to tray (default) or ask frontend to quit.

        // When close-to-tray is off, prevent default so App can confirm if agents are busy

        // — unless keep_tray_for_schedules is on and any automation is enabled (still tray).

        // Tray "Quit Grok" emits the same event (see tray.rs). Force exit: `app_force_quit`.

        // Close button / Alt+F4 on **main**: hide to tray (default) or ask frontend to quit.

        // Secondary session windows (`session-*`) always close for real — they must not

        // hide the whole app to tray or trigger busy-quit confirm for a view-only pane.

        // Tray "Quit Grok" emits app://close-requested on main (see tray.rs).

        // Force exit: `app_force_quit`.

        .on_window_event(|window, event| {

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {

                use tauri::{Emitter, Manager};

                // Only the primary workbench owns tray-hide / quit-confirm.

                // Secondary session windows (`session-*`) close for real.

                if window.label() != "main" {

                    return;

                }

                let settings = store::load_settings();

                let any_enabled = store::load_automations().iter().any(|a| a.enabled);

                let hide = automation_runner::should_hide_to_tray_on_close(

                    settings.close_to_tray,

                    settings.keep_tray_for_schedules,

                    any_enabled,

                );

                if hide {

                    api.prevent_close();

                    tray::hide_to_tray(window.app_handle());

                } else {

                    api.prevent_close();

                    let _ = window.emit("app://close-requested", ());

                }

            }

        })

        .setup(|app| {

            crate::path_scope::refresh_from_store();

            use tauri::Manager;

            // Editors / terminals / git GUIs: non-blocking background scan + cache.

            // UI menus read cache immediately; never wait on icon extraction here.

            editors::start_background_scan_on_launch(app.handle().clone());



            // Loopback media HTTP (token-gated Range streaming). Primary path for

            // local <img>/<video>/fetch — frontend no longer depends on media://.

            match tauri::async_runtime::block_on(media_server::start()) {

                Ok(handle) => {

                    tracing::info!(

                        base_url = %handle.endpoint.base_url,

                        "media server ready"

                    );

                    app.manage(handle);

                }

                Err(e) => {

                    tracing::error!(error = %e, "media server failed to start — local media previews may break");

                }

            }



            // OpenCode Zen Go etc. append non-OpenAI SSE trailers (missing `id`)

            // that fatal Grok Build — sanitize via loopback reverse proxy and

            // rewrite affected provider base_url in agent-home config.toml.

            {

                if let Err(e) =

                    tauri::async_runtime::block_on(relay_stream_proxy::ensure_started())

                {

                    tracing::warn!(error = %e, "relay stream proxy failed to start");

                }

                if let Err(e) = relay_stream_proxy::repair_sanitize_proxy_bases() {

                    tracing::warn!(error = %e, "relay stream proxy base_url repair failed");

                }

            }

            if let Some(window) = app.get_webview_window("main") {

                #[cfg(target_os = "macos")]

                {

                    // Transparent layers so CSS backdrop-filter / native vibrancy show through.

                    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

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

                // Windows / others: solid base matching dark theme (avoids white flash / WebView2 glitches).

                #[cfg(not(target_os = "macos"))]

                {

                    let _ = window.set_background_color(Some(tauri::window::Color(13, 13, 13, 255)));

                }

                // Windows: frameless + tray skip_taskbar can leave the HWND out of

                // Explorer's Show Desktop set when it is the only visible window.

                #[cfg(windows)]

                win_shell::ensure_main_window_shell_integration(&window);

            }

            // Menu-bar / system tray — logo.svg tray icon (not dock app icon)

            if let Err(e) = tray::setup_tray(app.handle()) {

                tracing::warn!("tray setup: {e}");

            }

            // I03: recycle idle agent processes; session metadata stays on disk.

            // I06: surface cancel UI when a stream is pure-silent for too long.

            {

                use tauri::Manager;

                let mgr = app.state::<Arc<SessionManager>>().inner().clone();

                mgr.start_idle_watchdog(app.handle().clone());

                mgr.start_stream_stall_watchdog(app.handle().clone());

                // Scheduled automations: host tick works while window is in tray

                // (and with --start-in-tray / keep_tray_for_schedules). No daemon.

                // One-shot `--fire-due-schedules`: fire at most one due task then exit

                // (honest helper — not KeepAlive continuous daemon).

                if automation_runner::wants_fire_due_schedules() {

                    automation_runner::start_oneshot(app.handle().clone(), mgr);

                } else {

                    automation_runner::start(app.handle().clone(), mgr);

                }

            }

            // LaunchAgent / helper / oneshot: open into tray so schedules fire without focus steal.

            if schedules_launch_agent::wants_start_in_tray()

                || automation_runner::wants_fire_due_schedules()

            {

                tray::hide_to_tray(app.handle());

            }

            // Remote IM: restore Feishu/Weixin connectors after App restart so
            // already-bound channels keep receiving messages without a manual Start.
            // Defer a short beat so the main window can paint / frontend hydrate first
            // (Weixin long-poll + Feishu WS connect can log for a long time otherwise
            // and looks like a hang on the last "ilink long-poll starting" line).
            {
                use tauri::Manager;

                remote_im::set_app_handle(app.handle().clone());

                let rim = app.state::<Arc<remote_im::RemoteImState>>().inner().clone();

                let rim_watch = rim.clone();

                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                    tracing::info!("remote_im: deferred autostart begin");
                    remote_im::try_autostart(&rim).await;
                    tracing::info!("remote_im: deferred autostart finished");
                });

                // Crash / exit recovery while bridge stays enabled.
                remote_im::start_health_watchdog(rim_watch);
            }

            // Headless mirror auto-start (GROK_MIRROR_HEADLESS=1) — off by default.

            {

                use tauri::Manager;

                let host = app.state::<Arc<MirrorHost>>().inner().clone();

                let mgr = app.state::<Arc<SessionManager>>().inner().clone();

                mirror::maybe_autostart(host, app.handle().clone(), mgr);

            }

            // Re-apply OS login item from AppSettings (default off). Does not enable

            // unless the user opted in; repairs drift if the OS entry was removed.

            {

                use tauri_plugin_autostart::ManagerExt;

                let want = store::load_settings().launch_at_login;

                let autolaunch = app.autolaunch();

                match autolaunch.is_enabled() {

                    Ok(on) if on != want => {

                        let res = if want {

                            autolaunch.enable()

                        } else {

                            autolaunch.disable()

                        };

                        if let Err(e) = res {

                            tracing::warn!("launch-at-login sync: {e}");

                        }

                    }

                    Ok(_) => {}

                    Err(e) => tracing::warn!("launch-at-login is_enabled: {e}"),

                }

            }

            Ok(())

        })

        .invoke_handler(tauri::generate_handler![

            commands::session_get_state,

            commands::session_connect,

            commands::session_send,

            commands::session_interject,

            commands::session_stop,

            commands::session_disconnect,

            commands::session_reattach,

            commands::session_resolve_permission,

            commands::session_resolve_plan,

            commands::session_resolve_ask_user,

            commands::probe_cli,

            commands::acp_test_connection,

            commands::acp_server_probe,

            commands::cli_install_latest,

            commands::cli_install_commands,

            commands::cli_update_check,

            commands::cli_update_install,

            commands::pick_cli_binary,

            commands::pick_agent_profile,

            commands::open_external_url,

            commands::app_check_update,

            updater::is_auto_update_supported,

            updater::is_updater_plugin_enabled,

            updater::updater_status,

            updater::prepare_for_app_update,

            commands::voice_status,

            commands::voice_transcribe,

            commands::projects_list,

            commands::general_workspace_path,

            commands::project_add,

            commands::project_add_dialog,

            commands::project_remove,

            commands::project_relocate,

            commands::project_trust,

            commands::project_set_permission_policy,

            commands::project_set_sandbox_profile,

            commands::project_rename,

            commands::project_set_pinned,

            commands::project_set_color,

            commands::project_reveal,

            commands::project_rules_list,

            commands::project_rules_ensure_template,

            commands::project_archive_sessions,

            commands::sessions_list,

            commands::sessions_search,

            commands::cli_sessions_list,

            commands::cli_sessions_search,

            commands::cli_session_import,

            commands::cli_sessions_import_all,

            commands::cli_sessions_delete,

            commands::cli_session_find_latest_for_cwd,

            commands::cli_session_continue_cwd,

            commands::session_create,

            commands::open_session_window,

            commands::focus_main_window,

            commands::session_delete,

            commands::session_rename,

            commands::session_set_archived,

            commands::session_set_pinned,

            commands::session_set_worktree,

            commands::session_set_json_schema,

            commands::session_set_project,

            commands::session_set_plugin_dirs,

            commands::session_set_extra_rules,

            commands::session_set_max_agent_turns,

            commands::session_set_system_prompt_override,

            commands::session_set_no_ask_user,

            commands::session_set_fork_agent_session,

            commands::session_set_scheduled,

            commands::session_messages,

            commands::session_media_root,

            commands::session_resolve_relative_media,

            commands::media_server_endpoint,

            commands::settings_get,

            commands::store_take_quarantine,

            commands::settings_set,

            commands::memory_clear,

            commands::memory_list,

            commands::memory_delete_file,

            commands::agent_config_toml_read,

            commands::memory_search,

            commands::memory_embed_config_get,

            commands::memory_embed_config_set,

            commands::settings_remember_last_session,

            commands::models_list_available,

            commands::agents_catalog,

            commands::composer_prefs_resolve,

            commands::composer_prefs_set,

            commands::session_set_policy,

            commands::permission_rules_get,

            commands::permission_rules_set,

            commands::agent_config_edit_get,

            commands::agent_config_edit_set,

            commands::privacy_config_get,

            commands::privacy_config_set,

            commands::codebase_indexing_get,

            commands::codebase_indexing_set,

            commands::session_set_model,

            commands::session_rewind_drop_last_user,

            commands::session_rewind_points,

            commands::session_rewind_execute,

            commands::session_fork,

            commands::secrets_get_masked,

            commands::secrets_set,

            commands::provider_ping,

            commands::import_grok_cli_config,

            commands::import_grok_go_config,

            commands::doctor_report,

            commands::network_probe,

            commands::probe_streaming_acp_ndjson,

            commands::agents_recycle_all,

            commands::cli_doctor_fix,

            commands::export_support_bundle,

            commands::process_budget_snapshot,

            commands::audit_ledger_list,

            commands::audit_ledger_clear,

            commands::audit_ledger_prune,

            commands::audit_ledger_export,

            commands::export_session_bundle,

            commands::session_cli_export,

            commands::export_bytes_save,

            commands::session_trace_export,

            commands::reset_app_data,

            commands::skills_list,

            commands::skill_read,

            commands::skill_write,

            commands::skill_roots,

            commands::skill_create,

            commands::agents_list,

            commands::workflows_list,

            commands::workflows_run,

            commands::workflows_create,

            commands::agents_scaffold,

            commands::inspect_mcp,

            commands::project_inspect,

            commands::extensions_get,

            commands::extensions_set_mcp,

            commands::extensions_set_skill,

            commands::extensions_enable_all_mcp,

            commands::extensions_enable_all_skills,

            commands::mcp_add,
            commands::mcp_oauth_start,
            commands::mcp_oauth_status,

            commands::mcp_remove,

            commands::mcp_doctor,

            commands::plugins_list,

            commands::plugin_enable,

            commands::plugin_disable,

            commands::plugin_uninstall,

            commands::plugin_details,

            commands::plugin_install,

            commands::plugin_update,

            commands::plugin_validate,

            commands::hooks_list,

            commands::hooks_reveal,

            commands::hooks_open_dir,

            commands::hooks_ensure_dir,

            commands::hooks_try_run,

            commands::setup_preview,

            commands::setup_install,

            commands::managed_setup_status,

            commands::marketplace_list,

            commands::marketplace_available,

            commands::marketplace_plugin_meta_index,

            commands::marketplace_add,

            commands::marketplace_remove,

            commands::marketplace_update,

            leader::leader_status,

            leader::leader_list,

            leader::leader_info,

            leader::leader_start,

            leader::leader_stop,

            leader::leader_kill_all,

            serve::serve_status,

            serve::serve_start,

            serve::serve_stop,

            serve::serve_tcp_probe,

            commands::pick_directory,

            commands::pick_attach_files,

            commands::pick_attach_folder,

            commands::save_temp_attachment,

            commands::clipboard_paste_image,

            commands::clipboard_write_image,

            commands::paths_classify,

            commands::path_open,

            commands::path_reveal,

            commands::media_video_poster,

            commands::media_video_poster_save,

            commands::git_file_diff,

            commands::git_status,

            commands::git_review_bundle,

            commands::git_worktrees_list,

            commands::git_worktree_add,

            commands::git_worktree_remove,

            commands::git_worktree_gc,

            commands::git_worktree_compare,

            commands::git_push_branch,

            commands::gh_pr_create,

            git_pr_hub::git_pr_list,

            git_pr_hub::git_pr_view,

            git_pr_hub::git_pr_checks,

            git_pr_hub::git_pr_comments,

            cli_worktrees::cli_worktrees_list,

            cli_worktrees::cli_worktree_db_path,

            cli_worktrees::cli_worktree_db_stats,

            cli_worktrees::cli_worktree_db_rebuild,

            commands::git_show_file,

            commands::apply_file_patch,

            commands::git_checkout_file,

            commands::delete_project_file,

            commands::fs_list_dir,

            commands::project_codebase_search,

            commands::fs_read_file,

            commands::fs_write_file,

            commands::fs_write_absolute,

            tray::tray_refresh,

            tray::tray_set_busy_count,

            commands::app_force_quit,

            commands::fs_read_absolute,

            commands::fs_open_path,

            commands::session_auto_title,

            commands::automations_list,

            commands::automation_create,

            commands::automation_update,

            commands::automation_set_enabled,

            commands::automation_mark_run,

            commands::automation_delete,

            commands::automation_runner_status,

            commands::schedules_launch_agent_status,

            commands::schedules_launch_agent_set_enabled,

            commands::schedules_launch_agent_reveal_helper,

            commands::account_status,

            commands::account_login,

            commands::account_login_cancel,

            commands::account_logout,

            commands::account_open_usage,

            commands::account_open_subscribe,

            commands::accounts_list,

            commands::account_save_current,

            commands::account_switch,

            commands::account_remove,

            commands::account_rename,

            commands::session_import_transcript,

            commands::session_import_transcript_file,

            commands::providers_list,

            commands::providers_upsert,

            commands::providers_remove,

            commands::providers_set_default,

            commands::providers_activate,

            commands::providers_ping,

            commands::providers_list_models,

            commands::providers_cc_switch_scan,

            commands::providers_cc_switch_import,

            commands::models_aux_get,

            commands::models_aux_set,

            commands::models_aux_apply_save_grok,

            commands::models_aux_reset_defaults,

            commands::models_aux_headless,

            commands::models_aux_web_search,

            commands::official_aux_status,

            commands::official_aux_ensure_home,

            commands::official_aux_dispatch,

            commands::official_aux_web_search,

            commands::official_aux_x_keyword_search,

            commands::official_aux_x_semantic_search,

            commands::official_aux_x_user_search,

            commands::official_aux_x_thread_fetch,

            commands::official_aux_vision_describe,

            commands::editors_list,

            commands::open_in_editor,

            mirror::mirror_status,

            mirror::mirror_rotate_token,

            mirror::mirror_set_read_only,

            mirror::mirror_set_max_clients,

            mirror::mirror_start,

            mirror::mirror_stop,

            voice_host::voice_state,

            voice_host::voice_start,

            voice_host::voice_stop,

            voice_host::voice_push_pcm,

            voice_host::voice_invoke_tool,

            voice_host::voice_dictation_transcribe,

            remote_im::remote_im_bridge_status,

            remote_im::remote_im_bridge_start,

            remote_im::remote_im_bridge_stop,

            remote_im::remote_im_bridge_set_config,

            remote_im::remote_im_bridge_reload,

            remote_im::remote_im_test_connection,

            remote_im::remote_im_scan_begin,

            remote_im::remote_im_scan_poll,

            remote_im::remote_im_list_instances,

            remote_im::remote_im_save_instance,

            remote_im::remote_im_delete_instance,

            remote_im::remote_im_doctor,

            commands::wallpaper_x_search,

            commands::wallpaper_fetch_media,

            commands::wallpaper_imagine,

            commands::wallpaper_library_list,

            commands::streaming_messages_json_probe,

            commands::batch_agents_headless,

            commands::x_evidence_search,

            commands::x_evidence_list,

            commands::x_evidence_get,

            commands::x_evidence_stats,

            commands::x_quote_pack,

            commands::path_exists_many,

            commands::terminal_pty_spawn,

            commands::terminal_pty_write,

            commands::terminal_pty_resize,

            commands::terminal_pty_kill,

            commands::side_browser_create,

            commands::side_browser_close,

            commands::side_browser_list,

            commands::side_browser_navigate,

            commands::side_browser_reload,

            commands::side_browser_url,

            commands::side_browser_eval,

            commands::side_browser_snapshot,

        ])

        .build(tauri::generate_context!())

        .expect("error while building Grok App")

        .run(|app, event| {

            // macOS: click Dock icon when all windows hidden → show main window again.

            #[cfg(target_os = "macos")]

            if let tauri::RunEvent::Reopen {

                has_visible_windows,

                ..

            } = event

            {

                if !has_visible_windows {

                    tray::show_main_window(app);

                }

            }

            // Full exit (tray Quit / Cmd+Q): tear down mirror host + cloudflared group.

            if let tauri::RunEvent::Exit = event {

                use tauri::Manager;

                if let Some(host) = app.try_state::<Arc<MirrorHost>>() {

                    host.inner().stop_sync();

                }

            }

            let _ = (app, &event);

        });
}
