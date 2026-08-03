import { describe, expect, it } from "vitest";
import {
  availableToCards,
  dedupeAvailablePluginsByName,
  filterPluginCardsByQuery,
  resolvePluginLogoPath,
  sliceCatalogPage,
} from "./pluginCatalogUi";

describe("pluginCatalogUi", () => {
  it("dedupes same name from multiple marketplaces", () => {
    const out = dedupeAvailablePluginsByName([
      {
        name: "vercel",
        description: "short",
        marketplace: "plugins",
      },
      {
        name: "vercel",
        description: "Vercel deployment platform integration. Longer.",
        marketplace: "xAI Official",
      },
      {
        name: "Sentry",
        description: "errors",
        marketplace: "xAI Official",
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((p) => p.name === "vercel")?.marketplace).toBe(
      "xAI Official",
    );
  });

  it("availableToCards does not emit duplicate names", () => {
    const cards = availableToCards([
      {
        name: "vercel",
        status: "available",
        description: "a",
        marketplace: "xAI Official",
      },
      {
        name: "vercel",
        status: "available",
        description: "b",
        marketplace: "plugins",
      },
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("vercel");
  });

  it("pages catalog with hasMore", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const p1 = sliceCatalogPage(items, 1, 24);
    expect(p1.visible).toHaveLength(24);
    expect(p1.hasMore).toBe(true);
    const p3 = sliceCatalogPage(items, 3, 24);
    expect(p3.visible).toHaveLength(50);
    expect(p3.hasMore).toBe(false);
  });

  it("maps available plugins with descriptions", () => {
    const cards = availableToCards([
      {
        name: "vercel",
        status: "available",
        description: "Vercel deployment platform",
        marketplace: "xAI Official",
        skillCount: 3,
      },
    ]);
    expect(cards[0]?.description).toContain("Vercel");
    expect(cards[0]?.displayName).toBe("vercel");
  });

  it("filters cards by query", () => {
    const cards = availableToCards([
      {
        name: "vercel",
        status: "available",
        description: "deploy",
        marketplace: "xAI Official",
      },
      {
        name: "sentry",
        status: "available",
        description: "errors",
        marketplace: "xAI Official",
      },
    ]);
    expect(filterPluginCardsByQuery(cards, "sentry")).toHaveLength(1);
  });

  it("resolves logo relative paths", () => {
    expect(
      resolvePluginLogoPath("/cache/plugins/neon", "assets/logo.svg"),
    ).toBe("/cache/plugins/neon/assets/logo.svg");
    expect(
      resolvePluginLogoPath("/cache/plugins/neon/.grok-plugin", "../assets/logo.svg"),
    ).toBe("/cache/plugins/neon/assets/logo.svg");
  });
});
