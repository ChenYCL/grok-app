//! Loopback HTTP media server — primary delivery for local files.
//!
//! Replaces the custom `media://` scheme for frontend `<img>` / `<video>` /
//! `fetch` loads. Benefits:
//! - Standard `http://127.0.0.1:{port}/…` URLs (WebView + browser + tools)
//! - Token gate (embedded browsers without the token cannot read disk)
//! - Same `path_scope` allowlist as the old protocol
//! - HTTP Range with bounded chunks (video/audio/PDF)
//!
//! URL shape (path never appears unencoded in the path segment):
//! ```text
//! GET http://127.0.0.1:{port}/v1/media?t={token}&p={urlencode(abs_path)}
//! ```

use std::io::{Read, Seek, SeekFrom};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rand::RngCore;
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Max bytes returned per request (keeps memory bounded — same as media_protocol).
const MAX_CHUNK: u64 = 2 * 1024 * 1024; // 2 MiB

/// Endpoint published to the frontend (base URL + secret token).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaServerEndpoint {
    pub base_url: String,
    pub token: String,
}

/// Managed Tauri state — process-wide media server.
pub struct MediaServerHandle {
    pub endpoint: MediaServerEndpoint,
    shutdown: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl MediaServerHandle {
    pub fn endpoint(&self) -> MediaServerEndpoint {
        self.endpoint.clone()
    }
}

impl Drop for MediaServerHandle {
    fn drop(&mut self) {
        if let Ok(mut g) = self.shutdown.lock() {
            if let Some(tx) = g.take() {
                let _ = tx.send(());
            }
        }
    }
}

#[derive(Clone)]
struct ServerState {
    token: Arc<String>,
}

#[derive(Debug, serde::Deserialize)]
struct MediaQuery {
    /// Shared secret from `media_server_endpoint`.
    t: String,
    /// Absolute filesystem path (percent-decoded by axum query parser).
    p: String,
}

/// Bind `127.0.0.1:0`, spawn axum serve task, return handle.
pub async fn start() -> Result<MediaServerHandle, String> {
    let token = random_token();
    let state = ServerState {
        token: Arc::new(token.clone()),
    };

    let app = Router::new()
        .route("/v1/media", get(media_get).head(media_get))
        .route("/v1/health", get(health))
        .fallback(fallback_not_found)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("media server bind: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("media server local_addr: {e}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let serve = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = serve.await {
            tracing::error!(error = %e, "media http server exited with error");
        } else {
            tracing::info!("media http server stopped");
        }
    });

    let base_url = format!("http://127.0.0.1:{bound}");
    tracing::info!(%base_url, "media http listening (loopback, token-gated)");

    Ok(MediaServerHandle {
        endpoint: MediaServerEndpoint { base_url, token },
        shutdown: std::sync::Mutex::new(Some(shutdown_tx)),
    })
}

/// Build a viewable URL for an absolute path (used by tests / optional host helpers).
pub fn url_for_path(endpoint: &MediaServerEndpoint, abs_path: &str) -> String {
    format!(
        "{}/v1/media?t={}&p={}",
        endpoint.base_url.trim_end_matches('/'),
        urlencoding_encode(&endpoint.token),
        urlencoding_encode(abs_path)
    )
}

fn random_token() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    // URL-safe base64 without padding
    base64_url_encode(&bytes)
}

fn base64_url_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Minimal encodeURIComponent-compatible encoder for query values.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => {
                out.push('%');
                out.push(char::from(HEX[(b >> 4) as usize]));
                out.push(char::from(HEX[(b & 0xf) as usize]));
            }
        }
    }
    out
}

const HEX: &[u8; 16] = b"0123456789ABCDEF";

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn fallback_not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, "not found")
}

async fn media_get(
    State(state): State<ServerState>,
    Query(q): Query<MediaQuery>,
    req: Request<Body>,
) -> Response {
    // Token must match exactly (constant-time-ish via subtle compare of equal length).
    if !tokens_equal(state.token.as_str(), &q.t) {
        tracing::warn!("media server: bad or missing token");
        return text_status(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    let path_raw = q.p.trim();
    if path_raw.is_empty() {
        return text_status(StatusCode::BAD_REQUEST, "missing path");
    }
    let path = PathBuf::from(path_raw);

    let path = match crate::path_scope::require_allowed(&path) {
        Ok(p) => p,
        Err(_) => {
            tracing::warn!(path = %path.display(), "media server: path not allowed");
            return text_status(StatusCode::FORBIDDEN, "path not allowed");
        }
    };

    if !path.is_file() {
        return text_status(StatusCode::NOT_FOUND, "file not found");
    }

    let method = req.method().clone();
    let range_hdr = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // File I/O off the async runtime.
    let result = tokio::task::spawn_blocking(move || {
        read_file_chunk(&path, range_hdr.as_deref(), method == Method::HEAD)
    })
    .await;

    match result {
        Ok(Ok(chunk)) => chunk.into_response(),
        Ok(Err((status, msg))) => text_status(status, msg),
        Err(e) => {
            tracing::error!(error = %e, "media server: join error");
            text_status(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}

struct FileChunk {
    status: StatusCode,
    mime: &'static str,
    start: u64,
    end: u64,
    total: u64,
    partial: bool,
    body: Vec<u8>,
    head_only: bool,
}

impl IntoResponse for FileChunk {
    fn into_response(self) -> Response {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(self.mime));
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static(
                "content-range, accept-ranges, content-length, content-type",
            ),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        );
        if self.partial && self.total > 0 {
            if let Ok(v) = HeaderValue::from_str(&format!(
                "bytes {}-{}/{}",
                self.start, self.end, self.total
            )) {
                headers.insert(header::CONTENT_RANGE, v);
            }
        }
        let body = if self.head_only {
            Body::empty()
        } else {
            Body::from(self.body)
        };
        if !self.head_only {
            if let Ok(v) = HeaderValue::from_str(&body_len_hint(&body)) {
                // Content-Length set by axum for full Body; for HEAD set explicitly.
                let _ = v;
            }
        }
        if self.head_only {
            let nbytes = if self.total == 0 {
                0
            } else {
                self.end.saturating_sub(self.start).saturating_add(1)
            };
            if let Ok(v) = HeaderValue::from_str(&nbytes.to_string()) {
                headers.insert(header::CONTENT_LENGTH, v);
            }
        }
        (self.status, headers, body).into_response()
    }
}

fn body_len_hint(_body: &Body) -> String {
    String::new()
}

fn read_file_chunk(
    path: &Path,
    range_hdr: Option<&str>,
    head_only: bool,
) -> Result<FileChunk, (StatusCode, &'static str)> {
    let mut file = std::fs::File::open(path).map_err(|_| {
        (
            StatusCode::FORBIDDEN,
            "open failed",
        )
    })?;
    let len = file
        .metadata()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "stat failed"))?
        .len();
    let mime = mime_from_path(&path.to_string_lossy());

    let (start, end, partial) = if let Some(rh) = range_hdr {
        match parse_range(rh, len) {
            Some((s, e)) => (s, e, true),
            None => {
                return Err((StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable"));
            }
        }
    } else if len == 0 {
        (0, 0, false)
    } else if len <= MAX_CHUNK {
        (0, len - 1, false)
    } else {
        // No Range on a large file: first chunk as 206 (player learns Accept-Ranges).
        (0, MAX_CHUNK - 1, true)
    };

    let nbytes = if len == 0 {
        0
    } else {
        end.saturating_sub(start).saturating_add(1)
    };
    if nbytes > MAX_CHUNK {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, "chunk too large"));
    }

    let body = if head_only || nbytes == 0 {
        Vec::new()
    } else {
        let mut buf = vec![0u8; nbytes as usize];
        file.seek(SeekFrom::Start(start))
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "seek failed"))?;
        match file.read_exact(&mut buf) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                // short read near EOF — keep what we have
            }
            Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, "read failed")),
        }
        buf
    };

    Ok(FileChunk {
        status: if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        mime,
        start,
        end,
        total: len,
        partial,
        body,
        head_only,
    })
}

fn text_status(status: StatusCode, msg: &str) -> Response {
    (status, msg.to_string()).into_response()
}

fn tokens_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    // Best-effort constant-time for equal-length secrets.
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn mime_from_path(path: &str) -> &'static str {
    let ext = path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let s = header.trim().strip_prefix("bytes=")?.trim();
    let part = s.split(',').next()?.trim();
    if let Some(suffix) = part.strip_prefix('-') {
        let n: u64 = suffix.parse().ok()?;
        if n == 0 || len == 0 {
            return None;
        }
        let n = n.min(len);
        return Some((len - n, len - 1));
    }
    let (a, b) = part.split_once('-')?;
    let start: u64 = a.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if b.is_empty() {
        (start + MAX_CHUNK - 1).min(len - 1)
    } else {
        let e: u64 = b.parse().ok()?;
        e.min(len - 1)
    };
    if end < start {
        return None;
    }
    let end = start.saturating_add(MAX_CHUNK - 1).min(end).min(len - 1);
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parse_range_suffix_and_cap() {
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99.min(MAX_CHUNK - 1))));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
    }

    #[test]
    fn tokens_equal_rejects_mismatch() {
        assert!(tokens_equal("abc", "abc"));
        assert!(!tokens_equal("abc", "abd"));
        assert!(!tokens_equal("abc", "ab"));
    }

    #[test]
    fn url_for_path_encodes() {
        let ep = MediaServerEndpoint {
            base_url: "http://127.0.0.1:9".into(),
            token: "tok".into(),
        };
        let u = url_for_path(&ep, "/Users/me/a b.png");
        assert!(u.contains("t=tok"));
        assert!(u.contains("p=%2FUsers%2Fme%2Fa%20b.png") || u.contains("a%20b"));
    }

    #[tokio::test]
    async fn serves_allowed_file_with_token() {
        let dir = std::env::temp_dir().join(format!("grok-media-srv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hi.png");
        {
            let mut f = std::fs::File::create(&file).unwrap();
            // minimal PNG-ish bytes
            f.write_all(b"\x89PNG\r\n\x1a\nhello").unwrap();
        }
        crate::path_scope::grant_path(&file);

        let handle = start().await.expect("start");
        let url = url_for_path(&handle.endpoint(), &file.to_string_lossy());
        let client = reqwest::Client::new();
        let res = client.get(&url).send().await.expect("get");
        assert_eq!(res.status(), 200);
        let bytes = res.bytes().await.unwrap();
        assert!(bytes.starts_with(b"\x89PNG"));

        // Bad token
        let bad = url.replace(&handle.endpoint.token, "wrong-token-xxxxxxxx");
        let res = client.get(&bad).send().await.expect("get bad");
        assert_eq!(res.status(), 401);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
