import type { BudgetWindow, BudgetWindowName } from "./types.js";

export function parseBudgetResetTime(isoTimestamp: string): Date | null {
  if (!isoTimestamp.trim()) return null;
  try {
    const normalized = isoTimestamp.endsWith("Z")
      ? isoTimestamp.slice(0, -1) + "+00:00"
      : isoTimestamp;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

export function computeBudgetWindow(
  name: BudgetWindowName,
  usedPercent: number,
  windowMinutes: number,
  resetsAt: string,
  now = new Date(),
): BudgetWindow {
  const resetAt = parseBudgetResetTime(resetsAt);
  let elapsedPercent = 0;
  let paceDelta = 0;
  let projectedUsedAtReset: number | undefined;

  if (resetAt && windowMinutes > 0) {
    const remainingMinutes = (resetAt.getTime() - now.getTime()) / 60_000;
    const elapsedMinutes = windowMinutes - remainingMinutes;
    if (elapsedMinutes <= 0) {
      elapsedPercent = 0;
      paceDelta = 0;
      projectedUsedAtReset = usedPercent;
    } else {
      elapsedPercent = (elapsedMinutes / windowMinutes) * 100;
      paceDelta = usedPercent - elapsedPercent;
      projectedUsedAtReset = (usedPercent / Math.max(elapsedPercent, 0.01)) * 100;
    }
  }

  const window: BudgetWindow = {
    name,
    usedPercent,
    windowMinutes,
    resetsAt,
    elapsedPercent,
    paceDelta,
  };
  if (projectedUsedAtReset !== undefined) window.projectedUsedAtReset = projectedUsedAtReset;
  return window;
}

export function paceLabel(
  paceDelta: number,
  aheadThreshold: number,
  behindThreshold: number,
): string {
  if (paceDelta > aheadThreshold) return "ahead of pace";
  if (paceDelta < behindThreshold) return "behind pace";
  return "on pace";
}
