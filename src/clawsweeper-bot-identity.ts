// The GitHub identity ClawSweeper writes as: its App logins and the git
// identity of its commits. The dashboard Worker and workflow steps run this
// file from source, so it has no imports.

// The ClawSweeper App slug. GraphQL reports the App bot login without the
// "[bot]" suffix, and commits use it as the author name so GitHub shows the
// App avatar.
export const CLAWSWEEPER_APP_SLUG = "clawsweeper";
// The REST `user.login` of the ClawSweeper App bot.
export const CLAWSWEEPER_APP_LOGIN = `${CLAWSWEEPER_APP_SLUG}[bot]`;
const CLAWSWEEPER_APP_USER_ID = 274271284;
export const CLAWSWEEPER_APP_NOREPLY_EMAIL = `${CLAWSWEEPER_APP_USER_ID}+${CLAWSWEEPER_APP_LOGIN}@users.noreply.github.com`;

// A fork that runs its own GitHub App names that App's REST bot login, for
// example "example-clawsweeper[bot]", in the CLAWSWEEPER_APP_BOT_LOGIN
// environment variable (comma-separated for several). Workflow steps read it
// from the process environment; the Worker uses its CLAWSWEEPER_BOT_LOGINS
// variable instead. Unset keeps the upstream logins only.
const CONFIGURED_APP_BOT_LOGINS: readonly string[] = String(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.CLAWSWEEPER_APP_BOT_LOGIN ?? "",
)
  .split(",")
  .map((login) => login.trim().toLowerCase())
  .filter((login) => /^[a-z0-9-]+\[bot\]$/.test(login));

// The REST `user.login` values of the Apps ClawSweeper writes as. A REST login
// of bare "clawsweeper" is a user account, so it is not in this set.
export const CLAWSWEEPER_APP_BOT_LOGINS: ReadonlySet<string> = new Set([
  CLAWSWEEPER_APP_LOGIN,
  "openclaw-clawsweeper[bot]",
  ...CONFIGURED_APP_BOT_LOGINS,
]);
// Every author login ClawSweeper writes as, including the GraphQL form.
export const CLAWSWEEPER_BOT_LOGINS: ReadonlySet<string> = new Set([
  CLAWSWEEPER_APP_SLUG,
  ...CLAWSWEEPER_APP_BOT_LOGINS,
  ...CONFIGURED_APP_BOT_LOGINS.map((login) => login.slice(0, -"[bot]".length)),
]);
