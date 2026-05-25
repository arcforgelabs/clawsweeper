import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { computeBudgetWindow } from "./pace.js";
import type { BudgetProvider, BudgetSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

export type CodexBarCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export type CodexBarBudgetProviderOptions = {
  codexbarBin?: string | undefined;
  commandRunner?: CodexBarCommandRunner;
  now?: () => Date;
};

type CodexBarUsageWindow = {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string;
};

type CodexBarUsagePayload = {
  provider?: string;
  source?: string;
  usage?: {
    loginMethod?: string;
    primary?: CodexBarUsageWindow | null;
    secondary?: CodexBarUsageWindow | null;
    updatedAt?: string;
  };
};

const DEFAULT_CODEXBAR_BIN = "codexbar";

export class CodexBarBudgetProvider implements BudgetProvider {
  readonly name = "codexbar";
  private readonly codexbarBin: string;
  private readonly commandRunner: CodexBarCommandRunner;
  private readonly now: () => Date;

  constructor(options: CodexBarBudgetProviderOptions = {}) {
    this.codexbarBin = options.codexbarBin?.trim() || DEFAULT_CODEXBAR_BIN;
    this.commandRunner =
      options.commandRunner ??
      (async (command, args) => {
        try {
          const result = await execFileAsync(command, [...args], {
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
          });
          return { stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          if (isExecFileError(error)) {
            const message = [error.message, error.stderr?.trim(), error.stdout?.trim()]
              .filter(Boolean)
              .join("\n");
            throw new Error(message || `command failed: ${command} ${args.join(" ")}`);
          }
          throw error;
        }
      });
    this.now = options.now ?? (() => new Date());
  }

  async fetchSnapshot(): Promise<BudgetSnapshot> {
    const { stdout } = await this.commandRunner(this.codexbarBin, [
      "usage",
      "--provider",
      "codex",
      "--source",
      "cli",
      "--json",
    ]);
    return parseCodexBarUsageJson(stdout, this.now());
  }
}

export function parseCodexBarUsageJson(stdout: string, now = new Date()): BudgetSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `codexbar usage returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("codexbar usage returned no provider payloads");
  }

  const payload = parsed.find((entry): entry is CodexBarUsagePayload => {
    if (!isRecord(entry)) return false;
    return typeof entry.provider === "string" && entry.provider.toLowerCase() === "codex";
  });
  if (!payload) {
    throw new Error("codexbar usage JSON is missing a Codex provider payload");
  }

  const usage = payload.usage;
  if (!usage) throw new Error("codexbar usage JSON is missing Codex usage data");
  assertOAuthUsageAvailable(usage.loginMethod);
  const primary = requireUsageWindow(usage.primary, "primary");
  const secondary = requireUsageWindow(usage.secondary, "secondary");

  return {
    provider: "codexbar",
    source: typeof payload.source === "string" ? payload.source : "unknown",
    observedAt: typeof usage.updatedAt === "string" ? usage.updatedAt : now.toISOString(),
    ...(typeof usage.loginMethod === "string" ? { loginMethod: usage.loginMethod } : {}),
    session: buildBudgetWindow("session", primary, now),
    weekly: buildBudgetWindow("weekly", secondary, now),
  };
}

function assertOAuthUsageAvailable(loginMethod: string | undefined): void {
  const normalized = String(loginMethod ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    throw new Error("Codex OAuth usage is unavailable: login method missing from codexbar usage");
  }
  if (normalized === "api" || normalized === "api_key" || normalized === "api-key") {
    throw new Error(
      "Codex OAuth usage is unavailable: codexbar reported API-key auth instead of subscription OAuth",
    );
  }
}

function requireUsageWindow(
  window: CodexBarUsageWindow | null | undefined,
  label: "primary" | "secondary",
): CodexBarUsageWindow {
  if (!window) {
    throw new Error(`codexbar usage JSON is missing Codex ${label} usage window`);
  }
  const usedPercent = window.usedPercent;
  const windowMinutes = window.windowMinutes;
  const resetsAt = window.resetsAt;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    throw new Error(`codexbar usage JSON has invalid ${label}.usedPercent`);
  }
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new Error(`codexbar usage JSON has invalid ${label}.windowMinutes`);
  }
  if (typeof resetsAt !== "string" || !resetsAt.trim()) {
    throw new Error(`codexbar usage JSON has invalid ${label}.resetsAt`);
  }
  return window;
}

function buildBudgetWindow(name: "session" | "weekly", window: CodexBarUsageWindow, now: Date) {
  return computeBudgetWindow(
    name,
    window.usedPercent ?? 0,
    window.windowMinutes ?? 0,
    window.resetsAt ?? "",
    now,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecFileError(
  error: unknown,
): error is NodeJS.ErrnoException & { stdout?: string; stderr?: string } {
  return error instanceof Error && "code" in error;
}

export function codexBarBudgetFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not found/i.test(detail)) {
    return "Codex OAuth budget check failed: codexbar is not installed or not on PATH.";
  }
  return `Codex OAuth budget check failed: codexbar usage unavailable (${detail}).`;
}

export function codexBarBudgetRecoveryHint(codexbarBin = DEFAULT_CODEXBAR_BIN): string {
  return `Run: ${codexbarBin} usage --provider codex --source cli --json`;
}
