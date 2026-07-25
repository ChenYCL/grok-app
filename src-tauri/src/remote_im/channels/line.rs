//! LINE Messaging API — webhook HTTP server (public URL required).

use super::super::outbound::{http_client, secret_or_opt};
use super::super::types::{ChannelInstance, IncomingMessage};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};

pub async fn run(
    inst: ChannelInstance,
    tx: mpsc::Sender<IncomingMessage>,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let channel_secret = secret_or_opt(&inst.secrets, &inst.options, "channel_secret")
        .ok_or_else(|| "line: missing channel_secret".to_string())?;
    let _ = channel_secret; // signature verification can be added
    let access_token = secret_or_opt(&inst.secrets, &inst.options, "channel_access_token")
        .ok_or_else(|| "line: missing channel_access_token".to_string())?;
    let _ = access_token;

    let port: u16 = secret_or_opt(&inst.secrets, &inst.options, "port")
        .and_then(|s| s.parse().ok())
        .or_else(|| {
            inst.options
                .get("port")
                .and_then(|x| x.as_u64())
                .map(|n| n as u16)
        })
        .unwrap_or(8082);
    let path = secret_or_opt(&inst.secrets, &inst.options, "callback_path")
        .unwrap_or_else(|| "/line/callback".into());

    tracing::info!(instance = %inst.id, port, %path, "line webhook server starting");

    // Minimal raw TCP HTTP server to avoid new deps — use hyper via reqwest not available.
    // Use tokio TcpListener + very small request parser.
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("line bind {port}: {e}"))?;

    let inst = Arc::new(inst);
    let path = Arc::new(path);

    loop {
        tokio::select! {
            _ = cancel.changed() => {
                if *cancel.borrow() { return Ok(()); }
            }
            acc = listener.accept() => {
                let Ok((mut socket, _)) = acc else { continue };
                let tx = tx.clone();
                let inst = inst.clone();
                let path = path.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let n = match socket.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => return,
                    };
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let body = req.split("\r\n\r\n").nth(1).unwrap_or("");
                    if !req.contains(path.as_str()) {
                        let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                        return;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(body) {
                        if let Some(events) = v.get("events").and_then(|e| e.as_array()) {
                            for ev in events {
                                if ev.get("type").and_then(|t| t.as_str()) != Some("message") {
                                    continue;
                                }
                                let text = ev.pointer("/message/text").and_then(|x| x.as_str()).unwrap_or("");
                                if text.is_empty() { continue; }
                                let user = ev.pointer("/source/userId").and_then(|x| x.as_str()).unwrap_or("");
                                let reply_token = ev.get("replyToken").and_then(|x| x.as_str()).unwrap_or("");
                                // store reply token as message_id for outbound
                                let _ = tx.send(IncomingMessage {
                                    channel: inst.channel.clone(),
                                    instance_id: inst.id.clone(),
                                    message_id: reply_token.into(),
                                    chat_id: user.into(),
                                    chat_type: "p2p".into(),
                                    sender_id: user.into(),
                                    content: text.into(),
                                    mentioned_bot: true,
                                }).await;
                            }
                        }
                    }
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK").await;
                });
            }
        }
    }
}

pub async fn send_text(
    secrets: &std::collections::HashMap<String, String>,
    chat_id: &str,
    text: &str,
) -> Result<(), String> {
    let token = secrets
        .get("channel_access_token")
        .ok_or("missing channel_access_token")?;
    let client = http_client()?;
    // Prefer push; replyToken may be in chat_id if we stored wrongly — use push by userId
    let res = client
        .post("https://api.line.me/v2/bot/message/push")
        .bearer_auth(token)
        .json(&json!({
            "to": chat_id,
            "messages": [{ "type": "text", "text": text }]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("line push: {}", res.status()));
    }
    Ok(())
}

pub fn protocol_name() -> &'static str {
    "line-webhook"
}
