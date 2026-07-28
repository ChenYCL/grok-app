/** Build a markdown export for a whole chat session. */

export type ExportableMessage = {
  role: "user" | "assistant" | "tool" | string;
  content: string;
  thought?: string;
  createdAt?: string;
  /** Journal markers: tool_step, context_compact, turn_cancelled, … */
  marker?: string;
};

export type SessionExportOptions = {
  /** Include assistant thinking in collapsed `<details>` (default true). */
  includeThoughts?: boolean;
  /**
   * Include tool_step / tool rows as a short summary list (default true).
   * When false, tool shells are omitted entirely.
   */
  includeToolSummary?: boolean;
};

export type SessionExportInput = {
  title: string;
  projectName?: string | null;
  projectPath?: string | null;
  sessionId?: string | null;
  exportedAt?: string;
  messages: ExportableMessage[];
  options?: SessionExportOptions;
};

function roleHeading(role: string): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "Tool";
  return role;
}

/** Parse `tool_step|name|status|…` or free-form tool content into one line. */
export function formatToolSummaryLine(content: string, marker?: string): string | null {
  const raw = (content || "").trim();
  if (!raw && !marker) return null;

  if (marker === "context_compact" || raw.startsWith("context_compact")) {
    return "Context compact";
  }
  if (marker === "turn_cancelled" || raw === "turn_cancelled") {
    return "Turn cancelled";
  }

  if (marker === "tool_step" || raw.startsWith("tool_step|") || raw.startsWith("tool_step")) {
    const body = raw.startsWith("tool_step|")
      ? raw.slice("tool_step|".length)
      : raw.replace(/^tool_step\s*/i, "");
    const parts = body.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return "Tool step";
    const name = parts[0] || "tool";
    const status = parts[1] || "";
    if (status) return `${name} (${status})`;
    return name;
  }

  // Generic tool row — single line, truncated.
  const one = raw.replace(/\s+/g, " ").slice(0, 160);
  return one || null;
}

function isToolish(m: ExportableMessage): boolean {
  if (m.role === "tool") return true;
  if (m.marker === "tool_step" || m.marker === "context_compact" || m.marker === "turn_cancelled") {
    return true;
  }
  const c = (m.content || "").trim();
  return c.startsWith("tool_step|") || c.startsWith("tool_step");
}

/**
 * Render a session as GitHub-flavored markdown.
 * Skips empty shells; optional thinking + tool summaries.
 */
export function sessionToMarkdown(input: SessionExportInput): string {
  const opts = input.options ?? {};
  const includeThoughts = opts.includeThoughts !== false;
  const includeToolSummary = opts.includeToolSummary !== false;

  const lines: string[] = [];
  const title = (input.title || "Untitled").trim() || "Untitled";
  lines.push(`# ${title}`);
  lines.push("");

  const meta: string[] = [];
  if (input.projectName) meta.push(`Project: ${input.projectName}`);
  if (input.projectPath) meta.push(`Path: ${input.projectPath}`);
  if (input.sessionId) meta.push(`Session: ${input.sessionId}`);
  meta.push(`Exported: ${input.exportedAt || new Date().toISOString()}`);
  lines.push(meta.map((m) => `- ${m}`).join("\n"));
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const m of input.messages) {
    const body = (m.content || "").trim();
    const thought = (m.thought || "").trim();

    if (isToolish(m)) {
      if (!includeToolSummary) continue;
      const line = formatToolSummaryLine(body, m.marker);
      if (!line) continue;
      lines.push(`## Tool`);
      if (m.createdAt) {
        lines.push(`*${m.createdAt}*`);
        lines.push("");
      }
      lines.push(`- ${line}`);
      lines.push("");
      continue;
    }

    if (!body && !thought) continue;

    lines.push(`## ${roleHeading(m.role)}`);
    if (m.createdAt) {
      lines.push(`*${m.createdAt}*`);
      lines.push("");
    }
    if (includeThoughts && thought) {
      lines.push("<details>");
      lines.push("<summary>Thinking</summary>");
      lines.push("");
      lines.push(thought);
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    if (body) {
      lines.push(body);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Safe download filename from a session title. */
export function sessionExportFilename(title: string, sessionId?: string | null): string {
  const base = (title || "session")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const id = (sessionId || "").slice(0, 8);
  const name = base || "session";
  return id ? `grok-${name}-${id}.md` : `grok-${name}.md`;
}
