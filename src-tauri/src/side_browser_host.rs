//! Embedded side-browser automation surface.
//!
//! All side browser tabs are **in-app** Tauri child Webviews (WKWebView /
//! WebView2 / webkit2gtk). Automation (navigate / eval / url) targets those
//! labeled webviews so Agent tooling can drive the same surface the user sees.
//!
//! True Chromium-in-process (CEF) is **not** available in Tauri/Wry today.
//! When CEF lands, it should register under the same label scheme and reuse
//! these commands so automation clients stay compatible.

use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Url};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideBrowserInfo {
    pub label: String,
    pub url: Option<String>,
}

fn validate_label(label: &str) -> Result<(), String> {
    let t = label.trim();
    if t.is_empty() || t.len() > 96 {
        return Err("invalid webview label".into());
    }
    if !t
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '/'))
    {
        return Err("invalid webview label chars".into());
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<Url, String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("url empty".into());
    }
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("about:")
        || lower.starts_with("file://")
        || lower.starts_with("data:"))
    {
        return Err("url scheme not allowed".into());
    }
    Url::parse(u).map_err(|e| format!("bad url: {e}"))
}

fn get_side_webview<R: tauri::Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<tauri::Webview<R>, String> {
    validate_label(label)?;
    app.get_webview(label)
        .ok_or_else(|| format!("side browser webview not found: {label}"))
}

/// List known side-browser webviews (label prefix `resource-browser`).
pub fn list(app: &AppHandle) -> Result<Vec<SideBrowserInfo>, String> {
    let mut out = Vec::new();
    for w in app.webviews().values() {
        let label = w.label().to_string();
        if !label.starts_with("resource-browser") {
            continue;
        }
        let url = w.url().ok().map(|u| u.to_string());
        out.push(SideBrowserInfo { label, url });
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(out)
}

pub fn navigate(app: &AppHandle, label: String, url: String) -> Result<(), String> {
    let parsed = validate_url(&url)?;
    let wv = get_side_webview(app, &label)?;
    wv.navigate(parsed).map_err(|e| format!("navigate: {e}"))
}

pub fn reload(app: &AppHandle, label: String) -> Result<(), String> {
    let wv = get_side_webview(app, &label)?;
    wv.reload().map_err(|e| format!("reload: {e}"))
}

pub fn current_url(app: &AppHandle, label: String) -> Result<String, String> {
    let wv = get_side_webview(app, &label)?;
    wv.url()
        .map(|u| u.to_string())
        .map_err(|e| format!("url: {e}"))
}

/// Evaluate JS in the embedded webview; return JSON-serialized result string.
///
/// Script should be an expression or IIFE that returns a value. Exceptions
/// should be caught in-script (Windows WebView2 limitation).
pub fn eval(app: &AppHandle, label: String, script: String) -> Result<String, String> {
    validate_label(&label)?;
    if script.trim().is_empty() {
        return Err("script empty".into());
    }
    if script.len() > 512_000 {
        return Err("script too large".into());
    }
    let wv = get_side_webview(app, &label)?;
    let (tx, rx) = mpsc::channel::<String>();
    wv.eval_with_callback(script, move |result| {
        let _ = tx.send(result);
    })
    .map_err(|e| format!("eval: {e}"))?;
    rx.recv_timeout(Duration::from_secs(15))
        .map_err(|_| "eval timeout".to_string())
}

/// Convenience: page snapshot for automation (title + href + body text sample).
pub fn snapshot(app: &AppHandle, label: String) -> Result<String, String> {
    let script = r#"(function(){
  try {
    return JSON.stringify({
      title: document.title || '',
      href: location.href || '',
      readyState: document.readyState || '',
      text: (document.body && document.body.innerText || '').slice(0, 8000)
    });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
})()"#;
    eval(app, label, script.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_rules() {
        assert!(validate_label("resource-browser-tab1").is_ok());
        assert!(validate_label("../x").is_err());
    }

    #[test]
    fn url_scheme_rules() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("javascript:alert(1)").is_err());
    }
}
