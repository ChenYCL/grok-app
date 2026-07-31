import { describe, expect, it } from "vitest";
import {
  assembleGoalOrchView,
  configHasGoalKeys,
  DEFAULT_GOAL_ORCH_UI_ENABLED,
  filterGoalOrchEvents,
  goalEventFromHostPayload,
  isGoalRelatedSessionUpdate,
  isGoalRelatedTool,
  loadGoalOrchUiEnabled,
  mapGoalRoleToPhase,
  parseGoalConfigKeys,
  parseGoalOrchUiEnabled,
  parseGoalUpdatedUpdate,
  prependGoalOrchEvent,
  saveGoalOrchUiEnabled,
  type GoalOrchEvent,
  type GoalOrchUiStorage,
} from "./goalOrch";

/** Wire fixture: ACP session/update with goal_updated (snake_case fields). */
const FIXTURE_GOAL_UPDATED_SNAKE = {
  update: {
    sessionUpdate: "goal_updated",
    goal_id: "g-abc",
    current_subagent_role: "goal classifier",
    current_deliverable_title: "Ship goal orch UI",
    completed_deliverables: 1,
    total_deliverables: 3,
    verifying_completion: true,
    last_classifier_verdict: "not_achieved",
    classifier_runs_attempted: 1,
    classifier_max_runs: 3,
    total_worker_rounds: 2,
    total_verify_rounds: 1,
    objective: "Implement GOAL-ORCH-UX",
  },
};

/** Wire fixture: camelCase host payload. */
const FIXTURE_GOAL_UPDATED_CAMEL = {
  sessionId: "sess-1",
  sessionUpdate: "goal_updated",
  goalId: "g-xyz",
  currentSubagentRole: "strategist",
  currentDeliverableTitle: "Plan steps",
  completedDeliverables: 0,
  totalDeliverables: 2,
  verifyingCompletion: false,
  lastClassifierVerdict: null,
};

const FIXTURE_CONFIG_TOML = `
[workflows]
enabled = true

goal_enabled = true
goal_classifier_enabled = true
goal_planner_enabled = false
goal_verifier_count = 2
goal_planner_model = "grok-4"
# goal_summary_enabled left unset
`;

function memStorage(seed?: string): GoalOrchUiStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  if (seed != null) store.set("grok.goalOrchUiEnabled", seed);
  return {
    store,
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function sampleEvent(
  partial: Partial<GoalOrchEvent> & Pick<GoalOrchEvent, "id" | "phase">,
): GoalOrchEvent {
  return {
    at: 1,
    label: partial.phase,
    detail: "",
    source: "host",
    sessionId: "s1",
    goalId: "g1",
    role: null,
    deliverableProgress: null,
    verifyingCompletion: null,
    lastClassifierVerdict: null,
    sessionUpdate: "goal_updated",
    ...partial,
  };
}

describe("mapGoalRoleToPhase", () => {
  it("maps classifier / planner / strategist / verifier / summarizer", () => {
    expect(mapGoalRoleToPhase("goal classifier")).toBe("classifier");
    expect(mapGoalRoleToPhase("planner")).toBe("planner");
    expect(mapGoalRoleToPhase("goal strategist")).toBe("strategist");
    expect(mapGoalRoleToPhase("skeptic")).toBe("verifier");
    expect(mapGoalRoleToPhase("goal summarizer")).toBe("summarizer");
    expect(mapGoalRoleToPhase("worker")).toBe("worker");
  });

  it("returns unknown for empty / unrelated", () => {
    expect(mapGoalRoleToPhase(null)).toBe("unknown");
    expect(mapGoalRoleToPhase("")).toBe("unknown");
    expect(mapGoalRoleToPhase("bash")).toBe("unknown");
  });
});

describe("isGoalRelatedSessionUpdate / tool", () => {
  it("recognizes goal_updated and goal_* kinds", () => {
    expect(isGoalRelatedSessionUpdate("goal_updated")).toBe(true);
    expect(isGoalRelatedSessionUpdate("goal_classifier_fired")).toBe(true);
    expect(isGoalRelatedSessionUpdate("agent_message_chunk")).toBe(false);
    expect(isGoalRelatedSessionUpdate(null)).toBe(false);
  });

  it("recognizes update_goal tool", () => {
    expect(isGoalRelatedTool("update_goal")).toBe(true);
    expect(isGoalRelatedTool("Update Goal")).toBe(false);
    expect(isGoalRelatedTool("bash")).toBe(false);
  });
});

describe("parseGoalUpdatedUpdate", () => {
  it("parses snake_case ACP envelope fixture", () => {
    const p = parseGoalUpdatedUpdate(FIXTURE_GOAL_UPDATED_SNAKE);
    expect(p).not.toBeNull();
    expect(p!.sessionUpdate).toBe("goal_updated");
    expect(p!.goalId).toBe("g-abc");
    expect(p!.phase).toBe("classifier");
    expect(p!.verifyingCompletion).toBe(true);
    expect(p!.lastClassifierVerdict).toBe("not_achieved");
    expect(p!.completedDeliverables).toBe(1);
    expect(p!.totalDeliverables).toBe(3);
    expect(p!.detail).toContain("Ship goal orch UI");
    expect(p!.detail).toContain("1/3");
    expect(p!.detail).toContain("verifying");
  });

  it("parses camelCase bare payload", () => {
    const p = parseGoalUpdatedUpdate(FIXTURE_GOAL_UPDATED_CAMEL);
    expect(p).not.toBeNull();
    expect(p!.goalId).toBe("g-xyz");
    expect(p!.phase).toBe("strategist");
    expect(p!.verifyingCompletion).toBe(false);
  });

  it("returns null for unrelated session updates", () => {
    expect(
      parseGoalUpdatedUpdate({
        update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } },
      }),
    ).toBeNull();
    expect(parseGoalUpdatedUpdate(null)).toBeNull();
    expect(parseGoalUpdatedUpdate({})).toBeNull();
  });

  it("accepts params.update envelope", () => {
    const p = parseGoalUpdatedUpdate({
      params: {
        update: {
          sessionUpdate: "goal_updated",
          goal_id: "nested",
          current_subagent_role: "planner",
        },
      },
    });
    expect(p?.goalId).toBe("nested");
    expect(p?.phase).toBe("planner");
  });
});

describe("goalEventFromHostPayload", () => {
  it("builds a ring event from host payload", () => {
    const ev = goalEventFromHostPayload({
      sessionId: "sess-1",
      update: FIXTURE_GOAL_UPDATED_SNAKE.update,
    }, 1000);
    expect(ev).not.toBeNull();
    expect(ev!.sessionId).toBe("sess-1");
    expect(ev!.phase).toBe("classifier");
    expect(ev!.goalId).toBe("g-abc");
    expect(ev!.source).toBe("host");
    expect(ev!.at).toBe(1000);
    expect(ev!.deliverableProgress).toBe("1/3");
  });

  it("soft-accepts update_goal tool title", () => {
    const ev = goalEventFromHostPayload({
      sessionId: "s",
      detail: "update_goal",
    }, 1);
    expect(ev?.source).toBe("tool");
    expect(ev?.phase).toBe("status");
  });

  it("returns null when nothing goal-shaped", () => {
    expect(goalEventFromHostPayload({ sessionId: "s", detail: "bash" })).toBeNull();
    expect(goalEventFromHostPayload(null)).toBeNull();
  });
});

describe("ring + view assembly", () => {
  it("prepends and caps", () => {
    const a = sampleEvent({ id: "a", phase: "planner" });
    const b = sampleEvent({ id: "b", phase: "strategist" });
    const c = sampleEvent({ id: "c", phase: "classifier" });
    expect(prependGoalOrchEvent([], a, 2)).toEqual([a]);
    expect(prependGoalOrchEvent([a], b, 2)).toEqual([b, a]);
    expect(prependGoalOrchEvent([b, a], c, 2)).toEqual([c, b]);
  });

  it("filters by session and builds latestByPhase", () => {
    const events = [
      sampleEvent({ id: "1", phase: "planner", sessionId: "s1", at: 3 }),
      sampleEvent({ id: "2", phase: "classifier", sessionId: "s2", at: 2 }),
      sampleEvent({ id: "3", phase: "planner", sessionId: "s1", at: 1 }),
    ];
    const view = assembleGoalOrchView({ events, sessionId: "s1" });
    expect(view.count).toBe(2);
    expect(view.empty).toBe(false);
    expect(view.latestByPhase.planner?.id).toBe("1");
    expect(view.latestByPhase.classifier).toBeUndefined();
    expect(filterGoalOrchEvents(events, "s2")).toHaveLength(1);
  });

  it("empty view when no events (honest empty state)", () => {
    const view = assembleGoalOrchView({ events: [] });
    expect(view.empty).toBe(true);
    expect(view.count).toBe(0);
    expect(view.events).toEqual([]);
  });
});

describe("parseGoalConfigKeys", () => {
  it("detects present goal_* keys without inventing defaults", () => {
    const keys = parseGoalConfigKeys(FIXTURE_CONFIG_TOML);
    const byKey = Object.fromEntries(keys.map((k) => [k.key, k]));
    expect(byKey.goal_enabled.present).toBe(true);
    expect(byKey.goal_enabled.value).toBe("true");
    expect(byKey.goal_classifier_enabled.present).toBe(true);
    expect(byKey.goal_planner_enabled.value).toBe("false");
    expect(byKey.goal_verifier_count.value).toBe("2");
    expect(byKey.goal_planner_model.value).toBe("grok-4");
    // Unset → not present
    expect(byKey.goal_summary_enabled.present).toBe(false);
    expect(byKey.goal_summary_enabled.value).toBeNull();
    expect(byKey.goal_strategist_model.present).toBe(false);
    expect(configHasGoalKeys(FIXTURE_CONFIG_TOML)).toBe(true);
    expect(configHasGoalKeys("[ui]\nyolo = true\n")).toBe(false);
    expect(configHasGoalKeys(null)).toBe(false);
  });
});

describe("goalOrchUiEnabled pref", () => {
  it("defaults on", () => {
    expect(DEFAULT_GOAL_ORCH_UI_ENABLED).toBe(true);
    expect(parseGoalOrchUiEnabled(null)).toBe(true);
    expect(parseGoalOrchUiEnabled(undefined)).toBe(true);
    expect(loadGoalOrchUiEnabled(memStorage())).toBe(true);
  });

  it("round-trips false/true", () => {
    const s = memStorage();
    saveGoalOrchUiEnabled(false, s);
    expect(loadGoalOrchUiEnabled(s)).toBe(false);
    saveGoalOrchUiEnabled(true, s);
    expect(loadGoalOrchUiEnabled(s)).toBe(true);
  });
});
