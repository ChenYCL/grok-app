//! Speech-to-text via xAI REST API (composer dictation).

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::voice_auth;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttResult {
    pub text: String,
    pub duration: Option<f64>,
    pub language: Option<String>,
}

/// Transcribe a base64-encoded audio blob (wav/webm/mp3). Used by the composer mic.
pub async fn transcribe_base64(
    audio_b64: &str,
    mime: Option<&str>,
    language: Option<&str>,
) -> Result<SttResult, String> {
    if std::env::var("GROK_APP_VOICE")
        .map(|v| v == "mock")
        .unwrap_or(false)
    {
        return Ok(SttResult {
            text: "mock transcript from voice dictation".into(),
            duration: Some(1.0),
            language: Some("en".into()),
        });
    }

    let token = voice_auth::resolve_bearer_token()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_b64.trim())
        .map_err(|e| format!("invalid audio base64: {e}"))?;
    if bytes.is_empty() {
        return Err("empty audio".into());
    }

    let (filename, content_type) = match mime.unwrap_or("") {
        m if m.contains("webm") => ("audio.webm", "audio/webm"),
        m if m.contains("ogg") => ("audio.ogg", "audio/ogg"),
        m if m.contains("mpeg") || m.contains("mp3") => ("audio.mp3", "audio/mpeg"),
        m if m.contains("mp4") || m.contains("m4a") => ("audio.m4a", "audio/mp4"),
        _ => ("audio.wav", "audio/wav"),
    };

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str(content_type)
        .map_err(|e| format!("multipart: {e}"))?;

    let mut form = reqwest::multipart::Form::new().part("file", part);
    if let Some(lang) = language.filter(|s| !s.is_empty()) {
        form = form
            .text("language", lang.to_string())
            .text("format", "true");
    }

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.x.ai/v1/stt")
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("STT request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("STT read body: {e}"))?;
    if !status.is_success() {
        let snippet: String = body.chars().take(240).collect();
        return Err(format!("STT HTTP {status}: {snippet}"));
    }

    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("STT JSON: {e}; body={body}"))?;
    let text = v
        .get("text")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(SttResult {
        text,
        duration: v.get("duration").and_then(|x| x.as_f64()),
        language: v
            .get("language")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_stt() {
        std::env::set_var("GROK_APP_VOICE", "mock");
        let r = transcribe_base64("AAAA", Some("audio/wav"), Some("en"))
            .await
            .unwrap();
        assert!(r.text.contains("mock"));
        std::env::remove_var("GROK_APP_VOICE");
    }
}
