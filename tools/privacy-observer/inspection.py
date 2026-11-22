"""Summarize outbound data without retaining payloads or matched secret values."""
import json
import re
from collections import deque
from threading import RLock
from time import time
from urllib.parse import unquote_plus

SCAN_LIMIT = 1024 * 1024
KNOWN_FIELDS = {"messages", "input", "prompt", "system", "tools", "model", "metadata", "contents", "events", "query", "projectId", "context"}
PATTERNS = {
    "email address": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "API token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b"),
    "database credentials": re.compile(r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s:/]+:[^\s@]+@", re.I),
    "credential assignment": re.compile(r"\b[A-Z_]*(?:PASSWORD|TOKEN|API_KEY|SECRET)\s*=\s*[\"']?[A-Za-z0-9][A-Za-z0-9_+/.=-]{7,}"),
}
SECRET_FIELD = re.compile(r"^(?:password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization)$", re.I)


def inspect(body, headers, path):
    findings = []
    fields = []
    text = body[:SCAN_LIMIT].decode("utf-8", errors="replace")
    try:
        decoded = json.loads(text)
        text = json.dumps(decoded, ensure_ascii=False)
    except (ValueError, RecursionError):
        pass
    for location, value in [("body", text), ("URL", unquote_plus(path[:SCAN_LIMIT]))]:
        for kind, pattern in PATTERNS.items():
            count = len(pattern.findall(value))
            if count:
                findings.append({"kind": kind, "location": location, "count": count, "expected": False})
    for name, value in headers:
        if name.lower() in {"authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"}:
            findings.append({"kind": "authentication material", "location": "header", "count": 1, "expected": True})
        else:
            for kind, pattern in PATTERNS.items():
                if pattern.search(value):
                    findings.append({"kind": kind, "location": "header", "count": 1, "expected": False})
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            fields = sorted(KNOWN_FIELDS.intersection(parsed))
        # Bound traversal as well as byte scanning; JSON may be deeply nested.
        pending, visited, count = [parsed], 0, 0
        while pending and visited < 10000:
            value = pending.pop()
            visited += 1
            if isinstance(value, dict):
                for key, item in value.items():
                    if SECRET_FIELD.fullmatch(key) and isinstance(item, str) and item and not item.startswith(("$", "op://")):
                        count += 1
                    elif isinstance(item, (dict, list)):
                        pending.append(item)
            elif isinstance(value, list):
                pending.extend(value[:10000])
        if count:
            findings.append({"kind": "credential field", "location": "body", "count": count, "expected": False})
    except (ValueError, RecursionError):
        pass
    # Query parameters are never retained, even if a detector does not recognize the value.
    if re.search(r"[?&](?:token|key|api_key|password|secret|access_token)=", path, re.I):
        findings.append({"kind": "credential query parameter", "location": "URL", "count": 1, "expected": False})
    return {"findings": findings, "fields": fields, "scanTruncated": len(body) > SCAN_LIMIT, "bodyBytes": len(body), "inspection": "binary/unknown; pattern scan only" if "\ufffd" in text or "\x00" in text else "text patterns"}


def category(host, fields):
    if host in {"ingest.t3.codes", "us.i.posthog.com", "api.axiom.co"} or host.endswith((".datadoghq.com", ".statsig.com", ".sentry.io")):
        return "telemetry (inferred)"
    if set(fields).intersection({"messages", "input", "prompt", "contents"}):
        return "conversation / inference (inferred)"
    return "unclassified"


class Journal:
    def __init__(self, label, capacity=2000):
        self.label = label
        self.events = deque(maxlen=capacity)
        self.blocked = set()
        self.lock = RLock()
        self.total = 0

    def add(self, host, method, body, headers, path, status="observed"):
        summary = inspect(body, headers, path)
        with self.lock:
            self.total += 1
            item = {"id": self.total, "time": time(), "source": self.label, "host": host,
                    "method": method, "status": status, "category": category(host, summary["fields"]), **summary}
            self.events.append(item)
            return item["id"]

    def update(self, identifier, status):
        with self.lock:
            for item in reversed(self.events):
                if item["id"] == identifier:
                    item["status"] = status
                    break

    def snapshot(self):
        with self.lock:
            return {"label": self.label, "events": list(self.events), "blocked": sorted(self.blocked), "observed": self.total,
                    "coverage": "Only requests routed through this proxy are visible. Direct traffic is unobserved. TLS inspection requires trusting this session's CA in the selected client. Payload detection is heuristic, not proof of safety. Source labels are operator-supplied; categories are inferred."}

    def change(self, action, host=""):
        if action not in {"block", "unblock", "clear"}:
            raise ValueError("Unknown action")
        if action != "clear" and (len(host) > 253 or not re.fullmatch(r"[A-Za-z0-9.-]+", host)):
            raise ValueError("Use an exact hostname")
        with self.lock:
            if action == "block":
                self.blocked.add(host.lower().rstrip("."))
            elif action == "unblock":
                self.blocked.discard(host.lower().rstrip("."))
            else:
                self.events.clear()

    def is_blocked(self, host):
        with self.lock:
            return host.lower().rstrip(".") in self.blocked
