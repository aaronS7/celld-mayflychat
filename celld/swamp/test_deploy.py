import copy
import json
import os
from pathlib import Path
import re
import tempfile
import unittest

from deploy import DeployError, MERCURY_NAMES, WORKER, merge_configuration, origin_url, redeploy
from mercury import decode, settings

CHECKOUT = Path(__file__).resolve().parents[2]
CONFIG = json.loads(re.sub(r"^\s*//.*$", "", (CHECKOUT / "wrangler.jsonc").read_text(), flags=re.MULTILINE))
MERCURY = settings("https://provider.example/v1/", "fixture'\"$literal;key")


def manifest(config):
    resources = [{"name": b["name"], "type": "durable_object_namespace", "class_name": b["class_name"]}
                 for b in config["durable_objects"]["bindings"]]
    resources += [{"name": b["binding"], "type": "r2_bucket", "bucket_name": b["bucket_name"]} for b in config["r2_buckets"]]
    resources += [{"name": name, "type": "plain_text", "text": value} for name, value in config["vars"].items()]
    return {"raw_metadata": {"bindings": resources, "compatibility_date": config["compatibility_date"]},
            "sqlite_classes": [name for m in config["migrations"] for name in m["new_sqlite_classes"]],
            "crons": config["triggers"]["crons"]}


def production_config():
    config = copy.deepcopy(CONFIG)
    config["vars"].update({"WIKI_ENABLED": "1", "WIKI_BOOK_LAYOUT_ENABLED": "1", "JEV_WIKI_SEARCH_ENABLED": "1",
                           "JEV_ENABLED": "1", "JEV_TAGGING_ENABLED": "1", "TYPESAFE_API_KEY": "existing-jev-fixture",
                           "REPORT_SUMMARY_KEY": "existing-report-fixture", "RETENTION_SECONDS": "12345"})
    return config


class FakeFleet:
    def __init__(self, directory):
        self.directory = directory
        self.current = {"schema_version": 2, "workers": {WORKER: {"version": "a" * 16, "prefix": "old"}, "other": {"version": "keep"}},
                        "hosts": {"app.example": WORKER}, "crons": ["keep-cron"]}
        self.document = manifest(production_config())
        self.calls = []
        self.received = []
        self.paths = []
        self.failure = False
        self.drift = False

    def catalog(self):
        return copy.deepcopy(self.current)

    def manifest(self, _reference):
        return copy.deepcopy(self.document)

    def deploy(self, stage, dry_run):
        self.calls.append(dry_run)
        self.paths.append(stage)
        assert stage.stat().st_mode & 0o777 == 0o700
        assert (stage / "wrangler.json").stat().st_mode & 0o777 == 0o600
        assert not stage.is_relative_to(CHECKOUT)
        config = json.loads((stage / "wrangler.json").read_text())
        self.received.append(config)
        if self.failure:
            raise InterruptedError()
        if self.drift:
            self.current["workers"][WORKER]["version"] = "c" * 16
        if not dry_run:
            self.current["workers"][WORKER] = {"version": "b" * 16, "prefix": "new"}
            self.document = manifest(config)
        return {"version": "b" * 16, "worker": WORKER}


class DeploymentTests(unittest.TestCase):
    def test_credentials_and_url_validation(self):
        self.assertEqual(decode(json.dumps(MERCURY)), MERCURY)
        self.assertEqual(MERCURY["MERCURY_BASE_URL"], "https://provider.example/v1")
        for url in ["http://provider.example/v1", "https://user:password@provider.example/v1", "https://provider.example/v1?key=x",
                    "https://provider.example/v1#key", "https://provider.example/v1/chat/completions", "https://example:bad/v1", "https://exa mple/v1"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                settings(url, "fixture")
        for key in ["", " ", "private\nheader", "private key"]:
            with self.assertRaises(ValueError):
                settings("https://example.com/v1", key)
        with self.assertRaises(ValueError):
            decode(json.dumps({**MERCURY, "TYPESAFE_API_KEY": "unexpected"}))
        for origin in ["https://app.example:bad", "https://app.example?", "https://@app.example", "https://app.example/path", "http://app.example"]:
            with self.subTest(origin=origin), self.assertRaises(DeployError):
                origin_url(origin)

    def test_preserves_live_settings_and_refuses_resource_or_encryption_changes(self):
        original = production_config()
        merged = merge_configuration(CHECKOUT, manifest(original), MERCURY)
        self.assertEqual({k: v for k, v in merged["vars"].items() if k not in MERCURY_NAMES},
                         {k: v for k, v in original["vars"].items() if k not in MERCURY_NAMES})
        self.assertEqual(merged["vars"]["AI_SUMMARY_ENABLED"], "1")
        for change in ["encryption", "resources", "cron", "classes", "compatibility"]:
            changed = manifest(original)
            if change == "encryption":
                next(b for b in changed["raw_metadata"]["bindings"] if b["name"] == "ENCRYPTION_ENABLED")["text"] = "1"
            elif change == "resources":
                changed["raw_metadata"]["bindings"][0]["class_name"] = "DifferentChat"
            elif change == "cron":
                changed["crons"] = []
            elif change == "classes":
                changed["sqlite_classes"] = []
            else:
                changed["raw_metadata"]["compatibility_date"] = "2020-01-01"
            with self.subTest(change=change), self.assertRaises(DeployError):
                merge_configuration(CHECKOUT, changed, MERCURY)

    def test_preview_and_apply_have_private_staging_and_verified_bindings(self):
        for dry_run in [True, False]:
            with self.subTest(dry_run=dry_run), tempfile.TemporaryDirectory() as tmp:
                fleet = FakeFleet(Path(tmp))
                verified = []
                result = redeploy(CHECKOUT, fleet, MERCURY, dry_run, "https://app.example", verify=verified.append)
                self.assertEqual(result["published"], not dry_run)
                self.assertEqual(fleet.calls, [True] if dry_run else [True, False])
                self.assertEqual(verified, [] if dry_run else ["https://app.example"])
                self.assertTrue(all(not path.exists() for path in fleet.paths))
                self.assertEqual(fleet.received[0]["vars"]["MERCURY_API_KEY"], MERCURY["MERCURY_API_KEY"])
                self.assertNotIn(MERCURY["MERCURY_API_KEY"], json.dumps(result))
                self.assertNotIn("existing-jev-fixture", json.dumps(result))

    def test_cancellation_and_catalog_drift_leave_no_staging_or_extra_deployment(self):
        for reason in ["cancel", "drift"]:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as tmp:
                fleet = FakeFleet(Path(tmp))
                fleet.failure, fleet.drift = reason == "cancel", reason == "drift"
                with self.assertRaises((InterruptedError, DeployError)):
                    redeploy(CHECKOUT, fleet, MERCURY, False, "https://app.example")
                self.assertEqual(fleet.calls, [True])
                self.assertTrue(all(not path.exists() for path in fleet.paths))

    def test_resource_fields_cannot_redirect_existing_objects(self):
        with tempfile.TemporaryDirectory() as tmp:
            checkout = Path(tmp)
            config = copy.deepcopy(CONFIG)
            config["durable_objects"]["bindings"][0]["script_name"] = "different-worker"
            (checkout / "wrangler.jsonc").write_text(json.dumps(config))
            with self.assertRaises(DeployError):
                merge_configuration(checkout, manifest(production_config()), MERCURY)


if __name__ == "__main__":
    unittest.main()
