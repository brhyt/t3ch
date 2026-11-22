"""Summarize outbound data without retaining payloads or matched secret values."""
import json
import re
from collections import deque
from threading import RLock
from time import time
from urllib.parse import unquote_plus, parse_qsl

from findings import Findings, RETENTION_DAYS

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
    structure_truncated = False
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
        structure_truncated = bool(pending)
        if count:
            findings.append({"kind": "credential field", "location": "body", "count": count, "expected": False})
    except (ValueError, RecursionError):
        pass
    if any(name.lower() == "content-type" and "application/x-www-form-urlencoded" in value.lower() for name, value in headers):
        try:
            pairs = parse_qsl(text, max_num_fields=10000)
            count = sum(bool(value) and bool(SECRET_FIELD.fullmatch(key)) for key, value in pairs)
            if count:
                findings.append({"kind": "credential field", "location": "body", "count": count, "expected": False})
            for kind, pattern in PATTERNS.items():
                count = sum(len(pattern.findall(value)) for _key, value in pairs)
                if count and not any(f["kind"] == kind and f["location"] == "body" for f in findings):
                    findings.append({"kind": kind, "location": "body", "count": count, "expected": False})
        except ValueError:
            structure_truncated = True
    # Query parameters are never retained, even if a detector does not recognize the value.
    if re.search(r"[?&](?:token|key|api_key|password|secret|access_token)=", unquote_plus(path[:SCAN_LIMIT]), re.I):
        findings.append({"kind": "credential query parameter", "location": "URL", "count": 1, "expected": False})
    return {"findings": findings, "fields": fields, "scanTruncated": len(body) > SCAN_LIMIT, "bodyBytes": len(body), "inspection": ("binary/unknown; pattern scan only" if "\ufffd" in text or "\x00" in text else "text patterns") + ("; structured-field scan truncated" if structure_truncated else "")}


def category(host, fields):
    if host in {"ingest.t3.codes", "us.i.posthog.com", "api.axiom.co"} or host.endswith((".datadoghq.com", ".statsig.com", ".sentry.io")):
        return "telemetry (inferred)"
    if set(fields).intersection({"messages", "input", "prompt", "contents"}):
        return "conversation / inference (inferred)"
    return "unclassified"


class Journal:
    def __init__(self, label, capacity=2000, findings_path=None, retention_days=RETENTION_DAYS):
        self.label = label[:128]
        self.events = deque(maxlen=capacity)
        self.blocked = set()
        self.lock = RLock()
        self.total = 0
        self.started_at = time()
        self.last_observed_at = None
        self.issues = Findings(findings_path, retention_days)
        self.event_issues = {}

    def _track(self, item, kinds):
        identifiers = self.event_issues.setdefault(item["id"], set())
        if kinds:
            identifiers.update(self.issues.add_many(self.label, item["host"], sorted(kinds), item["status"], item["time"]))

    def add(self, host, method, body, headers, path, status="observed"):
        summary = inspect(body, headers, path)
        host = host.lower().rstrip(".")[:253]
        with self.lock:
            self.total += 1
            self.last_observed_at = time()
            item = {"id": self.total, "time": self.last_observed_at, "source": self.label, "host": host,
                    "method": method, "status": status, "category": category(host, summary["fields"]), **summary}
            if len(self.events) == self.events.maxlen:
                self.event_issues.pop(self.events[0]["id"], None)
            self.events.append(item)
            kinds = {(finding["kind"], finding["location"]) for finding in summary["findings"] if not finding["expected"]}
            if summary["scanTruncated"]:
                kinds.add(("inspection truncated", "coverage"))
            if "structured-field scan truncated" in summary["inspection"]:
                kinds.add(("structured-field scan truncated", "coverage"))
            if summary["inspection"].startswith("binary"):
                kinds.add(("binary content; detection limited", "coverage"))
            if "not inspected" in status:
                kinds.add(("inspection failed", "coverage"))
            self._track(item, kinds)
            return item["id"]

    def update(self, identifier, status):
        with self.lock:
            for item in reversed(self.events):
                if item["id"] == identifier:
                    new_gap = "not inspected" in status and "not inspected" not in item["status"]
                    item["status"] = status
                    if new_gap:
                        self._track(item, {("inspection failed", "coverage")})
                    self.issues.update(self.event_issues.get(identifier, ()), status, item["time"])
                    break

    def inspection_failed(self, identifier):
        with self.lock:
            for item in reversed(self.events):
                if item["id"] == identifier:
                    item["inspection"] = "not inspected; body decoding failed"
                    self._track(item, {("inspection failed", "coverage")})
                    break

    def snapshot(self):
        with self.lock:
            issues = self.issues.snapshot()
            return {"label": self.label, "events": list(self.events), "blocked": sorted(self.blocked), "observed": self.total,
                    "issues": issues,
                    "tracking": {"sessionStartedAt": self.started_at, "lastObservedAt": self.last_observed_at,
                                 "observedThisSession": self.total, "directTraffic": "unknown",
                                 "retentionDays": self.issues.retention_days,
                                 "persistent": self.issues.persistent, "persistenceError": self.issues.error},
                    "coverage": "Only requests routed through this proxy are visible. Direct traffic is unobserved. TLS inspection requires trusting this session's CA in the selected client. Payload detection is heuristic, not proof of safety. Source labels are operator-supplied; categories are inferred. Reviewed findings are not verified fixes; recurrence reopens them."}

    def change(self, action, host="", finding_id=""):
        if action not in {"block", "unblock", "clear", "review-finding", "reopen-finding", "clear-findings"}:
            raise ValueError("Unknown action")
        if action in {"block", "unblock"} and (not isinstance(host, str) or len(host) > 253 or not re.fullmatch(r"[A-Za-z0-9.-]+", host)):
            raise ValueError("Use an exact hostname")
        if action in {"review-finding", "reopen-finding"} and (not isinstance(finding_id, str) or not re.fullmatch(r"[a-f0-9]{64}", finding_id)):
            raise ValueError("Use a finding identifier")
        with self.lock:
            if action == "block":
                self.blocked.add(host.lower().rstrip("."))
            elif action == "unblock":
                self.blocked.discard(host.lower().rstrip("."))
            elif action == "clear":
                self.events.clear()
                self.event_issues.clear()
            elif action == "clear-findings":
                self.issues.clear()
            else:
                self.issues.review(finding_id, action == "review-finding")

    def is_blocked(self, host):
        with self.lock:
            return host.lower().rstrip(".") in self.blocked

    def close(self):
        with self.lock:
            self.issues.close()
