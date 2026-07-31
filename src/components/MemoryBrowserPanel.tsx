/**
 * Settings → Agent: browse on-disk Grok Build workspace memory files.
 * When experimental memory is off, shows an honest empty state.
 * Client-side search + kind chips filter the host list (preview stays redacted).
 * Host list + content search under GROK_HOME/memory (capped, path-scoped).
 * Previews/snippets redact likely secrets. Open / reveal / delete per file.
 * App search is always keyword — never invents embeddings (CLI hybrid separate).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import type { MemoryFileEntry, MemorySearchHit } from "@/lib/api";
import { createT, type Locale, type MessageKey } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import {
  IconExternalLink,
  IconFolder,
  IconRefresh,
  IconTrash,
} from "@/components/icons";
import {
  MEMORY_BROWSER_KIND_FILTERS,
  countMemoryEntriesByKind,
  hasActiveMemoryBrowserFilters,
  normalizeMemoryBrowserKind,
  type MemoryBrowserKindFilter,
} from "@/lib/memoryBrowserFilter";
import {
  MEMORY_SEARCH_DEBOUNCE_MS,
  buildMemoryBrowserDisplayRows,
  memoryBrowserMatchBadge,
  memoryBrowserMatchSummary,
  resolveMemoryBrowserEmptyState,
  shouldRunMemoryContentSearch,
  type MemoryBrowserRow,
} from "@/lib/memoryBrowserSearch";
import { isEmbeddingConfigured } from "@/lib/memoryEmbedConfig";
import {
  CLI_MEMORY_HYBRID_SEARCH_AVAILABLE,
  effectiveMemorySearchKind,
  memoryHybridUnavailableHintKey,
  memorySearchKindStatusKey,
  memorySearchModeChipLabelKey,
  memorySearchModeChips,
  type MemorySearchKind,
} from "@/lib/memoryHybridSearch";

function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMtime(ms: number, locale: Locale): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(
      locale === "zh" ? "zh-CN" : locale === "zh-TW" ? "zh-TW" : "en",
      { dateStyle: "medium", timeStyle: "short" },
    );
  } catch {
    return "";
  }
}

function kindLabelKey(kind: string): MessageKey {
  switch (normalizeMemoryBrowserKind(kind)) {
    case "global":
      return "settings.memoryBrowser.kind.global";
    case "workspace":
      return "settings.memoryBrowser.kind.workspace";
    case "session":
      return "settings.memoryBrowser.kind.session";
    case "index":
      return "settings.memoryBrowser.kind.index";
    default:
      return "settings.memoryBrowser.kind.other";
  }
}

function kindFilterLabelKey(filter: MemoryBrowserKindFilter): MessageKey {
  if (filter === "all") return "settings.memoryBrowser.kind.all";
  return kindLabelKey(filter);
}

export function MemoryBrowserPanel({
  locale,
  projectPath = null,
  experimentalMemory,
  onClearAll,
  clearAllBusy = false,
}: {
  locale: Locale;
  projectPath?: string | null;
  experimentalMemory: boolean;
  /** Opens the existing clear-workspace confirm flow. */
  onClearAll?: () => void;
  clearAllBusy?: boolean;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const t = useCallback((k: MessageKey, vars?: Record<string, string | number>) => tr(k, vars), [tr]);

  const [entries, setEntries] = useState<MemoryFileEntry[]>([]);
  const [memoryRoot, setMemoryRoot] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<MemoryBrowserKindFilter>("all");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [searchHits, setSearchHits] = useState<MemorySearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState<MemoryFileEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [actionBusyPath, setActionBusyPath] = useState<string | null>(null);
  const [embedConfigured, setEmbedConfigured] = useState<boolean | null>(null);
  /** Host-reported search kind from last content search (soft-fail missing). */
  const [hostSearchKind, setHostSearchKind] = useState<string | null>(null);

  const cwd = (projectPath || "").trim() || null;

  const searchKind: MemorySearchKind = useMemo(
    () =>
      effectiveMemorySearchKind({
        hostSearchKind,
        embeddingConfigured: embedConfigured,
        cliHybridAvailable: CLI_MEMORY_HYBRID_SEARCH_AVAILABLE,
      }),
    [hostSearchKind, embedConfigured],
  );

  const modeChips = useMemo(
    () =>
      memorySearchModeChips({
        embeddingConfigured: embedConfigured,
        cliHybridAvailable: CLI_MEMORY_HYBRID_SEARCH_AVAILABLE,
      }),
    [embedConfigured],
  );

  const load = useCallback(async () => {
    if (!experimentalMemory) {
      setEntries([]);
      setError(null);
      setLoading(false);
      setSearchHits([]);
      setSearchTruncated(false);
      return;
    }
    if (!api.isTauri()) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.memoryList({ cwd });
      setEntries(res.entries ?? []);
      setMemoryRoot(res.memoryRoot || "");
    } catch (e) {
      setEntries([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd, experimentalMemory]);

  useEffect(() => {
    void load();
  }, [load]);

  // Soft-probe embedding status for honest search-mode chips (never invents vectors).
  useEffect(() => {
    if (!experimentalMemory || !api.isTauri()) {
      setEmbedConfigured(null);
      setHostSearchKind(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const snap = await api.memoryEmbedConfigGet();
        if (cancelled) return;
        setEmbedConfigured(isEmbeddingConfigured(snap));
      } catch {
        if (cancelled) return;
        setEmbedConfigured(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [experimentalMemory]);

  const kindCounts = useMemo(() => countMemoryEntriesByKind(entries), [entries]);
  const activeFilters = hasActiveMemoryBrowserFilters({
    query,
    kind: kindFilter,
  });

  const clearFilters = () => {
    setQuery("");
    setKindFilter("all");
    setDebouncedFilter("");
  };

  const scrollToEmbedSettings = useCallback(() => {
    const el = document.getElementById("settings-anchor-memoryEmbed");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Debounce free-text before host content search.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedFilter(query);
    }, MEMORY_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  // Host content search (path-scoped, capped, redacted snippets).
  useEffect(() => {
    if (!experimentalMemory || !api.isTauri()) {
      setSearchHits([]);
      setSearchTruncated(false);
      setSearching(false);
      return;
    }
    if (!shouldRunMemoryContentSearch(debouncedFilter)) {
      setSearchHits([]);
      setSearchTruncated(false);
      setSearching(false);
      setHostSearchKind(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    void (async () => {
      try {
        const res = await api.memorySearch({
          query: debouncedFilter.trim(),
          cwd,
          limit: 50,
        });
        if (cancelled) return;
        setSearchHits(res.hits ?? []);
        setSearchTruncated(!!res.truncated);
        setHostSearchKind(res.searchKind ?? null);
      } catch (e) {
        if (cancelled) return;
        // Keep list filter usable; surface error without wiping entries.
        setSearchHits([]);
        setSearchTruncated(false);
        setHostSearchKind(null);
        setError(String(e));
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, debouncedFilter, experimentalMemory]);

  // Merge content hits + re-apply kind chip (kind was lost after content-search merge).
  const rows: MemoryBrowserRow[] = useMemo(
    () => buildMemoryBrowserDisplayRows(entries, searchHits, query, kindFilter),
    [entries, searchHits, query, kindFilter],
  );

  const emptyState = useMemo(
    () =>
      resolveMemoryBrowserEmptyState({
        experimentalMemory,
        loading,
        searching,
        entryCount: entries.length,
        rowCount: rows.length,
        query,
        kind: kindFilter,
        embedConfigured,
      }),
    [
      experimentalMemory,
      loading,
      searching,
      entries.length,
      rows.length,
      query,
      kindFilter,
      embedConfigured,
    ],
  );

  const matchSummary = useMemo(
    () => memoryBrowserMatchSummary(rows, query, kindFilter),
    [rows, query, kindFilter],
  );

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const runDelete = async () => {
    if (!deleteTarget || deleteBusy) return;
    const deletedPath = deleteTarget.path;
    setDeleteBusy(true);
    try {
      await api.memoryDeleteFile(deletedPath);
      setDeleteTarget(null);
      setSearchHits((prev) => prev.filter((h) => h.path !== deletedPath));
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  const openFile = async (path: string) => {
    if (!api.isTauri() || actionBusyPath) return;
    setActionBusyPath(path);
    try {
      await api.pathOpen(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setActionBusyPath(null);
    }
  };

  const revealFile = async (path: string) => {
    if (!api.isTauri() || actionBusyPath) return;
    setActionBusyPath(path);
    try {
      await api.pathReveal(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setActionBusyPath(null);
    }
  };

  const queryActive = shouldRunMemoryContentSearch(query);
  const showTruncated = queryActive && searchTruncated && rows.length > 0;
  // Inline "searching…" only when rows already show (empty state covers zero-row case).
  const showSearchingInline =
    queryActive && searching && rows.length > 0 && !emptyState;

  return (
    <div
      className={"settings-row settings-row--stack" + " settings-memory-browser"}
      id="settings-anchor-memoryBrowser"
    >
      <div className="settings-row__text">
        <div className="settings-row__label">{t("settings.memoryBrowser")}</div>
        <div className="settings-row__desc">{t("settings.memoryBrowserDesc")}</div>
      </div>

      {experimentalMemory ? (
        <div
          className="settings-memory-browser__embed-status"
          role="status"
          aria-label={t("settings.memoryBrowser.searchModeLabel")}
        >
          {modeChips.map((chip) => (
            <span
              key={chip}
              className={
                chip === "cli_hybrid"
                  ? "ext-badge"
                  : "ext-badge ext-badge--muted"
              }
            >
              {t(memorySearchModeChipLabelKey(chip))}
            </span>
          ))}
          {embedConfigured === false ? (
            <span className="ext-field-hint settings-memory-browser__embed-hint">
              {t("settings.memoryBrowser.embedUnsetHint")}
            </span>
          ) : searchKind === "hybrid_unavailable" ? (
            <span className="ext-field-hint settings-memory-browser__embed-hint">
              {t(memoryHybridUnavailableHintKey())}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={scrollToEmbedSettings}
          >
            {t("settings.memoryBrowser.openEmbedSettings")}
          </button>
        </div>
      ) : null}

      {!experimentalMemory ? (
        <div className="settings-memory-browser__filter-empty">
          <p className="ext-field-hint settings-memory-browser__empty">
            {t("settings.memoryBrowser.off")}
          </p>
        </div>
      ) : (
        <>
          <div
            className="settings-memory-browser__chips"
            role="tablist"
            aria-label={t("settings.memoryBrowser.kindFilterLabel")}
          >
            {MEMORY_BROWSER_KIND_FILTERS.map((id) => {
              const n = kindCounts[id];
              // Hide zero-count kind chips except "all" and the active selection.
              if (id !== "all" && n === 0 && kindFilter !== id) return null;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={kindFilter === id}
                  className={
                    "settings-memory-browser__chip" +
                    (kindFilter === id ? " is-active" : "")
                  }
                  onClick={() => setKindFilter(id)}
                >
                  <span>{t(kindFilterLabelKey(id))}</span>
                  <span className="settings-memory-browser__chip-count">{n}</span>
                </button>
              );
            })}
          </div>

          <div className="settings-memory-browser__toolbar">
            <input
              type="search"
              className="settings-input settings-memory-browser__search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.memoryBrowser.searchPlaceholder")}
              aria-label={t("settings.memoryBrowser.searchPlaceholder")}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="settings-memory-browser__actions">
              {activeFilters ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={clearFilters}
                >
                  <span>{t("settings.memoryBrowser.clearFilters")}</span>
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={loading || deleteBusy}
                onClick={() => void load()}
              >
                <IconRefresh size={13} />
                <span>{t("settings.memoryBrowser.refresh")}</span>
              </button>
              {onClearAll && cwd ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--danger"
                  disabled={clearAllBusy || loading}
                  onClick={onClearAll}
                >
                  <IconTrash size={13} />
                  <span>
                    {clearAllBusy
                      ? t("settings.clearWorkspaceMemoryBusy")
                      : t("settings.clearWorkspaceMemory")}
                  </span>
                </button>
              ) : null}
            </div>
          </div>

          {memoryRoot ? (
            <p className="ext-toolbar__hint" title={memoryRoot}>
              {t("settings.memoryBrowser.root", { path: memoryRoot })}
            </p>
          ) : null}

          {!cwd ? (
            <p className="ext-field-hint">{t("settings.memoryBrowser.noProject")}</p>
          ) : null}

          {matchSummary ? (
            <p className="ext-field-hint settings-memory-browser__match-summary" role="status">
              {matchSummary.queryActive && matchSummary.contentHits > 0
                ? t("settings.memoryBrowser.matchSummaryContent", {
                    count: matchSummary.total,
                    content: matchSummary.contentHits,
                  })
                : t("settings.memoryBrowser.matchSummary", {
                    count: matchSummary.total,
                  })}
              {matchSummary.queryActive
                ? ` · ${t(memorySearchKindStatusKey(searchKind))}`
                : ""}
            </p>
          ) : queryActive && !searching && !emptyState ? (
            <p className="ext-field-hint settings-memory-browser__match-summary" role="status">
              {t(memorySearchKindStatusKey(searchKind))}
            </p>
          ) : null}

          {showSearchingInline ? (
            <p className="ext-field-hint" aria-live="polite">
              {t("settings.memoryBrowser.searching")}
            </p>
          ) : null}

          {showTruncated ? (
            <p className="ext-field-hint" role="status">
              {t("settings.memoryBrowser.searchTruncated")}
            </p>
          ) : null}

          {error ? (
            <div className="ext-alert ext-alert--error" role="alert">
              <div className="ext-alert__title">{t("settings.memoryBrowser.error")}</div>
              <p className="ext-alert__body">{error}</p>
            </div>
          ) : null}

          {emptyState ? (
            <div className="settings-memory-browser__filter-empty">
              <p className="ext-field-hint settings-memory-browser__empty">
                {t(emptyState.titleKey)}
              </p>
              {emptyState.hintKey ? (
                <p className="ext-field-hint">{t(emptyState.hintKey)}</p>
              ) : null}
              {emptyState.showClearFilters ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm settings-memory-browser__clear-filters"
                  onClick={clearFilters}
                >
                  {t("settings.memoryBrowser.clearFilters")}
                </button>
              ) : null}
              {emptyState.showEmbedLink ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm settings-memory-browser__clear-filters"
                  onClick={scrollToEmbedSettings}
                >
                  {t("settings.memoryBrowser.openEmbedSettings")}
                </button>
              ) : null}
            </div>
          ) : (
            <ul className="ext-list settings-memory-browser__list">
              {rows.map((e) => {
                const open = expanded.has(e.path);
                const canPreview = !!e.preview;
                const busy = actionBusyPath === e.path;
                const matchBadge = memoryBrowserMatchBadge(e, query);
                return (
                  <li key={e.path} className="ext-item">
                    <div className="ext-item__head">
                      <span className="ext-item__name" title={e.path}>
                        {e.relativePath || e.name}
                      </span>
                      <span className="ext-badge ext-badge--muted">
                        {t(kindLabelKey(e.kind))}
                      </span>
                      {matchBadge === "content" ? (
                        <span className="ext-badge ext-badge--muted">
                          {t("settings.memoryBrowser.contentHit")}
                        </span>
                      ) : matchBadge === "name" ? (
                        <span className="ext-badge ext-badge--muted">
                          {t("settings.memoryBrowser.nameHit")}
                        </span>
                      ) : null}
                    </div>
                    <div className="ext-item__meta">
                      {formatSize(e.size)}
                      {e.mtimeMs ? ` · ${formatMtime(e.mtimeMs, locale)}` : ""}
                      {e.workspaceSlug ? ` · ${e.workspaceSlug}` : ""}
                    </div>
                    {e.snippet ? (
                      <p className="settings-memory-browser__snippet" title={e.snippet}>
                        {e.snippet}
                      </p>
                    ) : null}
                    <div className="ext-item__actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy}
                        onClick={() => void openFile(e.path)}
                      >
                        <IconExternalLink size={13} />
                        <span>{t("settings.memoryBrowser.open")}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy}
                        onClick={() => void revealFile(e.path)}
                      >
                        <IconFolder size={13} />
                        <span>{t("settings.memoryBrowser.reveal")}</span>
                      </button>
                      {canPreview ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => toggleExpand(e.path)}
                        >
                          {open
                            ? t("settings.memoryBrowser.collapse")
                            : t("settings.memoryBrowser.expand")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm btn--danger"
                        disabled={deleteBusy}
                        onClick={() =>
                          setDeleteTarget({
                            path: e.path,
                            name: e.name,
                            relativePath: e.relativePath,
                            size: e.size,
                            mtimeMs: e.mtimeMs,
                            preview: e.preview,
                            kind: e.kind,
                            workspaceSlug: e.workspaceSlug,
                            matched: e.matched,
                          })
                        }
                      >
                        <IconTrash size={13} />
                        <span>{t("settings.memoryBrowser.delete")}</span>
                      </button>
                    </div>
                    {open && canPreview ? (
                      <pre className="settings-memory-browser__preview">{e.preview}</pre>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <GlassModal
        open={!!deleteTarget}
        onClose={() => {
          if (!deleteBusy) setDeleteTarget(null);
        }}
        title={t("settings.memoryBrowser.deleteConfirmTitle")}
        size="sm"
        closeLabel={t("common.close")}
        closeOnOverlay={!deleteBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={deleteBusy}
              onClick={() => setDeleteTarget(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={deleteBusy || !deleteTarget}
              onClick={() => void runDelete()}
            >
              {deleteBusy
                ? t("settings.memoryBrowser.deleting")
                : t("settings.memoryBrowser.delete")}
            </button>
          </>
        }
      >
        <p className="settings-row__desc" style={{ margin: 0 }}>
          {t("settings.memoryBrowser.deleteConfirmMsg", {
            name: deleteTarget?.relativePath || deleteTarget?.name || "",
          })}
        </p>
      </GlassModal>
    </div>
  );
}
