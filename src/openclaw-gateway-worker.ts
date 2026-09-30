import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  executeGatewayReview,
  parseGatewayWorkerOptions,
  publicGatewayError,
  resolveGatewayRuntimeEntry,
  type GatewayExecution,
  type GatewayWorkerOptions,
} from "./openclaw-gateway-review.js";

const secrets: string[] = [];
let resultPath: string | undefined;

main().catch((error: unknown) => {
  if (resultPath) {
    writeResult(resultPath, {
      ok: false,
      finalText: "",
      error: publicGatewayError(error, secrets),
      meta: {
        sessionId: null,
        sessionKey: null,
        reportedSessionId: null,
        reportedSessionKey: null,
        permissionMode: null,
        cwd: null,
        mismatch: false,
        terminalStatus: null,
      },
    });
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error("Gateway review worker received unexpected arguments.");
  }
  const options = parseGatewayWorkerOptions(
    JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")),
  );
  resultPath = options.resultPath;
  if (options.message.length >= 8) secrets.push(options.message);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const entry = resolveGatewayRuntimeEntry(options.packageRoot);
    const imported = (await import(pathToFileURL(entry).href)) as {
      callGatewayFromCli?: Parameters<typeof executeGatewayReview>[0]["callGatewayFromCli"];
    };
    if (typeof imported.callGatewayFromCli !== "function") {
      throw new Error("OpenClaw gateway runtime export did not provide callGatewayFromCli.");
    }
    writeExecution(
      options,
      await executeGatewayReview({
        callGatewayFromCli: imported.callGatewayFromCli,
        agentId: options.agentId,
        message: options.message,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

function writeExecution(options: GatewayWorkerOptions, execution: GatewayExecution): void {
  writeFileSync(options.metaPath, JSON.stringify(execution.meta), {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(options.metaPath, 0o600);
  writeResult(options.resultPath, execution);
}

function writeResult(path: string, execution: GatewayExecution): void {
  const error = execution.ok
    ? undefined
    : (execution.error ?? { message: "Gateway review failed." });
  writeFileSync(
    path,
    JSON.stringify({
      status: execution.ok ? 0 : 1,
      signal: null,
      ...(error ? { error } : {}),
      stdout: execution.ok ? JSON.stringify({ payloads: [{ text: execution.finalText }] }) : "",
      stderr: error?.message ?? "",
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(path, 0o600);
}
