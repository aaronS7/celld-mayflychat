#!/usr/bin/env python3
"""Prompt locally for Mercury settings and store them with swamp vault put."""
import argparse
import getpass
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from mercury import DEFAULT_MODEL, SECRET, VAULT, settings


def swamp(repo, *args, value=None):
    # This helper always operates on the local vault, even in a shell that has
    # remote swamp defaults. Secret material travels on stdin, never argv.
    env = {k: v for k, v in os.environ.items() if k not in {"SWAMP_SERVE_URL", "SWAMP_SERVER_URL"}}
    result = subprocess.run(["swamp", "vault", *args, "--repo-dir", str(repo), "--json", "--no-telemetry"],
                            input=value, text=True, capture_output=True, env=env, timeout=60)
    if result.returncode:
        raise RuntimeError("Swamp vault operation failed. Check this repository and its vault permissions.")
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise RuntimeError("Swamp returned an unexpected response.") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        raise RuntimeError("Run this interactive setup from a terminal; the API key is entered with echo hidden.")
    if not shutil.which("swamp"):
        raise RuntimeError("Install swamp before running this setup.")
    repo = args.repo_dir.resolve()
    if not (repo / ".swamp.yaml").is_file():
        raise RuntimeError("This is not an initialized swamp repository.")
    vault = swamp(repo, "get", VAULT)
    if vault.get("type") != "local_encryption" or Path(vault.get("config", {}).get("base_dir", "")).resolve() != repo:
        raise RuntimeError("Expected this checkout's local encrypted vault. Check its base_dir with swamp vault get.")
    keys = swamp(repo, "list-keys", VAULT).get("secretKeys")
    if not isinstance(keys, list):
        raise RuntimeError("Swamp returned an unexpected vault key listing.")
    print("Mercury settings → local encrypted swamp vault: " + VAULT)
    if SECRET in keys:
        print("This replaces the existing Mercury settings. The live deployment changes only when you run the workflow.")
    print("Use the API base URL including /v1 where needed, without /chat/completions.")
    base_url = input("Mercury base URL [https://api.inceptionlabs.ai/v1]: ").strip() or "https://api.inceptionlabs.ai/v1"
    model = input("Mercury model [" + DEFAULT_MODEL + "]: ").strip() or DEFAULT_MODEL
    api_key = getpass.getpass("Mercury API key (hidden): ")
    confirm = getpass.getpass("Repeat API key (hidden): ")
    if api_key != confirm:
        raise ValueError("Keys did not match. Nothing was stored.")
    value = settings(base_url, api_key, model)
    # One encrypted entry keeps an endpoint change and key rotation together.
    swamp(repo, "put", VAULT, SECRET, "--yes", value=json.dumps(value))
    print("Saved Mercury settings. No credentials were deployed.")
    print("From the application checkout, preview with: npm run mercury:preview")
    print("Deploy and enable summaries with: npm run mercury:deploy")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled; deployment was not changed.", file=sys.stderr)
        sys.exit(130)
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        # Child stdout/stderr and secret input are never printed.
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else "Setup could not complete; check swamp and local filesystem access."
        print(message, file=sys.stderr)
        sys.exit(1)
