# Native xAI subscription reviews

The review command can opt into OpenClaw's native `agent exec` using a dedicated
agent's saved xAI OAuth subscription. The default runner and legacy OpenClaw
invocation are unchanged. This path was developed against OpenClaw 2026.9.6 and
Node 24; it requires native exec and the retained SQLite transcript schema.

Sign in through OpenClaw for the dedicated reviewer agent and set its xAI order
to exactly that profile. The agent's local auth store must contain only that xAI
OAuth profile. Other agents may use their own accounts independently.

```bash
openclaw models auth login --agent reviewer --provider xai --method oauth
openclaw models auth order set --agent reviewer --provider xai xai:review@example.com

CLAWSWEEPER_RUNNER=openclaw \
CLAWSWEEPER_OPENCLAW_MODEL=xai/grok-4.7 \
CLAWSWEEPER_OPENCLAW_NATIVE_EXEC=1 \
CLAWSWEEPER_OPENCLAW_AUTH_AGENT_ID=reviewer \
CLAWSWEEPER_OPENCLAW_AUTH_AGENT_DIR="$HOME/.openclaw/agents/reviewer/agent" \
CLAWSWEEPER_OPENCLAW_AUTH_PROFILE_ID=xai:review@example.com \
pnpm run review -- --local-only --target-repo owner/repo \
  --target-dir ../target --item-number 123 --result-format json
```

Keep these variables scoped to the review invocation. This does not change
repair workflows, activate hosted jobs, or replace a GitHub approval workflow.
`--local-only` does not publish a review comment.

The adapter validates the local account and saved order before launching. It
passes only basic OS environment variables, supplies a minimal xAI-only plugin
configuration, and sets no model fallbacks. Provider API keys, workflow tokens,
inherited OpenClaw controls, and custom provider blocks cannot substitute another
credential. OpenClaw reads and refreshes the original saved login; credentials
are not copied into ClawSweeper configuration or its temporary state.

Each invocation has separate temporary ambient and execution state. Checkout
inspection still allows only the read tool and must return the host-selected
line. Its receipt is decoded from the exact native session's SQLite events,
including zstd records, then checked by the existing exact-path read validator.
Missing events, malformed payloads, failed reads, extra tools, wrong paths, and
oversized transcripts fail closed. Inspection retains its existing 30-second
budget. Temporary state is removed after the existing process supervisor exits.

Input scans, output scans, and report/schema validation remain in place. Native
exec success must also identify the requested xAI model. OpenClaw Bay is
unaffected: review report and publication contracts have not changed.

Operational limits: gateway load can exhaust the existing inspection timeout.
OpenClaw 2026.9.6 can also log post-run auth bookkeeping warnings when the original
agent database is concurrently maintained; inspect those separately from the
native inference result. Do not disable receipt verification to work around a
runtime/schema incompatibility.

## Behavior proof (2026-09-29)

Claim: a native review can use an existing agent-owned xAI OAuth subscription
without substituting another account, while preserving checkout-read receipts.
The controlled environment is Arc Haven, OpenClaw 2026.9.6 (`eb377ac`), Node 24,
and an isolated candidate checkout based on `73186a07eb`.

The actual `runOpenclawProcess` checkout-inspection path returned status 0 after
reading a host-selected file through the saved Horizon login. Independently
inspected native SQLite events matched the exact read path and successful tool
result. The private host artifact is `/tmp/horizon-native-proof/adapter-proof.json`.
Separate real native reads returned undisclosed file contents; one retained
session was `3f1974b5-c803-41f3-b531-1df9ab327e57`.

Real runtime receipts were uncompressed. SQLite/zstd fixtures exercise compressed
records, malformed encodings, session isolation, sequence gaps, wrong-account
rejection, environment filtering, and final-answer normalization. Run the narrow
suite with `pnpm run build && node --test test/openclaw-native-exec.test.ts
test/openclaw-process.test.ts`. These tests support, but do not replace, the
runtime proof. Full PR-report generation and production promotion are separate
checks; a successful checkout challenge alone does not prove either.

The local-only review of `arcforgelabs/arc-forge-tools` PR 106 completed on Arc
Haven against head `167cfee2e6b2eeaf8f7bd7c9577026af304dc4f1`, producing a validated
report with actionable findings and `local_checkout_access: verified`. It took
917 seconds at high reasoning effort. The report and JSON result are retained
on that host under `/tmp/horizon-native-proof/pr106-review.json`. No GitHub
comment or approval was published. GitHub check-run hydration returned HTTP 403
with the existing read credential, so CI visibility was unavailable.

The final adapter also passed a fresh real checkout challenge using mixed-case
`ClawSweeper`; `/tmp/horizon-native-proof/adapter-final-proof.json` records status 0. The full repository check has 14 failures reproduced in a clean checkout of
its base; the focused native/process suite passes all 19 tests. Documentation
and CLI-label regression tests also pass. These baseline failures are not waived
for unrelated future changes.
