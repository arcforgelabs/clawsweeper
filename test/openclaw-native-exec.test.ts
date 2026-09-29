import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  assertExclusiveNativeXaiProfile,
  readNativeOpenclawTranscript,
} from "../dist/openclaw-native-transcript.js";
import { runOpenclawProcess } from "../dist/openclaw-process.js";

const profile = "xai:review@example.test";
function authStore(root: string): string {
  const path = join(root, "auth.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE auth_profile_store (store_json TEXT); CREATE TABLE auth_profile_state (state_json TEXT)",
  );
  db.prepare("INSERT INTO auth_profile_store VALUES (?)").run(
    JSON.stringify({ profiles: { [profile]: { provider: "xai", type: "oauth" } } }),
  );
  db.prepare("INSERT INTO auth_profile_state VALUES (?)").run(
    JSON.stringify({ order: { xai: [profile] } }),
  );
  db.close();
  return path;
}
function transcriptStore(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, "transcript.sqlite"));
  db.exec(
    "CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER)",
  );
  return db;
}

test("native transcript decodes real SQLite/zstd rows for only the requested session", () => {
  const root = mkdtempSync(join(tmpdir(), "native-transcript-"));
  try {
    const db = transcriptStore(root);
    const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)");
    const entry = JSON.stringify({
      type: "message",
      message: { role: "toolResult", isError: true, content: "x".repeat(2048) },
    });
    insert.run("selected", 1, '{"type":"session_info"}', null, null);
    insert.run("selected", 2, null, zstdCompressSync(Buffer.from(entry)), Buffer.byteLength(entry));
    insert.run("unrelated", 1, "invalid JSON", null, null);
    db.close();
    assert.equal(
      readNativeOpenclawTranscript(join(root, "transcript.sqlite"), "selected"),
      `{"type":"session_info"}\n${entry}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native transcript rejects malformed, missing, oversized and incomplete receipts", () => {
  for (const variant of [
    "missing",
    "bad-json",
    "bad-zstd",
    "wrong-size",
    "gap",
    "oversized",
    "unsupported",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "native-transcript-invalid-"));
    try {
      const db = transcriptStore(root);
      const insert = db.prepare("INSERT INTO transcript_events VALUES ('selected', ?, ?, ?, ?)");
      if (variant === "bad-json") insert.run(1, "bad JSON", null, null);
      if (variant === "bad-zstd") insert.run(1, null, Buffer.from("bad zstd"), 10);
      if (variant === "wrong-size") insert.run(1, null, zstdCompressSync(Buffer.from("{}")), 3);
      if (variant === "gap") {
        insert.run(1, "{}", null, null);
        insert.run(3, "{}", null, null);
      }
      if (variant === "oversized") insert.run(1, " ".repeat(4 * 1024 * 1024 + 1), null, null);
      if (variant === "unsupported") insert.run(1, "{}", Buffer.from("{}"), 2);
      db.close();
      assert.throws(
        () => readNativeOpenclawTranscript(join(root, "transcript.sqlite"), "selected"),
        variant,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("native OAuth account guard refuses other accounts, API keys, and fallback orders", () => {
  const root = mkdtempSync(join(tmpdir(), "native-auth-"));
  try {
    const path = authStore(root);
    assert.doesNotThrow(() => assertExclusiveNativeXaiProfile(path, profile));
    assert.throws(() => assertExclusiveNativeXaiProfile(path, "xai:other@example.test"));
    const db = new DatabaseSync(path);
    db.prepare("UPDATE auth_profile_state SET state_json=?").run(
      JSON.stringify({ order: { xai: [profile, "xai:other@example.test"] } }),
    );
    assert.throws(() => assertExclusiveNativeXaiProfile(path, profile));
    db.prepare("UPDATE auth_profile_state SET state_json=?").run(
      JSON.stringify({ order: { xai: [profile] } }),
    );
    db.prepare("UPDATE auth_profile_store SET store_json=?").run(
      JSON.stringify({ profiles: { [profile]: { provider: "xai", type: "api_key" } } }),
    );
    assert.throws(() => assertExclusiveNativeXaiProfile(path, profile));
    db.prepare("UPDATE auth_profile_store SET store_json=?").run(
      JSON.stringify({
        profiles: {
          [profile]: { provider: "xai", type: "oauth" },
          "xai:other@example.test": { provider: "xai", type: "oauth" },
        },
      }),
    );
    assert.throws(() => assertExclusiveNativeXaiProfile(path, profile));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native exec uses isolated state and saved OAuth, and preserves exact-path compressed read validation", () => {
  for (const variant of [
    "success",
    "commentary",
    "final-only",
    "missing-final",
    "error-payload",
    "timeout",
    "wrong-path",
    "failed-read",
    "extra-failed-read",
    "wrong-model",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "native-exec-"));
    try {
      const authDir = join(root, "auth");
      mkdirSync(authDir);
      const authPath = authStore(authDir);
      // Match the native agent store name without creating a second credential copy.
      renameSync(authPath, join(authDir, "openclaw-agent.sqlite"));
      const recordPath = join(root, "record.json");
      const binary = join(root, "fake-openclaw");
      writeFileSync(
        binary,
        `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'), {DatabaseSync}=require('node:sqlite'), {zstdCompressSync}=require('node:zlib');
const args=process.argv.slice(2), arg=n=>args[args.indexOf(n)+1], state=arg('--state-dir');
const config=JSON.parse(fs.readFileSync(arg('--config'),'utf8'));
fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify({args,config,state,ambient:process.env.OPENCLAW_STATE_DIR,key:process.env.XAI_API_KEY??null,github:process.env.GITHUB_TOKEN??null,inheritedToken:process.env.OPENCLAW_GATEWAY_TOKEN??null}));
const dbPath=path.join(state,'agents','reviewer','agent','openclaw-agent.sqlite');fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB,event_utf8_bytes INTEGER)');
const call=(id,p)=>({type:'message',message:{role:'assistant',content:[{type:'toolCall',id,name:'read',arguments:{path:p}}]}});
const result=(id,error)=>({type:'message',message:{role:'toolResult',toolName:'read',toolCallId:id,isError:error,content:[{type:'text',text:'x'.repeat(2048)}]}});
const entries=[call('one',${JSON.stringify(variant === "wrong-path" ? "wrong.txt" : "proof.txt")}),result('one',${variant === "failed-read"})];
if(${variant === "extra-failed-read"})entries.push(call('two','other.txt'),result('two',true));
entries.forEach((e,i)=>{const b=Buffer.from(JSON.stringify(e));db.prepare('INSERT INTO transcript_events VALUES (?,?,?,?,?)').run('native-session',i+1,null,zstdCompressSync(b),b.length)});db.close();
const payloads=${variant === "final-only"} ? [] : [{text:'expected-line'}];
if(${variant === "commentary"})payloads.unshift({text:'progress',isCommentary:true},{text:'private reasoning',isReasoning:true});
if(${variant === "error-payload"})payloads.push({text:'failed',isError:true});
process.stdout.write(JSON.stringify({ok:true,status:'ok',provider:'xai',model:${JSON.stringify(variant === "wrong-model" ? "other" : "grok-4.7")},sessionId:'native-session',meta:${variant === "timeout" ? "{stopReason:'timeout'}" : "{}"},final:${variant === "missing-final" ? "undefined" : "'expected-line'"},payloads}));
process.exitCode=${variant === "timeout" ? 2 : variant === "error-payload" ? 1 : 0};
`,
      );
      chmodSync(binary, 0o755);
      const output = runOpenclawProcess({
        label: "native-test",
        prompt: "Read proof.txt",
        model: "xai/grok-4.7",
        cwd: root,
        timeoutMs: 10_000,
        env: {
          ...process.env,
          CLAWSWEEPER_OPENCLAW_NATIVE_EXEC: "1",
          CLAWSWEEPER_OPENCLAW_AUTH_AGENT_ID: "Reviewer",
          CLAWSWEEPER_OPENCLAW_AUTH_AGENT_DIR: authDir,
          CLAWSWEEPER_OPENCLAW_AUTH_PROFILE_ID: profile,
          CLAWSWEEPER_OPENCLAW_BIN: binary,
          XAI_API_KEY: "must-not-pass",
          GITHUB_TOKEN: "must-not-pass",
          OPENCLAW_GATEWAY_TOKEN: "must-not-pass",
        },
        checkoutInspection: { expectedText: "expected-line", expectedPath: "proof.txt" },
      });
      if (!["success", "commentary", "final-only"].includes(variant))
        assert.ok(output.error || output.status !== 0, variant);
      else {
        assert.equal(output.status, 0);
        assert.equal(output.stdout, "");
      }
      if (variant === "timeout")
        assert.equal((output.error as NodeJS.ErrnoException)?.code, "ETIMEDOUT");
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      assert.deepEqual(record.args.slice(0, 2), ["agent", "exec"]);
      assert.equal(record.key, null);
      assert.equal(record.github, null);
      assert.equal(record.inheritedToken, null);
      assert.notEqual(record.state, record.ambient);
      assert.equal(record.config.agents.entries.reviewer.agentDir, authDir);
      assert.deepEqual(record.config.auth.order.xai, [profile]);
      assert.deepEqual(record.config.plugins.allow, ["xai"]);
      assert.deepEqual(record.config.tools.allow, ["read"]);
      assert.equal(existsSync(record.state), false);
      assert.equal(existsSync(authDir), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
