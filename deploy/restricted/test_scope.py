"""Explicit scope-death regression, including creation completing after caller death."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
DOCKER = ['docker', '--context', 'default']


class ScopeTests(unittest.TestCase):
    def test_startup_scope_death_and_failed_owner(self):
        with tempfile.TemporaryDirectory(prefix='t3-scope-proof-') as temporary:
            root = Path(temporary)
            workspace = root / 'project'
            workspace.mkdir()
            (root / 'allowlist').touch()
            image = subprocess.check_output([*DOCKER, 'image', 'inspect', 't3-restricted-codex:0.171.0', '--format', '{{.Id}}'], text=True).strip()
            config = dict(workspace=str(workspace), context='default', image=image, allowlist=str(root / 'allowlist'), state='scope-proof')
            (root / 'config').write_text(json.dumps(config))
            for name in ('codex.py', 'supervisor.py', 'compose.yaml'):
                shutil.copy(ROOT / name, root / name)
            gate = root / 'gate'
            os.mkfifo(gate)
            source = (root / 'codex.py').read_text()
            # Hold an owned creation operation BEFORE it sends its daemon request.
            # Caller dies here; releasing the gate deliberately creates late resources.
            source = source.replace("            runner = project + '-runner'",
                "            print('creation_gate', file=sys.stderr, flush=True)\n            with open(" + repr(str(gate)) + ") as gate:\n                gate.read()\n            runner = project + '-runner'", 1)
            (root / 'codex.py').write_text(source)
            command = [str(root / 'codex.py'), '--config', str(root / 'config'), 'app-server']
            failed = subprocess.run(command, env={**os.environ, 'XDG_RUNTIME_DIR': str(root / 'missing')}, capture_output=True, text=True, timeout=20)
            self.assertNotEqual(failed.returncode, 0)
            self.assertNotIn('Network t3-codex-', failed.stderr)
            self.assertEqual(failed.stdout, '')
            unit = 't3-scope-proof-' + root.name + '.scope'
            process = subprocess.Popen(['systemd-run', '--user', '--scope', '--quiet', '--unit=' + unit, *command], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            log = ''
            forced = False
            try:
                while 'creation_gate\n' not in log:
                    line = process.stderr.readline()
                    self.assertTrue(line, log)
                    log += line
                subprocess.run(['systemctl', '--user', 'kill', '--signal=SIGKILL', '--kill-whom=all', unit], check=True)
                process.wait(timeout=10)
                with gate.open('w') as release:
                    release.write('continue')
                # Service owns stderr until cleanup completes; EOF synchronizes checks.
                log += process.stderr.read()
                self.assertIn('Restricted runner started:', log)
                print(log, flush=True)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                projects = set(re.findall(r'Network (t3-codex-[a-f0-9]{16})_', log))
                for project in projects:
                    for resource, remove in [('container', ['rm', '-f']), ('network', ['network', 'rm'])]:
                        ids = subprocess.check_output([*DOCKER, resource, 'ls', '-aq' if resource == 'container' else '-q', '--filter', 'label=com.docker.compose.project=' + project], text=True).split()
                        if ids:
                            forced = True
                            subprocess.run([*DOCKER, *remove, *ids], check=True)
                for volume in set(re.findall(r'Volume (t3-codex-[a-f0-9]+) Created', log)):
                    subprocess.run([*DOCKER, 'volume', 'inspect', volume], check=True, stdout=subprocess.DEVNULL)
                    subprocess.run([*DOCKER, 'volume', 'rm', volume], check=True)
                for owner in set(re.findall(r'Restricted cleanup owner: (\S+)', log)):
                    # Process stderr EOF means the service's worker and children exited.
                    pid = subprocess.run(['systemctl', '--user', 'show', owner, '-p', 'MainPID', '--value'], capture_output=True, text=True)
                    self.assertIn(pid.stdout.strip(), ('', '0'))
                for stream in (process.stdin, process.stdout, process.stderr):
                    stream.close()
            self.assertFalse(forced, 'Orphans detected before fixture cleanup')
            print('controlled_startup_scope_cleanup_verified; initialization_refused', flush=True)


if __name__ == '__main__':
    unittest.main()
