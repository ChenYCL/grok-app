//! Detect local code editors and open project files in them.
//! Candidate list is app-owned; detection uses PATH + common install paths.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEditor {
    pub id: String,
    pub label: String,
    pub command: String,
    pub available: bool,
}

struct Candidate {
    id: &'static str,
    label: &'static str,
    bins: &'static [&'static str],
}

const CANDIDATES: &[Candidate] = &[
    Candidate {
        id: "code",
        label: "Visual Studio Code",
        bins: &["code", "code.cmd"],
    },
    Candidate {
        id: "cursor",
        label: "Cursor",
        bins: &["cursor", "cursor.cmd"],
    },
    Candidate {
        id: "codium",
        label: "VSCodium",
        bins: &["codium", "codium.cmd"],
    },
    Candidate {
        id: "windsurf",
        label: "Windsurf",
        bins: &["windsurf", "windsurf.cmd"],
    },
    Candidate {
        id: "zed",
        label: "Zed",
        bins: &["zed", "zeditor"],
    },
];

fn path_hints(id: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let apps = match id {
            "code" => vec![
                "/usr/local/bin/code",
                "/opt/homebrew/bin/code",
                "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            ],
            "cursor" => vec![
                "/usr/local/bin/cursor",
                "/opt/homebrew/bin/cursor",
                "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
            ],
            "codium" => vec![
                "/usr/local/bin/codium",
                "/opt/homebrew/bin/codium",
                "/Applications/VSCodium.app/Contents/Resources/app/bin/codium",
            ],
            "windsurf" => vec![
                "/usr/local/bin/windsurf",
                "/opt/homebrew/bin/windsurf",
                "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf",
            ],
            "zed" => vec![
                "/usr/local/bin/zed",
                "/opt/homebrew/bin/zed",
                "/Applications/Zed.app/Contents/MacOS/zed",
            ],
            _ => vec![],
        };
        for a in apps {
            out.push(PathBuf::from(a));
        }
    }
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let prog = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let prog_x86 =
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
        let rel = match id {
            "code" => vec![
                r"Programs\Microsoft VS Code\bin\code.cmd",
                r"Microsoft VS Code\bin\code.cmd",
            ],
            "cursor" => vec![
                r"Programs\cursor\resources\app\bin\cursor.cmd",
                r"Programs\Cursor\resources\app\bin\cursor.cmd",
            ],
            "codium" => vec![r"Programs\VSCodium\bin\codium.cmd"],
            "windsurf" => vec![
                r"Programs\Windsurf\bin\windsurf.cmd",
                r"Programs\windsurf\bin\windsurf.cmd",
            ],
            _ => vec![],
        };
        for root in [local.as_str(), prog.as_str(), prog_x86.as_str()] {
            if root.is_empty() {
                continue;
            }
            for r in &rel {
                out.push(PathBuf::from(root).join(r));
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let bins = match id {
            "code" => vec!["/usr/bin/code", "/usr/local/bin/code"],
            "cursor" => vec!["/usr/bin/cursor", "/usr/local/bin/cursor"],
            "codium" => vec!["/usr/bin/codium", "/usr/local/bin/codium"],
            "windsurf" => vec!["/usr/bin/windsurf", "/usr/local/bin/windsurf"],
            "zed" => vec!["/usr/bin/zed", "/usr/local/bin/zed"],
            _ => vec![],
        };
        for b in bins {
            out.push(PathBuf::from(b));
        }
    }
    out
}

fn resolve_on_path(bin: &str) -> Option<String> {
    which::which(bin)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

fn resolve_candidate(c: &Candidate) -> Option<DetectedEditor> {
    for bin in c.bins {
        if let Some(hit) = resolve_on_path(bin) {
            return Some(DetectedEditor {
                id: c.id.into(),
                label: c.label.into(),
                command: hit,
                available: true,
            });
        }
    }
    for p in path_hints(c.id) {
        if p.is_file() {
            return Some(DetectedEditor {
                id: c.id.into(),
                label: c.label.into(),
                command: p.to_string_lossy().to_string(),
                available: true,
            });
        }
    }
    None
}

/// Return only editors present on this machine.
pub fn detect_editors() -> Vec<DetectedEditor> {
    let mut out = Vec::new();
    for c in CANDIDATES {
        if let Some(hit) = resolve_candidate(c) {
            out.push(hit);
        }
    }
    out
}

pub fn resolve_editor_command(open_target: Option<&str>) -> Option<String> {
    let list = detect_editors();
    let t = open_target.unwrap_or("").trim().to_ascii_lowercase();
    if t.is_empty() || t == "finder" || t == "explorer" {
        return None;
    }
    if t == "editor" {
        return list
            .iter()
            .find(|e| e.id == "cursor")
            .or_else(|| list.iter().find(|e| e.id == "code"))
            .or_else(|| list.first())
            .map(|e| e.command.clone())
            .or_else(|| std::env::var("GROK_APP_EDITOR").ok());
    }
    if let Some(by_id) = list.iter().find(|e| e.id == t) {
        return Some(by_id.command.clone());
    }
    // Absolute path or bare command name
    if t.contains('/') || t.contains('\\') || t.ends_with(".cmd") || t.ends_with(".exe") {
        return Some(open_target.unwrap().trim().to_string());
    }
    Some(open_target.unwrap().trim().to_string())
}

/// Open file (optional line) in the resolved editor, or OS default if none.
pub fn open_in_editor(
    file_path: &str,
    line: Option<u32>,
    editor: Option<&str>,
) -> Result<(), String> {
    let path = PathBuf::from(file_path);
    if !path.exists() {
        return Err(format!("path not found: {file_path}"));
    }
    let abs = path
        .canonicalize()
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();

    let cmd = resolve_editor_command(editor);
    if let Some(cmd) = cmd {
        // VS Code family: -g path:line
        let mut args: Vec<String> = Vec::new();
        if let Some(ln) = line {
            args.push("-g".into());
            args.push(format!("{abs}:{ln}"));
        } else {
            args.push(abs.clone());
        }
        Command::new(&cmd)
            .args(&args)
            .spawn()
            .map_err(|e| format!("failed to open editor `{cmd}`: {e}"))?;
        return Ok(());
    }

    // Fallback: OS default open
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&abs)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &abs])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&abs)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether a path looks like a known editor binary (for tests / doctor).
#[allow(dead_code)]
pub fn is_executable_file(p: &Path) -> bool {
    fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}
