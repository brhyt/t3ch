"""Bounded evidence of recurring findings; never stores request content."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from time import time

RETENTION_DAYS = 30
ISSUE_CAPACITY = 500


def outcome(status):
    if status == "blocked":
        return "blocked"
    if status.startswith("response "):
        return "response received; data sent"
    if "not inspected" in status:
        return "not inspected"
    if status.startswith("error"):
        return "error; delivery uncertain"
    if status == "outbound WebSocket":
        return "outbound WebSocket; delivery unconfirmed"
    return "delivery unconfirmed"


class Findings:
    def __init__(self, path=None, retention_days=RETENTION_DAYS, capacity=ISSUE_CAPACITY):
        self.retention_days = retention_days
        self.capacity = capacity
        self.persistent = False
        self.error = False
        try:
            if path:
                path = Path(path)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
                os.close(fd)
                path.chmod(0o600)
            self.db = sqlite3.connect(str(path) if path else ":memory:", check_same_thread=False)
            self.db.execute("PRAGMA secure_delete = ON")
            self.db.execute("""CREATE TABLE IF NOT EXISTS findings (
                id TEXT PRIMARY KEY, source TEXT NOT NULL, host TEXT NOT NULL,
                kind TEXT NOT NULL, location TEXT NOT NULL, first_seen REAL NOT NULL,
                last_seen REAL NOT NULL, occurrences INTEGER NOT NULL, blocked INTEGER NOT NULL,
                state TEXT NOT NULL, reviewed_at REAL, last_outcome TEXT NOT NULL
            )""")
            self.persistent = path is not None
        except (OSError, sqlite3.Error):
            # Losing audit storage must not break unrelated provider requests.
            self.error = True
            if hasattr(self, "db"):
                self.db.close()
            self.db = sqlite3.connect(":memory:", check_same_thread=False)
            self.db.execute("""CREATE TABLE findings (
                id TEXT PRIMARY KEY, source TEXT NOT NULL, host TEXT NOT NULL,
                kind TEXT NOT NULL, location TEXT NOT NULL, first_seen REAL NOT NULL,
                last_seen REAL NOT NULL, occurrences INTEGER NOT NULL, blocked INTEGER NOT NULL,
                state TEXT NOT NULL, reviewed_at REAL, last_outcome TEXT NOT NULL
            )""")

    def _prune(self, now):
        self.db.execute("DELETE FROM findings WHERE last_seen < ?", (now - self.retention_days * 86400,))
        self.db.execute("DELETE FROM findings WHERE id NOT IN (SELECT id FROM findings ORDER BY last_seen DESC, id LIMIT ?)", (self.capacity,))

    def add(self, source, host, kind, location, status, now=None):
        return self.add_many(source, host, [(kind, location)], status, now)[0]

    def add_many(self, source, host, kinds, status, now=None):
        now = time() if now is None else now
        identifiers = []
        try:
            with self.db:
                for kind, location in kinds:
                    identifier = hashlib.sha256(json.dumps([source, host, kind, location]).encode()).hexdigest()
                    identifiers.append(identifier)
                    self.db.execute("""INSERT INTO findings VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'open', NULL, ?)
                        ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen,
                        occurrences = occurrences + 1, blocked = blocked + excluded.blocked,
                        state = 'open', reviewed_at = NULL, last_outcome = excluded.last_outcome""",
                        (identifier, source, host, kind, location, now, now, int(status == "blocked"), outcome(status)))
                self._prune(now)
        except sqlite3.Error:
            self.error = True
        return identifiers

    def update(self, identifiers, status, event_time):
        try:
            with self.db:
                for identifier in identifiers:
                    self.db.execute("UPDATE findings SET last_outcome = ? WHERE id = ? AND last_seen = ?", (outcome(status), identifier, event_time))
        except sqlite3.Error:
            self.error = True

    def review(self, identifier, reviewed):
        try:
            with self.db:
                cursor = self.db.execute("UPDATE findings SET state = ?, reviewed_at = ? WHERE id = ?", ("reviewed" if reviewed else "open", time() if reviewed else None, identifier))
                if not cursor.rowcount:
                    raise ValueError("Unknown finding")
        except sqlite3.Error as error:
            self.error = True
            raise ValueError("Finding storage unavailable") from error

    def clear(self):
        try:
            with self.db:
                self.db.execute("DELETE FROM findings")
        except sqlite3.Error as error:
            self.error = True
            raise ValueError("Finding storage unavailable") from error

    def snapshot(self, now=None):
        try:
            with self.db:
                self._prune(time() if now is None else now)
                rows = self.db.execute("SELECT * FROM findings ORDER BY last_seen DESC, id").fetchall()
            keys = ("id", "source", "host", "kind", "location", "firstSeen", "lastSeen", "occurrences", "blocked", "state", "reviewedAt", "lastOutcome")
            return [dict(zip(keys, row)) for row in rows]
        except sqlite3.Error:
            self.error = True
            return []

    def close(self):
        self.db.close()
