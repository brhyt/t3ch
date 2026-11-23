import base64
import json
import unittest
import tempfile
from pathlib import Path
from mitmproxy.test import tflow
from attribution import Launches
from inspection import Journal, inspect
from observer import Observer


def header(lease):
    return 'Basic ' + base64.b64encode(('t3-launch:' + lease['credential']).encode()).decode()

class AttributionTests(unittest.TestCase):
    def test_routes_expire_revoke_and_never_mix_launches(self):
        now = [100]
        launches = Launches(lambda: now[0])
        first = launches.change(dict(action='register', providerInstanceId='codex-a', initiatingThreadId='thread-a'))
        second = launches.change(dict(action='register', providerInstanceId='codex-b', initiatingThreadId='thread-b'))
        self.assertEqual(launches.resolve(header(first))['providerInstanceId'], 'codex-a')
        self.assertEqual(launches.resolve(header(second))['providerInstanceId'], 'codex-b')
        self.assertNotEqual(first['launchId'], second['launchId'])
        launches.change(dict(action='revoke', launchId=first['launchId']))
        self.assertEqual(launches.resolve(header(first))['evidence'], 'unknown')
        now[0] += 3601
        self.assertEqual(launches.resolve(header(second))['evidence'], 'unknown')
        self.assertEqual(launches.resolve('Basic garbage')['evidence'], 'unknown')

    def test_connect_and_http_issue_route_association_without_retaining_secrets(self):
        journal = Journal('operator assertion')
        self.addCleanup(journal.close)
        addon = Observer(journal)
        lease = journal.launches.change(dict(action='register', providerInstanceId='codex-a', initiatingThreadId='thread-a'))
        flow = tflow.tflow()
        flow.request.headers['proxy-authorization'] = header(lease)
        addon.http_connect(flow)
        self.assertNotIn('proxy-authorization', flow.request.headers)
        addon.request(flow)
        event = journal.snapshot()['events'][-1]
        self.assertEqual(event['launchAttribution']['launchId'], lease['launchId'])
        self.assertEqual(event['launchAttribution']['workflow'], 'unknown')
        self.assertNotIn(lease['credential'], json.dumps(journal.snapshot()))
        journal.launches.change(dict(action='revoke', launchId=lease['launchId']))
        addon.request(flow)
        self.assertEqual(journal.snapshot()['events'][-1]['launchAttribution']['evidence'], 'unknown')
        unknown = tflow.tflow()
        addon.request(unknown)
        self.assertEqual(journal.snapshot()['events'][-1]['launchAttribution']['evidence'], 'unknown')

    def test_context_is_structural_never_authorization_or_credential_validity(self):
        findings = inspect(b'{"type":"object","properties":{"password":"schema-description-fixture"}}', [('Authorization', 'secret-header-fixture')], '/private-path?key=&token=query-fixture')['findings']
        field = next(f for f in findings if f['kind'] == 'credential field')
        self.assertEqual(field['context'], 'schema')
        auth = next(f for f in findings if f['kind'] == 'authentication material')
        self.assertFalse(auth['expected'])
        self.assertEqual(auth['context'], 'authentication-shaped')
        self.assertEqual(auth['destinationExpectation'], 'unknown')
        self.assertEqual([f['valuePresence'] for f in findings if f['location'] == 'URL'], ['empty', 'present'])
        for secret in ['schema-description-fixture', 'secret-header-fixture', 'query-fixture', 'private-path', 'password']:
            self.assertNotIn(secret, json.dumps(findings))
        self.assertTrue(all(f['detectorId'].endswith('.v1') for f in findings))

    def test_advertised_new_actions_are_implemented(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        journal = Journal('test', findings_path=Path(folder.name) / 'findings.sqlite')
        self.addCleanup(journal.close)
        self.assertTrue({'experiment-metadata', 'experiment-outcome', 'delete-experiment'} <= set(journal.snapshot()['supportedActions']))
        journal.change('start-experiment', 'fixture.test', duration_seconds=60)
        identifier = journal.snapshot()['experiments'][0]['id']
        journal.change('experiment-metadata', experiment_id=identifier, metadata={'provenance': 'operator-asserted', 'provider': 'codex'})
        journal.change('experiment-outcome', experiment_id=identifier, outcome='partial')
        journal.change('finish-experiment', experiment_id=identifier)
        journal.change('delete-experiment', experiment_id=identifier)
        self.assertEqual(journal.snapshot()['experiments'], [])
