/**
 * Slash palette catalog: built-in commands + invocable skills.
 * UI titles/descriptions use i18n keys (`titleKey` / `descriptionKey`)
 * or display strings for dynamic skills.
 */

export type SlashKind = "mode" | "skill" | "action" | "prompt";

export type SlashItem = {
  id: string;
  kind: SlashKind;
  name: string;
  titleKey?: string;
  descriptionKey?: string;
  displayTitle?: string;
  displayDescription?: string;
  source?: string;
  action?: string;
  mode?: "goal" | "plan";
};

export type SkillInfo = {
  name: string;
  description: string;
  source?: string;
  userInvocable?: boolean;
};

/** Built-in slash commands (modes, prompts, host actions). */
export function builtinSlashItems(): SlashItem[] {
  return [
    {
      id: "goal",
      kind: "mode",
      name: "goal",
      titleKey: "slash.goal",
      descriptionKey: "slash.goalDesc",
      mode: "goal",
    },
    {
      id: "plan",
      kind: "mode",
      name: "plan",
      titleKey: "slash.plan",
      descriptionKey: "slash.planDesc",
      mode: "plan",
    },
    {
      id: "compact",
      kind: "action",
      name: "compact",
      titleKey: "slash.compact",
      descriptionKey: "slash.compactDesc",
      action: "compact",
    },
    {
      id: "status",
      kind: "action",
      name: "status",
      titleKey: "slash.status",
      descriptionKey: "slash.statusDesc",
      action: "status",
    },
    {
      id: "mcp",
      kind: "action",
      name: "mcp",
      titleKey: "slash.mcp",
      descriptionKey: "slash.mcpDesc",
      action: "mcp",
    },
    {
      id: "doctor",
      kind: "action",
      name: "doctor",
      titleKey: "slash.doctor",
      descriptionKey: "slash.doctorDesc",
      action: "doctor",
    },
    {
      id: "newChat",
      kind: "action",
      name: "new",
      titleKey: "slash.newChat",
      descriptionKey: "slash.newChatDesc",
      action: "newChat",
    },
    {
      id: "automations",
      kind: "action",
      name: "automations",
      titleKey: "slash.automations",
      descriptionKey: "slash.automationsDesc",
      action: "automations",
    },
    {
      id: "settings",
      kind: "action",
      name: "settings",
      titleKey: "slash.settings",
      descriptionKey: "slash.settingsDesc",
      action: "settings",
    },
    {
      id: "yolo",
      kind: "action",
      name: "yolo",
      titleKey: "slash.yolo",
      descriptionKey: "slash.yoloDesc",
      action: "yolo",
    },
  ];
}

/** Map skill metadata to slash items (skips `userInvocable: false`). */
export function skillsToSlashItems(skills: SkillInfo[]): SlashItem[] {
  return skills
    .filter((s) => s.userInvocable !== false)
    .map((s) => ({
      id: `skill:${s.name}`,
      kind: "skill" as const,
      name: s.name,
      displayTitle: s.name,
      displayDescription: s.description,
      source: s.source,
    }));
}

/**
 * Filter items by query (case-insensitive substring on name / titles / descriptions).
 * Empty query returns all items.
 */
export function filterSlashItems(
  items: SlashItem[],
  query: string,
): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    const fields = [
      item.name,
      item.displayTitle,
      item.displayDescription,
      item.id,
    ];
    return fields.some((f) => f && f.toLowerCase().includes(q));
  });
}

/** Full catalog split into built-in commands and skill items. */
export function buildSlashCatalog(skills: SkillInfo[]): {
  commands: SlashItem[];
  skills: SlashItem[];
} {
  return {
    commands: builtinSlashItems(),
    skills: skillsToSlashItems(skills),
  };
}

/** Flat list for keyboard nav: filtered commands then skills. */
export function flattenFilteredCatalog(
  catalog: { commands: SlashItem[]; skills: SlashItem[] },
  query: string,
): { commands: SlashItem[]; skills: SlashItem[]; flat: SlashItem[] } {
  const commands = filterSlashItems(catalog.commands, query);
  const skills = filterSlashItems(catalog.skills, query);
  return { commands, skills, flat: [...commands, ...skills] };
}
