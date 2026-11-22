import json
import unittest
import urllib.error
import urllib.request
from mitmproxy.test import tflow
from inspection import Journal
from observer import Observer, dashboard


class ObserverTests(unittest.TestCase):
    def test_blocks_before_forwarding_and_unblocks_without_rewriting_old_outcomes(self):
        journal = Journal("test")
        self.addCleanup(journal.close)
        addon = Observer(journal)
        flow = tflow.tflow()
        journal.change("block", flow.request.host)
        addon.request(flow)
        self.assertEqual(flow.response.status_code, 403)
        journal.change("unblock", flow.request.host)
        addon.response(flow)
        self.assertEqual(journal.snapshot()["events"][0]["status"], "blocked")
        allowed = tflow.tflow()
        addon.request(allowed)
        self.assertIsNone(allowed.response)
        journal.change("block", allowed.request.host)
        allowed.response = tflow.tresp()
        addon.response(allowed)
        self.assertEqual(journal.snapshot()["events"][-1]["status"], "response 200")

    def test_reports_unsupported_encoding_without_claiming_inspection(self):
        journal = Journal("test")
        self.addCleanup(journal.close)
        addon = Observer(journal)
        flow = tflow.tflow()
        flow.request.headers["content-encoding"] = "gzip"
        flow.request.raw_content = b"not a gzip stream"
        addon.request(flow)
        self.assertIn("not inspected", journal.snapshot()["events"][0]["inspection"])
        flow.response = tflow.tresp()
        addon.response(flow)
        self.assertIn("not inspected", journal.snapshot()["events"][0]["inspection"])

        self.assertEqual(journal.snapshot()["events"][0]["status"], "response 200")

    def test_blocked_decode_failure_preserves_both_coverage_and_block_evidence(self):
        journal = Journal("test")
        self.addCleanup(journal.close)
        addon = Observer(journal)
        flow = tflow.tflow()
        flow.request.headers["content-encoding"] = "gzip"
        flow.request.raw_content = b"not a gzip stream"
        journal.change("block", flow.request.host)
        addon.request(flow)
        addon.response(flow)
        report = journal.snapshot()
        self.assertEqual(flow.response.status_code, 403)
        gap = next(issue for issue in report["issues"] if issue["kind"] == "inspection failed")
        self.assertEqual(gap["blocked"], 1)
        self.assertEqual(gap["lastOutcome"], "blocked")
        self.assertEqual(report["events"][0]["status"], "blocked")
        self.assertIn("not inspected", report["events"][0]["inspection"])

    def test_connection_error_before_request_is_recorded_as_uninspected(self):
        journal = Journal("test")
        self.addCleanup(journal.close)
        flow = tflow.tflow()
        flow.request = None
        flow.server_conn.address = ("unreachable.test", 443)
        Observer(journal).error(flow)
        report = journal.snapshot()
        self.assertEqual(report["events"][0]["host"], "unreachable.test")
        self.assertIn("not inspected", report["events"][0]["status"])
        self.assertEqual(report["issues"][0]["kind"], "inspection failed")

    def test_websocket_block_drops_client_message(self):
        journal = Journal("test")
        self.addCleanup(journal.close)
        addon = Observer(journal)
        flow = tflow.twebsocketflow()
        message = flow.websocket.messages[-1]
        message.from_client = True
        journal.change("block", flow.request.host)
        addon.websocket_message(flow)
        self.assertTrue(message.dropped)
        self.assertEqual(journal.snapshot()["events"][-1]["status"], "blocked")

    def test_dashboard_requires_token_for_data_and_mutations(self):
        journal = Journal("test")
        self.addCleanup(journal.close)
        server = dashboard(journal, "fixture-token", 0)
        base = f"http://127.0.0.1:{server.server_port}"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def request(path, body=None, token=None):
            return opener.open(urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={} if token is None else {"Authorization": "Bearer " + token}), timeout=5)
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                request("/api/events")
            self.assertEqual(error.exception.code, 401)
            with self.assertRaises(urllib.error.HTTPError):
                request("/api/rules", {"action": "block", "host": "api.test"}, "wrong")
            request("/api/rules", {"action": "block", "host": "api.test"}, "fixture-token").close()
            self.assertTrue(journal.is_blocked("api.test"))
            with request("/api/events", token="fixture-token") as response:
                self.assertEqual(json.load(response)["blocked"], ["api.test"])
                self.assertEqual(response.headers["Cache-Control"], "no-store")
            with self.assertRaises(urllib.error.HTTPError):
                request("/api/rules", [], "fixture-token")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
