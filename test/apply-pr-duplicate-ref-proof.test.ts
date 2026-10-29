import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { linkedPullRequestSignalContextsFromText } from "../dist/clawsweeper-pr-references.js";

import {
  lowSignalCloseReport,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runOpenClawApplyDecisionsForTest,
  tmpPrefix,
  withApplyTestWorkspace,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

test("PR reference parsing follows the explicit repository without retaining prior selection", () => {
  const text = "Superseded by openclaw/clawhub#400";
  for (const repo of ["openclaw/openclaw", "openclaw/clawhub", "openclaw/openclaw"]) {
    assert.deepEqual(
      linkedPullRequestSignalContextsFromText(repo, text, 357, 400),
      repo === "openclaw/clawhub" ? [text] : [],
    );
  }
});

test("pull request lists keep the shared relationship for each reference", () => {
  for (const references of [
    "#400, #401 and #402",
    "#400; #401; and #402",
    "openclaw/openclaw#400 and #401",
  ]) {
    const expected = `Superseded by ${references}`;
    for (const number of [400, 401]) {
      assert.deepEqual(
        linkedPullRequestSignalContextsFromText("openclaw/openclaw", `${expected}.`, 357, number),
        [expected],
      );
    }
  }
});

test("pull request relationships stop before an independent clause", () => {
  for (const separator of [", while", ";", " and", " but"]) {
    const text = `Superseded by #400${separator} #401 keeps a different approach.`;
    assert.deepEqual(linkedPullRequestSignalContextsFromText("openclaw/openclaw", text, 357, 400), [
      "Superseded by #400",
    ]);
    assert.deepEqual(linkedPullRequestSignalContextsFromText("openclaw/openclaw", text, 357, 401), [
      "#401 keeps a different approach",
    ]);
  }
});

test("same-repository Markdown links use the destination number within a shared list", () => {
  const text =
    "Superseded by #400 and [replacement #999](https://github.com/openclaw/openclaw/pull/401).";
  for (const number of [400, 401]) {
    const contexts = linkedPullRequestSignalContextsFromText(
      "openclaw/openclaw",
      text,
      357,
      number,
    );
    assert.equal(contexts.length, 1);
    assert.match(contexts[0]!, /^Superseded by #400 and /);
    assert.match(contexts[0]!, /replacement/);
    assert.match(contexts[0]!, /https:\/\/github\.com\/openclaw\/openclaw\/pull\/401$/);
    assert.doesNotMatch(contexts[0]!, /#999/);
  }
  assert.deepEqual(
    linkedPullRequestSignalContextsFromText("openclaw/openclaw", text, 357, 999),
    [],
  );
});

test("apply-decisions ignores bare refs inside cross-repo markdown link labels for duplicate proof", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const proofLogPath = join(root, "proof.log");
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 357,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by [PR #400](https://github.com/other/repo/pull/400)",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by the linked external PR.",
      ),
      357,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "357.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 357,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Unrelated same-repo PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Unrelated provider cleanup.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "failure",
            message: "coverage proof should not run for cross-repo markdown link labels",
            invocationLogPath: proofLogPath,
          },
          () => {
            runOpenClawApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath,
              dryRun: true,
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
  });
});
