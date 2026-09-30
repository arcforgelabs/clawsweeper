---
name: arcforge-pr-maintainer
description: "Require Arc Forge pull request problem, impact, and evidence sections."
---

# Arc Forge pull request maintainer

Use this for Arc Forge issue and pull request work. The source of this skill is `arc-forge-tools`. A repo `AGENTS.md` rule that asks for more proof wins over this skill.

## Pull request body

Create or update the body from `.github/pull_request_template.md`. These four sections need authored text:

- What Problem This Solves
- Why This Change Was Made
- User Impact
- Evidence

HTML comments and placeholders such as `tbd`, `n/a`, and `not tested` do not count. Maintainer authorship does not skip the sections.

When a review asks for more proof, edit the body. A short comment may point at the edit. The body stays the record.

## Evidence

Write the command, the commit, the result, and what was not run. For a screen, use the real product, name the viewport, and say whether the data was synthetic or live.

A passing test is evidence about this source. Production activation, customer cutover, and live revocation are a separate record. Do not treat that unfinished work as a reason to hide a source defect, and do not treat a source test as that activation record.

If the proof could not be run, say exactly what is missing and why. The closest real command still goes in Evidence.

## Before merge

Read the diff, the linked issue, and the check named `PR context`. Do not merge a bug fix on the pull request text alone. A green `PR context` check means the four sections have text. It does not judge whether the fix is right.
