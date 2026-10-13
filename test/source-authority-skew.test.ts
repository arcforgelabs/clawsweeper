import test from "node:test";
import assert from "node:assert/strict";
import {
  createExactReviewAdmissionHarness,
  jsonResponse,
  withExactReviewAdmissionHarness,
} from "./dashboard-worker-harness.ts";
import { HOSTED_TARGET_ELIGIBILITY_HEADER } from "../src/hosted-target-admission.ts";
import { arcforgeQueueIntakeReply } from "../dashboard/arcforge-activity.ts";

// A settings-only deploy that enrols a repository reaches the front Worker and
// the queue Durable Object at different moments. The front Worker vouches for
// eligibility on intake; the Durable Object rechecks it in its alarm.
const TARGET = "arcforgelabs/openclaw";
const HEAD = "d".repeat(40);

function skewHarness() {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    hostedPublicTargetProbe: async () => "public",
    targetAccessToken: () => jsonResponse({ token: "target-token" }),
    targetPull: () => jsonResponse({ head: { sha: HEAD } }),
  });
  const env = (harness.queue as unknown as { env: Record<string, unknown> }).env;
  env.EXACT_REVIEW_PRIVATE_GATEWAY = "1";
  const queueAllowlist = { enrolled: false };
  env.hostedTargetPredicate = (repo: string) => queueAllowlist.enrolled && repo === TARGET;
  return { harness, queueAllowlist };
}

async function reserve(
  harness: ReturnType<typeof createExactReviewAdmissionHarness>,
  deliveryId: string,
  vouched = true,
) {
  const response = await harness.queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/source-authority", {
      method: "POST",
      headers: vouched ? { [HOSTED_TARGET_ELIGIBILITY_HEADER]: TARGET } : {},
      body: JSON.stringify({
        delivery_id: deliveryId,
        installation_id: 123,
        decision: {
          targetRepo: TARGET,
          targetBranch: "master",
          itemNumber: 1,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction: "opened",
          supersedesInProgress: true,
          sourceHeadSha: HEAD,
        },
      }),
    }),
  );
  const key = `exact-review-source-authority-reservation:v1:${encodeURIComponent(deliveryId)}`;
  return { response, key };
}

function makeDue(harness: ReturnType<typeof createExactReviewAdmissionHarness>, key: string) {
  harness.storage.rawPut(key, {
    ...(harness.storage.rawGet(key) as Record<string, unknown>),
    nextAttemptAt: 0,
  });
}

async function listing(harness: ReturnType<typeof createExactReviewAdmissionHarness>) {
  const response = await harness.queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/source-authority/list", {
      method: "POST",
      body: "{}",
    }),
  );
  assert.equal(response.status, 200);
  return (await response.json()) as {
    reservations: Record<string, unknown>[];
    recent_drops: Record<string, unknown>[];
  };
}

function deliveries(harness: ReturnType<typeof createExactReviewAdmissionHarness>) {
  return Array.from(
    harness.storage.sql.exec("SELECT delivery_id FROM exact_review_queue_deliveries"),
  ).map((row) => (row as { delivery_id: string }).delivery_id);
}

test("a vouched reservation survives a stale queue allowlist and enqueues after the reset", async () => {
  const { harness, queueAllowlist } = skewHarness();
  await withExactReviewAdmissionHarness(harness, async () => {
    const { response, key } = await reserve(harness, "opened-during-rollout");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, source_authority_seq: 1 });
    makeDue(harness, key);

    await harness.queue.alarm();

    // Before the fix the alarm deleted the reservation and marked the delivery
    // handled, so neither a job nor a redelivery could follow.
    assert.equal(harness.storage.rawHas(key), true);
    assert.deepEqual(deliveries(harness), []);
    const pending = await listing(harness);
    assert.equal(pending.reservations.length, 1);
    assert.equal(pending.reservations[0]?.target_repo, TARGET);
    assert.equal(pending.reservations[0]?.source_action, "opened");
    assert.equal(typeof pending.reservations[0]?.eligibility_vouched_at, "string");
    assert.deepEqual(pending.recent_drops, []);

    queueAllowlist.enrolled = true;
    makeDue(harness, key);
    await harness.queue.alarm();

    assert.equal(harness.storage.rawHas(key), false);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string; sourceHeadSha: string } }>;
    };
    assert.equal(state.items[`${TARGET}#1`]?.decision.sourceAction, "opened");
    assert.equal(state.items[`${TARGET}#1`]?.decision.sourceHeadSha, HEAD);
    assert.deepEqual((await listing(harness)).reservations, []);
  });
});

test("a newly enrolled private target is reserved, not refused, while the queue settings lag", async () => {
  const { harness, queueAllowlist } = skewHarness();
  // The private probe is only allowed once the queue sees the new allowlist.
  (harness.queue as unknown as { env: Record<string, unknown> }).env.hostedPublicTargetProbe =
    async () => (queueAllowlist.enrolled ? "private" : "terminal");
  await withExactReviewAdmissionHarness(harness, async () => {
    const { response, key } = await reserve(harness, "private-opened-during-rollout");
    assert.equal(response.status, 200);
    makeDue(harness, key);
    await harness.queue.alarm();
    assert.equal(harness.storage.rawHas(key), true);
    assert.deepEqual(deliveries(harness), []);

    queueAllowlist.enrolled = true;
    makeDue(harness, key);
    await harness.queue.alarm();

    assert.equal(harness.storage.rawHas(key), false);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(state.items[`${TARGET}#1`]);
  });
});

test("a terminal target is refused at intake when unvouched or in the public deployment", async () => {
  for (const scenario of ["unvouched", "public_deployment"] as const) {
    const { harness } = skewHarness();
    const env = (harness.queue as unknown as { env: Record<string, unknown> }).env;
    env.hostedPublicTargetProbe = async () => "terminal";
    if (scenario === "public_deployment") delete env.EXACT_REVIEW_PRIVATE_GATEWAY;
    await withExactReviewAdmissionHarness(harness, async () => {
      const { response, key } = await reserve(harness, scenario, scenario === "public_deployment");
      assert.equal(response.status, 422);
      assert.equal(harness.storage.rawHas(key), false);
    });
  }
});

test("an ineligible target is still dropped after the skew window, and the drop is listed", async () => {
  const { harness } = skewHarness();
  await withExactReviewAdmissionHarness(harness, async () => {
    const { key } = await reserve(harness, "opened-for-unenrolled-target");
    const reservation = harness.storage.rawGet(key) as Record<string, unknown>;
    harness.storage.rawPut(key, {
      ...reservation,
      eligibilityVouchedAt: Date.now() - 16 * 60_000,
      nextAttemptAt: 0,
    });

    await harness.queue.alarm();

    assert.equal(harness.storage.rawHas(key), false);
    assert.deepEqual(deliveries(harness), ["opened-for-unenrolled-target"]);
    const { reservations, recent_drops } = await listing(harness);
    assert.deepEqual(reservations, []);
    assert.equal(recent_drops.length, 1);
    assert.equal(recent_drops[0]?.cause, "target_not_admitted");
    assert.equal(recent_drops[0]?.target_repo, TARGET);
    assert.equal(recent_drops[0]?.item_number, 1);
    assert.equal(recent_drops[0]?.source_head_sha, HEAD);
  });
});

test("a reservation the front Worker did not vouch for keeps the immediate drop", async () => {
  const { harness } = skewHarness();
  await withExactReviewAdmissionHarness(harness, async () => {
    // Without the prepared eligibility header the queue checks eligibility on
    // intake, so skew cannot apply; seed the reservation as an older record.
    harness.storage.rawPut("exact-review-source-authority-sequence:v1", 1);
    const key = `exact-review-source-authority-reservation:v1:${encodeURIComponent("legacy")}`;
    harness.storage.rawPut(key, {
      deliveryId: "legacy",
      decision: {
        targetRepo: TARGET,
        targetBranch: "master",
        itemNumber: 1,
        itemKind: "pull_request",
        sourceEvent: "pull_request",
        sourceAction: "opened",
        supersedesInProgress: true,
        sourceHeadSha: HEAD,
        sourceAuthoritySeq: 1,
      },
      installationId: 123,
      sourceAuthoritySeq: 1,
      attempts: 0,
      nextAttemptAt: 0,
    });

    await harness.queue.alarm();

    assert.equal(harness.storage.rawHas(key), false);
    assert.equal((await listing(harness)).recent_drops[0]?.cause, "target_not_admitted");
  });
});

test("the intake reply reports the queue's real outcome", () => {
  assert.deepEqual(arcforgeQueueIntakeReply(200, { ok: true, source_authority_seq: 7 }), {
    ok: true,
    accepted: true,
    route: "queue",
    stage: "source_authority_reserved",
    source_authority_seq: 7,
  });
  assert.deepEqual(arcforgeQueueIntakeReply(200, { ok: true, deduped: true }), {
    ok: true,
    accepted: false,
    route: "queue",
    reason: "duplicate_delivery",
  });
  assert.deepEqual(
    arcforgeQueueIntakeReply(202, {
      ok: true,
      accepted: false,
      reason: "source_not_current_or_open",
    }),
    { ok: true, accepted: false, route: "queue", reason: "source_not_current_or_open" },
  );
  assert.deepEqual(arcforgeQueueIntakeReply(202, { ok: true, branch_authority_pending: true }), {
    ok: true,
    accepted: true,
    route: "queue",
    stage: "branch_authority_pending",
  });
  assert.deepEqual(arcforgeQueueIntakeReply(403, { error: "gateway_target_not_enrolled" }), {
    ok: true,
    accepted: false,
    route: "queue",
    reason: "gateway_target_not_enrolled",
  });
  assert.deepEqual(arcforgeQueueIntakeReply(200, { ok: true, accepted: true }), {
    ok: true,
    accepted: true,
    route: "queue",
  });
});
