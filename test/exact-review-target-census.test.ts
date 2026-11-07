import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { TestStorage } from "./exact-review-test-storage.ts";
import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import worker from "../dashboard/worker.ts";
const repo = "arcforgelabs/dictate";
const post = (path: string, body: unknown, signature?: string) =>
  new Request("https://queue" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-clawsweeper-exact-review-signature": signature } : {}),
    },
    body: JSON.stringify(body),
  });
test("signed target census includes all canonical states, finalizers and orphan batch ownership without writes", async () => {
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://queue/stats"));
  const expected = {
    review: { pending: 1, dispatching: 1, leased: 1, parked: 1 },
    publication: { pending: 1, dispatching: 1, leased: 1, parked: 1 },
    finalization: { pending: 1, dispatching: 1, leased: 1, parked: 1 },
  };
  let number = 1;
  for (const lane of ["review", "publication", "finalization"])
    for (const state of ["pending", "dispatching", "leased", "parked"]) {
      const key = repo + "#" + number++;
      const item = {
        key,
        revision: 1,
        state,
        attempts: 0,
        createdAt: 1,
        updatedAt: 1,
        nextAttemptAt: 1,
        decision: {
          targetRepo: repo,
          targetBranch: "master",
          itemNumber: number,
          itemKind: "issue",
          sourceEvent: "issues",
          sourceAction: lane === "publication" ? "exact_review_artifact_publish" : "opened",
          supersedesInProgress: false,
        },
        ...(lane === "finalization" ? { terminalFinalization: { disposition: "failure" } } : {}),
      };
      storage.sql.exec(
        "INSERT INTO exact_review_queue_items(item_key,item_json) VALUES(?,?)",
        key,
        JSON.stringify(item),
      );
    }
  storage.sql.exec(
    "INSERT INTO exact_review_publication_batches(batch_id,state,lease_owner,lease_expires_at,attempt,created_at) VALUES('batch','leased','owner',9999999999999,1,1)",
  );
  storage.sql.exec(
    "INSERT INTO exact_review_publication_batch_items(batch_id,item_key,revision,claim_generation) VALUES('batch',?,1,1)",
    repo + "#999@publish:2:1",
  );
  storage.sql.exec(
    "INSERT INTO exact_review_publication_batch_items(batch_id,item_key,revision,claim_generation) VALUES('batch','arcforgelabs/field#999',1,1)",
  );
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-only",
    EXACT_REVIEW_QUEUE: {
      idFromName: () => "queue",
      get: () => ({ fetch: (request: Request) => queue.fetch(request) }),
    },
  };
  const body = { target_repo: repo };
  const signature =
    "sha256=" + createHmac("sha256", "test-only").update(JSON.stringify(body)).digest("hex");
  assert.equal(
    (await worker.fetch(post("/internal/exact-review/target-census", body), env, {})).status,
    401,
  );
  const before = [...storage.sql.exec("SELECT name,sql FROM sqlite_master ORDER BY name")];
  const itemsBefore = [
    ...storage.sql.exec("SELECT * FROM exact_review_queue_items ORDER BY item_key"),
  ];
  const response = await worker.fetch(
    post("/internal/exact-review/target-census", body, signature),
    env,
    {},
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.items, expected);
  assert.equal(result.unfinished_batch_items, 1);
  assert.equal(result.collection.state, "complete");
  assert.equal(result.drained, false);
  assert.deepEqual(
    [...storage.sql.exec("SELECT * FROM exact_review_queue_items ORDER BY item_key")],
    itemsBefore,
  );
  assert.deepEqual(
    [...storage.sql.exec("SELECT name,sql FROM sqlite_master ORDER BY name")],
    before,
  );
  const fresh = new ExactReviewQueue(
    { storage: new TestStorage(), blockConcurrencyWhile: async (f: () => Promise<void>) => f() },
    {},
  );
  assert.equal((await fresh.fetch(post("/target-census", body))).status, 503);
  assert.equal((await queue.fetch(post("/target-census", { target_repo: "bad" }))).status, 400);
  const authoritiesBefore = "exact-review-source-authority-reservation:v1:one";
  await storage.put(authoritiesBefore, { decision: { targetRepo: "arcforgelabs/themes" } });
  const authorityResult = await queue.fetch(
    post("/target-census", { target_repo: "arcforgelabs/themes" }),
  );
  assert.equal((await authorityResult.json()).pending_authorities, 1);
  await storage.delete(authoritiesBefore);
  const other = await queue.fetch(post("/target-census", { target_repo: "arcforgelabs/themes" }));
  assert.equal((await other.json()).drained, true);
});

test("retained lease completes with new admission stopped", async () => {
  const storage = new TestStorage();
  const q = new ExactReviewQueue({ storage }, { hostedTargetPredicate: () => false });
  await q.fetch(new Request("https://q/stats"));
  const key = "arcforgelabs/dictate#10";
  const now = Date.now();
  const item = {
    key,
    state: "leased",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    attempts: 1,
    leaseId: "old-lease",
    leaseRevision: 1,
    claimGeneration: 1,
    claimProtocolVersion: 2,
    leaseExpiresAt: now + 60000,
    claimedRunId: "123",
    claimedRunAttempt: 1,
    decision: {
      targetRepo: "arcforgelabs/dictate",
      targetBranch: "master",
      itemNumber: 10,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
      supersedesInProgress: false,
    },
  };
  storage.sql.exec(
    "INSERT INTO exact_review_queue_items(item_key,item_json) VALUES(?,?)",
    key,
    JSON.stringify(item),
  );
  const r = await q.fetch(
    new Request("https://q/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "old-lease",
        item_key: key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "123",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, requeued: false });
});
