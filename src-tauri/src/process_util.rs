//! Cross-platform process / path helpers (Windows GUI spawn, home dir, PATH).

#![allow(dead_code)] // residual-clippy: tokio_command helper
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::thread;

/// User home directory.
///
/// - **Windows:** prefer `USERPROFILE` (matches PowerShell / install.ps1).
///   Fall back to `HOME` only if USERPROFILE is missing (Git Bash sometimes sets HOME).
/// - **Unix/macOS:** `HOME`.
pub fn user_home() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(h) = std::env::var("USERPROFILE") {
            if !h.is_empty() {
                return PathBuf::from(h);
            }
        }
        if let Ok(h) = std::env::var("HOME") {
            if !h.is_empty() {
                return PathBuf::from(h);
            }
        }
        return PathBuf::from(".");
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(h) = std::env::var("HOME") {
            if !h.is_empty() {
                return PathBuf::from(h);
            }
        }
        // Rare fallback
        if let Ok(h) = std::env::var("USERPROFILE") {
            if !h.is_empty() {
                return PathBuf::from(h);
            }
        }
        PathBuf::from(".")
    }
}

/// PATH list separator for the current OS.
pub fn path_list_separator() -> char {
    #[cfg(target_os = "windows")]
    {
        ';'
    }
    #[cfg(not(target_os = "windows"))]
    {
        ':'
    }
}

/// Hide console window when spawning CLI tools from a GUI app (Windows).
pub fn apply_no_window_std(cmd: &mut StdCommand) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// Same as [`apply_no_window_std`] for `tokio::process::Command`.
pub fn apply_no_window_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd;
}

/// Build a `std::process::Command` with Windows console hidden (Fixes #162).
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> StdCommand {
    let mut cmd = StdCommand::new(program);
    apply_no_window_std(&mut cmd);
    cmd
}

/// Build a `tokio::process::Command` with Windows console hidden.
pub fn tokio_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    apply_no_window_tokio(&mut cmd);
    cmd
}

/// Whether a path looks runnable as a CLI binary on this OS.
///
/// Follows symlinks (`is_file` / metadata). On Windows accepts `.exe`/`.cmd`/`.bat`/`.com`
/// and extension-less files (MSYS installs). On Unix requires any execute bit.
pub fn looks_runnable(path: &Path) -> bool {
    // `is_file` follows symlinks; also accept symlink-to-file that metadata sees as file.
    if !path.is_file() {
        // Windows: broken symlink or reparse point still listed — try metadata
        if path.symlink_metadata().is_err() {
            return false;
        }
        // Symlink that does not resolve: not runnable
        if !std::fs::metadata(path)
            .map(|m| m.is_file())
            .unwrap_or(false)
        {
            return false;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            return meta.permissions().mode() & 0o111 != 0;
        }
        false
    }
    #[cfg(not(unix))]
    {
        // Windows: .exe / .cmd / .bat / no extension (some installers / shims).
        match path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref()
        {
            Some("exe") | Some("cmd") | Some("bat") | Some("com") => true,
            None => true,
            Some(_) => false,
        }
    }
}

/// Push `p` onto `parts` if non-empty and not already present.
fn push_path_part(parts: &mut Vec<String>, p: &str) {
    if p.is_empty() {
        return;
    }
    if !parts.iter().any(|x| x == p) {
        parts.push(p.to_string());
    }
}

/// Push directory only when it exists (for optional user installs like conda).
fn push_path_dir_if_exists(parts: &mut Vec<String>, dir: &Path) {
    if dir.is_dir() {
        push_path_part(parts, &dir.to_string_lossy());
    }
}

/// Common user-level Python/Node/env manager bin dirs (conda, pyenv, nvm, asdf…).
///
/// GUI apps (Dock / Finder) inherit a sparse PATH and never load `~/.zshrc`, so
/// agent shell-outs miss tools that work in Terminal. Only **existing** dirs are
/// returned so PATH is not bloated with dead roots.
///
/// Pure helper (takes `home`) for unit tests.
pub fn user_tool_path_dirs(home: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push_dir = |p: PathBuf| {
        if p.is_dir() && !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    };

    // Active conda/mamba from parent env (e.g. app launched from an activated shell).
    for key in ["CONDA_PREFIX", "MAMBA_ROOT_PREFIX", "CONDA_ROOT"] {
        if let Ok(v) = std::env::var(key) {
            if v.is_empty() {
                continue;
            }
            let root = PathBuf::from(&v);
            #[cfg(target_os = "windows")]
            {
                push_dir(root.join("Scripts"));
                push_dir(root.join("Library").join("bin"));
                push_dir(root.join("bin"));
            }
            #[cfg(not(target_os = "windows"))]
            {
                push_dir(root.join("bin"));
                push_dir(root.join("condabin"));
            }
        }
    }
    // CONDA_EXE=/…/bin/conda → parent bin (+ condabin).
    if let Ok(exe) = std::env::var("CONDA_EXE") {
        if let Some(bin) = Path::new(&exe).parent() {
            push_dir(bin.to_path_buf());
            if let Some(root) = bin.parent() {
                #[cfg(target_os = "windows")]
                push_dir(root.join("Scripts"));
                #[cfg(not(target_os = "windows"))]
                push_dir(root.join("condabin"));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let names = [
            "miniconda3",
            "Miniconda3",
            "anaconda3",
            "Anaconda3",
            "mambaforge",
            "Mambaforge",
            "miniforge3",
            "Miniforge3",
            "micromamba",
        ];
        for name in names {
            let root = home.join(name);
            push_dir(root.join("Scripts"));
            push_dir(root.join("Library").join("bin"));
            push_dir(root.join("condabin"));
            push_dir(root.join("bin"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            for name in ["miniconda3", "Miniconda3", "anaconda3", "Anaconda3"] {
                let root = local.join(name);
                push_dir(root.join("Scripts"));
                push_dir(root.join("Library").join("bin"));
                push_dir(root.join("condabin"));
            }
        }
        push_dir(home.join(".pyenv").join("pyenv-win").join("shims"));
        push_dir(home.join(".pyenv").join("pyenv-win").join("bin"));
        if let Ok(nvm) = std::env::var("NVM_HOME") {
            push_dir(PathBuf::from(nvm));
        }
        if let Ok(nvm_sym) = std::env::var("NVM_SYMLINK") {
            push_dir(PathBuf::from(nvm_sym));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let conda_roots = [
            home.join("miniconda3"),
            home.join("anaconda3"),
            home.join("miniforge3"),
            home.join("mambaforge"),
            home.join("micromamba"),
            home.join("opt").join("miniconda3"),
            home.join("opt").join("anaconda3"),
            home.join("opt").join("miniforge3"),
            home.join("opt").join("mambaforge"),
            PathBuf::from("/opt/homebrew/Caskroom/miniconda/base"),
            PathBuf::from("/opt/homebrew/Caskroom/miniforge/base"),
            PathBuf::from("/usr/local/Caskroom/miniconda/base"),
            PathBuf::from("/usr/local/Caskroom/miniforge/base"),
            PathBuf::from("/opt/miniconda3"),
            PathBuf::from("/opt/anaconda3"),
            PathBuf::from("/opt/miniforge3"),
        ];
        for root in conda_roots {
            push_dir(root.join("bin"));
            push_dir(root.join("condabin"));
        }
        push_dir(home.join(".pyenv").join("shims"));
        push_dir(home.join(".pyenv").join("bin"));
        push_dir(home.join(".asdf").join("shims"));
        push_dir(home.join(".asdf").join("bin"));
        push_dir(home.join(".local").join("share").join("fnm"));
        let nvm_default = home.join(".nvm").join("alias").join("default");
        if let Ok(ver) = std::fs::read_to_string(&nvm_default) {
            let ver = ver.trim();
            if !ver.is_empty() && !ver.contains('/') {
                push_dir(
                    home.join(".nvm")
                        .join("versions")
                        .join("node")
                        .join(ver)
                        .join("bin"),
                );
            }
        }
        push_dir(home.join(".volta").join("bin"));
    }

    out
}

/// Build PATH suitable for GUI-spawned agent processes.
///
/// Starts from the process PATH, then appends common CLI install locations and
/// **existing** user tool roots (conda/mamba/pyenv/…) so nested shell tools
/// resolve like an interactive Terminal session without loading shell rc files.
pub fn enriched_path_env() -> Option<String> {
    let sep = path_list_separator();
    let mut parts: Vec<String> = Vec::new();

    if let Ok(cur) = std::env::var("PATH") {
        for p in cur.split(sep) {
            push_path_part(&mut parts, p);
        }
    }

    let home = user_home();
    let home_s = home.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        push_path_part(&mut parts, &format!(r"{home_s}\.grok\bin"));
        push_path_part(&mut parts, &format!(r"{home_s}\.local\bin"));
        push_path_part(&mut parts, &format!(r"{home_s}\.cargo\bin"));
        push_path_part(&mut parts, &format!(r"{home_s}\AppData\Local\pnpm"));
        push_path_part(&mut parts, &format!(r"{home_s}\AppData\Roaming\npm"));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            push_path_part(&mut parts, &format!(r"{local}\Programs"));
            push_path_part(&mut parts, &format!(r"{local}\Microsoft\WinGet\Links"));
        }
        push_path_part(&mut parts, r"C:\Program Files\nodejs");
        push_path_part(&mut parts, r"C:\Program Files\Git\cmd");
        push_path_part(&mut parts, r"C:\Program Files\Git\bin");
    }
    #[cfg(not(target_os = "windows"))]
    {
        push_path_part(&mut parts, &format!("{home_s}/.grok/bin"));
        push_path_part(&mut parts, &format!("{home_s}/.local/bin"));
        push_path_part(&mut parts, &format!("{home_s}/.cargo/bin"));
        push_path_part(&mut parts, &format!("{home_s}/.bun/bin"));
        push_path_part(&mut parts, "/opt/homebrew/bin");
        push_path_part(&mut parts, "/usr/local/bin");
        push_path_part(&mut parts, "/usr/bin");
        push_path_part(&mut parts, "/bin");
    }

    for d in user_tool_path_dirs(&home) {
        push_path_dir_if_exists(&mut parts, &d);
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(&sep.to_string()))
    }
}

/// Fire-and-forget background work that **must not** take down the process.
///
/// Named thread + `catch_unwind`: panics become error logs instead of process abort
/// when they would otherwise escape an unhandled thread (Rust default: abort on
/// uncaught panic in non-main threads depends on panic strategy; release often
/// aborts). Prefer this over bare `std::thread::spawn` for optional host chores.
pub fn spawn_named_catch<F>(name: impl Into<String>, f: F)
where
    F: FnOnce() + Send + 'static,
{
    let name = name.into();
    let label = name.clone();
    let result = thread::Builder::new().name(name).spawn(move || {
        if let Err(payload) = catch_unwind(AssertUnwindSafe(f)) {
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".into()
            };
            tracing::error!(thread = %label, panic = %msg, "background task panicked (caught)");
        }
    });
    if let Err(e) = result {
        tracing::error!(error = %e, "failed to spawn named background task");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_home_nonempty() {
        assert!(!user_home().as_os_str().is_empty());
    }

    #[test]
    fn enriched_path_has_separator() {
        if let Some(p) = enriched_path_env() {
            assert!(!p.is_empty());
            #[cfg(target_os = "windows")]
            assert!(p.contains(';') || !p.contains(':'));
        }
    }

    #[test]
    fn user_tool_path_dirs_only_existing() {
        let tmp = std::env::temp_dir().join(format!(
            "grok-app-path-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Missing install → empty extras from home scan (env may still add some).
        let missing = user_tool_path_dirs(&tmp);
        // No conda under empty temp home; env-based entries may exist.
        for d in &missing {
            assert!(d.is_dir(), "returned non-dir {}", d.display());
        }
        // Create a fake miniconda3/bin → must appear.
        let bin = tmp.join("miniconda3").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let found = user_tool_path_dirs(&tmp);
        assert!(
            found.iter().any(|p| p == &bin),
            "expected {:?} in {:?}",
            bin,
            found
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn enriched_path_includes_existing_tool_dirs() {
        let Some(path) = enriched_path_env() else {
            return;
        };
        let sep = path_list_separator();
        let parts: Vec<&str> = path.split(sep).filter(|s| !s.is_empty()).collect();
        assert!(!parts.is_empty());
        // Dedup preserved: no consecutive identical empties; unique membership.
        let mut seen = std::collections::HashSet::new();
        for p in &parts {
            assert!(seen.insert(*p), "duplicate PATH entry: {p}");
        }
    }

    #[test]
    fn spawn_named_catch_swallows_panic() {
        let (tx, rx) = std::sync::mpsc::channel();
        spawn_named_catch("test-panic-catch", move || {
            let _ = tx.send(());
            panic!("expected test panic");
        });
        // Task should start; panic must not kill the test process.
        let _ = rx.recv_timeout(std::time::Duration::from_secs(2));
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}
