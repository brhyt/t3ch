"""Ephemeral issued-route associations; never process identity or authorization."""
import base64
import hashlib
import re
import secrets
from threading import RLock
from time import time

class Launches:
    def __init__(self, clock=time):
        self.clock = clock
        self.entries = {}
        self.lock = RLock()

    def change(self, data):
        with self.lock:
            self.entries = {k: v for k, v in self.entries.items() if v[0] > self.clock()}
            if data.get("action") == "revoke":
                self.entries = {k: v for k, v in self.entries.items() if v[1]["launchId"] != data.get("launchId")}
                return {"ok": True}
            if data.get("action") != "register" or len(self.entries) >= 1024:
                raise ValueError("invalid launch")
            context = {}
            for key in ("providerInstanceId", "initiatingThreadId"):
                value = data.get(key)
                if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value):
                    raise ValueError("invalid launch")
                context[key] = value
            context.update(evidence="launch-linked", component="codex-app-server", launchId=secrets.token_hex(16), workflow="unknown")
            credential = secrets.token_urlsafe(32)
            self.entries[hashlib.sha256(credential.encode()).hexdigest()] = (self.clock() + 3600, context)
            return {"credential": credential, "launchId": context["launchId"]}

    def route_key(self, header):
        try:
            scheme, encoded = header.split(" ", 1)
            user, credential = base64.b64decode(encoded, validate=True).decode().split(":", 1)
            if scheme.lower() == "basic" and user == "t3-launch":
                return hashlib.sha256(credential.encode()).hexdigest()
        except (ValueError, UnicodeError):
            pass
        return ""

    def resolve(self, header):
        return self.resolve_key(self.route_key(header))

    def resolve_key(self, key):
        with self.lock:
            entry = self.entries.get(key)
            if entry and entry[0] > self.clock():
                return dict(entry[1])
        return {"evidence": "unknown", "workflow": "unknown"}
