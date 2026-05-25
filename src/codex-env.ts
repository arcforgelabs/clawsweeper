export type CodexEnvOptions = {
  ghToken?: string | undefined;
};

export function codexEnv(options: CodexEnvOptions = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const ghToken = options.ghToken?.trim();
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.COMMIT_SWEEPER_TARGET_GH_TOKEN;
  delete env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN;
  delete env.CLAWSWEEPER_APP_ID;
  delete env.CLAWSWEEPER_APP_PRIVATE_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  if (ghToken) env.GH_TOKEN = ghToken;
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export function codexForcedLoginMethod(): string {
  const configured = String(process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD ?? "").trim();
  if (configured) return configured;
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.CLAWSWEEPER_ALLOW_API_CODEX_AUTH !== "1"
  ) {
    return "chatgpt";
  }
  return "api";
}

export function codexForcedLoginConfig(): string {
  return `forced_login_method=${JSON.stringify(codexForcedLoginMethod())}`;
}
