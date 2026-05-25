#!/usr/bin/env bash
set -euo pipefail

default_repo="arcforgelabs/clawsweeper"
repo="${1:-$default_repo}"
auth_json="${CODEX_AUTH_JSON:-$HOME/.codex/auth.json}"
workflow="${CLAWSWEEPER_CODEX_AUTH_DOCTOR_WORKFLOW:-codex-auth-doctor.yml}"

usage() {
  cat <<EOF
Usage: $0 [owner/repo]

Refresh CODEX_AUTH_JSON_B64 from a local Codex ChatGPT OAuth login, then start
the Codex Auth Doctor workflow.

Defaults:
  owner/repo: $default_repo
  auth file:  $auth_json

Environment:
  CODEX_AUTH_JSON                         Override the Codex auth.json path
  CLAWSWEEPER_CODEX_AUTH_DOCTOR_WORKFLOW  Override the doctor workflow file
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command codex
require_command gh
require_command base64
require_command tr

echo "Checking local Codex login..."
if ! codex login status >/dev/null 2>&1; then
  echo "No active Codex login found. Starting Codex login..."
  codex login
fi

status="$(codex login status 2>&1)"
echo "$status"
if [[ "$status" != *"ChatGPT"* ]]; then
  echo "Codex is not logged in with ChatGPT OAuth/subscription auth." >&2
  echo "Run 'codex login' and choose ChatGPT login, then rerun this script." >&2
  exit 1
fi

if [[ ! -s "$auth_json" ]]; then
  echo "Codex auth file not found or empty: $auth_json" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

base64 "$auth_json" | tr -d '\n' > "$tmp"

echo "Updating CODEX_AUTH_JSON_B64 on $repo..."
gh secret set CODEX_AUTH_JSON_B64 --repo "$repo" --body-file "$tmp" >/dev/null

echo "Starting $workflow on $repo..."
gh workflow run "$workflow" --repo "$repo" --ref main

echo "OAuth secret refreshed. Check the doctor run:"
echo "  gh run list --repo $repo --limit 5"
