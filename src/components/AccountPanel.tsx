/**
 * Account panel — simplified layout:
 * 1) One top card: identity + plan + quota + actions
 * 2) Heatmap
 * 3) Fixed-height, internally scrolling call logs
 *
 * Multi-account + import-chat UI is gated off (`SHOW_ACCOUNT_EXTRAS`) until product opens them.
 */

import type { AccountStatus, SavedAccount } from "@/lib/api";
import {
  accountDisplayName,
  accountInitials,
  formatCompactNumber,
  formatDuration,
  formatRelativeTime,
  tierLabel,
  usagePercent,
} from "@/lib/accountUi";
import { Heatmap } from "@/components/Heatmap";
import { Tip } from "@/components/ui/tooltip";

/** Flip to true when multi-account switcher / import chat should ship publicly. */
const SHOW_ACCOUNT_EXTRAS = false;

export interface AccountPanelLabels {
  signedIn: string;
  signedOut: string;
  loginOauth: string;
  loginDevice: string;
  logout: string;
  refresh: string;
  refreshing: string;
  manageUsage: string;
  subscribe: string;
  channel: string;
  subscription: string;
  quota: string;
  quotaRemaining: string;
  quotaUsed: string;
  quotaUnknown: string;
  period: string;
  prepaid: string;
  onDemand: string;
  heatmap: string;
  heatmapHint: string;
  callLogs: string;
  callLogsEmpty: string;
  colSession: string;
  colModel: string;
  colTurns: string;
  colTokens: string;
  colDuration: string;
  colWhen: string;
  less: string;
  more: string;
  expired: string;
  team: string;
  billingUnavailable: string;
  loginBusy: string;
  resetsAt: string;
  fetchedAt: string;
  products: string;
  heatmapNoData: string;
  heatmapAria: string;
  heatmapRequests: string;
  heatmapTokens: string;
  weeklyTitle: string;
  loginHelpTitle: string;
  loginHelpBody: string;
  loginTryDevice: string;
  profiles: string;
  profilesHint: string;
  profilesEmpty: string;
  profileSave: string;
  profileSwitch: string;
  profileRemove: string;
  profileActive: string;
  importChat: string;
  importChatHint: string;
  importChatBtn: string;
}

export interface AccountPanelProps {
  status: AccountStatus | null;
  loading: boolean;
  busy: boolean;
  locale: string;
  t: (key: string) => string;
  labels: AccountPanelLabels;
  compact?: boolean;
  /** Last login error / tip (Access denied etc.) */
  loginHint?: string | null;
  savedAccounts?: SavedAccount[];
  activeAccountId?: string | null;
  onLoginOauth: () => void;
  onLoginDevice: () => void;
  onLogout: () => void;
  onRefresh: () => void;
  onManageUsage: () => void;
  onSubscribe: () => void;
  onOpenSettings?: () => void;
  onSaveAccount?: () => void;
  onSwitchAccount?: (id: string) => void;
  onRemoveAccount?: (id: string) => void;
  onImportChat?: () => void;
}

export function AccountPanel({
  status,
  loading,
  busy,
  locale,
  t,
  labels,
  compact = false,
  loginHint = null,
  savedAccounts = [],
  activeAccountId = null,
  onLoginOauth,
  onLoginDevice,
  onLogout,
  onRefresh,
  onManageUsage,
  onSubscribe,
  onOpenSettings,
  onSaveAccount,
  onSwitchAccount,
  onRemoveAccount,
  onImportChat,
}: AccountPanelProps) {
  const profile = status?.profile;
  const signedIn = !!profile?.signedIn;
  const name = profile
    ? accountDisplayName(profile, t("common.local"))
    : t("common.local");
  const initials = profile ? accountInitials(profile) : "G";
  const channel = status?.channel ?? "none";
  const billing = status?.billing;
  const usedPct = billing ? usagePercent(billing) : null;
  const remaining =
    billing?.remainingPercent != null
      ? billing.remainingPercent
      : usedPct != null
        ? Math.max(0, 100 - usedPct)
        : null;
  const products = (billing?.products ?? []).filter(
    (p) => p.usedPercent > 0 || p.productId === 1 || p.productId === 2,
  );
  const plan = billing ? tierLabel(billing, channel) : "—";
  /** Only show SuperGrok quota when the official account is signed in. */
  const hasQuota = signedIn && !!billing?.available && remaining != null;

  return (
    <div
      className={"account-panel" + (compact ? " account-panel--compact" : "")}
      data-testid="account-panel"
    >
      {/* ── Top: one card for profile + plan + quota + actions ── */}
      <div className="account-hero">
        <div className="account-hero__head">
          <div className="account-avatar" aria-hidden>
            {initials}
          </div>
          <div className="account-hero__id">
            <div className="account-hero__name-row">
              <span className="account-hero__name">{name}</span>
              {!signedIn ? (
                <span className="account-badge account-badge--muted">
                  {labels.signedOut}
                </span>
              ) : profile?.expired ? (
                <span className="account-badge account-badge--muted account-hero__warn">
                  {labels.expired}
                </span>
              ) : null}
            </div>
            {profile?.email && profile.email !== name ? (
              <div className="account-hero__meta">
                <span className="account-hero__email">{profile.email}</span>
              </div>
            ) : null}
          </div>
          <div className="account-hero__actions">
            {signedIn ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy || loading}
                  onClick={onRefresh}
                >
                  {loading ? labels.refreshing : labels.refresh}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={onLogout}
                >
                  {labels.logout}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--solid"
                  disabled={busy}
                  onClick={onLoginOauth}
                >
                  {busy ? labels.loginBusy : labels.loginOauth}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={onLoginDevice}
                >
                  {labels.loginDevice}
                </button>
              </>
            )}
          </div>
        </div>

        {!signedIn ? (
          <div className="account-login-help" role="note">
            <strong>{labels.loginHelpTitle}</strong>
            <p>{labels.loginHelpBody}</p>
            {loginHint ? (
              <p className="account-login-help__err">{loginHint}</p>
            ) : null}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={onLoginDevice}
            >
              {labels.loginTryDevice}
            </button>
          </div>
        ) : null}

        {/* Multi-account + import: hidden until SHOW_ACCOUNT_EXTRAS */}
        {SHOW_ACCOUNT_EXTRAS ? (
          <>
            <div className="account-profiles">
              <div className="account-profiles__head">
                <div>
                  <div className="account-profiles__title">{labels.profiles}</div>
                  <div className="account-profiles__hint">{labels.profilesHint}</div>
                </div>
                {signedIn && onSaveAccount ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={onSaveAccount}
                  >
                    {labels.profileSave}
                  </button>
                ) : null}
              </div>
              {savedAccounts.length === 0 ? (
                <div className="account-profiles__empty">{labels.profilesEmpty}</div>
              ) : (
                <ul className="account-profiles__list">
                  {savedAccounts.map((a) => {
                    const active = activeAccountId === a.id;
                    return (
                      <li key={a.id} className="account-profiles__row">
                        <div className="account-profiles__meta">
                          <span className="account-profiles__label">{a.label}</span>
                          {active ? (
                            <span className="account-badge account-badge--muted">
                              {labels.profileActive}
                            </span>
                          ) : null}
                          {a.email && a.email !== a.label ? (
                            <span className="account-profiles__email">{a.email}</span>
                          ) : null}
                        </div>
                        <div className="account-profiles__actions">
                          {!active && onSwitchAccount ? (
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={busy}
                              onClick={() => onSwitchAccount(a.id)}
                            >
                              {labels.profileSwitch}
                            </button>
                          ) : null}
                          {onRemoveAccount ? (
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={busy}
                              onClick={() => onRemoveAccount(a.id)}
                            >
                              {labels.profileRemove}
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {onImportChat ? (
              <div className="account-import">
                <div className="account-import__title">{labels.importChat}</div>
                <p className="account-import__hint">{labels.importChatHint}</p>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={busy}
                  onClick={onImportChat}
                >
                  {labels.importChatBtn}
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {signedIn ? (
          <>
            <div className="account-hero__quota">
              {hasQuota ? (
                <>
                  {/* Compact: plan + remaining on one row (same as user menu) */}
                  <div className="account-hero__quota-line account-hero__quota-line--compact">
                    <span className="account-hero__plan">{plan}</span>
                    <span className="account-hero__remain">
                      {remaining!.toFixed(0)}% {labels.quotaRemaining}
                    </span>
                  </div>
                  <div className="account-quota-bar" aria-hidden>
                    <div
                      className={
                        "account-quota-bar__fill" +
                        ((usedPct ?? 0) >= 90
                          ? " is-danger"
                          : (usedPct ?? 0) >= 70
                            ? " is-warn"
                            : "")
                      }
                      style={{ width: `${Math.min(100, usedPct ?? 0)}%` }}
                    />
                  </div>
                  <div className="account-hero__quota-side account-hero__quota-side--below">
                    {labels.quotaUsed} {(usedPct ?? 0).toFixed(0)}%
                    {billing?.resetsAt
                      ? ` · ${labels.resetsAt} ${formatRelativeTime(billing.resetsAt, locale)}`
                      : ""}
                  </div>
                  {products.length > 0 && (
                    <div className="account-products">
                      {products.map((p) => (
                        <span
                          key={`${p.productId}-${p.label}`}
                          className="account-product-tag"
                        >
                          {p.label} {p.usedPercent.toFixed(0)}%
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="account-hero__quota-empty">
                  <div className="account-hero__quota-line account-hero__quota-line--compact">
                    <span className="account-hero__plan">{plan}</span>
                  </div>
                  <span>{billing?.message || labels.quotaUnknown}</span>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={busy || loading}
                    onClick={onRefresh}
                  >
                    {loading ? labels.refreshing : labels.refresh}
                  </button>
                </div>
              )}
            </div>

            <div className="account-hero__links">
              <button
                type="button"
                className="account-link"
                onClick={onManageUsage}
              >
                {labels.manageUsage}
              </button>
              <button
                type="button"
                className="account-link"
                onClick={onSubscribe}
              >
                {labels.subscribe}
              </button>
              {compact && onOpenSettings ? (
                <button
                  type="button"
                  className="account-link"
                  onClick={onOpenSettings}
                >
                  {t("settings.nav.account")}
                </button>
              ) : null}
            </div>
          </>
        ) : compact && onOpenSettings ? (
          <div className="account-hero__links">
            <button
              type="button"
              className="account-link"
              onClick={onOpenSettings}
            >
              {t("settings.nav.account")}
            </button>
          </div>
        ) : null}
      </div>

      {!compact && (
        <>
          {/* Heatmap */}
          <section className="account-section">
            <div className="account-section__title">{labels.heatmap}</div>
            <div className="account-section__body account-section__body--heat">
              <Heatmap
                days={status?.heatmap ?? []}
                metric="requests"
                locale={locale}
                labels={{
                  less: labels.less,
                  more: labels.more,
                  noData: labels.heatmapNoData,
                  aria: labels.heatmapAria,
                  requests: labels.heatmapRequests,
                  tokens: labels.heatmapTokens,
                }}
              />
            </div>
          </section>

          {/* Fixed-height, internally scrolling call logs */}
          <section className="account-section">
            <div className="account-section__title">{labels.callLogs}</div>
            <div className="account-section__body account-logs-scroll">
              {!status?.callLogs?.length ? (
                <div className="account-logs__empty">
                  {labels.callLogsEmpty}
                </div>
              ) : (
                <div className="account-logs">
                  <div className="account-logs__head">
                    <span>{labels.colSession}</span>
                    <span>{labels.colModel}</span>
                    <span>{labels.colTurns}</span>
                    <span>{labels.colTokens}</span>
                    <span>{labels.colDuration}</span>
                    <span>{labels.colWhen}</span>
                  </div>
                  {status.callLogs.map((row) => (
                    <div key={row.id} className="account-logs__row">
                      <Tip label={row.projectPath ?? row.title}>
                        <span className="account-logs__title">
                          {row.title}
                        </span>
                      </Tip>
                      <span className="account-logs__mono">
                        {row.model || "—"}
                      </span>
                      <span>{row.turns}</span>
                      <span>{formatCompactNumber(row.contextTokens)}</span>
                      <span>{formatDuration(row.durationSecs)}</span>
                      <span>
                        {formatRelativeTime(row.startedAt, locale)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
