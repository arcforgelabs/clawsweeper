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

The coordinator job runs on a GitHub-hosted runner because this repository is
public and the ClawSweeper runner group denies public repositories. Public-repo
minutes are free, but a job that waits on a stopped gateway still occupies a
runner for its full deadline, so `gateway-review-run.mjs` gives the claim back to
the upstream retry path after 15 minutes without executor progress. The
`/gateway/status` response reports `execution` as `waiting`, `running`,
`stalled` or `finished` for that check.

## Activity intake

An `arcforgelabs` organization webhook sends `issues`, `issue_comment` and
`pull_request` events to `/internal/arcforge/github-activity`, signed with
`ARCFORGE_ACTIVITY_WEBHOOK_SECRET`. `dashboard/arcforge-activity.ts` applies the
filter the retired per-repository `clawsweeper-activity.yml` Actions job used:
pull requests and maintainer `@clawsweeper review` commands on pull requests
enter the durable queue; opened or reopened issues and review commands on issues
go to the OpenClaw hook at `team.arcforge.au/hooks/agent`
(`CLAWSWEEPER_OPENCLAW_HOOK_TOKEN`) as an admission-only request, because GitHub
abandons a delivery after ten seconds. Cloudflare Access guards that hook path with Service
Auth, so the Worker also sends the Access service token from the secret
`ARCFORGE_HOOK_ACCESS_SERVICE_TOKEN` (`<client id>:<client secret>`). The
Worker serves only its Access-guarded custom domain: `workers_dev` and
`preview_urls` are off. Only repositories in
`ARCFORGE_ACTIVITY_REPOSITORIES` are routed. Failed deliveries appear in the
webhook's recent deliveries and can be redelivered there. No Actions minutes are
spent on intake.

The delivery reply states what the queue did. `accepted` is `false` with a
`reason` for a stale or closed source (`source_not_current_or_open`), a
duplicate delivery (`duplicate_delivery`) or a queue rejection. A pull request
in private gateway mode first becomes a source-authority reservation, reported
as `stage: "source_authority_reserved"` with its `source_authority_seq`. The
queue alarm then rechecks the target and the live head before it creates the
job. The signed operator route `/internal/exact-review/source-authority/list`
lists waiting reservations and the last 50 dropped ones with a `cause`
(`target_not_admitted`, `head_changed` or `verifier_mismatch`). A dropped
delivery is recorded as handled, so a GitHub redelivery does not retry it; use
`@clawsweeper re-review` instead.

Enrol a repository in both `EXACT_REVIEW_ALLOWED_REPOSITORIES` and
`ARCFORGE_ACTIVITY_REPOSITORIES`. Cloudflare moves the front Worker and the
queue Durable Object to a new version at different moments. For 15 minutes
after the front Worker confirmed eligibility, the queue retries a reservation
whose target its own settings do not yet admit, instead of dropping it.

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
