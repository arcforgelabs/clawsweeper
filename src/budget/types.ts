export type BudgetWindowName = "session" | "weekly";

export type BudgetWindow = {
  name: BudgetWindowName;
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
  elapsedPercent: number;
  paceDelta: number;
  projectedUsedAtReset?: number;
};

export type BudgetSnapshot = {
  provider: "codexbar";
  source: string;
  observedAt: string;
  loginMethod?: string;
  session: BudgetWindow;
  weekly: BudgetWindow;
};

export type BudgetHookMode = "throttle" | "release";

export type BudgetHook = {
  id: string;
  mode: BudgetHookMode;
  window: BudgetWindowName;
  usedPercentGte?: number;
  usedPercentLte?: number;
  paceDeltaGte?: number;
  paceDeltaLte?: number;
  projectedUsedGte?: number;
  workerScale?: number;
  maxWorkers?: number;
  minWorkers?: number;
  requireBacklog?: boolean;
};

export type LinearBackoffConfig = {
  enabled: boolean;
  window: BudgetWindowName;
  startUsedPercent: number;
  stopUsedPercent: number;
  minWorkerScale: number;
};

export type BudgetPaceConfig = {
  aheadThresholdPercent: number;
  behindThresholdPercent: number;
  aheadScalePerPoint: number;
  behindReleasePerPoint: number;
};

export type FiredBudgetHook = {
  id: string;
  mode: BudgetHookMode;
  detail: string;
  workerScale?: number;
  maxWorkers?: number;
};

export type BudgetScaleSnapshot = {
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
};

export type WorkerBudgetReason =
  | "disabled"
  | "on_pace"
  | "released"
  | "linear_backoff"
  | "ahead_of_pace"
  | "behind_pace"
  | "weekly_pressure"
  | "session_pressure"
  | "critical_session_usage"
  | "critical_weekly_usage"
  | "global_pool_exhausted"
  | "provider_unavailable";

export type WorkerBudgetDecision = {
  recommendedWorkers: number;
  reason: WorkerBudgetReason;
  detail: string;
  snapshot?: BudgetSnapshot;
  providerError?: string;
  firedHooks?: FiredBudgetHook[];
  scales?: BudgetScaleSnapshot;
};

export type BudgetProvider = {
  readonly name: string;
  fetchSnapshot(): Promise<BudgetSnapshot>;
};
