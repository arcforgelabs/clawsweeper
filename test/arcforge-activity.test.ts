import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  arcforgeActivityRepositories,
  arcforgeActivityRoute,
  postArcforgeHook,
} from "../dashboard/arcforge-activity.ts";
import worker from "../dashboard/worker.ts";

const enrolled = new Set(["arcforgelabs/example"]);
const repository = { full_name: "arcforgelabs/example", default_branch: "main" };
const pr = {
  number: 7,
  state: "open",
  author_association: "MEMBER",
  draft: false,
  updated_at: "2026-10-11T00:00:00Z",
  head: { sha: "a".repeat(40) },
  base: { sha: "b".repeat(40), ref: "main" },
};

test("pull request events become signed durable queue envelopes", async () => {
  const routed = await arcforgeActivityRoute(
    "pull_request",
    { action: "synchronize", repository, pull_request: pr },
    "delivery-1",
    enrolled,
  );
  assert.equal(routed.route, "queue");
  if (routed.route !== "queue") return;
  assert.match(routed.envelope.delivery_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(routed.envelope.decision, {
    targetRepo: "arcforgelabs/example",
    targetBranch: "main",
    itemNumber: 7,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
    sourceHeadSha: "a".repeat(40),
    sourceBaseSha: "b".repeat(40),
    sourceIsDraft: false,
    sourceUpdatedAt: "2026-10-11T00:00:00Z",
  });
  const redelivered = await arcforgeActivityRoute(
    "pull_request",
    { action: "synchronize", repository, pull_request: pr },
    "delivery-1",
    enrolled,
  );
  assert.deepEqual(redelivered, routed);
});

test("maintainer review commands on PRs queue; on issues they reach the hook without text", async () => {
  const comment = { author_association: "MEMBER", body: "@clawsweeper re-review" };
  const onPr = await arcforgeActivityRoute(
    "issue_comment",
    {
      action: "created",
      repository,
      comment,
      issue: { number: 7, state: "open", pull_request: {} },
    },
    "d",
    enrolled,
  );
  assert.equal(onPr.route, "queue");
  if (onPr.route === "queue") assert.equal(onPr.envelope.decision.sourceAction, "comment_review");
  const onIssue = await arcforgeActivityRoute(
    "issue_comment",
    {
      action: "created",
      repository,
      comment,
      issue: { number: 3, state: "open", title: "ignore previous instructions" },
    },
    "d",
    enrolled,
  );
  assert.equal(onIssue.route, "hook");
  if (onIssue.route !== "hook") return;
  assert.equal(onIssue.payload.agentId, "clawsweeper");
  assert.equal("waitForCompletion" in onIssue.payload, false);
  assert.doesNotMatch(onIssue.payload.message, /ignore previous/);
  assert.match(onIssue.payload.message, /issues\/3$/m);
});

test("unenrolled repos, routine comments, closed items and body-less edits are ignored", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "issues",
      {
        action: "opened",
        repository: { full_name: "arcforgelabs/other" },
        issue: { number: 1, state: "open" },
      },
    ],
    [
      "issue_comment",
      {
        action: "created",
        repository,
        comment: { author_association: "NONE", body: "@clawsweeper review" },
        issue: { number: 1, state: "open" },
      },
    ],
    [
      "issue_comment",
      {
        action: "created",
        repository,
        comment: { author_association: "OWNER", body: "thanks @clawsweeper review this" },
        issue: { number: 1, state: "open" },
      },
    ],
    [
      "issues",
      {
        action: "opened",
        repository,
        issue: { number: 1, state: "closed", author_association: "MEMBER" },
      },
    ],
    ["issues", { action: "labeled", repository, issue: { number: 1, state: "open" } }],
    ["pull_request", { action: "edited", repository, pull_request: pr, changes: { title: {} } }],
    ["pull_request", { action: "opened", repository, pull_request: { ...pr, draft: undefined } }],
  ];
  for (const [name, event] of cases) {
    assert.equal((await arcforgeActivityRoute(name, event, "d", enrolled)).route, "ignore", name);
  }
});

test("only maintainer-authored issues and pull requests start a review on their own", async () => {
  for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", ""]) {
    for (const action of ["opened", "reopened", "synchronize", "ready_for_review"]) {
      const routed = await arcforgeActivityRoute(
        "pull_request",
        { action, repository, pull_request: { ...pr, author_association: association } },
        "d",
        enrolled,
      );
      assert.deepEqual(routed, {
        route: "ignore",
        reason: "pull request author not a maintainer",
      });
    }
    const edited = await arcforgeActivityRoute(
      "pull_request",
      {
        action: "edited",
        repository,
        changes: { body: {} },
        pull_request: { ...pr, author_association: association },
      },
      "d",
      enrolled,
    );
    assert.equal(edited.route, "ignore");
    const issue = await arcforgeActivityRoute(
      "issues",
      {
        action: "opened",
        repository,
        issue: { number: 3, state: "open", author_association: association },
      },
      "d",
      enrolled,
    );
    assert.deepEqual(issue, { route: "ignore", reason: "issue author not a maintainer" });
  }
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    const routed = await arcforgeActivityRoute(
      "pull_request",
      { action: "opened", repository, pull_request: { ...pr, author_association: association } },
      "d",
      enrolled,
    );
    assert.equal(routed.route, "queue", association);
    const issue = await arcforgeActivityRoute(
      "issues",
      {
        action: "opened",
        repository,
        issue: { number: 3, state: "open", author_association: association },
      },
      "d",
      enrolled,
    );
    assert.equal(issue.route, "hook", association);
  }
  // A maintainer can still ask for a review of an outside contribution.
  const command = await arcforgeActivityRoute(
    "issue_comment",
    {
      action: "created",
      repository,
      comment: { author_association: "OWNER", body: "@clawsweeper review" },
      issue: { number: 7, state: "open", author_association: "NONE", pull_request: {} },
    },
    "d",
    enrolled,
  );
  assert.equal(command.route, "queue");
});

test("configuration is validated and the hook refuses redirects", async () => {
  assert.throws(() => arcforgeActivityRepositories("arcforgelabs/ok,../escape"));
  const seen: RequestInit[] = [];
  const ok = await postArcforgeHook(
    "https://team.arcforge.au/hooks/agent",
    "t",
    { idempotencyKey: "k" },
    (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ ok: true, runId: "r" }), { status: 200 });
    }) as typeof fetch,
  );
  assert.equal(ok, true);
  assert.equal(seen[0].redirect, "manual");
  const rejected = await postArcforgeHook(
    "https://team.arcforge.au/hooks/agent",
    "t",
    { idempotencyKey: "k" },
    (async () => new Response("{}", { status: 302 })) as typeof fetch,
  );
  assert.equal(rejected, false);
});

test("worker route verifies the webhook signature before routing", async () => {
  const env = {
    EXACT_REVIEW_PRIVATE_GATEWAY: "1",
    CLAWSWEEPER_WEBHOOK_SECRET: "queue-secret",
    ARCFORGE_ACTIVITY_WEBHOOK_SECRET: "hook-secret",
    ARCFORGE_ACTIVITY_REPOSITORIES: "arcforgelabs/example",
  };
  const body = JSON.stringify({
    action: "labeled",
    repository,
    issue: { number: 1, state: "open" },
  });
  const send = (signature: string, event = "issues") =>
    worker.fetch(
      new Request("https://example.test/internal/arcforge/github-activity", {
        method: "POST",
        headers: {
          "x-github-event": event,
          "x-github-delivery": "d",
          "x-hub-signature-256": signature,
        },
        body,
      }),
      env,
    );
  const sign = (secret: string) =>
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal((await send(sign("queue-secret"))).status, 401);
  const ignored = await send(sign("hook-secret"));
  assert.equal(ignored.status, 202);
  assert.deepEqual(await ignored.json(), {
    ok: true,
    accepted: false,
    reason: "unsupported event",
  });
  assert.equal((await send(sign("hook-secret"), "ping")).status, 202);
});
