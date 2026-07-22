/**
 * Full-page settings shell (ChatGPT-desktop style): left nav + content.
 * Back control returns to the workbench ("返回应用").
 */

import { useMemo, useState } from "react";
import { Select } from "@/components/Select";
import {
  IconAppearance,
  IconArrowLeft,
  IconDoctor,
  IconInfo,
  IconLanguage,
  IconSearch,
  IconSettings,
  IconShield,
  IconUser,
} from "@/components/icons";
import type { Theme } from "@/lib/theme";
import type { PermissionPolicyId } from "@/lib/grokCatalog";
import { PERMISSION_POLICIES } from "@/lib/grokCatalog";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "account"
  | "about";

export interface SettingsPageProps {
  section: SettingsSectionId;
  onSection: (id: SettingsSectionId) => void;
  onBack: () => void;
  labels: Record<string, string>;
  locale: string;
  onLocale: (v: string) => void;
  theme: Theme;
  onTheme: (v: Theme) => void;
  sessionDataMode: string;
  onSessionDataMode: (v: string) => void;
  policy: string;
  onPolicy: (v: PermissionPolicyId) => void;
  manualCliPath: string;
  onManualCliPath: (v: string) => void;
  onCliBlur: (v: string) => void;
  cliInfo: {
    found: boolean;
    path: string | null;
    version: string | null;
    source: string;
    cliAuthPresent: boolean;
  };
  onDoctor: () => void;
  versionFooter: string;
}

const NAV: {
  id: SettingsSectionId;
  icon: "settings" | "appearance" | "user" | "info";
  labelKey: string;
  group: "personal" | "system";
}[] = [
  { id: "general", icon: "settings", labelKey: "settings.nav.general", group: "personal" },
  { id: "appearance", icon: "appearance", labelKey: "settings.nav.appearance", group: "personal" },
  { id: "account", icon: "user", labelKey: "settings.nav.account", group: "personal" },
  { id: "about", icon: "info", labelKey: "settings.nav.about", group: "system" },
];

function NavIcon({
  name,
  size = 18,
}: {
  name: (typeof NAV)[number]["icon"];
  size?: number;
}) {
  if (name === "appearance") return <IconAppearance size={size} />;
  if (name === "user") return <IconUser size={size} />;
  if (name === "info") return <IconInfo size={size} />;
  return <IconSettings size={size} />;
}

export function SettingsPage({
  section,
  onSection,
  onBack,
  labels,
  locale,
  onLocale,
  theme,
  onTheme,
  sessionDataMode,
  onSessionDataMode,
  policy,
  onPolicy,
  manualCliPath,
  onManualCliPath,
  onCliBlur,
  cliInfo,
  onDoctor,
  versionFooter,
}: SettingsPageProps) {
  const [query, setQuery] = useState("");
  const t = (k: string) => labels[k] ?? k;

  const nav = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV;
    return NAV.filter((n) => t(n.labelKey).toLowerCase().includes(q));
  }, [query, labels]);

  const title =
    section === "general"
      ? t("settings.nav.general")
      : section === "appearance"
        ? t("settings.nav.appearance")
        : section === "account"
          ? t("settings.nav.account")
          : t("settings.nav.about");

  return (
    <div className="settings-page" data-testid="settings-page">
      <aside className="settings-page__nav">
        {/* Traffic-light / titlebar clearance only — not left padding on whole rail */}
        <div
          className="settings-page__titlebar"
          data-tauri-drag-region
          aria-hidden
        />
        <div className="settings-page__nav-inner">
        <button
          type="button"
          className="settings-page__back"
          onClick={onBack}
        >
          <IconArrowLeft size={16} />
          <span>{t("settings.backToApp")}</span>
        </button>

        <div className="settings-page__search">
          <IconSearch size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.searchPlaceholder")}
          />
        </div>

        <div className="settings-page__group-label">
          {t("settings.group.personal")}
        </div>
        {nav
          .filter((n) => n.group === "personal")
          .map((n) => (
            <button
              key={n.id}
              type="button"
              className={
                "settings-page__nav-item" +
                (section === n.id ? " is-active" : "")
              }
              onClick={() => onSection(n.id)}
            >
              <NavIcon name={n.icon} />
              <span>{t(n.labelKey)}</span>
            </button>
          ))}

        <div className="settings-page__group-label">
          {t("settings.group.system")}
        </div>
        {nav
          .filter((n) => n.group === "system")
          .map((n) => (
            <button
              key={n.id}
              type="button"
              className={
                "settings-page__nav-item" +
                (section === n.id ? " is-active" : "")
              }
              onClick={() => onSection(n.id)}
            >
              <NavIcon name={n.icon} />
              <span>{t(n.labelKey)}</span>
            </button>
          ))}
        </div>
      </aside>

      <div className="settings-page__content">
      <main className="settings-page__main">
        <h1 className="settings-page__title">{title}</h1>

        {section === "general" && (
          <>
            <h2 className="settings-page__h2">{t("settings.section.permissions")}</h2>
            <div className="settings-card">
              <div className="settings-row settings-row--stack">
                <div className="settings-row__text">
                  <div className="settings-row__label">
                    <IconShield size={16} />
                    {t("settings.permissionDeep")}
                  </div>
                  <div className="settings-row__desc">
                    {t("composer.permissionTitle")}
                  </div>
                </div>
                <Select
                  value={policy}
                  onChange={(v) => onPolicy(v as PermissionPolicyId)}
                  options={PERMISSION_POLICIES.map((p) => ({
                    value: p.id,
                    label: t(
                      (
                        {
                          ask: "policy.ask",
                          accept_edits: "policy.accept_edits",
                          allow_for_session: "policy.allow_for_session",
                          dont_ask: "policy.dont_ask",
                          always_approve: "policy.always_approve",
                        } as const
                      )[p.id],
                    ),
                  }))}
                />
              </div>
            </div>

            <h2 className="settings-page__h2">{t("settings.section.general")}</h2>
            <div className="settings-card">
              <div className="settings-row">
                <div className="settings-row__text">
                  <div className="settings-row__label">
                    <IconLanguage size={16} />
                    {t("settings.language")}
                  </div>
                  <div className="settings-row__desc">
                    {t("settings.languageDesc")}
                  </div>
                </div>
                <Select
                  value={locale}
                  onChange={onLocale}
                  options={[
                    { value: "zh", label: "中文" },
                    { value: "en", label: "English" },
                  ]}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row__text">
                  <div className="settings-row__label">
                    {t("settings.sessionDataMode")}
                  </div>
                  <div className="settings-row__desc">
                    {t("settings.sessionDataModeDesc")}
                  </div>
                </div>
                <Select
                  value={sessionDataMode}
                  onChange={onSessionDataMode}
                  options={[
                    {
                      value: "independent",
                      label: t("settings.modeIndependent"),
                    },
                    { value: "shared", label: t("settings.modeShared") },
                  ]}
                />
              </div>
            </div>
          </>
        )}

        {section === "appearance" && (
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row__text">
                <div className="settings-row__label">
                  <IconAppearance size={16} />
                  {t("settings.theme")}
                </div>
                <div className="settings-row__desc">
                  {t("settings.themeDesc")}
                </div>
              </div>
              <div className="settings-seg">
                <button
                  type="button"
                  className={
                    "settings-seg__btn" + (theme === "light" ? " is-on" : "")
                  }
                  onClick={() => onTheme("light")}
                >
                  {t("settings.themeLight")}
                </button>
                <button
                  type="button"
                  className={
                    "settings-seg__btn" + (theme === "dark" ? " is-on" : "")
                  }
                  onClick={() => onTheme("dark")}
                >
                  {t("settings.themeDark")}
                </button>
              </div>
            </div>
          </div>
        )}

        {section === "account" && (
          <div className="settings-card">
            <div className="settings-row settings-row--stack">
              <div className="settings-row__text">
                <div className="settings-row__label">
                  {t("settings.cliPath")}{" "}
                  {cliInfo.found
                    ? `(${cliInfo.source || "ok"})`
                    : t("settings.cliNotFound")}
                </div>
                <div className="settings-row__desc">
                  {t("settings.cliPathDesc")}
                </div>
              </div>
              <input
                className="settings-input"
                value={manualCliPath}
                placeholder={cliInfo.path || "e.g. ~/.grok/bin/grok"}
                onChange={(e) => onManualCliPath(e.target.value)}
                onBlur={(e) => onCliBlur(e.target.value.trim())}
              />
              {cliInfo.version && (
                <div className="settings-row__hint">
                  {cliInfo.version}
                  {cliInfo.path ? ` · ${cliInfo.path}` : ""}
                  {cliInfo.cliAuthPresent
                    ? " · auth.json ok"
                    : " · no CLI auth.json"}
                </div>
              )}
            </div>
            <div className="settings-row">
              <div className="settings-row__text">
                <div className="settings-row__label">
                  <IconDoctor size={16} />
                  {t("doctor.title")}
                </div>
                <div className="settings-row__desc">
                  {t("settings.doctorDesc")}
                </div>
              </div>
              <button
                type="button"
                className="btn btn--ghost settings-row__action"
                onClick={onDoctor}
              >
                {t("settings.runDoctor")}
              </button>
            </div>
          </div>
        )}

        {section === "about" && (
          <div className="settings-card">
            <div className="settings-row settings-row--stack">
              <div className="settings-row__text">
                <div className="settings-row__label">
                  <IconInfo size={16} />
                  {t("settings.aboutApp")}
                </div>
                <div className="settings-row__desc">{versionFooter}</div>
              </div>
            </div>
          </div>
        )}
      </main>
      </div>
    </div>
  );
}
