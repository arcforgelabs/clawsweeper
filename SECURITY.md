# Security Policy

If you believe you have found a security issue in Arc Forge's fork of ClawSweeper, report it privately first.

Do not open a public issue or pull request that discloses an unpatched vulnerability, exploit path, secret, or security-sensitive proof of concept.

## Reporting

This repository is a fork of [openclaw/clawsweeper](https://github.com/openclaw/clawsweeper).

- **Issues in upstream ClawSweeper code:** submit a private advisory to [openclaw/clawsweeper](https://github.com/openclaw/clawsweeper/security/advisories/new), or email [security@openclaw.ai](mailto:security@openclaw.ai).
- **Issues in this fork's own changes, or in Arc Forge's ClawSweeper deployment:** submit a private [GitHub Security Advisory](https://github.com/arcforgelabs/clawsweeper/security/advisories/new) here. If you cannot use it, open a public issue that only asks for a disclosure contact and contains no details.

If you are unsure where it belongs, report it here and we will route it.

Useful reports include:

- the affected commit SHA,
- the impacted workflow, Worker route, or file path,
- reproduction steps against current `main`,
- the actual impact and which trust boundary below it crosses,
- a suggested fix when practical.

## Scope

Security-relevant surfaces specific to this fork include:

- the Arc Forge gateway execution adapter: `dashboard/arcforge-entry.ts`, `dashboard/gateway-*.ts`, `dashboard/review-coordinator.ts`, `dashboard/wrangler.arcforge.toml`, and `scripts/arcforge/` (see `docs/arcforge-gateway-queue.md`),
- the signed `/gateway/take` and `/gateway/finish` endpoints, execution leases, and stale-owner rejection,
- the private deployment's protection of queue items, reports, and lifecycle data,
- GitHub App and repository tokens used for review, dispatch, and publication, and their scopes,
- hosted-target admission and the target repository configuration,
- GitHub Actions workflows that run with credentials.

## Out of Scope

The following are usually out of scope for this repository:

- issues in upstream ClawSweeper behavior that this fork does not change, which belong in [openclaw/clawsweeper](https://github.com/openclaw/clawsweeper/security/advisories/new),
- issues in OpenClaw core or Codex that must be fixed in their own repositories,
- prompt injection in reviewed issue or PR content by itself, unless it demonstrates a concrete auth, approval, merge, or token-scope bypass,
- reports that require prior write access to this repository, its Actions secrets, or the deployment's state,
- scanner-only findings without a working reproduction and demonstrated impact.

## Trust Boundaries

- Issue and PR content on target repositories is untrusted input, from any GitHub user.
- Maintainer commands are trusted only from authorized maintainers of the target repository.
- Model output is not a trusted principal. Close, repair, and merge actions stay gated by policy, confidence, and maintainer authority.
- Gateway workers and the host running them are inside the operator trust boundary, and they claim work through the signed `/gateway/take` endpoint.

Reports should show how an untrusted input crosses one of those boundaries.
