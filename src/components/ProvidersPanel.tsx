/**
 * Settings → Account → Custom providers.
 * Visual language matches settings-card / account-panel (not a third-party port).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import { Select } from "@/components/Select";
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconShare,
  IconSkills,
  IconTrash,
} from "@/components/icons";

export interface ProvidersPanelProps {
  locale: Locale;
  /** Called after switching official/custom so host can reconnect Grok Build. */
  onProviderActivated?: () => void;
}

type FormState = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiBackend: string;
  setAsDefault: boolean;
};

type PingState = {
  status: "idle" | "loading" | "ok" | "fail";
  ms?: number;
  detail?: string;
  httpStatus?: number;
};

const emptyForm = (): FormState => ({
  id: "",
  name: "",
  baseUrl: "",
  model: "",
  apiKey: "",
  apiBackend: "chat_completions",
  setAsDefault: true,
});

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function ProvidersPanel({
  locale,
  onProviderActivated,
}: ProvidersPanelProps) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [list, setList] = useState<api.ProvidersListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [pingMap, setPingMap] = useState<Record<string, PingState>>({});
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [hintTone, setHintTone] = useState<"ok" | "err" | "muted">("muted");
  const [copied, setCopied] = useState(false);
  const [switchHint, setSwitchHint] = useState<string | null>(null);

  const protocolOptions = useMemo(
    () => [
      {
        value: "chat_completions",
        label: tr("prov.protocol.chatCompletions"),
      },
      { value: "responses", label: tr("prov.protocol.responses") },
      { value: "messages", label: tr("prov.protocol.messages") },
    ],
    [tr],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!api.isTauri()) {
        setList({
          providers: [],
          defaultModel: null,
          activeSource: "official",
          activeProviderId: null,
          configPath: "",
          agentHome: "",
        });
        return;
      }
      const r = await api.providersList();
      setList(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setRemoteModels([]);
    setHint(null);
    setShowKey(false);
    setFormOpen(true);
  };

  const openEdit = (p: api.CustomProvider) => {
    setEditingId(p.id);
    setForm({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: "",
      apiBackend: p.apiBackend || "chat_completions",
      setAsDefault: p.isDefault,
    });
    setRemoteModels([]);
    setHint(null);
    setShowKey(false);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setHint(null);
    setRemoteModels([]);
  };

  const save = async () => {
    if (!form.baseUrl.trim()) {
      setHint(tr("prov.err.needBase"));
      setHintTone("err");
      return;
    }
    if (!editingId && !form.apiKey.trim()) {
      setHint(tr("prov.err.needKey"));
      setHintTone("err");
      return;
    }
    setBusy(true);
    setHint(tr("prov.saving"));
    setHintTone("muted");
    try {
      const id =
        editingId ??
        (slugify(form.id || form.name || form.baseUrl) ||
          `provider-${Date.now().toString(36)}`);
      await api.providersUpsert({
        id,
        model: form.model.trim() || id,
        baseUrl: form.baseUrl.trim(),
        name: form.name.trim() || id,
        apiKey: form.apiKey.trim() || undefined,
        apiBackend: form.apiBackend,
        setAsDefault: form.setAsDefault,
        createOnly: !editingId,
      });
      setFormOpen(false);
      setHint(null);
      await reload();
    } catch (e) {
      setHint(String(e));
      setHintTone("err");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, name: string) => {
    if (
      !window.confirm(tr("prov.confirmDelete", { id: name || id }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.providersRemove(id);
      if (editingId === id) closeForm();
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (id: string) => {
    setBusy(true);
    try {
      await api.providersActivate("custom", id);
      await reload();
      onProviderActivated?.();
      setSwitchHint(tr("prov.switchedCustom"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const activateOfficial = async () => {
    setBusy(true);
    setSwitchHint(null);
    try {
      const r = await api.providersActivate("official");
      setList(r);
      onProviderActivated?.();
      setSwitchHint(tr("prov.switchedOfficial"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const activateCustom = async (id: string) => {
    setBusy(true);
    setSwitchHint(null);
    try {
      const r = await api.providersActivate("custom", id);
      setList(r);
      onProviderActivated?.();
      setSwitchHint(tr("prov.switchedCustom"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const ping = async (id: string) => {
    setPingMap((m) => ({ ...m, [id]: { status: "loading" } }));
    try {
      const r = await api.providersPing({ providerId: id });
      setPingMap((m) => ({
        ...m,
        [id]: {
          status: r.ok ? "ok" : "fail",
          ms: r.latencyMs,
          detail: r.error,
          httpStatus: r.status,
        },
      }));
    } catch (e) {
      setPingMap((m) => ({
        ...m,
        [id]: { status: "fail", detail: String(e) },
      }));
    }
  };

  const fetchModels = async () => {
    if (!form.baseUrl.trim()) {
      setHint(tr("prov.err.needBase"));
      setHintTone("err");
      return;
    }
    setHint(tr("prov.fetching"));
    setHintTone("muted");
    try {
      const r = await api.providersListModels({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        providerId: editingId ?? undefined,
      });
      setRemoteModels(r.models.map((m) => m.id));
      if (r.models.length) {
        setHint(tr("prov.loaded", { n: r.models.length }));
        setHintTone("ok");
        if (!form.model && r.models[0]?.id) {
          setForm((f) => ({ ...f, model: r.models[0].id }));
        }
      } else {
        setHint(tr("prov.emptyList"));
        setHintTone("muted");
      }
    } catch (e) {
      setHint(String(e));
      setHintTone("err");
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  if (loading) {
    return (
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__label">{tr("prov.loading")}</div>
            <div className="settings-row__desc">{tr("prov.loadingHint")}</div>
          </div>
        </div>
      </div>
    );
  }

  const providers = list?.providers ?? [];
  const count = providers.length;
  const activeSource = list?.activeSource ?? "official";
  const activeProviderId = list?.activeProviderId ?? null;

  return (
    <div className="prov-panel" data-testid="providers-panel">
      {/* Active route switcher — official + custom providers */}
      <h2 className="settings-page__h2">{tr("prov.switchTitle")}</h2>
      <div className="prov-switcher" role="listbox" aria-label={tr("prov.switchTitle")}>
        <button
          type="button"
          role="option"
          aria-selected={activeSource === "official"}
          className={
            "prov-switch" + (activeSource === "official" ? " is-active" : "")
          }
          disabled={busy}
          onClick={() => void activateOfficial()}
        >
          <div className="prov-switch__avatar" aria-hidden>
            G
          </div>
          <div className="prov-switch__text">
            <div className="prov-switch__name">{tr("prov.officialName")}</div>
            <div className="prov-switch__desc">{tr("prov.officialDesc")}</div>
          </div>
          {activeSource === "official" ? (
            <span className="account-badge account-badge--ok">
              {tr("prov.active")}
            </span>
          ) : (
            <span className="prov-switch__go">{tr("prov.useThis")}</span>
          )}
        </button>

        {providers.map((p) => {
          const active =
            activeSource === "custom" && activeProviderId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={active}
              className={"prov-switch" + (active ? " is-active" : "")}
              disabled={busy}
              onClick={() => void activateCustom(p.id)}
            >
              <div className="prov-switch__avatar" aria-hidden>
                {(p.name || p.id).slice(0, 1).toUpperCase()}
              </div>
              <div className="prov-switch__text">
                <div className="prov-switch__name">{p.name || p.id}</div>
                <div className="prov-switch__desc" title={p.baseUrl}>
                  {hostOf(p.baseUrl)}
                  {p.model ? ` · ${p.model}` : ""}
                </div>
              </div>
              {active ? (
                <span className="account-badge account-badge--ok">
                  {tr("prov.active")}
                </span>
              ) : (
                <span className="prov-switch__go">{tr("prov.useThis")}</span>
              )}
            </button>
          );
        })}
      </div>
      {switchHint ? (
        <div className="prov-switch-hint" role="status">
          {switchHint}
        </div>
      ) : (
        <div className="prov-switch-hint prov-switch-hint--muted">
          {tr("prov.switchHint")}
        </div>
      )}

      {/* Intro */}
      <div className="settings-card prov-intro">
        <div className="settings-row settings-row--stack">
          <div className="prov-intro__top">
            <div className="prov-intro__icon" aria-hidden>
              <IconSkills size={20} />
            </div>
            <div className="prov-intro__text">
              <div className="settings-row__label">{tr("prov.configuredTitle")}</div>
              <div className="settings-row__desc">{tr("prov.lead")}</div>
            </div>
            {!formOpen && (
              <button
                type="button"
                className="btn btn--solid"
                onClick={openCreate}
                disabled={busy}
              >
                <IconPlus size={16} />
                {tr("prov.new")}
              </button>
            )}
          </div>
          {list?.agentHome ? (
            <div className="prov-intro__meta">
              <div className="prov-intro__meta-row">
                <span className="prov-intro__meta-k">{tr("prov.agentHome")}</span>
                <code className="prov-intro__meta-v" title={list.agentHome}>
                  {list.agentHome}
                </code>
                <button
                  type="button"
                  className="chrome-btn"
                  title={tr("prov.copyPath")}
                  onClick={() => void copyPath(list.agentHome)}
                >
                  {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                </button>
              </div>
              {list.configPath ? (
                <div className="prov-intro__meta-row">
                  <span className="prov-intro__meta-k">{tr("prov.configFile")}</span>
                  <code className="prov-intro__meta-v" title={list.configPath}>
                    config.toml
                  </code>
                </div>
              ) : null}
              <div className="prov-intro__meta-row">
                <span className="prov-intro__meta-k">{tr("prov.count")}</span>
                <span className="prov-intro__meta-v-plain">
                  {tr("prov.countValue", { n: count })}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {error && (
        <div className="settings-card prov-alert" role="alert">
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">{tr("prov.errorTitle")}</div>
              <div className="settings-row__desc">{error}</div>
            </div>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setError(null)}
            >
              {tr("common.dismiss")}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {!formOpen && (
        <>
          <h2 className="settings-page__h2">{tr("prov.listTitle")}</h2>
          {count === 0 ? (
            <div className="settings-card prov-empty">
              <div className="settings-row settings-row--stack">
                <div className="prov-empty__icon" aria-hidden>
                  <IconShare size={28} />
                </div>
                <div className="settings-row__label">{tr("prov.emptyTitle")}</div>
                <div className="settings-row__desc">{tr("prov.empty")}</div>
                <div className="prov-empty__actions">
                  <button
                    type="button"
                    className="btn btn--solid"
                    onClick={openCreate}
                  >
                    <IconPlus size={16} />
                    {tr("prov.new")}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="prov-list">
              {providers.map((p) => {
                const pingState = pingMap[p.id] ?? { status: "idle" as const };
                const protocolLabel =
                  protocolOptions.find((o) => o.value === p.apiBackend)
                    ?.label ?? p.apiBackend;
                return (
                  <article
                    key={p.id}
                    className={
                      "settings-card prov-card" +
                      (p.isDefault ? " is-default" : "")
                    }
                  >
                    <div className="prov-card__body">
                      <div className="prov-card__head">
                        <div className="prov-card__identity">
                          <div className="prov-card__avatar" aria-hidden>
                            {(p.name || p.id).slice(0, 1).toUpperCase()}
                          </div>
                          <div className="prov-card__titles">
                            <div className="prov-card__name-row">
                              <h3 className="prov-card__name">
                                {p.name || p.id}
                              </h3>
                              {p.isDefault && (
                                <span className="account-badge account-badge--ok">
                                  {tr("prov.default")}
                                </span>
                              )}
                              {p.hasApiKey ? (
                                <span className="account-badge account-badge--muted">
                                  {tr("prov.hasKey")}
                                </span>
                              ) : (
                                <span className="account-badge account-badge--warn">
                                  {tr("prov.noKey")}
                                </span>
                              )}
                            </div>
                            <div className="prov-card__sub">
                              <code>{p.id}</code>
                              <span className="prov-card__dot">·</span>
                              <span>{protocolLabel}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="prov-card__facts">
                        <div className="prov-fact">
                          <span className="prov-fact__k">{tr("prov.factModel")}</span>
                          <code className="prov-fact__v">{p.model}</code>
                        </div>
                        <div className="prov-fact">
                          <span className="prov-fact__k">{tr("prov.factEndpoint")}</span>
                          <span className="prov-fact__v" title={p.baseUrl}>
                            {hostOf(p.baseUrl)}
                          </span>
                        </div>
                      </div>

                      {pingState.status !== "idle" && (
                        <div
                          className={
                            "prov-card__ping" +
                            (pingState.status === "ok"
                              ? " is-ok"
                              : pingState.status === "fail"
                                ? " is-fail"
                                : " is-loading")
                          }
                        >
                          {pingState.status === "loading"
                            ? tr("prov.pinging")
                            : pingState.status === "ok"
                              ? tr("prov.pingOk", {
                                  ms: String(pingState.ms ?? 0),
                                }) +
                                (pingState.httpStatus
                                  ? ` · HTTP ${pingState.httpStatus}`
                                  : "")
                              : tr("prov.pingFail", {
                                  ms: String(pingState.ms ?? 0),
                                }) +
                                (pingState.detail
                                  ? ` · ${pingState.detail}`
                                  : "")}
                        </div>
                      )}
                    </div>

                    <div className="prov-card__actions">
                      {!p.isDefault && (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => void setDefault(p.id)}
                          disabled={busy}
                          title={tr("prov.enable")}
                        >
                          <IconCheck size={14} />
                          {tr("prov.enable")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => void ping(p.id)}
                        disabled={pingState.status === "loading"}
                        title={tr("prov.ping")}
                      >
                        <IconRefresh size={14} />
                        {tr("prov.ping")}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => openEdit(p)}
                        title={tr("prov.edit")}
                      >
                        <IconEdit size={14} />
                        {tr("prov.edit")}
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger"
                        onClick={() => void remove(p.id, p.name || p.id)}
                        disabled={busy}
                        title={tr("prov.delete")}
                      >
                        <IconTrash size={14} />
                        {tr("prov.delete")}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Form */}
      {formOpen && (
        <div className="settings-card prov-form" data-testid="provider-form">
          <div className="prov-form__head">
            <div>
              <div className="settings-row__label">
                {editingId ? tr("prov.editTitle") : tr("prov.addTitle")}
              </div>
              <div className="settings-row__desc">{tr("prov.formLead")}</div>
            </div>
            <button
              type="button"
              className="chrome-btn"
              onClick={closeForm}
              title={tr("common.close")}
              aria-label={tr("common.close")}
            >
              <IconClose size={16} />
            </button>
          </div>

          <div className="prov-form__grid">
            <label className="prov-field">
              <span className="prov-field__label">{tr("prov.name")}</span>
              <input
                className="settings-input"
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({
                    ...f,
                    name,
                    id: editingId ? f.id : slugify(name) || f.id,
                  }));
                }}
                placeholder={tr("prov.namePh")}
                autoComplete="off"
              />
              <span className="prov-field__hint">{tr("prov.nameHint")}</span>
            </label>

            {!editingId && (
              <label className="prov-field">
                <span className="prov-field__label">{tr("prov.displayName")}</span>
                <input
                  className="settings-input"
                  value={form.id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, id: slugify(e.target.value) }))
                  }
                  placeholder={tr("prov.idPh")}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="prov-field__hint">{tr("prov.idHint")}</span>
              </label>
            )}

            <label className="prov-field prov-field--full">
              <span className="prov-field__label">{tr("prov.baseUrl")}</span>
              <input
                className="settings-input"
                value={form.baseUrl}
                onChange={(e) =>
                  setForm((f) => ({ ...f, baseUrl: e.target.value }))
                }
                placeholder={tr("prov.baseUrlPh")}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="prov-field__hint">{tr("prov.baseHint")}</span>
            </label>

            <div className="prov-field">
              <span className="prov-field__label">{tr("prov.protocol")}</span>
              <Select
                value={form.apiBackend}
                onChange={(v) => setForm((f) => ({ ...f, apiBackend: v }))}
                options={protocolOptions}
                aria-label={tr("prov.protocol")}
              />
              <span className="prov-field__hint">{tr("prov.protocolHint")}</span>
            </div>

            <label className="prov-field">
              <span className="prov-field__label">{tr("prov.apiKey")}</span>
              <div className="prov-key-row">
                <input
                  className="settings-input"
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, apiKey: e.target.value }))
                  }
                  placeholder={
                    editingId ? tr("prov.keyKeep") : tr("prov.keyPh")
                  }
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? tr("prov.keyHide") : tr("prov.keyShow")}
                </button>
              </div>
              <span className="prov-field__hint">{tr("prov.keyHint")}</span>
            </label>

            <label className="prov-field prov-field--full">
              <span className="prov-field__label-row">
                <span className="prov-field__label">{tr("prov.requestModel")}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void fetchModels()}
                  disabled={busy}
                >
                  <IconRefresh size={14} />
                  {tr("prov.fetchModels")}
                </button>
              </span>
              <input
                className="settings-input"
                value={form.model}
                onChange={(e) =>
                  setForm((f) => ({ ...f, model: e.target.value }))
                }
                placeholder={tr("prov.modelPh")}
                list="prov-model-suggestions"
                autoComplete="off"
                spellCheck={false}
              />
              <datalist id="prov-model-suggestions">
                {remoteModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <span className="prov-field__hint">{tr("prov.modelHint")}</span>
            </label>
          </div>

          <label className="prov-check">
            <input
              type="checkbox"
              checked={form.setAsDefault}
              onChange={(e) =>
                setForm((f) => ({ ...f, setAsDefault: e.target.checked }))
              }
            />
            <span>
              <span className="prov-check__title">{tr("prov.setDefault")}</span>
              <span className="prov-check__desc">{tr("prov.setDefaultHint")}</span>
            </span>
          </label>

          {hint && (
            <div
              className={
                "prov-form__hint" +
                (hintTone === "ok"
                  ? " is-ok"
                  : hintTone === "err"
                    ? " is-err"
                    : "")
              }
            >
              {hint}
            </div>
          )}

          <div className="prov-form__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={closeForm}
              disabled={busy}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => void save()}
              disabled={busy}
            >
              {editingId ? tr("prov.save") : tr("prov.add")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
