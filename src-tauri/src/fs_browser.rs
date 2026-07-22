//! Project-scoped filesystem browser for the right-pane resource viewer.
//! All paths are resolved under an explicit project root (no escape).

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::Serialize;

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB text preview
const MAX_BINARY_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB image / pdf
/// Office packages streamed to the UI for rich render (docx-preview / xlsx / pdf).
const MAX_OFFICE_STREAM_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub ext: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadResult {
    pub relative_path: String,
    pub name: String,
    /// Absolute filesystem path for stream preview (video/audio/image via asset protocol).
    pub absolute_path: String,
    pub size: u64,
    pub kind: String,
    pub mime: String,
    pub text: Option<String>,
    pub base64: Option<String>,
    /// Prefer streaming the file path instead of embedding base64 (media / large files).
    pub stream: bool,
    pub truncated: bool,
    pub error: Option<String>,
}

fn ok_result(
    path: &Path,
    relative_path: String,
    name: String,
    size: u64,
    kind: String,
    mime: String,
    text: Option<String>,
    base64: Option<String>,
    stream: bool,
    truncated: bool,
    error: Option<String>,
) -> FsReadResult {
    FsReadResult {
        relative_path,
        name,
        absolute_path: path.to_string_lossy().to_string(),
        size,
        kind,
        mime,
        text,
        base64,
        stream,
        truncated,
        error,
    }
}

fn normalize_rel(relative: &str) -> String {
    relative
        .trim()
        .trim_start_matches("./")
        .trim_start_matches('/')
        .trim_start_matches('\\')
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

fn join_rel(parent: &str, name: &str) -> String {
    let p = normalize_rel(parent);
    if p.is_empty() {
        name.to_string()
    } else {
        format!("{p}/{name}")
    }
}

fn lexical_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = normalize_rel(relative);
    let mut out = root.to_path_buf();
    if rel.is_empty() || rel == "." {
        return Ok(out);
    }
    for comp in Path::new(&rel).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("path escapes project root".into());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute path not allowed".into());
            }
        }
    }
    // Ensure still under root (lexical)
    if !out.starts_with(root) {
        return Err("path escapes project root".into());
    }
    Ok(out)
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn guess_kind(ext: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "dir";
    }
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" => "image",
        "pdf" => "pdf",
        "mp4" | "webm" | "mov" | "mkv" => "video",
        "mp3" | "wav" | "ogg" | "m4a" | "flac" | "aac" => "audio",
        "json" | "jsonc" => "json",
        "md" | "mdx" | "markdown" => "markdown",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "csv" | "tsv" => "csv",
        "xml" | "yml" | "yaml" | "toml" | "ini" | "env" | "conf" | "config" => "config",
        // Office Open XML / ODF — extract text for preview
        "docx" | "docm" | "dotx" | "dotm" => "docx",
        "xlsx" | "xlsm" | "xltx" | "xltm" => "xlsx",
        "pptx" | "pptm" | "potx" | "potm" => "pptx",
        "odt" | "ods" | "odp" => "odf",
        "doc" | "xls" | "ppt" => "office_legacy",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "kt" | "swift" | "c" | "cc"
        | "cpp" | "h" | "hpp" | "cs" | "rb" | "php" | "sh" | "bash" | "zsh" | "sql" | "vue"
        | "svelte" | "dart" | "lua" | "r" | "scala" | "zig" | "ex" | "exs" | "clj" | "fs"
        | "fsx" | "gradle" | "dockerfile" | "makefile" | "cmake" | "mdc" | "map" => "code",
        "txt" | "log" | "gitignore" | "gitattributes" | "editorconfig" | "lock" | "license" => {
            "text"
        }
        "zip" | "tar" | "gz" | "tgz" | "bz2" | "7z" | "rar" | "xz" => "archive",
        "woff" | "woff2" | "ttf" | "otf" | "eot" => "font",
        _ => "text",
    }
}

fn mime_of(ext: &str, kind: &str) -> String {
    match (kind, ext) {
        ("image", "png") => "image/png".into(),
        ("image", "jpg" | "jpeg") => "image/jpeg".into(),
        ("image", "gif") => "image/gif".into(),
        ("image", "webp") => "image/webp".into(),
        ("image", "svg") => "image/svg+xml".into(),
        ("image", "bmp") => "image/bmp".into(),
        ("image", "ico") => "image/x-icon".into(),
        ("image", "avif") => "image/avif".into(),
        ("pdf", _) => "application/pdf".into(),
        ("video", "mp4") => "video/mp4".into(),
        ("video", "webm") => "video/webm".into(),
        ("video", "mov") => "video/quicktime".into(),
        ("audio", "mp3") => "audio/mpeg".into(),
        ("audio", "wav") => "audio/wav".into(),
        ("audio", "ogg") => "audio/ogg".into(),
        ("json", _) => "application/json".into(),
        ("markdown", _) => "text/markdown".into(),
        ("html", _) => "text/html".into(),
        ("css", _) => "text/css".into(),
        ("csv", "tsv") => "text/tab-separated-values".into(),
        ("csv", _) => "text/csv".into(),
        ("docx", _) => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into()
        }
        ("xlsx", _) => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into()
        }
        ("pptx", _) => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation".into()
        }
        ("odf", "odt") => "application/vnd.oasis.opendocument.text".into(),
        ("odf", "ods") => "application/vnd.oasis.opendocument.spreadsheet".into(),
        ("odf", "odp") => "application/vnd.oasis.opendocument.presentation".into(),
        _ if kind == "code" || kind == "text" || kind == "config" || kind == "office" => {
            "text/plain".into()
        }
        _ => "application/octet-stream".into(),
    }
}

/// Strip XML tags and decode a few common entities for OOXML / ODF preview text.
fn xml_to_plain(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 4);
    let mut in_tag = false;
    let mut chars = xml.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<' {
            in_tag = true;
            // Paragraph / break markers → newline
            let rest: String = chars.clone().take(12).collect();
            let lower = rest.to_ascii_lowercase();
            if lower.starts_with("w:p ")
                || lower.starts_with("w:p>")
                || lower.starts_with("/w:p>")
                || lower.starts_with("w:br")
                || lower.starts_with("w:cr")
                || lower.starts_with("text:p")
                || lower.starts_with("/text:p")
                || lower.starts_with("a:p ")
                || lower.starts_with("a:p>")
                || lower.starts_with("/a:p")
            {
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            continue;
        }
        if c == '>' {
            in_tag = false;
            continue;
        }
        if in_tag {
            continue;
        }
        if c == '&' {
            let ent: String = chars.clone().take(8).collect();
            if let Some(decoded) = decode_entity(&ent) {
                out.push_str(decoded.0);
                for _ in 0..decoded.1 {
                    chars.next();
                }
                continue;
            }
        }
        out.push(c);
    }
    // collapse 3+ newlines
    let mut cleaned = String::new();
    let mut nl = 0;
    for c in out.chars() {
        if c == '\n' {
            nl += 1;
            if nl <= 2 {
                cleaned.push(c);
            }
        } else if c == '\r' {
            continue;
        } else {
            nl = 0;
            cleaned.push(c);
        }
    }
    cleaned.trim().to_string()
}

fn decode_entity(s: &str) -> Option<(&'static str, usize)> {
    if s.starts_with("amp;") {
        Some(("&", 4))
    } else if s.starts_with("lt;") {
        Some(("<", 3))
    } else if s.starts_with("gt;") {
        Some((">", 3))
    } else if s.starts_with("quot;") {
        Some(("\"", 5))
    } else if s.starts_with("apos;") {
        Some(("'", 5))
    } else if s.starts_with("nbsp;") {
        Some((" ", 5))
    } else {
        None
    }
}

fn read_zip_entry_text(path: &Path, entry_name: &str) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|e| format!("zip entry {entry_name}: {e}"))?;
    let mut buf = String::new();
    entry
        .read_to_string(&mut buf)
        .map_err(|e| format!("read zip entry: {e}"))?;
    Ok(buf)
}

fn read_zip_entries_matching(path: &Path, prefix: &str, suffix: &str) -> Result<Vec<String>, String> {
    let file = fs::File::open(path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
    let mut names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("zip index: {e}"))?;
        let name = entry.name().to_string();
        if name.starts_with(prefix) && name.ends_with(suffix) {
            names.push(name);
        }
    }
    names.sort();
    let mut texts = Vec::new();
    for name in names {
        let mut entry = archive
            .by_name(&name)
            .map_err(|e| format!("zip entry {name}: {e}"))?;
        let mut buf = String::new();
        if entry.read_to_string(&mut buf).is_ok() {
            texts.push(buf);
        }
    }
    Ok(texts)
}

/// Extract plain text from Office Open XML / ODF packages.
fn extract_office_text(path: &Path, kind: &str) -> Result<String, String> {
    match kind {
        "docx" => {
            let xml = read_zip_entry_text(path, "word/document.xml")?;
            let text = xml_to_plain(&xml);
            if text.is_empty() {
                Err("docx has no extractable text".into())
            } else {
                Ok(text)
            }
        }
        "xlsx" => {
            // shared strings + all sheet xml
            let mut parts = Vec::new();
            if let Ok(ss) = read_zip_entry_text(path, "xl/sharedStrings.xml") {
                let t = xml_to_plain(&ss);
                if !t.is_empty() {
                    parts.push(t);
                }
            }
            let sheets = read_zip_entries_matching(path, "xl/worksheets/", ".xml")?;
            for (i, xml) in sheets.into_iter().enumerate() {
                let t = xml_to_plain(&xml);
                if !t.is_empty() {
                    parts.push(format!("--- Sheet {} ---\n{t}", i + 1));
                }
            }
            if parts.is_empty() {
                Err("xlsx has no extractable text".into())
            } else {
                Ok(parts.join("\n\n"))
            }
        }
        "pptx" => {
            let slides = read_zip_entries_matching(path, "ppt/slides/slide", ".xml")?;
            let mut parts = Vec::new();
            for (i, xml) in slides.into_iter().enumerate() {
                let t = xml_to_plain(&xml);
                if !t.is_empty() {
                    parts.push(format!("--- Slide {} ---\n{t}", i + 1));
                }
            }
            if parts.is_empty() {
                Err("pptx has no extractable text".into())
            } else {
                Ok(parts.join("\n\n"))
            }
        }
        "odf" => {
            let xml = read_zip_entry_text(path, "content.xml")?;
            let text = xml_to_plain(&xml);
            if text.is_empty() {
                Err("odf has no extractable text".into())
            } else {
                Ok(text)
            }
        }
        _ => Err("unsupported office format".into()),
    }
}

pub fn list_dir(project_root: &str, relative: &str) -> Result<Vec<FsEntry>, String> {
    let root = PathBuf::from(project_root);
    if !root.is_dir() {
        return Err(format!("project root is not a directory: {project_root}"));
    }
    let parent_rel = normalize_rel(relative);
    let dir = lexical_join(&root, &parent_rel)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {parent_rel}"));
    }
    let mut entries = Vec::new();
    let rd = fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        // Always hide VCS / macOS noise (never list .git directory or contents entry).
        if name == ".DS_Store" || name == ".git" || name == "Thumbs.db" {
            continue;
        }
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        // Always build relative path from parent + name (never absolute)
        let rel = join_rel(&parent_rel, &name);
        entries.push(FsEntry {
            name: name.clone(),
            relative_path: rel,
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            ext: if is_dir { String::new() } else { ext_of(&name) },
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

pub fn read_file(project_root: &str, relative: &str) -> Result<FsReadResult, String> {
    let root = PathBuf::from(project_root);
    if !root.is_dir() {
        return Err(format!("project root is not a directory: {project_root}"));
    }
    let rel_in = normalize_rel(relative);
    if rel_in.is_empty() {
        return Err("empty relative path".into());
    }
    let path = lexical_join(&root, &rel_in)?;
    if !path.is_file() {
        return Err(format!("not a file: {rel_in}"));
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| rel_in.clone());
    let meta = fs::metadata(&path).map_err(|e| format!("stat: {e}"))?;
    let size = meta.len();
    let ext = ext_of(&name);
    let mut kind = guess_kind(&ext, false).to_string();
    let mime = mime_of(&ext, &kind);

    // Office OOXML: stream path to frontend rich preview (docx-preview / SheetJS).
    // Keep original kind (docx|xlsx|pptx) so the UI can pick the right renderer.
    if matches!(kind.as_str(), "docx" | "xlsx" | "pptx" | "odf") {
        if size > MAX_OFFICE_STREAM_BYTES {
            return Ok(ok_result(
                &path,
                rel_in,
                name,
                size,
                kind,
                mime,
                None,
                None,
                true,
                true,
                Some(format!(
                    "file too large for in-app office preview (>{MAX_OFFICE_STREAM_BYTES} bytes)"
                )),
            ));
        }
        // Optional plain-text fallback for tiny extract failures in UI
        let text_fallback = extract_office_text(&path, &kind).ok().map(|t| {
            if t.len() as u64 > MAX_TEXT_BYTES {
                t.chars().take(MAX_TEXT_BYTES as usize).collect()
            } else {
                t
            }
        });
        return Ok(ok_result(
            &path,
            rel_in,
            name,
            size,
            kind,
            mime,
            text_fallback,
            None,
            true, // stream → frontend fetches binary via asset/media URL
            false,
            None,
        ));
    }

    if kind == "office_legacy" {
        return Ok(ok_result(
            &path,
            rel_in,
            name,
            size,
            "binary".into(),
            mime,
            None,
            None,
            false,
            false,
            Some(
                "legacy .doc/.xls/.ppt is not supported — save as .docx/.xlsx/.pptx to preview"
                    .into(),
            ),
        ));
    }

    // Video / audio — always stream via absolute path (no base64; supports multi‑GB files)
    if matches!(kind.as_str(), "video" | "audio") {
        return Ok(ok_result(
            &path,
            rel_in,
            name,
            size,
            kind,
            mime,
            None,
            None,
            true,
            false,
            None,
        ));
    }

    // Image / PDF — stream path for large files; small images may embed as base64
    if matches!(kind.as_str(), "image" | "pdf") {
        if ext == "svg" && size <= MAX_TEXT_BYTES {
            let text = fs::read_to_string(&path).unwrap_or_default();
            return Ok(ok_result(
                &path,
                rel_in,
                name,
                size,
                "image".into(),
                mime,
                Some(text),
                None,
                false,
                false,
                None,
            ));
        }
        // Prefer stream for anything over 2 MiB (webview loads via asset protocol)
        if size > 2 * 1024 * 1024 {
            return Ok(ok_result(
                &path,
                rel_in,
                name,
                size,
                kind,
                mime,
                None,
                None,
                true,
                false,
                None,
            ));
        }
        let bytes = fs::read(&path).map_err(|e| format!("read: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(ok_result(
            &path,
            rel_in,
            name,
            size,
            kind,
            mime,
            None,
            Some(b64),
            false,
            false,
            None,
        ));
    }

    if matches!(kind.as_str(), "font" | "archive") {
        return Ok(ok_result(
            &path,
            rel_in,
            name,
            size,
            kind,
            mime,
            None,
            None,
            false,
            false,
            Some("no inline preview for this format".into()),
        ));
    }

    // Text-like (incl. unknown → try as text)
    let truncated = size > MAX_TEXT_BYTES;
    let bytes = if truncated {
        let mut f = fs::File::open(&path).map_err(|e| format!("open: {e}"))?;
        let mut buf = vec![0u8; MAX_TEXT_BYTES as usize];
        let n = f.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        buf.truncate(n);
        buf
    } else {
        fs::read(&path).map_err(|e| format!("read: {e}"))?
    };

    let nulls = bytes.iter().filter(|b| **b == 0).count();
    if !bytes.is_empty() && nulls > bytes.len() / 50 {
        kind = "binary".into();
        return Ok(ok_result(
            &path,
            rel_in,
            name,
            size,
            kind,
            "application/octet-stream".into(),
            None,
            None,
            false,
            false,
            Some("binary file (no text preview)".into()),
        ));
    }

    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(ok_result(
        &path,
        rel_in,
        name,
        size,
        kind,
        mime,
        Some(text),
        None,
        false,
        truncated,
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_escape() {
        let dir = tempfile_dir();
        let err = list_dir(dir.to_str().unwrap(), "../").unwrap_err();
        assert!(
            err.contains("escape") || err.contains("not a directory") || err.contains("resolve"),
            "{err}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_and_reads() {
        let dir = tempfile_dir();
        let f = dir.join("hello.md");
        let mut file = fs::File::create(&f).unwrap();
        writeln!(file, "# hi").unwrap();
        let entries = list_dir(dir.to_str().unwrap(), "").unwrap();
        assert!(entries.iter().any(|e| e.name == "hello.md"));
        assert!(entries.iter().any(|e| e.relative_path == "hello.md"));
        let r = read_file(dir.to_str().unwrap(), "hello.md").unwrap();
        assert_eq!(r.kind, "markdown");
        assert!(r.text.unwrap().contains("# hi"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_relative_paths() {
        let dir = tempfile_dir();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/a.ts"), "export const x = 1;\n").unwrap();
        let entries = list_dir(dir.to_str().unwrap(), "src").unwrap();
        assert_eq!(entries[0].relative_path, "src/a.ts");
        let r = read_file(dir.to_str().unwrap(), "src/a.ts").unwrap();
        assert_eq!(r.kind, "code");
        assert!(r.text.unwrap().contains("export"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hides_git_directory() {
        let dir = tempfile_dir();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/config"), "x").unwrap();
        fs::write(dir.join("readme.md"), "# hi").unwrap();
        let entries = list_dir(dir.to_str().unwrap(), "").unwrap();
        assert!(
            entries.iter().all(|e| e.name != ".git"),
            "entries: {:?}",
            entries.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert!(entries.iter().any(|e| e.name == "readme.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn xml_to_plain_strips_tags() {
        let xml = r#"<w:document><w:p><w:t>小猪去买菜</w:t></w:p><w:p><w:t>第二段</w:t></w:p></w:document>"#;
        let t = xml_to_plain(xml);
        assert!(t.contains("小猪去买菜"), "{t}");
        assert!(t.contains("第二段"), "{t}");
    }

    #[test]
    fn reads_minimal_docx() {
        let dir = tempfile_dir();
        let docx = dir.join("sample.docx");
        write_minimal_docx(&docx, "Hello DOCX preview");
        let r = read_file(dir.to_str().unwrap(), "sample.docx").unwrap();
        assert_eq!(r.kind, "office");
        assert!(
            r.text.as_ref().unwrap().contains("Hello DOCX preview"),
            "{:?}",
            r.text
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_minimal_docx(path: &Path, body: &str) {
        use std::io::Write;
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("[Content_Types].xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>"#,
        )
        .unwrap();
        zip.start_file("word/document.xml", opts).unwrap();
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>{body}</w:t></w:r></w:p></w:body>
</w:document>"#
        );
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    fn tempfile_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("grok-fs-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }
}
