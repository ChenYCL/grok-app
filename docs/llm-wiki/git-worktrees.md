# Git worktrees

Community request: [issue #42](https://github.com/RongleCat/grok-app/issues/42).

## Behavior

When the active project path is a git work tree, the composer **project chip** menu lists linked worktrees from:

```bash
git worktree list --porcelain
```

- Selecting a worktree binds the open session (or draft context) to that path as agent **cwd**.
- If the path is already a project, switch only; otherwise `project_add` (trust inherited from the current project when possible).
- Soft-fail when `git` is missing or the folder is not a repo (same spirit as Workspace Changes git status).
- **UI:** section is hidden until host confirms `available: true` (non-git / loading → no “GIT WORKTREES” block). Rows match project list height; branch + badges on one line.

### Create worktree

From the same menu: **New worktree…**

1. User enters a **name** (required) and optional **start point** (branch / tag / commit).
2. Host runs `git worktree add -b <name> <path> [<start_point>]` with argv (no shell).
3. On success: refresh the list, `project_add` with trust inherited from the source project when possible, then bind session cwd to the new path.

**Path layout (sibling of main worktree):**

```text
<main_parent>/<main_basename>-<name>
```

Example: main `/Users/me/repo` + name `feat` → `/Users/me/repo-feat`.

| Choice | Why |
|--------|-----|
| **Sibling** `../<repo>-<name>` (preferred) | Matches common `git worktree add ../repo-feat` practice; checkouts sit next to the primary clone; same pattern as porcelain list samples. |
| In-repo `.worktrees/<name>` | Avoided for create — keeps build/tooling ignore noise out of the main tree and matches sibling-first docs. |

Name rules: letters, digits, `.` `_` `-` only; max 64; no path separators; must not start with `-` (so it cannot look like a git flag).

Errors when the folder is not a git repository, `git` is missing, the path already exists, or `git worktree add` fails (message surfaced in the dialog).

## Non-goals (MVP)

- Removing / pruning worktrees from the App
- Full branch browser / remote fetch UI

## Implementation

- Host: `git_worktrees_list`, `git_worktree_add` (`src-tauri/src/commands.rs`)
- Pure path / name helpers: `sanitize_worktree_name`, `build_worktree_sibling_path` (+ unit tests)
- Frontend pure helpers: `src/lib/gitWorktree.ts` (+ unit tests)
- UI: `ComposerProjectMenu` worktrees section + create dialog in `App.tsx`
