import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertMatchesJsonSchema } from "../scripts/hosted-review-canary-proof.mjs";

import {
  parseDecision,
  renderReviewCommentFromReport,
  reviewActionForDecision,
  validateCloseDecision,
} from "../dist/clawsweeper.js";
import {
  REPOSITORY_PROFILES,
  repositoryProfileFor,
  validateTargetRepositoryConfigForTest,
} from "../dist/repository-profiles.js";
import { closeDecision, git, item, reportFrontMatter } from "./helpers.ts";

const DESTINATION = {
  repo: "openclaw/openclaw",
  visionPath: "VISION.md",
  visionLine: 14,
  visionQuote: "Fixes to OpenClaw itself land upstream in openclaw/openclaw first.",
};

const VISION_EVIDENCE = {
  repo: "arcforgelabs/openclaw-deploy",
  label: "VISION.md scope",
  detail: "VISION.md says OpenClaw fixes land upstream first.",
  file: "VISION.md",
  line: 14,
  command: null,
  sha: null,
};

function forkItem(overrides = {}) {
  return item({
    repo: "arcforgelabs/openclaw-deploy",
    url: "https://github.com/arcforgelabs/openclaw-deploy/issues/123",
    ...overrides,
  });
}

function belongsElsewhereDecision(overrides = {}) {
  return closeDecision({
    closeReason: "belongs_elsewhere",
    closeDestination: DESTINATION,
    summary: "The bug is in OpenClaw's gateway, which VISION.md routes upstream.",
    bestSolution: "Report the gateway bug in openclaw/openclaw and link it here.",
    evidence: [VISION_EVIDENCE],
    ...overrides,
  });
}

test("schema offers belongs_elsewhere with a required, nullable destination", () => {
  const schema = JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8"));
  assert.ok(schema.properties.closeReason.enum.includes("belongs_elsewhere"));
  assert.ok(schema.required.includes("closeDestination"));
  const destination = schema.properties.closeDestination;
  assert.deepEqual(destination.type, ["object", "null"]);
  assert.deepEqual(destination.required, ["repo", "visionPath", "visionLine", "visionQuote"]);
  assertMatchesJsonSchema(null, destination);
  assertMatchesJsonSchema(DESTINATION, destination);
  for (const repo of ["openclaw", "openclaw/openclaw/extra", "https://github.com/a/b", ""]) {
    assert.throws(() => assertMatchesJsonSchema({ ...DESTINATION, repo }, destination), /pattern/);
  }
  assert.throws(
    () => assertMatchesJsonSchema({ ...DESTINATION, visionQuote: "one\ntwo" }, destination),
    /pattern/,
  );
});

test("decision parser keeps a valid destination only for belongs_elsewhere", () => {
  const parsed = parseDecision(belongsElsewhereDecision(), forkItem());
  assert.equal(parsed.closeReason, "belongs_elsewhere");
  assert.deepEqual(parsed.closeDestination, DESTINATION);

  const trimmed = parseDecision(
    belongsElsewhereDecision({
      closeDestination: { ...DESTINATION, repo: " openclaw/openclaw ", visionLine: null },
    }),
  );
  assert.deepEqual(trimmed.closeDestination, { ...DESTINATION, visionLine: null });

  // Legacy output without the field and other reasons with a stray destination.
  assert.equal(parseDecision(closeDecision()).closeDestination, undefined);
  assert.equal(
    parseDecision(closeDecision({ closeDestination: null })).closeDestination,
    undefined,
  );
  assert.equal(
    parseDecision(closeDecision({ closeDestination: DESTINATION })).closeDestination,
    undefined,
  );
});

test("decision parser rejects malformed destinations", () => {
  const cases: Array<[Record<string, unknown> | string, RegExp]> = [
    [{ ...DESTINATION, repo: "openclaw" }, /repo must look like owner\/repo/],
    [{ ...DESTINATION, repo: "-bad/repo" }, /repo must look like owner\/repo/],
    [{ ...DESTINATION, repo: "owner/.." }, /repo must look like owner\/repo/],
    [{ ...DESTINATION, repo: "owner/repo.git" }, /repo must look like owner\/repo/],
    [{ ...DESTINATION, visionPath: "README.md" }, /VISION\.md path/],
    [{ ...DESTINATION, visionPath: "/abs/VISION.md" }, /VISION\.md path/],
    [{ ...DESTINATION, visionPath: "../VISION.md" }, /VISION\.md path/],
    [{ ...DESTINATION, visionLine: 0 }, /visionLine/],
    [{ ...DESTINATION, visionLine: 1.5 }, /visionLine/],
    [{ ...DESTINATION, visionQuote: "  " }, /visionQuote must not be empty/],
    [{ ...DESTINATION, visionQuote: "a\nb" }, /visionQuote must be a single-line/],
    [{ ...DESTINATION, visionQuote: "x".repeat(401) }, /at most 400/],
    [{ ...DESTINATION, extra: true }, /unexpected keys: extra/],
    ["openclaw/openclaw", /closeDestination must be an object/],
  ];
  for (const [closeDestination, pattern] of cases) {
    assert.throws(
      () => parseDecision(belongsElsewhereDecision({ closeDestination })),
      pattern,
      JSON.stringify(closeDestination),
    );
  }
});

test("belongs_elsewhere is recommend-only in every repository profile", () => {
  for (const profile of REPOSITORY_PROFILES) {
    for (const kind of ["issue", "pull_request"] as const) {
      assert.equal(
        profile.applyCloseRules[kind]?.includes("belongs_elsewhere") ?? false,
        false,
        `${profile.targetRepo} ${kind}`,
      );
    }
  }
  const arcforge = repositoryProfileFor("arcforgelabs/openclaw-deploy");
  assert.deepEqual(arcforge.applyCloseRules, { issue: [], pull_request: [] });

  const config = (reasons: string[]) => ({
    schema_version: 2,
    repositories: [
      {
        target_repo: "example/repo",
        display_name: "Example",
        checkout_dir: "repo",
        prompt_note: "Review the example repository.",
        apply_close_rules: { issue: reasons, pull_request: [] },
      },
    ],
    generic_fallbacks: [],
  });
  assert.doesNotThrow(() => validateTargetRepositoryConfigForTest(config(["clawhub"])));
  assert.throws(
    () => validateTargetRepositoryConfigForTest(config(["belongs_elsewhere"])),
    /belongs_elsewhere is recommend-only and cannot be auto-applied/,
  );
});

test("close validation fails closed and never applies belongs_elsewhere", () => {
  const valid = parseDecision(belongsElsewhereDecision(), forkItem());
  for (const target of [forkItem(), item()]) {
    const result = validateCloseDecision(target, valid);
    assert.equal(result.ok, false);
    assert.equal(result.actionTaken, "skipped_invalid_decision");
  }
  assert.match(
    validateCloseDecision(forkItem(), valid).reason,
    /belongs_elsewhere is not allowed for arcforgelabs\/openclaw-deploy issue apply policy/,
  );

  const reasons: Array<[Record<string, unknown>, Record<string, unknown>, RegExp]> = [
    [{}, { closeDestination: null }, /requires a closeDestination/],
    [
      {},
      { closeDestination: { ...DESTINATION, repo: "ArcForgeLabs/OpenClaw-Deploy" } },
      /must differ from the reviewed repository/,
    ],
    [{}, { evidence: [{ ...VISION_EVIDENCE, file: "README.md" }] }, /evidence citing the VISION/],
    [{ authorAssociation: "MEMBER" }, {}, /cannot close maintainer-authored items/],
  ];
  for (const [itemOverrides, decisionOverrides, pattern] of reasons) {
    const result = validateCloseDecision(
      forkItem(itemOverrides),
      parseDecision(belongsElsewhereDecision(decisionOverrides)),
    );
    assert.equal(result.ok, false);
    assert.equal(result.actionTaken, "skipped_invalid_decision");
    assert.match(result.reason, pattern);
  }

  // The evidence path may carry a line suffix or a ./ prefix.
  const lineSuffixed = validateCloseDecision(
    forkItem(),
    parseDecision(
      belongsElsewhereDecision({ evidence: [{ ...VISION_EVIDENCE, file: "./VISION.md:14" }] }),
    ),
  );
  assert.match(lineSuffixed.reason, /not allowed for .* apply policy/);

  // Maintainer-authored items keep upstream's review-lane close guard.
  const maintainerAction = reviewActionForDecision({
    item: forkItem({ authorAssociation: "OWNER" }),
    decision: valid,
    git,
  });
  assert.equal(maintainerAction.actionTaken, "skipped_maintainer_authored");
  assert.equal(maintainerAction.closeComment, "");
});

function belongsElsewhereReport(
  frontMatter: Record<string, unknown> = {},
  evidenceFile = "VISION.md",
) {
  return `${reportFrontMatter({
    repository: "arcforgelabs/openclaw-deploy",
    number: 123,
    decision: "close",
    close_reason: "belongs_elsewhere",
    action_taken: "skipped_invalid_decision",
    close_destination: JSON.stringify({
      ...DESTINATION,
      visionQuote: "Fixes to OpenClaw itself land upstream first; ping @someone there.",
    }),
    ...frontMatter,
  })}
# Gateway drops reconnects

## Summary

The reconnect bug is in OpenClaw's gateway, which this repository's VISION.md routes upstream.

## Best Possible Solution

Report the gateway bug in openclaw/openclaw and link it here.

## Evidence

- **VISION.md scope:** VISION.md says OpenClaw fixes land upstream first.
  - repo: arcforgelabs/openclaw-deploy
  - file: \`${evidenceFile}:14\`
`;
}

test("public review names the destination and quotes VISION.md", () => {
  const comment = renderReviewCommentFromReport(belongsElsewhereReport(), "belongs_elsewhere");
  assert.match(
    comment,
    /this work belongs in \[`openclaw\/openclaw`\]\(https:\/\/github\.com\/openclaw\/openclaw\) rather than here/,
  );
  assert.match(comment, /\*\*Where this belongs\*\*/);
  assert.match(comment, /`VISION\.md`, line 14 says:/);
  assert.match(
    comment,
    /^> Fixes to OpenClaw itself land upstream first; ping @\u200bsomeone there\.$/m,
  );
  assert.match(comment, /will not open an issue or PR in \[`openclaw\/openclaw`\]/);
  assert.match(comment, /scope recommendation, not a close\. A maintainer decides/);
  assert.doesNotMatch(comment, /I’m closing this/);
});

test("public review falls back to keep-open when the destination is unusable", () => {
  for (const report of [
    belongsElsewhereReport({ close_destination: "null" }),
    belongsElsewhereReport({ close_destination: '{"repo":"not-a-slug"}' }),
    belongsElsewhereReport({
      close_destination: JSON.stringify({ ...DESTINATION, repo: "arcforgelabs/openclaw-deploy" }),
    }),
    belongsElsewhereReport({}, "README.md"),
  ]) {
    const comment = renderReviewCommentFromReport(report, "belongs_elsewhere");
    assert.doesNotMatch(comment, /Where this belongs/);
    assert.doesNotMatch(comment, /belongs in another repository rather than here/);
  }
});

test("review prompt explains when to recommend another repository", () => {
  const prompt = readFileSync(new URL("../prompts/review-item.md", import.meta.url), "utf8");
  assert.match(prompt, /- `belongs_elsewhere`: /);
  assert.match(prompt, /a `VISION\.md` line, not inference, places the work elsewhere/);
  assert.match(prompt, /This reason is recommend-only: ClawSweeper never auto-applies it/);
  assert.match(prompt, /set `closeDestination` to null/);
  assert.doesNotMatch(prompt, /arcforge/i);
});
