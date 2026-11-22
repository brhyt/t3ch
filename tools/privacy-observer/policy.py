"""Exact-host policy and masked experiments, serialized by the owning Journal lock."""
from copy import deepcopy
import json
import math
import os
from pathlib import Path
import re
import sqlite3
from time import time
from uuid import uuid4

ACTIONS = {'block', 'unblock', 'save-policy', 'remove-policy', 'start-experiment', 'stop-experiment', 'finish-experiment'}


def hostname(value):
    if not isinstance(value, str) or len(value) > 253:
        raise ValueError('Use an exact hostname')
    value = value.lower().removesuffix('.')
    if not value or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) for part in value.split('.')):
        raise ValueError('Use an exact hostname')
    return value


def counters(events=()):
    result = dict(observed=0, blocked=0, responses=0, errors=0)
    for event in events:
        result['observed'] += 1
        result['blocked'] += event['status'] == 'blocked'
        result['responses'] += event['status'].startswith('response ')
        result['errors'] += event['status'].startswith('error') or event['status'] in {
            'not inspected; connection error', 'not inspected; TLS handshake failed'}
    return result


def validate_state(data):
    def require(condition):
        if not condition:
            raise ValueError('Invalid policy state')

    def stamp(value):
        return type(value) in (int, float) and 0 <= value <= 1e15 and math.isfinite(value)

    def identity(item):
        require(isinstance(item, dict))
        require(isinstance(item.get('id'), str) and re.fullmatch('[a-f0-9]{32}', item['id']) is not None)
        require(hostname(item.get('host')) == item['host'])

    require(isinstance(data, dict) and set(data) == {'rules', 'experiments'})
    require(isinstance(data['rules'], list) and len(data['rules']) <= 256)
    require(isinstance(data['experiments'], list) and len(data['experiments']) <= 100)
    rules, experiments = {}, {}
    for rule in data['rules']:
        identity(rule)
        require(set(rule) == {'id', 'host', 'kind', 'createdAt', 'expiresAt'})
        require(rule['kind'] in ('saved', 'temporary') and stamp(rule['createdAt']))
        require(rule['expiresAt'] is None if rule['kind'] == 'saved' else
                stamp(rule['expiresAt']) and rule['expiresAt'] >= rule['createdAt'])
        require(rule['host'] not in rules)
        rules[rule['host']] = rule
    for e in data['experiments']:
        identity(e)
        require(set(e) == {'id', 'host', 'startedAt', 'expiresAt', 'recoveryAt', 'finishedAt', 'phase',
                          'baselineStartedAt', 'baselineEndedAt', 'evidenceIncomplete', 'baseline',
                          'blocked', 'recovery', 'outcome', 'evidence'})
        require(e['id'] not in experiments and e['phase'] in ('blocked', 'recovery', 'finished'))
        require(all(stamp(e[key]) for key in ('startedAt', 'expiresAt', 'baselineEndedAt')))
        require(e['expiresAt'] >= e['startedAt'])
        require(all(e[key] is None or stamp(e[key]) for key in ('recoveryAt', 'finishedAt', 'baselineStartedAt')))
        require((e['recoveryAt'] is None) == (e['phase'] == 'blocked'))
        require((e['finishedAt'] is not None) == (e['phase'] == 'finished'))
        require(type(e['evidenceIncomplete']) is bool and e['outcome'] == 'unknown' and
                e['evidence'] == 'bounded-proxy-observations')
        for phase in ('baseline', 'blocked', 'recovery'):
            counts = e[phase]
            require(isinstance(counts, dict) and set(counts) == {'observed', 'blocked', 'responses', 'errors'})
            require(all(type(value) is int and value >= 0 for value in counts.values()))
            require(sum(counts[key] for key in ('blocked', 'responses', 'errors')) <= counts['observed'])
        experiments[e['id']] = e
    for rule in rules.values():
        if rule['kind'] == 'temporary':
            e = experiments.get(rule['id'])
            require(e is not None and e['phase'] == 'blocked' and e['host'] == rule['host'] and
                    e['expiresAt'] == rule['expiresAt'])
    for e in experiments.values():
        if e['phase'] == 'blocked':
            rule = rules.get(e['host'])
            require(rule is not None and rule['kind'] == 'temporary' and rule['id'] == e['id'])
    return rules, list(experiments.values())


class Policies:
    def __init__(self, path=None):
        self.rules = {}
        self.experiments = []
        self.error = False
        self.dirty = False
        self.status = 'ephemeral' if path is None else 'unavailable'
        self.db = None
        if path is not None:
            try:
                path = Path(str(path) + '.policy')
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
                os.close(fd)
                path.chmod(0o600)
                self.db = sqlite3.connect(path, check_same_thread=False)
                self.db.execute('CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
                row = self.db.execute('SELECT data FROM policy WHERE id=1').fetchone()
                if row:
                    data = json.loads(row[0])
                    self.rules, self.experiments = validate_state(data)
                    for e in self.experiments:
                        if e['phase'] != 'finished':
                            e['evidenceIncomplete'] = True
                            self.dirty = True
                self.status = 'ready'
            except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
                self.error = True
                self.rules = {}
                self.experiments = []
                self.dirty = False
                if self.db:
                    self.db.close()
                    self.db = None
        self.expire()

    def _write(self):
        if self.status != 'ready':
            raise OSError('Policy storage unavailable')
        data = {'rules': [r for r in self.rules.values() if r['kind'] != 'session'], 'experiments': self.experiments}
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO policy VALUES (1, ?)', (json.dumps(data),))

    def flush(self, required=False):
        try:
            self._write()
            self.error = False
            self.dirty = False
        except (OSError, sqlite3.Error) as error:
            self.error = True
            self.dirty = True
            for e in self.experiments:
                if e['phase'] != 'finished':
                    e['evidenceIncomplete'] = True
            if required:
                raise ValueError('Policy storage unavailable') from error

    def _recover(self, experiment, now):
        rule = self.rules.get(experiment['host'])
        if rule and rule['id'] == experiment['id']:
            del self.rules[experiment['host']]
        experiment['phase'] = 'recovery'
        experiment['recoveryAt'] = now

    def expire(self):
        now = time()
        for e in self.experiments:
            if e['phase'] == 'blocked' and e['expiresAt'] <= now:
                self._recover(e, e['expiresAt'])
                self.dirty = True
            if e['phase'] == 'recovery' and e['recoveryAt'] + 3600 <= now:
                e.update(phase='finished', finishedAt=e['recoveryAt'] + 3600)
                self.dirty = True
        if self.dirty:
            self.flush()

    def change(self, action, host, duration, identifier, events):
        self.expire()
        now = time()
        if action in {'stop-experiment', 'finish-experiment'}:
            if not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{32}', identifier):
                raise ValueError('Invalid experiment')
            if not any(e['id'] == identifier for e in self.experiments):
                raise ValueError('Unknown experiment')
        else:
            host = hostname(host)
        if action == 'start-experiment':
            if type(duration) is not int or not 1 <= duration <= 3600 or host in self.rules:
                raise ValueError('Invalid duration or host already blocked')
            if len(self.experiments) >= 100 or any(e['host'] == host and e['phase'] != 'finished' for e in self.experiments):
                raise ValueError('Experiment capacity or active experiment')
        if action in {'block', 'save-policy', 'start-experiment'} and host not in self.rules and len(self.rules) >= 256:
            raise ValueError('Rule capacity')
        previous = deepcopy((self.rules, self.experiments))
        if action in {'block', 'save-policy', 'start-experiment'}:
            if action == 'block' and self.rules.get(host, {}).get('kind') == 'saved':
                raise ValueError('Remove saved policy explicitly')
            identifier = uuid4().hex
            self.rules[host] = dict(id=identifier, host=host, kind={'block': 'session', 'save-policy': 'saved', 'start-experiment': 'temporary'}[action], createdAt=now, expiresAt=now + duration if action == 'start-experiment' else None)
            if action == 'start-experiment':
                self.experiments.append(dict(id=identifier, host=host, startedAt=now, expiresAt=now + duration, recoveryAt=None, finishedAt=None, phase='blocked', baselineStartedAt=next((e['time'] for e in events if e['host'] == host), None), baselineEndedAt=now, evidenceIncomplete=False, baseline=counters(e for e in events if e['host'] == host), blocked=counters(), recovery=counters(), outcome='unknown', evidence='bounded-proxy-observations'))
        elif action in {'unblock', 'remove-policy'}:
            rule = self.rules.get(host)
            if rule and (rule['kind'] == 'saved') == (action == 'remove-policy'):
                del self.rules[host]
        else:
            e = next(e for e in self.experiments if e['id'] == identifier)
            if e['phase'] == 'blocked':
                self._recover(e, now)
            if action == 'finish-experiment' and e['phase'] != 'finished':
                e.update(phase='finished', finishedAt=now)
        # A manual edit ends the block phase without letting rollback undo that edit.
        for e in self.experiments:
            if e['phase'] == 'blocked' and self.rules.get(e['host'], {}).get('id') != e['id']:
                self._recover(e, now)
        durable = action != 'block' and action != 'unblock' or previous[1] != self.experiments
        if durable:
            try:
                self.flush(required=True)
            except ValueError:
                self.rules, self.experiments = previous
                raise

    def record(self, host, status):
        self.expire()
        refs = []
        for e in self.experiments:
            if e['host'] == host and e['phase'] != 'finished':
                phase = e['phase']
                counts = counters([{'status': status}])
                for key, value in counts.items():
                    e[phase][key] += value
                refs.append((e['id'], phase))
        if refs:
            self.flush()
        return refs

    def lose_outcomes(self, refs):
        identifiers = {identifier for identifier, _phase in refs}
        changed = False
        for e in self.experiments:
            if e['id'] in identifiers and not e['evidenceIncomplete']:
                e['evidenceIncomplete'] = True
                changed = True
        if changed:
            self.flush()

    def update(self, refs, old, status):
        before, after = counters([{'status': old}]), counters([{'status': status}])
        for identifier, phase in refs:
            e = next((e for e in self.experiments if e['id'] == identifier), None)
            if e:
                for key in before:
                    e[phase][key] += after[key] - before[key]
        if refs:
            self.flush()

    def snapshot(self):
        self.expire()
        return deepcopy(dict(policyStorage=dict(status=self.status, persistenceError=self.error), rules=list(self.rules.values()), experiments=self.experiments))

    def close(self):
        if self.db:
            self.db.close()
            self.db = None
