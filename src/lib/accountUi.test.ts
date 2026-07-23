import { describe, expect, it, beforeEach } from "vitest";
import {
  formatMessageTime,
  loadCachedSuperGrokBrand,
  resolveWelcomeBrandKind,
  saveCachedSuperGrokBrand,
  superGrokBrandKind,
  SUPERGROK_BRAND_CACHE_KEY,
  tierLabel,
} from "./accountUi";
import type { BillingSnapshot } from "./api";

function billing(partial: Partial<BillingSnapshot>): BillingSnapshot {
  return {
    available: false,
    source: "test",
    message: null,
    subscriptionTier: null,
    creditUsagePercent: null,
    remainingPercent: null,
    monthlyLimit: null,
    includedUsed: null,
    totalUsed: null,
    prepaidBalance: null,
    onDemandEnabled: null,
    onDemandCap: null,
    onDemandUsed: null,
    billingPeriodStart: null,
    billingPeriodEnd: null,
    resetsAt: null,
    isUnifiedBillingUser: null,
    products: [],
    manageUrl: "",
    subscribeUrl: "",
    fetchedAt: null,
    ...partial,
  };
}

describe("superGrokBrandKind", () => {
  it("returns null when signed out", () => {
    expect(
      superGrokBrandKind(billing({ subscriptionTier: "SuperGrok Heavy" }), false),
    ).toBeNull();
  });

  it("maps SuperGrok Heavy display and SuperGrokPro enum", () => {
    expect(
      superGrokBrandKind(billing({ subscriptionTier: "SuperGrok Heavy" }), true),
    ).toBe("heavy");
    expect(
      superGrokBrandKind(billing({ subscriptionTier: "SuperGrokPro" }), true),
    ).toBe("heavy");
  });

  it("maps SuperGrok standard", () => {
    expect(
      superGrokBrandKind(billing({ subscriptionTier: "SuperGrok" }), true),
    ).toBe("supergrok");
  });

  it("falls back when quota is available but tier string missing", () => {
    expect(
      superGrokBrandKind(billing({ available: true, subscriptionTier: null }), true),
    ).toBe("supergrok");
  });
});

describe("resolveWelcomeBrandKind", () => {
  it("prefers live over cache", () => {
    expect(resolveWelcomeBrandKind("heavy", "supergrok")).toBe("heavy");
  });

  it("uses cache while live is still unknown", () => {
    expect(resolveWelcomeBrandKind(null, "heavy")).toBe("heavy");
  });

  it("drops cache when account is ready and signed out", () => {
    expect(
      resolveWelcomeBrandKind(null, "heavy", {
        accountReady: true,
        signedIn: false,
      }),
    ).toBeNull();
  });
});

describe("cached SuperGrok brand", () => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
  } as Storage;

  beforeEach(() => {
    mem.clear();
  });

  it("round-trips kind", () => {
    saveCachedSuperGrokBrand("heavy", storage);
    expect(loadCachedSuperGrokBrand(storage)).toBe("heavy");
    expect(mem.get(SUPERGROK_BRAND_CACHE_KEY)).toBe("heavy");
  });

  it("clears on null", () => {
    saveCachedSuperGrokBrand("supergrok", storage);
    saveCachedSuperGrokBrand(null, storage);
    expect(loadCachedSuperGrokBrand(storage)).toBeNull();
  });
});

describe("tierLabel", () => {
  it("prefers subscriptionTier string", () => {
    expect(
      tierLabel(billing({ subscriptionTier: "SuperGrok Heavy" }), "official_oauth"),
    ).toBe("SuperGrok Heavy");
  });
});

describe("formatMessageTime", () => {
  it("formats weekday + time", () => {
    const iso = "2026-07-21T07:23:00.000Z";
    const zh = formatMessageTime(iso, "zh");
    const en = formatMessageTime(iso, "en");
    expect(zh.length).toBeGreaterThan(4);
    expect(en.length).toBeGreaterThan(4);
    expect(formatMessageTime(null, "zh")).toBe("");
  });
});
