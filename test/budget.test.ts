import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexBarBudgetProvider,
  computeBudgetWindow,
  computeLinearBackoffScale,
  DEFAULT_LINEAR_BACKOFF,
  parseCodexBarUsageJson,
  readBudgetConfig,
  recommendWorkersFromSnapshot,
  resolveActiveOAuthWorkers,
  resolveBudgetConfig,
  resolveEffectiveWorkerCount,
  resolveWorkerBudget,
  workerBudgetReasonLabel,
  type BudgetConfig,
} from "../dist/budget/index.js";

const SAMPLE_USAGE = JSON.stringify([
  {
    provider: "codex",
    source: "codex-cli",
    usage: {
      loginMethod: "pro",
      primary: {
        usedPercent: 48,
        windowMinutes: 300,
        resetsAt: "2026-05-25T18:00:00.000Z",
      },
      secondary: {
        usedPercent: 15,
        windowMinutes: 10080,
        resetsAt: "2026-06-01T00:00:00.000Z",
      },
      updatedAt: "2026-05-25T13:00:00.000Z",
    },
  },
]);

const TEST_CONFIG: BudgetConfig = readBudgetConfig();

const NOW = new Date("2026-05-25T13:00:00.000Z");

function snapshotFromUsage(stdout = SAMPLE_USAGE) {
  return parseCodexBarUsageJson(stdout, NOW);
}

test("parseCodexBarUsageJson parses valid CodexBar JSON", () => {
  const snapshot = snapshotFromUsage();
  assert.equal(snapshot.provider, "codexbar");
  assert.equal(snapshot.source, "codex-cli");
  assert.equal(snapshot.loginMethod, "pro");
  assert.equal(snapshot.session.usedPercent, 48);
  assert.equal(snapshot.weekly.usedPercent, 15);
});

test("parseCodexBarUsageJson rejects missing primary or secondary usage windows", () => {
  assert.throws(
    () =>
      parseCodexBarUsageJson(
        JSON.stringify([
          {
            provider: "codex",
            usage: { loginMethod: "pro", primary: null, secondary: { usedPercent: 1 } },
          },
        ]),
        NOW,
      ),
    /missing Codex primary usage window/,
  );
});

test("parseCodexBarUsageJson rejects API-key auth for OAuth budget mode", () => {
  assert.throws(
    () =>
      parseCodexBarUsageJson(
        JSON.stringify([
          {
            provider: "codex",
            usage: {
              loginMethod: "api",
              primary: { usedPercent: 1, windowMinutes: 300, resetsAt: "2026-05-25T18:00:00.000Z" },
              secondary: {
                usedPercent: 1,
                windowMinutes: 10080,
                resetsAt: "2026-06-01T00:00:00.000Z",
              },
            },
          },
        ]),
        NOW,
      ),
    /API-key auth instead of subscription OAuth/,
  );
});

test("CodexBarBudgetProvider surfaces missing codexbar and command failures", async () => {
  await assert.rejects(
    () =>
      new CodexBarBudgetProvider({
        commandRunner: async () => {
          throw new Error("spawn ENOENT");
        },
      }).fetchSnapshot(),
    /spawn ENOENT/,
  );
});

test("computeBudgetWindow classifies ahead, behind, and on pace", () => {
  const ahead = computeBudgetWindow(
    "session",
    80,
    300,
    "2026-05-25T18:00:00.000Z",
    new Date("2026-05-25T14:00:00.000Z"),
  );
  assert.ok(ahead.paceDelta > 5);
  const behind = computeBudgetWindow(
    "session",
    10,
    300,
    "2026-05-25T18:00:00.000Z",
    new Date("2026-05-25T14:00:00.000Z"),
  );
  assert.ok(behind.paceDelta < -5);
});

test("computeLinearBackoffScale ramps down weekly usage between start and stop", () => {
  const healthy = computeLinearBackoffScale(
    {
      name: "weekly",
      usedPercent: 50,
      windowMinutes: 10080,
      resetsAt: "x",
      elapsedPercent: 0,
      paceDelta: 0,
    },
    DEFAULT_LINEAR_BACKOFF,
  );
  assert.equal(healthy, 1);
  const pressured = computeLinearBackoffScale(
    {
      name: "weekly",
      usedPercent: 88,
      windowMinutes: 10080,
      resetsAt: "x",
      elapsedPercent: 0,
      paceDelta: 0,
    },
    DEFAULT_LINEAR_BACKOFF,
  );
  assert.ok(pressured < 0.35 && pressured > 0.2);
});

test("recommendWorkersFromSnapshot allows configured max when healthy", () => {
  const snapshot = snapshotFromUsage();
  snapshot.session.paceDelta = 1;
  snapshot.weekly.paceDelta = -1;
  snapshot.weekly.projectedUsedAtReset = 40;
  const decision = recommendWorkersFromSnapshot({
    configuredMaxWorkers: 10,
    snapshot,
    config: TEST_CONFIG,
    hasBacklog: true,
  });
  assert.equal(decision.recommendedWorkers, 10);
  assert.equal(decision.reason, "on_pace");
});

test("recommendWorkersFromSnapshot reduces workers for critical weekly usage", () => {
  const snapshot = snapshotFromUsage();
  snapshot.weekly.usedPercent = 96;
  snapshot.weekly.projectedUsedAtReset = 100;
  const decision = recommendWorkersFromSnapshot({
    configuredMaxWorkers: 10,
    snapshot,
    config: TEST_CONFIG,
  });
  assert.ok(decision.recommendedWorkers <= 1);
  assert.equal(decision.reason, "critical_weekly_usage");
});

test("recommendWorkersFromSnapshot reduces workers for critical session usage", () => {
  const snapshot = snapshotFromUsage();
  snapshot.session.usedPercent = 92;
  snapshot.weekly.projectedUsedAtReset = 40;
  const decision = recommendWorkersFromSnapshot({
    configuredMaxWorkers: 10,
    snapshot,
    config: TEST_CONFIG,
  });
  assert.ok(decision.recommendedWorkers <= 1);
  assert.equal(decision.reason, "critical_session_usage");
});

test("recommendWorkersFromSnapshot applies weekly linear backoff under pressure", () => {
  const snapshot = snapshotFromUsage();
  snapshot.weekly.usedPercent = 88;
  snapshot.weekly.paceDelta = 2;
  snapshot.session.paceDelta = 0;
  const decision = recommendWorkersFromSnapshot({
    configuredMaxWorkers: 10,
    snapshot,
    config: TEST_CONFIG,
  });
  assert.ok(decision.recommendedWorkers <= 3);
  assert.equal(decision.reason, "linear_backoff");
  assert.ok(decision.firedHooks?.some((hook) => hook.id === "weekly_throttle"));
});

test("recommendWorkersFromSnapshot releases constraints when weekly is under-utilized", () => {
  const snapshot = snapshotFromUsage();
  snapshot.weekly.usedPercent = 30;
  snapshot.weekly.paceDelta = -10;
  snapshot.session.paceDelta = 0;
  const decision = recommendWorkersFromSnapshot({
    configuredMaxWorkers: 10,
    snapshot,
    config: TEST_CONFIG,
    hasBacklog: true,
  });
  assert.equal(decision.recommendedWorkers, 10);
  assert.equal(decision.reason, "released");
  assert.ok(decision.firedHooks?.some((hook) => hook.id === "weekly_release"));
});

test("weekly release hooks do not override active session throttles", () => {
  const snapshot = snapshotFromUsage();
  snapshot.weekly.usedPercent = 30;
  snapshot.weekly.paceDelta = -10;
  snapshot.weekly.projectedUsedAtReset = 40;
  snapshot.session.usedPercent = 85;
  snapshot.session.paceDelta = 0;
  const decision = recommendWorkersFromSnapshot({
    configuredMaxWorkers: 10,
    snapshot,
    config: TEST_CONFIG,
    hasBacklog: true,
  });
  assert.equal(decision.recommendedWorkers, 6);
  assert.ok(decision.firedHooks?.some((hook) => hook.id === "weekly_release"));
  assert.ok(decision.firedHooks?.some((hook) => hook.id === "session_throttle"));
});

test("recommendWorkersFromSnapshot respects the global OAuth worker pool", () => {
  const snapshot = snapshotFromUsage();
  snapshot.session.paceDelta = 0;
  snapshot.weekly.paceDelta = 0;
  snapshot.weekly.projectedUsedAtReset = 40;
  const decision = recommendWorkersFromSnapshot({
    configuredMaxWorkers: 10,
    activeOAuthWorkers: 12,
    snapshot,
    config: TEST_CONFIG,
  });
  assert.equal(decision.recommendedWorkers, 3);
  assert.equal(decision.scales?.globalAvailableWorkers, 3);
});

test("recommendWorkersFromSnapshot stops when the global pool is exhausted", () => {
  const decision = recommendWorkersFromSnapshot({
    configuredMaxWorkers: 10,
    activeOAuthWorkers: 15,
    snapshot: snapshotFromUsage(),
    config: TEST_CONFIG,
  });
  assert.equal(decision.recommendedWorkers, 0);
  assert.equal(decision.reason, "global_pool_exhausted");
});

test("resolveWorkerBudget fail-closed throws when provider fails", async () => {
  await assert.rejects(
    () =>
      resolveWorkerBudget({
        configuredMaxWorkers: 10,
        config: { ...TEST_CONFIG, enabled: true, failClosed: true },
        runtime: { codexLoginMethod: "chatgpt", env: { CLAWSWEEPER_BUDGET_ENABLED: "1" } },
        provider: {
          name: "codexbar",
          fetchSnapshot: async () => {
            throw new Error("boom");
          },
        },
      }),
    /OAuth budget mode is fail-closed/,
  );
});

test("resolveWorkerBudget falls back only when fail-closed is disabled", async () => {
  const resolved = await resolveWorkerBudget({
    configuredMaxWorkers: 10,
    config: { ...TEST_CONFIG, enabled: true, failClosed: false },
    runtime: { codexLoginMethod: "chatgpt", env: { CLAWSWEEPER_BUDGET_ENABLED: "1" } },
    provider: {
      name: "codexbar",
      fetchSnapshot: async () => {
        throw new Error("boom");
      },
    },
  });
  assert.equal(resolved.effectiveWorkers, 10);
  assert.equal(resolved.decision.reason, "provider_unavailable");
});

test("resolveEffectiveWorkerCount applies the minimum of all guardrails", () => {
  assert.equal(
    resolveEffectiveWorkerCount({
      configuredMaxWorkers: 10,
      budgetRecommendedWorkers: 8,
      concurrencyLimit: 9,
      backlogNeededWorkers: 4,
    }),
    4,
  );
});

test("readBudgetConfig aligns global cap with workers.max and loads hooks", () => {
  const config = readBudgetConfig();
  assert.equal(config.globalMaxWorkers, 15);
  assert.equal(config.primaryWindow, "weekly");
  assert.ok(config.hooks.some((hook) => hook.id === "weekly_stop"));
  assert.equal(config.linearBackoff.window, "weekly");
});

test("resolveBudgetConfig honors CLAWSWEEPER_BUDGET_ENABLED and active worker env", () => {
  const config = resolveBudgetConfig(readBudgetConfig(), {
    env: { CLAWSWEEPER_BUDGET_ENABLED: "1" },
  });
  assert.equal(config.enabled, true);
  assert.equal(resolveActiveOAuthWorkers({ env: { CLAWSWEEPER_ACTIVE_OAUTH_WORKERS: "4" } }), 4);
});

test("resolveBudgetConfig disables budget when CLAWSWEEPER_BUDGET_ENABLED=0 overrides config", () => {
  const config = resolveBudgetConfig(readBudgetConfig(), {
    env: { CLAWSWEEPER_BUDGET_ENABLED: "0" },
  });
  assert.equal(config.enabled, false);
});

test("resolveWorkerBudget skips provider when CLAWSWEEPER_BUDGET_ENABLED=0 overrides config", async () => {
  const resolved = await resolveWorkerBudget({
    configuredMaxWorkers: 10,
    config: readBudgetConfig(),
    runtime: { codexLoginMethod: "chatgpt", env: { CLAWSWEEPER_BUDGET_ENABLED: "0" } },
    provider: {
      name: "codexbar",
      fetchSnapshot: async () => {
        throw new Error("codexbar should not be called");
      },
    },
  });
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.effectiveWorkers, 10);
  assert.equal(resolved.decision.reason, "disabled");
});

test("workerBudgetReasonLabel maps reasons for run summaries", () => {
  assert.equal(workerBudgetReasonLabel("linear_backoff"), "linear backoff");
  assert.equal(workerBudgetReasonLabel("released"), "constraints released");
  assert.equal(workerBudgetReasonLabel("global_pool_exhausted"), "global pool exhausted");
});
