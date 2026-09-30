// Controlled process/SQLite/HTTP proof. Synthetic upstream claims, no GitHub or model calls.
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { gatewayExecution, GATEWAY_EXECUTION_TTL_MS } from "../../dashboard/gateway-execution.ts";
if (process.argv[2] === "server") {
  const root = process.argv[3],
    db = new DatabaseSync(join(root, "execution.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const store = {
    get: (k) => {
      const r = db.prepare("SELECT value FROM kv WHERE key=?").get(k);
      return r ? JSON.parse(r.value) : undefined;
    },
    put: (k, v) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?,?)").run(k, JSON.stringify(v)),
  };
  const items = Array.from({ length: 5 }, (_, n) => ({
    key: `synthetic/repo:pull_request:${n + 1}`,
    state: "leased",
    revision: 1,
    leaseRevision: 1,
    leaseId: `lease-${n}`,
    claimGeneration: 1,
    claimProtocolVersion: 2,
    claimedRunId: String(n + 1),
    claimedRunAttempt: 1,
    createdAt: n,
    leaseExpiresAt: Date.now() + 600000,
    leaseDecision: { targetRepo: "synthetic/repo", itemNumber: n + 1, itemKind: "pull_request" },
  }));
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const r = gatewayExecution(store, items, req.url.slice(1), JSON.parse(raw), Date.now());
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  process.on("SIGTERM", () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
} else {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-execution-proof-"));
  let server, port;
  const start = () =>
    new Promise((resolve) => {
      server = spawn(process.execPath, [process.argv[1], "server", root], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      server.stdout.once("data", (d) => {
        port = Number(String(d).trim());
        resolve();
      });
    });
  const stop = () =>
    new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill("SIGTERM");
    });
  const call = async (action, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  await start();
  try {
    const jobs = [];
    for (let n = 0; n < 5; n++) jobs.push((await call("take", { owner: randomUUID() })).body.job);
    assert.ok(jobs.every(Boolean));
    assert.equal((await call("take", { owner: randomUUID() })).body.job, null);
    await stop();
    await start();
    assert.equal((await call("take", { owner: randomUUID() })).body.job, null);
    console.log(
      "Five claims persisted across process restart; waiting for the real 120-second expiry.",
    );
    await sleep(GATEWAY_EXECUTION_TTL_MS + 1000);
    const replacement = (await call("take", { owner: randomUUID() })).body.job;
    assert.ok(replacement);
    assert.equal((await call("finish", { ...jobs[0], outcome: "success" })).status, 409);
    assert.equal((await call("finish", { ...replacement, outcome: "success" })).status, 200);
    await stop();
    await start();
    assert.equal((await call("status", replacement)).body.outcome, "success");
    const evidence = {
      passed: true,
      provider: "local-node-sqlite-http",
      workers: 5,
      expiry_ms: GATEWAY_EXECUTION_TTL_MS,
      old_owner_status: 409,
      publication_receipt_survives_restart: true,
      limits: "Synthetic upstream claims; GitHub dispatch and xAI inference require live canary.",
    };
    writeFileSync(join(root, "proof.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, artifact: join(root, "proof.json") }));
  } finally {
    await stop();
  }
}
