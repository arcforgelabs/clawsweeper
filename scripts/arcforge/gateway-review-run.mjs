import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const base = "https://clawsweeper.arcforge.au/internal/exact-review";
const secret = process.env.CLAWSWEEPER_WEBHOOK_SECRET;
if (!secret) throw Error("Queue credential missing");
async function call(route, value) {
  const body = JSON.stringify(value);
  const r = await fetch(base + route, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature":
        "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 409) return null;
  if (!r.ok) throw Error(`Queue ${route}: HTTP ${r.status}`);
  return r.json();
}
const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).client_payload;
const tuple = {
  lease_id: payload.queue_lease_id,
  item_key: payload.queue_claim?.item_key,
  lease_revision: payload.queue_claim?.lease_revision,
  run_id: process.env.GITHUB_RUN_ID,
  run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
};
if (payload.queue_claim?.protocol_version !== 2) throw Error("Protocol v2 required");
const claim = await call("/claim", tuple);
if (claim) {
  tuple.claim_generation = claim.claim_generation;
  if (claim.decision?.sourceHeadSha) tuple.source_head_sha = claim.decision.sourceHeadSha;
  let outcome = "failure";
  try {
    for (const deadline = Date.now() + 100 * 60000; Date.now() < deadline;) {
      if (!(await call("/heartbeat", { ...tuple, phase: "review" }))) break;
      const status = await call("/gateway/status", tuple);
      if (!status) break;
      if (status.outcome) {
        outcome = status.outcome;
        break;
      }
      await sleep(30000);
    }
  } finally {
    // The upstream completion path owns retry bounds and abandoned-run recovery.
    await call("/complete", { ...tuple, outcome });
  }
  if (outcome !== "success") process.exitCode = 1;
}
