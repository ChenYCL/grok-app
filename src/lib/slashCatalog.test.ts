import { describe, expect, it } from "vitest";
import {
  buildSlashCatalog,
  builtinSlashItems,
  filterSlashItems,
  skillsToSlashItems,
  type SkillInfo,
  type SlashItem,
} from "./slashCatalog";

describe("builtinSlashItems", () => {
  it("includes expected commands with i18n keys", () => {
    const items = builtinSlashItems();
    const names = items.map((i) => i.name);
    expect(names).toEqual([
      "goal",
      "plan",
      "compact",
      "status",
      "mcp",
      "doctor",
      "new",
      "automations",
      "settings",
      "yolo",
    ]);

    const goal = items.find((i) => i.name === "goal")!;
    expect(goal.kind).toBe("mode");
    expect(goal.mode).toBe("goal");
    expect(goal.titleKey).toBe("slash.goal");
    expect(goal.descriptionKey).toBe("slash.goalDesc");

    const plan = items.find((i) => i.name === "plan")!;
    expect(plan.kind).toBe("mode");
    expect(plan.mode).toBe("plan");

    const compact = items.find((i) => i.name === "compact")!;
    expect(compact.kind).toBe("action");
    expect(compact.action).toBe("compact");

    const doctor = items.find((i) => i.name === "doctor")!;
    expect(doctor.kind).toBe("action");
    expect(doctor.action).toBe("doctor");

    const yolo = items.find((i) => i.name === "yolo")!;
    expect(yolo.kind).toBe("action");
    expect(yolo.action).toBe("yolo");
  });
});

describe("skillsToSlashItems", () => {
  it("maps skill info to slash items", () => {
    const skills: SkillInfo[] = [
      {
        name: "aihot",
        description: "Hot tips",
        source: "user",
        userInvocable: true,
      },
      { name: "hidden", description: "nope", userInvocable: false },
    ];
    const items = skillsToSlashItems(skills);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "skill:aihot",
      kind: "skill",
      name: "aihot",
      displayTitle: "aihot",
      displayDescription: "Hot tips",
      source: "user",
    });
  });

  it("includes skills when userInvocable is undefined", () => {
    expect(
      skillsToSlashItems([{ name: "x", description: "d" }]),
    ).toHaveLength(1);
  });
});

describe("filterSlashItems", () => {
  const items: SlashItem[] = [
    {
      id: "goal",
      kind: "mode",
      name: "goal",
      titleKey: "slash.goal",
      mode: "goal",
    },
    {
      id: "skill:aihot",
      kind: "skill",
      name: "aihot",
      displayTitle: "aihot",
      displayDescription: "AI hot reload helper",
    },
    {
      id: "doctor",
      kind: "action",
      name: "doctor",
      displayDescription: "health check",
    },
  ];

  it("returns all on empty query", () => {
    expect(filterSlashItems(items, "")).toHaveLength(3);
    expect(filterSlashItems(items, "  ")).toHaveLength(3);
  });

  it("filters by name substring", () => {
    expect(filterSlashItems(items, "go").map((i) => i.name)).toEqual(["goal"]);
    expect(filterSlashItems(items, "aih").map((i) => i.name)).toEqual([
      "aihot",
    ]);
  });

  it("filters by description", () => {
    expect(filterSlashItems(items, "health").map((i) => i.name)).toEqual([
      "doctor",
    ]);
  });

  it("is case-insensitive", () => {
    expect(filterSlashItems(items, "GOAL").map((i) => i.name)).toEqual([
      "goal",
    ]);
  });
});

describe("buildSlashCatalog", () => {
  it("splits commands and skills", () => {
    const skills: SkillInfo[] = [
      { name: "s1", description: "one" },
      { name: "s2", description: "two", userInvocable: false },
    ];
    const cat = buildSlashCatalog(skills);
    expect(cat.commands).toEqual(builtinSlashItems());
    expect(cat.skills).toHaveLength(1);
    expect(cat.skills[0]!.name).toBe("s1");
  });
});
