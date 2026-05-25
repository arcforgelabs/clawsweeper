import { codexForcedLoginMethod } from "../codex-env.js";
import {
  CodexBarBudgetProvider,
  codexBarBudgetFailureMessage,
  codexBarBudgetRecoveryHint,
  type CodexBarBudgetProviderOptions,
} from "./codexbar-provider.js";
import {
  budgetAppliesToAuthMode,
  readBudgetConfig,
  resolveActiveOAuthWorkers,
  resolveBudgetConfig,
  type BudgetConfig,
  type BudgetRuntimeOptions,
} from "./config.js";
import {
  backlogNeededWorkers,
  recommendWorkersFromSnapshot,
  resolveEffectiveWorkerCount,
  type WorkerBudgetPlannerInput,
} from "./planner.js";
import {
  appendBudgetSummaryToGithubStepSummary,
  formatBudgetFailure,
  formatBudgetSummary,
} from "./summary.js";
import type { BudgetProvider, WorkerBudgetDecision } from "./types.js";

export type ResolveWorkerBudgetInput = {
  configuredMaxWorkers: number;
  concurrencyLimit?: number;
  dueBacklog?: number;
  batchSize?: number;
  hasBacklog?: boolean;
  activeOAuthWorkers?: number;
  config?: BudgetConfig;
  provider?: BudgetProvider;
  runtime?: BudgetRuntimeOptions;
};

export type ResolvedWorkerBudget = {
  enabled: boolean;
  configuredMaxWorkers: number;
  effectiveWorkers: number;
  decision: WorkerBudgetDecision;
  backlogNeededWorkers?: number;
};

export async function resolveWorkerBudget(
  input: ResolveWorkerBudgetInput,
): Promise<ResolvedWorkerBudget> {
  const runtime = input.runtime ?? {};
  const config = resolveBudgetConfig(input.config ?? readBudgetConfig(), runtime);
  const configuredMaxWorkers = Math.max(0, Math.floor(input.configuredMaxWorkers));
  const activeOAuthWorkers = input.activeOAuthWorkers ?? resolveActiveOAuthWorkers(runtime);
  const codexLoginMethod = runtime.codexLoginMethod ?? codexForcedLoginMethod();

  if (!config.enabled || !budgetAppliesToAuthMode(config, codexLoginMethod)) {
    return {
      enabled: false,
      configuredMaxWorkers,
      effectiveWorkers: configuredMaxWorkers,
      decision: {
        recommendedWorkers: configuredMaxWorkers,
        reason: "disabled",
        detail: config.enabled
          ? `Budget is limited to OAuth runs; current Codex login method is ${codexLoginMethod}.`
          : "Dynamic Codex OAuth budget is disabled.",
      },
    };
  }

  const codexbarBin = runtime.codexbarBin ?? process.env.CLAWSWEEPER_CODEXBAR_BIN;
  const provider =
    input.provider ??
    (codexbarBin ? new CodexBarBudgetProvider({ codexbarBin }) : new CodexBarBudgetProvider());

  try {
    const snapshot = await provider.fetchSnapshot();
    const plannerInput: WorkerBudgetPlannerInput = {
      configuredMaxWorkers,
      activeOAuthWorkers,
      hasBacklog: input.hasBacklog ?? (input.dueBacklog ?? 0) > 0,
      snapshot,
      config,
    };
    if (input.concurrencyLimit !== undefined) {
      plannerInput.concurrencyLimit = input.concurrencyLimit;
    }
    const decision = recommendWorkersFromSnapshot(plannerInput);
    const backlog =
      input.dueBacklog !== undefined && input.batchSize !== undefined
        ? backlogNeededWorkers(input.dueBacklog, input.batchSize, configuredMaxWorkers)
        : undefined;
    const effectiveInput: Parameters<typeof resolveEffectiveWorkerCount>[0] = {
      configuredMaxWorkers,
      budgetRecommendedWorkers: decision.recommendedWorkers,
    };
    if (input.concurrencyLimit !== undefined) {
      effectiveInput.concurrencyLimit = input.concurrencyLimit;
    }
    if (backlog !== undefined) {
      effectiveInput.backlogNeededWorkers = backlog;
    }
    const effectiveWorkers = resolveEffectiveWorkerCount(effectiveInput);
    return {
      enabled: true,
      configuredMaxWorkers,
      effectiveWorkers,
      decision,
      ...(backlog !== undefined ? { backlogNeededWorkers: backlog } : {}),
    };
  } catch (error) {
    if (config.failClosed) {
      throw new BudgetProviderUnavailableError(error, config, runtime.codexbarBin);
    }
    const effectiveInput: Parameters<typeof resolveEffectiveWorkerCount>[0] = {
      configuredMaxWorkers,
      budgetRecommendedWorkers: configuredMaxWorkers,
    };
    if (input.concurrencyLimit !== undefined) {
      effectiveInput.concurrencyLimit = input.concurrencyLimit;
    }
    const effectiveWorkers = resolveEffectiveWorkerCount(effectiveInput);
    return {
      enabled: true,
      configuredMaxWorkers,
      effectiveWorkers,
      decision: {
        recommendedWorkers: configuredMaxWorkers,
        reason: "provider_unavailable",
        detail: codexBarBudgetFailureMessage(error),
        providerError: codexBarBudgetFailureMessage(error),
      },
    };
  }
}

export class BudgetProviderUnavailableError extends Error {
  readonly failClosed: boolean;
  readonly recoveryHint: string;

  constructor(error: unknown, config: BudgetConfig, codexbarBin?: string) {
    super(
      formatBudgetFailure({
        error,
        failClosed: config.failClosed,
        ...(codexbarBin ? { codexbarBin } : {}),
      }),
    );
    this.name = "BudgetProviderUnavailableError";
    this.failClosed = config.failClosed;
    this.recoveryHint = codexBarBudgetRecoveryHint(codexbarBin);
  }
}

export async function logBudgetSummary(
  resolved: ResolvedWorkerBudget,
  config: BudgetConfig = readBudgetConfig(),
): Promise<void> {
  if (!resolved.enabled) {
    console.error(`[budget] ${resolved.decision.detail}`);
    return;
  }
  const summary = formatBudgetSummary({
    decision: resolved.decision,
    effectiveWorkers: resolved.effectiveWorkers,
    configuredMaxWorkers: resolved.configuredMaxWorkers,
    config,
  });
  console.error(`[budget] ${summary.replaceAll("\n", "\n[budget] ")}`);
  await appendBudgetSummaryToGithubStepSummary(`\n${summary}\n`);
}

export {
  CodexBarBudgetProvider,
  type CodexBarBudgetProviderOptions,
  parseCodexBarUsageJson,
} from "./codexbar-provider.js";
export {
  readBudgetConfig,
  resolveBudgetConfig,
  resolveActiveOAuthWorkers,
  budgetAppliesToAuthMode,
  type BudgetConfig,
  type BudgetRuntimeOptions,
} from "./config.js";
export {
  DEFAULT_BUDGET_HOOKS,
  DEFAULT_LINEAR_BACKOFF,
  computeLinearBackoffScale,
  evaluateBudgetHooks,
  hookMatches,
} from "./hooks.js";
export { computeBudgetWindow, paceLabel, parseBudgetResetTime } from "./pace.js";
export {
  backlogNeededWorkers,
  recommendWorkersFromSnapshot,
  resolveEffectiveWorkerCount,
  workerBudgetReasonLabel,
} from "./planner.js";
export { formatBudgetFailure, formatBudgetSummary, formatBudgetWindowLine } from "./summary.js";
export type {
  BudgetHook,
  BudgetProvider,
  BudgetScaleSnapshot,
  BudgetSnapshot,
  BudgetWindow,
  FiredBudgetHook,
  LinearBackoffConfig,
  WorkerBudgetDecision,
  WorkerBudgetReason,
} from "./types.js";
