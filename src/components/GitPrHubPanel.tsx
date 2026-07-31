/**
 * Settings → Runtime → Tools: project-level GitHub PR hub
 * (`gh pr list` / optional `gh pr checks`). Soft-fails when gh/git missing.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as api from "@/lib/api";
import { createT, type Locale, type MessageKey } from "@/i18n";
import {
  classifyPrHubReason,
  formatChecksSummaryLine,
  normalizeMergeable,
  type GitPrCheckEntry,
  type GitPrHubEntry,
  type PrChecksSummary,
} from "@/lib/gitPrHub";
import {
  isHighlightedPr,
  sanitizePrNumber,
} from "@/lib/prHubDeepLink";
import {
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconRefresh,
} from "@/components/icons";

export interface GitPrHubPanelProps {
  locale: Locale;
  /** Active workbench project path (gh cwd). */
  projectPath?: string | null;
  /** When true, omit title/desc (parent card already shows them). */
  hideHeader?: boolean;
  /**
   * Optional PR number to expand + highlight (ship deep link / `?pr=`).
   * Soft-no-op when the number is missing from the current list.
   */
  highlightPrNumber?: number | null;
}

function ChecksBadge({
  summary,
  tr,
}: {
  summary: PrChecksSummary | null | undefined;
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  if (!summary || summary.total <= 0) {
    return (
      <span className="pr-hub__badge pr-hub__badge--muted">
        {tr("prHub.checks.none")}
      </span>
    );
  }
  const line = formatChecksSummaryLine(summary);
  const tone =
    summary.overall === "fail"
      ? "fail"
      : summary.overall === "pending"
        ? "pending"
        : summary.overall === "pass"
          ? "pass"
          : "muted";
  return (
    <span
      className={`pr-hub__badge pr-hub__badge--${tone}`}
      title={line || undefined}
    >
      {line || tr("prHub.checks.none")}
    </span>
  );
}

function MergeableBadge({
  mergeable,
  tr,
}: {
  mergeable: string | null | undefined;
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const m = normalizeMergeable(mergeable);
  if (!m) return null;
  if (m === "mergeable") {
    return (
      <span className="pr-hub__badge pr-hub__badge--pass">
        {tr("prHub.mergeable")}
      </span>
    );
  }
  if (m === "conflicting") {
    return (
      <span className="pr-hub__badge pr-hub__badge--fail">
        {tr("prHub.conflicting")}
      </span>
    );
  }
  return (
    <span className="pr-hub__badge pr-hub__badge--muted">
      {tr("prHub.mergeableUnknown")}
    </span>
  );
}

function EmptyState({
  title,
  body,
}: {
  title: string;
  body?: string | null;
}) {
  return (
    <div className="pi-empty pr-hub__empty" role="status">
      <div className="pi-empty__title">{title}</div>
      {body ? <p className="pi-empty__body">{body}</p> : null}
    </div>
  );
}

function ChecksDetail({
  checks,
  loading,
  error,
  tr,
}: {
  checks: GitPrCheckEntry[] | null;
  loading: boolean;
  error: string | null;
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  if (loading) {
    return (
      <div className="pr-hub__checks-detail pr-hub__muted">
        {tr("prHub.checks.loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="pr-hub__checks-detail pr-hub__error" role="alert">
        {error}
      </div>
    );
  }
  if (!checks || checks.length === 0) {
    return (
      <div className="pr-hub__checks-detail pr-hub__muted">
        {tr("prHub.checks.none")}
      </div>
    );
  }
  return (
    <ul className="pr-hub__checks-list">
      {checks.map((c) => (
        <li key={`${c.name}:${c.workflow ?? ""}`} className="pr-hub__check-row">
          <span
            className={`pr-hub__check-dot pr-hub__check-dot--${c.bucket || "muted"}`}
            aria-hidden
          />
          <span className="pr-hub__check-name">{c.name}</span>
          {c.workflow ? (
            <span className="pr-hub__check-workflow">{c.workflow}</span>
          ) : null}
          <span className="pr-hub__check-state">{c.state || c.bucket}</span>
          {c.link ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm pr-hub__check-link"
              onClick={() => void openUrl(c.link!)}
              title={c.link}
              aria-label={tr("prHub.openCheck")}
            >
              <IconExternalLink size={12} />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

async function openUrl(url: string) {
  const u = url.trim();
  if (!u) return;
  if (api.isTauri()) {
    await api.openExternalUrl(u);
  } else {
    window.open(u, "_blank", "noopener,noreferrer");
  }
}

export function GitPrHubPanel({
  locale,
  projectPath = null,
  hideHeader = false,
  highlightPrNumber = null,
}: GitPrHubPanelProps) {
  const tr = useMemo(() => createT(locale), [locale]);
  const cwd = projectPath?.trim() || null;
  const highlightN = sanitizePrNumber(highlightPrNumber);

  const [prs, setPrs] = useState<GitPrHubEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [ghFound, setGhFound] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [checksByPr, setChecksByPr] = useState<
    Record<number, GitPrCheckEntry[] | null>
  >({});
  const [checksLoading, setChecksLoading] = useState<Record<number, boolean>>(
    {},
  );
  const [checksError, setChecksError] = useState<Record<number, string | null>>(
    {},
  );
  /** Avoid re-scrolling the same highlight on every refresh. */
  const scrolledHighlightRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!cwd) {
      setPrs([]);
      setError(null);
      setReason(null);
      setAvailable(null);
      setLoading(false);
      return;
    }
    if (!api.isTauri()) {
      setPrs([]);
      setError(tr("prHub.needTauri"));
      setAvailable(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setReason(null);
    try {
      const res = await api.gitPrList(cwd, { limit: 30, state: "open" });
      setGhFound(res.ghFound !== false);
      setAvailable(res.available);
      setPrs(Array.isArray(res.prs) ? res.prs : []);
      if (!res.available) {
        setReason(res.reason?.trim() || null);
      } else {
        setReason(null);
      }
    } catch (e) {
      setPrs([]);
      setAvailable(false);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd, tr]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setExpanded({});
    setChecksByPr({});
    setChecksLoading({});
    setChecksError({});
    scrolledHighlightRef.current = null;
  }, [cwd]);

  const loadChecks = useCallback(
    async (n: number) => {
      if (!cwd || !api.isTauri()) return;
      setChecksLoading((prev) => ({ ...prev, [n]: true }));
      setChecksError((prev) => ({ ...prev, [n]: null }));
      try {
        const res = await api.gitPrChecks(cwd, n);
        if (!res.available) {
          setChecksByPr((prev) => ({ ...prev, [n]: [] }));
          setChecksError((prev) => ({
            ...prev,
            [n]: res.reason?.trim() || tr("prHub.checks.failed"),
          }));
          return;
        }
        setChecksByPr((prev) => ({
          ...prev,
          [n]: Array.isArray(res.checks) ? res.checks : [],
        }));
      } catch (e) {
        setChecksError((prev) => ({
          ...prev,
          [n]: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setChecksLoading((prev) => ({ ...prev, [n]: false }));
      }
    },
    [cwd, tr],
  );

  // Deep-link / ship: expand + scroll to highlighted PR when it appears.
  // Soft-no-op if the number is absent from the open list (just-created PR may
  // lag gh list briefly — user can Refresh).
  useEffect(() => {
    if (highlightN == null) {
      scrolledHighlightRef.current = null;
      return;
    }
    const found = prs.some((p) => p.number === highlightN);
    if (!found) return;
    setExpanded((prev) => {
      if (prev[highlightN]) return prev;
      return { ...prev, [highlightN]: true };
    });
    if (checksByPr[highlightN] === undefined) {
      void loadChecks(highlightN);
    }
    if (scrolledHighlightRef.current === highlightN) return;
    scrolledHighlightRef.current = highlightN;
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`pr-hub-row-${highlightN}`);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [highlightN, prs, checksByPr, loadChecks]);

  const toggleExpand = (n: number) => {
    setExpanded((prev) => {
      const next = !prev[n];
      if (next && checksByPr[n] === undefined) {
        void loadChecks(n);
      }
      return { ...prev, [n]: next };
    });
  };

  const reasonKind = classifyPrHubReason(reason);
  const softMessage = (() => {
    if (!cwd) {
      return {
        title: tr("prHub.needProject"),
        body: tr("prHub.needProjectBody"),
      };
    }
    if (error) {
      return { title: tr("prHub.error"), body: error };
    }
    if (available === false) {
      if (reasonKind === "no_gh" || !ghFound) {
        return {
          title: tr("prHub.needGh"),
          body: reason || tr("prHub.needGhBody"),
        };
      }
      if (reasonKind === "no_git") {
        return {
          title: tr("prHub.needGit"),
          body: reason || tr("prHub.needGitBody"),
        };
      }
      if (reasonKind === "not_repo") {
        return {
          title: tr("prHub.notGit"),
          body: reason || tr("prHub.notGitBody"),
        };
      }
      return {
        title: tr("prHub.unavailable"),
        body: reason || tr("prHub.unavailableBody"),
      };
    }
    return null;
  })();

  let body: ReactNode;
  if (!cwd || softMessage) {
    body = softMessage ? (
      <EmptyState title={softMessage.title} body={softMessage.body} />
    ) : null;
  } else if (loading && prs.length === 0) {
    body = (
      <div className="pr-hub__muted" role="status">
        {tr("prHub.loading")}
      </div>
    );
  } else if (prs.length === 0) {
    body = (
      <EmptyState title={tr("prHub.empty")} body={tr("prHub.emptyBody")} />
    );
  } else {
    body = (
      <ul className="pr-hub__list" data-testid="pr-hub-list">
        {prs.map((pr) => {
          const open = Boolean(expanded[pr.number]);
          const highlighted = isHighlightedPr(pr.number, highlightN);
          return (
            <li
              key={pr.number}
              id={`pr-hub-row-${pr.number}`}
              className={
                "pr-hub__row" + (highlighted ? " pr-hub__row--highlight" : "")
              }
              data-highlighted={highlighted ? "true" : undefined}
            >
              <div className="pr-hub__row-main">
                <button
                  type="button"
                  className="pr-hub__expand"
                  onClick={() => toggleExpand(pr.number)}
                  aria-expanded={open}
                  title={
                    open ? tr("prHub.collapseChecks") : tr("prHub.expandChecks")
                  }
                >
                  {open ? (
                    <IconChevronDown size={14} />
                  ) : (
                    <IconChevronRight size={14} />
                  )}
                </button>
                <div className="pr-hub__meta">
                  <div className="pr-hub__title-line">
                    <span className="pr-hub__number">#{pr.number}</span>
                    <span className="pr-hub__title" title={pr.title}>
                      {pr.title || tr("prHub.untitled")}
                    </span>
                    {pr.isDraft ? (
                      <span className="pr-hub__badge pr-hub__badge--muted">
                        {tr("prHub.draft")}
                      </span>
                    ) : null}
                  </div>
                  <div className="pr-hub__sub">
                    {pr.author ? (
                      <span className="pr-hub__author">
                        {tr("prHub.author", { name: pr.author })}
                      </span>
                    ) : null}
                    {pr.headRefName ? (
                      <span className="pr-hub__branch" title={pr.headRefName}>
                        {pr.headRefName}
                        {pr.baseRefName ? ` → ${pr.baseRefName}` : ""}
                      </span>
                    ) : null}
                  </div>
                  <div className="pr-hub__badges">
                    <MergeableBadge mergeable={pr.mergeable} tr={tr} />
                    <ChecksBadge summary={pr.checks} tr={tr} />
                  </div>
                </div>
                <div className="pr-hub__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!pr.url}
                    onClick={() => void openUrl(pr.url)}
                    title={tr("prHub.openInBrowser")}
                    aria-label={tr("prHub.openInBrowser")}
                  >
                    <IconExternalLink size={14} />
                    <span>{tr("prHub.open")}</span>
                  </button>
                </div>
              </div>
              {open ? (
                <ChecksDetail
                  checks={checksByPr[pr.number] ?? null}
                  loading={Boolean(checksLoading[pr.number])}
                  error={checksError[pr.number] ?? null}
                  tr={tr}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="pr-hub-panel" data-testid="git-pr-hub-panel">
      {!hideHeader ? (
        <div
          className="settings-row settings-row--stack"
          style={{ borderBottom: "none", paddingBottom: 0 }}
        >
          <div className="settings-row__text">
            <div className="settings-row__label">{tr("prHub.title")}</div>
            <div className="settings-row__desc">{tr("prHub.desc")}</div>
          </div>
        </div>
      ) : null}

      <div className="pr-hub__toolbar">
        <div className="pr-hub__toolbar-left">
          {available && prs.length > 0 ? (
            <span className="pr-hub__count">
              {tr("prHub.count", { n: prs.length })}
            </span>
          ) : null}
          {loading && prs.length > 0 ? (
            <span className="pr-hub__muted">{tr("prHub.refreshing")}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void refresh()}
          disabled={loading || !cwd || !api.isTauri()}
          aria-label={tr("prHub.refresh")}
        >
          <IconRefresh size={14} />
          <span>{loading ? tr("prHub.refreshing") : tr("prHub.refresh")}</span>
        </button>
      </div>

      {body}
    </div>
  );
}
