/**
 * Effective inference model shown in composer model chips.
 *
 * A custom provider (relay) is a **channel**: when it is the active route the
 * agent spawns with the provider's request model (`[model.<id>] model = …`)
 * and the official composer selection is ignored (`agent_spawn_model_id` in
 * providers.rs). The chip must therefore reflect the provider request model —
 * not the stale official catalog pick (default "Grok 4.5") that misleads users
 * into thinking the relay sends Grok.
 */

/**
 * Resolve the model id the composer chip should display.
 *
 * @param modelId Official catalog selection (composer state).
 * @param activeCustomModel Request model of the active custom provider, or
 *   null/undefined when the official route is active.
 */
export function effectiveComposerModel(
  modelId: string,
  activeCustomModel: string | null | undefined,
): string {
  const custom = activeCustomModel?.trim();
  return custom ? custom : modelId;
}
