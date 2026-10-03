# Belongs-Elsewhere Recommendation Policy

Read when changing how ClawSweeper recommends moving work to another
repository.

`belongs_elsewhere` is the parameterised sibling of `clawhub`. Where `clawhub`
says "this belongs on ClawHub" for OpenClaw, `belongs_elsewhere` says "this
belongs in `owner/repo`" for any target whose `VISION.md` names another
repository as the owner of that kind of work. Typical cases:

- an upstream project where the fix should land first
- a plugin or extension repository rather than core
- a different layer of the same product (deployment vs application vs docs)
- a client- or deployment-specific repository

## What the reviewer must supply

A decision with `closeReason: "belongs_elsewhere"` carries `closeDestination`:

| Field         | Rule                                                    |
| ------------- | ------------------------------------------------------- |
| `repo`        | `owner/repo`; must differ from the reviewed repository  |
| `visionPath`  | repository-relative path ending in `VISION.md`          |
| `visionLine`  | 1-based line of the quote, or `null`                    |
| `visionQuote` | the `VISION.md` text, verbatim, one line, max 400 chars |

The decision's `evidence` must also include an entry whose `file` is the same
`VISION.md` path. For every other reason `closeDestination` is `null`, and the
parser drops one supplied by mistake.

Shape errors (bad slug, non-`VISION.md` path, empty or multi-line quote) are
schema violations and fail the review output like any other. A
`belongs_elsewhere` decision that is missing its destination, points at the
reviewed repository, or lacks the `VISION.md` evidence entry fails closed: the
action is `skipped_invalid_decision` and the public review renders as a normal
keep-open review instead of an unnamed "belongs elsewhere".

## Public wording

The durable review comment names the destination, links it, and quotes the
`VISION.md` line, then states the boundary: ClawSweeper does not open an issue
or PR in the destination, transfer the item, or close it. A maintainer decides
whether to move or close it.

## Recommend-only

No repository profile can auto-apply this reason. `apply_close_rules` in
`config/target-repositories.json` rejects `belongs_elsewhere` at load time, the
core OpenClaw profile does not list it, and the repair lane's close-candidate
set excludes it. Maintainer-authored items, protected labels, and the other
review-lane close guards apply exactly as for every other reason.

Making it auto-applicable later needs three changes together: remove it from
`RECOMMEND_ONLY_CLOSE_REASONS` in `src/repository-profiles.ts`, list it in the
chosen profile, and change the public wording, which currently promises that
ClawSweeper will not close the item.
