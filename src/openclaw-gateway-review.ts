import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { isRecord, rejectUnexpectedKeys } from "./value-coerce.js";

const require = createRequire(import.meta.url);
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const CONFIG_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 60_000;
const MIN_AGENT_MS = 1_000;
const SESSION_ID = /^[a-zA-Z0-9-]{1,128}$/;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+/-]{0,127}$/;
const CAPABILITY_PROTOCOL = "arcforge.clawsweeper-readonly.v1";
const WORKER_OPTION_KEYS = new Set([
  "packageRoot",
  "agentId",
  "message",
  "cwd",
  "timeoutMs",
  "resultPath",
  "metaPath",
]);

export interface GatewayProvenance {
  provider: string | null;
  model: string | null;
  profileId: string | null;
  selection: "runtime" | "unavailable";
}

export interface GatewayRunMeta {
  sessionId: string | null;
  sessionKey: string | null;
  reportedSessionId: string | null;
  reportedSessionKey: string | null;
  permissionMode: string | null;
  cwd: string | null;
  mismatch: boolean;
  terminalStatus: string | null;
}

export interface GatewayExecution {
  ok: boolean;
  finalText: string;
  error?: { message: string; code?: string };
  meta: GatewayRunMeta;
}

export interface GatewayWorkerOptions {
  packageRoot: string;
  agentId: string;
  message: string;
  cwd: string;
  timeoutMs: number;
  resultPath: string;
  metaPath: string;
}

interface GatewayCaller {
  (
    method: string,
    opts: { json: true; timeout: string },
    params: Record<string, unknown>,
    extra: {
      expectFinal: boolean;
      timeoutMs: number;
      progress: false;
      sharedStateMode: "read-only";
      signal: AbortSignal;
    },
  ): Promise<unknown>;
}

export function unavailableGatewayProvenance(): GatewayProvenance {
  return { provider: null, model: null, profileId: null, selection: "unavailable" };
}

export function gatewayReviewEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.CLAWSWEEPER_OPENCLAW_GATEWAY_REVIEW?.trim();
  if (!flag || flag === "0") return false;
  if (flag !== "1") throw new Error("CLAWSWEEPER_OPENCLAW_GATEWAY_REVIEW must be 0 or 1.");
  const native = env.CLAWSWEEPER_OPENCLAW_NATIVE_EXEC?.trim();
  if (native && native !== "0") {
    throw new Error(
      "CLAWSWEEPER_OPENCLAW_GATEWAY_REVIEW cannot be combined with CLAWSWEEPER_OPENCLAW_NATIVE_EXEC.",
    );
  }
  return true;
}

export function requireGatewayReviewSettings(env: NodeJS.ProcessEnv): {
  packageRoot: string;
  agentId: string;
} {
  if (!gatewayReviewEnabled(env)) throw new Error("Gateway review is not enabled.");
  const agentId = env.CLAWSWEEPER_OPENCLAW_GATEWAY_AGENT_ID?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) {
    throw new Error("CLAWSWEEPER_OPENCLAW_GATEWAY_AGENT_ID must identify the gateway agent.");
  }
  const packageRoot = env.CLAWSWEEPER_OPENCLAW_PACKAGE_ROOT?.trim() ?? "";
  if (!packageRoot || !isAbsolute(packageRoot) || packageRoot.includes("\0")) {
    throw new Error("CLAWSWEEPER_OPENCLAW_PACKAGE_ROOT must be an absolute OpenClaw package root.");
  }
  return { agentId, packageRoot };
}

export function gatewaySessionKeyPrefix(agentId: string): string {
  return `agent:${agentId}:dashboard:clawsweeper-review-`;
}

export function gatewayChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TERM",
    "NO_COLOR",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
  ]) {
    if (env[name] !== undefined) child[name] = env[name];
  }
  return child;
}

export function gatewayAgentDatabasePath(agentId: string, env: NodeJS.ProcessEnv): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) {
    throw new Error("Gateway review agent id is invalid.");
  }
  const configured = env.OPENCLAW_STATE_DIR?.trim();
  const root = configured ? configured : join(homedir(), ".openclaw");
  if (!isAbsolute(root) || root.includes("\0")) {
    throw new Error("OPENCLAW_STATE_DIR must be an absolute path for gateway review.");
  }
  return join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

export function canonicalGatewayCwd(cwd: string): string {
  if (!isAbsolute(cwd) || cwd.includes("\0"))
    throw new Error("Gateway review cwd must be absolute.");
  return realpathSync(cwd);
}

export function composeGatewayMessage(
  prompt: string,
  outputSchema: Record<string, unknown> | undefined,
  checkoutInspection: boolean,
): string {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("Gateway review prompt is empty.");
  }
  let message = prompt;
  if (!checkoutInspection) {
    const lines = [
      "Runtime constraints: This is a read-only review. Your only tool is read, rooted in the target checkout. Shell, git commands, tests, writes, and tool discovery are unavailable.",
    ];
    if (outputSchema) {
      const schemaJson = JSON.stringify(outputSchema);
      if (Buffer.byteLength(schemaJson) > MAX_SCHEMA_BYTES) {
        throw new Error("Gateway review output schema exceeds 1 MiB.");
      }
      lines.push("Return only JSON validating against this schema:", schemaJson);
    }
    message = `${lines.join("\n")}\n\n${prompt}`;
  }
  if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
    throw new Error("Gateway review prompt exceeds 8 MiB.");
  }
  return message;
}

export function resolveGatewayRuntimeEntry(packageRoot: string): string {
  const root = realpathSync(packageRoot);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as unknown;
  const exports = isRecord(manifest) ? manifest.exports : undefined;
  const exp = isRecord(exports) ? exports["./plugin-sdk/gateway-runtime"] : undefined;
  const rel =
    typeof exp === "string"
      ? exp
      : isRecord(exp) && typeof exp.default === "string"
        ? exp.default
        : "";
  if (!rel.startsWith("./") || rel.includes("\0") || rel.split("/").includes("..")) {
    throw new Error("OpenClaw gateway runtime export is not a package-local path.");
  }
  const entry = realpathSync(join(root, rel));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (entry !== root && !entry.startsWith(rootPrefix)) {
    throw new Error("OpenClaw gateway runtime export escapes the package root.");
  }
  return entry;
}

export function parseGatewayWorkerOptions(value: unknown): GatewayWorkerOptions {
  const record = requireRecord(value, "Gateway review worker options");
  rejectUnexpectedKeys(record, WORKER_OPTION_KEYS, "Gateway review worker options");
  const packageRoot = requireText(record.packageRoot, "packageRoot");
  const agentId = requireText(record.agentId, "agentId");
  const message = requireText(record.message, "message");
  const cwd = requireText(record.cwd, "cwd");
  const resultPath = requireText(record.resultPath, "resultPath");
  const metaPath = requireText(record.metaPath, "metaPath");
  const timeoutMs = record.timeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    typeof timeoutMs !== "number" ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error("Gateway review timeout is invalid.");
  }
  if (
    !isAbsolute(cwd) ||
    cwd.includes("\0") ||
    !isAbsolute(packageRoot) ||
    packageRoot.includes("\0")
  ) {
    throw new Error("Gateway review worker options are invalid.");
  }
  if (
    !isAbsolute(resultPath) ||
    !isAbsolute(metaPath) ||
    resultPath.includes("\0") ||
    metaPath.includes("\0")
  ) {
    throw new Error("Gateway review worker options are invalid.");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) {
    throw new Error("Gateway review agent id is invalid.");
  }
  if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
    throw new Error("Gateway review prompt exceeds 8 MiB.");
  }
  return { packageRoot, agentId, message, cwd, timeoutMs, resultPath, metaPath };
}

export function publicGatewayError(
  error: unknown,
  secrets: readonly string[],
): { message: string; code?: string } {
  const named = error instanceof Error ? error : new Error("Gateway review failed.");
  let message = named.message || "Gateway review failed.";
  for (const secret of secrets) {
    if (secret.length >= 8) message = message.replaceAll(secret, "[redacted]");
  }
  message = message
    .split("\0")
    .join(" ")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
  if (!message) message = "Gateway review failed.";
  const explicit =
    "code" in named && typeof named.code === "string" && /^[A-Z0-9_]{1,32}$/.test(named.code)
      ? named.code
      : undefined;
  const code =
    named.name === "AbortError" || explicit === "ETIMEDOUT" || /timeout|aborted/i.test(message)
      ? "ETIMEDOUT"
      : explicit;
  return code ? { message, code } : { message };
}

export async function executeGatewayReview(input: {
  callGatewayFromCli: GatewayCaller;
  agentId: string;
  message: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<GatewayExecution> {
  const meta = emptyMeta();
  const secrets = input.message.length >= 8 ? [input.message] : [];
  try {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new Error("Gateway review timeout is invalid.");
    }
    if (!isAbsolute(input.cwd) || input.cwd.includes("\0")) {
      throw new Error("Gateway review cwd must be absolute.");
    }
    input = { ...input, cwd: canonicalGatewayCwd(input.cwd) };
    const deadline = Date.now() + input.timeoutMs;
    const remaining = () => deadline - Date.now();
    const rpc = async (
      method: string,
      params: Record<string, unknown>,
      cap: number,
      expectFinal: boolean,
    ) => {
      if (input.signal.aborted || remaining() < 1)
        throw coded("Gateway review timeout.", "ETIMEDOUT");
      const timeoutMs = Math.min(cap, remaining());
      return input.callGatewayFromCli(method, { json: true, timeout: String(timeoutMs) }, params, {
        expectFinal,
        timeoutMs,
        progress: false,
        sharedStateMode: "read-only",
        signal: input.signal,
      });
    };

    let capability: unknown;
    try {
      capability = await rpc(
        "clawsweeper.reviewCapabilities",
        { agentId: input.agentId },
        CONFIG_TIMEOUT_MS,
        false,
      );
    } catch (error) {
      if (isTimeout(error)) throw error;
      throw new Error("Gateway review capability is unavailable.", { cause: error });
    }
    const prefix = assertCapability(capability, input.agentId);
    if (input.signal.aborted || remaining() < MIN_AGENT_MS) {
      throw coded("Gateway review timeout.", "ETIMEDOUT");
    }

    const sessionKey = `${prefix}${randomUUID()}`;
    const createKey = `cs-${randomUUID()}`;
    let created: unknown;
    try {
      created = await rpc(
        "sessions.create",
        {
          key: sessionKey,
          idempotencyKey: createKey,
          agentId: input.agentId,
          cwd: input.cwd,
          permissionMode: "read-only",
        },
        CREATE_TIMEOUT_MS,
        false,
      );
    } catch (error) {
      if (isTimeout(error)) throw error;
      throw new Error("Gateway sessions.create failed.", { cause: error });
    }
    const session = assertCreatedSession(created, {
      agentId: input.agentId,
      cwd: input.cwd,
      sessionKey,
    });
    meta.sessionId = session.sessionId;
    meta.sessionKey = session.sessionKey;
    meta.permissionMode = "read-only";
    meta.cwd = input.cwd;
    if (remaining() < MIN_AGENT_MS || input.signal.aborted) {
      throw coded("Gateway review timeout.", "ETIMEDOUT");
    }

    const runKey = `cs-${randomUUID()}`;
    const timeoutSeconds = Math.max(1, Math.ceil(remaining() / 1000));
    let agent: unknown;
    try {
      agent = await rpc(
        "agent",
        {
          message: input.message,
          agentId: input.agentId,
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          timeout: timeoutSeconds,
          idempotencyKey: runKey,
          deliver: false,
        },
        remaining(),
        true,
      );
    } catch (error) {
      if (isTimeout(error)) throw error;
      throw new Error("Gateway review failed.", { cause: error });
    }
    let terminal = await terminalPayload(agent, rpc, runKey, remaining, input.signal);
    noteReported(meta, terminal);
    meta.terminalStatus = typeof terminal.status === "string" ? terminal.status : null;
    if (meta.mismatch) throw new Error("Gateway review session did not match the created session.");
    const status = meta.terminalStatus;
    if (status === "timeout" || status === "aborted")
      throw coded("Gateway review timeout.", "ETIMEDOUT");
    if (status === "error") throw new Error("Gateway review failed.");
    if (status !== "ok" && status !== "completed") {
      throw new Error("Gateway review returned an unexpected status.");
    }
    const finalText = payloadText(terminal);
    if (!finalText) throw new Error("Gateway review returned no final output.");
    return { ok: true, finalText, meta };
  } catch (error) {
    return { ok: false, finalText: "", error: publicGatewayError(error, secrets), meta };
  }
}

export function readGatewaySessionProof(
  databasePath: string,
  sessionId: string,
  sessionKey: string | null,
): { mismatch: boolean; provenance: GatewayProvenance } {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid gateway session id.");
  if (!sessionKey || sessionKey.length > 256 || sessionKey.includes("\0")) {
    return { mismatch: false, provenance: unavailableGatewayProvenance() };
  }
  assertDatabasePath(databasePath);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(databasePath);
  } catch (error) {
    if (isEnoent(error)) return { mismatch: false, provenance: unavailableGatewayProvenance() };
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Gateway review database path is invalid.");
  }
  const db = openDatabase(databasePath);
  try {
    db.exec("BEGIN");
    const sessions = selectRows(
      db,
      `SELECT session_id, model_provider, model FROM sessions WHERE session_key = ? LIMIT 2`,
      sessionKey,
    );
    const nodes = selectRows(
      db,
      `SELECT current_session_id,
        json_extract(entry_json, '$.model') AS model,
        json_extract(entry_json, '$.modelProvider') AS modelProvider,
        json_extract(entry_json, '$.activeModel') AS activeModel,
        json_extract(entry_json, '$.activeModelProvider') AS activeModelProvider,
        json_extract(entry_json, '$.providerOverride') AS providerOverride,
        json_extract(entry_json, '$.modelOverride') AS modelOverride,
        json_extract(entry_json, '$.authProfileOverride') AS authProfileOverride
      FROM session_nodes WHERE session_key = ? LIMIT 2`,
      sessionKey,
    );
    const others = selectRows(
      db,
      `SELECT COUNT(*) AS count FROM session_nodes
       WHERE session_key = ? AND current_session_id IS NOT NULL AND current_session_id != ?`,
      sessionKey,
      sessionId,
    );
    if (sessions === "missing" && nodes === "missing") {
      return { mismatch: false, provenance: unavailableGatewayProvenance() };
    }
    if (sessions !== "missing" && sessions.length > 1) return mismatchedProof();
    if (nodes !== "missing" && nodes.length > 1) return mismatchedProof();
    const otherCount = others === "missing" ? 0 : numeric(others[0]?.count);
    if (otherCount > 0) return mismatchedProof();
    const sessionRow = sessions === "missing" ? undefined : sessions[0];
    const nodeRow = nodes === "missing" ? undefined : nodes[0];
    if (
      sessionRow &&
      typeof sessionRow.session_id === "string" &&
      sessionRow.session_id !== sessionId
    ) {
      return mismatchedProof();
    }
    if (
      nodeRow &&
      typeof nodeRow.current_session_id === "string" &&
      nodeRow.current_session_id !== sessionId
    ) {
      return mismatchedProof();
    }
    const nodeMatches = nodeRow && nodeRow.current_session_id === sessionId ? nodeRow : undefined;
    const sessionMatches =
      sessionRow && sessionRow.session_id === sessionId ? sessionRow : undefined;
    const picked =
      (nodeMatches
        ? (tier(nodeMatches.activeModelProvider, nodeMatches.activeModel) ??
          tier(nodeMatches.modelProvider, nodeMatches.model))
        : undefined) ??
      (sessionMatches ? tier(sessionMatches.model_provider, sessionMatches.model) : undefined);
    // A configured auth override is not evidence of the account actually billed.
    const profileId = null;
    if (!picked && !profileId)
      return { mismatch: false, provenance: unavailableGatewayProvenance() };
    return {
      mismatch: false,
      provenance: {
        provider: picked?.provider ?? null,
        model: picked?.model ?? null,
        profileId,
        selection: "runtime",
      },
    };
  } finally {
    db.close();
  }
}

function assertCapability(value: unknown, agentId: string): string {
  const record = isRecord(value) ? value : undefined;
  const allowed = new Set([
    "protocol",
    "agentId",
    "sessionKeyPrefix",
    "allowedTools",
    "permissionMode",
  ]);
  if (!record || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Gateway review capability did not match the read-only contract.");
  }
  const prefix = gatewaySessionKeyPrefix(agentId);
  const tools = Array.isArray(record.allowedTools) ? record.allowedTools : [];
  if (
    record.protocol !== CAPABILITY_PROTOCOL ||
    record.agentId !== agentId ||
    record.sessionKeyPrefix !== prefix ||
    record.permissionMode !== "read-only" ||
    tools.length !== 1 ||
    tools[0] !== "read"
  ) {
    throw new Error("Gateway review capability did not match the read-only contract.");
  }
  return prefix;
}

function assertCreatedSession(
  value: unknown,
  expected: { agentId: string; cwd: string; sessionKey: string },
): { sessionId: string; sessionKey: string } {
  if (!isRecord(value) || value.ok !== true || value.runStarted === true) {
    throw new Error(
      value && isRecord(value) && value.runStarted === true
        ? "Gateway review session create started a run."
        : "Gateway sessions.create failed.",
    );
  }
  if (value.key !== expected.sessionKey) {
    throw new Error("Gateway review session did not match the created session.");
  }
  if (typeof value.sessionId !== "string" || !SESSION_ID.test(value.sessionId)) {
    throw new Error("Gateway review session did not match the created session.");
  }
  if (!isRecord(value.entry)) throw new Error("Gateway sessions.create failed.");
  const entry = value.entry;
  if (entry.permissionMode !== "read-only") {
    throw new Error("Gateway review session was not created read-only.");
  }
  if (entry.spawnedCwd !== expected.cwd) {
    throw new Error("Gateway review session cwd did not match the requested checkout.");
  }
  if (entry.sessionId !== value.sessionId) {
    throw new Error("Gateway review session did not match the created session.");
  }
  if (typeof entry.agentId === "string" && entry.agentId !== expected.agentId) {
    throw new Error("Gateway review session did not match the created session.");
  }
  if (typeof entry.key === "string" && entry.key !== expected.sessionKey) {
    throw new Error("Gateway review session did not match the created session.");
  }
  return { sessionId: value.sessionId, sessionKey: expected.sessionKey };
}

async function terminalPayload(
  first: unknown,
  rpc: (
    method: string,
    params: Record<string, unknown>,
    cap: number,
    expectFinal: boolean,
  ) => Promise<unknown>,
  runKey: string,
  remaining: () => number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const initial = requireRecord(first, "Gateway agent result");
  if (!isPending(initial)) return initial;
  if (signal.aborted || remaining() < 1) throw coded("Gateway review timeout.", "ETIMEDOUT");
  const runId = typeof initial.runId === "string" && initial.runId ? initial.runId : runKey;
  let waited: unknown;
  try {
    waited = await rpc(
      "agent.wait",
      { runId, timeoutMs: Math.max(1, remaining()) },
      remaining(),
      false,
    );
  } catch (error) {
    if (isTimeout(error)) throw error;
    throw new Error("Gateway review failed.", { cause: error });
  }
  const terminal = requireRecord(waited, "Gateway agent result");
  if (isPending(terminal)) throw new Error("Gateway review returned an unexpected status.");
  return terminal;
}

function noteReported(meta: GatewayRunMeta, value: Record<string, unknown>): void {
  const result = isRecord(value.result) ? value.result : undefined;
  const nested = result && isRecord(result.meta) ? result.meta : undefined;
  const sessionId = firstString(value.sessionId, result?.sessionId, nested?.sessionId);
  const sessionKey = firstString(value.sessionKey, result?.sessionKey, nested?.sessionKey);
  if (sessionId !== undefined) {
    if (!SESSION_ID.test(sessionId) || sessionId !== meta.sessionId) meta.mismatch = true;
    meta.reportedSessionId = sessionId.length <= 128 ? sessionId : null;
  }
  if (sessionKey !== undefined) {
    if (sessionKey !== meta.sessionKey || sessionKey.length > 256 || sessionKey.includes("\0")) {
      meta.mismatch = true;
    }
    meta.reportedSessionKey = sessionKey.length <= 256 ? sessionKey : null;
  }
}

function payloadText(value: Record<string, unknown>): string {
  const result = isRecord(value.result) ? value.result : undefined;
  const payloads = Array.isArray(result?.payloads)
    ? result.payloads
    : Array.isArray(value.payloads)
      ? value.payloads
      : [];
  return payloads
    .filter(isRecord)
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function isPending(value: Record<string, unknown>): boolean {
  return value.status === "accepted" || value.status === "in_flight";
}

function tier(
  provider: unknown,
  model: unknown,
): { provider: string | null; model: string | null } | undefined {
  const providerPresent = typeof provider === "string" && provider.length > 0;
  const modelPresent = typeof model === "string" && model.length > 0;
  if (!providerPresent && !modelPresent) return undefined;
  return { provider: safeRuntimeId(provider), model: safeRuntimeId(model) };
}

function safeRuntimeId(value: unknown): string | null {
  return typeof value === "string" && RUNTIME_ID.test(value) ? value : null;
}

function mismatchedProof(): { mismatch: true; provenance: GatewayProvenance } {
  return { mismatch: true, provenance: unavailableGatewayProvenance() };
}

function selectRows(
  db: ReturnType<typeof openDatabase>,
  sql: string,
  ...params: string[]
): Record<string, unknown>[] | "missing" {
  try {
    const rows = db.prepare(sql).all(...params);
    if (!Array.isArray(rows))
      throw new Error("Gateway session query returned an unexpected result.");
    return rows.map((row) => {
      if (!isRecord(row)) throw new Error("Gateway session query returned an unexpected result.");
      return row;
    });
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return "missing";
    throw error;
  }
}

function numeric(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Gateway session query returned an unexpected result.");
  }
  return value;
}

function openDatabase(databasePath: string) {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(databasePath, { readOnly: true });
}

function assertDatabasePath(databasePath: string): void {
  if (
    !isAbsolute(databasePath) ||
    databasePath.includes("\0") ||
    databasePath.split(sep).includes("..")
  ) {
    throw new Error("Gateway review database path is invalid.");
  }
  if (databasePath.split(sep).at(-1) !== "openclaw-agent.sqlite") {
    throw new Error("Gateway review database path is invalid.");
  }
}

function emptyMeta(): GatewayRunMeta {
  return {
    sessionId: null,
    sessionKey: null,
    reportedSessionId: null,
    reportedSessionKey: null,
    permissionMode: null,
    cwd: null,
    mismatch: false,
    terminalStatus: null,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a string.`);
  return value;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function coded(message: string, code: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === "ETIMEDOUT" || error.name === "AbortError")
  );
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
