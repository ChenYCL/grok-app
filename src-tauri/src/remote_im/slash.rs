//! IM slash commands: /p project · /r resume · /help …
//! Also used as the catalog for Telegram Bot API `setMyCommands` (native / menu).

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuiltinCommand {
    Help,
    New,
    Whoami,
    Status,
    Stop,
    Project { query: Option<String> },
    Resume { query: Option<String> },
    Unknown { raw: String },
}

/// One entry for Telegram-style native bot command menus.
#[derive(Debug, Clone, Copy)]
pub struct NativeBotCommand {
    pub command: &'static str,
    pub description_en: &'static str,
    pub description_zh: &'static str,
}

/// Commands registered via Telegram `setMyCommands` (and documented in `/help`).
/// Names: 1–32 chars, lowercase a-z / 0-9 / underscore only.
pub fn native_bot_commands() -> &'static [NativeBotCommand] {
    &[
        NativeBotCommand {
            command: "start",
            description_en: "Welcome & help",
            description_zh: "欢迎与帮助",
        },
        NativeBotCommand {
            command: "help",
            description_en: "List all commands",
            description_zh: "显示全部命令",
        },
        NativeBotCommand {
            command: "p",
            description_en: "List / bind a trusted project",
            description_zh: "列出或绑定已信任项目",
        },
        NativeBotCommand {
            command: "project",
            description_en: "Same as /p",
            description_zh: "同 /p",
        },
        NativeBotCommand {
            command: "r",
            description_en: "List / resume a prior session",
            description_zh: "列出或恢复历史会话",
        },
        NativeBotCommand {
            command: "resume",
            description_en: "Same as /r",
            description_zh: "同 /r",
        },
        NativeBotCommand {
            command: "new",
            description_en: "Fresh session (keep project)",
            description_zh: "保持项目，开启新会话",
        },
        NativeBotCommand {
            command: "status",
            description_en: "Binding & runtime snapshot",
            description_zh: "绑定与运行状态",
        },
        NativeBotCommand {
            command: "whoami",
            description_en: "Show your sender id",
            description_zh: "查看发送者 id",
        },
        NativeBotCommand {
            command: "stop",
            description_en: "Cancel in-flight turn",
            description_zh: "中断当前任务",
        },
    ]
}

/// Strip Telegram group form `/cmd@BotName` → `cmd`.
fn normalize_command_head(head: &str) -> String {
    let lower = head.to_ascii_lowercase();
    match lower.split_once('@') {
        Some((cmd, _)) => cmd.to_string(),
        None => lower,
    }
}

pub fn parse_slash(text: &str) -> Option<BuiltinCommand> {
    let t = text.trim();
    if !t.starts_with('/') {
        return None;
    }
    let rest = &t[1..];
    let (head_raw, query) = match rest.find(char::is_whitespace) {
        Some(i) => {
            let q = rest[i + 1..].trim();
            (
                rest[..i].to_string(),
                if q.is_empty() {
                    None
                } else {
                    Some(q.to_string())
                },
            )
        }
        None => (rest.to_string(), None),
    };
    let head = normalize_command_head(&head_raw);
    Some(match head.as_str() {
        // Telegram always sends /start on first open; treat as help/welcome.
        "start" | "help" | "h" | "?" => BuiltinCommand::Help,
        "new" | "reset" => BuiltinCommand::New,
        "whoami" | "id" => BuiltinCommand::Whoami,
        "status" => BuiltinCommand::Status,
        "stop" | "cancel" => BuiltinCommand::Stop,
        "p" | "project" => BuiltinCommand::Project { query },
        "r" | "resume" => BuiltinCommand::Resume { query },
        other => BuiltinCommand::Unknown {
            raw: other.to_string(),
        },
    })
}

pub fn help_text(lang: &str) -> String {
    if lang == "en" {
        [
            "**Grok Remote IM** — local Grok Build via IM (Rust)",
            "",
            "Commands (Telegram: type `/` for the native menu):",
            "- `/start` · `/help` — this message",
            "- `/p` · `/project` — list / bind a trusted project",
            "- `/p <name|n>` — bind by name or number",
            "- `/r` · `/resume` — list / resume a prior session",
            "- `/r <n>` — resume by number",
            "- `/new` — fresh session (keep project)",
            "- `/whoami` — show your sender id",
            "- `/status` — snapshot",
            "- `/stop` — cancel in-flight turn",
            "- `0` — cancel number-pick mode",
        ]
        .join("\n")
    } else {
        [
            "**Grok Remote IM** — 本地 Grok Build 远程 IM 桥（Rust 内置）",
            "",
            "命令（Telegram 输入 `/` 可唤起原生命令菜单）：",
            "- `/start` · `/help` — 显示帮助",
            "- `/p` · `/project` — 列出 / 绑定已信任项目",
            "- `/p <名|序号>` — 按名称或序号绑定",
            "- `/r` · `/resume` — 列出 / 恢复历史会话",
            "- `/r <序号>` — 按序号恢复",
            "- `/new` — 保持项目，开启新会话",
            "- `/whoami` — 查看发送者 id",
            "- `/status` — 状态快照",
            "- `/stop` — 中断当前任务",
            "- `0` — 取消序号选择",
        ]
        .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_project_resume() {
        assert_eq!(
            parse_slash("/p"),
            Some(BuiltinCommand::Project { query: None })
        );
        assert_eq!(
            parse_slash("/p 1"),
            Some(BuiltinCommand::Project {
                query: Some("1".into())
            })
        );
        assert_eq!(
            parse_slash("/r"),
            Some(BuiltinCommand::Resume { query: None })
        );
        assert!(matches!(parse_slash("hi"), None));
    }

    #[test]
    fn strips_telegram_bot_suffix() {
        assert_eq!(
            parse_slash("/help@MyGrokBot"),
            Some(BuiltinCommand::Help)
        );
        assert_eq!(
            parse_slash("/p@MyGrokBot 2"),
            Some(BuiltinCommand::Project {
                query: Some("2".into())
            })
        );
        assert_eq!(
            parse_slash("/START@bot"),
            Some(BuiltinCommand::Help)
        );
    }

    #[test]
    fn start_is_help() {
        assert_eq!(parse_slash("/start"), Some(BuiltinCommand::Help));
        assert_eq!(
            parse_slash("/start payload"),
            Some(BuiltinCommand::Help)
        );
    }

    #[test]
    fn native_catalog_commands_are_valid() {
        for c in native_bot_commands() {
            assert!(!c.command.is_empty() && c.command.len() <= 32);
            assert!(c
                .command
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_'));
            assert!(!c.description_en.is_empty() && c.description_en.len() <= 256);
            assert!(!c.description_zh.is_empty() && c.description_zh.len() <= 256);
        }
    }
}
