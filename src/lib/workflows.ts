/**
 * Grok Build workflows — pure helpers (enable config + discovery).
 *
 * Workflows are deterministic Rhai scripts that orchestrate subagents via the
 * CLI `workflow` tool. Files live under:
 * - User: `~/.grok/workflows/<name>.rhai`
 * - Project: `<repo>/.grok/workflows/<name>.rhai`
 *
 * App surfaces:
 * - `workflows_enabled` AppSettings → independent agent-home `config.toml`
 * - Read-only name discovery (no in-app runner / editor)
 *
 * Docs honesty: author via `/create-workflow` skill; run via CLI `/workflow`
 * or the `workflow` tool — App does not invent a fake GUI runner.
 */

/** Top-level config.toml key. */
export const WORKFLOWS_ENABLED_CONFIG_KEY = "workflows_enabled";

/** Relative dir under GROK home / project `.grok`. */
export const WORKFLOWS_DIR_NAME = "workflows";

/** Bundled skill that documents authoring (relative under `~/.grok`). */
export const CREATE_WORKFLOW_SKILL_SEGMENTS = [
  "bundled",
  "skills",
  "create-workflow",
  "SKILL.md",
] as const;

export type WorkflowScope = "project" | "user" | "agent_home";

export type WorkflowDefLike = {
  name: string;
  path: string;
  scope: WorkflowScope;
};

/**
 * Normalize the enable toggle.
 * null / undefined → false (App + CLI-aligned opt-in default).
 */
export function normalizeWorkflowsEnabled(
  raw: boolean | null | undefined,
): boolean {
  return raw === true;
}

/** True when two raw toggles normalize equal. */
export function workflowsEnabledEqual(
  a: boolean | null | undefined,
  b: boolean | null | undefined,
): boolean {
  return normalizeWorkflowsEnabled(a) === normalizeWorkflowsEnabled(b);
}

/** `~/.grok` style root from a user home directory. */
export function grokHomeFromUserHome(userHome: string): string {
  const home = (userHome ?? "").trim().replace(/[/\\]+$/g, "");
  if (!home) return ".grok";
  const sep = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  return `${home}${sep}.grok`;
}

function joinPath(...parts: string[]): string {
  const cleaned = parts
    .map((p) => p.replace(/[/\\]+$/g, ""))
    .filter((p, i) => (i === 0 ? p.length > 0 : p.length > 0));
  if (cleaned.length === 0) return "";
  const first = cleaned[0];
  const sep = first.includes("\\") && !first.includes("/") ? "\\" : "/";
  const isAbsUnix = first.startsWith("/");
  const isAbsWin = /^[A-Za-z]:/.test(first);
  const segs: string[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const piece = cleaned[i].replace(/\\/g, "/");
    for (const s of piece.split("/").filter(Boolean)) segs.push(s);
  }
  if (isAbsWin) {
    const drive = cleaned[0].slice(0, 2);
    const afterDrive = segs[0]?.includes(":") ? segs.slice(1) : segs.slice(1);
    return `${drive}\\${afterDrive.join("\\")}`;
  }
  if (isAbsUnix) return `/${segs.join("/")}`;
  return segs.join(sep);
}

/**
 * Absolute directories where workflow `.rhai` files are discovered.
 * `projectPath` is the workbench project root (not GROK_HOME).
 */
export function resolveWorkflowDirs(
  userHome: string,
  projectPath?: string | null,
): {
  user: string;
  project: string | null;
  skillDoc: string;
} {
  const grok = grokHomeFromUserHome(userHome);
  const user = joinPath(grok, WORKFLOWS_DIR_NAME);
  const skillDoc = joinPath(grok, ...CREATE_WORKFLOW_SKILL_SEGMENTS);
  const proj = (projectPath ?? "").trim().replace(/[/\\]+$/g, "");
  const project = proj
    ? joinPath(proj, ".grok", WORKFLOWS_DIR_NAME)
    : null;
  return { user, project, skillDoc };
}

const RHAI_RE = /\.rhai$/i;

/**
 * Definition name = file stem (`review-changes.rhai` → `review-changes`).
 * Rejects empty, dotfiles, README.
 */
export function workflowNameFromFileName(
  fileName: string | null | undefined,
): string | null {
  const base = (fileName ?? "").trim().replace(/^.*[/\\]/, "");
  if (!base || base.startsWith(".")) return null;
  if (!RHAI_RE.test(base)) return null;
  const stem = base.replace(RHAI_RE, "").trim();
  if (!stem || stem.toLowerCase() === "readme") return null;
  return stem;
}

/** True when a file name is a Grok workflow script. */
export function isWorkflowDefinitionFileName(
  fileName: string | null | undefined,
): boolean {
  return workflowNameFromFileName(fileName) != null;
}

/** Collect workflow names from bare file basenames in a directory listing. */
export function workflowNamesFromFileList(fileNames: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of fileNames) {
    const name = workflowNameFromFileName(f);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return out;
}

function scopeRank(scope: WorkflowScope): number {
  switch (scope) {
    case "project":
      return 0;
    case "user":
      return 1;
    case "agent_home":
      return 2;
    default:
      return 9;
  }
}

/**
 * Merge project + user (+ optional agent-home) workflow file lists into
 * de-duplicated defs. Same name: project > user > agent_home.
 */
export function collectWorkflowDefs(input: {
  userFiles?: string[];
  projectFiles?: string[];
  agentHomeFiles?: string[];
  userDir?: string;
  projectDir?: string | null;
  agentHomeDir?: string | null;
}): WorkflowDefLike[] {
  const rows: WorkflowDefLike[] = [];
  const push = (
    files: string[] | undefined,
    scope: WorkflowScope,
    dir: string | null | undefined,
  ) => {
    if (!files?.length) return;
    const base = (dir ?? "").replace(/[/\\]+$/g, "");
    for (const f of files) {
      const name = workflowNameFromFileName(f);
      if (!name) continue;
      const fileBase = f.replace(/^.*[/\\]/, "");
      const path = base
        ? `${base}${base.includes("\\") ? "\\" : "/"}${fileBase}`
        : fileBase;
      rows.push({ name, path, scope });
    }
  };
  push(input.projectFiles, "project", input.projectDir);
  push(input.userFiles, "user", input.userDir);
  push(input.agentHomeFiles, "agent_home", input.agentHomeDir);

  rows.sort((a, b) => {
    const r = scopeRank(a.scope) - scopeRank(b.scope);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const seen = new Set<string>();
  const out: WorkflowDefLike[] = [];
  for (const w of rows) {
    const key = w.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** Short meta line for list UI. */
export function workflowMetaLine(
  w: Pick<WorkflowDefLike, "name" | "scope">,
  labels?: Partial<Record<WorkflowScope, string>>,
): string {
  const scopeLabel =
    labels?.[w.scope] ??
    (w.scope === "project"
      ? "project"
      : w.scope === "agent_home"
        ? "agent-home"
        : "user");
  return `${w.name} · ${scopeLabel}`;
}

/** Format a short discovered-names summary (empty → null for honesty empty state). */
export function formatDiscoveredWorkflowNames(
  workflows: ReadonlyArray<Pick<WorkflowDefLike, "name">>,
  max = 12,
): string | null {
  if (!workflows.length) return null;
  const names = workflows.map((w) => w.name);
  if (names.length <= max) return names.join(", ");
  const head = names.slice(0, max).join(", ");
  return `${head} (+${names.length - max})`;
}
