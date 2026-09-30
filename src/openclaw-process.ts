import { isRecord } from "./value-coerce.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_CHECKOUT_DIAGNOSTIC_MAX_BYTES,
  normalizedOutputFileBytes,
  normalizedTailBytes,
} from "./codex-output-capture.js";
import type { CodexProcessResult } from "./codex-process.js";
import {
  assertExclusiveNativeXaiProfile,
  readNativeOpenclawTranscript,
} from "./openclaw-native-transcript.js";
import {
  canonicalGatewayCwd,
  composeGatewayMessage,
  gatewayAgentDatabasePath,
  gatewayChildEnvironment,
  gatewayReviewEnabled,
  gatewaySessionKeyPrefix,
  readGatewaySessionProof,
  requireGatewayReviewSettings,
  unavailableGatewayProvenance,
  type GatewayProvenance,
  type GatewayRunMeta,
} from "./openclaw-gateway-review.js";

const OPENCLAW_PROCESS_WORKER_PATH = fileURLToPath(
  new URL("./openclaw-process-worker.js", import.meta.url),
);
const OPENCLAW_GATEWAY_WORKER_PATH = fileURLToPath(
  new URL("./openclaw-gateway-worker.js", import.meta.url),
);
const STDERR_FAILURE_TAIL_BYTES = 8 * 1024;
export { NATIVE_CHECKOUT_DIAGNOSTIC_MAX_BYTES };
const NATIVE_CHECKOUT_DIAGNOSTIC_NAME = /^[0-9]+\.native-checkout-inspection\.json$/;
const CHALLENGE_MISMATCH = "OpenClaw checkout inspection did not return the runner challenge.";
const RECEIPT_MISMATCH = "OpenClaw checkout inspection did not read the exact challenged path.";
const ENVELOPE_MISMATCH = "Native OpenClaw returned an unsuccessful or unexpected model envelope.";
const SAFE_VALIDATION_FAILURES = new Set([CHALLENGE_MISMATCH, RECEIPT_MISMATCH, ENVELOPE_MISMATCH]);

type ExactReadReceiptClassification = "success" | "mismatch" | "unavailable";

interface InspectionNotes {
  validationFailure: string | null;
  receipt: ExactReadReceiptClassification | null;
}

interface NativeCheckoutEnvelopeDiagnostic {
  parsed: boolean;
  okPresent: boolean;
  ok: boolean | null;
  statusPresent: boolean;
  status: string | null;
  providerPresent: boolean;
  provider: string | null;
  modelPresent: boolean;
  model: string | null;
  finalPresent: boolean;
}

interface NativeCheckoutDiagnostic {
  version: 1;
  raw: { status: number | null; signal: string | null; errorKind: string | null };
  stdoutBytes: number;
  envelope: NativeCheckoutEnvelopeDiagnostic;
  normalized: { status: number | null; validationFailure: string | null };
  receipt: ExactReadReceiptClassification | null;
  provenance?: GatewayProvenance;
}

export function nativeCheckoutDiagnosticPath(
  workDir: string,
  itemNumber: number,
): string | undefined {
  if (!Number.isSafeInteger(itemNumber) || itemNumber < 0) return undefined;
  if (typeof workDir !== "string" || workDir.length === 0 || workDir.includes("\0"))
    return undefined;
  const root = resolve(workDir);
  const diagnosticPath = join(root, `${itemNumber}.native-checkout-inspection.json`);
  if (dirname(diagnosticPath) !== root) return undefined;
  if (!NATIVE_CHECKOUT_DIAGNOSTIC_NAME.test(basename(diagnosticPath))) return undefined;
  return diagnosticPath;
}

interface SerializedProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: { message: string; code?: string };
  stdout: string;
  stderr: string;
}

export interface OpenClawProcessOptions {
  label: string;
  prompt: string;
  model: string;
  reasoningEffort?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  tailBytes?: number;
  outputFileBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
  checkoutInspection?: { expectedText: string; expectedPath: string };
  // Host-owned review artifact path. Never derived from model output.
  checkoutDiagnosticPath?: string;
  outputSchema?: Record<string, unknown>;
}

export function runOpenclawProcess(options: OpenClawProcessOptions): CodexProcessResult {
  if (gatewayReviewEnabled(options.env)) return runGatewayOwnedReview(options);
  const stateDir = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-process-"));
  const configPath = join(stateDir, "openclaw.json");
  const promptPath = join(stateDir, "prompt.md");
  const workerOptionsPath = join(stateDir, "worker-options.json");
  const resultPath = join(stateDir, "result.json");
  const stdoutPath = options.stdoutPath ?? join(stateDir, "stdout.log");
  const stderrPath = options.stderrPath ?? join(stateDir, "stderr.log");
  let nativeCheckoutDiagnostic: NativeCheckoutDiagnostic | undefined;
  const noteInspection = (status: number | null, inspection: InspectionNotes): void => {
    if (!nativeCheckoutDiagnostic) return;
    nativeCheckoutDiagnostic.normalized = {
      status: safeProcessStatus(status),
      validationFailure: safeValidationFailure(inspection.validationFailure),
    };
    nativeCheckoutDiagnostic.receipt = inspection.receipt;
  };
  try {
    const native = nativeExecSettings(options);
    const runStateDir = join(stateDir, "run");
    if (native) mkdirSync(runStateDir, { mode: 0o700 });
    const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1_000));
    // Native reviews must never execute untrusted repository instructions on the
    // credential-owning gateway. Workspace-rooted read is sufficient for review.
    const config = openclawConfig(
      options.env,
      timeoutSeconds,
      Boolean(native || options.checkoutInspection),
    );
    if (native) {
      const agents = config.agents as Record<string, unknown>;
      agents.defaults = {
        ...(agents.defaults as Record<string, unknown>),
        systemAgent: { agentId: native.agentId },
        ...(options.outputSchema && !options.checkoutInspection
          ? {
              models: {
                [options.model]: {
                  params: {
                    response_format: {
                      type: "json_schema",
                      json_schema: {
                        name: "clawsweeper_review",
                        strict: true,
                        schema: options.outputSchema,
                      },
                    },
                  },
                },
              },
            }
          : {}),
      };
      agents.entries = {
        [native.agentId]: {
          agentDir: native.agentDir,
          model: { primary: options.model, fallbacks: [] },
        },
      };
      config.auth = { order: { xai: [native.profileId] } };
      // One permitted tool does not need a discovery/dispatch indirection.
      (config.tools as Record<string, unknown>).toolSearch = false;
      config.plugins = { allow: ["xai"], slots: { memory: "none" } };
    }
    writeFileSync(configPath, `${JSON.stringify(config)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const prompt =
      native && !options.checkoutInspection
        ? "Runtime constraints: This is a read-only review. Your only tool is read, rooted in the target checkout. Shell, git commands, tests, writes, and tool discovery are unavailable. Use the supplied diff/context and read source files directly; report any missing evidence instead of attempting unavailable tools. Return the requested final review schema.\n\n" +
          options.prompt
        : options.prompt;
    writeFileSync(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
    const sessionId = openclawSessionId(options.label);
    const args = native
      ? [
          "agent",
          "exec",
          "--config",
          configPath,
          "--cwd",
          options.cwd,
          "--state-dir",
          runStateDir,
          "--model",
          options.model,
          "--message-file",
          promptPath,
          "--timeout",
          String(timeoutSeconds),
          "--json",
        ]
      : [
          "agent",
          "--local",
          "--agent",
          "main",
          "--session-id",
          sessionId,
          "--model",
          options.model,
          "--message-file",
          promptPath,
          "--timeout",
          String(timeoutSeconds),
          "--json",
        ];
    const thinking = options.reasoningEffort?.trim();
    if (thinking) args.splice(args.length - 1, 0, "--thinking", thinking);
    // Deny-by-default: the embedded agent runs untrusted repository content
    // with full exec, so it must never inherit workflow credentials (GitHub
    // App tokens, state tokens, webhook secrets). Only the base OS surface,
    // OpenClaw controls, and the provider API keys inference needs pass
    // through — mirroring the codex lane, which keeps OPENAI_API_KEY out of
    // subprocesses via its proxy auth mode.
    const childEnv: NodeJS.ProcessEnv = {
      ...(native
        ? nativeExecEnvironment(options.env)
        : pickEnv(options.env, OPENCLAW_CHILD_ENV_ALLOWLIST)),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: options.cwd,
    };
    if (!native && !childEnv.OPENAI_API_KEY && options.env.CLAWSWEEPER_OPENCLAW_OPENAI_KEY) {
      childEnv.OPENAI_API_KEY = options.env.CLAWSWEEPER_OPENCLAW_OPENAI_KEY;
    }
    writeFileSync(
      workerOptionsPath,
      JSON.stringify({
        args,
        command: options.env.CLAWSWEEPER_OPENCLAW_BIN?.trim() || "openclaw",
        timeoutMs: options.timeoutMs,
        resultPath,
        stdoutPath,
        stderrPath,
        tailBytes: normalizedTailBytes(options.tailBytes),
        maxOutputFileBytes: normalizedOutputFileBytes(options.outputFileBytes),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const worker = spawnSync(process.execPath, [OPENCLAW_PROCESS_WORKER_PATH, workerOptionsPath], {
      cwd: options.cwd,
      env: childEnv,
      stdio: "ignore",
      timeout: options.timeoutMs + 10_000,
    });
    if (!existsSync(resultPath)) {
      const failed = worker.error
        ? failedResult(worker.error, worker.status, worker.signal)
        : failedResult(
            new Error(
              `OpenClaw process worker failed with exit ${worker.status ?? "unknown"} and did not write a result.`,
            ),
            worker.status,
            worker.signal,
          );
      nativeCheckoutDiagnostic = nativeCheckoutDiagnosticFor(
        native,
        options,
        failed,
        undefined,
        fileByteCount(stdoutPath),
      );
      return failed;
    }
    const processResult = deserializeResult(JSON.parse(readFileSync(resultPath, "utf8")));
    if (worker.error) {
      const failed = { ...processResult, error: worker.error };
      nativeCheckoutDiagnostic = nativeCheckoutDiagnosticFor(
        native,
        options,
        failed,
        undefined,
        fileByteCount(stdoutPath),
      );
      return failed;
    }
    const completeStdout = readFileSync(stdoutPath, "utf8");
    nativeCheckoutDiagnostic = nativeCheckoutDiagnosticFor(
      native,
      options,
      processResult,
      completeStdout,
      fileByteCount(stdoutPath),
    );
    let normalizedStdout = completeStdout;
    let nativeTranscript: string | undefined;
    if (native && !processResult.error) {
      if (parseOpenclawJsonEnvelope(completeStdout, processResult.stderr).failure) {
        const failure = normalizeOpenclawResult(
          { ...processResult, status: 0 },
          completeStdout,
          options.checkoutInspection,
        );
        const returned = {
          ...failure.result,
          status: processResult.status || failure.result.status,
        };
        noteInspection(returned.status, failure.inspection);
        return returned;
      }
      if (processResult.status !== 0) {
        noteInspection(processResult.status, { validationFailure: null, receipt: null });
        return processResult;
      }
      const envelope: unknown = JSON.parse(completeStdout);
      if (
        !isRecord(envelope) ||
        envelope.ok !== true ||
        envelope.status !== "ok" ||
        envelope.provider !== "xai" ||
        envelope.model !== options.model.slice(4) ||
        typeof envelope.sessionId !== "string" ||
        typeof envelope.final !== "string"
      ) {
        throw new Error(ENVELOPE_MISMATCH);
      }
      // Native exec excludes commentary/reasoning and can recover a final
      // answer from runtime metadata even when it emits no text payload.
      normalizedStdout = JSON.stringify({ payloads: [{ text: envelope.final }] });
      if (options.checkoutInspection)
        nativeTranscript = readNativeOpenclawTranscript(
          join(runStateDir, "agents", native.agentId, "agent", "openclaw-agent.sqlite"),
          envelope.sessionId,
        );
    }
    const normalized = normalizeOpenclawResult(
      processResult,
      normalizedStdout,
      options.checkoutInspection,
      {
        cwd: options.cwd,
        // OpenClaw persists an explicit local session under this agent-owned
        // path; inspect it before the isolated state directory is removed.
        transcriptPath: join(stateDir, "agents", "main", "sessions", `${sessionId}.jsonl`),
        ...(nativeTranscript !== undefined ? { transcript: nativeTranscript } : {}),
      },
    );
    noteInspection(normalized.result.status, normalized.inspection);
    return normalized.result;
  } catch (error) {
    if (
      nativeCheckoutDiagnostic &&
      nativeCheckoutDiagnostic.normalized.validationFailure === null
    ) {
      const message = error instanceof Error ? error.message : "";
      nativeCheckoutDiagnostic.normalized = {
        status: null,
        validationFailure: safeValidationFailure(message),
      };
      if (nativeCheckoutDiagnostic.receipt === null)
        nativeCheckoutDiagnostic.receipt = "unavailable";
    }
    return failedResult(error instanceof Error ? error : new Error(String(error)));
  } finally {
    try {
      if (nativeCheckoutDiagnostic && options.checkoutDiagnosticPath) {
        writeNativeCheckoutDiagnostic(
          options.checkoutDiagnosticPath,
          nativeCheckoutDiagnostic,
          stateDir,
        );
      }
    } catch {
      // Diagnostic retention must not replace the inspection result.
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function runGatewayOwnedReview(options: OpenClawProcessOptions): CodexProcessResult {
  const settings = requireGatewayReviewSettings(options.env);
  if (!isAbsolute(options.cwd) || options.cwd.includes("\0")) {
    return failedResult(new Error("Gateway review cwd must be absolute."));
  }
  let message = "";
  try {
    options = { ...options, cwd: canonicalGatewayCwd(options.cwd) };
    message = composeGatewayMessage(
      options.prompt,
      options.outputSchema,
      Boolean(options.checkoutInspection),
    );
  } catch (error) {
    return failedResult(error instanceof Error ? error : new Error(String(error)));
  }
  const secrets = [message];
  if (options.outputSchema) {
    const schemaJson = JSON.stringify(options.outputSchema);
    if (schemaJson.length >= 12) secrets.push(schemaJson);
  }
  const stateDir = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-gateway-"));
  const resultPath = join(stateDir, "result.json");
  const metaPath = join(stateDir, "meta.json");
  const optionsPath = join(stateDir, "worker-options.json");
  let diagnostic: NativeCheckoutDiagnostic | undefined;
  const databasePath = gatewayAgentDatabasePath(settings.agentId, options.env);
  const prefix = gatewaySessionKeyPrefix(settings.agentId);
  try {
    writeFileSync(
      optionsPath,
      JSON.stringify({
        packageRoot: settings.packageRoot,
        agentId: settings.agentId,
        message,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        resultPath,
        metaPath,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(optionsPath, 0o600);
    const worker = spawnSync(process.execPath, [OPENCLAW_GATEWAY_WORKER_PATH, optionsPath], {
      cwd: options.cwd,
      env: gatewayChildEnvironment(options.env),
      stdio: "ignore",
      timeout: options.timeoutMs + 10_000,
    });
    if (!existsSync(resultPath)) {
      const failed = worker.error
        ? failedResult(worker.error, worker.status, worker.signal)
        : failedResult(
            new Error(
              `OpenClaw process worker failed with exit ${worker.status ?? "unknown"} and did not write a result.`,
            ),
            worker.status,
            worker.signal,
          );
      diagnostic = gatewayCheckoutDiagnostic(
        options,
        failed,
        "",
        unavailableGatewayProvenance(),
        false,
      );
      return redactGatewayResult(failed, secrets);
    }
    let processResult = readGatewayWorkerResult(resultPath);
    if (worker.error && !processResult.error) {
      processResult = { ...processResult, error: worker.error };
      diagnostic = gatewayCheckoutDiagnostic(
        options,
        processResult,
        processResult.stdout,
        unavailableGatewayProvenance(),
        false,
      );
      return redactGatewayResult(processResult, secrets);
    }
    const meta = readGatewayMeta(metaPath);
    const rawStdout = processResult.stdout;
    const accepting = processResult.status === 0 && !processResult.error;
    let provenance = unavailableGatewayProvenance();
    let identityMismatch = meta?.mismatch === true;
    if (meta?.reportedSessionId && meta.reportedSessionId !== meta.sessionId)
      identityMismatch = true;
    if (meta?.reportedSessionKey && meta.reportedSessionKey !== meta.sessionKey)
      identityMismatch = true;
    if (accepting && (!meta?.sessionId || !meta.sessionKey?.startsWith(prefix)))
      identityMismatch = true;
    if (accepting && meta?.permissionMode !== "read-only") {
      const failed = failedResult(new Error("Gateway review session was not created read-only."));
      diagnostic = gatewayCheckoutDiagnostic(options, failed, rawStdout, provenance, false);
      return redactGatewayResult(failed, secrets);
    }
    if (accepting && meta?.cwd !== options.cwd) {
      const failed = failedResult(
        new Error("Gateway review session cwd did not match the requested checkout."),
      );
      diagnostic = gatewayCheckoutDiagnostic(options, failed, rawStdout, provenance, false);
      return redactGatewayResult(failed, secrets);
    }
    if (identityMismatch) {
      const failed = accepting
        ? failedResult(new Error("Gateway review session did not match the created session."))
        : processResult;
      diagnostic = gatewayCheckoutDiagnostic(options, failed, rawStdout, provenance, false);
      return redactGatewayResult(failed, secrets);
    }
    if (meta?.sessionId) {
      try {
        const proof = readGatewaySessionProof(databasePath, meta.sessionId, meta.sessionKey);
        if (proof.mismatch) {
          const failed = failedResult(
            new Error("Gateway review session did not match the created session."),
          );
          diagnostic = gatewayCheckoutDiagnostic(options, failed, rawStdout, provenance, false);
          return redactGatewayResult(accepting ? failed : processResult, secrets);
        }
        provenance = proof.provenance;
      } catch (error) {
        if (accepting) throw error;
      }
    }
    // Retain host-observed runtime provenance outside the untrusted checkout.
    const provenancePath = options.env.CLAWSWEEPER_OPENCLAW_PROVENANCE_PATH;
    if (accepting && !options.checkoutInspection && provenancePath) {
      if (!isAbsolute(provenancePath)) throw new Error("Gateway provenance path must be absolute.");
      writeFileSync(
        provenancePath,
        JSON.stringify({
          version: 1,
          sessionId: meta?.sessionId,
          sessionKey: meta?.sessionKey,
          provider: provenance.provider,
          model: provenance.model,
        }),
        { mode: 0o600 },
      );
    }
    let transcript: string | undefined;
    if (accepting && options.checkoutInspection) {
      if (!meta?.sessionId) {
        throw new Error("Native checkout transcript is missing or exceeds its event limit.");
      }
      transcript = readNativeOpenclawTranscript(databasePath, meta.sessionId);
    }
    const normalized = normalizeOpenclawResult(
      processResult,
      rawStdout,
      options.checkoutInspection,
      options.checkoutInspection
        ? {
            cwd: options.cwd,
            transcriptPath: join(stateDir, "unused-transcript.jsonl"),
            ...(transcript !== undefined ? { transcript } : {}),
          }
        : undefined,
    );
    diagnostic = gatewayCheckoutDiagnostic(
      options,
      normalized.result,
      rawStdout,
      provenance,
      accepting,
    );
    if (diagnostic) {
      diagnostic.normalized = {
        status: safeProcessStatus(normalized.result.status),
        validationFailure: safeValidationFailure(normalized.inspection.validationFailure),
      };
      diagnostic.receipt = normalized.inspection.receipt;
    }
    return redactGatewayResult(normalized.result, secrets);
  } catch (error) {
    if (diagnostic && diagnostic.normalized.validationFailure === null) {
      const text = error instanceof Error ? error.message : "";
      diagnostic.normalized = { status: null, validationFailure: safeValidationFailure(text) };
      if (diagnostic.receipt === null) diagnostic.receipt = "unavailable";
    }
    return redactGatewayResult(
      failedResult(error instanceof Error ? error : new Error(String(error))),
      secrets,
    );
  } finally {
    try {
      if (diagnostic && options.checkoutDiagnosticPath) {
        writeNativeCheckoutDiagnostic(options.checkoutDiagnosticPath, diagnostic, stateDir);
      }
    } catch {
      // Diagnostic retention must not replace the inspection result.
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function gatewayCheckoutDiagnostic(
  options: OpenClawProcessOptions,
  processResult: CodexProcessResult,
  rawStdout: string,
  provenance: GatewayProvenance,
  finalAccepted: boolean,
): NativeCheckoutDiagnostic | undefined {
  if (!options.checkoutInspection) return undefined;
  let parsed = false;
  let finalPresent = false;
  try {
    const value: unknown = rawStdout ? JSON.parse(rawStdout) : undefined;
    if (isRecord(value)) {
      parsed = true;
      const result = isRecord(value.result) ? value.result : value;
      const payloads = Array.isArray(result.payloads) ? result.payloads : [];
      finalPresent = payloads.some(
        (payload) =>
          isRecord(payload) && typeof payload.text === "string" && payload.text.length > 0,
      );
    }
  } catch {
    parsed = false;
  }
  const succeeded = processResult.status === 0 && !processResult.error;
  const code =
    processResult.error && "code" in processResult.error
      ? (processResult.error as NodeJS.ErrnoException).code
      : undefined;
  const status = succeeded ? "ok" : code === "ETIMEDOUT" ? "timeout" : "error";
  return {
    version: 1,
    raw: {
      status: safeProcessStatus(processResult.status),
      signal: safeProcessSignal(processResult.signal),
      errorKind: processErrorKind(processResult.error),
    },
    stdoutBytes: Buffer.byteLength(rawStdout),
    envelope: {
      parsed,
      okPresent: true,
      ok: succeeded,
      statusPresent: true,
      status,
      providerPresent: provenance.provider !== null,
      provider: provenance.provider,
      modelPresent: provenance.model !== null,
      model: provenance.model,
      finalPresent: finalAccepted && finalPresent,
    },
    normalized: { status: safeProcessStatus(processResult.status), validationFailure: null },
    receipt: null,
    provenance,
  };
}

function readGatewayWorkerResult(resultPath: string): CodexProcessResult {
  const metadata = lstatSync(resultPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 9 * 1024 * 1024) {
    throw new Error("Gateway review worker result is invalid.");
  }
  const value: unknown = JSON.parse(readFileSync(resultPath, "utf8"));
  if (!isRecord(value) || typeof value.stdout !== "string" || typeof value.stderr !== "string") {
    throw new Error("Gateway review worker result is invalid.");
  }
  const status = typeof value.status === "number" ? value.status : null;
  const error =
    isRecord(value.error) && typeof value.error.message === "string" ? value.error : undefined;
  return {
    status,
    signal: null,
    ...(error
      ? {
          error: deserializeError({
            message: String(error.message),
            ...(typeof error.code === "string" ? { code: error.code } : {}),
          }),
        }
      : {}),
    stdout: value.stdout,
    stderr: value.stderr,
  };
}

function readGatewayMeta(metaPath: string): GatewayRunMeta | undefined {
  if (!existsSync(metaPath)) return undefined;
  const metadata = lstatSync(metaPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65_536) {
    throw new Error("Gateway review session metadata is invalid.");
  }
  const value: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
  if (!isRecord(value)) throw new Error("Gateway review session metadata is invalid.");
  return {
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    sessionKey: typeof value.sessionKey === "string" ? value.sessionKey : null,
    reportedSessionId: typeof value.reportedSessionId === "string" ? value.reportedSessionId : null,
    reportedSessionKey:
      typeof value.reportedSessionKey === "string" ? value.reportedSessionKey : null,
    permissionMode: typeof value.permissionMode === "string" ? value.permissionMode : null,
    cwd: typeof value.cwd === "string" ? value.cwd : null,
    mismatch: value.mismatch === true,
    terminalStatus: typeof value.terminalStatus === "string" ? value.terminalStatus : null,
  };
}

function redactGatewayResult(
  result: CodexProcessResult,
  secrets: readonly string[],
): CodexProcessResult {
  if (!result.error && result.status === 0) return result;
  const redact = (value: string) => {
    let text = value;
    for (const secret of secrets) {
      if (secret.length >= 8) text = text.replaceAll(secret, "[redacted]");
    }
    return text;
  };
  const error = result.error;
  return {
    ...result,
    ...(error
      ? {
          error: Object.assign(new Error(redact(error.message)), {
            name: error.name,
            ...((error as NodeJS.ErrnoException).code
              ? { code: (error as NodeJS.ErrnoException).code }
              : {}),
          }),
        }
      : {}),
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  };
}

function nativeExecSettings(
  options: OpenClawProcessOptions,
): { agentId: string; agentDir: string; profileId: string } | undefined {
  const flag = options.env.CLAWSWEEPER_OPENCLAW_NATIVE_EXEC?.trim();
  if (!flag || flag === "0") return undefined;
  if (flag !== "1") throw new Error("CLAWSWEEPER_OPENCLAW_NATIVE_EXEC must be 0 or 1.");
  const agentId = options.env.CLAWSWEEPER_OPENCLAW_AUTH_AGENT_ID?.trim().toLowerCase() ?? "";
  const agentDir = options.env.CLAWSWEEPER_OPENCLAW_AUTH_AGENT_DIR?.trim() ?? "";
  const profileId = options.env.CLAWSWEEPER_OPENCLAW_AUTH_PROFILE_ID?.trim() ?? "";
  if (
    !options.model.startsWith("xai/") ||
    options.env.CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON?.trim() ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(agentId) ||
    !isAbsolute(agentDir) ||
    !/^xai:[a-zA-Z0-9@._+-]+$/.test(profileId)
  ) {
    throw new Error(
      "Native exec requires an xAI model, explicit auth agent id, absolute auth agent directory, and xAI profile id; custom provider blocks are unsupported.",
    );
  }
  assertExclusiveNativeXaiProfile(join(agentDir, "openclaw-agent.sqlite"), profileId);
  return { agentId, agentDir, profileId };
}

function nativeExecEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
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
  ]) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  return result;
}

export function parseOpenclawJsonEnvelope(
  stdout: string,
  stderr = "",
): { text: string; failure?: Error } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return {
      text: "",
      failure: new Error(
        `OpenClaw exited successfully but produced invalid JSON.${boundedStderrDetail(stderr)}`,
      ),
    };
  }
  if (!isRecord(envelope)) {
    return { text: "", failure: new Error("OpenClaw JSON output must be an object.") };
  }
  const result = isRecord(envelope.result) ? envelope.result : envelope;
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const text = payloads
    .filter(isRecord)
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .filter(Boolean)
    .join("\n");
  const failureDetail = openclawFailureDetail(envelope, result, payloads);
  return {
    text,
    ...(failureDetail ? { failure: new Error(`OpenClaw agent failed: ${failureDetail}`) } : {}),
  };
}

function openclawConfig(
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  checkoutInspection: boolean,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        skipBootstrap: true,
        sandbox: { mode: "off" },
        timeoutSeconds,
      },
    },
    tools: checkoutInspection
      ? {
          allow: ["read"],
          fs: { workspaceOnly: true },
          exec: { host: "gateway", mode: "deny" },
        }
      : {
          profile: "coding",
          fs: { workspaceOnly: true },
          exec: { host: "gateway", mode: "full" },
        },
  };
  const providersJson = env.CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON?.trim();
  if (!providersJson) {
    const builtin = builtinProviderBlock(env.CLAWSWEEPER_OPENCLAW_MODEL?.trim() || "");
    if (builtin) config.models = { mode: "merge", providers: builtin };
    return config;
  }
  let providers: unknown;
  try {
    providers = JSON.parse(providersJson);
  } catch {
    throw new Error("CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON must be valid JSON.");
  }
  if (!isRecord(providers)) {
    throw new Error("CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON must be a JSON object.");
  }
  // OpenClaw config validation requires models[].name; default it to the id so
  // provider blocks stay minimal.
  for (const provider of Object.values(providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (isRecord(model) && typeof model.id === "string" && model.name === undefined) {
        model.name = model.id;
      }
    }
  }
  config.models = { mode: "merge", providers };
  return config;
}

function normalizeOpenclawResult(
  processResult: CodexProcessResult,
  completeStdout: string,
  checkoutInspection?: { expectedText: string; expectedPath: string },
  receipt?: { cwd: string; transcriptPath: string; transcript?: string },
): { result: CodexProcessResult; inspection: InspectionNotes } {
  const noted = (
    result: CodexProcessResult,
    validationFailure: string | null,
    receiptClassification: ExactReadReceiptClassification | null,
  ) => ({
    result,
    inspection: { validationFailure, receipt: receiptClassification },
  });
  if (processResult.error || processResult.status !== 0) return noted(processResult, null, null);
  const parsed = parseOpenclawJsonEnvelope(completeStdout, processResult.stderr);
  if (!parsed.failure) {
    if (!checkoutInspection) return noted({ ...processResult, stdout: parsed.text }, null, null);
    const receiptInspection = receipt
      ? inspectReadReceipt({ ...receipt, expectedPath: checkoutInspection.expectedPath })
      : { success: false, classification: "unavailable" as const };
    if (parsed.text.trim() !== checkoutInspection.expectedText) {
      return noted(
        failedInspectionResult(processResult, CHALLENGE_MISMATCH),
        CHALLENGE_MISMATCH,
        receiptInspection.classification,
      );
    }
    // The runtime-owned session receipt binds the successful read to the
    // host-selected tracked path, whose expected line never enters the prompt.
    if (!receiptInspection.success) {
      return noted(
        failedInspectionResult(processResult, RECEIPT_MISMATCH),
        RECEIPT_MISMATCH,
        receiptInspection.classification,
      );
    }
    return noted({ ...processResult, stdout: "" }, null, "success");
  }
  if (/\btimeout\b/i.test(parsed.failure.message)) {
    (parsed.failure as NodeJS.ErrnoException).code = "ETIMEDOUT";
  }
  return noted(
    { ...processResult, status: 1, error: parsed.failure, stdout: parsed.text },
    null,
    null,
  );
}

function inspectReadReceipt(options: {
  cwd: string;
  transcriptPath: string;
  transcript?: string;
  expectedPath: string;
}): { success: boolean; classification: ExactReadReceiptClassification } {
  let transcript: string;
  try {
    transcript = options.transcript ?? readFileSync(options.transcriptPath, "utf8");
  } catch {
    return { success: false, classification: "unavailable" };
  }
  const readCalls = new Map<string, { matchesExpectedPath: boolean; resolved: boolean }>();
  let challengedReadSucceeded = false;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return { success: false, classification: "unavailable" };
    }
    if (!isRecord(entry) || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        if (
          block.name !== "read" ||
          typeof block.id !== "string" ||
          !isRecord(block.arguments) ||
          typeof block.arguments.path !== "string" ||
          readCalls.has(block.id)
        ) {
          return { success: false, classification: "mismatch" };
        }
        readCalls.set(block.id, {
          matchesExpectedPath:
            resolve(options.cwd, block.arguments.path) ===
            resolve(options.cwd, options.expectedPath),
          resolved: false,
        });
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    if (message.toolName !== "read" || typeof message.toolCallId !== "string") {
      return { success: false, classification: "mismatch" };
    }
    const call = readCalls.get(message.toolCallId);
    if (!call || call.resolved || message.isError !== false) {
      return { success: false, classification: "mismatch" };
    }
    call.resolved = true;
    if (call.matchesExpectedPath) challengedReadSucceeded = true;
  }
  const success = challengedReadSucceeded && [...readCalls.values()].every((call) => call.resolved);
  return { success, classification: success ? "success" : "mismatch" };
}

function failedInspectionResult(
  processResult: CodexProcessResult,
  message: string,
): CodexProcessResult {
  return { ...processResult, status: 1, error: new Error(message), stdout: "" };
}

function openclawFailureDetail(
  envelope: Record<string, unknown>,
  result: Record<string, unknown>,
  payloads: unknown[],
): string {
  const meta = isRecord(result.meta) ? result.meta : {};
  const errors = [
    detailText(meta.error),
    detailText(result.error),
    detailText(envelope.error),
  ].filter(Boolean);
  if (errors.length > 0) return errors.join("; ");
  const errorPayload = payloads.filter(isRecord).find((payload) => payload.isError === true);
  if (errorPayload) {
    return detailText(errorPayload.text) || detailText(errorPayload.error) || "error payload";
  }
  const stopReason = [meta.stopReason, result.stopReason, envelope.stopReason]
    .find((value) => typeof value === "string")
    ?.toString()
    .trim();
  if (stopReason && /^(?:timeout|timed_out|error|aborted)$/i.test(stopReason)) {
    return `stop reason ${stopReason}`;
  }
  if (meta.aborted === true) return "agent run was aborted";
  const executionTrace = isRecord(meta.executionTrace) ? meta.executionTrace : {};
  if (
    executionTrace.exhausted === true ||
    meta.fallbackExhaustedFailure === true ||
    result.fallbackExhaustedFailure === true
  ) {
    const attempts = Array.isArray(executionTrace.attempts) ? executionTrace.attempts : [];
    const lastAttempt = attempts.filter(isRecord).at(-1);
    return lastAttempt
      ? `all model fallbacks were exhausted: ${detailText(lastAttempt)}`
      : "all model fallbacks were exhausted";
  }
  if (
    typeof envelope.status === "string" &&
    !["ok", "completed", "success"].includes(envelope.status)
  ) {
    return detailText(envelope.summary) || `status ${envelope.status}`;
  }
  return "";
}

function detailText(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, 2_000);
  if (value === true) return "reported an error";
  if (!isRecord(value)) return "";
  for (const key of ["message", "errorMessage", "detail", "reason"]) {
    const nested = value[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim().slice(0, 2_000);
  }
  return "reported an error";
}

const OPENCLAW_CHILD_ENV_ALLOWLIST = [
  // Base OS/tooling surface the CLI needs to run.
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "NODE_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Provider API keys the embedded agent needs for direct inference. These
  // are the credentials this lane intentionally trades for provider choice;
  // everything else in the step environment stays out.
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MINIMAX_API_KEY",
  "KIMI_API_KEY",
  "KIMICODE_API_KEY",
  "MOONSHOT_API_KEY",
  "CEREBRAS_API_KEY",
  "ZAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
] as const;

function pickEnv(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    // OPENCLAW_* carries operational controls (log level, test hooks), never
    // workflow credentials; everything else must be explicitly allowlisted.
    if (value !== undefined && (names.includes(name) || name.startsWith("OPENCLAW_"))) {
      picked[name] = value;
    }
  }
  return picked;
}

// Kimi Code (api.kimi.com/coding) works with released openclaw versions that
// predate the bundled kimi provider plugin, but only via explicit provider
// config. Ship those defaults so `kimi/...` models run without extra setup.
// Verified 2026-07-25: kimi-for-coding needs maxTokens above the runtime
// default or reasoning-heavy turns die on the output cap; k3 limits are from
// the Kimi Code catalog (1M context, 131072 max output).
const BUILTIN_PROVIDERS = {
  kimi: {
    baseUrl: "https://api.kimi.com/coding/",
    apiKey: "${KIMI_API_KEY}",
    api: "anthropic-messages",
    models: [
      { id: "kimi-for-coding", name: "Kimi Code", contextWindow: 262144, maxTokens: 65536 },
      { id: "k3", name: "Kimi K3", contextWindow: 1048576, maxTokens: 131072 },
    ],
  },
  // Cerebras Code plans serve the GLM coding model at ~1000 tok/s; validated
  // live 2026-07-25 (474 tok/s wall including network, E2E tool run in 5s).
  // zai-glm-4.7 deprecates 2026-08-17 — update the id when Cerebras swaps in
  // its successor.
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    apiKey: "${CEREBRAS_API_KEY}",
    api: "openai-completions",
    models: [{ id: "zai-glm-4.7", name: "Z.ai GLM 4.7", contextWindow: 128000, maxTokens: 8192 }],
  },
  // Z.AI GLM Coding Plan keys only authorize the coding endpoint — the general
  // paas endpoint rejects them with error 1113. Validated live 2026-07-25
  // (~51 tok/s, E2E tool run in 16s).
  zai: {
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKey: "${ZAI_API_KEY}",
    api: "openai-completions",
    models: [{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 131072 }],
  },
} as const;

function builtinProviderBlock(model: string): Record<string, unknown> | undefined {
  const provider = model.split("/", 1)[0] as keyof typeof BUILTIN_PROVIDERS;
  const block = BUILTIN_PROVIDERS[provider];
  if (!block) return undefined;
  return structuredClone({ [provider]: block }) as unknown as Record<string, unknown>;
}

function boundedStderrDetail(stderr: string): string {
  const tail = Buffer.from(stderr).subarray(-STDERR_FAILURE_TAIL_BYTES).toString("utf8").trim();
  return tail ? ` OpenClaw stderr: ${tail}` : "";
}

function openclawSessionId(label: string): string {
  const safeLabel = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 48);
  return `${safeLabel || "clawsweeper"}-${randomUUID()}`;
}

function nativeCheckoutDiagnosticFor(
  native: { agentId: string } | undefined,
  options: OpenClawProcessOptions,
  processResult: CodexProcessResult,
  stdout: string | undefined,
  stdoutBytes: number,
): NativeCheckoutDiagnostic | undefined {
  if (!native || !options.checkoutInspection) return undefined;
  return {
    version: 1,
    raw: {
      status: safeProcessStatus(processResult.status),
      signal: safeProcessSignal(processResult.signal),
      errorKind: processErrorKind(processResult.error),
    },
    stdoutBytes,
    envelope:
      stdout === undefined
        ? emptyEnvelopeDiagnostic()
        : envelopePresence(stdout, options.model.slice(4)),
    normalized: { status: safeProcessStatus(processResult.status), validationFailure: null },
    receipt: null,
  };
}

function writeNativeCheckoutDiagnostic(
  diagnosticPath: string,
  diagnostic: NativeCheckoutDiagnostic,
  stateDir: string,
): void {
  if (!isAbsolute(diagnosticPath)) return;
  if (!NATIVE_CHECKOUT_DIAGNOSTIC_NAME.test(basename(diagnosticPath))) return;
  const parent = dirname(diagnosticPath);
  let parentStat: ReturnType<typeof lstatSync>;
  try {
    parentStat = lstatSync(parent);
  } catch {
    return;
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return;
  const resolvedPath = resolve(diagnosticPath);
  const resolvedState = resolve(stateDir);
  if (resolvedPath === resolvedState || resolvedPath.startsWith(`${resolvedState}${sep}`)) return;
  try {
    const existing = lstatSync(diagnosticPath);
    if (existing.isSymbolicLink() || !existing.isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  const payload = `${JSON.stringify(diagnostic)}\n`;
  if (Buffer.byteLength(payload) > NATIVE_CHECKOUT_DIAGNOSTIC_MAX_BYTES) return;
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(diagnosticPath, flags, 0o600);
  try {
    const data = Buffer.from(payload);
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

function envelopePresence(stdout: string, expectedModel: string): NativeCheckoutEnvelopeDiagnostic {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return emptyEnvelopeDiagnostic();
  }
  if (!isRecord(value)) return { ...emptyEnvelopeDiagnostic(), parsed: true };
  return {
    parsed: true,
    okPresent: typeof value.ok === "boolean",
    ok: typeof value.ok === "boolean" ? value.ok : null,
    statusPresent: typeof value.status === "string",
    status:
      typeof value.status === "string" && ["ok", "error", "timeout"].includes(value.status)
        ? value.status
        : null,
    providerPresent: typeof value.provider === "string",
    provider: value.provider === "xai" ? "xai" : null,
    modelPresent: typeof value.model === "string",
    model:
      value.model === expectedModel && /^grok-[A-Za-z0-9_.-]{1,58}$/.test(expectedModel)
        ? expectedModel
        : null,
    finalPresent: typeof value.final === "string" && value.final.length > 0,
  };
}

function emptyEnvelopeDiagnostic(): NativeCheckoutEnvelopeDiagnostic {
  return {
    parsed: false,
    okPresent: false,
    ok: null,
    statusPresent: false,
    status: null,
    providerPresent: false,
    provider: null,
    modelPresent: false,
    model: null,
    finalPresent: false,
  };
}

function safeValidationFailure(message: string | null): string | null {
  return message && SAFE_VALIDATION_FAILURES.has(message) ? message : null;
}

function safeProcessStatus(status: number | null): number | null {
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function safeProcessSignal(signal: NodeJS.Signals | null): string | null {
  return signal && /^SIG[A-Z0-9]+$/.test(signal) ? signal : null;
}

function processErrorKind(error: Error | undefined): string | null {
  if (!error) return null;
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  if (
    typeof code === "string" &&
    [
      "ETIMEDOUT",
      "ENOENT",
      "EACCES",
      "EPERM",
      "E2BIG",
      "ENOBUFS",
      "EPIPE",
      "EIO",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOSPC",
      "ENOMEM",
    ].includes(code)
  )
    return code;
  if (["Error", "TypeError", "RangeError", "SyntaxError", "AbortError"].includes(error.name))
    return error.name;
  return "Error";
}

function fileByteCount(path: string): number {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return 0;
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) return 0;
    return metadata.size;
  } catch {
    return 0;
  }
}

function failedResult(
  error: Error,
  status: number | null = null,
  signal: NodeJS.Signals | null = null,
): CodexProcessResult {
  return { status, signal, error, stdout: "", stderr: "" };
}

function deserializeResult(value: SerializedProcessResult): CodexProcessResult {
  return {
    status: value.status,
    signal: value.signal,
    ...(value.error ? { error: deserializeError(value.error) } : {}),
    stdout: value.stdout,
    stderr: value.stderr,
  };
}

function deserializeError(value: { message: string; code?: string }): Error {
  const error = new Error(value.message);
  if (value.code) (error as NodeJS.ErrnoException).code = value.code;
  return error;
}
