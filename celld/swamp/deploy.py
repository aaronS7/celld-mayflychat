#!/usr/bin/env python3
"""Redeploy Mayfly on the existing consolidated fleet with vaulted Mercury settings."""
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from mercury import decode

WORKER = "mayfly-native"
MERCURY_NAMES = {"AI_SUMMARY_ENABLED", "MERCURY_BASE_URL", "MERCURY_API_KEY", "MERCURY_MODEL"}


class DeployError(Exception):
    """An operator-facing error containing no provider or storage diagnostics."""


def require(condition, message):
    if not condition:
        raise DeployError(message)


def metadata(manifest):
    value = manifest["raw_metadata"]
    return json.loads(value) if isinstance(value, str) else value


def bindings(manifest):
    values = metadata(manifest)["bindings"]
    require(len({b["name"] for b in values}) == len(values), "Live binding names are not unique.")
    return {b["name"]: b for b in values}


def merge_configuration(checkout, manifest, mercury):
    text = (checkout / "wrangler.jsonc").read_text()
    config = json.loads(re.sub(r"^\s*//.*$", "", text, flags=re.MULTILINE))
    require(config.get("name") == WORKER and config.get("main") == "celld/native/worker.ts",
            "The source configuration must target the existing mayfly-native Worker.")
    require(set(config) <= {"name", "main", "compatibility_date", "durable_objects", "migrations", "r2_buckets", "triggers", "vars"},
            "Source configuration has unsupported fields; review the deployment adapter before changing infrastructure.")
    require(set(config.get("durable_objects", {})) == {"bindings"}
            and all(set(b) == {"name", "class_name"} for b in config["durable_objects"]["bindings"])
            and all(set(b) == {"binding", "bucket_name"} for b in config.get("r2_buckets", []))
            and set(config.get("triggers", {})) <= {"crons"},
            "Resource configuration has unsupported fields; review the deployment adapter before changing infrastructure.")
    old = bindings(manifest)
    resources = {name: item for name, item in old.items() if item["type"] not in {"plain_text", "secret_text"}}
    proposed = {item["name"]: {"name": item["name"], "type": "durable_object_namespace", "class_name": item["class_name"]}
                for item in config["durable_objects"]["bindings"]}
    proposed.update({item["binding"]: {"name": item["binding"], "type": "r2_bucket", "bucket_name": item["bucket_name"]}
                     for item in config.get("r2_buckets", [])})
    require(proposed == resources, "Durable Object or storage bindings differ from production; deployment stopped.")
    raw = metadata(manifest)
    require(config["compatibility_date"] == raw["compatibility_date"], "Compatibility date differs from production.")
    migrations = config.get("migrations", [])
    require(all(set(m) <= {"tag", "new_sqlite_classes"} for m in migrations), "Unsupported Durable Object migration.")
    classes = [name for migration in migrations for name in migration.get("new_sqlite_classes", [])]
    require(sorted(classes) == sorted(manifest["sqlite_classes"]), "Durable Object classes differ from production.")
    require(config.get("triggers", {}).get("crons", []) == manifest.get("crons", []), "Cron configuration differs from production.")
    variables = {}
    for name, item in old.items():
        if item["type"] in {"plain_text", "secret_text"}:
            require(item["type"] == "plain_text", "This adapter cannot preserve a secret_text binding type; deployment stopped.")
            value = item.get("text", item.get("value"))
            require(isinstance(value, str), "Live Worker variables must be strings.")
            variables[name] = value
    require(variables.get("ENCRYPTION_ENABLED", "0") == "0", "Encrypted deployments cannot enable Mercury summaries.")
    config["vars"] = {**variables, **mercury, "AI_SUMMARY_ENABLED": "1"}
    return config


class Fleet:
    def __init__(self, directory):
        try:
            import boto3
            from botocore.config import Config
        except ImportError:
            raise DeployError("The deployment Python needs boto3. Use the configured celld-backup-tools virtual environment.") from None
        self.directory = directory
        destination = json.loads((directory / "migration-plan.json").read_text())["destination"]
        env = json.loads((directory / "environment-private.json").read_text())
        url = urlsplit(destination["uri"])
        require(url.scheme == "s3" and url.netloc, "Expected the consolidated fleet's S3 destination.")
        self.bucket, self.prefix = url.netloc, url.path.strip("/") + "/"
        self.client = boto3.client("s3", endpoint_url=destination["endpoint"], region_name=destination["region"],
                                  aws_access_key_id=env["AWS_ACCESS_KEY_ID"], aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
                                  aws_session_token=env.get("AWS_SESSION_TOKEN"),
                                  config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=10,
                                                retries={"max_attempts": 2}, s3={"addressing_style": "path"}))

    def get(self, key):
        response = self.client.get_object(Bucket=self.bucket, Key=self.prefix + key)
        try:
            return json.loads(response["Body"].read())
        finally:
            response["Body"].close()

    def catalog(self):
        return self.get("deploy/ingress.json")

    def manifest(self, reference):
        return self.get(reference["prefix"] + "/manifest.json")

    def deploy(self, project, dry_run):
        command = [sys.executable, str(self.directory / "ctl.py"), "deploy", str(project), "--json"]
        if dry_run:
            command.append("--dry-run")
        # ctl.py supplies the established fleet environment. Mercury is already
        # in the private Worker config; keep vault payloads out of child envs.
        env = {k: v for k, v in os.environ.items() if not k.startswith(("MERCURY_", "MAYFLY_MERCURY_", "__SWAMP_VAULT_"))}
        result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=180)
        require(result.returncode == 0, "celld " + ("dry-run" if dry_run else "deployment") + " failed; check fleet access and build dependencies.")
        value = json.loads(result.stdout)
        require(value.get("worker") == WORKER and re.fullmatch(r"[a-f0-9]{16,64}", value.get("version", "")), "celld returned an unexpected deployment result.")
        return value


def origin_url(origin):
    try:
        url = urlsplit(origin)
        valid = (url.scheme == "https" and url.hostname and url.path in {"", "/"}
                 and url.username is None and url.password is None and not url.query and not url.fragment
                 and (url.port is None or 0 < url.port < 65536)
                 and not any(ord(c) <= 32 or ord(c) == 127 or c in "?#\\" for c in origin))
    except ValueError:
        valid = False
    require(valid, "Use an HTTPS public origin without credentials, a path, query or fragment for verification.")
    return url


def verify_policy(origin):
    url = origin_url(origin)
    targets = [("http://127.0.0.1:" + str(port) + "/config", {"X-Forwarded-Host": url.netloc, "X-Forwarded-Proto": "https"})
               for port in [8960, 8961, 8962]] + [(origin.rstrip("/") + "/config", {})]
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        ready = True
        for target, headers in targets:
            try:
                with urlopen(Request(target, headers=headers), timeout=3) as response:
                    value = json.loads(response.read(32768))
                ready = ready and value.get("summary") == {"enabled": True} and value.get("encryption") is False
            except Exception:
                ready = False
        if ready:
            return
        time.sleep(0.5)
    raise DeployError("Deployment was published, but summary availability did not verify on all three nodes and public HTTPS within 45 seconds.")


def redeploy(checkout, fleet, mercury, dry_run, origin, verify=verify_policy):
    origin_url(origin)
    before = fleet.catalog()
    require(WORKER in before.get("workers", {}), "Mayfly is absent from the consolidated catalog; refusing to create a replacement fleet.")
    old_manifest = fleet.manifest(before["workers"][WORKER])
    config = merge_configuration(checkout, old_manifest, mercury)
    # Use an operator-private directory outside the checkout and remove plaintext
    # staging on success, errors and cancellation. No credential-bearing output
    # or deployment JSON is persisted in swamp's result records.
    with tempfile.TemporaryDirectory(prefix="mayfly-mercury-", dir=fleet.directory) as tmp:
        stage = Path(tmp)
        shutil.copytree(checkout / "celld/native", stage / "celld/native")
        config_path = stage / "wrangler.json"
        with config_path.open("x") as out:
            os.chmod(config_path, 0o600)
            json.dump(config, out)
        preview = fleet.deploy(stage, True)
        require(fleet.catalog() == before, "The fleet changed during preparation. Rerun to capture its current configuration.")
        if dry_run:
            return {"worker": WORKER, "version": preview["version"], "dry_run": True,
                    "published": False, "existing_bindings_preserved": True}
        published = fleet.deploy(stage, False)
        require(published["version"] == preview["version"], "Published version differs from the dry-run; inspect the fleet before retrying.")
        after = fleet.catalog()
        require({k: v for k, v in before.items() if k != "workers"} == {k: v for k, v in after.items() if k != "workers"}
                and {k: v for k, v in before["workers"].items() if k != WORKER} == {k: v for k, v in after["workers"].items() if k != WORKER},
                "Deployment published, but other catalog entries changed during verification. Inspect the fleet.")
        reference = after["workers"][WORKER]
        require(reference["version"] == published["version"], "Mayfly changed during deployment verification.")
        current = bindings(fleet.manifest(reference))
        original = bindings(old_manifest)
        require({k: v for k, v in current.items() if k not in MERCURY_NAMES} == {k: v for k, v in original.items() if k not in MERCURY_NAMES},
                "Deployment published, but existing Worker bindings did not verify unchanged.")
        for name in MERCURY_NAMES:
            require(current.get(name, {}).get("text") == config["vars"][name], "Deployment published, but Mercury bindings did not verify.")
        verify(origin)
        return {"worker": WORKER, "version": published["version"], "dry_run": False, "published": True,
                "summary_enabled": True, "existing_bindings_preserved": True, "all_nodes_and_https_verified": True}


def main():
    os.umask(0o077)
    def cancel(*_args):
        raise InterruptedError()
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        mercury = decode(os.environ.pop("MAYFLY_MERCURY_CONFIG", ""))
    except ValueError as error:
        raise DeployError(str(error)) from None
    dry = os.environ.get("MAYFLY_DRY_RUN")
    require(dry in {"0", "1"}, "MAYFLY_DRY_RUN must be exactly 0 or 1; run the provided workflow.")
    checkout = Path.cwd().resolve()
    directory = Path(os.environ["MAYFLY_FLEET_DIRECTORY"]).resolve()
    require(directory.is_dir() and (directory / "ctl.py").is_file(), "The consolidated fleet directory or ctl.py is missing.")
    require(not directory.is_relative_to(checkout), "Keep the private fleet directory outside the application checkout.")
    with (directory / ".mayfly-mercury-deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeployError("Another Mayfly redeployment is running. Wait for it to finish.") from None
        result = redeploy(checkout, Fleet(directory), mercury, dry == "1", os.environ["MAYFLY_PUBLIC_ORIGIN"])
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except DeployError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
    except (KeyboardInterrupt, InterruptedError):
        print("Deployment interrupted. Check fleet state before retrying.", file=sys.stderr)
        sys.exit(130)
    except Exception:
        print("Deployment could not complete. Check fleet access, the vault setup and the configured Python environment.", file=sys.stderr)
        sys.exit(1)
