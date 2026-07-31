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
        "weixin" => test_weixin(&creds),
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
        "line" => test_line(&creds),
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

/// Weixin personal (ilink) credential posture — presence only, no live long-poll.
fn test_weixin(creds: &HashMap<String, String>) -> Result<TestConnectionDto, String> {
    let token = cred_get(creds, &["token", "bot_token", "ilink_token"]);
    if token.is_empty() {
        return Ok(TestConnectionDto {
            ok: false,
            message: "missing_weixin_token".into(),
            mock: false,
        });
    }

    // Soft option checks (shape only — never claims getUpdates is live).
    let base = cred_get(creds, &["base_url"]);
    if !base.is_empty()
        && !(base.starts_with("https://") || base.starts_with("http://"))
    {
        return Ok(TestConnectionDto {
            ok: false,
            message: "invalid_weixin_base_url".into(),
            mock: false,
        });
    }
    let proxy = cred_get(creds, &["proxy"]);
    if !proxy.is_empty() {
        let ok_proxy = proxy.starts_with("http://")
            || proxy.starts_with("https://")
            || proxy.starts_with("socks5://")
            || proxy.starts_with("socks5h://");
        if !ok_proxy {
            return Ok(TestConnectionDto {
                ok: false,
                message: "invalid_weixin_proxy".into(),
/// LINE webhook credential posture — presence + port/path shape only.
/// Never claims the public callback is reachable (tunnel is user-side helper).
fn test_line(creds: &HashMap<String, String>) -> Result<TestConnectionDto, String> {
    let channel_secret = cred_get(creds, &["channel_secret"]);
    let access_token = cred_get(creds, &["channel_access_token", "access_token"]);

    let mut missing: Vec<&str> = Vec::new();
    if channel_secret.is_empty() {
        missing.push("channel_secret");
    }
    if access_token.is_empty() {
        missing.push("channel_access_token");
    }

    // Soft option shape checks (never prove public HTTPS).
    let port = cred_get(creds, &["port"]);
    if !port.is_empty() {
        let ok_port = port
            .parse::<u16>()
            .ok()
            .filter(|p| *p >= 1)
            .is_some();
        if !ok_port {
            return Ok(TestConnectionDto {
                ok: false,
                message: "invalid_line_port".into(),
                mock: false,
            });
        }
    }
    let path = cred_get(creds, &["callback_path"]);
    if !path.is_empty() {
        let ok_path = path.starts_with('/')
            && !path.contains("://")
            && !path.chars().any(|c| c.is_whitespace());
        if !ok_path {
            return Ok(TestConnectionDto {
                ok: false,
                message: "invalid_line_callback_path".into(),
                mock: false,
            });
        }
    }

    let message = if !proxy.is_empty() {
        "weixin_ilink_credentials_present_proxy"
    } else {
        "weixin_ilink_credentials_present"
    };
    Ok(TestConnectionDto {
        ok: true,
        // Honest: token present only — does not prove ilink long-poll is online
    if !missing.is_empty() {
        return Ok(TestConnectionDto {
            ok: false,
            message: if missing.len() == 2 {
                "missing_line_credentials".into()
            } else {
                format!("missing_line_fields:{}", missing.join(","))
            },
            mock: false,
        });
    }

    let message = if !port.is_empty() && port != "8081" {
        "line_webhook_credentials_present_custom_port"
    } else {
        "line_webhook_credentials_present"
    };
    Ok(TestConnectionDto {
        ok: true,
        // Honest: secrets present only — does not prove public webhook is live
        message: message.into(),
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

/// Discord bot token shape: three base64url-ish segments (optional "Bot " prefix).
/// Soft-fail only — never logs the token.
fn is_discord_bot_token_format(raw: &str) -> bool {
    let t = raw.trim();
    if t.is_empty() {
        return false;
    }
    let body = t
        .strip_prefix("Bot ")
        .or_else(|| t.strip_prefix("bot "))
        .unwrap_or(t)
        .trim();
    let parts: Vec<&str> = body.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts.iter().enumerate().all(|(i, p)| {
        let min = if i == 1 { 4 } else { 20 };
        p.len() >= min
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

async fn test_discord(
    secrets: &HashMap<String, String>,
) -> Result<TestConnectionDto, String> {
    let token = cred_get(secrets, &["token", "bot_token"]);
    if token.is_empty() {
        return Ok(TestConnectionDto {
            ok: false,
            message: "missing_discord_token".into(),
            mock: false,
        });
    }
    // Soft-fail bad paste before network (honest; never claims Gateway live).
    if !is_discord_bot_token_format(token) {
        return Ok(TestConnectionDto {
            ok: false,
            message: "invalid_discord_token_format".into(),
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
            let status = res.status();
            if status.is_success() {
                // REST identity only — Gateway requires Bridge link + Message Content Intent.
                Ok(TestConnectionDto {
                    ok: true,
                    message: "discord_bot_identity_ok".into(),
                    mock: false,
                })
            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                Ok(TestConnectionDto {
                    ok: false,
                    message: format!("discord_auth_http_{}", status.as_u16()),
                    mock: false,
                })
            } else {
                Ok(TestConnectionDto {
                    ok: false,
                    message: format!("discord_http_{}", status.as_u16()),
                    mock: false,
                })
            }
        }
        Err(e) => Ok(TestConnectionDto {
            ok: false,
            // Network soft-fail — credentials may still be fine; Gateway not verified.
            message: format!("discord_network:{}", e),
            mock: false,
        }),
    }
}

async fn test_slack(
    secrets: &HashMap<String, String>,
) -> Result<TestConnectionDto, String> {
    let token = cred_get(secrets, &["bot_token", "token"]);
    if token.is_empty() {
        return Ok(TestConnectionDto {
            ok: false,
            message: "missing_bot_token".into(),
            mock: false,
        });
    }
    let client = reqwest::Client::new();
    match client
        .post("https://slack.com/api/auth.test")
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(res) => {
            let v: serde_json::Value = res.json().await.unwrap_or_default();
            let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
            Ok(TestConnectionDto {
                ok,
                message: if ok {
                    v.get("user")
                        .and_then(|u| u.as_str())
                        .unwrap_or("ok")
                        .to_string()
                } else {
                    v.get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("auth_test_failed")
                        .to_string()
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

    #[test]
    fn weixin_requires_token_not_any_secret() {
        let mut c = HashMap::new();
        c.insert("account_id".into(), "default".into());
        let r = test_weixin(&c).unwrap();
        assert!(!r.ok);
        assert_eq!(r.message, "missing_weixin_token");
        assert!(!r.mock);

        c.insert("token".into(), "ilink-tok".into());
        let r2 = test_weixin(&c).unwrap();
        assert!(r2.ok);
        assert_eq!(r2.message, "weixin_ilink_credentials_present");
    }

    #[test]
    fn weixin_accepts_token_aliases() {
        for key in ["bot_token", "ilink_token"] {
            let mut c = HashMap::new();
            c.insert(key.into(), "x".into());
            let r = test_weixin(&c).unwrap();
            assert!(r.ok, "alias {key}");
            assert_eq!(r.message, "weixin_ilink_credentials_present");
        }
    }

    #[test]
    fn weixin_soft_fails_invalid_base_url_and_proxy() {
        let mut c = HashMap::new();
        c.insert("token".into(), "t".into());
        c.insert("base_url".into(), "not-a-url".into());
        let r = test_weixin(&c).unwrap();
        assert!(!r.ok);
        assert_eq!(r.message, "invalid_weixin_base_url");

        c.remove("base_url");
        c.insert("proxy".into(), "ftp://bad".into());
        let r2 = test_weixin(&c).unwrap();
        assert!(!r2.ok);
        assert_eq!(r2.message, "invalid_weixin_proxy");

        c.insert("proxy".into(), "socks5://127.0.0.1:1080".into());
        let r3 = test_weixin(&c).unwrap();
        assert!(r3.ok);
        assert_eq!(r3.message, "weixin_ilink_credentials_present_proxy");
    fn discord_token_format_accepts_three_segments() {
        // Synthetic shape only — not a real Discord credential.
        let ok = "TESTTOKEN_NOT_A_SECRET_xx.TEST.TESTTOKEN_NOT_A_SECRET_TAIL_xx";
        assert!(is_discord_bot_token_format(ok));
        assert!(is_discord_bot_token_format(&format!("Bot {ok}")));
        assert!(!is_discord_bot_token_format(""));
        assert!(!is_discord_bot_token_format("not-a-token"));
        assert!(!is_discord_bot_token_format("only.two"));
        assert!(!is_discord_bot_token_format(
            "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
        ));
    }

    #[tokio::test]
    async fn discord_soft_fails_missing_and_bad_format() {
        let empty = HashMap::new();
        let r = test_discord(&empty).await.unwrap();
        assert!(!r.ok);
        assert_eq!(r.message, "missing_discord_token");
        assert!(!r.mock);

        let mut bad = HashMap::new();
        bad.insert("token".into(), "garbage".into());
        let r2 = test_discord(&bad).await.unwrap();
        assert!(!r2.ok);
        assert_eq!(r2.message, "invalid_discord_token_format");
        assert!(!r2.mock);
    fn line_requires_secret_and_access_token() {
        let mut c = HashMap::new();
        let r = test_line(&c).unwrap();
        assert!(!r.ok);
        assert_eq!(r.message, "missing_line_credentials");
        assert!(!r.mock);

        c.insert("channel_secret".into(), "sec".into());
        let r2 = test_line(&c).unwrap();
        assert!(!r2.ok);
        assert!(r2.message.contains("channel_access_token"));

        c.insert("channel_access_token".into(), "tok".into());
        let r3 = test_line(&c).unwrap();
        assert!(r3.ok);
        assert_eq!(r3.message, "line_webhook_credentials_present");
    }

    #[test]
    fn line_accepts_access_token_alias() {
        let mut c = HashMap::new();
        c.insert("channel_secret".into(), "sec".into());
        c.insert("access_token".into(), "tok".into());
        let r = test_line(&c).unwrap();
        assert!(r.ok);
        assert_eq!(r.message, "line_webhook_credentials_present");
    }

    #[test]
    fn line_soft_fails_invalid_port_and_path() {
        let mut c = HashMap::new();
        c.insert("channel_secret".into(), "sec".into());
        c.insert("channel_access_token".into(), "tok".into());
        c.insert("port".into(), "not-a-port".into());
        let r = test_line(&c).unwrap();
        assert!(!r.ok);
        assert_eq!(r.message, "invalid_line_port");

        c.insert("port".into(), "9443".into());
        c.insert("callback_path".into(), "relative".into());
        let r2 = test_line(&c).unwrap();
        assert!(!r2.ok);
        assert_eq!(r2.message, "invalid_line_callback_path");

        c.insert("callback_path".into(), "/hooks/line".into());
        let r3 = test_line(&c).unwrap();
        assert!(r3.ok);
        assert_eq!(r3.message, "line_webhook_credentials_present_custom_port");
    }
}
