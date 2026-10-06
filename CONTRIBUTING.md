# Contributing to ClawSweeper

ClawSweeper is the conservative maintenance bot for OpenClaw repositories. This
guide is for people and coding agents preparing or updating a ClawSweeper pull
request. It complements the repository's [README](README.md) and
[documentation index](docs/README.md). [AGENTS.md](AGENTS.md) is the binding
instruction file for agents.

## Before You Start

- Keep one focused problem and one pull request together. Check open pull
  requests first so a new change does not duplicate active work.
- Start an issue or ask a maintainer before broad product, architecture,
  automation, workflow, or security work. Route security-sensitive work through
  the repository's security handling instead of a normal public PR.
- For an `openclaw/openclaw` target PR, do not submit a normal PR that edits
  `CHANGELOG.md`. That changelog is release-owned; put release-note context in
  the PR body and commit message. For ClawSweeper or another target repository,
  follow that repository's release-note policy.
- Read the root `AGENTS.md`, then any scoped instructions for files you touch.
  Coding agents must follow those instructions even when this guide is shorter.

## Local Setup and Focused Validation

ClawSweeper requires Node 24 or newer.

```bash
corepack enable
pnpm install
pnpm run build
pnpm run check
```

Corepack reads the pinned `pnpm@12.4.1` version from `package.json`; do not
replace it with an unpinned global pnpm command in canonical examples.

Workflow-intake fixtures require Bash 4+ for `mapfile`. macOS `/bin/bash` 3.2 is
insufficient; select an installed newer Bash on `PATH` for validation, for example
`PATH="/opt/homebrew/opt/bash/bin:$PATH" pnpm run check`. This does not change your
default shell.

Use the narrowest meaningful validation for the changed surface first. For a
docs-only change, run `git diff --check` and verify the changed links and
commands. For code, test, workflow, queue, API, UI, package, or integration
changes, follow `AGENTS.md`: satisfy the real-behavior proof contract and
mandatory Codex review loop before opening even a draft PR or updating one.
Only Martin may expressly approve an evidence-in-progress exception.

Documentation-only changes should also classify new pages as active, proposed,
compatibility-only, or historical. Active runbooks need a role owner, owning
source, last-verified revision, and concrete update triggers; see the
[documentation index](docs/README.md#document-lifecycle).
Run `pnpm run check:docs` while editing documentation; the full `pnpm run check`
gate runs it again through the static-check path.

## Create or Update a Pull Request

Use the [pull request template](.github/pull_request_template.md). Keep these
main-body sections current:

- **What Problem This Solves** — the concrete user, product, or operator
  problem and trigger.
- **User Impact** — the concrete outcome in plain language, or a clear statement
  that there is no user-visible change. Keep important risks and actions visible.
- **Why This Change Was Made** — a brief explanation without implementation
  inventories. Keep technical details optional and material tradeoffs visible.
- **Evidence** — focused tests, CI, screenshots, terminal output, live
  observations, redacted logs, or artifact links that make the validation easy
  to inspect.

For code-bearing changes, keep an executed `## Real Behavior Proof` package in
the main PR body. State the claim, exercised surface, scenario or fixture,
command and environment, observed result, artifact or trace, and limits. Tests,
CI, mocks, and clean review support the claim but do not replace proof of a
changed runtime, workflow, queue, API, UI, package, or integration path.
Redact tokens, private URLs, user data, and unrelated logs before posting
evidence.

## Review Conversations Are Author-Owned

Treat a ClawSweeper or maintainer result as the next-step checklist for the PR,
not as a handoff.

1. Read the latest durable ClawSweeper comment, its reviewed head, proof
   guidance, accepted findings, and any contributor-facing blocker.
2. Address every accepted or actionable finding. Apply an applicable
   `Rank-up moves:` item, or explain the exception in the main PR body; those
   optional moves are not blockers by themselves.
3. Put the updated proof and each finding's disposition or supporting evidence
   in the main PR body. Do not leave required proof only in a comment.
4. If the branch head or PR body changed after the latest durable review, treat
   that review and any affected proof as stale. Rerun the affected proof and
   wait until the next review applies to the current head and body.
5. Request `@clawsweeper re-review` only after the branch, body, proof, and
   relevant checks are current. PR authors and users with repository write
   access may use `@clawsweeper re-review` or `@clawsweeper re-run`; plain
   `@clawsweeper review` is maintainer-only. Do not dispatch a review workflow
   directly.

`status: ⏳ waiting on author` or `status: 📣 needs proof` means the next action
belongs to the author. Let the normal queue finish after a current re-review;
repeated commands before the requested changes are present add noise rather
than evidence.

## Readiness and Landing

`proof: sufficient` and `status: 👀 ready for maintainer look` are evidence for
maintainer review, not approval to merge. Contributors must not use maintainer
repair, autofix, automerge, approve, or workflow-dispatch routes. Agents must
not merge or enable/execute automerge without the user's explicit approval in
the current conversation, even when a PR is otherwise ready. Normal ClawSweeper
mutation and merge routes remain maintainer-controlled and subject to their
separate exact-head, check, mergeability, and policy gates.

If a human maintainer is already actively repairing or reviewing the PR, do not
work on the branch or summon a parallel ClawSweeper lane. Keep the discussion on
the PR; ask for maintainer direction only when the next decision or proof
requires it.

<!-- arc-forge-org-consistency:start -->
## Issue, PR, and contact routing

This follows upstream OpenClaw's routing. Start here before you create a GitHub item:

| Situation | Use | Required evidence |
| --- | --- | --- |
| Bug, regression, crash or wrong behaviour | Bug report form | Repro steps, expected and actual behaviour, version, OS, model and provider route when relevant, logs or screenshots, impact |
| Wrong, missing or contradictory docs | Docs bug report form | Docs path or URL, verification steps, expected and actual content, impact, evidence |
| New capability or improvement | Feature request form | Problem, proposed solution, alternatives, impact, examples, whether you will open the PR |
| Security issue | This repo's `SECURITY.md`; without one, the [Arc Forge security policy](https://github.com/arcforgelabs/business/blob/master/SECURITY.md) | Never paste a credential, in full or in part |
| Defect in OpenClaw itself | The upstream repo's own forms and `CONTRIBUTING.md` | What upstream asks for, in its language (American English for OpenClaw) |
| PR for an existing or new issue | `.github/pull_request_template.md` | Visible `Closes #<issue>` or `Related: #<issue>`, then the four sections below |

The forms in `.github/ISSUE_TEMPLATE/` are copies of upstream OpenClaw's. Answer every field from observed evidence. Where the evidence does not answer a field, write exactly `NOT_ENOUGH_INFO`. File one issue per report, and reuse an open issue rather than file a duplicate. Without the web form (for example `gh issue create`), use each field label as a `###` heading in the body.

For agent-authored or non-trivial work, create or reuse the issue first, then open the PR against it. Do not tag people to route work; the forms and labels do that.

## Pull request body

Use `.github/pull_request_template.md` and keep the body current:

- **What Problem This Solves** — the concrete problem and when it happens.
- **User Impact** — what someone can now do, or a plain statement that there is no user-visible change.
- **Why This Change Was Made** — the shipped solution and any boundary that matters.
- **Evidence** — the command, commit, result, and what was not run. Screenshots show the real product. Placeholder text does not count.

Edit the pull request body when someone asks for more proof. A review comment can point at that edit. The body stays the record. Maintainer authorship does not remove this requirement.
<!-- arc-forge-org-consistency:end -->
