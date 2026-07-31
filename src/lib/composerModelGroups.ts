import type { ModelOption } from "@/lib/grokCatalog";

export type ComposerModelPick =
  | { kind: "official"; modelId: string }
  | { kind: "custom"; providerId: string };

export type ComposerModelEntry = {
  pick: ComposerModelPick;
  title: string;
  /** Raw model id when title is a display name that differs. */
  subtitle?: string;
  /** Stable row key for React. */
  key: string;
};

export type ComposerModelGroup = {
  key: string;
  title: string;
  entries: ComposerModelEntry[];
};

export type ComposerProviderInput = {
  id: string;
  name: string;
  model: string;
};

export function buildComposerModelGroups(opts: {
  officialModels: ModelOption[];
  providers: ComposerProviderInput[];
  officialGroupTitle: string;
}): ComposerModelGroup[] {
  const groups: ComposerModelGroup[] = [];
  const officialEntries: ComposerModelEntry[] = opts.officialModels.map(
    (m) => ({
      key: `official:${m.id}`,
      pick: { kind: "official" as const, modelId: m.id },
      title: m.label || m.id,
    }),
  );
  if (officialEntries.length > 0) {
    groups.push({
      key: "official",
      title: opts.officialGroupTitle,
      entries: officialEntries,
    });
  }
  for (const p of opts.providers) {
    const model = p.model?.trim() ?? "";
    if (!model) continue;
    const name = p.name?.trim() ?? "";
    const title = name || model;
    const subtitle = name && name !== model ? model : undefined;
    groups.push({
      key: `provider:${p.id}`,
      title: name || p.id,
      entries: [
        {
          key: `custom:${p.id}`,
          pick: { kind: "custom", providerId: p.id },
          title,
          subtitle,
        },
      ],
    });
  }
  return groups;
}

export function filterComposerModelGroups(
  groups: ComposerModelGroup[],
  query: string,
): ComposerModelGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({
      ...g,
      entries: g.entries.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          (e.subtitle?.toLowerCase().includes(q) ?? false) ||
          g.title.toLowerCase().includes(q) ||
          (e.pick.kind === "official"
            ? e.pick.modelId.toLowerCase().includes(q)
            : e.pick.providerId.toLowerCase().includes(q)),
      ),
    }))
    .filter((g) => g.entries.length > 0);
}

/** Whether a menu entry is the active selection. */
export function isComposerModelEntryActive(
  entry: ComposerModelEntry,
  opts: {
    activeSource: "official" | "custom" | string;
    activeProviderId: string | null | undefined;
    modelId: string;
  },
): boolean {
  if (entry.pick.kind === "official") {
    return (
      opts.activeSource !== "custom" && entry.pick.modelId === opts.modelId
    );
  }
  return (
    opts.activeSource === "custom" &&
    opts.activeProviderId === entry.pick.providerId
  );
}
