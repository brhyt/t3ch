"""Summarize outbound data without retaining payloads or matched secret values."""
import json
import hashlib
import marshal
import sys
import re
from collections import deque
from threading import RLock
from time import time
from urllib.parse import unquote_plus, parse_qsl

from attribution import Launches
from findings import Findings, RETENTION_DAYS
from policy import Policies, ACTIONS

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
            findings.append({"kind": "authentication material", "location": "header", "count": 1, "expected": False, "context": "authentication-shaped", "valuePresence": "present" if value else "empty", "valueType": "string"})
        else:
            for kind, pattern in PATTERNS.items():
                if pattern.search(value):
                    findings.append({"kind": kind, "location": "header", "count": 1, "expected": False})
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            fields = sorted(KNOWN_FIELDS.intersection(parsed))
        # Bound traversal as well as byte scanning; JSON may be deeply nested.
        pending, visited, matches = [(parsed, False)], 0, {}
        while pending and visited < 10000:
            value, schema = pending.pop()
            visited += 1
            if isinstance(value, dict):
                schema = schema or (value.get("type") == "object" and isinstance(value.get("properties"), dict)) or isinstance(value.get("$schema"), str)
                for key, item in value.items():
                    if SECRET_FIELD.fullmatch(key) and isinstance(item, str) and item and not item.startswith(("$", "op://")):
                        context = "schema" if schema else "unknown"
                        matches[context] = matches.get(context, 0) + 1
                    elif isinstance(item, (dict, list)):
                        pending.append((item, schema))
            elif isinstance(value, list):
                pending.extend((item, schema) for item in value[:10000])
        structure_truncated = bool(pending)
        for context, count in matches.items():
            findings.append({"kind": "credential field", "location": "body", "count": count, "expected": False, "context": context, "valuePresence": "present", "valueType": "string"})
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
    try:
        query = path[:SCAN_LIMIT].partition("?")[2]
        for key, value in parse_qsl(query, keep_blank_values=True, max_num_fields=10000):
            if key.lower() in {"token", "key", "api_key", "password", "secret", "access_token"}:
                findings.append({"kind": "credential query parameter", "location": "URL", "count": 1, "expected": False, "valuePresence": "present" if value else "empty", "valueType": "string"})
    except ValueError:
        structure_truncated = True
    for finding in findings:
        finding.setdefault("context", "unknown")
        finding.setdefault("valuePresence", "unknown")
        finding.setdefault("valueType", "unknown")
        finding["destinationExpectation"] = "unknown"
        finding["detectorId"] = "heuristic." + finding["kind"].replace(" ", "-").lower() + ".v1"
    return {"findings": findings, "fields": fields, "scanTruncated": len(body) > SCAN_LIMIT, "bodyBytes": len(body), "inspection": ("binary/unknown; pattern scan only" if "\ufffd" in text or "\x00" in text else "text patterns") + ("; structured-field scan truncated" if structure_truncated else "")}


def category(host, fields):
    if host in {"ingest.t3.codes", "us.i.posthog.com", "api.axiom.co"} or host.endswith((".datadoghq.com", ".statsig.com", ".sentry.io")):
        return "telemetry (inferred)"
    if set(fields).intersection({"messages", "input", "prompt", "contents"}):
        return "conversation / inference (inferred)"
    return "unclassified"


class Journal:
    def __init__(self, label, capacity=2000, findings_path=None, retention_days=RETENTION_DAYS):
        # Version 0 omits reference-sharing flags that differ between script and import loading.
        digest = hashlib.sha256()
        for name in ('inspection', 'policy', 'findings', 'observer', 'attribution'):
            module = sys.modules.get(name)
            if name == 'observer' and module is None:
                candidate = sys.modules.get('__main__')
                if str(getattr(candidate, '__file__', '')).endswith('/observer.py'):
                    module = candidate
            if module is not None:
                for key, value in sorted(vars(module).items()):
                    code = getattr(value, '__code__', None)
                    if code is not None:
                        digest.update(marshal.dumps(code, 0))
                    if isinstance(value, type) and value.__module__ == module.__name__:
                        for method in vars(value).values():
                            code = getattr(method, '__code__', None)
                            if code is not None:
                                digest.update(marshal.dumps(code, 0))
        self.component = dict(name='privacy-observer', version=digest.hexdigest(), identityKind='loaded-python-code-sha256')
        self.launches = Launches()
        self.label = label[:128]
        self.events = deque(maxlen=capacity)
        self.policies = Policies(findings_path)
        self.event_experiments = {}
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

    def add(self, host, method, body, headers, path, status="observed", attribution=None):
        summary = inspect(body, headers, path)
        host = host.lower().rstrip(".")[:253]
        with self.lock:
            self.total += 1
            self.last_observed_at = time()
            item = {"id": self.total, "time": self.last_observed_at, "source": self.label, "host": host,
                    "launchAttribution": attribution or {"evidence": "unknown", "workflow": "unknown"},
                    "stages": {"inspection": "not-observed" if "not inspected" in status else "performed", "forwarding": "blocked" if status == "blocked" else "unknown", **({"handshake": "failed"} if method == "TLS" else {}), **({"connection": "failed"} if "connection error" in status else {})},
                    "method": method, "status": status, "category": category(host, summary["fields"]), **summary}
            if len(self.events) == self.events.maxlen:
                self._discard_outcomes((self.events[0],))
                self.event_issues.pop(self.events[0]["id"], None)
                self.event_experiments.pop(self.events[0]["id"], None)
            self.events.append(item)
            self.event_experiments[item["id"]] = self.policies.record(host, status)
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

    def _discard_outcomes(self, events):
        self.policies.lose_outcomes([
            ref for event in events if event["status"] == "pending"
            for ref in self.event_experiments.get(event["id"], ())
        ])

    def update(self, identifier, status):
        with self.lock:
            for item in reversed(self.events):
                if item["id"] == identifier:
                    new_gap = "not inspected" in status and "not inspected" not in item["status"]
                    self.policies.update(self.event_experiments.get(identifier, []), item["status"], status)
                    item["status"] = status
                    item["stages"]["forwarding"] = "response-observed" if status.startswith("response ") else "error-delivery-unknown" if status.startswith("error") else "unknown"
                    if new_gap:
                        self._track(item, {("inspection failed", "coverage")})
                    self.issues.update(self.event_issues.get(identifier, ()), status, item["time"])
                    break

    def inspection_failed(self, identifier):
        with self.lock:
            for item in reversed(self.events):
                if item["id"] == identifier:
                    item["stages"]["inspection"] = "failed"
                    item["inspection"] = "not inspected; body decoding failed"
                    self._track(item, {("inspection failed", "coverage")})
                    break

    def snapshot(self):
        with self.lock:
            issues = self.issues.snapshot()
            policy = self.policies.snapshot()
            generated_at = time()
            return {"supportedActions": sorted(ACTIONS | {"block", "unblock", "clear", "review-finding", "reopen-finding", "clear-findings"}), "label": self.label, "events": list(self.events), "blocked": sorted(self.policies.rules), **policy, "attribution": {"kind": "operator-supplied", "source": self.label, "impactScope": "shared-proxy-unknown"}, "observed": self.total,
                    "issues": issues,
                    "generatedAt": generated_at, "component": self.component,
                    "observationWindow": dict(startedAt=self.started_at, endedAt=generated_at, retainedEvents=len(self.events), capacity=self.events.maxlen, truncated=self.total > len(self.events)),
                    "retention": dict(events="Bounded memory ring; clear or restart removes events.", findings=f"At most {self.issues.capacity} findings; rolling {self.issues.retention_days}-day inactivity expiry from lastSeen, pruned on access. Recurring firstSeen and counts can predate this window.", experiments="Independent durable records; no automatic deletion. Delete finished experiments explicitly. No secure-erasure guarantee."),
                    "tracking": {"sessionStartedAt": self.started_at, "lastObservedAt": self.last_observed_at,
                                 "observedThisSession": self.total, "directTraffic": "unknown",
                                 "retentionDays": self.issues.retention_days,
                                 "persistent": self.issues.persistent, "persistenceError": self.issues.error},
                    "coverage": "Only requests routed through this proxy are visible. Direct traffic is unobserved. TLS inspection requires trusting this session's CA in the selected client. Payload detection is heuristic, not proof of safety. Source labels are operator-supplied; categories are inferred. Reviewed findings are not verified fixes; recurrence reopens them."}

    def change(self, action, host="", finding_id="", duration_seconds=None, experiment_id="", metadata=None, outcome=None):
        if action in ACTIONS:
            with self.lock:
                return self.policies.change(action, host, duration_seconds, experiment_id, self.events, metadata, outcome, self.total > len(self.events))
        if action not in {"block", "unblock", "clear", "review-finding", "reopen-finding", "clear-findings"}:
            raise ValueError("Unknown action")
        if action in {"block", "unblock"} and (not isinstance(host, str) or len(host) > 253 or not re.fullmatch(r"[A-Za-z0-9.-]+", host)):
            raise ValueError("Use an exact hostname")
        if action in {"review-finding", "reopen-finding"} and (not isinstance(finding_id, str) or not re.fullmatch(r"[a-f0-9]{64}", finding_id)):
            raise ValueError("Use a finding identifier")
        with self.lock:
            if action == "clear":
                self._discard_outcomes(self.events)
                self.events.clear()
                self.event_issues.clear()
                self.event_experiments.clear()
            elif action == "clear-findings":
                self.issues.clear()
            else:
                self.issues.review(finding_id, action == "review-finding")

    def is_blocked(self, host):
        with self.lock:
            self.policies.expire()
            return host.lower().rstrip(".") in self.policies.rules

    def close(self):
        with self.lock:
            self.issues.close()
            self.policies.close()
