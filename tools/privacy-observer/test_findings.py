import json
from pathlib import Path
import stat
import tempfile
from time import time
import unittest
from unittest.mock import patch

from findings import Findings
from inspection import Journal, SCAN_LIMIT, inspect


class FindingsTests(unittest.TestCase):
    def test_persists_only_masked_aggregates_and_reopens_reviewed_recurrence(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "findings.sqlite"
            journal = Journal("codex-test", findings_path=path)
            event = journal.add("API.TEST.", "POST", b'{"password":"do-not-retain-value"}', [("Authorization", "Bearer never-persist-header")], "/private-path?token=never-persist-query")
            journal.update(event, "response 200")
            issues = journal.snapshot()["issues"]
            self.assertEqual(len(issues), 2)
            identifier = next(issue["id"] for issue in issues if issue["location"] == "body")
            journal.change("review-finding", finding_id=identifier)
            journal.change("clear")
            self.assertEqual(journal.snapshot()["events"], [])
            self.assertEqual(len(journal.snapshot()["issues"]), 2)
            journal.close()
            restored = Journal("codex-test", findings_path=path)
            try:
                report = restored.snapshot()
                reviewed = next(issue for issue in report["issues"] if issue["id"] == identifier)
                self.assertEqual(reviewed["state"], "reviewed")
                self.assertIsNotNone(reviewed["reviewedAt"])
                self.assertEqual(reviewed["lastOutcome"], "response received; data sent")
                self.assertEqual(report["tracking"]["observedThisSession"], 0)
                self.assertIsNone(report["tracking"]["lastObservedAt"])
                self.assertTrue(report["tracking"]["persistent"])
                self.assertEqual(report["tracking"]["directTraffic"], "unknown")
                restored.add("api.test", "POST", b'{"password":"do-not-retain-value"}', [], "/", "blocked")
                issue = next(issue for issue in restored.snapshot()["issues"] if issue["id"] == identifier)
                self.assertEqual((issue["state"], issue["occurrences"], issue["blocked"]), ("open", 2, 1))
                self.assertIsNone(issue["reviewedAt"])
                self.assertEqual(issue["lastOutcome"], "blocked")
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                for file in Path(folder).iterdir():
                    stored = file.read_bytes()
                    for forbidden in (b"do-not-retain-value", b"never-persist-header", b"never-persist-query", b"private-path"):
                        self.assertNotIn(forbidden, stored)
                restored.change("clear-findings")
                self.assertEqual(restored.snapshot()["issues"], [])
            finally:
                restored.close()

    def test_retention_and_capacity_bound_records_without_replaying_requests(self):
        now = time()
        ledger = Findings(retention_days=1, capacity=2)
        try:
            ledger.add("test", "expired.test", "email address", "body", "pending", now - 86401)
            ledger.add("test", "first.test", "email address", "body", "pending", now)
            ledger.add("test", "second.test", "email address", "body", "pending", now + 1)
            ledger.add("test", "third.test", "email address", "body", "pending", now + 2)
            self.assertEqual({issue["host"] for issue in ledger.snapshot(now + 2)}, {"second.test", "third.test"})
            self.assertEqual(ledger.snapshot(now + 86403), [])
        finally:
            ledger.close()

    def test_storage_failure_keeps_capture_available_and_exposes_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = Journal("test", findings_path=Path(folder) / "missing" / "findings.sqlite")
            try:
                journal.add("api.test", "POST", b'{"password":"synthetic-value"}', [], "/")
                report = journal.snapshot()
                self.assertTrue(report["tracking"]["persistenceError"])
                self.assertFalse(report["tracking"]["persistent"])
                self.assertEqual(len(report["issues"]), 1)
            finally:
                journal.close()

    def test_tracks_inspection_gaps_and_does_not_overwrite_newer_outcome(self):
        now = time()
        journal = Journal("test")
        try:
            with patch("inspection.time", return_value=now):
                first = journal.add("api.test", "POST", b'{"password":"fixture-value"}', [], "/")
            with patch("inspection.time", return_value=now + 1):
                journal.add("api.test", "POST", b'{"password":"fixture-value"}', [], "/", "blocked")
            journal.update(first, "response 200")
            self.assertEqual(journal.snapshot()["issues"][0]["lastOutcome"], "blocked")
            failed = journal.add("broken.test", "POST", b"", [], "/")
            journal.update(failed, "not inspected; body decoding failed")
            journal.add("large.test", "POST", b"x" * (SCAN_LIMIT + 1), [], "/")
            journal.add("binary.test", "POST", b"\x00\xff", [], "/")
            kinds = {issue["kind"] for issue in journal.snapshot()["issues"]}
            self.assertTrue({"inspection failed", "inspection truncated", "binary content; detection limited"} <= kinds)
            with self.assertRaises(ValueError):
                journal.change("review-finding", finding_id="0" * 64)
        finally:
            journal.close()

    def test_decodes_form_credentials_without_retaining_fields_or_values(self):
        report = inspect(b'password=unrecognized-secret&contact=person%40example.test', [("Content-Type", "application/x-www-form-urlencoded")], "/")
        self.assertEqual({f["kind"] for f in report["findings"]}, {"credential field", "email address"})
        self.assertNotIn("unrecognized-secret", json.dumps(report))
        self.assertNotIn("person", json.dumps(report))
        query = inspect(b"", [], "/?%74oken=encoded-fixture")
        self.assertEqual(query["findings"][0]["kind"], "credential query parameter")
        limited = inspect(b"a=b&" * 10001, [("Content-Type", "application/x-www-form-urlencoded")], "/")
        self.assertIn("structured-field scan truncated", limited["inspection"])


if __name__ == "__main__":
    unittest.main()
