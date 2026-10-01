import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "gateway-path-test-"));
const cwd = join(root, "checkout");
mkdirSync(cwd);
const alias = join(root, "alias");
symlinkSync(cwd, alias, "dir");
after(() => rmSync(root, { recursive: true, force: true }));
import assert from "node:assert/strict";
import {
  executeGatewayReview,
  composeGatewayMessage,
  gatewayChildEnvironment,
} from "../dist/openclaw-gateway-review.js";
const capability = {
  protocol: "arcforge.clawsweeper-readonly.v1",
  agentId: "clawsweeper",
  sessionKeyPrefix: "agent:clawsweeper:dashboard:clawsweeper-review-",
  allowedTools: ["read"],
  permissionMode: "read-only",
};
const run = (rpc, requestedCwd = cwd) =>
  executeGatewayReview({
    callGatewayFromCli: rpc,
    agentId: "clawsweeper",
    message: "review this source",
    cwd: requestedCwd,
    timeoutMs: 30000,
    signal: new AbortController().signal,
  });
test("gateway review uses standard agent preferences and read-only owned session", async () => {
  const methods = [];
  let key;
  const result = await run(async (method, opts, params, extra) => {
    methods.push(method);
    assert.equal(extra.sharedStateMode, "read-only");
    assert.equal(params.model, undefined);
    assert.equal(params.authProfile, undefined);
    if (method === "clawsweeper.reviewCapabilities") return capability;
    if (method === "sessions.create") {
      key = params.key;
      assert.equal(params.permissionMode, "read-only");
      assert.equal(params.message, undefined);
      return {
        ok: true,
        key,
        sessionId: "id-123",
        entry: { sessionId: "id-123", spawnedCwd: cwd, permissionMode: "read-only" },
      };
    }
    assert.equal(params.sessionId, "id-123");
    assert.equal(params.expectedExistingSessionId, undefined);
    assert.equal(params.sessionKey, key);
    assert.equal(params.lane, "subagent");
    return { status: "ok", result: { payloads: [{ text: "review result" }] } };
  });
  assert.equal(result.ok, true);
  assert.equal(result.finalText, "review result");
  assert.deepEqual(methods, ["clawsweeper.reviewCapabilities", "sessions.create", "agent"]);
});
test("missing or permissive guard cannot start inference", async () => {
  for (const cap of [
    null,
    { ...capability, allowedTools: ["read", "exec"] },
    { ...capability, agentId: "arc" },
  ]) {
    let calls = 0;
    const result = await run(async () => {
      calls++;
      return cap;
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
});
test("session mismatch and missing read-only policy fail before inference", async () => {
  for (const changed of [
    { spawnedCwd: "/elsewhere" },
    { permissionMode: "full" },
    { sessionId: "other" },
  ]) {
    let calls = 0;
    const result = await run(async (method, _opts, params) => {
      calls++;
      return method === "clawsweeper.reviewCapabilities"
        ? capability
        : {
            ok: true,
            key: params.key,
            sessionId: "id-123",
            entry: {
              sessionId: "id-123",
              spawnedCwd: cwd,
              permissionMode: "read-only",
              ...changed,
            },
          };
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 2);
  }
});
test("uncertain agent transport is not retried", async () => {
  let inference = 0;
  const result = await run(async (method, _opts, params) => {
    if (method === "clawsweeper.reviewCapabilities") return capability;
    if (method === "sessions.create")
      return {
        ok: true,
        key: params.key,
        sessionId: "id-123",
        entry: { sessionId: "id-123", spawnedCwd: cwd, permissionMode: "read-only" },
      };
    inference++;
    throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  });
  assert.equal(result.ok, false);
  assert.equal(inference, 1);
});
test("large prompts remain file payloads and write credentials are excluded", () => {
  assert.ok(composeGatewayMessage("x".repeat(200000), undefined, false).length > 200000);
  const env = gatewayChildEnvironment({
    HOME: "/home/test",
    GH_TOKEN: "secret",
    XAI_API_KEY: "secret",
    PATH: "/bin",
  });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.HOME, "/home/test");
});

test("symlink and trailing-slash checkouts bind to the actual gateway workspace", async () => {
  const result = await run(async (method, _opts, params) => {
    if (method === "clawsweeper.reviewCapabilities") return capability;
    if (method === "sessions.create") {
      assert.equal(params.cwd, cwd);
      return {
        ok: true,
        key: params.key,
        sessionId: "id-123",
        entry: { sessionId: "id-123", spawnedCwd: cwd, permissionMode: "read-only" },
      };
    }
    return { status: "ok", result: { payloads: [{ text: "review result" }] } };
  }, alias + "/");
  assert.equal(result.ok, true);
  assert.equal(result.meta.cwd, cwd);
});
