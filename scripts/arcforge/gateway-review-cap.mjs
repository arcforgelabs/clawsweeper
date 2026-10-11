// Hard monthly cap on Gateway exact review runner minutes.
//   check:  before claiming work, compare this month's minutes with the cap; at
//           the cap, disable gateway-review.yml so no further runners start.
//           gateway-review-cap-reset.yml enables it again on the 1st.
//   record: after the job, report its whole-minute duration once per attempt.
import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";

const base = "https://clawsweeper.arcforge.au/internal/exact-review";
const secret = process.env.CLAWSWEEPER_WEBHOOK_SECRET;
if (!secret) throw Error("Queue credential missing");
const cap = Number(process.env.CLAWSWEEPER_MONTHLY_MINUTE_CAP);
if (!Number.isInteger(cap) || cap < 1) throw Error("Monthly minute cap missing");

async function usage(value) {
  const body = JSON.stringify(value);
  const r = await fetch(base + "/gateway/usage", {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "user-agent": "ArcForge-ClawSweeper/1.0",
      "x-clawsweeper-exact-review-signature":
        "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Error(`Queue usage: HTTP ${r.status}`);
  return r.json();
}

const mode = process.argv[2];
if (mode === "check") {
  const { month, minutes } = await usage({});
  const capped = minutes >= cap;
  console.log(`Coordinator minutes for ${month}: ${minutes} of ${cap}`);
  if (capped) {
    const r = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/gateway-review.yml/disable`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
        },
      },
    );
    if (!r.ok) throw Error(`Disabling gateway-review.yml: HTTP ${r.status}`);
    console.log(
      `::warning::Monthly cap of ${cap} minutes reached; gateway-review.yml disabled until the 1st`,
    );
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `capped=${capped}\n`);
} else if (mode === "record") {
  const started = Number(process.env.JOB_STARTED_AT);
  const minutes = Math.min(120, Math.max(1, Math.ceil((Date.now() / 1000 - started) / 60)));
  const { month, minutes: total } = await usage({
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    minutes,
  });
  console.log(`Recorded ${minutes} minutes; ${month} total ${total} of ${cap}`);
} else {
  throw Error("Usage: gateway-review-cap.mjs check|record");
}
