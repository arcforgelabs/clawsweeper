import { exactReviewSourceRevisionMaterial } from "./exact-review-source-revision.ts";

/** Bind signed gateway intake to live GitHub source before upstream sequencing. */
export async function gatewaySourceDecision(input: Record<string, any>, live: Record<string, any>) {
  if (live.state !== "open") return null;
  const head = String(live.head?.sha || "").toLowerCase();
  const base = String(live.base?.sha || "").toLowerCase();
  const material = exactReviewSourceRevisionMaterial(live);
  if (
    !/^[a-f0-9]{40}$/.test(head) ||
    !/^[a-f0-9]{40}$/.test(base) ||
    typeof live.base?.ref !== "string" ||
    typeof live.draft !== "boolean" ||
    !Number.isFinite(Date.parse(live.updated_at)) ||
    !material ||
    !Number.isSafeInteger(input.itemNumber) ||
    input.itemNumber !== live.number
  )
    throw new Error("Live gateway review source is incomplete");
  if (input.sourceHeadSha && String(input.sourceHeadSha).toLowerCase() !== head) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(material)),
  );
  return {
    targetRepo: input.targetRepo,
    targetBranch: live.base.ref,
    itemNumber: input.itemNumber,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: input.sourceAction === "comment_review" ? "re_review" : input.sourceAction,
    supersedesInProgress: true,
    sourceHeadSha: head,
    sourceBaseSha: base,
    sourceIsDraft: live.draft,
    sourceUpdatedAt: live.updated_at,
    sourceContentRevision: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
