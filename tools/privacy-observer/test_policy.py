import json
import sqlite3
from policy import counters
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from inspection import Journal


class PolicyTests(unittest.TestCase):
    def test_restart_expiry_conflict_and_masked_outcomes(self):
        with tempfile.TemporaryDirectory() as directory, patch('policy.time', return_value=100) as clock:
            path = Path(directory) / 'findings.sqlite'
            j = Journal('operator', findings_path=path)
            j.change('save-policy', 'saved.test')
            j.add('trial.test', 'POST', b'{"password":"secret-fixture"}', [], '/?token=secret-fixture', 'response 200')
            j.change('start-experiment', 'trial.test', duration_seconds=10)
            j.add('trial.test', 'POST', b'', [], '', 'blocked')
            j.close()
            j = Journal('operator', findings_path=path)
            self.assertTrue(j.is_blocked('saved.test'))
            self.assertTrue(j.is_blocked('trial.test'))
            clock.return_value = 111
            self.assertFalse(j.is_blocked('trial.test'))  # no dashboard read
            e = j.snapshot()['experiments'][0]
            self.assertEqual(e['baseline']['responses'], 1)
            self.assertEqual(e['blocked']['blocked'], 1)
            identifier = j.add('trial.test', 'GET', b'', [], '', 'pending')
            j.update(identifier, 'response 503')
            self.assertEqual(j.snapshot()['experiments'][0]['recovery']['responses'], 1)
            self.assertEqual(j.snapshot()['experiments'][0]['outcome'], 'unknown')
            j.change('finish-experiment', experiment_id=e['id'])
            j.change('start-experiment', 'other.test', duration_seconds=10)
            j.change('save-policy', 'other.test')
            clock.return_value = 122
            self.assertTrue(j.is_blocked('other.test'))
            j.close()
            self.assertNotIn(b'secret-fixture', Path(str(path) + '.policy').read_bytes())

    def test_validation_and_unavailable_storage(self):
        j = Journal('fixture')
        self.addCleanup(j.close)
        for host in ['https://x.test', '*.test', 'a..test', '-a.test', 'a.test:443', 'x@a.test', '.']:
            with self.assertRaises(ValueError):
                j.change('block', host)
        with self.assertRaises(ValueError):
            j.change('save-policy', 'a.test')
        self.assertEqual(j.snapshot()['policyStorage']['status'], 'ephemeral')
        with tempfile.TemporaryDirectory() as directory:
            j2 = Journal('fixture', findings_path=Path(directory) / 'missing' / 'db')
            self.addCleanup(j2.close)
            with self.assertRaises(ValueError):
                j2.change('start-experiment', 'a.test', duration_seconds=10)
            self.assertFalse(j2.is_blocked('a.test'))
            self.assertEqual(j2.snapshot()['policyStorage']['status'], 'unavailable')

    def test_failed_write_does_not_apply_and_expiry_still_releases(self):
        with tempfile.TemporaryDirectory() as directory, patch('policy.time', return_value=100) as clock:
            j = Journal('fixture', findings_path=Path(directory) / 'db')
            self.addCleanup(j.close)
            for duration in [0, 3601, True, 1.5, None]:
                with self.assertRaises(ValueError):
                    j.change('start-experiment', 'a.test', duration_seconds=duration)
            j.change('start-experiment', 'a.test', duration_seconds=10)
            with patch.object(j.policies, '_write', side_effect=OSError):
                with self.assertRaises(ValueError):
                    j.change('save-policy', 'b.test')
                self.assertFalse(j.is_blocked('b.test'))
                clock.return_value = 111
                self.assertFalse(j.is_blocked('a.test'))
                self.assertTrue(j.snapshot()['policyStorage']['persistenceError'])
            j.snapshot()
            j.close()
            restarted = Journal('fixture', findings_path=Path(directory) / 'db')
            self.addCleanup(restarted.close)
            self.assertFalse(restarted.is_blocked('a.test'))

    def test_restart_after_expiry_session_separation_and_early_rollback(self):
        with tempfile.TemporaryDirectory() as directory, patch('policy.time', return_value=100) as clock:
            path = Path(directory) / 'db'
            j = Journal('fixture', findings_path=path)
            j.change('block', 'session.test')
            j.change('save-policy', 'saved.test')
            j.change('unblock', 'saved.test')
            self.assertTrue(j.is_blocked('saved.test'))
            j.change('start-experiment', 'expired.test', duration_seconds=10)
            j.close()
            clock.return_value = 120
            j = Journal('fixture', findings_path=path)
            self.addCleanup(j.close)
            self.assertFalse(j.is_blocked('session.test'))
            self.assertFalse(j.is_blocked('expired.test'))
            self.assertTrue(j.is_blocked('saved.test'))
            j.change('start-experiment', 'early.test', duration_seconds=10)
            e = j.snapshot()['experiments'][-1]
            j.change('stop-experiment', experiment_id=e['id'])
            self.assertFalse(j.is_blocked('early.test'))
            j.change('block', 'early.test')
            j.change('finish-experiment', experiment_id=e['id'])
            self.assertTrue(j.is_blocked('early.test'))
            clock.return_value = 4000
            self.assertEqual(j.snapshot()['experiments'][0]['phase'], 'finished')
            j.change('remove-policy', 'saved.test')
            self.assertFalse(j.is_blocked('saved.test'))

    def test_lost_pending_outcomes_persist_incomplete_evidence(self):
        for action in ('evict', 'clear'):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'db'
                j = Journal('fixture', capacity=1, findings_path=path)
                j.change('start-experiment', 'trial.test', duration_seconds=60)
                experiment = j.snapshot()['experiments'][0]['id']
                j.change('stop-experiment', experiment_id=experiment)
                request = j.add('trial.test', 'GET', b'', [], '', 'pending')
                if action == 'evict':
                    j.add('other.test', 'GET', b'', [], '', 'response 200')
                else:
                    j.change('clear')
                j.update(request, 'response 200')
                e = j.snapshot()['experiments'][0]
                self.assertTrue(e['evidenceIncomplete'])
                self.assertEqual(e['recovery']['responses'], 0)
                j.change('finish-experiment', experiment_id=experiment)
                j.close()
                restarted = Journal('fixture', findings_path=path)
                self.assertTrue(restarted.snapshot()['experiments'][0]['evidenceIncomplete'])
                restarted.close()

    def test_transport_failures_count_as_errors(self):
        result = counters({'status': status} for status in (
            'not inspected; connection error', 'not inspected; TLS handshake failed', 'response 503'))
        self.assertEqual(result, dict(observed=3, blocked=0, responses=1, errors=2))

    def test_corrupt_state_is_unavailable_and_preserved(self):
        for malformed in [
            {'rules': [], 'experiments': [{'phase': 'blocked'}]},
            {'rules': [{'host': 'bad.test'}], 'experiments': []},
            {'rules': [], 'experiments': None},
        ]:
            with self.subTest(malformed=malformed), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'db'
                with sqlite3.connect(str(path) + '.policy') as db:
                    db.execute('CREATE TABLE policy (id INTEGER PRIMARY KEY, data TEXT NOT NULL)')
                    original = json.dumps(malformed)
                    db.execute('INSERT INTO policy VALUES (1, ?)', (original,))
                j = Journal('fixture', findings_path=path)
                self.assertEqual(j.snapshot()['policyStorage'], dict(status='unavailable', persistenceError=True))
                with self.assertRaises(ValueError):
                    j.change('save-policy', 'new.test')
                j.close()
                with sqlite3.connect(str(path) + '.policy') as db:
                    self.assertEqual(db.execute('SELECT data FROM policy').fetchone()[0], original)
