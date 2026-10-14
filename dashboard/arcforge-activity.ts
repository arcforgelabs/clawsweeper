// Arc Forge GitHub activity intake. An organization webhook delivers issue,
// comment and pull request events here instead of a per-repository Actions job,
// so routine activity spends no GitHub Actions minutes. The filter mirrors the
// retired `review-event-adapter` in arcforgelabs/.github clawsweeper-activity.yml:
// pull requests enter the durable exact-review queue; issues and maintainer
// review commands on issues go to the OpenClaw hook as an advisory request.

const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REVIEW_COMMAND = /^@clawsweeper(?:\[bot\])?\s+(?:review|re-review)\s*$/i;
const HOOK_TIMEOUT_MS = 8000;

type Json = Record<string, any>;

export type ArcforgeActivityRoute =
  | { route: "ignore"; reason: string }
  | { route: "queue"; envelope: { delivery_id: string; decision: Json } }
  | { route: "hook"; payload: Json };

export function arcforgeActivityRepositories(value: unknown): Set<string> {
  const repos = String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const repo of repos) {
    if (!/^arcforgelabs\/[A-Za-z0-9_.-]+$/.test(repo))
      throw new Error("ARCFORGE_ACTIVITY_REPOSITORIES holds an invalid repository");
  }
  return new Set(repos);
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function arcforgeActivityRoute(
  eventName: string,
  event: Json,
  deliveryId: string,
  enrolled: Set<string>,
): Promise<ArcforgeActivityRoute> {
  const ignore = (reason: string) => ({ route: "ignore", reason }) as const;
  const repository = String(event?.repository?.full_name || "");
  if (!enrolled.has(repository)) return ignore("repository not enrolled");
  const action = String(event.action || "");
  let item: Json;
  let kind: "issue" | "pull request";
  if (eventName === "issues" && (action === "opened" || action === "reopened")) {
    item = event.issue ?? {};
    kind = "issue";
  } else if (
    eventName === "pull_request" &&
    ["opened", "reopened", "ready_for_review", "synchronize", "edited"].includes(action)
  ) {
    item = event.pull_request ?? {};
    if (typeof item.draft !== "boolean") return ignore("pull request draft state missing");
    if (action === "edited" && !("body" in (event.changes ?? {})))
      return ignore("pull request edit without body change");
    kind = "pull request";
  } else if (eventName === "issue_comment" && action === "created") {
    item = event.issue ?? {};
    const comment = event.comment ?? {};
    if (!ALLOWED_ASSOCIATIONS.has(String(comment.author_association || "")))
      return ignore("comment author not a maintainer");
    if (!REVIEW_COMMAND.test(String(comment.body || ""))) return ignore("not a review command");
    kind = item.pull_request && typeof item.pull_request === "object" ? "pull request" : "issue";
  } else {
    return ignore("unsupported event");
  }
  // Public forks rehearse our own work before it goes upstream, so only a
  // maintainer's issue or pull request starts a review there. A maintainer
  // review command still admits anyone else's pull request.
  if (
    eventName !== "issue_comment" &&
    event.repository?.fork === true &&
    !ALLOWED_ASSOCIATIONS.has(String(item.author_association || ""))
  )
    return ignore("fork item author not a maintainer");
  const number = item.number;
  if (!Number.isInteger(number) || number < 1 || item.state !== "open")
    return ignore("item not open");
  const delivery_id = await sha256Hex(
    `${repository}:${eventName}:${action}:${number}:${deliveryId}`,
  );
  if (kind === "pull request") {
    const pr = eventName === "pull_request" ? item : null;
    const decision: Json = {
      targetRepo: repository,
      targetBranch: pr?.base?.ref || event.repository.default_branch,
      itemNumber: number,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: pr ? action : "comment_review",
      supersedesInProgress: true,
    };
    if (pr) {
      Object.assign(decision, {
        sourceHeadSha: pr.head?.sha,
        sourceBaseSha: pr.base?.sha,
        sourceIsDraft: pr.draft,
        sourceUpdatedAt: pr.updated_at,
      });
    }
    return { route: "queue", envelope: { delivery_id, decision } };
  }
  // No titles, bodies or arbitrary comment text enter the model instruction.
  const message = [
    "You are ingesting general GitHub activity for ClawSweeper.",
    `Event: ${eventName}.${action}`,
    `Repository: ${repository}`,
    `Subject: issue #${number}`,
    `URL: https://github.com/${repository}/issues/${number}`,
    "Request a fresh review following the gateway workspace AGENTS.md. Delegate to the item session and return NO_REPLY.",
  ].join("\n");
  return {
    route: "hook",
    payload: {
      name: "GitHub review request",
      agentId: "clawsweeper",
      deliver: false,
      idempotencyKey: delivery_id,
      thinking: "low",
      timeoutSeconds: 60,
      message,
    },
  };
}

// Report what the queue actually did. `ok` alone also covers a stale source,
// a duplicate delivery and a reservation that still waits for verification.
export function arcforgeQueueIntakeReply(status: number, receipt: Json) {
  const reason =
    receipt.ok === true
      ? receipt.deduped === true
        ? "duplicate_delivery"
        : receipt.accepted === false || receipt.shed === true
          ? String(receipt.reason || "not_accepted")
          : null
      : String(receipt.error || status);
  const sourceAuthoritySeq = Number(receipt.source_authority_seq);
  return {
    ok: true,
    accepted: reason === null,
    route: "queue",
    ...(reason === null ? {} : { reason }),
    ...(Number.isSafeInteger(sourceAuthoritySeq) && sourceAuthoritySeq > 0
      ? { stage: "source_authority_reserved", source_authority_seq: sourceAuthoritySeq }
      : {}),
    ...(receipt.branch_authority_pending === true ? { stage: "branch_authority_pending" } : {}),
  };
}

// Fixed destination: a configurable URL would also spend one of the Worker's
// 64 Free-plan variables, and only this hook is ever valid.
export const ARCFORGE_HOOK_URL = "https://team.arcforge.au/hooks/agent";

// Cloudflare Access guards the hook path with Service Auth. One secret holds the
// service token as "<client id>:<client secret>" so it spends one Free-plan
// variable, not two. Unset or malformed means no Access headers are sent.
export function arcforgeHookAccessHeaders(serviceToken: string | null): Record<string, string> {
  const separator = serviceToken?.indexOf(":") ?? -1;
  if (!serviceToken || separator <= 0 || separator === serviceToken.length - 1) return {};
  return {
    "cf-access-client-id": serviceToken.slice(0, separator),
    "cf-access-client-secret": serviceToken.slice(separator + 1),
  };
}

// GitHub abandons a delivery after ten seconds, so this asks OpenClaw only to
// admit the run. Failures surface in the webhook's recent deliveries.
export async function postArcforgeHook(
  url: string,
  token: string,
  payload: Json,
  fetchImpl: typeof fetch = fetch,
  accessHeaders: Record<string, string> = {},
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...accessHeaders,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "ArcForge-ClawSweeper/1.0",
        "idempotency-key": payload.idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const result = (await response.json().catch(() => null)) as Json | null;
    return result?.ok === true;
  } catch {
    return false;
  }
}
