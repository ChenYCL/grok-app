//! Mirror host token generation and constant-time comparison.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;

/// Cryptographic random token: ≥32 bytes, URL-safe base64 (no padding).
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Constant-time equality for same-length secrets; length mismatch is immediate false.
pub fn tokens_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.as_bytes().iter().zip(b.as_bytes().iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extract token from path prefix `/t/{token}` or `/t/{token}/…`.
pub fn extract_token_from_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/t/")?;
    if rest.is_empty() {
        return None;
    }
    let token = rest.split('/').next().unwrap_or("");
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Path under the token prefix (no leading slash). Empty for `/t/{token}` or `/t/{token}/`.
pub fn path_after_token(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/t/")?;
    let mut parts = rest.splitn(2, '/');
    let _token = parts.next()?;
    let after = parts.next().unwrap_or("");
    Some(after.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_token_is_long_url_safe() {
        let t = generate_token();
        assert!(t.len() >= 32, "token len {}", t.len());
        assert!(!t.contains('+') && !t.contains('/') && !t.contains('='));
    }

    #[test]
    fn tokens_equal_rejects_mismatch() {
        assert!(tokens_equal("abc", "abc"));
        assert!(!tokens_equal("abc", "abd"));
        assert!(!tokens_equal("abc", "ab"));
    }

    #[test]
    fn extract_token_from_path_works() {
        assert_eq!(
            extract_token_from_path("/t/secret/api/health").as_deref(),
            Some("secret")
        );
        assert_eq!(extract_token_from_path("/t/secret/").as_deref(), Some("secret"));
        assert_eq!(extract_token_from_path("/t/secret").as_deref(), Some("secret"));
        assert_eq!(extract_token_from_path("/nope"), None);
        assert_eq!(path_after_token("/t/secret/api/health").as_deref(), Some("api/health"));
        assert_eq!(path_after_token("/t/secret/").as_deref(), Some(""));
        assert_eq!(path_after_token("/t/secret").as_deref(), Some(""));
    }
}
