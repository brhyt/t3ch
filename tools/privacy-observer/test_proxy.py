"""A real HTTPS request, inspection, block, and unblock against a synthetic local service."""
import json
import os
from pathlib import Path
import select
import socket
import ssl
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread


class ProxyTests(unittest.TestCase):
    def test_https_inspection_and_blocking_without_system_trust_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cert, key = root / "upstream.pem", root / "upstream.key"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            received = []
            proxy_headers = []
            class Upstream(BaseHTTPRequestHandler):
                def log_message(self, *_args): pass
                def do_POST(self):
                    proxy_headers.append(self.headers.get("proxy-authorization"))
                    received.append(self.rfile.read(int(self.headers["Content-Length"])))
                    self.send_response(200)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"ok")
            upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            upstream.socket = context.wrap_socket(upstream.socket, server_side=True)
            Thread(target=upstream.serve_forever, daemon=True).start()
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                proxy_port = sock.getsockname()[1]
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("observer.py")), "--proxy-port", str(proxy_port), "--dashboard-port", "0", "--state-dir", str(root / "state"), "--upstream-ca", str(cert), "--label", "synthetic test"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                if not select.select([process.stdout], [], [], 20)[0]:
                    self.fail("Observer did not become ready")
                startup = json.loads(process.stdout.readline())
                dashboard, token = startup["dashboard"].split("#")
                descriptor = Path(startup["connectionFile"])
                self.assertEqual(json.loads(descriptor.read_text()), {"port": int(dashboard.split(":")[-1].split("/")[0]), "token": token, "proxyPort": proxy_port})
                self.assertEqual(descriptor.stat().st_mode & 0o777, 0o600)
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                def api(path, body=None):
                    request = urllib.request.Request(dashboard.rstrip("/") + path, data=None if body is None else json.dumps(body).encode(), headers={"Authorization": "Bearer " + token})
                    with opener.open(request, timeout=5) as response:
                        return json.load(response)
                lease = api("/api/launches", dict(action="register", providerInstanceId="codex-fixture", initiatingThreadId="thread-fixture"))
                proxy = startup["proxy"].replace("http://", "http://t3-launch:" + lease["credential"] + "@")
                def send():
                    return subprocess.run(["curl", "--silent", "--show-error", "--max-time", "8", "--noproxy", "", "--proxy", proxy, "--cacert", startup["ca"], "-H", "Content-Type: application/json", "--data", '{"messages":[{"content":"person@example.test"}],"password":"synthetic-secret-value"}', "--write-out", "%{http_code}", f"https://localhost:{upstream.server_port}/private?token=synthetic-query"], capture_output=True, text=True, check=True).stdout
                self.assertEqual(send(), "ok200")
                report = api("/api/events")
                self.assertEqual(report["events"][0]["status"], "response 200")
                self.assertEqual(report["events"][0]["launchAttribution"]["launchId"], lease["launchId"])
                self.assertNotIn(lease["credential"], json.dumps(report))
                self.assertNotIn("synthetic-secret-value", json.dumps(report))
                self.assertTrue(report["events"][0]["findings"])
                api("/api/rules", {"action": "block", "host": "localhost"})
                self.assertTrue(send().endswith("403"))
                self.assertEqual(len(received), 1)
                api("/api/rules", {"action": "unblock", "host": "localhost"})
                self.assertEqual(send(), "ok200")
                self.assertEqual(len(received), 2)
                self.assertEqual(proxy_headers, [None, None])
                report = api("/api/events")
                self.assertTrue(report["tracking"]["persistent"])
                self.assertEqual(report["tracking"]["observedThisSession"], 3)
                self.assertEqual(report["tracking"]["directTraffic"], "unknown")
                self.assertTrue(all(issue["occurrences"] == 3 and issue["blocked"] == 1 for issue in report["issues"]))
                identifier = report["issues"][0]["id"]
                api("/api/rules", {"action": "review-finding", "findingId": identifier})
                self.assertEqual(next(issue["state"] for issue in api("/api/events")["issues"] if issue["id"] == identifier), "reviewed")
                stored = (root / "state" / "findings.sqlite").read_bytes()
                for value in (b"synthetic-secret-value", b"synthetic-query", b"person@example.test", b"/private"):
                    self.assertNotIn(value, stored)
            finally:
                process.terminate()
                process.communicate(timeout=10)
                upstream.shutdown()
                upstream.server_close()


if __name__ == "__main__":
    unittest.main()
