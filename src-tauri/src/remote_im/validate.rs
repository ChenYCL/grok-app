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
        "wecom" => {
            let ok = (creds.contains_key("bot_id") && creds.contains_key("bot_secret"))
                || (creds.contains_key("corp_id") && creds.contains_key("corp_secret"));
            Ok(TestConnectionDto {
                ok,
                message: if ok {
                    "credentials_present".into()
                } else {
                    "missing_wecom_credentials".into()
                },
                mock: false,
            })
        }
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

/// Soft App ID shape (aligned with pure feishuConfig). Empty = missing, not invalid.
fn is_feishu_app_id_format(raw: &str) -> bool {
    let t = raw.trim();
    if t.is_empty() || t.len() < 3 || t.len() > 128 {
        return false;
    }
    if t.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    let mut chars = t.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Soft pre-checks for Feishu/Lark (shape + presence only). Live tenant token is separate.
fn feishu_credential_posture(
    creds: &HashMap<String, String>,
    channel: &str,
    options: &serde_json::Value,
) -> Option<TestConnectionDto> {
    let app_id = cred_get(creds, &["app_id", "appId"]);
    let app_secret = cred_get(creds, &["app_secret", "appSecret"]);

    let mut missing: Vec<&str> = Vec::new();
    if app_id.is_empty() {
        missing.push("app_id");
    }
    if app_secret.is_empty() {
        missing.push("app_secret");
    }

    let domain_raw = options
        .get("domain")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim();
    if domain_raw == "custom" {
        let custom = options
            .get("custom_domain")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        if custom.is_empty() {
            return Some(TestConnectionDto {
                ok: false,
                message: "missing_feishu_custom_domain".into(),
                mock: false,
            });
        }
    }

    if !app_id.is_empty() && !is_feishu_app_id_format(app_id) {
        return Some(TestConnectionDto {
            ok: false,
            message: "invalid_feishu_app_id_format".into(),
            mock: false,
        });
    }

    if !missing.is_empty() {
        let msg = if missing.len() == 2 {
            "missing_feishu_credentials".to_string()
        } else {
            format!("missing_feishu_fields:{}", missing.join(","))
        };
        return Some(TestConnectionDto {
            ok: false,
            message: msg,
            mock: false,
        });
    }

    // Posture ok — let live tenant_access_token run. channel reserved for messages.
    let _ = channel;
    None
}

async fn test_feishu(
    creds: &HashMap<String, String>,
    channel: &str,
    options: &serde_json::Value,
) -> Result<TestConnectionDto, String> {
    if let Some(soft) = feishu_credential_posture(creds, channel, options) {
        return Ok(soft);
    }

    let app_id = cred_get(creds, &["app_id", "appId"]);
    let app_secret = cred_get(creds, &["app_secret", "appSecret"]);

    // Prefer configured domain (options.domain) then channel defaults.
    let domain = options
        .get("domain")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty() && *s != "custom" && *s != "feishu" && *s != "lark")
        .or_else(|| {
            let d = options.get("domain").and_then(|x| x.as_str()).unwrap_or("");
            if d == "lark" {
                Some("open.larksuite.com")
            } else if d == "feishu" {
                Some("open.feishu.cn")
            } else {
                None
            }
        })
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
                    // Honest: tenant token only — does not prove WS long-connection is online
                    return Ok(TestConnectionDto {
                        ok: true,
                        message: format!("feishu_tenant_token_ok:{base}"),
                        mock: false,
                    });
                }
                last = v
                    .get("msg")
                    .and_then(|m| m.as_str())
                    .unwrap_or("token_failed")
                    .to_string();
            }
            Err(e) => {
                let msg = e.to_string();
                // Soft-fail codes without leaking secrets
                last = if msg.to_ascii_lowercase().contains("proxy") {
                    "feishu_proxy_or_network_error".into()
                } else {
                    "feishu_network_error".into()
                };
            }
        }
    }
    Ok(TestConnectionDto {
        ok: false,
        message: last,
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
            Ok(TestConnectionDto {
                ok,
                message: if ok {
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
    fn feishu_app_id_format_soft_fail() {
        assert!(!is_feishu_app_id_format(""));
        assert!(!is_feishu_app_id_format("ab"));
        assert!(!is_feishu_app_id_format("has space"));
        assert!(is_feishu_app_id_format("cli_a1b2c3d4"));

        let mut c = HashMap::new();
        let opts = serde_json::json!({});
        let r = feishu_credential_posture(&c, "feishu", &opts).unwrap();
        assert!(!r.ok);
        assert_eq!(r.message, "missing_feishu_credentials");

        c.insert("app_id".into(), "bad id".into());
        c.insert("app_secret".into(), "sec".into());
        let r2 = feishu_credential_posture(&c, "feishu", &opts).unwrap();
        assert!(!r2.ok);
        assert_eq!(r2.message, "invalid_feishu_app_id_format");

        c.insert("app_id".into(), "cli_aaa".into());
        let opts_custom = serde_json::json!({ "domain": "custom" });
        let r3 = feishu_credential_posture(&c, "feishu", &opts_custom).unwrap();
        assert!(!r3.ok);
        assert_eq!(r3.message, "missing_feishu_custom_domain");

        let opts_ok = serde_json::json!({ "domain": "open.feishu.cn" });
        assert!(feishu_credential_posture(&c, "feishu", &opts_ok).is_none());
    }

    #[test]
    fn feishu_missing_secret_only() {
        let mut c = HashMap::new();
        c.insert("app_id".into(), "cli_aaa".into());
        let opts = serde_json::json!({});
        let r = feishu_credential_posture(&c, "feishu", &opts).unwrap();
        assert!(!r.ok);
        assert!(r.message.contains("missing_feishu_fields"));
        assert!(r.message.contains("app_secret"));
        assert!(!r.mock);
    }
}
