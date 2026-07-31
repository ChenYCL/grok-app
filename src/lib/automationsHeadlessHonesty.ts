/**
 * AUTO-HEADLESS-LITE — honest process-bound scheduling.
 *
 * Schedules tick only while the Grok App process is alive (main window or
 * tray). There is **no** detached headless daemon. Optional LaunchAgent /
 * Launch-at-login only restart the **full app** (login / crash), never run
 * tasks after a successful Quit without relaunch.
 *
 * Pure helpers only — no I/O. UI translates returned message keys.
 */

import { shouldHideToTrayOnClose } from "./automationsRunnerPolicy";

/** Why schedules are paused or at risk (for status surface). */
export type AutomationsPausedReason =
  | "none"
  | "no_enabled"
  | "runner_unknown"
  | "close_exits"
  | "process_bound"
  | "awaiting_tick";

export type AutomationsPausedReasonKey =
  | "automations.runner.reason.none"
  | "automations.runner.reason.noEnabled"
  | "automations.runner.reason.unknown"
  | "automations.runner.reason.closeExits"
  | "automations.runner.reason.processBound"
  | "automations.runner.reason.awaitingTick";

export type AutomationsRunnerPhase = "running" | "idle" | "unknown";

export type AutomationsRunnerSurface = {
  phase: AutomationsRunnerPhase;
  lastTickAt: string | null;
  tickIntervalSecs: number;
  enabledCount: number;
  /** Primary pause / risk reason for the status line. */
  pausedReason: AutomationsPausedReason;
  pausedReasonKey: AutomationsPausedReasonKey;
  /** Visual weight for the status chip / line. */
  severity: "none" | "info" | "warn";
  /** Closing the window currently keeps the process (tray residency path). */
  hidesOnClose: boolean;
  /**
   * LaunchAgent helper installed+enabled. Does **not** keep this process on
   * window close — only relaunches full app later (login / crash).
   */
  launchAgentEnabled: boolean;
};

export type AutomationsRunnerSurfaceInput = {
  runnerKnown: boolean;
  running: boolean;
  lastTickAt?: string | null;
  tickIntervalSecs?: number;
  enabledCount: number;
  closeToTray: boolean;
  keepTrayForSchedules: boolean;
  /** Optional LaunchAgent helper currently installed+enabled (macOS). */
  launchAgentEnabled?: boolean;
};

function normalizeCount(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function normalizeTickSecs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(3600, Math.floor(n));
}

/**
 * Derive host runner status surface: phase, last tick, honest pause reason.
 */
export function deriveAutomationsRunnerSurface(
  input: AutomationsRunnerSurfaceInput,
): AutomationsRunnerSurface {
  const enabledCount = normalizeCount(input.enabledCount);
  const tickIntervalSecs = normalizeTickSecs(input.tickIntervalSecs);
  const lastTickAt =
    typeof input.lastTickAt === "string" && input.lastTickAt.trim()
      ? input.lastTickAt.trim()
      : null;

  const hidesOnClose = shouldHideToTrayOnClose({
    closeToTray: !!input.closeToTray,
    keepTrayForSchedules: !!input.keepTrayForSchedules,
    anyEnabledAutomation: enabledCount > 0,
  });
  const launchAgentEnabled = !!input.launchAgentEnabled;

  if (!input.runnerKnown) {
    return {
      phase: "unknown",
      lastTickAt,
      tickIntervalSecs,
      enabledCount,
      pausedReason: enabledCount > 0 ? "runner_unknown" : "no_enabled",
      pausedReasonKey:
        enabledCount > 0
          ? "automations.runner.reason.unknown"
          : "automations.runner.reason.noEnabled",
      severity: enabledCount > 0 ? "warn" : "none",
      hidesOnClose,
      launchAgentEnabled,
    };
  }

  if (enabledCount <= 0) {
    return {
      phase: input.running ? "running" : "idle",
      lastTickAt,
      tickIntervalSecs,
      enabledCount: 0,
      pausedReason: "no_enabled",
      pausedReasonKey: "automations.runner.reason.noEnabled",
      severity: "none",
      hidesOnClose,
      launchAgentEnabled,
    };
  }

  if (!input.running) {
    return {
      phase: "idle",
      lastTickAt,
      tickIntervalSecs,
      enabledCount,
      pausedReason: "runner_unknown",
      pausedReasonKey: "automations.runner.reason.unknown",
      severity: "warn",
      hidesOnClose,
      launchAgentEnabled,
    };
  }

  // Host tick loop is up. Close-without-tray still kills *this* process.
  // LaunchAgent only relaunches later (login/crash) — it is not tray residency.
  if (!hidesOnClose) {
    return {
      phase: "running",
      lastTickAt,
      tickIntervalSecs,
      enabledCount,
      pausedReason: "close_exits",
      pausedReasonKey: "automations.runner.reason.closeExits",
      severity: "warn",
      hidesOnClose: false,
      launchAgentEnabled,
    };
  }

  if (!lastTickAt) {
    return {
      phase: "running",
      lastTickAt: null,
      tickIntervalSecs,
      enabledCount,
      pausedReason: "awaiting_tick",
      pausedReasonKey: "automations.runner.reason.awaitingTick",
      severity: "info",
      hidesOnClose,
      launchAgentEnabled,
    };
  }

  // Running with tray residency. Full quit still pauses — process-bound only.
  return {
    phase: "running",
    lastTickAt,
    tickIntervalSecs,
    enabledCount,
    pausedReason: "process_bound",
    pausedReasonKey: "automations.runner.reason.processBound",
    severity: "info",
    hidesOnClose,
    launchAgentEnabled,
  };
}

/** Product-truth rows: tray vs quit vs LaunchAgent (no fake daemon). */
export type AutomationsHonestyMatrixRowId = "tray" | "quit" | "launchAgent";

export type AutomationsHonestyMatrixRow = {
  id: AutomationsHonestyMatrixRowId;
  titleKey:
    | "automations.honesty.trayTitle"
    | "automations.honesty.quitTitle"
    | "automations.honesty.launchAgentTitle";
  bodyKey:
    | "automations.honesty.trayBody"
    | "automations.honesty.quitBody"
    | "automations.honesty.launchAgentBody";
};

/**
 * Fixed honesty matrix for Scheduled tasks background panel.
 * LaunchAgent row is always included so non-macOS still reads the limit
 * ("optional / macOS"); callers may hide it when unsupported.
 */
export function automationsHonestyMatrix(input?: {
  launchAgentSupported?: boolean;
}): AutomationsHonestyMatrixRow[] {
  const rows: AutomationsHonestyMatrixRow[] = [
    {
      id: "tray",
      titleKey: "automations.honesty.trayTitle",
      bodyKey: "automations.honesty.trayBody",
    },
    {
      id: "quit",
      titleKey: "automations.honesty.quitTitle",
      bodyKey: "automations.honesty.quitBody",
    },
  ];
  if (input?.launchAgentSupported !== false) {
    rows.push({
      id: "launchAgent",
      titleKey: "automations.honesty.launchAgentTitle",
      bodyKey: "automations.honesty.launchAgentBody",
    });
  }
  return rows;
}

export type LaunchAgentSoftFailAction = "enable" | "disable" | "reveal";

export type LaunchAgentSoftFail = {
  action: LaunchAgentSoftFailAction;
  titleKey: "automations.launchAgent.failTitle";
  bodyKey:
    | "automations.launchAgent.failEnable"
    | "automations.launchAgent.failDisable"
    | "automations.launchAgent.failReveal";
  /** Always remind: schedules still process-bound; not a daemon install. */
  honestyKey: "automations.launchAgent.failHonesty";
  detail: string;
};

/** Strip / normalize host errors for GlassModal soft-fail (never empty). */
export function formatLaunchAgentSoftFailDetail(err: unknown): string {
  let raw = "";
  if (err instanceof Error) raw = err.message;
  else if (typeof err === "string") raw = err;
  else if (err != null) raw = String(err);
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return "unknown error";
  // Cap length so a huge launchctl dump doesn't blow the modal.
  return t.length > 480 ? `${t.slice(0, 477)}…` : t;
}

/**
 * Build soft-fail payload for LaunchAgent install/remove/reveal failures.
 * Caller shows GlassModal and leaves toggle state from last successful status.
 */
export function launchAgentSoftFail(
  err: unknown,
  action: LaunchAgentSoftFailAction,
): LaunchAgentSoftFail {
  const bodyKey =
    action === "enable"
      ? "automations.launchAgent.failEnable"
      : action === "disable"
        ? "automations.launchAgent.failDisable"
        : "automations.launchAgent.failReveal";
  return {
    action,
    titleKey: "automations.launchAgent.failTitle",
    bodyKey,
    honestyKey: "automations.launchAgent.failHonesty",
    detail: formatLaunchAgentSoftFailDetail(err),
  };
}
