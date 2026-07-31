//! Telegram Bot API long-polling (getUpdates) + native bot commands menu.

use super::super::outbound::{http_client, secret_or_opt};
use super::super::slash::{self, native_bot_commands};
use super::super::types::{ChannelInstance, IncomingMessage};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

pub async fn run(
    inst: ChannelInstance,
    tx: mpsc::Sender<IncomingMessage>,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let token = secret_or_opt(&inst.secrets, &inst.options, "bot_token")
        .or_else(|| secret_or_opt(&inst.secrets, &inst.options, "token"))
        .ok_or_else(|| "missing bot_token".to_string())?;
    let client = http_client()?;
    let mut offset: i64 = 0;

    tracing::info!(instance = %inst.id, "telegram long-poll starting");

    // drop pending webhook if any
    let _ = client
        .post(format!("https://api.telegram.org/bot{token}/deleteWebhook"))
        .json(&json!({ "drop_pending_updates": false }))
        .send()
        .await;

    // Register Telegram native command menu (/ key) for default + zh.
    if let Err(e) = register_native_commands(&client, &token).await {
        tracing::warn!(instance = %inst.id, "telegram setMyCommands failed: {e}");
    }

    loop {
        if *cancel.borrow() {
            return Ok(());
        }
        let url = format!(
            "https://api.telegram.org/bot{token}/getUpdates?timeout=25&offset={offset}"
        );
        let fut = client.get(&url).send();
        let res = tokio::select! {
            _ = cancel.changed() => {
                if *cancel.borrow() { return Ok(()); }
                continue;
            }
            r = fut => r,
        };
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(instance = %inst.id, "telegram poll error: {e}");
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        let body: Value = match res.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        if body.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }
        let Some(arr) = body.get("result").and_then(|r| r.as_array()) else {
            continue;
        };
        for upd in arr {
            if let Some(id) = upd.get("update_id").and_then(|x| x.as_i64()) {
                offset = id + 1;
            }
            let msg = upd.get("message").or_else(|| upd.get("edited_message"));
            let Some(msg) = msg else { continue };
            let raw_text = msg
                .get("text")
                .or_else(|| msg.get("caption"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if raw_text.is_empty() {
                continue;
            }
            let entities = msg.get("entities").and_then(|e| e.as_array());
            // Normalize `/cmd@BotName args` → `/cmd args` so control-plane slash parser matches.
            let text = normalize_bot_command_text(&raw_text, entities);
            let chat_id = msg
                .pointer("/chat/id")
                .map(|x| match x {
                    Value::Number(n) => n.to_string(),
                    Value::String(s) => s.clone(),
                    _ => String::new(),
                })
                .unwrap_or_default();
            let chat_type = msg
                .pointer("/chat/type")
                .and_then(|x| x.as_str())
                .map(|t| {
                    if t == "private" {
                        "p2p"
                    } else {
                        "group"
                    }
                })
                .unwrap_or("p2p")
                .to_string();
            let sender_id = msg
                .pointer("/from/id")
                .map(|x| match x {
                    Value::Number(n) => n.to_string(),
                    Value::String(s) => s.clone(),
                    _ => String::new(),
                })
                .unwrap_or_default();
            let message_id = msg
                .get("message_id")
                .map(|x| match x {
                    Value::Number(n) => n.to_string(),
                    Value::String(s) => s.clone(),
                    _ => String::new(),
                })
                .unwrap_or_default();
            // Private chats always; groups when @mentioned or a native bot_command entity.
            let mentioned_bot = chat_type == "p2p"
                || entities
                    .map(|e| {
                        e.iter().any(|ent| {
                            matches!(
                                ent.get("type").and_then(|t| t.as_str()),
                                Some("mention") | Some("bot_command")
                            )
                        })
                    })
                    .unwrap_or(false)
                || slash::parse_slash(&text).is_some();

            let _ = tx
                .send(IncomingMessage {
                    channel: inst.channel.clone(),
                    instance_id: inst.id.clone(),
                    message_id,
                    chat_id,
                    chat_type,
                    sender_id,
                    content: text,
                    mentioned_bot,
                })
                .await;
        }
    }
}

/// Register default + Chinese command lists with Telegram Bot API.
pub async fn register_native_commands(
    client: &reqwest::Client,
    token: &str,
) -> Result<(), String> {
    let base = format!("https://api.telegram.org/bot{token}/setMyCommands");

    let en_cmds: Vec<Value> = native_bot_commands()
        .iter()
        .map(|c| {
            json!({
                "command": c.command,
                "description": c.description_en,
            })
        })
        .collect();
    let zh_cmds: Vec<Value> = native_bot_commands()
        .iter()
        .map(|c| {
            json!({
                "command": c.command,
                "description": c.description_zh,
            })
        })
        .collect();

    // Default language (fallback for all clients)
    post_set_my_commands(client, &base, &en_cmds, None).await?;
    // Simplified Chinese clients
    post_set_my_commands(client, &base, &zh_cmds, Some("zh-hans")).await?;
    // Also zh as broader Chinese tag used by some clients
    let _ = post_set_my_commands(client, &base, &zh_cmds, Some("zh")).await;

    Ok(())
}

async fn post_set_my_commands(
    client: &reqwest::Client,
    url: &str,
    commands: &[Value],
    language_code: Option<&str>,
) -> Result<(), String> {
    let mut body = json!({ "commands": commands });
    if let Some(code) = language_code {
        body["language_code"] = json!(code);
    }
    let res = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("setMyCommands {status}: {text}"));
    }
    let v: Value = res.json().await.unwrap_or_default();
    if v.get("ok").and_then(|o| o.as_bool()) != Some(true) {
        let desc = v
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("setMyCommands_failed");
        return Err(desc.to_string());
    }
    Ok(())
}

/// Strip `@BotUsername` from the leading bot_command entity (UTF-16 offsets per Telegram API).
pub fn normalize_bot_command_text(text: &str, entities: Option<&Vec<Value>>) -> String {
    let Some(entities) = entities else {
        return strip_at_in_leading_slash(text);
    };
    let Some(ent) = entities.iter().find(|e| {
        e.get("type").and_then(|t| t.as_str()) == Some("bot_command")
            && e.get("offset").and_then(|o| o.as_u64()) == Some(0)
    }) else {
        return strip_at_in_leading_slash(text);
    };
    let Some(len) = ent.get("length").and_then(|l| l.as_u64()).map(|n| n as usize) else {
        return strip_at_in_leading_slash(text);
    };
    let utf16: Vec<u16> = text.encode_utf16().collect();
    if len > utf16.len() {
        return strip_at_in_leading_slash(text);
    }
    let cmd_u16 = &utf16[..len];
    let rest_u16 = &utf16[len..];
    let cmd = String::from_utf16_lossy(cmd_u16);
    let rest = String::from_utf16_lossy(rest_u16);
    let normalized_cmd = if let Some((base, _)) = cmd.split_once('@') {
        base.to_string()
    } else {
        cmd
    };
    format!("{normalized_cmd}{rest}")
}

/// Fallback when entities are missing: `/help@Bot arg` → `/help arg`.
fn strip_at_in_leading_slash(text: &str) -> String {
    let t = text.trim_start();
    if !t.starts_with('/') {
        return text.to_string();
    }
    let rest = &t[1..];
    let (head, tail) = match rest.find(char::is_whitespace) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if let Some((cmd, _)) = head.split_once('@') {
        format!("/{cmd}{tail}")
    } else {
        text.to_string()
    }
}

pub async fn send_text(
    secrets: &std::collections::HashMap<String, String>,
    chat_id: &str,
    text: &str,
) -> Result<(), String> {
    let token = secrets
        .get("bot_token")
        .or_else(|| secrets.get("token"))
        .map(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "missing bot_token".to_string())?;
    let client = http_client()?;
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let res = client
        .post(url)
        .json(&json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        // retry without markdown
        let res2 = client
            .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
            .json(&json!({ "chat_id": chat_id, "text": text }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res2.status().is_success() {
            return Err(format!("telegram send: {}", res2.status()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_bot_command_with_entity() {
        let text = "/help@MyGrokBot";
        // ASCII: length in UTF-16 units equals char count
        let entities = vec![json!({
            "offset": 0,
            "length": text.encode_utf16().count(),
            "type": "bot_command"
        })];
        assert_eq!(
            normalize_bot_command_text(text, Some(&entities)),
            "/help"
        );
    }

    #[test]
    fn normalizes_bot_command_with_args() {
        let text = "/p@MyBot 1";
        let entities = vec![json!({
            "offset": 0,
            "length": "/p@MyBot".encode_utf16().count(),
            "type": "bot_command"
        })];
        assert_eq!(
            normalize_bot_command_text(text, Some(&entities)),
            "/p 1"
        );
    }

    #[test]
    fn fallback_strip_without_entities() {
        assert_eq!(
            normalize_bot_command_text("/status@BotX", None),
            "/status"
        );
        assert_eq!(
            normalize_bot_command_text("/r@Bot 3", None),
            "/r 3"
        );
    }
}
