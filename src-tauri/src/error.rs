//! Host-side error taxonomy (P0 four codes). UI must not conflate these.
//! Full i18n copy is deferred; codes are stable for PR3+.

use serde::{Deserialize, Serialize};

/// Stable error codes for agent / runtime failures (AUTOPLAN §5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentErrorCode {
    /// Binary missing or not executable.
    CliNotFound,
    /// 401 / invalid key / not logged in.
    AuthFailed,
    /// DNS / timeout / provider 5xx / model 404.
    NetworkProvider,
    /// Process died or protocol crashed.
    AgentCrashed,
}

impl AgentErrorCode {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CliNotFound => "CLI_NOT_FOUND",
            Self::AuthFailed => "AUTH_FAILED",
            Self::NetworkProvider => "NETWORK_PROVIDER",
            Self::AgentCrashed => "AGENT_CRASHED",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentError {
    pub code: AgentErrorCode,
    pub message: String,
}

impl AgentError {
    pub fn new(code: AgentErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_serialize_to_stable_names() {
        let codes = [
            AgentErrorCode::CliNotFound,
            AgentErrorCode::AuthFailed,
            AgentErrorCode::NetworkProvider,
            AgentErrorCode::AgentCrashed,
        ];
        let expected = [
            "CLI_NOT_FOUND",
            "AUTH_FAILED",
            "NETWORK_PROVIDER",
            "AGENT_CRASHED",
        ];
        for (code, name) in codes.into_iter().zip(expected) {
            assert_eq!(code.as_str(), name);
            let json = serde_json::to_string(&code).unwrap();
            assert_eq!(json, format!("\"{name}\""));
        }
    }
}
