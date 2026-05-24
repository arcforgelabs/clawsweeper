#!/usr/bin/env python3
"""Create the Arc Forge ClawSweeper GitHub App via manifest flow."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

ORG = "arcforgelabs"
REDIRECT_PATH = "/clawsweeper-app-created"
PORT = 8765
REDIRECT_URL = f"http://127.0.0.1:{PORT}{REDIRECT_PATH}"

MANIFEST = {
    "name": "Arc Forge ClawSweeper",
    "url": "https://github.com/arcforgelabs/clawsweeper",
    "hook_attributes": {"active": False},
    "redirect_url": REDIRECT_URL,
    "callback_urls": [REDIRECT_URL],
    "public": False,
    "default_permissions": {
        "contents": "write",
        "issues": "write",
        "pull_requests": "write",
        "actions": "write",
        "metadata": "read",
        "workflows": "write",
        "checks": "write",
    },
    "default_events": ["issues", "issue_comment", "pull_request"],
    "request_oauth_on_install": False,
}

REPOS = [
    "arcforgelabs/clawsweeper",
    "arcforgelabs/clawsweeper-state",
    "arcforgelabs/arc-forge-console",
]


class Handler(BaseHTTPRequestHandler):
    code: str | None = None

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != REDIRECT_PATH:
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(parsed.query)
        Handler.code = params.get("code", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"Arc Forge ClawSweeper app created. You can close this tab.\n")
        threading.Thread(target=self.server.shutdown, daemon=True).start()  # type: ignore[attr-defined]

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def gh_json(args: list[str]) -> dict:
    result = subprocess.run(["gh", "api", *args], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def gh_run(args: list[str], *, input_text: str | None = None) -> None:
    subprocess.run(
        ["gh", *args],
        check=True,
        input=input_text,
        capture_output=True,
        text=True,
    )


def main() -> int:
    manifest_b64 = base64.urlsafe_b64encode(json.dumps(MANIFEST).encode()).decode().rstrip("=")
    manifest_url = f"https://github.com/organizations/{ORG}/settings/apps/new?manifest={manifest_b64}"

    server = None
    try:
        server = HTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:
        if exc.errno != 98:
            raise
        print(
            f"Port {PORT} is already in use; assuming an existing bootstrap redirect server is running.",
            file=sys.stderr,
        )

    if server is not None:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
    else:
        thread = None

    print(f"Open this GitHub app manifest URL and complete org sudo confirmation:\n{manifest_url}")
    webbrowser.open(manifest_url)
    print(f"Waiting for redirect to {REDIRECT_URL} ...")

    if thread is not None:
        thread.join(timeout=600)
    else:
        deadline = time.time() + 600
        while time.time() < deadline and not Handler.code:
            time.sleep(1)
    if not Handler.code:
        print("Timed out waiting for GitHub app manifest redirect.", file=sys.stderr)
        print("Complete GitHub sudo mode in your browser, then rerun this script.", file=sys.stderr)
        return 1

    conversion = gh_json(["-X", "POST", f"/app-manifests/{Handler.code}/conversions"])
    client_id = conversion["client_id"]
    app_id = conversion["id"]
    pem = conversion["pem"]
    slug = conversion.get("slug", "arc-forge-clawsweeper")

    print(f"Created GitHub App {slug} (id={app_id}, client_id={client_id})")

    for repo in REPOS:
        gh_run(["secret", "set", "CLAWSWEEPER_APP_PRIVATE_KEY", "-R", repo], input_text=pem)
        gh_run(["secret", "set", "CLAWSWEEPER_APP_CLIENT_ID", "-R", repo], input_text=client_id)
        print(f"Set app secrets on {repo}")

    gh_run(["secret", "set", "CLAWSWEEPER_APP_PRIVATE_KEY", "-o", ORG], input_text=pem)
    gh_run(["secret", "set", "CLAWSWEEPER_APP_CLIENT_ID", "-o", ORG], input_text=client_id)
    print(f"Set org-level app secrets on {ORG}")

    gh_run(["variable", "set", "CLAWSWEEPER_APP_CLIENT_ID", "-R", "arcforgelabs/arc-forge-console", "-b", client_id])
    print("Set CLAWSWEEPER_APP_CLIENT_ID repo variable on arc-forge-console")

    install_url = f"https://github.com/apps/{slug}/installations/new"
    print(f"\nInstall the app on {ORG} repositories:\n{install_url}")
    webbrowser.open(install_url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
