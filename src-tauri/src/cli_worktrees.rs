//! List Grok Build CLI-tracked worktrees (`grok worktree list`).
//!
//! Prefers `grok worktree list --json`; falls back to careful text parsing when
//! `--json` is rejected by older CLIs. Soft-fails when the CLI is missing.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cli_probe;
use crate::process_util;
use crate::store;

const CLI_WORKTREE_LIST_TIMEOUT_SECS: u64 = 15;
/// Cap rows returned to the UI (CLI index can grow large with subagents).
const CLI_WORKTREE_LIST_CAP: usize = 200;

/// One tracked worktree from `grok worktree list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliWorktreeEntry {
    /// CLI index id (stable when present).
    pub id: String,
    /// Display name (folder basename, else short id).
    pub name: String,
    /// Absolute worktree path when known.
    pub path: String,
    /// Branch / git ref when known (`git_ref` in JSON, BRANCH column in text).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Lifecycle status (`alive`, `stale`, …) when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Kind: `user` / `subagent` / etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Short repo name from CLI index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,
    /// Absolute source checkout path when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_repo: Option<String>,
    /// True when `path` exists as a directory (safe to open as cwd).
    #[serde(default)]
    pub path_ok: bool,
    /// Short HEAD commit when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
}

/// Result envelope for the worktree list panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliWorktreesResult {
    /// True when the list command succeeded (even if empty).
    pub available: bool,
    pub worktrees: Vec<CliWorktreeEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub cli_found: bool,
    /// How the list was parsed: `json` | `text` | `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/// Normalize path separators and strip trailing slashes (keep root `/`).
pub fn normalize_cli_wt_path(path: &str) -> String {
    let mut p = path.trim().replace('\\', "/");
    while p.len() > 1 && p.ends_with('/') {
        p.pop();
    }
    p
}

/// Expand a leading `~/` to the user home directory.
pub fn expand_tilde_path(path: &str, home: &Path) -> String {
    let t = path.trim();
    if t == "~" {
        return normalize_cli_wt_path(&home.to_string_lossy());
    }
    if let Some(rest) = t.strip_prefix("~/") {
        let joined = home.join(rest);
        return normalize_cli_wt_path(&joined.to_string_lossy());
    }
    if let Some(rest) = t.strip_prefix("~\\") {
        let joined = home.join(rest);
        return normalize_cli_wt_path(&joined.to_string_lossy());
    }
    normalize_cli_wt_path(t)
}

/// Display name: last path segment when present, else id (trimmed).
pub fn derive_cli_worktree_name(id: &str, path: &str) -> String {
    let p = normalize_cli_wt_path(path);
    if !p.is_empty() {
        if let Some(base) = Path::new(&p).file_name().and_then(|s| s.to_str()) {
            let b = base.trim();
            if !b.is_empty() && b != "." && b != ".." {
                return b.to_string();
            }
        }
    }
    let id = id.trim();
    if id.is_empty() {
        return "worktree".into();
    }
    // Keep subagent ids readable but capped for UI.
    if id.len() > 48 {
        format!("{}…", id.chars().take(40).collect::<String>())
    } else {
        id.to_string()
    }
}

fn json_str_field(item: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = item.get(*k).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn path_is_dir(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    PathBuf::from(path).is_dir()
}

/// Pure parse helper for `grok worktree list --json`.
///
/// Accepts a top-level array, or `{ worktrees: [...] }` / `{ items: [...] }`.
pub fn parse_cli_worktree_list_json(stdout: &str, home: &Path) -> Result<Vec<CliWorktreeEntry>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    // Tolerate leading log noise: take first `[` or `{`.
    let json_start = trimmed
        .find(|c| c == '[' || c == '{')
        .ok_or_else(|| "cli worktree list: no JSON object/array".to_string())?;
    let slice = &trimmed[json_start..];
    let value: serde_json::Value = serde_json::from_str(slice)
        .map_err(|e| format!("invalid cli worktree list JSON: {e}"))?;

    let items: Vec<serde_json::Value> = if let Some(arr) = value.as_array() {
        arr.clone()
    } else if let Some(arr) = value
        .get("worktrees")
        .or_else(|| value.get("items"))
        .or_else(|| value.get("entries"))
        .and_then(|v| v.as_array())
    {
        arr.clone()
    } else if value.is_object() {
        // Single object row.
        vec![value]
    } else {
        return Ok(Vec::new());
    };

    let mut out = Vec::with_capacity(items.len().min(CLI_WORKTREE_LIST_CAP));
    for item in items {
        if !item.is_object() {
            continue;
        }
        let id = json_str_field(&item, &["id", "worktree_id", "worktreeId"]).unwrap_or_default();
        let raw_path = json_str_field(&item, &["path", "worktree_path", "worktreePath", "dir"])
            .unwrap_or_default();
        let path = expand_tilde_path(&raw_path, home);
        if id.is_empty() && path.is_empty() {
            continue;
        }
        let branch = json_str_field(
            &item,
            &["git_ref", "gitRef", "branch", "ref", "worktree_ref", "worktreeRef"],
        );
        let status = json_str_field(&item, &["status", "state"]);
        let kind = json_str_field(&item, &["kind", "type", "worktree_type", "worktreeType"]);
        let repo_name = json_str_field(&item, &["repo_name", "repoName", "repo"]);
        let source_repo = json_str_field(&item, &["source_repo", "sourceRepo", "source"])
            .map(|s| expand_tilde_path(&s, home));
        let head = json_str_field(&item, &["head_commit", "headCommit", "head", "commit"])
            .map(|h| {
                if h.len() > 12 {
                    h.chars().take(12).collect()
                } else {
                    h
                }
            });
        let effective_id = if id.is_empty() {
            path.clone()
        } else {
            id.clone()
        };
        let name = derive_cli_worktree_name(&effective_id, &path);
        out.push(CliWorktreeEntry {
            id: effective_id,
            name,
            path: path.clone(),
            branch,
            status,
            kind,
            repo_name,
            source_repo,
            path_ok: path_is_dir(&path),
            head,
        });
        if out.len() >= CLI_WORKTREE_LIST_CAP {
            break;
        }
    }
    Ok(out)
}

/// Detect summary / header lines in text `grok worktree list` output.
fn is_cli_worktree_text_noise(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("id ") || lower == "id" {
        return true;
    }
    if lower.contains(" type ") && lower.contains(" path") {
        return true;
    }
    // "20 worktrees (20 subagent)" summary
    if lower.contains("worktree")
        && (lower.contains(" subagent")
            || lower.ends_with("worktrees")
            || lower.contains(" worktrees "))
        && t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
    {
        return true;
    }
    false
}

/// Pure parse helper for human table from `grok worktree list` (no --json).
///
/// Columns observed (Grok Build 0.2.x):
/// `ID TYPE REPO LABEL BRANCH AGE PATH`
/// Path is last; id is first; type is second. Branch is often `HEAD` or a name
/// just before the age token (`4d`, `4d ago`, `12h`).
pub fn parse_cli_worktree_list_text(stdout: &str, home: &Path) -> Vec<CliWorktreeEntry> {
    let text = stdout.replace("\r\n", "\n");
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if is_cli_worktree_text_noise(t) {
            continue;
        }
        // Prefer absolute / home path at end of line.
        let path_raw = extract_trailing_path(t);
        let Some(path_raw) = path_raw else {
            continue;
        };
        let path = expand_tilde_path(path_raw, home);
        if path.is_empty() {
            continue;
        }
        let left = t[..t.len().saturating_sub(path_raw.len())].trim_end();
        let mut tokens: Vec<&str> = left.split_whitespace().collect();
        if tokens.is_empty() {
            continue;
        }
        // Drop trailing age tokens: "4d", "ago", "12h", "2mo", "3w"
        while let Some(last) = tokens.last().copied() {
            if is_age_token(last) {
                tokens.pop();
            } else {
                break;
            }
        }
        let id = tokens.first().copied().unwrap_or("").to_string();
        let kind = tokens.get(1).map(|s| (*s).to_string());
        // BRANCH is typically the last remaining token after REPO/LABEL (may be empty).
        let branch = tokens
            .iter()
            .rev()
            .find(|s| {
                let s = **s;
                !s.is_empty()
                    && s != "…"
                    && s != "..."
                    && !s.ends_with('…')
                    && s != id.as_str()
                    && kind.as_deref() != Some(s)
            })
            .map(|s| (*s).to_string());
        // Prefer a token that looks like a ref (HEAD, main, feat/x) over truncated repo.
        let branch = branch.filter(|b| {
            b == "HEAD"
                || b.contains('/')
                || b.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        });
        let effective_id = if id.is_empty() { path.clone() } else { id };
        let name = derive_cli_worktree_name(&effective_id, &path);
        out.push(CliWorktreeEntry {
            id: effective_id,
            name,
            path: path.clone(),
            branch,
            status: None,
            kind,
            repo_name: None,
            source_repo: None,
            path_ok: path_is_dir(&path),
            head: None,
        });
        if out.len() >= CLI_WORKTREE_LIST_CAP {
            break;
        }
    }
    out
}

fn is_age_token(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    if lower == "ago" {
        return true;
    }
    // 4d, 12h, 30m, 2w, 3mo, 1y
    let bytes = lower.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return false;
    }
    matches!(&lower[i..], "d" | "h" | "m" | "s" | "w" | "mo" | "y" | "min" | "mins" | "hr" | "hrs")
}

/// Extract a trailing filesystem path token from a table row.
fn extract_trailing_path(line: &str) -> Option<&str> {
    let t = line.trim_end();
    // Find last occurrence of path-like start.
    // Scan from the right for a token starting with ~/, /, or X:/
    let mut best: Option<&str> = None;
    for (idx, ch) in t.char_indices().rev() {
        if ch == ' ' || ch == '\t' {
            let candidate = t[idx + 1..].trim();
            if looks_like_path(candidate) {
                best = Some(candidate);
                break;
            }
        }
    }
    if best.is_none() && looks_like_path(t) {
        best = Some(t);
    }
    best.filter(|s| !s.is_empty())
}

fn looks_like_path(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    if s.starts_with("~/") || s.starts_with("~\\") || s == "~" {
        return true;
    }
    if s.starts_with('/') {
        return true;
    }
    // Windows drive
    let b = s.as_bytes();
    if b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/')
    {
        return true;
    }
    // Relative worktree paths are rare in CLI output; ignore.
    false
}

/// Whether stderr/stdout looks like clap rejecting an unknown flag (`--json`).
pub fn looks_like_unsupported_json_flag(stderr: &str, stdout: &str) -> bool {
    let blob = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    blob.contains("unexpected argument")
        || blob.contains("unknown flag")
        || blob.contains("unrecognized option")
        || (blob.contains("--json")
            && (blob.contains("not found")
                || blob.contains("unknown")
                || blob.contains("unexpected")))
}

// ── CLI runner ──────────────────────────────────────────────────────────────

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
        process_util::apply_no_window_std(&mut cmd);
        if let Some(path_env) = process_util::enriched_path_env() {
            cmd.env("PATH", path_env);
        }
        let result = cmd.output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_secs(timeout_secs)) {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Ok((stdout, stderr, output.status.success()))
        }
        Ok(Err(e)) => Err(format!("Failed to run grok: {e}")),
        Err(_) => Err(format!("grok command timed out after {timeout_secs}s")),
    }
}

fn user_home() -> PathBuf {
    process_util::user_home()
}

/// List CLI-tracked worktrees. Soft-fails when CLI is missing or list fails.
///
/// - `all`: pass `--all` when true (include stale / all ages per CLI).
/// - `repo`: optional `--repo <name>` filter (matches CLI `repo_name`).
#[tauri::command]
pub async fn cli_worktrees_list(
    all: Option<bool>,
    repo: Option<String>,
) -> Result<CliWorktreesResult, String> {
    let all = all.unwrap_or(false);
    let repo = repo
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // Never pass shell-like junk into argv.
    if let Some(ref r) = repo {
        if r.starts_with('-') || r.contains('\0') || r.len() > 256 {
            return Ok(CliWorktreesResult {
                available: false,
                worktrees: vec![],
                reason: Some("invalid repo filter".into()),
                cli_found: true,
                source: Some("none".into()),
            });
        }
    }

    let home = user_home();
    let result = tauri::async_runtime::spawn_blocking(move || list_cli_worktrees_blocking(all, repo, home))
        .await
        .map_err(|e| format!("cli worktree list worker panicked: {e}"))?;
    Ok(result)
}

fn list_cli_worktrees_blocking(
    all: bool,
    repo: Option<String>,
    home: PathBuf,
) -> CliWorktreesResult {
    let settings = store::load_settings();
    let probe = cli_probe::probe_cli(settings.manual_cli_path.as_deref());
    if !probe.found {
        return CliWorktreesResult {
            available: false,
            worktrees: vec![],
            reason: Some("Grok Build CLI not found".into()),
            cli_found: false,
            source: Some("none".into()),
        };
    }

    let mut json_args: Vec<String> = vec!["worktree".into(), "list".into(), "--json".into()];
    if all {
        json_args.push("--all".into());
    }
    if let Some(ref r) = repo {
        json_args.push("--repo".into());
        json_args.push(r.clone());
    }
    let json_refs: Vec<&str> = json_args.iter().map(|s| s.as_str()).collect();

    match run_grok_cli_args(&json_refs, CLI_WORKTREE_LIST_TIMEOUT_SECS) {
        Ok((stdout, stderr, ok)) => {
            if !stdout.trim().is_empty() {
                match parse_cli_worktree_list_json(&stdout, &home) {
                    Ok(list) => {
                        return CliWorktreesResult {
                            available: true,
                            worktrees: list,
                            reason: None,
                            cli_found: true,
                            source: Some("json".into()),
                        };
                    }
                    Err(e) => {
                        // If parse failed but looks like JSON noise, try text fallback below.
                        if ok && !looks_like_unsupported_json_flag(&stderr, &stdout) {
                            // Fall through to text only when stdout is not JSON-ish.
                            if stdout.trim_start().starts_with('[')
                                || stdout.trim_start().starts_with('{')
                            {
                                return CliWorktreesResult {
                                    available: false,
                                    worktrees: vec![],
                                    reason: Some(e.chars().take(240).collect()),
                                    cli_found: true,
                                    source: Some("none".into()),
                                };
                            }
                        }
                    }
                }
            }
            if looks_like_unsupported_json_flag(&stderr, &stdout) || stdout.trim().is_empty() {
                // Fall back to text table.
            } else if !ok {
                let detail = if stderr.trim().is_empty() {
                    "grok worktree list failed".to_string()
                } else {
                    stderr.chars().take(240).collect()
                };
                return CliWorktreesResult {
                    available: false,
                    worktrees: vec![],
                    reason: Some(detail),
                    cli_found: true,
                    source: Some("none".into()),
                };
            }
        }
        Err(e) => {
            return CliWorktreesResult {
                available: false,
                worktrees: vec![],
                reason: Some(e.chars().take(240).collect()),
                cli_found: e.to_ascii_lowercase().contains("not found") == false,
                source: Some("none".into()),
            };
        }
    }

    // Text fallback (older CLI without --json, or empty JSON path).
    let mut text_args: Vec<String> = vec!["worktree".into(), "list".into()];
    if all {
        text_args.push("--all".into());
    }
    if let Some(ref r) = repo {
        text_args.push("--repo".into());
        text_args.push(r.clone());
    }
    let text_refs: Vec<&str> = text_args.iter().map(|s| s.as_str()).collect();
    match run_grok_cli_args(&text_refs, CLI_WORKTREE_LIST_TIMEOUT_SECS) {
        Ok((stdout, stderr, ok)) => {
            if !ok && stdout.trim().is_empty() {
                let detail = if stderr.trim().is_empty() {
                    "grok worktree list failed".to_string()
                } else {
                    stderr.chars().take(240).collect()
                };
                return CliWorktreesResult {
                    available: false,
                    worktrees: vec![],
                    reason: Some(detail),
                    cli_found: true,
                    source: Some("none".into()),
                };
            }
            let list = parse_cli_worktree_list_text(&stdout, &home);
            CliWorktreesResult {
                available: true,
                worktrees: list,
                reason: None,
                cli_found: true,
                source: Some("text".into()),
            }
        }
        Err(e) => CliWorktreesResult {
            available: false,
            worktrees: vec![],
            reason: Some(e.chars().take(240).collect()),
            cli_found: !e.to_ascii_lowercase().contains("not found"),
            source: Some("none".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn home() -> PathBuf {
        PathBuf::from("/Users/me")
    }

    #[test]
    fn derive_name_from_path() {
        assert_eq!(
            derive_cli_worktree_name("id-long", "/Users/me/.grok/worktrees/repo/feat-login"),
            "feat-login"
        );
        assert_eq!(derive_cli_worktree_name("only-id", ""), "only-id");
    }

    #[test]
    fn expand_tilde() {
        assert_eq!(
            expand_tilde_path("~/.grok/worktrees/r/a", &home()),
            "/Users/me/.grok/worktrees/r/a"
        );
        assert_eq!(expand_tilde_path("/abs/x", &home()), "/abs/x");
    }

    #[test]
    fn parse_json_array() {
        let raw = r#"[
          {
            "id": "subagent-abc",
            "path": "/Users/me/.grok/worktrees/oss-grok-app/subagent-abc",
            "source_repo": "/Users/me/Code/oss/grok-app",
            "repo_name": "grok-app",
            "kind": "subagent",
            "git_ref": "HEAD",
            "head_commit": "ea837bbb4f3f625e9bb01268bab97476414abb5b",
            "status": "alive"
          },
          {
            "id": "feat-x",
            "path": "~/.grok/worktrees/oss-grok-app/feat-x",
            "repo_name": "grok-app",
            "kind": "user",
            "git_ref": "feat/x",
            "status": "alive"
          }
        ]"#;
        let list = parse_cli_worktree_list_json(raw, &home()).expect("parse");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "subagent-abc");
        assert_eq!(list[0].branch.as_deref(), Some("HEAD"));
        assert_eq!(list[0].status.as_deref(), Some("alive"));
        assert_eq!(list[0].head.as_deref(), Some("ea837bbb4f3f"));
        assert_eq!(list[1].path, "/Users/me/.grok/worktrees/oss-grok-app/feat-x");
        assert_eq!(list[1].branch.as_deref(), Some("feat/x"));
        assert_eq!(list[1].name, "feat-x");
    }

    #[test]
    fn parse_json_wrapped() {
        let raw = r#"{"worktrees":[{"id":"a","path":"/tmp/a","status":"stale"}]}"#;
        let list = parse_cli_worktree_list_json(raw, &home()).expect("parse");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "a");
        assert_eq!(list[0].status.as_deref(), Some("stale"));
    }

    #[test]
    fn parse_json_empty() {
        assert!(parse_cli_worktree_list_json("", &home()).unwrap().is_empty());
        assert!(parse_cli_worktree_list_json("[]", &home()).unwrap().is_empty());
    }

    #[test]
    fn parse_text_table() {
        let raw = "\
  ID                                                             TYPE     REPO   LABEL BRANCH               AGE        PATH
  subagent-019f99c5-d7db-7e50-9212-2ee9821126c0-24f7e69a9a88c6fa subagent grok-…       HEAD                 4d ago     ~/.grok/worktrees/oss-grok-app/subagent-019f99c5-d7db-7e50-9212-2ee9821126c0
  feat-login                                                     user     grok-…       feat/login           1h ago     /Users/me/.grok/worktrees/oss-grok-app/feat-login
  20 worktrees (20 subagent)
";
        let list = parse_cli_worktree_list_text(raw, &home());
        assert_eq!(list.len(), 2);
        assert_eq!(
            list[0].path,
            "/Users/me/.grok/worktrees/oss-grok-app/subagent-019f99c5-d7db-7e50-9212-2ee9821126c0"
        );
        assert_eq!(list[0].kind.as_deref(), Some("subagent"));
        assert_eq!(list[0].branch.as_deref(), Some("HEAD"));
        assert_eq!(list[1].name, "feat-login");
        assert_eq!(list[1].branch.as_deref(), Some("feat/login"));
        assert_eq!(list[1].kind.as_deref(), Some("user"));
    }

    #[test]
    fn unsupported_json_flag_detect() {
        assert!(looks_like_unsupported_json_flag(
            "error: unexpected argument '--json' found",
            ""
        ));
        assert!(!looks_like_unsupported_json_flag("ok", "[]"));
    }

    #[test]
    fn age_tokens() {
        assert!(is_age_token("4d"));
        assert!(is_age_token("ago"));
        assert!(is_age_token("12h"));
        assert!(!is_age_token("HEAD"));
        assert!(!is_age_token("feat/login"));
    }
}
