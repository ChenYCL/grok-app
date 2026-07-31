/**
 * Built-in custom-provider presets (add-provider gallery).
 * Values align with upstream docs; App stores them in agent-home config.toml.
 */

import type { ProviderEffortEntry, ProviderModelEntry } from "@/lib/api";
import { GROK_BUILD_EFFORTS } from "@/lib/grokCatalog";

export type ProviderPreset = {
  id: string;
  /** Channel display name (provider card / group). */
  name: string;
  /** Suggested config section id. */
  suggestedId: string;
  baseUrl: string;
  apiBackend: "responses" | "chat_completions" | "messages";
  models: ProviderModelEntry[];
  efforts: ProviderEffortEntry[];
  /** Optional short blurb for the gallery chip. */
  blurbKey?: string;
  /** Where to obtain an API key (opened from the form). */
  apiKeyUrl?: string;
};

/** Grok / official default reasoning tiers (low · medium · high). */
export const GROK_CHANNEL_EFFORTS: ProviderEffortEntry[] = GROK_BUILD_EFFORTS.map(
  (e) => ({
    id: e.id,
    name: e.id,
    isDefault: e.id === "medium",
  }),
);

/**
 * DeepSeek thinking-mode efforts (OpenAI `reasoning_effort` mapping table):
 * low / high / xhigh / max — see
 * https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 */
export const DEEPSEEK_EFFORTS: ProviderEffortEntry[] = [
  { id: "low", name: "low" },
  { id: "high", name: "high", isDefault: true },
  { id: "xhigh", name: "xhigh" },
  { id: "max", name: "max" },
];

export const DEEPSEEK_MODELS: ProviderModelEntry[] = [
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
];

/** Amux OpenAI-compatible relay (grok-4.5). */
export const AMUX_MODELS: ProviderModelEntry[] = [
  { id: "grok-4.5", name: "Grok 4.5" },
];

/** Yun API (云驿 yunyi) OpenAI-compatible relay. */
export const YUN_API_MODELS: ProviderModelEntry[] = [
  { id: "grok-4.5", name: "Grok 4.5" },
];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    suggestedId: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiBackend: "chat_completions",
    models: DEEPSEEK_MODELS,
    efforts: DEEPSEEK_EFFORTS,
    blurbKey: "prov.preset.deepseek.blurb",
    apiKeyUrl: "https://platform.deepseek.com/",
  },
  {
    id: "amux",
    name: "Amux",
    suggestedId: "amux",
    baseUrl: "https://api.amux.ai/v1",
    apiBackend: "responses",
    models: AMUX_MODELS,
    efforts: GROK_CHANNEL_EFFORTS.map((e) => ({ ...e })),
    blurbKey: "prov.preset.amux.blurb",
    apiKeyUrl: "https://api.amux.ai/register?aff=Vccp",
  },
  {
    id: "yun-api",
    name: "Yun API",
    suggestedId: "yun-api",
    baseUrl: "https://api.yunyi.ai/v1",
    apiBackend: "responses",
    models: YUN_API_MODELS,
    efforts: GROK_CHANNEL_EFFORTS.map((e) => ({ ...e })),
    blurbKey: "prov.preset.yunApi.blurb",
    apiKeyUrl: "https://api.yunyi.ai/register/?aff_code=W0iw",
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** Resolve API-key signup URL for a form (by preset id or base URL host). */
export function resolveProviderApiKeyUrl(opts: {
  providerId?: string | null;
  baseUrl?: string | null;
}): string | null {
  const pid = opts.providerId?.trim().toLowerCase() ?? "";
  if (pid) {
    const byId = PROVIDER_PRESETS.find(
      (p) => p.id === pid || p.suggestedId === pid,
    );
    if (byId?.apiKeyUrl) return byId.apiKeyUrl;
  }
  let host = "";
  try {
    host = new URL(opts.baseUrl?.trim() || "").host.toLowerCase();
  } catch {
    host = "";
  }
  if (!host) return null;
  for (const p of PROVIDER_PRESETS) {
    if (!p.apiKeyUrl) continue;
    try {
      if (new URL(p.baseUrl).host.toLowerCase() === host) return p.apiKeyUrl;
    } catch {
      /* skip */
    }
  }
  // Loose host match (subdomains / without www).
  for (const p of PROVIDER_PRESETS) {
    if (!p.apiKeyUrl) continue;
    try {
      const ph = new URL(p.baseUrl).host.toLowerCase();
      if (host === ph || host.endsWith(`.${ph}`) || ph.endsWith(`.${host}`)) {
        return p.apiKeyUrl;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Default efforts when creating a blank custom channel (Grok-compatible). */
export function defaultCustomChannelEfforts(): ProviderEffortEntry[] {
  return GROK_CHANNEL_EFFORTS.map((e) => ({ ...e }));
}
