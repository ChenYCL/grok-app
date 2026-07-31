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
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** Default efforts when creating a blank custom channel (Grok-compatible). */
export function defaultCustomChannelEfforts(): ProviderEffortEntry[] {
  return GROK_CHANNEL_EFFORTS.map((e) => ({ ...e }));
}
