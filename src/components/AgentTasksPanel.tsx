/**
 * Session agent tasks — active + recent tool steps from the live transcript,
 * plus cross-session busy activity from liveMap.
 *
 * No separate ACP task API; tools via collectSessionTasks / turnActivity.
 * Cross-session rows are UI projections only (jump / stop).
 * Nested tools under spawn_subagent render as an indented tree when parent
 * linkage (explicit or inferred) is available.
 */

import { useMemo, useState } from "react";
import type { MessageKey } from "@/i18n";
import type { ChatMessage } from "@/lib/session";
import {
  buildTaskTree,
  collectSessionTasks,
  countRunningTasks,
  filterSessionTasks,
  filterTaskTree,
  taskStatusMessageKey,
  taskTreeHasNesting,
  taskTreeHasRunning,
  type AgentTask,
  type TaskTreeNode,
} from "@/lib/sessionTasks";
import {
  buildTurnActivity,
  tasksFromTurnActivity,
} from "@/lib/turnActivity";
import {
  stoppableActivitySessions,
  type ActivitySessionRow,
} from "@/lib/agentActivity";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconList,
} from "@/components/icons";

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type AgentTasksPanelProps = {
  messages: ChatMessage[];
  t: TFn;
  onClose?: () => void;
  /** Bump to force re-derive (optional; messages already drive updates). */
  refreshKey?: number;
  /** Other sessions that are busy / waiting (from liveMap). */
  activitySessions?: ActivitySessionRow[];
  onSelectSession?: (sessionId: string) => void;
  onStopSession?: (sessionId: string) => void;
  /** Stop every stoppable busy session (confirm lives in App). */
  onStopAllSessions?: () => void;
  /** Open the cross-session Agent dashboard (distinct from this tools panel). */
  onOpenDashboard?: () => void;
};

function TaskRow({
  task,
  t,
  depth = 0,
  hasChildren = false,
  childrenOpen = true,
  onToggleChildren,
  showTreeChrome = false,
}: {
  task: AgentTask;
  t: TFn;
  depth?: number;
  hasChildren?: boolean;
  childrenOpen?: boolean;
  onToggleChildren?: () => void;
  /** When false, omit tree toggle/spacer so flat lists match pre-tree layout. */
  showTreeChrome?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const statusKey = taskStatusMessageKey(task.status);
  const pad =
    showTreeChrome && depth > 0
      ? { paddingLeft: 8 + depth * 14 }
      : undefined;
  return (
    <li
      className={
        "agent-tasks__row" +
        (task.status === "running" ? " is-running" : "") +
        (task.longRunning ? " is-long" : "") +
        (showTreeChrome && depth > 0 ? " is-child" : "")
      }
      style={pad}
    >
      <div className="agent-tasks__row-line">
        {showTreeChrome ? (
          hasChildren ? (
            <button
              type="button"
              className="agent-tasks__tree-toggle"
              onClick={(e) => {
                e.stopPropagation();
                onToggleChildren?.();
              }}
              aria-expanded={childrenOpen}
              aria-label={
                childrenOpen
                  ? t("tasks.collapseChildren")
                  : t("tasks.expandChildren")
              }
              title={
                childrenOpen
                  ? t("tasks.collapseChildren")
                  : t("tasks.expandChildren")
              }
            >
              {childrenOpen ? (
                <IconChevronDown size={14} />
              ) : (
                <IconChevronRight size={14} />
              )}
            </button>
          ) : (
            <span className="agent-tasks__tree-spacer" aria-hidden />
          )
        ) : null}
        <button
          type="button"
          className={
            "agent-tasks__row-main" +
            (showTreeChrome ? "" : " agent-tasks__row-main--flat")
          }
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? t("tasks.collapse") : t("tasks.expand")}
        >
          <span
            className={`agent-tasks__dot agent-tasks__dot--${task.status}`}
            aria-hidden
          />
          <span className="agent-tasks__name" title={task.name}>
            {task.name}
          </span>
          <span className="agent-tasks__status">{t(statusKey)}</span>
        </button>
      </div>
      {open ? (
        <div className="agent-tasks__detail">
          {task.kind ? (
            <div className="agent-tasks__meta">
              <span className="agent-tasks__meta-k">{t("tasks.kind")}</span>
              <code className="agent-tasks__meta-v">{task.kind}</code>
            </div>
          ) : null}
          {task.detail ? (
            <div className="agent-tasks__meta">
              <span className="agent-tasks__meta-k">{t("tasks.detail")}</span>
              <span className="agent-tasks__meta-v" title={task.detail}>
                {task.detail}
              </span>
            </div>
          ) : null}
          {task.path ? (
            <div className="agent-tasks__meta">
              <span className="agent-tasks__meta-k">{t("tasks.path")}</span>
              <code className="agent-tasks__meta-v" title={task.path}>
                {task.path}
              </code>
            </div>
          ) : null}
          {task.parentId ? (
            <div className="agent-tasks__meta">
              <span className="agent-tasks__meta-k">{t("tasks.parent")}</span>
              <code className="agent-tasks__meta-v" title={task.parentId}>
                {task.parentId}
              </code>
            </div>
          ) : null}
          <div className="agent-tasks__meta">
            <span className="agent-tasks__meta-k">{t("tasks.id")}</span>
            <code className="agent-tasks__meta-v">{task.id}</code>
          </div>
          {task.longRunning ? (
            <p className="agent-tasks__hint">{t("tasks.longRunning")}</p>
          ) : null}
          {task.status === "running" ? (
            <p className="agent-tasks__hint">{t("tasks.noKill")}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function TaskTreeItem({
  node,
  t,
  depth = 0,
  showTreeChrome = false,
}: {
  node: TaskTreeNode;
  t: TFn;
  depth?: number;
  showTreeChrome?: boolean;
}) {
  const hasChildren = node.children.length > 0;
  const [childrenOpen, setChildrenOpen] = useState(true);
  return (
    <>
      <TaskRow
        task={node.task}
        t={t}
        depth={depth}
        hasChildren={hasChildren}
        childrenOpen={childrenOpen}
        onToggleChildren={() => setChildrenOpen((v) => !v)}
        showTreeChrome={showTreeChrome}
      />
      {hasChildren && childrenOpen
        ? node.children.map((child) => (
            <TaskTreeItem
              key={child.task.id}
              node={child}
              t={t}
              depth={depth + 1}
              showTreeChrome={showTreeChrome}
            />
          ))
        : null}
    </>
  );
}

function activityStatusLabel(row: ActivitySessionRow, t: TFn): string {
  switch (row.status) {
    case "streaming":
      return t("tasks.activity.streaming");
    case "awaiting_permission":
      return t("tasks.activity.permission");
    case "connecting":
      return t("tasks.activity.connecting");
    default:
      return t("tasks.activity.other");
  }
}

function ActivityRow({
  row,
  t,
  onSelect,
  onStop,
}: {
  row: ActivitySessionRow;
  t: TFn;
  onSelect?: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
}) {
  return (
    <li
      className={
        "agent-tasks__row agent-tasks__row--session" +
        (row.isCurrent ? " is-current" : "")
      }
    >
      <div className="agent-tasks__row-main agent-tasks__row-main--static">
        <span
          className={`agent-tasks__dot agent-tasks__dot--${
            row.status === "awaiting_permission" ? "failed" : "running"
          }`}
          aria-hidden
        />
        <span className="agent-tasks__name" title={row.title}>
          {row.title}
          {row.isCurrent ? (
            <span className="agent-tasks__current-tag">
              {" "}
              {t("tasks.activity.current")}
            </span>
          ) : null}
        </span>
        <span className="agent-tasks__status">{activityStatusLabel(row, t)}</span>
      </div>
      {row.liveToolTitle ? (
        <div className="agent-tasks__detail">
          <div className="agent-tasks__meta">
            <span className="agent-tasks__meta-k">{t("tasks.kind")}</span>
            <span className="agent-tasks__meta-v" title={row.liveToolTitle}>
              {row.liveToolTitle}
            </span>
          </div>
        </div>
      ) : null}
      <div className="agent-tasks__session-actions">
        {!row.isCurrent && onSelect ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onSelect(row.sessionId)}
          >
            {t("tasks.activity.open")}
          </button>
        ) : null}
        {onStop ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onStop(row.sessionId)}
          >
            {t("tasks.activity.stop")}
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function AgentTasksPanel({
  messages,
  t,
  onClose,
  activitySessions = [],
  onSelectSession,
  onStopSession,
  onStopAllSessions,
  onOpenDashboard,
}: AgentTasksPanelProps) {
  const [query, setQuery] = useState("");
  const tasks = useMemo(() => {
    const act = buildTurnActivity(messages);
    const fromTurn = tasksFromTurnActivity(act);
    const ids = new Set(fromTurn.map((x) => x.id));
    const extraRunning = collectSessionTasks(messages).filter(
      (x) => x.status === "running" && !ids.has(x.id),
    );
    return [...extraRunning, ...fromTurn];
  }, [messages]);
  const filtered = useMemo(
    () => filterSessionTasks(tasks, query),
    [tasks, query],
  );
  const tree = useMemo(() => {
    // Build from full list so parent linkage survives filter, then filter tree.
    const full = buildTaskTree(tasks);
    return filterTaskTree(full, query);
  }, [tasks, query]);
  const running = useMemo(() => countRunningTasks(filtered), [filtered]);
  const activeTree = useMemo(
    () => tree.filter((n) => taskTreeHasRunning(n)),
    [tree],
  );
  const recentTree = useMemo(
    () => tree.filter((n) => !taskTreeHasRunning(n)),
    [tree],
  );
  const otherSessions = useMemo(
    () => activitySessions.filter((r) => !r.isCurrent),
    [activitySessions],
  );
  const stoppableSessions = useMemo(
    () => stoppableActivitySessions(activitySessions),
    [activitySessions],
  );
  const totalBusy = running + otherSessions.length;
  const showStopAll =
    !!onStopAllSessions && stoppableSessions.length > 0;
  const hasTaskRows = activeTree.length > 0 || recentTree.length > 0;
  const showTreeChrome = taskTreeHasNesting(tree);

  return (
    <section className="agent-tasks" aria-label={t("tasks.title")}>
      <header className="agent-tasks__head">
        <div className="agent-tasks__title-row">
          <IconList size={15} />
          <h2 className="agent-tasks__title">{t("tasks.title")}</h2>
          {totalBusy > 0 ? (
            <span className="agent-tasks__badge">
              {t("tasks.runningCount", { n: totalBusy })}
            </span>
          ) : null}
        </div>
        <div className="agent-tasks__head-actions">
          {onOpenDashboard ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onOpenDashboard}
              title={t("tasks.openDashboard")}
            >
              {t("tasks.openDashboard")}
            </button>
          ) : null}
          {showStopAll ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onStopAllSessions}
              title={t("tasks.activity.stopAll")}
            >
              {t("tasks.activity.stopAll")}
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              className="chrome-btn"
              title={t("tasks.hidePanel")}
              aria-label={t("tasks.hidePanel")}
              onClick={onClose}
            >
              <IconClose size={14} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="agent-tasks__search">
        <input
          type="search"
          className="settings-input agent-tasks__search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("tasks.searchPlaceholder")}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {!hasTaskRows && otherSessions.length === 0 ? (
        <div className="agent-tasks__empty">
          <p className="agent-tasks__empty-title">{t("tasks.empty")}</p>
          <p className="agent-tasks__empty-hint">{t("tasks.emptyHint")}</p>
        </div>
      ) : (
        <div className="agent-tasks__body">
          {otherSessions.length > 0 ? (
            <div className="agent-tasks__section">
              <h3 className="agent-tasks__section-title">
                {t("tasks.section.otherSessions")}
              </h3>
              <ul className="agent-tasks__list">
                {otherSessions.map((row) => (
                  <ActivityRow
                    key={row.sessionId}
                    row={row}
                    t={t}
                    onSelect={onSelectSession}
                    onStop={onStopSession}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          {activeTree.length > 0 ? (
            <div className="agent-tasks__section">
              <h3 className="agent-tasks__section-title">
                {t("tasks.section.active")}
              </h3>
              <ul className="agent-tasks__list">
                {activeTree.map((node) => (
                  <TaskTreeItem
                    key={node.task.id}
                    node={node}
                    t={t}
                    showTreeChrome={showTreeChrome}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          {recentTree.length > 0 ? (
            <div className="agent-tasks__section">
              <h3 className="agent-tasks__section-title">
                {t("tasks.section.recent")}
              </h3>
              <ul className="agent-tasks__list">
                {recentTree.map((node) => (
                  <TaskTreeItem
                    key={node.task.id}
                    node={node}
                    t={t}
                    showTreeChrome={showTreeChrome}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
