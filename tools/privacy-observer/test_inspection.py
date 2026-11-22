import json
import unittest
from inspection import Journal, SCAN_LIMIT, inspect


class InspectionTests(unittest.TestCase):
    def test_never_retains_payload_or_secret_values(self):
        secret = "fixture-never-keep-this"
        body = json.dumps({"messages": [{"content": "owner@example.test postgres://user:fixture-pass@db.test/data"}], "password": secret}).encode()
        journal = Journal("codex test")
        self.addCleanup(journal.close)
        journal.add("api.example.test", "POST", body, [("Authorization", "Bearer private-fixture")], "/private?token=hidden-query")
        report = journal.snapshot()
        rendered = json.dumps(report)
        for forbidden in [secret, "owner@example.test", "fixture-pass", "private-fixture", "hidden-query", "/private"]:
            self.assertNotIn(forbidden, rendered)
        self.assertEqual(report["events"][0]["fields"], ["messages"])
        kinds = {f["kind"] for f in report["events"][0]["findings"]}
        self.assertTrue({"email address", "database credentials", "credential field", "authentication material", "credential query parameter"} <= kinds)

    def test_decodes_json_and_url_escaping(self):
        result = inspect(b'{"messages":"person\\u0040example.test"}', [], "/?contact=other%40example.test")
        self.assertEqual({f["location"] for f in result["findings"]}, {"body", "URL"})

    def test_caps_scanning_and_retention_and_keeps_rule_state_on_clear(self):
        result = inspect(b"x" * (SCAN_LIMIT + 5), [], "/")
        self.assertTrue(result["scanTruncated"])
        journal = Journal("test", capacity=2)
        self.addCleanup(journal.close)
        first = journal.add("a.test", "POST", b"", [], "/")
        journal.add("b.test", "POST", b"", [], "/")
        journal.add("c.test", "POST", b"", [], "/")
        self.assertEqual(len(journal.snapshot()["events"]), 2)
        journal.change("block", "A.TEST.")
        self.assertTrue(journal.is_blocked("a.test"))
        self.assertFalse(journal.is_blocked("sub.a.test"))
        journal.change("clear")
        newer = journal.add("d.test", "POST", b"", [], "/")
        self.assertNotEqual(first, newer)
        journal.update(first, "response 200")
        self.assertEqual(journal.snapshot()["events"][0]["status"], "observed")
        self.assertTrue(journal.is_blocked("a.test"))
        journal.change("unblock", "a.test")
        self.assertFalse(journal.is_blocked("a.test"))
        with self.assertRaises(ValueError):
            journal.change("block", "https://a.test/path")


if __name__ == "__main__":
    unittest.main()
