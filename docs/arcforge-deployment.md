# Arc Forge ClawSweeper deployment

Arc Forge runs a self-hosted ClawSweeper fork for `arcforgelabs/*` repositories.
This document is the operator runbook for bootstrap, conservative mode, and rollout.

## Repositories

| Repo | Role |
|------|------|
| [arcforgelabs/clawsweeper](https://github.com/arcforgelabs/clawsweeper) | Review engine, workflows, repair router |
| [arcforgelabs/clawsweeper-state](https://github.com/arcforgelabs/clawsweeper-state) | Generated state on branch `state`; dashboard renderer on `main` |
| Target repos (phase 1) | `arcforgelabs/arc-forge-console` first, then expand deliberately |

Upstream reference: [openclaw/clawsweeper](https://github.com/openclaw/clawsweeper).

## State repository (Arc Forge only)

`arcforgelabs/clawsweeper-state` is forked from OpenClaw for the dashboard renderer on
`main`, but the generated `state` branch is a **fresh bootstrap** — it does not carry
OpenClaw's historical sweep records (~2.6 GB). ClawSweeper fills `records/`, `jobs/`,
and `results/` as Arc Forge reviews run.

Local checkout when needed:

```bash
# Dashboard renderer source (small)
git clone --branch main --single-branch --depth 1 \
  https://github.com/arcforgelabs/clawsweeper-state.git clawsweeper-state

# Generated state only (grows with our reviews; stay shallow)
git clone --branch state --single-branch --depth 1 \
  https://github.com/arcforgelabs/clawsweeper-state.git /tmp/clawsweeper-state-live
```

Do not full-clone the entire repo history unless you are debugging the state repo itself.

## Phase 1 bootstrap (conservative)

Goal: review selected repos, write durable state, sync maintainer-facing comments, and **not** auto-close, autofix, or automerge.

Configured policy in `config/target-repositories.json`:

- Primary targets: `arcforgelabs/arc-forge-console`, `arcforgelabs/clawsweeper`
- Generic `arcforgelabs/*` fallback: review-only (`apply_close_rules` empty for issues and PRs)
- OpenClaw repository profiles remain for upstream compatibility and apply/reconcile paths, but `target_inventory.owners` is `["arcforgelabs"]` only so scheduled fanout does not sweep OpenClaw repos during bootstrap

Repository variables on `arcforgelabs/clawsweeper`:

| Variable | Bootstrap value | Purpose |
|----------|-----------------|--------|
| `CLAWSWEEPER_CODEX_AUTH_MODE` | `subscription` | Use ChatGPT/Codex subscription auth instead of pay-as-you-go API key |
| `CLAWSWEEPER_ENABLE_SCHEDULES` | unset / `0` | Keep `sweep.yml` cron disabled until first manual verification succeeds |
| `CLAWSWEEPER_COMMENT_ROUTER_EXECUTE` | unset / `0` | Repair command router stays dry-run |
| `CLAWSWEEPER_ENABLE_CLAWHUB` | unset | N/A for Arc Forge |
| `CLAWSWEEPER_AUTO_IMPLEMENT_REPRO_BUGS` | unset / `0` | No issue implementation PRs |
| `CLAWSWEEPER_AUTO_IMPLEMENT_VISION_FIT` | unset / `0` | No vision-fit PRs |

Required secrets on `arcforgelabs/clawsweeper`:

| Secret | Purpose |
|--------|---------|
| `CODEX_AUTH_JSON_B64` | Base64-encoded `auth.json` from a Codex subscription login (`auth_mode: chatgpt`) |
| `CLAWSWEEPER_APP_CLIENT_ID` | Arc Forge GitHub App client ID |
| `CLAWSWEEPER_APP_PRIVATE_KEY` | Arc Forge GitHub App private key PEM |

Optional fallback secrets:

| Secret | Purpose |
|--------|---------|
| `OPENAI_API_KEY` | Only when `CLAWSWEEPER_CODEX_AUTH_MODE=proxy` or `login` |

### Codex auth modes

Default bootstrap mode is **subscription**:

1. On a trusted machine, run `codex login` with your ChatGPT subscription account.
2. Base64-encode `~/.codex/auth.json` without logging it: `base64 -w0 ~/.codex/auth.json`.
3. Store the result as repo secret `CODEX_AUTH_JSON_B64`.
4. Set repo variable `CLAWSWEEPER_CODEX_AUTH_MODE=subscription`.

`setup-codex` writes the decoded file into an isolated per-run `CODEX_HOME/auth.json`. Codex subprocesses never receive `OPENAI_API_KEY` in subscription mode.

**Rotation:** subscription refresh tokens expire or rotate. When `codex login status` fails in Actions, refresh the local login and update `CODEX_AUTH_JSON_B64`.

**Long-term:** prefer a self-hosted runner with persistent `CODEX_HOME` OAuth instead of storing refresh material in GitHub secrets.

**API key fallback:** set `CLAWSWEEPER_CODEX_AUTH_MODE=proxy`, provide `OPENAI_API_KEY`, and accept pay-as-you-go token billing.

Optional later:

- `CLAWSWEEPER_STATUS_INGEST_TOKEN`, Cloudflare tokens — only if deploying the live Worker dashboard
- `CLAWSWEEPER_WEBHOOK_SECRET` — only if deploying the comment webhook Worker

## GitHub App

Create an org GitHub App named **Arc Forge ClawSweeper** (slug suggestion: `arc-forge-clawsweeper`).

Install on:

- `arcforgelabs/clawsweeper`
- `arcforgelabs/clawsweeper-state`
- `arcforgelabs/arc-forge-console` (first target)

Minimum permissions:

| Permission | Access | Why |
|------------|--------|-----|
| Contents | Read & write | State publish, repair branches (later) |
| Issues | Read & write | Comments, labels, closes (closes disabled in bootstrap) |
| Pull requests | Read & write | PR comments, labels, merge readiness |
| Actions | Read & write | Workflow dispatch on `clawsweeper` |
| Workflows | Write | Repair rebases (later) |
| Checks | Write | Optional commit review checks (disabled in bootstrap) |

Subscribe to: Issues, Issue comment, Pull request (if using webhook Worker later).

Store the App ID as repo secret `CLAWSWEEPER_APP_CLIENT_ID` and the generated private key as `CLAWSWEEPER_APP_PRIVATE_KEY`.

Copy the client ID into target dispatch workflows as `CLAWSWEEPER_APP_CLIENT_ID`.

## Target dispatcher

Each reviewed repository needs `.github/workflows/clawsweeper-dispatch.yml`.
See `docs/target-dispatcher.md` in the clawsweeper repo; Arc Forge copies use:

- `owner: arcforgelabs`
- `repositories: clawsweeper`
- dispatch target: `arcforgelabs/clawsweeper`

Target repos also need the org/repo secret `CLAWSWEEPER_APP_PRIVATE_KEY`.

## Verification checklist

1. **CI** — `pnpm run check` passes on `arcforgelabs/clawsweeper` `main`.
2. **Manual review** — workflow dispatch `ClawSweeper` with `target_repo=arcforgelabs/arc-forge-console`, `apply_existing=false`, `batch_size=1`, `shard_count=1` (explicit override for bootstrap), and optionally one `item_number`.
3. **Event review** — open or edit an issue/PR in `arc-forge-console`; confirm dispatcher run and receiver run in `clawsweeper` Actions.
4. **State publish** — confirm `arcforgelabs/clawsweeper-state` branch `state` receives `records/`, `jobs/`, `results/`, and dashboard status JSON.
5. **Comments** — confirm one marker-backed review comment per reviewed item; no issue/PR closes during bootstrap.
6. **Schedules** — only after steps 2–5 succeed, restore `sweep.yml` cron entries and set `CLAWSWEEPER_ENABLE_SCHEDULES=1`.

## Rollout order (recommended)

1. ClawSweeper dry-run / review-only on `arc-forge-console`
2. State publishing + dashboard on `clawsweeper-state`
3. Enable public comments on selected repos (already on in bootstrap once App write perms exist)
4. Add guarded close/fix workflows repo-by-repo after trust is established
5. Docs mirror for console (see `arc-forge-infrastructure/docs/CONSOLE-DOCS-PUBLISHING.md`)
6. Ask-Molty variant tracked as a console enhancement issue

## Local development

```bash
cd ~/repos/clawsweeper
corepack enable
pnpm install
pnpm run build
git -C ../clawsweeper-state switch state
node scripts/hydrate-state.ts --state-dir ../clawsweeper-state
pnpm run plan -- --target-repo arcforgelabs/arc-forge-console --batch-size 1 --shard-count 1 --max-pages 5
```

Requires Node 24 and a configured Codex/OpenAI environment for live review runs.
