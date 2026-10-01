import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayExecution,
  gatewayTuple,
  GATEWAY_EXECUTION_TTL_MS,
} from "../dashboard/gateway-execution.ts";
import { randomUUID } from "node:crypto";
import type { ExactReviewQueueItem } from "../dashboard/exact-review-queue.ts";
import worker from "../dashboard/worker.ts";
import {
  privateReviewTargetAllowed,
  reviewCoordinatorRepository,
  configuredReviewRepositories,
} from "../dashboard/review-coordinator.ts";
const fixture = () =>
  ({
    key: "private/repo:pull_request:1",
    state: "leased",
    revision: 1,
    leaseRevision: 1,
    leaseId: "a",
    claimGeneration: 1,
    claimProtocolVersion: 2,
    claimedRunId: "123",
    claimedRunAttempt: 1,
    createdAt: 1,
    leaseExpiresAt: 999999,
    leaseDecision: {
      targetRepo: "private/repo",
      itemNumber: 1,
      itemKind: "pull_request",
      sourceHeadSha: "a".repeat(40),
    },
  }) as ExactReviewQueueItem;
test("gateway restart recovers expired execution; old owner and superseded head cannot finish", () => {
  const data = new Map();
  const store = { get: (k: string) => data.get(k), put: (k: string, v: unknown) => data.set(k, v) };
  const item = fixture(),
    a = randomUUID(),
    b = randomUUID();
  const call = (action: string, body: Record<string, unknown>, now = 1) =>
    gatewayExecution(store, [item], action, body, now);
  assert.ok((call("take", { owner: a }).body as any).job);
  assert.equal((call("take", { owner: b }).body as any).job, null);
  assert.equal(call("heartbeat", { ...gatewayTuple(item), owner: a }).status, 200);
  const later = GATEWAY_EXECUTION_TTL_MS + 2;
  assert.ok((call("take", { owner: b }, later).body as any).job);
  assert.equal(
    call("finish", { ...gatewayTuple(item), owner: a, outcome: "success" }, later).status,
    409,
  );
  assert.equal(
    call("finish", { ...gatewayTuple(item), owner: b, outcome: "success" }, later).status,
    200,
  );
  assert.equal((call("status", gatewayTuple(item), later).body as any).outcome, "success");
  item.revision = 2;
  assert.equal(call("heartbeat", { ...gatewayTuple(item), owner: b }, later).status, 409);
});
test("private deployment blocks public read and POST data routes; signed routes require auth", async () => {
  const env = { EXACT_REVIEW_PRIVATE_GATEWAY: "1", CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" };
  for (const path of [
    "/",
    "/api/exact-review-queue",
    "/api/exact-review-queue/item",
    "/api/reviews",
    "/records/private/repo",
  ]) {
    for (const method of ["GET", "POST"]) {
      const r = await worker.fetch(new Request("https://example.test" + path, { method }), env);
      assert.deepEqual(await r.json(), {
        service: "clawsweeper-status",
        visibility: "private",
        review_capacity: 5,
      });
    }
  }
  const r = await worker.fetch(
    new Request("https://example.test/internal/exact-review/gateway/take", {
      method: "POST",
      body: "{}",
    }),
    env,
  );
  assert.equal(r.status, 401);
});
test("private enrollment and coordinator are explicit and validated", () => {
  assert.equal(reviewCoordinatorRepository(), "openclaw/clawsweeper");
  assert.equal(
    privateReviewTargetAllowed({ EXACT_REVIEW_PRIVATE_GATEWAY: "1" }, "private/repo"),
    false,
  );
  assert.equal(
    privateReviewTargetAllowed(
      { EXACT_REVIEW_PRIVATE_GATEWAY: "1", EXACT_REVIEW_ALLOWED_REPOSITORIES: "private/repo" },
      "private/repo",
    ),
    true,
  );
  assert.throws(() =>
    configuredReviewRepositories({ EXACT_REVIEW_ALLOWED_REPOSITORIES: "../escape" }),
  );
});
