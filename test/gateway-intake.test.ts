import test from "node:test";
import assert from "node:assert/strict";
import { gatewaySourceDecision } from "../dashboard/gateway-intake.ts";
import { exactReviewDecisionCanSupersedeReview } from "../dashboard/exact-review-decision.ts";

const input = {
  targetRepo: "arcforgelabs/example",
  itemNumber: 6,
  sourceAction: "edited",
  additionalPrompt: "untrusted instruction",
};
const live = {
  number: 6,
  state: "open",
  title: "Title",
  body: "Proof",
  locked: false,
  labels: [],
  head: { sha: "a".repeat(40) },
  base: { sha: "b".repeat(40), ref: "main" },
  draft: false,
  updated_at: "2026-10-01T00:00:00Z",
};

test("live source identity supports body edits and newer heads through upstream authority", async () => {
  const first = await gatewaySourceDecision(input, live);
  assert.ok(first);
  assert.equal("additionalPrompt" in first, false);
  const edited = await gatewaySourceDecision(input, {
    ...live,
    body: "New proof",
    updated_at: "2026-10-01T00:01:00Z",
  });
  assert.ok(edited);
  assert.notEqual(first.sourceContentRevision, edited.sourceContentRevision);
  const current = { decision: { ...first, sourceAuthoritySeq: 1 } } as any;
  assert.equal(
    exactReviewDecisionCanSupersedeReview(current, {
      ...edited,
      sourceAuthoritySeq: 2,
      sourceHeadVerified: true,
    } as any),
    true,
  );
  const next = await gatewaySourceDecision(input, {
    ...live,
    head: { sha: "c".repeat(40) },
  });
  assert.equal(
    exactReviewDecisionCanSupersedeReview(current, {
      ...next,
      sourceAuthoritySeq: 2,
      sourceHeadVerified: true,
    } as any),
    true,
  );
  assert.equal(
    exactReviewDecisionCanSupersedeReview(current, { ...edited } as any),
    false,
  );
});

test("stale heads and closed PRs cannot replace current review source", async () => {
  assert.equal(
    await gatewaySourceDecision(
      { ...input, sourceHeadSha: "c".repeat(40) },
      live,
    ),
    null,
  );
  assert.equal(
    await gatewaySourceDecision(input, { ...live, state: "closed" }),
    null,
  );
  await assert.rejects(
    gatewaySourceDecision(input, { ...live, number: 7 }),
    /incomplete/,
  );
});

test("authorized comment requests bind the live head and use upstream re-review semantics", async () => {
  const decision = await gatewaySourceDecision(
    { ...input, sourceAction: "comment_review" },
    live,
  );
  assert.equal(decision?.sourceAction, "re_review");
  assert.equal(decision?.sourceHeadSha, live.head.sha);
  assert.equal(decision?.sourceBaseSha, live.base.sha);
});

test("signed Worker intake binds live HTTP source and forwards upstream source authority", async (t) => {
  const { createServer } = await import("node:http");
  const { createHmac, generateKeyPairSync } = await import("node:crypto");
  const { default: worker } = await import("../dashboard/worker.ts");
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    calls.push(request.url!);
    let body = "";
    for await (const chunk of request) body += chunk;
    let result;
    if (request.url === "/repos/arcforgelabs/example/installation") result = { id: 123 };
    else if (request.url === "/app/installations/123/access_tokens") {
      assert.deepEqual(JSON.parse(body), { repositories: ["example"], permissions: { pull_requests: "read" } });
      result = { token: "fixture-token" };
    } else if (request.url === "/repos/arcforgelabs/example/pulls/6") result = live;
    else { response.writeHead(404).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const forwarded: {path: string; body: any}[] = [];
  const secret = "fixture-secret";
  const env = {
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    EXACT_REVIEW_PRIVATE_GATEWAY: "1",
    EXACT_REVIEW_ALLOWED_REPOSITORIES: "arcforgelabs/example",
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    CLAWSWEEPER_APP_ID: "123",
    CLAWSWEEPER_APP_PRIVATE_KEY: generateKeyPairSync("rsa", {modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}),
    EXACT_REVIEW_QUEUE: { idFromName: (x: string) => x, get: () => ({fetch: async (request: Request) => {
      forwarded.push({path: new URL(request.url).pathname, body: await request.json()});
      return Response.json({ok: true, source_authority_seq: 1});
    }}) },
  };
  const send = async (head = live.head.sha, signed = true) => {
    const body = JSON.stringify({delivery_id:"fixture-delivery", decision:{...input,itemKind:"pull_request",sourceHeadSha:head}});
    return worker.fetch(new Request("https://fixture.test/internal/exact-review/enqueue", {method:"POST",body,headers:{"x-clawsweeper-exact-review-signature":signed ? "sha256="+createHmac("sha256",secret).update(body).digest("hex") : "invalid"}}), env);
  };
  assert.equal((await send(live.head.sha, false)).status, 401);
  assert.equal(calls.length, 0);
  const response = await send();
  assert.equal(response.status, 200, await response.text());
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].path, "/source-authority");
  assert.equal(forwarded[0].body.installation_id, 123);
  assert.equal(forwarded[0].body.decision.sourceHeadSha, live.head.sha);
  assert.equal(forwarded[0].body.decision.additionalPrompt, undefined);
  const stale = await send("c".repeat(40));
  assert.equal(stale.status, 202);
  assert.equal((await stale.json() as any).accepted, false);
  assert.equal(forwarded.length, 1);
});
