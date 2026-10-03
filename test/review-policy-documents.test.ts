import assert from "node:assert/strict";
import test from "node:test";

import { reviewPolicyHashForTest } from "../dist/clawsweeper-runtime.js";
import {
  repositoryProfileFor,
  validateTargetRepositoryConfigForTest,
} from "../dist/repository-profiles.js";
import {
  POLICY_DOCUMENT_ABSENT,
  createPolicyDocumentRevisionReader,
  policyDocumentRevisionsFromRootListing,
} from "../dist/review-policy-documents.js";
import { reviewContentCacheHit, shouldReviewItem } from "../dist/scheduler-policy.js";

const VISION_V1 = "1".repeat(40);
const VISION_V2 = "2".repeat(40);
const AGENTS_V1 = "a".repeat(40);
const AGENTS_V2 = "b".repeat(40);
const README_V1 = "c".repeat(40);
const README_V2 = "d".repeat(40);

function rootListing(
  options: { vision?: string | null; agents?: string | null; readme?: string } = {},
) {
  const entries: Array<Record<string, unknown>> = [
    { name: "README.md", path: "README.md", type: "file", sha: options.readme ?? README_V1 },
    { name: "docs", path: "docs", type: "dir", sha: "e".repeat(40) },
  ];
  if (options.vision !== null) {
    entries.push({
      name: "VISION.md",
      path: "VISION.md",
      type: "file",
      sha: options.vision ?? VISION_V1,
    });
  }
  if (options.agents !== null) {
    entries.push({
      name: "AGENTS.md",
      path: "AGENTS.md",
      type: "file",
      sha: options.agents ?? AGENTS_V1,
    });
  }
  return entries;
}

function dictateHash(listing: unknown): string {
  return reviewPolicyHashForTest({
    targetRepo: "arcforgelabs/dictate",
    policyDocumentRootListing: () => listing,
  });
}

function fallbackConfig(policyDocuments: unknown) {
  return {
    schema_version: 2,
    repositories: [],
    generic_fallbacks: [
      {
        owner: "example",
        deny_repositories: [],
        allow_repo_name_pattern: "^[A-Za-z0-9_.-]+$",
        prompt_note: "Review {target_repo}.",
        apply_close_rules: { issue: [], pull_request: [] },
        policy_documents: policyDocuments,
      },
    ],
  };
}

test("root listing resolves configured documents to blob SHAs or absent", () => {
  assert.deepEqual(
    policyDocumentRevisionsFromRootListing(rootListing({ agents: null }), [
      "VISION.md",
      "AGENTS.md",
    ]),
    { "VISION.md": VISION_V1, "AGENTS.md": POLICY_DOCUMENT_ABSENT },
  );
  // A directory with a document's name is not that document.
  assert.deepEqual(
    policyDocumentRevisionsFromRootListing(
      [{ name: "VISION.md", path: "VISION.md", type: "dir", sha: VISION_V1 }],
      ["VISION.md"],
    ),
    { "VISION.md": POLICY_DOCUMENT_ABSENT },
  );
});

test("malformed root listings fail instead of guessing a revision", () => {
  assert.throws(
    () => policyDocumentRevisionsFromRootListing({ message: "Not Found" }, ["VISION.md"]),
    /must be an array/,
  );
  assert.throws(
    () =>
      policyDocumentRevisionsFromRootListing(
        [{ name: "VISION.md", type: "file", sha: "not-a-sha" }],
        ["VISION.md"],
      ),
    /no blob SHA/,
  );
  assert.throws(
    () => policyDocumentRevisionsFromRootListing([null], ["VISION.md"]),
    /malformed entry/,
  );
});

test("profiles without policy documents never fetch", () => {
  let fetches = 0;
  const read = createPolicyDocumentRevisionReader(() => {
    fetches++;
    return rootListing();
  });
  assert.equal(read(repositoryProfileFor("openclaw/openclaw")), undefined);
  assert.equal(read({ targetRepo: "example/repo", policyDocuments: [] }), undefined);
  assert.equal(fetches, 0);
});

test("policy document revisions are fetched once per target repo", () => {
  const fetched: string[] = [];
  const read = createPolicyDocumentRevisionReader((repo) => {
    fetched.push(repo);
    return rootListing();
  });
  const dictate = repositoryProfileFor("arcforgelabs/dictate");
  const website = repositoryProfileFor("arcforgelabs/arc-forge-website");
  assert.deepEqual(read(dictate), { "VISION.md": VISION_V1, "AGENTS.md": AGENTS_V1 });
  read(dictate);
  read(website);
  assert.deepEqual(fetched, ["arcforgelabs/dictate", "arcforgelabs/arc-forge-website"]);
});

test("Arc Forge targets opt in to VISION.md and AGENTS.md; upstream profiles do not", () => {
  assert.deepEqual(repositoryProfileFor("arcforgelabs/dictate").policyDocuments, [
    "VISION.md",
    "AGENTS.md",
  ]);
  assert.equal("policyDocuments" in repositoryProfileFor("openclaw/openclaw"), false);
  assert.equal("policyDocuments" in repositoryProfileFor("openclaw/clawsweeper"), false);
  assert.equal("policyDocuments" in repositoryProfileFor("steipete/camsnap"), false);
});

test("policy_documents accepts only distinct root-level file names", () => {
  const parsed = validateTargetRepositoryConfigForTest(fallbackConfig(["VISION.md"]));
  assert.deepEqual(parsed.genericFallbacks[0]?.policyDocuments, ["VISION.md"]);
  for (const invalid of [
    [],
    "VISION.md",
    ["docs/VISION.md"],
    [".."],
    ["VISION.md", "VISION.md"],
    Array.from({ length: 9 }, (_, index) => `DOC${index}.md`),
  ]) {
    assert.throws(
      () => validateTargetRepositoryConfigForTest(fallbackConfig(invalid)),
      /policy_documents/,
    );
  }
});

test("review policy hash follows the target's VISION.md and AGENTS.md blobs only", () => {
  const baseline = dictateHash(rootListing());
  assert.equal(dictateHash(rootListing()), baseline);
  assert.equal(dictateHash(rootListing({ readme: README_V2 })), baseline);
  assert.notEqual(dictateHash(rootListing({ vision: VISION_V2 })), baseline);
  assert.notEqual(dictateHash(rootListing({ agents: AGENTS_V2 })), baseline);
  assert.notEqual(dictateHash(rootListing({ vision: null })), baseline);
});

test("upstream review policy hashes are unchanged and never read policy documents", () => {
  let fetches = 0;
  const withReader = reviewPolicyHashForTest({
    targetRepo: "openclaw/openclaw",
    policyDocumentRootListing: () => {
      fetches++;
      return rootListing({ vision: VISION_V2 });
    },
  });
  assert.equal(withReader, reviewPolicyHashForTest({ targetRepo: "openclaw/openclaw" }));
  assert.equal(fetches, 0);
});

test("a VISION.md change makes reviewed items due and bypasses cached keep-open verdicts", () => {
  const now = Date.parse("2026-10-01T00:00:00.000Z");
  const before = dictateHash(rootListing());
  const after = dictateHash(rootListing({ vision: VISION_V2 }));
  const item = {
    repo: "arcforgelabs/dictate",
    number: 116,
    kind: "issue" as const,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
  const review = {
    reviewedAt: "2026-09-30T23:00:00.000Z",
    itemUpdatedAt: "2026-09-30T00:00:00.000Z",
    reviewStatus: "complete",
    reviewPolicy: before,
    decision: "keep_open",
    contentDigest: "same-content",
    lastFullReviewAt: "2026-09-30T23:00:00.000Z",
    lastFullReviewDecision: "keep_open",
  };
  const cacheInput = {
    review,
    contentDigest: "same-content",
    now,
    explicitDispatch: false,
    maintainerRequest: false,
  };
  assert.equal(shouldReviewItem(item, review, now, before), false);
  assert.equal(reviewContentCacheHit({ ...cacheInput, reviewPolicy: before }), true);
  assert.equal(shouldReviewItem(item, review, now, after), true);
  assert.equal(reviewContentCacheHit({ ...cacheInput, reviewPolicy: after }), false);
});
