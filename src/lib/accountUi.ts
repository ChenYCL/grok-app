/** Display helpers for official account / billing / local usage. */

import type {
  AccountProfile,
  AccountStatus,
  BillingSnapshot,
} from "./api";

export function accountDisplayName(
  profile: AccountProfile,
  fallback = "Local",
): string {
  return (
    profile.displayName?.trim() ||
    profile.email?.trim() ||
    fallback
  );
}

export function accountInitials(profile: AccountProfile): string {
  const name = accountDisplayName(profile, "G");
  if (name.includes("@")) {
    return name.slice(0, 1).toUpperCase();
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function channelLabelKey(channel: string): string {
  switch (channel) {
    case "official_oauth":
      return "account.channel.oauth";
    case "official_key":
      return "account.channel.key";
    case "relay":
      return "account.channel.relay";
    default:
      return "account.channel.none";
  }
}

export function tierLabel(
  billing: BillingSnapshot,
  channel: string,
): string {
  if (billing.subscriptionTier) {
    return billing.subscriptionTier;
  }
  if (channel === "official_oauth") return "Grok Build";
  if (channel === "official_key") return "API Key";
  if (channel === "relay") return "Relay";
  return "—";
}

export function usagePercent(billing: BillingSnapshot): number | null {
  if (
    billing.creditUsagePercent != null &&
    Number.isFinite(billing.creditUsagePercent)
  ) {
    // Allow slight overflow past 100 like grok-go.
    return Math.max(0, Math.min(200, billing.creditUsagePercent));
  }
  if (
    billing.remainingPercent != null &&
    Number.isFinite(billing.remainingPercent)
  ) {
    return Math.max(0, 100 - billing.remainingPercent);
  }
  if (
    billing.monthlyLimit != null &&
    billing.monthlyLimit > 0 &&
    billing.includedUsed != null
  ) {
    return Math.max(
      0,
      Math.min(100, (billing.includedUsed / billing.monthlyLimit) * 100),
    );
  }
  return null;
}

export function formatCompactNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

export function formatDuration(secs: number | null | undefined): string {
  if (secs == null || secs <= 0) return "—";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

export function formatRelativeTime(
  iso: string | null | undefined,
  locale: string,
): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const rtf = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    numeric: "auto",
  });
  const sec = Math.round(diff / 1000);
  if (Math.abs(sec) < 60) return rtf.format(-sec, "second");
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return rtf.format(-min, "minute");
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 48) return rtf.format(-hr, "hour");
  const day = Math.round(hr / 24);
  return rtf.format(-day, "day");
}

export function isAccountConnected(status: AccountStatus | null): boolean {
  if (!status) return false;
  return (
    status.profile.signedIn ||
    status.hasOfficialKey ||
    status.hasRelayKey ||
    status.cliAuthPresent
  );
}
