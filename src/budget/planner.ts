import type { BudgetConfig } from "./config.js";
import {
  buildScaleSnapshot,
  combineHookScales,
  computeLinearBackoffScale,
  deriveBudgetReason,
  evaluateBudgetHooks,
  windowFromSnapshot,
} from "./hooks.js";
import type { BudgetSnapshot, WorkerBudgetDecision, WorkerBudgetReason } from "./types.js";

export type WorkerBudgetPlannerInput = {
  configuredMaxWorkers: number;
  activeOAuthWorkers?: number;
  concurrencyLimit?: number;
  backlogNeededWorkers?: number;
  hasBacklog?: boolean;
  snapshot: BudgetSnapshot;
  config: BudgetConfig;
};

export function recommendWorkersFromSnapshot(
  input: WorkerBudgetPlannerInput,
): WorkerBudgetDecision {
  const { snapshot, config } = input;
  const laneMaxWorkers = Math.max(0, Math.floor(input.configuredMaxWorkers));
  const activeOAuthWorkers = Math.max(0, Math.floor(input.activeOAuthWorkers ?? 0));
  const globalAvailableWorkers = Math.max(0, config.globalMaxWorkers - activeOAuthWorkers);
  const baseMaxWorkers = Math.min(laneMaxWorkers, globalAvailableWorkers);

  if (globalAvailableWorkers <= 0) {
    return {
      recommendedWorkers: 0,
      reason: "global_pool_exhausted",
      detail: `Global OAuth pool is full (${activeOAuthWorkers}/${config.globalMaxWorkers} workers already active).`,
      snapshot,
      firedHooks: [],
      scales: buildScaleSnapshot({
        laneMaxWorkers,
        globalMaxWorkers: config.globalMaxWorkers,
        activeOAuthWorkers,
        globalAvailableWorkers,
        linearBackoffScale: 0,
        throttleScale: 0,
        releaseScale: 0,
        paceScale: 0,
        sessionScale: 0,
        effectiveScale: 0,
      }),
    };
  }

  const hookInput = {
    snapshot,
    ...(input.hasBacklog !== undefined ? { hasBacklog: input.hasBacklog } : {}),
  };
  const firedHooks = evaluateBudgetHooks(config.hooks, hookInput);
  const linearWindow = windowFromSnapshot(
    snapshot,
    config.linearBackoff.window ?? config.primaryWindow,
  );
  const linearBackoffScale = computeLinearBackoffScale(linearWindow, config.linearBackoff);
  const {
    throttleScale,
    releaseScale,
    maxWorkers: hookMaxWorkers,
  } = combineHookScales(config.hooks, firedHooks);

  const primaryWindow = windowFromSnapshot(snapshot, config.primaryWindow);
  let paceScale = 1;
  if (primaryWindow.paceDelta > config.pace.aheadThresholdPercent) {
    const excess = primaryWindow.paceDelta - config.pace.aheadThresholdPercent;
    paceScale = Math.max(
      config.linearBackoff.minWorkerScale,
      1 - excess * config.pace.aheadScalePerPoint,
    );
  } else if (
    primaryWindow.paceDelta < config.pace.behindThresholdPercent &&
    input.hasBacklog !== false
  ) {
    const deficit = config.pace.behindThresholdPercent - primaryWindow.paceDelta;
    paceScale = Math.min(1, 1 + deficit * config.pace.behindReleasePerPoint);
  }

  let sessionScale = 1;
  if (snapshot.session.paceDelta > config.pace.aheadThresholdPercent) {
    const excess = snapshot.session.paceDelta - config.pace.aheadThresholdPercent;
    sessionScale = Math.max(
      config.linearBackoff.minWorkerScale,
      1 - excess * config.pace.aheadScalePerPoint,
    );
  }
  if (snapshot.session.usedPercent >= 90) {
    sessionScale = Math.min(sessionScale, 0.05);
  } else if (snapshot.session.usedPercent >= 80) {
    sessionScale = Math.min(sessionScale, 0.65);
  }

  const weeklyConstrainedScale = Math.min(linearBackoffScale, throttleScale, paceScale);
  const constrainedScale = Math.min(weeklyConstrainedScale, sessionScale);
  const releaseHooksFired = firedHooks.some((hook) => hook.mode === "release");
  const effectiveScale = releaseHooksFired
    ? Math.min(sessionScale, Math.min(1, Math.max(weeklyConstrainedScale, releaseScale)))
    : constrainedScale;

  let recommendedWorkers = Math.floor(baseMaxWorkers * effectiveScale);
  if (hookMaxWorkers !== undefined) {
    recommendedWorkers = Math.min(recommendedWorkers, hookMaxWorkers);
  }
  for (const hook of config.hooks) {
    if (!firedHooks.some((entry) => entry.id === hook.id)) continue;
    if (hook.minWorkers !== undefined) {
      recommendedWorkers = Math.max(recommendedWorkers, hook.minWorkers);
    }
  }
  recommendedWorkers = Math.max(config.minWorkers, recommendedWorkers);
  recommendedWorkers = Math.min(recommendedWorkers, baseMaxWorkers);

  const reason = deriveBudgetReason({
    firedHooks,
    linearBackoffScale,
    effectiveScale,
    globalAvailableWorkers,
    recommendedWorkers,
  });
  const detail = buildDecisionDetail({
    reason,
    firedHooks,
    linearBackoffScale,
    effectiveScale,
    baseMaxWorkers,
    activeOAuthWorkers,
    globalMaxWorkers: config.globalMaxWorkers,
    primaryWindow,
  });

  return {
    recommendedWorkers,
    reason,
    detail,
    snapshot,
    firedHooks,
    scales: buildScaleSnapshot({
      laneMaxWorkers,
      globalMaxWorkers: config.globalMaxWorkers,
      activeOAuthWorkers,
      globalAvailableWorkers,
      linearBackoffScale,
      throttleScale,
      releaseScale,
      paceScale,
      sessionScale,
      effectiveScale,
    }),
  };
}

export function resolveEffectiveWorkerCount(options: {
  configuredMaxWorkers: number;
  budgetRecommendedWorkers: number;
  concurrencyLimit?: number;
  backlogNeededWorkers?: number;
}): number {
  const limits = [
    Math.max(0, Math.floor(options.configuredMaxWorkers)),
    Math.max(0, Math.floor(options.budgetRecommendedWorkers)),
  ];
  if (options.concurrencyLimit !== undefined) {
    limits.push(Math.max(0, Math.floor(options.concurrencyLimit)));
  }
  if (options.backlogNeededWorkers !== undefined) {
    limits.push(Math.max(0, Math.floor(options.backlogNeededWorkers)));
  }
  return Math.min(...limits);
}

export function backlogNeededWorkers(
  dueBacklog: number,
  batchSize: number,
  shardCap: number,
): number {
  const batch = Math.max(1, Math.floor(batchSize));
  const cap = Math.max(0, Math.floor(shardCap));
  if (cap === 0) return 0;
  if (dueBacklog <= 0) return 0;
  return Math.max(1, Math.min(cap, Math.ceil(dueBacklog / batch)));
}

function buildDecisionDetail(options: {
  reason: WorkerBudgetReason;
  firedHooks: WorkerBudgetDecision["firedHooks"];
  linearBackoffScale: number;
  effectiveScale: number;
  baseMaxWorkers: number;
  activeOAuthWorkers: number;
  globalMaxWorkers: number;
  primaryWindow: BudgetSnapshot["weekly"];
}): string {
  const hookSummary =
    options.firedHooks && options.firedHooks.length > 0
      ? `Hooks: ${options.firedHooks.map((hook) => hook.id).join(", ")}.`
      : "Hooks: none.";
  const poolSummary = `Global pool ${options.activeOAuthWorkers}/${options.globalMaxWorkers} active, lane base ${options.baseMaxWorkers}.`;
  const scaleSummary = `Linear scale ${formatScale(options.linearBackoffScale)}, effective scale ${formatScale(options.effectiveScale)} on ${options.primaryWindow.name} (${Math.round(options.primaryWindow.usedPercent)}% used, pace ${formatSigned(options.primaryWindow.paceDelta)}).`;
  switch (options.reason) {
    case "global_pool_exhausted":
      return `${poolSummary} No OAuth workers remain for this lane.`;
    case "released":
      return `${hookSummary} ${poolSummary} Under-utilization release restored lane allowance. ${scaleSummary}`;
    case "linear_backoff":
      return `${hookSummary} ${poolSummary} Weekly linear backoff reduced concurrency. ${scaleSummary}`;
    case "weekly_pressure":
    case "session_pressure":
    case "critical_weekly_usage":
    case "critical_session_usage":
    case "ahead_of_pace":
      return `${hookSummary} ${poolSummary} Budget hooks reduced concurrency. ${scaleSummary}`;
    default:
      return `${hookSummary} ${poolSummary} ${scaleSummary}`;
  }
}

export function workerBudgetReasonLabel(reason: WorkerBudgetReason): string {
  switch (reason) {
    case "disabled":
      return "budget disabled";
    case "on_pace":
      return "on pace";
    case "released":
      return "constraints released";
    case "linear_backoff":
      return "linear backoff";
    case "ahead_of_pace":
      return "ahead of pace";
    case "behind_pace":
      return "behind pace";
    case "weekly_pressure":
      return "weekly pressure";
    case "session_pressure":
      return "session pressure";
    case "critical_session_usage":
      return "critical session usage";
    case "critical_weekly_usage":
      return "critical weekly usage";
    case "global_pool_exhausted":
      return "global pool exhausted";
    case "provider_unavailable":
      return "provider unavailable";
  }
}

function formatScale(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}
