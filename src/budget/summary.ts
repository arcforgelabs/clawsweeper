import { codexBarBudgetFailureMessage, codexBarBudgetRecoveryHint } from "./codexbar-provider.js";
import type { BudgetConfig } from "./config.js";
import { paceLabel } from "./pace.js";
import type { BudgetSnapshot, WorkerBudgetDecision } from "./types.js";
import { workerBudgetReasonLabel } from "./planner.js";

export function formatBudgetWindowLine(
  window: BudgetSnapshot["session"],
  config: BudgetConfig,
): string {
  const pace = paceLabel(
    window.paceDelta,
    config.pace.aheadThresholdPercent,
    config.pace.behindThresholdPercent,
  );
  const projected =
    window.projectedUsedAtReset !== undefined
      ? `, projected ${Math.round(window.projectedUsedAtReset)}%`
      : "";
  return `${capitalize(window.name)}: ${Math.round(window.usedPercent)}% used, resets at ${window.resetsAt}, pace ${formatSignedPercent(window.paceDelta)} (${pace})${projected}.`;
}

export function formatBudgetSummary(options: {
  decision: WorkerBudgetDecision;
  effectiveWorkers: number;
  configuredMaxWorkers: number;
  config: BudgetConfig;
}): string {
  const lines = ["Codex OAuth budget:"];
  if (options.decision.snapshot) {
    lines.push(`- ${formatBudgetWindowLine(options.decision.snapshot.weekly, options.config)}`);
    lines.push(`- ${formatBudgetWindowLine(options.decision.snapshot.session, options.config)}`);
  }
  if (options.decision.scales) {
    const scales = options.decision.scales;
    lines.push(
      `- Global pool: ${scales.activeOAuthWorkers}/${scales.globalMaxWorkers} active, ${scales.globalAvailableWorkers} available for this lane (lane max ${scales.laneMaxWorkers}).`,
    );
    lines.push(
      `- Scales: linear ${formatScale(scales.linearBackoffScale)}, throttle ${formatScale(scales.throttleScale)}, release ${formatScale(scales.releaseScale)}, pace ${formatScale(scales.paceScale)}, session ${formatScale(scales.sessionScale)}, effective ${formatScale(scales.effectiveScale)}.`,
    );
  }
  if (options.decision.firedHooks && options.decision.firedHooks.length > 0) {
    lines.push(
      `- Triggered hooks: ${options.decision.firedHooks.map((hook) => hook.id).join(", ")}.`,
    );
  }
  lines.push(`- Recommended workers: ${options.decision.recommendedWorkers}.`);
  lines.push(
    `- Effective workers: ${options.effectiveWorkers} (configured max ${options.configuredMaxWorkers}, global cap ${options.config.globalMaxWorkers}).`,
  );
  lines.push(
    `- Reason: ${workerBudgetReasonLabel(options.decision.reason)}${options.decision.detail ? ` — ${options.decision.detail}` : ""}.`,
  );
  return lines.join("\n");
}

export function formatBudgetFailure(options: {
  error: unknown;
  failClosed: boolean;
  codexbarBin?: string;
}): string {
  const lines = [
    codexBarBudgetFailureMessage(options.error),
    options.failClosed
      ? "OAuth budget mode is fail-closed, so no ClawSweeper workers were launched."
      : "OAuth budget provider failed; falling back to the static worker ceiling.",
    codexBarBudgetRecoveryHint(options.codexbarBin),
  ];
  return lines.join("\n");
}

export async function appendBudgetSummaryToGithubStepSummary(summary: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(path, `\n${summary}\n`);
  } catch {
    // Best-effort reporting only.
  }
}

function formatSignedPercent(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

function formatScale(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
