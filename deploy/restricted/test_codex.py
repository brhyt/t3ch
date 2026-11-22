"""Real pinned Codex protocol and Docker lifecycle proof; explicitly invoked only."""
import hashlib
import contextlib
import sys
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import tempfile
import unittest

import codex

ROOT = Path(__file__).resolve().parent


class CodexTests(unittest.TestCase):
    def test_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / 'project'
            project.mkdir()
            self.assertEqual(codex.workspace_path(str(project)), project)
            codex.validate_frame({'params': {'cwd': str(project)}}, project)
            with self.assertRaises(ValueError):
                codex.validate_frame({'params': {'cwd': str(root)}}, project)
            (project / 'escape').symlink_to(root)
            with self.assertRaises(ValueError):
                codex.workspace_path(str(project))

    def test_real_cli(self):
        image = subprocess.check_output(['docker', '--context', 'default', 'image', 'inspect', 't3-restricted-codex:0.171.0', '--format', '{{.Id}}'], text=True).strip()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / 'project'
            workspace.mkdir()
            allowlist = root / 'allowlist'
            allowlist.write_text('')
            config = root / 'config.json'
            settings = dict(workspace=str(workspace), context='default', image=image, allowlist=str(allowlist), state='test')
            config.write_text(json.dumps(settings))
            endpoint = json.loads(subprocess.check_output(['docker', '--context', 'default', 'context', 'inspect', 'default']))[0]['Endpoints']['docker']['Host']
            identity = [str(workspace), workspace.stat().st_dev, workspace.stat().st_ino, 'default', endpoint, image, 'test', '']
            volume = 't3-codex-' + hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:24]
            (workspace / 'fixture.py').write_text("""
import http.server,json
class Handler(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length','0')))
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  item={'id':'msg_fixture','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'fixture response','annotations':[]}]}
  events=[{'type':'response.created','response':{'id':'resp_fixture','status':'in_progress','output':[]}},
   {'type':'response.output_item.added','output_index':0,'item':dict(item,status='in_progress',content=[])},
   {'type':'response.output_text.delta','item_id':'msg_fixture','output_index':0,'content_index':0,'delta':'fixture response'},
   {'type':'response.output_item.done','output_index':0,'item':item},
   {'type':'response.completed','response':{'id':'resp_fixture','status':'completed','output':[item],'usage':{'input_tokens':1,'output_tokens':2,'total_tokens':3}}}]
  for event in events:self.wfile.write(('data: '+json.dumps(event)+'\\n\\n').encode());self.wfile.flush()
server=http.server.HTTPServer(('127.0.0.1',18888),Handler)
print('ready',flush=True)
server.serve_forever()
""")
            command = [str(ROOT / 'codex.py'), '--config', str(config)]
            def launch(*args):
                return subprocess.Popen([*command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            def assert_cleaned(log):
                for project in set(re.findall(r'Network (t3-codex-[a-f0-9]{16})_', log)):
                    for resource in ('container', 'network'):
                        remaining = subprocess.check_output(['docker', '--context', 'default', resource, 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project], text=True)
                        self.assertEqual(remaining.strip(), '', (project, resource))
            buffers = {}
            def read_frame(process):
                pending = buffers.get(process.pid, b'')
                while b'\n' not in pending:
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ)
                        self.assertTrue(selector.select(40), 'Timed out waiting for protocol response')
                    chunk = os.read(process.stdout.fileno(), 65536)
                    self.assertTrue(chunk, 'Protocol exited early')
                    pending += chunk
                line, buffers[process.pid] = pending.split(b'\n', 1)
                return json.loads(line)
            def request(process, ident, method, params):
                process.stdin.write(json.dumps(dict(id=ident, method=method, params=params)) + '\n')
                process.stdin.flush()
                while True:
                    frame = read_frame(process)
                    if frame.get('id') == ident:
                        return frame
            try:
                with contextlib.nullcontext(sys.stderr) as errors:
                    version = subprocess.run([*command, '--version'], capture_output=True, text=True, timeout=60)
                    self.assertEqual(version.returncode, 0, version.stderr)
                    self.assertEqual(version.stdout.strip(), 'codex-cli 0.171.0')
                    for mode in ('startupcancel', 'startupkill', 'normal', 'cancel', 'kill', 'mismatch'):
                        process = launch('app-server')
                        try:
                            if mode.startswith('startup'):
                                log = ''
                                while ' Waiting ' not in log:
                                    line = process.stderr.readline()
                                    self.assertTrue(line, 'Startup exited before readiness wait')
                                    log += line
                                process.send_signal(signal.SIGTERM if mode == 'startupcancel' else signal.SIGKILL)
                                self.assertEqual(process.wait(timeout=40), 143 if mode == 'startupcancel' else -9)
                                log += process.stderr.read()
                                assert_cleaned(log)
                                process.stderr.close()
                                continue
                            initialized = request(process, 1, 'initialize', {'clientInfo': {'name': 't3-code-test', 'version': '0.1.0'}, 'capabilities': {'experimentalApi': True}})
                            self.assertIn('result', initialized)
                            self.assertIn('result', request(process, 2, 'account/read', {}))
                            self.assertIn('result', request(process, 3, 'model/list', {}))
                            self.assertIn('result', request(process, 30, 'skills/list', {'cwds': [str(root)]}))
                            if mode == 'cancel':
                                resumed = request(process, 8, 'thread/resume', {'threadId': thread_id, 'cwd': str(workspace), 'config': {'model_providers.fixture': {'name': 'fixture', 'base_url': 'http://127.0.0.1:18888/v1', 'wire_api': 'responses', 'requires_openai_auth': False}}})
                                self.assertIn('result', resumed, resumed)
                            if mode == 'normal':
                                result = request(process, 4, 'command/exec', {'command': ['sh', '-c', 'printf isolated > proof.txt; cat proof.txt; test ! -e /var/run/docker.sock; test ! -e /home/grr/.ssh'], 'cwd': str(workspace), 'sandboxPolicy': {'type': 'dangerFullAccess'}})
                                self.assertEqual(result['result']['exitCode'], 0, result)
                                self.assertEqual((workspace / 'proof.txt').read_text(), 'isolated')
                                process.stdin.write(json.dumps({'id': 5, 'method': 'command/exec', 'params': {'command': ['python3', 'fixture.py'], 'cwd': str(workspace), 'sandboxPolicy': {'type': 'dangerFullAccess'}, 'processId': 'fixture', 'streamStdoutStderr': True, 'timeoutMs': 60000}}) + '\n')
                                process.stdin.flush()
                                while True:
                                    ready = read_frame(process)
                                    if ready.get('method') == 'command/exec/outputDelta':
                                        break
                                    self.assertNotEqual(ready.get('id'), 5, ready)
                                thread = request(process, 6, 'thread/start', {'cwd': str(workspace), 'approvalPolicy': 'never', 'model': 'fixture', 'modelProvider': 'fixture', 'config': {'model_providers.fixture': {'name': 'fixture', 'base_url': 'http://127.0.0.1:18888/v1', 'wire_api': 'responses', 'requires_openai_auth': False}}})
                                self.assertIn('result', thread, thread)
                                thread_id = thread['result']['thread']['id']
                                turn = request(process, 7, 'turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'Say hello.'}]})
                                self.assertIn('result', turn, turn)
                                while True:
                                    frame = read_frame(process)
                                    if frame.get('method') == 'turn/completed':
                                        self.assertEqual(frame['params']['turn']['status'], 'completed', frame)
                                        break
                                request(process, 9, 'command/exec/terminate', {'processId': 'fixture'})
                                process.stdin.close()
                            elif mode == 'mismatch':
                                process.stdin.write(json.dumps({'id': 4, 'method': 'thread/start', 'params': {'cwd': str(root)}}) + '\n')
                                process.stdin.flush()
                            else:
                                process.send_signal(signal.SIGTERM if mode == 'cancel' else signal.SIGKILL)
                            code = process.wait(timeout=40)
                            log = process.stderr.read()
                            print(log, file=sys.stderr)
                            process.stderr.close()
                            assert_cleaned(log)
                            self.assertEqual(code, {'normal': 0, 'cancel': 143, 'kill': -9, 'mismatch': 1}[mode])
                        finally:
                            if process.poll() is None:
                                process.kill()
                                process.wait()
                            process.stdout.close()
                            if not process.stdin.closed:
                                try:
                                    process.stdin.close()
                                except BrokenPipeError:
                                    pass
                            if not process.stderr.closed:
                                print(process.stderr.read(), file=sys.stderr)
                                process.stderr.close()
                    settings['image'] = 'sha256:' + '0' * 64
                    config.write_text(json.dumps(settings))
                    failed = subprocess.run([*command, '--version'], capture_output=True, text=True, timeout=60)
                    self.assertNotEqual(failed.returncode, 0)
                    self.assertEqual(failed.stdout, '')
                    assert_cleaned(failed.stderr)
            finally:
                exists = subprocess.run(['docker', '--context', 'default', 'volume', 'inspect', volume], capture_output=True)
                if exists.returncode == 0:
                    subprocess.run(['docker', '--context', 'default', 'volume', 'rm', volume], check=True)


if __name__ == '__main__':
    unittest.main()
