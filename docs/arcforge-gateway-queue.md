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
