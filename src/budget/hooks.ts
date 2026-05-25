import type {
  BudgetHook,
  BudgetScaleSnapshot,
  BudgetSnapshot,
  BudgetWindow,
  BudgetWindowName,
  FiredBudgetHook,
  LinearBackoffConfig,
  WorkerBudgetReason,
} from "./types.js";

export type HookEvaluationInput = {
  snapshot: BudgetSnapshot;
  hasBacklog?: boolean;
};

export function windowFromSnapshot(
  snapshot: BudgetSnapshot,
  window: BudgetWindowName,
): BudgetWindow {
  return window === "weekly" ? snapshot.weekly : snapshot.session;
}

export function hookMatches(hook: BudgetHook, input: HookEvaluationInput): boolean {
  if (hook.requireBacklog && input.hasBacklog === false) return false;
  const window = windowFromSnapshot(input.snapshot, hook.window);
  if (hook.usedPercentGte !== undefined && window.usedPercent < hook.usedPercentGte) return false;
  if (hook.usedPercentLte !== undefined && window.usedPercent > hook.usedPercentLte) return false;
  if (hook.paceDeltaGte !== undefined && window.paceDelta < hook.paceDeltaGte) return false;
  if (hook.paceDeltaLte !== undefined && window.paceDelta > hook.paceDeltaLte) return false;
  if (
    hook.projectedUsedGte !== undefined &&
    (window.projectedUsedAtReset ?? window.usedPercent) < hook.projectedUsedGte
  ) {
    return false;
  }
  return true;
}

export function computeLinearBackoffScale(
  window: BudgetWindow,
  config: LinearBackoffConfig,
): number {
  if (!config.enabled) return 1;
  const used = window.usedPercent;
  if (used <= config.startUsedPercent) return 1;
  if (used >= config.stopUsedPercent) return config.minWorkerScale;
  const progress =
    (used - config.startUsedPercent) /
    Math.max(1, config.stopUsedPercent - config.startUsedPercent);
  return 1 - progress * (1 - config.minWorkerScale);
}

export function evaluateBudgetHooks(
  hooks: readonly BudgetHook[],
  input: HookEvaluationInput,
): FiredBudgetHook[] {
  const fired: FiredBudgetHook[] = [];
  for (const hook of hooks) {
    if (!hookMatches(hook, input)) continue;
    fired.push({
      id: hook.id,
      mode: hook.mode,
      detail: describeHook(hook, input.snapshot),
      ...(hook.workerScale !== undefined ? { workerScale: hook.workerScale } : {}),
      ...(hook.maxWorkers !== undefined ? { maxWorkers: hook.maxWorkers } : {}),
    });
  }
  return fired;
}

export function combineHookScales(
  hooks: readonly BudgetHook[],
  firedHooks: readonly FiredBudgetHook[],
): { throttleScale: number; releaseScale: number; maxWorkers?: number } {
  let throttleScale = 1;
  let releaseScale = 1;
  let maxWorkers: number | undefined;
  for (const hook of hooks) {
    if (!firedHooks.some((entry) => entry.id === hook.id)) continue;
    if (hook.mode === "throttle") {
      if (hook.workerScale !== undefined) {
        throttleScale = Math.min(throttleScale, hook.workerScale);
      }
      if (hook.maxWorkers !== undefined) {
        maxWorkers =
          maxWorkers === undefined ? hook.maxWorkers : Math.min(maxWorkers, hook.maxWorkers);
      }
    } else if (hook.mode === "release" && hook.workerScale !== undefined) {
      releaseScale = Math.max(releaseScale, hook.workerScale);
    }
  }
  return {
    throttleScale,
    releaseScale,
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
  };
}

export function deriveBudgetReason(options: {
  firedHooks: readonly FiredBudgetHook[];
  linearBackoffScale: number;
  effectiveScale: number;
  globalAvailableWorkers: number;
  recommendedWorkers: number;
}): WorkerBudgetReason {
  if (options.globalAvailableWorkers <= 0) return "global_pool_exhausted";
  if (options.recommendedWorkers <= 1) {
    if (
      options.firedHooks.some(
        (hook) => hook.id.includes("weekly_stop") || hook.id.includes("weekly_critical"),
      )
    ) {
      return "critical_weekly_usage";
    }
    if (
      options.firedHooks.some(
        (hook) => hook.id.includes("session_stop") || hook.id.includes("session_critical"),
      )
    ) {
      return "critical_session_usage";
    }
  }
  if (options.firedHooks.some((hook) => hook.mode === "release")) return "released";
  if (options.linearBackoffScale < 0.999) return "linear_backoff";
  if (options.firedHooks.some((hook) => hook.mode === "throttle" && hook.id.includes("weekly"))) {
    return "weekly_pressure";
  }
  if (options.firedHooks.some((hook) => hook.mode === "throttle" && hook.id.includes("session"))) {
    return "session_pressure";
  }
  if (options.effectiveScale < 0.999) return "ahead_of_pace";
  return "on_pace";
}

export function buildScaleSnapshot(options: {
  laneMaxWorkers: number;
  globalMaxWorkers: number;
  activeOAuthWorkers: number;
  globalAvailableWorkers: number;
  linearBackoffScale: number;
  throttleScale: number;
  releaseScale: number;
  paceScale: number;
  sessionScale: number;
  effectiveScale: number;
}): BudgetScaleSnapshot {
  return {
    laneMaxWorkers: options.laneMaxWorkers,
    globalMaxWorkers: options.globalMaxWorkers,
    activeOAuthWorkers: options.activeOAuthWorkers,
    globalAvailableWorkers: options.globalAvailableWorkers,
    linearBackoffScale: roundScale(options.linearBackoffScale),
    throttleScale: roundScale(options.throttleScale),
    releaseScale: roundScale(options.releaseScale),
    paceScale: roundScale(options.paceScale),
    sessionScale: roundScale(options.sessionScale),
    effectiveScale: roundScale(options.effectiveScale),
  };
}

function describeHook(hook: BudgetHook, snapshot: BudgetSnapshot): string {
  const window = windowFromSnapshot(snapshot, hook.window);
  const parts = [`${hook.window} window`];
  if (hook.usedPercentGte !== undefined) parts.push(`${Math.round(window.usedPercent)}% used`);
  if (hook.usedPercentLte !== undefined) parts.push(`at most ${hook.usedPercentLte}% used`);
  if (hook.paceDeltaGte !== undefined) parts.push(`pace ${formatSigned(window.paceDelta)}`);
  if (hook.paceDeltaLte !== undefined) parts.push(`pace ${formatSigned(window.paceDelta)}`);
  if (hook.projectedUsedGte !== undefined) {
    parts.push(`projected ${Math.round(window.projectedUsedAtReset ?? window.usedPercent)}%`);
  }
  if (hook.workerScale !== undefined) parts.push(`scale ${hook.workerScale}`);
  if (hook.maxWorkers !== undefined) parts.push(`cap ${hook.maxWorkers}`);
  return parts.join(", ");
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

function roundScale(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export const DEFAULT_BUDGET_HOOKS: BudgetHook[] = [
  {
    id: "weekly_stop",
    mode: "throttle",
    window: "weekly",
    usedPercentGte: 95,
    workerScale: 0,
    maxWorkers: 1,
  },
  {
    id: "weekly_throttle",
    mode: "throttle",
    window: "weekly",
    usedPercentGte: 85,
    workerScale: 0.5,
  },
  {
    id: "weekly_guard",
    mode: "throttle",
    window: "weekly",
    usedPercentGte: 70,
    workerScale: 0.75,
  },
  {
    id: "weekly_projected_stop",
    mode: "throttle",
    window: "weekly",
    projectedUsedGte: 98,
    workerScale: 0.25,
  },
  {
    id: "weekly_release",
    mode: "release",
    window: "weekly",
    usedPercentLte: 50,
    paceDeltaLte: -5,
    workerScale: 1,
    requireBacklog: true,
  },
  {
    id: "weekly_pace_release",
    mode: "release",
    window: "weekly",
    paceDeltaLte: -8,
    workerScale: 1,
    requireBacklog: true,
  },
  {
    id: "session_stop",
    mode: "throttle",
    window: "session",
    usedPercentGte: 90,
    workerScale: 0,
    maxWorkers: 1,
  },
  {
    id: "session_throttle",
    mode: "throttle",
    window: "session",
    usedPercentGte: 80,
    workerScale: 0.65,
  },
  {
    id: "pace_ahead_weekly",
    mode: "throttle",
    window: "weekly",
    paceDeltaGte: 5,
    workerScale: 0.5,
  },
  {
    id: "pace_ahead_session",
    mode: "throttle",
    window: "session",
    paceDeltaGte: 5,
    workerScale: 0.5,
  },
];

export const DEFAULT_LINEAR_BACKOFF: LinearBackoffConfig = {
  enabled: true,
  window: "weekly",
  startUsedPercent: 60,
  stopUsedPercent: 95,
  minWorkerScale: 0.1,
};
