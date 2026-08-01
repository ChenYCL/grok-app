//! Media path extract tests.
#![cfg(test)]

use super::*;

use serde_json::json;

#[test]
fn extracts_backtick_path_from_mcp_okay_output() {
    let raw = json!({
        "status": "completed",
        "rawOutput": {
            "type": "MCP",
            "tool_name": "image_edit",
            "server_name": "official-aux",
            "output": {
                "OkayOutput": "已完成 image_edit。\n\n**输出文件路径：**\n\n`/tmp/demo/images/1.jpg`\n\n（会话内相对路径：images/1.jpg）"
            }
        }
    });
    assert_eq!(
        extract_generated_media_path(&raw).as_deref(),
        Some("/tmp/demo/images/1.jpg")
    );
}

#[test]
fn extracts_path_from_content_text_markdown() {
    let raw = json!({
        "content": [{
            "type": "content",
            "content": {
                "type": "text",
                "text": "saved to /Users/me/out/pixel.png for you"
            }
        }]
    });
    assert_eq!(
        extract_generated_media_path(&raw).as_deref(),
        Some("/Users/me/out/pixel.png")
    );
}

