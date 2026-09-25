"""Real swamp + hidden terminal input + real celld dry-run, using only fixtures."""
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mercury import SECRET, VAULT
from test_deploy import CHECKOUT, FakeFleet


class WorkflowTest(unittest.TestCase):
    def test_interactive_vault_and_real_workflow_dry_run(self):
        celld = Path(os.environ.get("MAYFLY_TEST_CELLD", str(Path.home() / ".local/share/celld-consolidated/bin/celld")))
        python = Path(os.environ.get("MAYFLY_DEPLOY_PYTHON", str(Path.home() / ".local/share/celld-backup-tools/venv/bin/python")))
        self.assertTrue(celld.is_file() and python.is_file() and shutil.which("swamp"), "Requires swamp, celld and Python with boto3")
        with tempfile.TemporaryDirectory(prefix="mayfly-swamp-test-") as tmp:
            root = Path(tmp)
            repo, fleet_dir = root / "swamp", root / "fleet"
            fleet_dir.mkdir()
            requests = []
            fixture = FakeFleet(fleet_dir)

            class Store(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_GET(self):
                    requests.append(("GET", self.path))
                    if self.path.endswith("/deploy/ingress.json"):
                        value = fixture.catalog()
                    elif self.path.endswith("/old/manifest.json"):
                        value = fixture.document
                    else:
                        self.send_error(404)
                        return
                    content = json.dumps(value).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)

                def do_PUT(self):
                    requests.append(("PUT", self.path))
                    self.send_error(403, "Dry-run tests may not publish")

            server = ThreadingHTTPServer(("127.0.0.1", 0), Store)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            (fleet_dir / "migration-plan.json").write_text(json.dumps({"destination": {
                "uri": "s3://fixture/mayfly", "endpoint": "http://127.0.0.1:" + str(server.server_port), "region": "us-east-1"}}))
            (fleet_dir / "environment-private.json").write_text(json.dumps({"PATH": os.environ["PATH"],
                "AWS_ACCESS_KEY_ID": "fixture-access", "AWS_SECRET_ACCESS_KEY": "fixture-secret"}))
            # A fixture of the consolidated helper's documented invocation. This
            # targets only the loopback fixture, never a production destination.
            helper = '''import json,os,pathlib,sys
base=pathlib.Path(__file__).resolve().parent
plan=json.loads((base/'migration-plan.json').read_text())['destination']
env=json.loads((base/'environment-private.json').read_text())
binary=CELLD
args=[binary,*sys.argv[1:],'--bucket',plan['uri'],'--endpoint',plan['endpoint'],'--region',plan['region']]
os.execve(binary,args,env)
'''.replace("CELLD", repr(str(celld)))
            (fleet_dir / "ctl.py").write_text(helper)
            env = {k: v for k, v in os.environ.items() if k not in {"SWAMP_SERVE_URL", "SWAMP_SERVER_URL", "SWAMP_REPO_DIR"}}

            def cli(*args, value=None, timeout=120):
                result = subprocess.run(["swamp", *args, "--no-telemetry"], input=value, capture_output=True,
                                        text=True, env=env, timeout=timeout)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return result.stdout

            cli("repo", "init", str(repo), "--tool", "none", "--json")
            cli("vault", "create", "local_encryption", VAULT, "--repo-dir", str(repo), "--json")
            created = json.loads(cli("workflow", "create", "mayfly-deploy", "--repo-dir", str(repo), "--json"))
            template = (CHECKOUT / "celld/swamp/workflows/workflow-mayfly-deploy.yaml").read_text()
            Path(created["path"]).write_text(re.sub(r"^id: [^\n]+", "id: " + created["id"], template, count=1))
            validation = json.loads(cli("workflow", "validate", "mayfly-deploy", "--repo-dir", str(repo), "--json"))
            self.assertTrue(validation["passed"])

            master, slave = pty.openpty()
            process = subprocess.Popen([sys.executable, str(CHECKOUT / "celld/swamp/configure.py"), "--repo-dir", str(repo)],
                                       stdin=slave, stdout=slave, stderr=slave, env=env)
            transcript = bytearray()
            secret = "fixture-$USER-`id`-literal-key"

            def expect(text):
                deadline = time.monotonic() + 45
                while text.encode() not in transcript:
                    self.assertIsNone(process.poll(), transcript.decode(errors="replace"))
                    self.assertLess(time.monotonic(), deadline, "Prompt did not appear: " + text)
                    if select.select([master], [], [], 0.1)[0]:
                        transcript.extend(os.read(master, 16384))

            try:
                expect("Mercury base URL")
                os.write(master, b"https://provider.example/v1\n")
                expect("Mercury model")
                os.write(master, b"\n")
                expect("Mercury API key (hidden):")
                self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
                os.write(master, (secret + "\n").encode())
                expect("Repeat API key (hidden):")
                self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
                os.write(master, (secret + "\n").encode())
                expect("Saved Mercury settings.")
                self.assertEqual(process.wait(timeout=10), 0)
                self.assertNotIn(secret.encode(), transcript)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                os.close(master)
                os.close(slave)

            stored = json.loads(cli("vault", "read-secret", VAULT, SECRET, "--repo-dir", str(repo), "--force", "--json"))
            values = json.loads(stored["value"])
            self.assertEqual(values["MERCURY_API_KEY"], secret)
            self.assertEqual(values["MERCURY_BASE_URL"], "https://provider.example/v1")
            versions = []

            def records(value):
                if isinstance(value, dict):
                    if value.get("worker") == "mayfly-native" and "published" in value:
                        yield value
                    for child in value.values():
                        yield from records(child)
                elif isinstance(value, list):
                    for child in value:
                        yield from records(child)
                elif isinstance(value, str):
                    try:
                        yield from records(json.loads(value))
                    except ValueError:
                        pass

            for rotate in [False, True]:
                if rotate:
                    values["MERCURY_API_KEY"] = "rotated-fixture-key"
                    cli("vault", "put", VAULT, SECRET, "--yes", "--repo-dir", str(repo), "--json", value=json.dumps(values))
                cli("workflow", "validate", "mayfly-deploy", "--repo-dir", str(repo), "--json")
                output = cli("workflow", "run", "mayfly-deploy", "--repo-dir", str(repo), "--input", "dryRun=true",
                             "--input", "checkout=" + str(CHECKOUT), "--input", "fleetDirectory=" + str(fleet_dir),
                             "--input", "python=" + str(python), "--input", "publicOrigin=https://app.example", timeout=240)
                data = cli("data", "get", "mayfly-deploy", "result", "--repo-dir", str(repo), "--json")
                history = cli("workflow", "history", "get", "mayfly-deploy", "--repo-dir", str(repo), "--json")
                for private in [secret, "rotated-fixture-key", "existing-jev-fixture", "existing-report-fixture"]:
                    self.assertNotIn(private, output + data + history)
                result = next(records(json.loads(data)))
                self.assertTrue(result["dry_run"])
                self.assertFalse(result["published"])
                versions.append(result["version"])
                self.assertFalse(list(fleet_dir.glob("mayfly-mercury-*")), "Private staging is removed after the real celld dry-run")
            self.assertNotEqual(*versions, "A second run must use the rotated vault value")
            self.assertTrue(requests)
            self.assertTrue(all(method == "GET" for method, _ in requests), requests)


if __name__ == "__main__":
    unittest.main()
