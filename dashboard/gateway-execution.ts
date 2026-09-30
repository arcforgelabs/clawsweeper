import type { ExactReviewQueueItem } from "./exact-review-queue.ts";

// Execution ownership is attached to upstream claims, never a second intake queue.
// Synchronous KV operations run without awaits inside the single queue DO.
export const GATEWAY_EXECUTION_TTL_MS = 120_000;
type Store = { get(key: string): unknown; put(key: string, value: unknown): void };
type Execution = { owner: string; expires: number; outcome?: "success" | "failure" };
export function gatewayTuple(item: ExactReviewQueueItem) {
  return {
    item_key: item.key,
    lease_id: item.leaseId,
    lease_revision: item.leaseRevision,
    run_id: item.claimedRunId,
    run_attempt: item.claimedRunAttempt,
    claim_generation: item.claimGeneration,
    ...(item.leaseDecision?.sourceHeadSha
      ? { source_head_sha: item.leaseDecision.sourceHeadSha }
      : {}),
  };
}
function key(item: ExactReviewQueueItem) {
  return `gateway-execution:${item.leaseId}:${item.claimGeneration}`;
}
export function gatewayExecution(
  store: Store,
  items: ExactReviewQueueItem[],
  action: string,
  body: Record<string, unknown>,
  now: number,
): { status: number; body: unknown } {
  const result = (status: number, body: unknown) => ({ status, body });
  const active = (item: ExactReviewQueueItem) =>
    item.state === "leased" &&
    item.claimProtocolVersion === 2 &&
    item.claimedRunId &&
    item.leaseDecision &&
    item.leaseDecision.itemKind === "pull_request" &&
    !item.leaseDecision.publication &&
    item.leaseRevision === item.revision &&
    Number(item.leaseExpiresAt) > now;
  // Keep execution receipts only while their upstream claim exists. This makes
  // storage bounded by queue concurrency, including after retries and restarts.
  const records = (store.get("gateway-executions-v1") ?? {}) as Record<string, Execution>;
  const liveKeys = new Set(items.filter(active).map(key));
  for (const k of Object.keys(records)) if (!liveKeys.has(k)) delete records[k];
  store.put("gateway-executions-v1", records);
  const executions = {
    get: (k: string) => records[k],
    put: (k: string, v: Execution) => {
      records[k] = v;
      store.put("gateway-executions-v1", records);
    },
  };
  if (action === "overview")
    return result(200, {
      pending: items.filter((i) => i.state === "pending").length,
      active: items.filter(active).length,
      executing: Object.values(records).filter((r) => !r.outcome && r.expires > now).length,
      completed_awaiting_ack: Object.values(records).filter((r) => r.outcome === "success").length,
    });
  if (action === "take") {
    if (typeof body.owner !== "string" || !/^[a-f0-9-]{36}$/.test(body.owner))
      return result(400, { error: "invalid_owner" });
    for (const item of items.filter(active).sort((a, b) => a.createdAt - b.createdAt)) {
      const record = executions.get(key(item)) as Execution | undefined;
      if (record?.outcome || (record && record.expires > now)) continue;
      executions.put(key(item), { owner: body.owner, expires: now + GATEWAY_EXECUTION_TTL_MS });
      return result(200, {
        job: { ...gatewayTuple(item), decision: item.leaseDecision, owner: body.owner },
      });
    }
    return result(200, { job: null });
  }
  const item = items.find(
    (i) => active(i) && Object.entries(gatewayTuple(i)).every(([k, v]) => body[k] === v),
  );
  if (!item) return result(409, { error: "lease_not_active" });
  const record = executions.get(key(item)) as Execution | undefined;
  if (action === "status") return result(200, { outcome: record?.outcome ?? null });
  if (!record || record.owner !== body.owner || record.expires <= now || record.outcome)
    return result(409, { error: "execution_not_owned" });
  if (action === "heartbeat") {
    executions.put(key(item), { ...record, expires: now + GATEWAY_EXECUTION_TTL_MS });
    return result(200, { ok: true });
  }
  if (action === "finish" && (body.outcome === "success" || body.outcome === "failure")) {
    executions.put(key(item), { ...record, outcome: body.outcome });
    return result(200, { ok: true });
  }
  return result(400, { error: "invalid_gateway_action" });
}
