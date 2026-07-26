/**
 * Session-scoped plan chrome (top bar + resource Plan panel).
 *
 * Lifecycle (per session id):
 * 1. Idle — no plan UI (`visible: false`, empty body/entries).
 * 2. Live — `session://plan` events fill body/entries; bar shows progress/review.
 * 3. Soft UI actions (approve / request changes) hide review gate but may keep steps.
 * 4. User dismiss (with confirm) — **hard close**: clear chrome, set `userClosed`.
 *    Reopening the session restores the closed state (no bar / no panel body).
 * 5. New plan cycle only un-closes: a **new** plan `toolCallId`, or a **new**
 *    `exit_plan_mode` `rpcId` (not the one abandoned on dismiss).
 *    Residual updates while still in composer plan mode must NOT resurrect
 *    the dismissed cycle.
 */

export type SessionPlanState = {
  title: string;
  body: string;
  entries: unknown[];
  waiting: boolean;
  visible: boolean;
  rpcId: number | null;
  toolCallId: string | null;
  /**
   * Soft-hide top bar only (legacy). Hard dismiss clears content instead;
   * kept for approve/progress transitions that hide without abandoning history.
   */
  barDismissed: boolean;
  /**
   * User confirmed dismiss for this plan cycle. Suppresses further plan events
   * until a new cycle is detected.
   */
  userClosed: boolean;
  /** toolCallId at hard-dismiss time — same id = same cycle, keep suppressed. */
  closedToolCallId: string | null;
  /**
   * exit_plan_mode rpcId abandoned on hard-dismiss. Same id must not re-open
   * the review panel after the user confirmed close.
   */
  closedRpcId: number | null;
};

export type PlanEventPayload = {
  entries?: unknown[];
  body?: string | null;
  rpcId?: number | null;
  toolCallId?: string | null;
  waiting?: boolean;
};

export function emptySessionPlan(
  title = "Plan ready for review",
): SessionPlanState {
  return {
    title,
    body: "",
    entries: [],
    waiting: true,
    visible: false,
    rpcId: null,
    toolCallId: null,
    barDismissed: false,
    userClosed: false,
    closedToolCallId: null,
    closedRpcId: null,
  };
}

/** Hard-closed empty plan for a session after user confirms dismiss. */
export function closedSessionPlan(
  title = "Plan ready for review",
  closedToolCallId: string | null = null,
  closedRpcId: number | null = null,
): SessionPlanState {
  return {
    ...emptySessionPlan(title),
    userClosed: true,
    closedToolCallId,
    closedRpcId,
    barDismissed: true,
  };
}

function normalizeToolCallId(
  toolCallId: string | null | undefined,
): string | null {
  if (toolCallId == null) return null;
  const t = String(toolCallId).trim();
  return t || null;
}

/**
 * Whether a plan event should reopen UI after the user hard-closed this cycle.
 *
 * Important: merely remaining in composer `plan` mode is NOT enough to reopen.
 * Residual `session://plan` updates from the dismissed cycle (same toolCallId,
 * no new rpcId) would otherwise resurrect the bar + resource Plan panel.
 */
export function shouldReopenClosedPlan(
  prev: SessionPlanState,
  p: PlanEventPayload,
  _composerMode: string,
): boolean {
  if (!prev.userClosed) return true;

  // New exit_plan_mode gate (must surface for approve/revise) — but not the
  // same rpc the user just abandoned on dismiss.
  if (p.rpcId != null && p.rpcId !== prev.closedRpcId) return true;

  // New plan tool invocation (different toolCallId than the one we closed).
  const tid = normalizeToolCallId(p.toolCallId ?? null);
  if (tid && tid !== prev.closedToolCallId) return true;

  return false;
}

function formatEntriesAsBody(entries: unknown[]): string {
  return entries
    .map((e, i) => {
      if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        const content = String(o.content ?? o.title ?? o.text ?? "");
        const st = o.status ? ` [${o.status}]` : "";
        const pr = o.priority ? ` (${o.priority})` : "";
        return `${i + 1}. ${content}${pr}${st}`;
      }
      return `${i + 1}. ${String(e)}`;
    })
    .join("\n");
}

/**
 * Merge a `session://plan` payload into previous session plan state.
 * Honors hard-dismiss suppression until a new plan cycle.
 */
export function mergePlanFromEvent(
  prev: SessionPlanState,
  p: PlanEventPayload,
  readyTitle: string,
  composerMode = "agent",
): SessionPlanState {
  if (prev.userClosed && !shouldReopenClosedPlan(prev, p, composerMode)) {
    return prev;
  }

  const body = (p.body || "").trim();
  const entries = Array.isArray(p.entries) ? p.entries : [];
  let displayBody = body;
  if (!displayBody && entries.length) {
    displayBody = formatEntriesAsBody(entries);
  }

  // Preserve exit_plan_mode rpcId across later sessionUpdate plan
  // notifications (those arrive with rpcId=null and would otherwise
  // disable Approve / Request changes — see #17).
  // After hard-close, do not inherit a stale rpcId from prev.
  const rpcId =
    p.rpcId != null
      ? p.rpcId
      : prev.userClosed
        ? null
        : prev.visible
          ? (prev.rpcId ?? null)
          : null;

  const toolCallId =
    p.toolCallId != null
      ? String(p.toolCallId)
      : prev.userClosed
        ? null
        : prev.visible
          ? (prev.toolCallId ?? null)
          : null;

  return {
    title: readyTitle,
    body: displayBody || (prev.visible && !prev.userClosed ? prev.body : ""),
    entries:
      entries.length > 0
        ? entries
        : prev.visible && !prev.userClosed
          ? prev.entries
          : [],
    waiting: rpcId == null,
    visible: true,
    rpcId,
    toolCallId,
    barDismissed: false,
    userClosed: false,
    closedToolCallId: null,
    closedRpcId: null,
  };
}
