"""Local, opt-in HTTP(S) observer. No system proxy or trust-store changes."""
import argparse
import asyncio
import hmac
import json
import os
from pathlib import Path
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from mitmproxy import http, options
from mitmproxy.tools.dump import DumpMaster
from inspection import Journal


class Observer:
    def __init__(self, journal, on_ready=None):
        self.journal = journal
        self.on_ready = on_ready

    def running(self):
        if self.on_ready:
            self.on_ready()

    def tls_failed_client(self, data):
        address = data.context.server.address
        host = address[0] if address else "unknown"
        self.journal.add(host, "TLS", b"", [], "", "not inspected; TLS handshake failed")

    def request(self, flow):
        request = flow.request
        blocked = self.journal.is_blocked(request.host)
        try:
            body = request.content or b""
            inspection_error = False
        except ValueError:
            body = request.raw_content or b""
            inspection_error = True
        flow.metadata["privacy_event"] = self.journal.add(
            request.host, request.method, body, list(request.headers.items()), request.path,
            "blocked" if blocked else "pending",
        )
        if inspection_error:
            self.journal.update(flow.metadata["privacy_event"], "not inspected; body decoding failed")
        flow.metadata["privacy_inspection_error"] = inspection_error
        flow.metadata["privacy_blocked"] = blocked
        if blocked:
            flow.response = http.Response.make(403, b"Blocked by the local privacy observer", {"content-type": "text/plain"})

    def response(self, flow):
        identifier = flow.metadata.get("privacy_event")
        if identifier and not flow.metadata.get("privacy_blocked") and not flow.metadata.get("privacy_inspection_error"):
            self.journal.update(identifier, f"response {flow.response.status_code}")

    def error(self, flow):
        identifier = flow.metadata.get("privacy_event")
        if identifier:
            self.journal.update(identifier, "error; delivery uncertain")
        else:
            self.journal.add(flow.request.host, flow.request.method, b"", [], "", "not inspected; connection error")

    def websocket_message(self, flow):
        message = flow.websocket.messages[-1]
        if message.from_client:
            blocked = self.journal.is_blocked(flow.request.host)
            self.journal.add(flow.request.host, "WS", message.content, [], "", "blocked" if blocked else "outbound WebSocket")
            if blocked:
                message.drop()


def dashboard(journal, token, port):
    page = Path(__file__).with_name("dashboard.html").read_bytes()
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_args):
            pass

        def send(self, status, body, kind="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; connect-src 'self'")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            expected = f"Bearer {token}"
            return hmac.compare_digest(self.headers.get("Authorization", ""), expected)

        def do_GET(self):
            if self.path == "/":
                self.send(200, page, "text/html; charset=utf-8")
            elif self.path == "/api/events" and self.authorized():
                self.send(200, json.dumps(journal.snapshot()).encode())
            else:
                self.send(401, b'{"error":"Unauthorized"}')

        def do_POST(self):
            if self.path != "/api/rules" or not self.authorized():
                self.send(401, b'{"error":"Unauthorized"}')
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 2048:
                    raise ValueError()
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError()
                journal.change(data["action"], data.get("host", ""))
                self.send(200, b'{"ok":true}')
            except (ValueError, TypeError, KeyError):
                self.send(400, b'{"error":"Invalid rule"}')

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    Thread(target=server.serve_forever, daemon=True).start()
    return server


async def run(args):
    directory = Path(args.state_dir).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    os.umask(0o077)
    journal = Journal(args.label)
    token = secrets.token_urlsafe(32)
    opts = options.Options(listen_host="127.0.0.1", listen_port=args.proxy_port, confdir=str(directory))
    master = DumpMaster(opts, with_termlog=False, with_dumper=False)
    master.options.update(connection_strategy="lazy")
    if args.upstream_ca:
        master.options.update(ssl_verify_upstream_trusted_ca=args.upstream_ca)
    server = dashboard(journal, token, args.dashboard_port)
    connection_file = directory / "observer.json"
    def ready():
        temporary = directory / f"observer-{secrets.token_hex(8)}.tmp"
        temporary.write_text(json.dumps({"port": server.server_port, "token": token}))
        temporary.chmod(0o600)
        temporary.replace(connection_file)
        print(json.dumps({"dashboard": f"http://127.0.0.1:{server.server_port}/#{token}",
                      "proxy": f"http://127.0.0.1:{args.proxy_port}",
                      "ca": str(directory / "mitmproxy-ca-cert.pem"), "connectionFile": str(connection_file), "label": args.label}), flush=True)
    master.addons.add(Observer(journal, ready))
    try:
        await master.run()
    finally:
        try:
            if json.loads(connection_file.read_text()).get("token") == token:
                connection_file.unlink()
        except (OSError, ValueError):
            pass
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", default="unattributed")
    parser.add_argument("--proxy-port", type=int, default=8899)
    parser.add_argument("--dashboard-port", type=int, default=8898)
    parser.add_argument("--state-dir", default=".t3-privacy")
    parser.add_argument("--upstream-ca", help="CA for a private upstream; upstream TLS verification stays enabled")
    asyncio.run(run(parser.parse_args()))
