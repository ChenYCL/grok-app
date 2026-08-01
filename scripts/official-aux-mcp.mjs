#!/usr/bin/env node
/**
 * Official-aux MCP server (stdio JSON-RPC).
 *
 * Runs isolated `grok -p -m grok-4.5` under OFFICIAL_AUX_HOME (official auth),
 * exposing web_search + all x_* tools for sessions whose main model is a
 * text-only custom relay (DeepSeek, etc.).
 *
 * Env (injected by Grok App):
 *   OFFICIAL_AUX_HOME  — GROK_HOME for side-channel (agent-home-official)
 *   OFFICIAL_AUX_MODEL — default grok-4.5
 *   OFFICIAL_AUX_CLI   — path to grok binary
 *   GROK_HOME          — same as OFFICIAL_AUX_HOME
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

const HOME = process.env.OFFICIAL_AUX_HOME || process.env.GROK_HOME || "";
const MODEL = process.env.OFFICIAL_AUX_MODEL || "grok-4.5";
const CLI = process.env.OFFICIAL_AUX_CLI || "grok";

const TOOLS = [
  {
    name: "web_search",
    description:
      "Web search / 网页搜索 / 联网搜索 using official Grok credentials (isolated). " +
      "PRIMARY tool for general internet queries when the main model has no built-in web_search. " +
      "Keywords: google, bing, 搜索网页, 查资料, news, 新闻.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (any language)" },
      },
      required: ["query"],
    },
  },
  {
    name: "x_keyword_search",
    description:
      "PRIMARY tool for X/Twitter post search. " +
      "Search X (Twitter) tweets/posts with keywords or advanced operators (lang:zh, from:user, since:YYYY-MM-DD). " +
      "Use this when the user asks to search X / Twitter / 推特 / 推文 / x上 / 在x上 / x.com posts. " +
      "Aliases: twitter search, 推特搜索, X搜索, 搜推文, x_keyword_search. " +
      "Prefer this over Playwright, open-websearch, or curl for X content.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword query, e.g. 飞书 lang:zh or Feishu OR Lark",
        },
        limit: { type: "number", description: "Max posts (tool caps ~10 per call)" },
        min_faves: { type: "number", description: "Optional minimum likes filter" },
      },
      required: ["query"],
    },
  },
  {
    name: "x_semantic_search",
    description:
      "Semantic / meaning-based search on X (Twitter) posts. " +
      "Use for topical research when keywords are fuzzy (e.g. 飞书最新动态, product launch discussion). " +
      "Keywords: semantic twitter, 语义搜索推特, X话题. Prefer x_keyword_search for exact terms.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language topic query" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "x_user_search",
    description:
      "Search X (Twitter) users/accounts by name or handle. " +
      "Use when the user wants a profile, 账号, @handle, or who someone is on X. " +
      "Keywords: twitter user, 搜用户, 推特账号, x_user_search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Display name or @handle without @" },
        count: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "x_thread_fetch",
    description:
      "Fetch a full X (Twitter) post thread by status id or https://x.com/.../status/... URL. " +
      "Keywords: thread, 串文, 推文详情, x_thread_fetch.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string", description: "Status id or status URL" },
        url: { type: "string", description: "Optional x.com status URL" },
      },
    },
  },
  {
    name: "vision_describe",
    description:
      "Describe local image files with official Grok vision. " +
      "Skip if the prompt already has [Host vision] or <image_description>. " +
      "Keywords: 识图, describe image, vision, 看图.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute image path" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Multiple absolute image paths",
        },
        question: { type: "string" },
      },
    },
  },
];

function buildPrompt(name, args) {
  const a = args || {};
  switch (name) {
    case "web_search": {
      const q = String(a.query || a.q || "").trim();
      return `You are an isolated research side-job with official Grok credentials.

Use the built-in **web_search** tool (and web_fetch if needed) for:
${q}

Rules:
1. You MUST call web_search at least once.
2. Prefer primary sources; include URLs.
3. Reply in the same language as the query.
4. Do not edit files.
5. Final answer: concise markdown findings + link list.`;
    }
    case "x_keyword_search": {
      const q = String(a.query || a.q || "").trim();
      const limit = Math.min(25, Math.max(1, Number(a.limit) || 10));
      const faves =
        a.min_faves != null || a.minFaves != null
          ? `min_faves: ${a.min_faves ?? a.minFaves}`
          : "";
      return `You are an isolated X research side-job with official Grok credentials.

Call **x_keyword_search** with query: ${q}, limit: ${limit}. ${faves}
Fallback: x_semantic_search if needed.

Return markdown with real https://x.com/…/status/… URLs. No file edits.`;
    }
    case "x_semantic_search": {
      const q = String(a.query || a.q || "").trim();
      const limit = Math.min(25, Math.max(1, Number(a.limit) || 10));
      return `You are an isolated X research side-job with official Grok credentials.

Call **x_semantic_search** with query: ${q}, limit: ${limit}.
Fallback: x_keyword_search.

Return markdown with x.com status URLs. No file edits.`;
    }
    case "x_user_search": {
      const q = String(a.query || a.q || "").trim();
      const count = Math.min(20, Math.max(1, Number(a.count) || 5));
      return `You are an isolated X research side-job with official Grok credentials.

Call **x_user_search** with query: ${q}, count: ${count}.

Return markdown: handle, name, bio, profile url. No file edits.`;
    }
    case "x_thread_fetch": {
      const id = String(a.post_id || a.postId || a.url || a.id || "").trim();
      return `You are an isolated X research side-job with official Grok credentials.

Call **x_thread_fetch** for: ${id}

Return thread as markdown with status URLs. No file edits.`;
    }
    case "vision_describe": {
      const paths = Array.isArray(a.paths)
        ? a.paths.map(String)
        : a.path
          ? [String(a.path)]
          : [];
      const q =
        String(a.question || "").trim() ||
        "Describe each image thoroughly for a coding agent.";
      const refs = paths.map((p) => `@${p}`).join("\n");
      return `${q}

Images (native vision):
${refs}

One <image_description path="…"> block per image. Do not refuse.`;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function runGrok(prompt) {
  return new Promise((resolve, reject) => {
    if (!HOME) {
      reject(new Error("OFFICIAL_AUX_HOME / GROK_HOME not set"));
      return;
    }
    const args = [
      "--no-auto-update",
      "-p",
      prompt,
      "-m",
      MODEL,
      "--always-approve",
      "--max-turns",
      "12",
      "--effort",
      "low",
      "--output-format",
      "plain",
    ];
    const child = spawn(CLI, args, {
      env: {
        ...process.env,
        GROK_HOME: HOME,
        OFFICIAL_AUX_HOME: HOME,
        GROK_WEB_SEARCH_MODEL: MODEL,
        GROK_IMAGE_DESCRIPTION_MODEL: MODEL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`official aux timeout (180s): ${stderr.slice(0, 300)}`));
    }, 180_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          `official aux exit ${code}: ${(stderr || "no output").slice(0, 500)}`,
        ),
      );
    });
  });
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function okResult(id, text) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: String(text) }],
      isError: false,
    },
  });
}

function errResult(id, message) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: String(message) }],
      isError: true,
    },
  });
}

async function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "official-aux", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const prompt = buildPrompt(name, args);
      const text = await runGrok(prompt);
      okResult(id, text);
    } catch (e) {
      errResult(id, e?.message || String(e));
    }
    return;
  }

  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  // Ignore unknown notifications; error on requests with id.
  if (id !== undefined && id !== null) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  try {
    void handle(JSON.parse(t));
  } catch (e) {
    // ignore malformed
  }
});
