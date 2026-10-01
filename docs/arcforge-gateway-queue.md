# Arc Forge gateway execution adapter

Deploy this fork's `dashboard/wrangler.arcforge.toml` together with the matching
Arc Forge Tools gateway executor. The executor is implemented in
[arc-forge-tools/components/cli/clawsweeper-review/gateway-worker.mjs](https://github.com/arcforgelabs/arc-forge-tools/blob/feat/durable-review-gateway/components/cli/clawsweeper-review/gateway-worker.mjs).
Its systemd service runs on prod-arc-haven independently of the OpenClaw service.

`gateway-review.yml` claims the upstream protocol-v2 tuple with the real Actions
run ID. Five external gateway workers call the signed `/gateway/take` endpoint,
execute the existing native OpenClaw publisher through xAI, and report a result
through `/gateway/finish`. The workflow heartbeats and acknowledges completion.
Deploying the workflow without that companion executor leaves it waiting; the
rollout must prove one complete canary before enrolling repositories.

This adapter retains the upstream intake, supersession, retry and dead-letter
machinery. The gateway execution ownership records live in the same queue
Durable Object and are bounded by active upstream claims. A 120-second execution
lease fences old workers after crashes. Immutable completed assessments stay on
the gateway for publication-only retries and are tied to source revision, head,
base, body, policy and installed runtime.

The private deployment exposes no public queue items, reports or lifecycle data.
OpenClaw Bay is affected: it displays only a private-service notice; authenticated
operator APIs remain available. No private target content is added to public Bay.
The upstream public deployment profile and default coordinator behavior remain
unchanged. The public coordinator's Actions metadata uses a metadata-only App
token; dispatch uses a repository-scoped Contents-write token.

Formal mode is a trusted host environment setting, `CLAWSWEEPER_FORMAL_REVIEW=1`.
It retains proof blockers for maintainer-authored PRs. The external publisher
binds review identity and exact source snapshots, so the renderer does not demand
an upstream comment lease for this mode. Confidence and findings remain blockers.
This setting is never derived from PR text and adds no bypass or merge authority.

Proof: `node scripts/arcforge/gateway-execution-proof.mjs` uses a real local HTTP
server and SQLite store, five synthetic upstream claims, process restart, the
real 120-second expiry, stale-owner rejection and persistent completion receipt.
It does not exercise GitHub dispatch, Cloudflare storage or xAI; the live canary
must cover those before activation. `node --test test/gateway-execution.test.ts`
also verifies private-surface protection and source-revision supersession.

Live permission proof (2026-09-30 UTC): the existing reviewer App minted a
metadata-only token scoped to the public `arcforgelabs/dictate` repository.
GitHub returned HTTP 200 for `/actions/runs/36729011246`,
`/actions/runs/36729011246/attempts/1`, and
`/actions/workflows/pr-context.yml/runs?per_page=1`. Thus this public coordinator
mode does not require expanding the App's Actions permission. Private
coordinators continue to request Actions-read. Enable repository Actions before
activation: the initial fork had the repository-wide Actions switch disabled,
independently of individual workflow state.

## Scheduled re-review

Arc Forge targets are reviewed only on events today: a PR event or an
`@clawsweeper re-review` comment reaches `gateway-review.yml`. Nothing in this
fork re-reviews open items on a schedule:

- The upstream scheduler (`sweep.yml`, the `ClawSweeper` workflow) and
  `hosted-target-admission.yml` are disabled in this fork, and their schedules
  still name `openclaw/*` targets.
- Target fanout lists whole owners from `target_inventory.owners`, and hosted
  admission accepts only configured repositories plus the `openclaw` and
  `steipete` fallbacks. Adding `arcforgelabs` there would enrol every public
  Arc Forge repository at once.
- The gateway executor accepts pull requests only, so no gateway worker would
  take a scheduled issue review.
- `TARGET_REPOS` in `dashboard/wrangler.arcforge.toml` only chooses which
  repositories the status dashboard collects. It does not schedule reviews.

The Arc Forge fallback lists `VISION.md` and `AGENTS.md` as policy documents
(see [Target Repositories](target-repositories.md#policy-documents)). Each
review records their blob SHAs in `review_policy`, so once a scheduler runs, an
edit to either file makes every open item in that repository due and blocks
cached keep-open verdicts. Until then, re-review open items by hand after a
vision change.

### Cost of scheduling a repository

The cadence comes from `src/scheduler-policy.ts`. Items with activity since
their last review are due hourly. Pull requests, and issues opened in the last
30 days, are due daily. Older issues are due weekly, and no item waits more
than six days. So a repository costs about one due check per open PR per day,
not one per item per week. On 2026-10-01, `arcforgelabs/dictate` had 13 open
PRs and 10 open issues, all under 30 days old: about 23 due checks a day.

A due check runs the model only when the review cache misses. An unchanged
item with a keep-open verdict reuses that verdict for up to 14 days, so the
model runs when an item changes, when its last full review is 14 days old, and
for every open item when the review policy changes. Each review uses about 30
GitHub API requests. One edit to a policy document therefore costs one full
review per open item: about 23 model runs for Dictate today.

### Add a repository to the schedule

1. Make the gateway executor accept issues, or keep issues out of the
   scheduled lane.
2. Retarget the `sweep.yml` and `hosted-target-admission.yml` schedules at
   this fork, and point hosted admission at this fork's registry.
3. Add a per-repository allowlist to `target_inventory`, so one repository can
   be enrolled without the whole owner, and list the repository there. Add it
   to `TARGET_REPOS` too so the dashboard shows it; `arcforgelabs/dictate` is
   already listed.
4. Enable the workflows, then run
   `pnpm run target-fanout -- plan --mode normal-review --limit 1 --dry-run`
   before the first scheduled run.
