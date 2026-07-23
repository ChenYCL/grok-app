//! System tray / menu-bar icon + ChatGPT / Codex-style menu.
//!
//! **Tray / menu-bar icon** → `icons/tray-icon.png` (from `docs/svg/logo.svg`).  
//! **App dock / .exe icons** → generated from `icons/icon (1).png` (do not mix).

use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

use crate::store;

const TRAY_ID: &str = "grok-main-tray";

/// Build ChatGPT-style tray menu: Recent · More · Usage · New Chat · Open · Quit.
pub fn build_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    let sessions = store::load_sessions_index();
    let projects = store::load_projects();
    let project_name = |id: &Option<String>| -> String {
        id.as_ref()
            .and_then(|pid| projects.iter().find(|p| &p.id == pid))
            .map(|p| p.name.clone())
            .unwrap_or_else(|| String::new())
    };

    let mut builder = MenuBuilder::new(app);

    // Recent header (disabled label)
    builder = builder.item(&MenuItem::with_id(
        app,
        "recent_header",
        "Recent",
        false,
        None::<&str>,
    )?);

    let mut count = 0usize;
    for s in sessions.iter().filter(|s| !s.archived) {
        if count >= 8 {
            break;
        }
        let title = if s.title.trim().is_empty() {
            "Untitled".to_string()
        } else {
            s.title.clone()
        };
        let proj = project_name(&s.project_id);
        let label = if proj.is_empty() {
            title
        } else {
            // ChatGPT shows title + project subtitle; native menu uses " · "
            format!("{title}  ·  {proj}")
        };
        let id = format!("session:{}", s.id);
        builder = builder.item(&MenuItem::with_id(app, &id, &label, true, None::<&str>)?);
        count += 1;
    }
    if count == 0 {
        builder = builder.item(&MenuItem::with_id(
            app,
            "recent_empty",
            "No recent chats",
            false,
            None::<&str>,
        )?);
    }

    builder = builder.separator();

    // More ▸ Settings / Doctor / Account
    let more = SubmenuBuilder::new(app, "More")
        .id("more")
        .item(&MenuItem::with_id(
            app,
            "more_settings",
            "Settings…",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "more_doctor",
            "Doctor",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "more_account",
            "Account",
            true,
            None::<&str>,
        )?)
        .build()?;
    builder = builder.item(&more);

    // Usage status line (disabled, like ChatGPT "1 week 96%")
    let usage_label = usage_status_label();
    builder = builder.item(&MenuItem::with_id(
        app,
        "usage",
        &usage_label,
        false,
        None::<&str>,
    )?);

    builder = builder.separator();
    builder = builder.item(&MenuItem::with_id(
        app,
        "new_chat",
        "New Chat",
        true,
        None::<&str>,
    )?);
    builder = builder.item(&MenuItem::with_id(
        app,
        "open_app",
        "Open Grok",
        true,
        None::<&str>,
    )?);
    builder = builder.separator();
    builder = builder.item(&MenuItem::with_id(
        app,
        "quit",
        "Quit Grok",
        true,
        None::<&str>,
    )?);

    builder.build()
}

fn usage_status_label() -> String {
    if let Ok(cache) =
        std::fs::read_to_string(crate::paths::app_data_root().join("account_billing_cache.json"))
    {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&cache) {
            let rem = v
                .pointer("/remainingPercent")
                .or_else(|| v.pointer("/remaining_percent"))
                .and_then(|x| x.as_f64())
                .or_else(|| {
                    v.pointer("/usedPercent")
                        .or_else(|| v.pointer("/used_percent"))
                        .and_then(|x| x.as_f64())
                        .map(|u| (100.0_f64 - u).clamp(0.0, 100.0))
                });
            if let Some(r) = rem {
                let now = chrono::Local::now();
                // Avoid platform-specific %-d (Unix-only); pad day is fine on all OSes.
                return format!("Usage  ·  {:.0}% left  ·  {}", r, now.format("%b %d"));
            }
        }
    }
    "Usage  ·  —".into()
}

/// Hide main window to tray only: no Dock (macOS) / no taskbar button (Windows).
pub fn hide_to_tray(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
        // Windows / Linux: drop taskbar button while living in the tray.
        #[cfg(not(target_os = "macos"))]
        {
            let _ = w.set_skip_taskbar(true);
        }
    }
    // macOS: hide Dock icon (menu-bar app while window is closed).
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_dock_visibility(false);
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

/// Show and focus the main workbench window (tray Open / dock reopen / after hide-to-tray).
pub fn show_main_window(app: &AppHandle) {
    // Restore Dock / taskbar presence before showing.
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let _ = app.set_dock_visibility(true);
    }
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = w.set_skip_taskbar(false);
        }
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "quit" => app.exit(0),
        "open_app" => show_main_window(app),
        "new_chat" => {
            show_main_window(app);
            let _ = app.emit("tray://new-chat", ());
        }
        "more_settings" => {
            show_main_window(app);
            let _ = app.emit(
                "tray://open-settings",
                serde_json::json!({ "section": "general" }),
            );
        }
        "more_doctor" => {
            show_main_window(app);
            let _ = app.emit("tray://open-doctor", ());
        }
        "more_account" => {
            show_main_window(app);
            let _ = app.emit(
                "tray://open-settings",
                serde_json::json!({ "section": "account" }),
            );
        }
        other if other.starts_with("session:") => {
            let sid = other.trim_start_matches("session:");
            show_main_window(app);
            let _ = app.emit(
                "tray://open-session",
                serde_json::json!({ "sessionId": sid }),
            );
        }
        _ => {}
    }
}

fn load_tray_icon() -> Result<Image<'static>, String> {
    // Embedded at compile time — logo.svg pipeline only (never app icon.png).
    // tray-icon on macOS displays at 18pt height; embed 36px (@2x) so retina is sharp.
    // Windows notification area: 32px monochrome.
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = include_bytes!("../icons/tray-icon.png"); // 36×36
    #[cfg(not(target_os = "macos"))]
    let bytes: &[u8] = include_bytes!("../icons/tray-32.png");
    Image::from_bytes(bytes).map_err(|e| format!("tray icon decode: {e}"))
}

/// Create menu-bar / system tray at startup.
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let menu = build_menu(app).map_err(|e| e.to_string())?;
    let icon = load_tray_icon()?;

    // macOS menu-bar: left-click opens menu (status-item habit).
    // Windows tray: left-click shows window; right-click opens menu.
    #[cfg(target_os = "macos")]
    let show_menu_on_left = true;
    #[cfg(not(target_os = "macos"))]
    let show_menu_on_left = false;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("Grok")
        .show_menu_on_left_click(show_menu_on_left)
        .on_menu_event(|app, event| handle_menu_event(app, event))
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    show_main_window(tray.app_handle());
                }
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    // Windows / Linux: left-click shows the workbench.
                    #[cfg(not(target_os = "macos"))]
                    {
                        show_main_window(tray.app_handle());
                    }
                    let _ = MouseButtonState::Up;
                }
                _ => {}
            }
        });

    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }

    let tray = builder.build(app).map_err(|e| e.to_string())?;
    app.manage(Mutex::new(tray));
    Ok(())
}

/// Rebuild recent list / usage after sessions or account change.
pub fn refresh_menu(app: &AppHandle) -> Result<(), String> {
    let menu = build_menu(app).map_err(|e| e.to_string())?;
    if let Some(tray) = app.try_state::<Mutex<tauri::tray::TrayIcon>>() {
        if let Ok(t) = tray.lock() {
            t.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn tray_refresh(app: AppHandle) -> Result<(), String> {
    refresh_menu(&app)
}
