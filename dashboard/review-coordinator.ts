/** Fork-owned deployment settings. Unset values retain upstream behavior. */
export function reviewCoordinatorRepository(env: Record<string, unknown> = {}): string {
  const value = String(env.CLAWSWEEPER_REVIEW_REPO ?? "openclaw/clawsweeper");
  if (
    value.split("/").some((s) => s === "." || s === "..") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error("Invalid CLAWSWEEPER_REVIEW_REPO");
  }
  return value;
}

export function reviewCoordinatorWorkflow(env: Record<string, unknown> = {}): string {
  const value = String(env.CLAWSWEEPER_REVIEW_WORKFLOW ?? "sweep.yml");
  if (!/^[A-Za-z0-9_-]+\.ya?ml$/.test(value)) {
    throw new Error("Invalid CLAWSWEEPER_REVIEW_WORKFLOW");
  }
  return value;
}

export function configuredReviewRepositories(env: Record<string, unknown>): string[] | undefined {
  if (env.EXACT_REVIEW_ALLOWED_REPOSITORIES === undefined) return undefined;
  const values = String(env.EXACT_REVIEW_ALLOWED_REPOSITORIES)
    .split(",")
    .map((s) => s.trim().toLowerCase());
  if (
    !values.length ||
    values.some(
      (s) =>
        s.split("/").some((part) => part === "." || part === "..") ||
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(s),
    )
  ) {
    throw new Error("Invalid EXACT_REVIEW_ALLOWED_REPOSITORIES");
  }
  return [...new Set(values)];
}

export function privateReviewTargetAllowed(env: Record<string, unknown>, repo: string): boolean {
  // Private admission is opt-in AND requires an explicit target allowlist. The
  // same mode restricts public Worker routes to aggregate, content-free status.
  return (
    env.EXACT_REVIEW_PRIVATE_GATEWAY === "1" &&
    (configuredReviewRepositories(env)?.includes(repo.trim().toLowerCase()) ?? false)
  );
}
