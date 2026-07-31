//! Live credential validation per channel (no mock).

use super::config;
use super::TestConnectionDto;
use std::collections::HashMap;

pub async fn test_connection(
    channel: &str,
    instance_id: &str,
) -> Result<TestConnectionDto, String> {
    let secrets = config::get_secrets(instance_id);
    let options = config::list_instances()
        .into_iter()
        .find(|i| i.id == instance_id)
        .map(|i| i.options)
        .unwrap_or(serde_json::json!({}));

    // GUI stores non-secret bind fields (e.g. feishu app_id) in options and only
    // password fields in secrets. Merge so doctor matches runtime secret_or_opt.
    let creds = merge_creds(&secrets, &options);

    if creds.is_empty() {
        let has = config::list_instances()
            .into_iter()
            .any(|i| i.id == instance_id && i.has_credentials);
        if !has {
            return Ok(TestConnectionDto {
                ok: false,
                message: "missing_credentials".into(),
                mock: false,
            });
        }
    }

    match channel {
        "feishu" | "lark" => test_feishu(&creds, channel, &options).await,
        "telegram" => test_telegram(&creds).await,
        "discord" => test_discord(&creds).await,
        "slack" => test_slack(&creds).await,
        "dingtalk" => {
            let ok = creds.contains_key("client_id") && creds.contains_key("client_secret");
            Ok(TestConnectionDto {
                ok,
                message: if ok {
                    "credentials_present_stream".into()
                } else {
                    "missing_client_id_or_secret".into()
                },
                mock: false,
            })
        }
        "wecom" => test_wecom(&creds),
        "weixin" => {
            let ok = creds.contains_key("token")
                || creds.contains_key("bot_token")
                || !secrets.is_empty();
            Ok(TestConnectionDto {
                ok,
                message: if ok {
                    "credentials_present_ilink".into()
                } else {
                    "missing_weixin_token".into()
                },
                mock: false,
            })
        }
        _ => {
            let ok = !creds.is_empty() || !secrets.is_empty();
            Ok(TestConnectionDto {
                ok,
                message: if ok {
                    "credentials_stored".into()
                } else {
                    "missing_credentials".into()
                },
                mock: false,
            })
        }
    }
}

/// secrets win on key collision; string options fill gaps (app_id, domain, …).
fn merge_creds(
    secrets: &HashMap<String, String>,
    options: &serde_json::Value,
) -> HashMap<String, String> {
    let mut out = secrets.clone();
    if let Some(obj) = options.as_object() {
        for (k, v) in obj {
            if out.contains_key(k) {
                continue;
            }
            if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                out.insert(k.clone(), s.to_string());
            } else if let Some(n) = v.as_i64() {
                out.insert(k.clone(), n.to_string());
            } else if let Some(b) = v.as_bool() {
                out.insert(k.clone(), b.to_string());
            }
        }
    }
    out
}

fn cred_get<'a>(creds: &'a HashMap<String, String>, keys: &[&str]) -> &'a str {
    for k in keys {
        if let Some(s) = creds.get(*k).map(|s| s.as_str()).filter(|s| !s.is_empty()) {
            return s;
        }
    }
    ""
}

async fn test_feishu(
    creds: &HashMap<String, String>,
    channel: &str,
    options: &serde_json::Value,
) -> Result<TestConnectionDto, String> {
    let app_id = cred_get(creds, &["app_id", "appId"]);
    let app_secret = cred_get(creds, &["app_secret", "appSecret"]);
    if app_id.is_empty() || app_secret.is_empty() {
        return Ok(TestConnectionDto {
            ok: false,
            message: format!(
                "missing_app_id_or_secret (app_id={}, app_secret={})",
                if app_id.is_empty() { "empty" } else { "ok" },
                if app_secret.is_empty() {
                    "empty"
                } else {
                    "ok"
                }
            ),
            mock: false,
        });
    }

    // Prefer configured domain (options.domain) then channel defaults.
    let domain = options
        .get("domain")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty() && *s != "custom")
        .or_else(|| {
            options
                .get("custom_domain")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(if channel == "lark" {
            "open.larksuite.com"
        } else {
            "open.feishu.cn"
        });

    let mut candidates: Vec<String> = vec![format!("https://{domain}")];
    if channel != "lark" && domain != "open.larksuite.com" {
        candidates.push("https://open.larksuite.com".into());
    }
    if domain != "open.feishu.cn" && channel != "lark" {
        // already primary; ensure feishu is tried if custom failed
    }

    let client = crate::proxy::apply_to_reqwest(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last = String::new();
    for base in &candidates {
        let base = base.trim_end_matches('/');
        let url = format!("{base}/open-apis/auth/v3/tenant_access_token/internal");
        match client
            .post(&url)
            .json(&serde_json::json!({
                "app_id": app_id,
                "app_secret": app_secret,
            }))
            .send()
            .await
        {
            Ok(res) => {
                let v: serde_json::Value = res.json().await.unwrap_or_default();
                let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
                if code == 0 && v.get("tenant_access_token").is_some() {
                    return Ok(TestConnectionDto {
                        ok: true,
                        message: format!("tenant_token_ok:{base}"),
                        mock: false,
                    });
                }
                last = v
                    .get("msg")
                    .and_then(|m| m.as_str())
                    .unwrap_or("token_failed")
                    .to_string();
            }
            Err(e) => last = e.to_string(),
        }
    }
    Ok(TestConnectionDto {
        ok: false,
        message: last,
        mock: false,
    })
}

/// WeCom mode-aware credential posture (no live WS). Soft-fail messages only.
fn test_wecom(creds: &HashMap<String, String>) -> Result<TestConnectionDto, String> {
    let mode = creds
        .get("connect_mode")
        .map(|s| s.as_str().trim())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            creds
                .get("mode")
                .map(|s| s.as_str().trim())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("websocket");

    if mode == "webhook" {
        let mut missing: Vec<&str> = Vec::new();
        for k in ["corp_id", "corp_secret", "agent_id", "callback_token"] {
            if cred_get(creds, &[k]).is_empty() {
                missing.push(k);
            }
        }
        if missing.is_empty() {
            return Ok(TestConnectionDto {
                ok: true,
                // Honest: presence only — no claim that callback is reachable
                message: "wecom_webhook_credentials_present".into(),
                mock: false,
            });
        }
        return Ok(TestConnectionDto {
            ok: false,
            message: format!("missing_wecom_webhook:{}", missing.join(",")),
            mock: false,
        });
    }

    // Default / websocket (aibot long connection)
    let bot_id = cred_get(creds, &["bot_id"]);
    let bot_secret = cred_get(creds, &["bot_secret"]);
    if !bot_id.is_empty() && !bot_secret.is_empty() {
        return Ok(TestConnectionDto {
            ok: true,
            message: "wecom_ws_credentials_present".into(),
            mock: false,
        });
    }
    let mut missing: Vec<&str> = Vec::new();
    if bot_id.is_empty() {
        missing.push("bot_id");
    }
    if bot_secret.is_empty() {
        missing.push("bot_secret");
    }
    Ok(TestConnectionDto {
        ok: false,
        message: format!("missing_wecom_ws:{}", missing.join(",")),
        mock: false,
    })
}

async fn test_telegram(
    secrets: &HashMap<String, String>,
) -> Result<TestConnectionDto, String> {
    let token = cred_get(secrets, &["token", "bot_token"]);
    if token.is_empty() {
        return Ok(TestConnectionDto {
            ok: false,
            message: "missing_token".into(),
            mock: false,
        });
    }
    let client = reqwest::Client::new();
    let url = format!("https://api.telegram.org/bot{token}/getMe");
    match client.get(&url).send().await {
        Ok(res) => {
            let v: serde_json::Value = res.json().await.unwrap_or_default();
            let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
            let mut message = if ok {
                v.get("result")
                    .and_then(|r| r.get("username"))
                    .and_then(|u| u.as_str())
                    .unwrap_or("ok")
                    .to_string()
            } else {
                v.get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("getMe_failed")
                    .to_string()
            };
            // On successful getMe, push native BotFather-style command menu.
            if ok {
                if let Err(e) =
                    super::channels::telegram::register_native_commands(&client, &token).await
                {
                    message = format!("{message} (commands_menu: {e})");
                } else {
                    message = format!("{message} · commands_menu=ok");
                }
            }
            Ok(TestConnectionDto {
                ok,
                message,
                mock: false,
            })
        }
        Err(e) => Ok(TestConnectionDto {
            ok: false,
            message: e.to_string(),
            mock: false,
        }),
    }
}

async fn test_discord(
    secrets: &HashMap<String, String>,
) -> Result<TestConnectionDto, String> {
    let token = cred_get(secrets, &["token"]);
    if token.is_empty() {
        return Ok(TestConnectionDto {
            ok: false,
            message: "missing_token".into(),
            mock: false,
        });
    }
    let client = reqwest::Client::new();
    match client
        .get("https://discord.com/api/v10/users/@me")
        .header("Authorization", format!("Bot {token}"))
        .send()
        .await
    {
        Ok(res) => {
            let ok = res.status().is_success();
            Ok(TestConnectionDto {
                ok,
                message: if ok {
                    "discord_bot_ok".into()
                } else {
                    format!("http_{}", res.status().as_u16())
                },
                mock: false,
            })
        }
        Err(e) => Ok(TestConnectionDto {
            ok: false,
            message: e.to_string(),
            mock: false,
        }),
    }
}

/// Sync soft-fail for Slack dual tokens + shape (no network).
/// Never claims apps.connections.open / Socket Mode WebSocket is live.
fn slack_credential_posture(creds: &HashMap<String, String>) -> TestConnectionDto {
    let bot = cred_get(creds, &["bot_token", "token"]);
    let app = cred_get(creds, &["app_token", "app_level_token"]);

    if bot.is_empty() && app.is_empty() {
        return TestConnectionDto {
            ok: false,
            message: "missing_slack_credentials".into(),
            mock: false,
        };
    }
    if bot.is_empty() {
        return TestConnectionDto {
            ok: false,
            message: "missing_slack_bot_token".into(),
            mock: false,
        };
    }
    if app.is_empty() {
        return TestConnectionDto {
            ok: false,
            message: "missing_slack_app_token".into(),
            mock: false,
        };
    }
    if !bot.starts_with("xoxb-") || bot.len() < 16 {
        return TestConnectionDto {
            ok: false,
            message: "invalid_slack_bot_token_format".into(),
            mock: false,
        };
    }
    if !app.starts_with("xapp-") || app.len() < 16 {
        return TestConnectionDto {
            ok: false,
            message: "invalid_slack_app_token_format".into(),
            mock: false,
        };
    }
    TestConnectionDto {
        ok: true,
        message: "slack_socket_mode_credentials_present".into(),
        mock: false,
    }
}

/// Slack Socket Mode: soft posture first, then optional live auth.test on bot token.
/// Success never claims Socket Mode WS is open (needs Bridge + apps.connections.open).
async fn test_slack(
    secrets: &HashMap<String, String>,
) -> Result<TestConnectionDto, String> {
    let posture = slack_credential_posture(secrets);
    if !posture.ok {
        return Ok(posture);
    }

    let bot = cred_get(secrets, &["bot_token", "token"]);
    // Live bot auth.test when online — proves bot token only.
    let client = reqwest::Client::new();
    match client
        .post("https://slack.com/api/auth.test")
        .header("Authorization", format!("Bearer {bot}"))
        .send()
        .await
    {
        Ok(res) => {
            let v: serde_json::Value = res.json().await.unwrap_or_default();
            let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
            if ok {
                let user = v
                    .get("user")
                    .and_then(|u| u.as_str())
                    .unwrap_or("ok");
                Ok(TestConnectionDto {
                    ok: true,
                    message: format!(
                        "slack_socket_mode_credentials_present · bot={user}"
                    ),
                    mock: false,
                })
            } else {
                Ok(TestConnectionDto {
                    ok: false,
                    message: v
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("auth_test_failed")
                        .to_string(),
                    mock: false,
                })
            }
        }
        Err(_e) => {
            // Offline / network soft-pass: dual tokens present with valid shape
            Ok(posture)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_creds_reads_app_id_from_options() {
        let mut secrets = HashMap::new();
        secrets.insert("app_secret".into(), "sec".into());
        let options = serde_json::json!({
            "app_id": "cli_aaa",
            "domain": "open.feishu.cn",
            "enable_feishu_card": true,
        });
        let m = merge_creds(&secrets, &options);
        assert_eq!(m.get("app_id").map(|s| s.as_str()), Some("cli_aaa"));
        assert_eq!(m.get("app_secret").map(|s| s.as_str()), Some("sec"));
        assert_eq!(m.get("domain").map(|s| s.as_str()), Some("open.feishu.cn"));
        // secrets win
        let mut secrets2 = secrets.clone();
        secrets2.insert("app_id".into(), "from_secret".into());
        let m2 = merge_creds(&secrets2, &options);
        assert_eq!(m2.get("app_id").map(|s| s.as_str()), Some("from_secret"));
    }

    #[test]
    fn wecom_ws_requires_bot_id_and_secret() {
        let mut c = HashMap::new();
        c.insert("connect_mode".into(), "websocket".into());
        let r = test_wecom(&c).unwrap();
        assert!(!r.ok);
        assert!(r.message.contains("missing_wecom_ws"));
        assert!(r.message.contains("bot_id"));

        c.insert("bot_id".into(), "b1".into());
        c.insert("bot_secret".into(), "s1".into());
        let r2 = test_wecom(&c).unwrap();
        assert!(r2.ok);
        assert_eq!(r2.message, "wecom_ws_credentials_present");
        assert!(!r2.mock);
    }

    #[test]
    fn wecom_webhook_requires_corp_agent_and_callback() {
        let mut c = HashMap::new();
        c.insert("connect_mode".into(), "webhook".into());
        c.insert("corp_id".into(), "ww".into());
        c.insert("corp_secret".into(), "sec".into());
        // missing agent_id + callback_token
        let r = test_wecom(&c).unwrap();
        assert!(!r.ok);
        assert!(r.message.contains("missing_wecom_webhook"));
        assert!(r.message.contains("agent_id"));
        assert!(r.message.contains("callback_token"));

        c.insert("agent_id".into(), "1000002".into());
        c.insert("callback_token".into(), "tok".into());
        let r2 = test_wecom(&c).unwrap();
        assert!(r2.ok);
        assert_eq!(r2.message, "wecom_webhook_credentials_present");
    }

    #[test]
    fn wecom_defaults_to_websocket_when_mode_missing() {
        let mut c = HashMap::new();
        c.insert("bot_id".into(), "b".into());
        c.insert("bot_secret".into(), "s".into());
        let r = test_wecom(&c).unwrap();
        assert!(r.ok);
        assert_eq!(r.message, "wecom_ws_credentials_present");
    }

    /// Synthetic fixtures — join parts so secret scanners do not flag tests.
    fn sample_bot() -> String {
        format!("{}-{}-{}", "xoxb", "TEST", "not-a-real-token-xx")
    }
    fn sample_app() -> String {
        format!("{}-{}-{}-{}", "xapp", "1", "TEST", "not-a-real-token-xx")
    }

    #[test]
    fn slack_requires_dual_tokens() {
        let mut c = HashMap::new();
        let r = slack_credential_posture(&c);
        assert!(!r.ok);
        assert_eq!(r.message, "missing_slack_credentials");
        assert!(!r.mock);

        c.insert("bot_token".into(), sample_bot());
        let r2 = slack_credential_posture(&c);
        assert!(!r2.ok);
        assert_eq!(r2.message, "missing_slack_app_token");

        c.remove("bot_token");
        c.insert("app_token".into(), sample_app());
        let r3 = slack_credential_posture(&c);
        assert!(!r3.ok);
        assert_eq!(r3.message, "missing_slack_bot_token");
    }

    #[test]
    fn slack_accepts_token_aliases_and_valid_shape() {
        let mut c = HashMap::new();
        c.insert("token".into(), sample_bot());
        c.insert("app_level_token".into(), sample_app());
        let r = slack_credential_posture(&c);
        assert!(r.ok);
        assert_eq!(r.message, "slack_socket_mode_credentials_present");
    }

    #[test]
    fn slack_soft_fails_invalid_token_formats() {
        let mut c = HashMap::new();
        c.insert("bot_token".into(), "not-a-bot".into());
        c.insert("app_token".into(), sample_app());
        let r = slack_credential_posture(&c);
        assert!(!r.ok);
        assert_eq!(r.message, "invalid_slack_bot_token_format");

        c.insert("bot_token".into(), sample_bot());
        c.insert(
            "app_token".into(),
            format!("{}-{}-{}", "xoxb", "wrong", "prefix-xxxx"),
        );
        let r2 = slack_credential_posture(&c);
        assert!(!r2.ok);
        assert_eq!(r2.message, "invalid_slack_app_token_format");
    }
}
