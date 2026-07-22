//! App data roots: independent default `~/.grok-app` (Win: %APPDATA%/grok-app).

use std::path::PathBuf;

use directories::ProjectDirs;

pub fn app_data_root() -> PathBuf {
    if let Ok(custom) = std::env::var("GROK_APP_HOME") {
        return PathBuf::from(custom);
    }
    if let Some(proj) = ProjectDirs::from("com", "grokapp", "grok-app") {
        return proj.data_dir().to_path_buf();
    }
    // Fallback
    dirs_fallback()
}

fn dirs_fallback() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("grok-app");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".grok-app")
}

pub fn ensure_app_dirs() -> std::io::Result<PathBuf> {
    let root = app_data_root();
    std::fs::create_dir_all(root.join("projects"))?;
    std::fs::create_dir_all(root.join("sessions"))?;
    std::fs::create_dir_all(root.join("logs"))?;
    // Agent profile (config.toml / optional auth) when session_data_mode=independent.
    std::fs::create_dir_all(root.join("agent-home"))?;
    Ok(root)
}

/// GROK_HOME for independent mode: App-owned agent profile (providers, config).
pub fn agent_home_dir() -> PathBuf {
    app_data_root().join("agent-home")
}

pub fn agent_config_toml() -> PathBuf {
    agent_home_dir().join("config.toml")
}

/// Resolve GROK_HOME for a spawned agent process.
pub fn resolve_agent_grok_home(session_data_mode: &str) -> PathBuf {
    if session_data_mode == "shared" {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        return PathBuf::from(home).join(".grok");
    }
    let _ = ensure_app_dirs();
    agent_home_dir()
}

pub fn projects_file() -> PathBuf {
    app_data_root().join("projects.json")
}

pub fn sessions_index_file() -> PathBuf {
    app_data_root().join("sessions_index.json")
}

pub fn settings_file() -> PathBuf {
    app_data_root().join("settings.json")
}

pub fn secrets_file() -> PathBuf {
    // Plain file with 0600; production may move to Keychain later.
    app_data_root().join("secrets.json")
}

pub fn session_dir(session_id: &str) -> PathBuf {
    app_data_root().join("sessions").join(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_root_is_absolute_or_relative_path() {
        let p = app_data_root();
        assert!(!p.as_os_str().is_empty());
    }
}
