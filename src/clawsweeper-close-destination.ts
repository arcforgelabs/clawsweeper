import type { CloseDestination, Decision, Evidence, Item } from "./clawsweeper-types.js";
import { normalizeRepo } from "./repository-profiles.js";

// `belongs_elsewhere` is the parameterised sibling of `clawhub`: the target
// repository's VISION.md says the work belongs in another repository, and the
// reviewer names that repository and quotes the line. It is recommend-only;
// repository profiles reject it in apply_close_rules.

export const CLOSE_DESTINATION_SCHEMA_KEYS = new Set([
  "repo",
  "visionPath",
  "visionLine",
  "visionQuote",
]);

export const CLOSE_DESTINATION_QUOTE_MAX_LENGTH = 400;

// GitHub owner (1-39 chars, alphanumeric or single hyphens) and repository name.
const REPOSITORY_SLUG =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;

export function isRepositorySlug(value: string): boolean {
  if (!REPOSITORY_SLUG.test(value)) return false;
  const name = value.split("/")[1] ?? "";
  return name !== "." && name !== ".." && !name.toLowerCase().endsWith(".git");
}

export function isVisionPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || LINE_BREAK.test(value)) {
    return false;
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return segments[segments.length - 1]?.toLowerCase() === "vision.md";
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function singleLine(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${path} must not be empty`);
  if (LINE_BREAK.test(text)) throw new Error(`${path} must be a single-line string`);
  return text;
}

/**
 * Parses the reviewer's `closeDestination`. Shape errors throw, matching the
 * schema: owner/repo destination, a repository-relative VISION.md path, a
 * positive line or null, and a non-empty one-line quote.
 */
export function parseCloseDestination(value: unknown, path: string): CloseDestination | null {
  if (value === null || value === undefined) return null;
  const entry = record(value, path);
  const unexpected = Object.keys(entry).filter((key) => !CLOSE_DESTINATION_SCHEMA_KEYS.has(key));
  if (unexpected.length) throw new Error(`${path} has unexpected keys: ${unexpected.join(", ")}`);
  const repo = singleLine(entry.repo, `${path}.repo`);
  if (!isRepositorySlug(repo)) throw new Error(`${path}.repo must look like owner/repo`);
  const visionPath = singleLine(entry.visionPath, `${path}.visionPath`);
  if (!isVisionPath(visionPath)) {
    throw new Error(`${path}.visionPath must be a repository-relative VISION.md path`);
  }
  const line = entry.visionLine;
  if (line !== null && (!Number.isSafeInteger(line) || (line as number) < 1)) {
    throw new Error(`${path}.visionLine must be a positive integer or null`);
  }
  const visionQuote = singleLine(entry.visionQuote, `${path}.visionQuote`);
  if (visionQuote.length > CLOSE_DESTINATION_QUOTE_MAX_LENGTH) {
    throw new Error(
      `${path}.visionQuote must be at most ${CLOSE_DESTINATION_QUOTE_MAX_LENGTH} characters`,
    );
  }
  return { repo, visionPath, visionLine: line as number | null, visionQuote };
}

/** Reads the `close_destination` front-matter value; anything malformed is null. */
export function closeDestinationFromFrontMatter(
  value: string | undefined,
): CloseDestination | null {
  if (!value || value === "null") return null;
  try {
    return parseCloseDestination(JSON.parse(value), "close_destination");
  } catch {
    return null;
  }
}

function evidenceCitesVision(entry: Evidence, destination: CloseDestination): boolean {
  const file = entry.file?.trim().replace(/^\.\//, "").replace(/:\d+$/, "");
  return Boolean(file) && file === destination.visionPath.replace(/^\.\//, "");
}

/**
 * Why a `belongs_elsewhere` decision cannot stand, or null when it can. Callers
 * fail closed on a reason: the decision is never applied and the public review
 * falls back to keep-open rendering. Maintainer-authored items keep the normal
 * close guards on top of this.
 */
export function belongsElsewhereDecisionBlockReason(
  item: Partial<Pick<Item, "repo">>,
  decision: Pick<Decision, "closeReason" | "closeDestination" | "evidence">,
): string | null {
  if (decision.closeReason !== "belongs_elsewhere") return null;
  const destination = decision.closeDestination;
  if (!destination) return "belongs_elsewhere requires a closeDestination";
  if (item.repo && normalizeRepo(item.repo) === normalizeRepo(destination.repo)) {
    return "belongs_elsewhere destination must differ from the reviewed repository";
  }
  if (!decision.evidence.some((entry) => evidenceCitesVision(entry, destination))) {
    return "belongs_elsewhere requires evidence citing the VISION.md it quotes";
  }
  return null;
}

function repositoryLink(repo: string): string {
  return `[\`${repo}\`](https://github.com/${repo})`;
}

function visionCitation(destination: CloseDestination): string {
  return destination.visionLine === null
    ? `\`${destination.visionPath}\``
    : `\`${destination.visionPath}\`, line ${destination.visionLine}`;
}

function quotedVisionText(destination: CloseDestination): string {
  // One line, rendered as a blockquote. Neutralize mentions so quoting a
  // VISION.md line can never ping anyone.
  return `> ${destination.visionQuote.replace(/@(?=[A-Za-z0-9])/g, "@\u200b")}`;
}

export function belongsElsewhereIntro(destination: CloseDestination): string {
  return `Thanks for this. I checked this repository's \`${destination.visionPath.split("/").pop()}\`, and this work belongs in ${repositoryLink(destination.repo)} rather than here.`;
}

export function belongsElsewhereBlock(destination: CloseDestination): string {
  return [
    `${visionCitation(destination)} says:`,
    "",
    quotedVisionText(destination),
    "",
    `- Destination: ${repositoryLink(destination.repo)}.`,
    `- Next step: raise the work in ${repositoryLink(destination.repo)} and link back to this thread so the context carries over.`,
    `- Boundary: ClawSweeper will not open an issue or PR in ${repositoryLink(destination.repo)}, transfer this item, or close it here.`,
  ].join("\n");
}

export function belongsElsewhereOutro(): string {
  return "This is a scope recommendation, not a close. A maintainer decides whether to move or close this item.";
}
