/**
 * Settings → Extensions: Hooks list + Plugin marketplace browser.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { createT, type Locale, type MessageKey } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import {
  IconExternalLink,
  IconFolder,
  IconHooks,
  IconPlus,
  IconPuzzle,
  IconRefresh,
  IconTrash,
} from "@/components/icons";
import { isCliMissingError } from "@/lib/extensionsUi";
import {
  formatHookMtime,
  formatHookSize,
  hookMetaLine,
  hookRowKey,
  hookTypeLabel,
  sortHooksByScopeName,
  type HookLike,
} from "@/lib/hooksUi";
import {
  loadMarketplaceCatalog,
  invalidateMarketplaceCatalogCache,
  removeAvailablePluginFromCache,
} from "@/lib/marketplaceCatalogCache";
import {
  availablePluginDetailModel,
  availablePluginMetaLine,
  availablePluginRowKey,
  clearPluginRowError,
  enrichAvailableFromComponents,
  filterAvailableByMarketplace,
  filterAvailablePlugins,
  filterPluginsByQuery,
  isXaiOfficialMarketplace,
  marketplaceQualifiedInstallSource,
  marketplaceRemoveTarget,
  marketplaceSourceLabel,
  normalizeMarketplaceAddSource,
  pickDefaultMarketplaceFilter,
  setPluginRowError,
  sortAvailablePluginsByName,
  sortMarketplaceSourcesByName,
  XAI_OFFICIAL_MARKETPLACE,
  type AvailablePluginDetailModel,
  type AvailablePluginLike,
  type MarketplaceSourceLike,
  type PluginComponentBadgeKind,
} from "@/lib/pluginMarketplace";

export type ExtensionsBuildExtrasProps = {
  locale: Locale;
  projectPath?: string | null;
  cliFound?: boolean;
  /** Which block(s) to render — settings page tabs use hooks | market. */
  mode?: "hooks" | "market" | "all";
  /** After plugin install — parent can refresh plugins list. */
  onPluginsChanged?: () => void;
  /**
   * Installed plugin names (and optional marketplace) so catalog rows can
   * offer Reinstall and match “already installed” state.
   */
  installedPlugins?: Array<{
    name: string;
    marketplace?: string | null;
  }>;
};

const BADGE_LABEL_KEY: Record<PluginComponentBadgeKind, MessageKey> = {
  skills: "ext.market.badge.skills",
  hooks: "ext.market.badge.hooks",
  agents: "ext.market.badge.agents",
  mcp: "ext.market.badge.mcp",
};

const PAGE_SIZE = 40;

function asSource(raw: Record<string, unknown>): MarketplaceSourceLike | null {
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    kind: String(raw.kind ?? raw.type ?? "git").trim() || "git",
    url: (raw.url as string | null | undefined) ?? null,
    path: (raw.path as string | null | undefined) ?? null,
    branch: (raw.branch as string | null | undefined) ?? null,
  };
}

function asAvailable(raw: Record<string, unknown>): AvailablePluginLike | null {
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  const status = String(raw.status ?? "available").trim() || "available";
  const skillCountRaw =
    typeof raw.skillCount === "number"
      ? raw.skillCount
      : typeof raw.skill_count === "number"
        ? raw.skill_count
        : null;
  const enriched = enrichAvailableFromComponents(raw, {
    skillCount: skillCountRaw,
    hasHooks: !!(raw.hasHooks ?? raw.has_hooks),
    hasAgents: !!(raw.hasAgents ?? raw.has_agents),
    hasMcp: !!(raw.hasMcp ?? raw.has_mcp),
  });
  return {
    name,
    status,
    marketplace:
      (raw.marketplace as string | null | undefined) ??
      (raw.market as string | null | undefined) ??
      null,
    description: (raw.description as string | null | undefined) ?? null,
    version: (raw.version as string | null | undefined) ?? null,
    skillCount: enriched.skillCount,
    hasHooks: enriched.hasHooks,
    hasAgents: enriched.hasAgents,
    hasMcp: enriched.hasMcp,
  };
}

export function ExtensionsBuildExtras({
  locale,
  projectPath = null,
  cliFound = true,
  mode = "all",
  onPluginsChanged,
  installedPlugins = [],
}: ExtensionsBuildExtrasProps) {
  const tr = useMemo(() => createT(locale), [locale]);
  const cliMissing = !cliFound;
  const showHooks = mode === "all" || mode === "hooks";
  const showMarket = mode === "all" || mode === "market";

  const [hooks, setHooks] = useState<HookLike[]>([]);
  const [hooksUserDir, setHooksUserDir] = useState("");
  const [hooksProjectDir, setHooksProjectDir] = useState<string | null>(null);
  const [hooksDocs, setHooksDocs] = useState<string | null>(null);
  const [hooksError, setHooksError] = useState<string | null>(null);
  const [hooksLoading, setHooksLoading] = useState(true);
  const [hooksBusy, setHooksBusy] = useState<string | null>(null);

  const [sources, setSources] = useState<MarketplaceSourceLike[]>([]);
  const [available, setAvailable] = useState<AvailablePluginLike[]>([]);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketBusy, setMarketBusy] = useState<string | null>(null);
  const [addSource, setAddSource] = useState("");
  const [availQuery, setAvailQuery] = useState("");
  const [marketFilter, setMarketFilter] = useState<string>(XAI_OFFICIAL_MARKETPLACE);
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);
  const [fromCache, setFromCache] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [removeSource, setRemoveSource] = useState<MarketplaceSourceLike | null>(
    null,
  );
  /** Catalog row opened in the detail drawer (rich panel, not install stub). */
  const [detailPlugin, setDetailPlugin] = useState<AvailablePluginLike | null>(
    null,
  );
  /** Confirm step after Install / Reinstall from detail or row. */
  const [installTarget, setInstallTarget] =
    useState<AvailablePluginLike | null>(null);
  /** Per-plugin last install/update error (row + detail Retry). */
  const [installErrors, setInstallErrors] = useState<Record<string, string>>(
    {},
  );

  const installedNameSet = useMemo(() => {
    const set = new Set<string>();
    for (const p of installedPlugins) {
      const n = (p.name ?? "").trim().toLowerCase();
      if (n) set.add(n);
    }
    return set;
  }, [installedPlugins]);

  const isPluginInstalled = useCallback(
    (p: AvailablePluginLike) => {
      const detail = availablePluginDetailModel(p);
      if (detail.isInstalled) return true;
      return installedNameSet.has(p.name.trim().toLowerCase());
    },
    [installedNameSet],
  );

  const badgeLabel = useCallback(
    (kind: PluginComponentBadgeKind, count?: number | null) => {
      const base = tr(BADGE_LABEL_KEY[kind]);
      if (kind === "skills" && typeof count === "number" && count > 0) {
        return tr("ext.market.badge.skillsCount", { n: String(count) });
      }
      return base;
    },
    [tr],
  );

  const detailModel: AvailablePluginDetailModel | null = useMemo(
    () => (detailPlugin ? availablePluginDetailModel(detailPlugin) : null),
    [detailPlugin],
  );

  const loadHooks = useCallback(async () => {
    if (!api.isTauri()) {
      setHooks([]);
      setHooksLoading(false);
      return;
    }
    setHooksLoading(true);
    setHooksError(null);
    try {
      const res = await api.hooksList(projectPath);
      const list = sortHooksByScopeName(
        (res.hooks ?? []).map(
          (h): HookLike => ({
            name: h.name,
            path: h.path,
            scope: h.scope,
            kind: h.kind,
            ext: h.ext,
            size: h.size ?? 0,
            mtimeMs: h.mtimeMs ?? 0,
          }),
        ),
      );
      setHooks(list);
      setHooksUserDir(res.userDir || "");
      setHooksProjectDir(res.projectDir ?? null);
      setHooksDocs(res.docsPath ?? null);
    } catch (e) {
      setHooks([]);
      setHooksError(String(e));
    } finally {
      setHooksLoading(false);
    }
  }, [projectPath]);

  const loadMarket = useCallback(async (force = false) => {
    if (!api.isTauri()) {
      setSources([]);
      setAvailable([]);
      setMarketLoading(false);
      return;
    }
    setMarketLoading(true);
    setMarketError(null);
    try {
      const result = await loadMarketplaceCatalog(async () => {
        const [srcRes, availRes] = await Promise.all([
          api.marketplaceList(),
          api.marketplaceAvailable(),
        ]);
        const err =
          srcRes.error?.trim() || availRes.error?.trim() || null;
        const src = sortMarketplaceSourcesByName(
          (srcRes.sources ?? [])
            .map((r) => asSource(r as Record<string, unknown>))
            .filter((x): x is MarketplaceSourceLike => !!x),
        );
        const avail = sortAvailablePluginsByName(
          filterAvailablePlugins(
            (availRes.plugins ?? [])
              .map((r) => asAvailable(r as Record<string, unknown>))
              .filter((x): x is AvailablePluginLike => !!x),
          ),
        );
        return { sources: src, available: avail, error: err };
      }, { force });

      setSources(result.sources);
      setAvailable(result.available);
      setFromCache(result.fromCache);
      if (result.error) setMarketError(result.error);

      // Keep official default when that source exists; otherwise stay on filter chip.
      setMarketFilter((prev) => {
        if (prev === "__all__") return prev;
        if (result.sources.some((s) => s.name === prev)) return prev;
        if (isXaiOfficialMarketplace(prev)) {
          return pickDefaultMarketplaceFilter(result.sources);
        }
        // If previous source was removed, fall back to official / all.
        return pickDefaultMarketplaceFilter(result.sources);
      });
    } catch (e) {
      setSources([]);
      setAvailable([]);
      setMarketError(String(e));
    } finally {
      setMarketLoading(false);
    }
  }, []);

  useEffect(() => {
    if (showHooks) void loadHooks();
  }, [loadHooks, showHooks]);

  useEffect(() => {
    if (showMarket) void loadMarket(false);
  }, [loadMarket, showMarket]);

  const marketChips = useMemo(() => {
    const chips: { id: string; label: string }[] = [
      {
        id: pickDefaultMarketplaceFilter(sources),
        label: tr("ext.market.filterOfficial"),
      },
      { id: "__all__", label: tr("ext.market.filterAll") },
    ];
    // Deduplicate official id if name differs
    const officialId = chips[0].id;
    for (const s of sources) {
      if (s.name === officialId || isXaiOfficialMarketplace(s.name)) continue;
      chips.push({ id: s.name, label: s.name });
    }
    return chips;
  }, [sources, tr]);

  const filteredByMarket = useMemo(
    () => filterAvailableByMarketplace(available, marketFilter),
    [available, marketFilter],
  );

  const filteredAvailable = useMemo(() => {
    return filterPluginsByQuery(filteredByMarket, availQuery);
  }, [filteredByMarket, availQuery]);

  const visibleAvailable = useMemo(
    () => filteredAvailable.slice(0, pageLimit),
    [filteredAvailable, pageLimit],
  );

  const hasMore = filteredAvailable.length > visibleAvailable.length;

  useEffect(() => {
    setPageLimit(PAGE_SIZE);
  }, [marketFilter, availQuery]);

  const openHooksDir = async (
    scope: "user" | "project",
    create: boolean,
  ) => {
    if (scope === "project" && !projectPath?.trim()) return;
    setHooksBusy(scope === "user" ? "open-user" : "open-project");
    try {
      await api.hooksOpenDir({
        scope,
        projectPath,
        create,
      });
      await loadHooks();
    } catch (e) {
      setHooksError(String(e));
    } finally {
      setHooksBusy(null);
    }
  };

  const revealHook = async (path: string) => {
    setHooksBusy(`reveal:${path}`);
    try {
      await api.hooksReveal(path);
    } catch (e) {
      setHooksError(String(e));
    } finally {
      setHooksBusy(null);
    }
  };

  const addMarketplace = async () => {
    let source: string;
    try {
      source = normalizeMarketplaceAddSource(addSource);
    } catch {
      setMarketError(tr("ext.market.addEmpty"));
      return;
    }
    setMarketBusy("add");
    setMarketError(null);
    try {
      const res = await api.marketplaceAdd(source);
      if (res && typeof res === "object" && "ok" in res && res.ok === false) {
        setMarketError(res.error?.trim() || tr("ext.market.error"));
        return;
      }
      setAddSource("");
      invalidateMarketplaceCatalogCache();
      await loadMarket(true);
    } catch (e) {
      setMarketError(String(e));
    } finally {
      setMarketBusy(null);
    }
  };

  const confirmRemoveSource = async () => {
    if (!removeSource) return;
    const target = marketplaceRemoveTarget(removeSource) || removeSource.name;
    setMarketBusy(`rm:${removeSource.name}`);
    setMarketError(null);
    try {
      const res = await api.marketplaceRemove(target);
      if (res && typeof res === "object" && "ok" in res && res.ok === false) {
        setMarketError(res.error?.trim() || tr("ext.market.error"));
        return;
      }
      setRemoveSource(null);
      invalidateMarketplaceCatalogCache();
      await loadMarket(true);
    } catch (e) {
      setMarketError(String(e));
    } finally {
      setMarketBusy(null);
    }
  };

  const refreshSources = async (name?: string | null) => {
    setMarketBusy(name ? `up:${name}` : "up:all");
    setMarketError(null);
    try {
      const res = await api.marketplaceUpdate(name ?? null);
      if (res && typeof res === "object" && "ok" in res && res.ok === false) {
        setMarketError(res.error?.trim() || tr("ext.market.error"));
        return;
      }
      invalidateMarketplaceCatalogCache();
      await loadMarket(true);
    } catch (e) {
      setMarketError(String(e));
    } finally {
      setMarketBusy(null);
    }
  };

  const runInstall = async (
    target: AvailablePluginLike,
    opts?: { closeConfirm?: boolean },
  ) => {
    const rowKey = availablePluginRowKey(target);
    const source = marketplaceQualifiedInstallSource(
      target.name,
      target.marketplace,
    );
    setMarketBusy(`inst:${rowKey}`);
    setMarketError(null);
    try {
      const res = await api.pluginInstall(source);
      if (res && typeof res === "object" && "ok" in res && res.ok === false) {
        const err =
          (res as { error?: string; message?: string }).error?.trim() ||
          (res as { message?: string }).message?.trim() ||
          tr("ext.market.error");
        setInstallErrors((prev) => setPluginRowError(prev, rowKey, err));
        if (opts?.closeConfirm !== false) setInstallTarget(null);
        return;
      }
      setInstallErrors((prev) => clearPluginRowError(prev, rowKey));
      removeAvailablePluginFromCache(target.name, target.marketplace);
      setAvailable((prev) =>
        prev.filter(
          (p) =>
            !(
              p.name === target.name &&
              (p.marketplace ?? "") === (target.marketplace ?? "")
            ),
        ),
      );
      setInstallTarget(null);
      setDetailPlugin(null);
      onPluginsChanged?.();
    } catch (e) {
      const err = String(e);
      setInstallErrors((prev) => setPluginRowError(prev, rowKey, err));
      if (opts?.closeConfirm !== false) setInstallTarget(null);
    } finally {
      setMarketBusy(null);
    }
  };

  const confirmInstall = async () => {
    if (!installTarget) return;
    await runInstall(installTarget);
  };

  const retryInstall = async (target: AvailablePluginLike) => {
    await runInstall(target, { closeConfirm: true });
  };

  const openDetail = (p: AvailablePluginLike) => {
    setDetailPlugin(p);
  };

  const requestInstall = (p: AvailablePluginLike) => {
    setInstallTarget(p);
  };

  const scopeLabel = (scope: string) => {
    if (scope === "project") return tr("ext.hooks.scope.project");
    return tr("ext.hooks.scope.user");
  };

  return (
    <>
      {/* ── Hooks ── */}
      {showHooks ? (
        <>
          <h2 className="settings-page__h2" id="settings-anchor-ext-hooks">
            <IconHooks size={15} />
            {tr("ext.hooks.title")}
            {!hooksLoading ? (
              <span className="ext-count">{hooks.length}</span>
            ) : null}
          </h2>
          <div className="settings-card ext-card">
            <p className="ext-section-note ext-section-note--top">
              {tr("ext.hooks.desc")}
            </p>
            <div className="ext-folder-actions">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!hooksBusy || cliMissing}
                onClick={() => void openHooksDir("user", false)}
              >
                <IconFolder size={13} />
                <span>
                  {hooksBusy === "open-user"
                    ? tr("ext.plugins.working")
                    : tr("ext.hooks.openUser")}
                </span>
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!hooksBusy || cliMissing}
                onClick={() => void openHooksDir("user", true)}
              >
                <IconPlus size={13} />
                <span>{tr("ext.hooks.createUser")}</span>
              </button>
              {projectPath?.trim() ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!!hooksBusy || cliMissing}
                    onClick={() => void openHooksDir("project", false)}
                  >
                    <IconFolder size={13} />
                    <span>
                      {hooksBusy === "open-project"
                        ? tr("ext.plugins.working")
                        : tr("ext.hooks.openProject")}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!!hooksBusy || cliMissing}
                    onClick={() => void openHooksDir("project", true)}
                  >
                    <IconPlus size={13} />
                    <span>{tr("ext.hooks.createProject")}</span>
                  </button>
                </>
              ) : (
                <span className="ext-field-hint">{tr("ext.hooks.emptyProject")}</span>
              )}
            </div>
            {hooksError ? (
              <div className="ext-alert ext-alert--error" role="alert">
                <div className="ext-alert__title">{tr("ext.hooks.error")}</div>
                <p className="ext-alert__body">
                  {isCliMissingError(hooksError)
                    ? tr("ext.error.cliBody")
                    : hooksError}
                </p>
              </div>
            ) : null}
            {hooksLoading ? (
              <p className="ext-empty">{tr("ext.hooks.loading")}</p>
            ) : hooks.length === 0 ? (
              <p className="ext-empty">{tr("ext.hooks.empty")}</p>
            ) : (
              <ul className="ext-list">
                {hooks.map((h) => (
                  <li key={hookRowKey(h)} className="ext-item">
                    <div className="ext-item__head">
                      <strong className="ext-item__name">{h.name}</strong>
                      <span className="ext-badge ext-badge--muted">
                        {scopeLabel(h.scope)}
                      </span>
                      <span className="ext-badge ext-badge--muted">
                        {hookTypeLabel(h)}
                      </span>
                    </div>
                    <div className="ext-item__meta">
                      <span>{hookMetaLine(h)}</span>
                      <span>
                        {formatHookSize(h.size)} · {formatHookMtime(h.mtimeMs)}
                      </span>
                      {h.path ? (
                        <button
                          type="button"
                          className="ext-path-btn"
                          title={h.path}
                          onClick={() => void revealHook(h.path)}
                        >
                          <IconExternalLink size={13} />
                          <span>{tr("ext.hooks.reveal")}</span>
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {hooksUserDir || hooksProjectDir ? (
              <p className="ext-section-note">
                {hooksUserDir ? (
                  <span>
                    {tr("ext.hooks.scope.user")}: <code>{hooksUserDir}</code>
                  </span>
                ) : null}
                {hooksProjectDir ? (
                  <span>
                    {hooksUserDir ? " · " : null}
                    {tr("ext.hooks.scope.project")}:{" "}
                    <code>{hooksProjectDir}</code>
                  </span>
                ) : null}
              </p>
            ) : null}
            {hooksDocs ? (
              <p className="ext-section-note">
                {tr("ext.hooks.docs")}: <code>{hooksDocs}</code>
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {/* ── Marketplace ── */}
      {showMarket ? (
        <>
          <h2 className="settings-page__h2" id="settings-anchor-ext-market">
            <IconPuzzle size={15} />
            {tr("ext.market.title")}
            {!marketLoading ? (
              <span className="ext-count">{filteredByMarket.length}</span>
            ) : null}
            <button
              type="button"
              className="btn btn--ghost ext-bulk-btn"
              disabled={marketLoading || !!marketBusy || cliMissing}
              onClick={() => void loadMarket(true)}
              title={fromCache ? tr("ext.market.cachedHint") : undefined}
            >
              <IconRefresh size={14} />
              <span>
                {marketBusy === "up:all" || marketLoading
                  ? tr("ext.market.updating")
                  : tr("ext.market.refreshCatalog")}
              </span>
            </button>
          </h2>
          <div className="settings-card ext-card">
            {marketError ? (
              <div className="ext-alert ext-alert--error" role="alert">
                <div className="ext-alert__title">{tr("ext.market.error")}</div>
                <p className="ext-alert__body">{marketError}</p>
              </div>
            ) : null}

            <div className="ext-market-browse">
              <div
                className="ext-plugin-filters"
                role="tablist"
                aria-label={tr("ext.market.filterLabel")}
              >
                {marketChips.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    role="tab"
                    aria-selected={marketFilter === chip.id}
                    className={
                      "ext-plugin-filter" +
                      (marketFilter === chip.id ? " is-active" : "")
                    }
                    onClick={() => setMarketFilter(chip.id)}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
              <input
                type="search"
                className="settings-input ext-market-browse__search"
                value={availQuery}
                placeholder={tr("ext.market.searchPlaceholder")}
                disabled={marketLoading}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setAvailQuery(e.target.value)}
              />
              {fromCache && !marketLoading ? (
                <p className="ext-field-hint">{tr("ext.market.cachedHint")}</p>
              ) : null}
            </div>

            {marketLoading ? (
              <p className="ext-empty">{tr("ext.market.availableLoading")}</p>
            ) : visibleAvailable.length === 0 ? (
              <p className="ext-empty">{tr("ext.market.availableEmpty")}</p>
            ) : (
              <ul className="ext-list ext-market-browse__list">
                {visibleAvailable.map((p) => {
                  const rowKey = availablePluginRowKey(p);
                  const busy =
                    marketBusy === `inst:${rowKey}` ||
                    marketBusy === `inst:${p.name}`;
                  const rowError = installErrors[rowKey] ?? null;
                  const installed = isPluginInstalled(p);
                  const badges = availablePluginDetailModel(p).badges;
                  return (
                    <li
                      key={rowKey}
                      className={
                        "ext-item ext-item--clickable" +
                        (detailPlugin &&
                        availablePluginRowKey(detailPlugin) === rowKey
                          ? " is-selected"
                          : "")
                      }
                    >
                      <button
                        type="button"
                        className="ext-item__hit"
                        onClick={() => openDetail(p)}
                        aria-label={tr("ext.market.viewDetailsAria", {
                          name: p.name,
                        })}
                      >
                        <div className="ext-item__head">
                          <span className="ext-item__name">{p.name}</span>
                          {p.marketplace ? (
                            <span className="ext-badge ext-badge--plugin">
                              {p.marketplace}
                            </span>
                          ) : null}
                          {installed ? (
                            <span className="ext-badge ext-badge--muted">
                              {tr("ext.market.installedBadge")}
                            </span>
                          ) : null}
                        </div>
                        {p.description ? (
                          <div className="ext-item__desc">{p.description}</div>
                        ) : null}
                        <div className="ext-item__meta">
                          {availablePluginMetaLine(p)}
                        </div>
                        {badges.length > 0 ? (
                          <div
                            className="ext-component-badges"
                            aria-hidden="true"
                          >
                            {badges.map((b) => (
                              <span
                                key={b.kind}
                                className={
                                  "ext-badge ext-badge--component ext-badge--component-" +
                                  b.kind
                                }
                              >
                                {badgeLabel(b.kind, b.count)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </button>
                      {rowError ? (
                        <div
                          className="ext-item__row-error"
                          role="alert"
                        >
                          <p className="ext-item__row-error-text">{rowError}</p>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={!!marketBusy || cliMissing}
                            onClick={() => void retryInstall(p)}
                          >
                            {busy
                              ? tr("ext.market.installing")
                              : tr("ext.market.retry")}
                          </button>
                        </div>
                      ) : null}
                      <div className="ext-item__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={!!marketBusy}
                          onClick={() => openDetail(p)}
                        >
                          {tr("ext.market.viewDetails")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--solid btn--sm"
                          disabled={!!marketBusy || cliMissing}
                          onClick={() => requestInstall(p)}
                        >
                          {busy
                            ? tr("ext.market.installing")
                            : installed
                              ? tr("ext.market.reinstall")
                              : tr("ext.market.install")}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {hasMore ? (
              <div className="ext-folder-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setPageLimit((n) => n + PAGE_SIZE)}
                >
                  {tr("ext.market.showMore", {
                    n: filteredAvailable.length - visibleAvailable.length,
                  })}
                </button>
              </div>
            ) : null}

            <details
              className="ext-market-sources"
              open={sourcesOpen}
              onToggle={(e) =>
                setSourcesOpen((e.target as HTMLDetailsElement).open)
              }
            >
              <summary className="ext-market-sources__summary">
                {tr("ext.market.sourcesTitle")}
                {!marketLoading ? (
                  <span className="ext-count">{sources.length}</span>
                ) : null}
              </summary>
              <div className="ext-plugin-install">
                <label
                  className="ext-plugin-install__label"
                  htmlFor="ext-market-source"
                >
                  {tr("ext.market.addLabel")}
                </label>
                <div className="ext-plugin-install__row">
                  <input
                    id="ext-market-source"
                    type="text"
                    className="settings-input ext-plugin-install__input"
                    value={addSource}
                    placeholder={tr("ext.market.addPlaceholder")}
                    disabled={!!marketBusy || cliMissing}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setAddSource(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addMarketplace();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--solid"
                    disabled={!!marketBusy || cliMissing || !addSource.trim()}
                    onClick={() => void addMarketplace()}
                  >
                    {marketBusy === "add"
                      ? tr("ext.market.adding")
                      : tr("ext.market.add")}
                  </button>
                </div>
              </div>
              <div className="ext-folder-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={marketLoading || !!marketBusy || cliMissing}
                  onClick={() => void refreshSources(null)}
                >
                  <IconRefresh size={13} />
                  <span>
                    {marketBusy === "up:all"
                      ? tr("ext.market.updating")
                      : tr("ext.market.updateAll")}
                  </span>
                </button>
              </div>
              {marketLoading ? (
                <p className="ext-field-hint">{tr("ext.market.loading")}</p>
              ) : sources.length === 0 ? (
                <p className="ext-field-hint">{tr("ext.market.empty")}</p>
              ) : (
                <ul className="ext-list">
                  {sources.map((s) => (
                    <li key={s.name} className="ext-item">
                      <div className="ext-item__head">
                        <span className="ext-item__name">{s.name}</span>
                        <span className="ext-badge ext-badge--muted">
                          {s.kind}
                        </span>
                      </div>
                      <div className="ext-item__meta">
                        {marketplaceSourceLabel(s)}
                      </div>
                      <div className="ext-item__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={!!marketBusy || cliMissing}
                          onClick={() => void refreshSources(s.name)}
                        >
                          <IconRefresh size={13} />
                          <span>
                            {marketBusy === `up:${s.name}`
                              ? tr("ext.market.updating")
                              : tr("ext.market.update")}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm ext-item__danger"
                          disabled={!!marketBusy || cliMissing}
                          onClick={() => setRemoveSource(s)}
                        >
                          <IconTrash size={13} />
                          <span>{tr("ext.market.remove")}</span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </div>

          <GlassModal
            open={!!removeSource}
            onClose={() => {
              if (!marketBusy) setRemoveSource(null);
            }}
            title={tr("ext.market.removeTitle")}
            size="sm"
            closeLabel={tr("common.close")}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!!marketBusy}
                  onClick={() => setRemoveSource(null)}
                >
                  {tr("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={!!marketBusy}
                  onClick={() => void confirmRemoveSource()}
                >
                  {tr("ext.market.remove")}
                </button>
              </>
            }
          >
            <p className="app-dialog__msg">
              {tr("ext.market.removeConfirm", {
                name: removeSource?.name ?? "",
              })}
            </p>
          </GlassModal>

          <GlassModal
            open={!!detailPlugin && !!detailModel}
            onClose={() => {
              if (!marketBusy?.startsWith("inst:")) setDetailPlugin(null);
            }}
            title={detailModel?.name ?? tr("ext.market.detailTitle")}
            size="md"
            closeLabel={tr("common.close")}
            wrapBody
            footer={
              detailPlugin && detailModel ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={!!marketBusy?.startsWith("inst:")}
                    onClick={() => setDetailPlugin(null)}
                  >
                    {tr("common.close")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--solid"
                    disabled={!!marketBusy || cliMissing}
                    onClick={() => requestInstall(detailPlugin)}
                  >
                    {marketBusy ===
                      `inst:${availablePluginRowKey(detailPlugin)}` ||
                    marketBusy === `inst:${detailPlugin.name}`
                      ? tr("ext.market.installing")
                      : isPluginInstalled(detailPlugin)
                        ? tr("ext.market.reinstall")
                        : tr("ext.market.install")}
                  </button>
                </>
              ) : null
            }
          >
            {detailModel ? (
              <div className="ext-market-detail">
                {detailModel.description ? (
                  <p className="ext-market-detail__desc">
                    {detailModel.description}
                  </p>
                ) : (
                  <p className="ext-market-detail__desc ext-market-detail__desc--muted">
                    {tr("ext.market.noDescription")}
                  </p>
                )}
                <dl className="ext-market-detail__meta">
                  <div className="ext-market-detail__row">
                    <dt>{tr("ext.market.field.marketplace")}</dt>
                    <dd>
                      {detailModel.marketplace?.trim() ||
                        tr("ext.market.field.unknown")}
                    </dd>
                  </div>
                  <div className="ext-market-detail__row">
                    <dt>{tr("ext.market.field.version")}</dt>
                    <dd>
                      {detailModel.versionLabel
                        ? `v${detailModel.versionLabel}`
                        : tr("ext.market.field.unknown")}
                    </dd>
                  </div>
                  <div className="ext-market-detail__row">
                    <dt>{tr("ext.market.field.source")}</dt>
                    <dd>
                      <code className="ext-market-detail__code">
                        {detailModel.installSource}
                      </code>
                    </dd>
                  </div>
                </dl>
                {detailModel.badges.length > 0 ? (
                  <div
                    className="ext-component-badges ext-component-badges--detail"
                    aria-label={tr("ext.market.componentsLabel")}
                  >
                    {detailModel.badges.map((b) => (
                      <span
                        key={b.kind}
                        className={
                          "ext-badge ext-badge--component ext-badge--component-" +
                          b.kind
                        }
                      >
                        {badgeLabel(b.kind, b.count)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="ext-field-hint">
                    {tr("ext.market.noComponents")}
                  </p>
                )}
                {detailPlugin &&
                installErrors[availablePluginRowKey(detailPlugin)] ? (
                  <div
                    className="ext-item__row-error ext-item__row-error--detail"
                    role="alert"
                  >
                    <p className="ext-item__row-error-text">
                      {installErrors[availablePluginRowKey(detailPlugin)]}
                    </p>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={!!marketBusy || cliMissing}
                      onClick={() => void retryInstall(detailPlugin)}
                    >
                      {marketBusy ===
                        `inst:${availablePluginRowKey(detailPlugin)}` ||
                      marketBusy === `inst:${detailPlugin.name}`
                        ? tr("ext.market.installing")
                        : tr("ext.market.retry")}
                    </button>
                  </div>
                ) : null}
                <p className="ext-market-detail__trust">
                  {tr("ext.market.installTrustNote")}
                </p>
              </div>
            ) : null}
          </GlassModal>

          <GlassModal
            open={!!installTarget}
            onClose={() => {
              if (!marketBusy) setInstallTarget(null);
            }}
            title={
              installTarget && isPluginInstalled(installTarget)
                ? tr("ext.market.reinstallTitle")
                : tr("ext.market.installTitle")
            }
            size="sm"
            closeLabel={tr("common.close")}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!!marketBusy}
                  onClick={() => setInstallTarget(null)}
                >
                  {tr("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--solid"
                  disabled={!!marketBusy}
                  onClick={() => void confirmInstall()}
                >
                  {marketBusy?.startsWith("inst:")
                    ? tr("ext.market.installing")
                    : installTarget && isPluginInstalled(installTarget)
                      ? tr("ext.market.reinstall")
                      : tr("ext.market.install")}
                </button>
              </>
            }
          >
            <p className="app-dialog__msg">
              {installTarget && isPluginInstalled(installTarget)
                ? tr("ext.market.reinstallConfirm", {
                    name: installTarget?.name ?? "",
                  })
                : tr("ext.market.installConfirm", {
                    name: installTarget?.name ?? "",
                  })}
            </p>
          </GlassModal>
        </>
      ) : null}
    </>
  );
}
