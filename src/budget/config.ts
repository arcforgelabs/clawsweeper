import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BUDGET_HOOKS, DEFAULT_LINEAR_BACKOFF } from "./hooks.js";
import type { BudgetHook, BudgetPaceConfig, LinearBackoffConfig } from "./types.js";

export type BudgetConfig = {
  enabled: boolean;
  provider: "codexbar";
  failClosed: boolean;
  oauthOnly: boolean;
  globalMaxWorkers: number;
  minWorkers: number;
  primaryWindow: "weekly" | "session";
  hooks: BudgetHook[];
  linearBackoff: LinearBackoffConfig;
  pace: BudgetPaceConfig;
};

export type BudgetRuntimeOptions = {
  codexbarBin?: string;
  codexLoginMethod?: string;
  activeOAuthWorkers?: number;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_PACE: BudgetPaceConfig = {
  aheadThresholdPercent: 5,
  behindThresholdPercent: -5,
  aheadScalePerPoint: 0.02,
  behindReleasePerPoint: 0.01,
};

const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  enabled: false,
  provider: "codexbar",
  failClosed: true,
  oauthOnly: true,
  globalMaxWorkers: 15,
  minWorkers: 0,
  primaryWindow: "weekly",
  hooks: DEFAULT_BUDGET_HOOKS,
  linearBackoff: DEFAULT_LINEAR_BACKOFF,
  pace: DEFAULT_PACE,
};

export function readBudgetConfig(
  filePath = join(repoRoot(), "config", "automation-limits.json"),
): BudgetConfig {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return validateBudgetConfig(parsed);
}

export function resolveBudgetConfig(
  config: BudgetConfig,
  options: BudgetRuntimeOptions = {},
): BudgetConfig {
  const env = options.env ?? process.env;
  const enabled = resolveBudgetEnabledFromEnv(config, env);
  const failClosed = env.CLAWSWEEPER_BUDGET_FAIL_CLOSED === "0" ? false : config.failClosed;
  return {
    ...config,
    enabled,
    failClosed,
  };
}

function resolveBudgetEnabledFromEnv(config: BudgetConfig, env: NodeJS.ProcessEnv): boolean {
  const raw = env.CLAWSWEEPER_BUDGET_ENABLED;
  if (typeof raw !== "string" || !raw.trim()) {
    return config.enabled;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  return config.enabled;
}

export function resolveActiveOAuthWorkers(options: BudgetRuntimeOptions = {}): number {
  if (options.activeOAuthWorkers !== undefined) {
    return Math.max(0, Math.floor(options.activeOAuthWorkers));
  }
  const env = options.env ?? process.env;
  const raw = env.CLAWSWEEPER_ACTIVE_OAUTH_WORKERS;
  if (typeof raw !== "string" || !raw.trim()) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function budgetAppliesToAuthMode(config: BudgetConfig, codexLoginMethod: string): boolean {
  if (!config.oauthOnly) return true;
  const normalized = codexLoginMethod.trim().toLowerCase();
  return normalized !== "api" && normalized !== "api_key" && normalized !== "api-key";
}

function validateBudgetConfig(root: unknown): BudgetConfig {
  if (!isRecord(root)) return DEFAULT_BUDGET_CONFIG;
  const workersMax = isRecord(root.workers) ? positiveInteger(root.workers, "max", 15) : 15;
  if (!isRecord(root.budget)) {
    return { ...DEFAULT_BUDGET_CONFIG, globalMaxWorkers: workersMax };
  }
  const budget = root.budget;
  return {
    enabled: booleanField(budget, "enabled", DEFAULT_BUDGET_CONFIG.enabled),
    provider: budget.provider === "codexbar" ? "codexbar" : DEFAULT_BUDGET_CONFIG.provider,
    failClosed: booleanField(budget, "fail_closed", DEFAULT_BUDGET_CONFIG.failClosed),
    oauthOnly: booleanField(budget, "oauth_only", DEFAULT_BUDGET_CONFIG.oauthOnly),
    globalMaxWorkers: positiveInteger(budget, "global_max_workers", workersMax),
    minWorkers: nonNegativeInteger(budget, "min_workers", DEFAULT_BUDGET_CONFIG.minWorkers),
    primaryWindow: budget.primary_window === "session" ? "session" : "weekly",
    hooks: parseHooks(budget.hooks),
    linearBackoff: parseLinearBackoff(budget.linear_backoff),
    pace: parsePace(budget.pace),
  };
}

function parseHooks(value: unknown): BudgetHook[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_BUDGET_HOOKS;
  const hooks: BudgetHook[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const mode = entry.mode === "release" ? "release" : "throttle";
    const window = entry.window === "session" ? "session" : "weekly";
    if (!id) continue;
    const hook: BudgetHook = { id, mode, window };
    const usedPercentGte = optionalNumber(entry.used_percent_gte);
    if (usedPercentGte !== undefined) hook.usedPercentGte = usedPercentGte;
    const usedPercentLte = optionalNumber(entry.used_percent_lte);
    if (usedPercentLte !== undefined) hook.usedPercentLte = usedPercentLte;
    const paceDeltaGte = optionalNumber(entry.pace_delta_gte);
    if (paceDeltaGte !== undefined) hook.paceDeltaGte = paceDeltaGte;
    const paceDeltaLte = optionalNumber(entry.pace_delta_lte);
    if (paceDeltaLte !== undefined) hook.paceDeltaLte = paceDeltaLte;
    const projectedUsedGte = optionalNumber(entry.projected_used_gte);
    if (projectedUsedGte !== undefined) hook.projectedUsedGte = projectedUsedGte;
    const workerScale = optionalNumber(entry.worker_scale);
    if (workerScale !== undefined) hook.workerScale = workerScale;
    const maxWorkers = optionalInteger(entry.max_workers);
    if (maxWorkers !== undefined) hook.maxWorkers = maxWorkers;
    const minWorkers = optionalInteger(entry.min_workers);
    if (minWorkers !== undefined) hook.minWorkers = minWorkers;
    if (entry.require_backlog === true) hook.requireBacklog = true;
    hooks.push(hook);
  }
  return hooks.length > 0 ? hooks : DEFAULT_BUDGET_HOOKS;
}

function parseLinearBackoff(value: unknown): LinearBackoffConfig {
  if (!isRecord(value)) return DEFAULT_LINEAR_BACKOFF;
  return {
    enabled: booleanField(value, "enabled", DEFAULT_LINEAR_BACKOFF.enabled),
    window: value.window === "session" ? "session" : "weekly",
    startUsedPercent: percentFieldValue(
      value.start_used_percent,
      DEFAULT_LINEAR_BACKOFF.startUsedPercent,
    ),
    stopUsedPercent: percentFieldValue(
      value.stop_used_percent,
      DEFAULT_LINEAR_BACKOFF.stopUsedPercent,
    ),
    minWorkerScale: scaleFieldValue(value.min_worker_scale, DEFAULT_LINEAR_BACKOFF.minWorkerScale),
  };
}

function parsePace(value: unknown): BudgetPaceConfig {
  if (!isRecord(value)) return DEFAULT_PACE;
  return {
    aheadThresholdPercent: numberFieldValue(
      value.ahead_threshold_percent,
      DEFAULT_PACE.aheadThresholdPercent,
    ),
    behindThresholdPercent: numberFieldValue(
      value.behind_threshold_percent,
      DEFAULT_PACE.behindThresholdPercent,
    ),
    aheadScalePerPoint: scaleFieldValue(
      value.ahead_scale_per_point,
      DEFAULT_PACE.aheadScalePerPoint,
    ),
    behindReleasePerPoint: scaleFieldValue(
      value.behind_release_per_point,
      DEFAULT_PACE.behindReleasePerPoint,
    ),
  };
}

function booleanField(root: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof root[key] === "boolean" ? root[key] : fallback;
}

function positiveInteger(root: Record<string, unknown>, key: string, fallback: number): number {
  const value = root[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function nonNegativeInteger(root: Record<string, unknown>, key: string, fallback: number): number {
  const value = root[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function percentFieldValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : fallback;
}

function numberFieldValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function scaleFieldValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}
