import type { RepositoryProfile } from "./repository-profiles.js";

// A configured policy document that the default branch does not contain.
export const POLICY_DOCUMENT_ABSENT = "absent";

const BLOB_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type PolicyDocumentRevisions = Readonly<Record<string, string>>;

/**
 * Maps each configured root-level document to its blob SHA in a GitHub
 * contents listing of the repository root (`GET repos/{repo}/contents`), or to
 * POLICY_DOCUMENT_ABSENT. Malformed listings throw: a guessed revision would
 * either hide a vision change or re-review every open item.
 */
export function policyDocumentRevisionsFromRootListing(
  listing: unknown,
  documents: readonly string[],
): PolicyDocumentRevisions {
  if (!Array.isArray(listing)) {
    throw new Error("Policy document listing must be an array of repository root entries.");
  }
  const blobs = new Map<string, string>();
  for (const entry of listing) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Policy document listing contains a malformed entry.");
    }
    const { name, sha, type } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof type !== "string") {
      throw new Error("Policy document listing entry is missing its name or type.");
    }
    if (type !== "file" && type !== "symlink") continue;
    if (typeof sha !== "string" || !BLOB_SHA.test(sha.toLowerCase())) {
      throw new Error(`Policy document listing has no blob SHA for ${name}.`);
    }
    blobs.set(name, sha.toLowerCase());
  }
  return Object.fromEntries(
    documents.map((document) => [document, blobs.get(document) ?? POLICY_DOCUMENT_ABSENT]),
  );
}

/**
 * Returns the profile's policy document revisions, memoized per target repo so
 * one process (planner or review) hashes a single consistent snapshot. Profiles
 * without policy documents never fetch and return undefined, which keeps their
 * review policy hash identical to the hash before this input existed.
 */
export function createPolicyDocumentRevisionReader(
  fetchRootListing: (targetRepo: string) => unknown,
): (
  profile: Pick<RepositoryProfile, "targetRepo" | "policyDocuments">,
) => PolicyDocumentRevisions | undefined {
  const cache = new Map<string, PolicyDocumentRevisions>();
  return (profile) => {
    const documents = profile.policyDocuments;
    if (!documents || documents.length === 0) return undefined;
    const key = `${profile.targetRepo.toLowerCase()}\n${documents.join("\n")}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const revisions = policyDocumentRevisionsFromRootListing(
      fetchRootListing(profile.targetRepo),
      documents,
    );
    cache.set(key, revisions);
    return revisions;
  };
}
