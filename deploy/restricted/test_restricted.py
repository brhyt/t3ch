"""Opt-in integration proof. Creates and removes only its own Docker Compose project."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

from run import docker_command

ROOT = Path(__file__).resolve().parent
PROBE = r'''
import json,os,pathlib,socket,subprocess
for key in list(os.environ):
 if 'proxy' in key.lower(): del os.environ[key]
assert os.getuid() == 1000
status=pathlib.Path('/proc/self/status').read_text()
for name in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']:
 assert int(next(line.split()[1] for line in status.splitlines() if line.startswith(name+':')),16)==0,name
assert 'NoNewPrivs:\t1' in status
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path('/run/docker.sock').exists()
assert not pathlib.Path(os.environ['HOST_SENTINEL']).exists()
assert pathlib.Path('/workspace/fixture.txt').read_text() == 'project-only'
pathlib.Path('/state/home/sandbox-proof').write_text('isolated state')
try:
 pathlib.Path('/usr/local/bin/sandbox-proof').write_text('forbidden')
 raise AssertionError('Root filesystem is writable')
except OSError: pass
assert subprocess.run(['iptables','-F','OUTPUT'],capture_output=True).returncode != 0
for host,port in [('1.1.1.1',443),('172.30.247.1',443),('172.30.247.2',443),('127.0.0.11',53),('2606:4700:4700::1111',443)]:
 try:
  socket.create_connection((host,port),timeout=1).close()
  raise AssertionError('Direct bypass succeeded: '+host)
 except OSError: pass
query=b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01'
for host in ['127.0.0.11','1.1.1.1']:
 with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
  sock.settimeout(1)
  try:
   sock.sendto(query,(host,53));sock.recv(4096)
   raise AssertionError('Direct DNS bypass succeeded: '+host)
  except OSError: pass
proxy='http://172.30.247.2:3128'
def curl(url):
 return subprocess.run(['curl','--silent','--show-error','--max-time','20','--proxy',proxy,'--output','/dev/null','--write-out','%{http_connect}',url],capture_output=True,text=True)
allowed=curl('https://example.com')
assert allowed.returncode==0 and allowed.stdout=='200',(allowed.returncode,allowed.stdout,allowed.stderr)
for url in ['https://example.org','https://localhost','https://127.0.0.1','https://169.254.169.254','https://example.com:444']:
 result=curl(url)
 assert result.stdout=='403',(url,result.stdout,result.stderr)
plain=subprocess.run(['curl','--silent','--max-time','5','--proxy',proxy,'--output','/dev/null','--write-out','%{http_code}','http://example.com'],capture_output=True,text=True)
assert plain.stdout=='403'
child=subprocess.run(['curl','--silent','--noproxy','*','--connect-timeout','1','--max-time','2','https://1.1.1.1'],capture_output=True)
assert child.returncode!=0
tools=pathlib.Path('/state/home/.local/bin');tools.mkdir(parents=True,exist_ok=True)
for name in ['iptables','ip6tables','mkdir','chown','setpriv']:
 tool=tools/name;tool.write_text('#!/bin/sh\n/usr/bin/id -u > /state/bootstrap-path-executed\nexit 88\n');tool.chmod(0o755)
print(json.dumps({'uid':os.getuid(),'capabilities':'all zero','hostFiles':'unavailable','rootFilesystem':'read-only','allowedHttps':'verified TLS, CONNECT 200','forbiddenHttps':'CONNECT 403','privateDestinations':'CONNECT 403','plainHttp':'403','directIpv4Ipv6AndDns':'denied','childWithoutProxyEnv':'denied'}))
'''


class RestrictedTests(unittest.TestCase):
    def test_enforced_isolation_and_empty_allowlist(self):
        project = 't3-isolation-test-' + uuid.uuid4().hex[:12]
        with tempfile.TemporaryDirectory(prefix='t3-isolation-') as temporary:
            root = Path(temporary)
            workspace = root / 'workspace'
            workspace.mkdir()
            (workspace / 'fixture.txt').write_text('project-only')
            sentinel = root / 'host-only-secret'
            sentinel.write_text('synthetic-host-only-fixture')
            allowlist = root / 'allowlist.txt'
            allowlist.write_text('example.com\nlocalhost\n127.0.0.1\n169.254.169.254\n')
            env = {**os.environ, 'T3_RESTRICTED_WORKSPACE': str(workspace), 'T3_RESTRICTED_ALLOWLIST': str(allowlist)}
            base = [*docker_command(os.environ.get('T3_RESTRICTED_DOCKER_CONTEXT')), 'compose', '-p', project, '-f', str(ROOT / 'compose.yaml')]
            def compose(*args, check=True):
                result = subprocess.run([*base, *args], env=env, capture_output=True, text=True, timeout=180)
                if check and result.returncode:
                    self.fail(result.stdout + result.stderr)
                return result
            try:
                compose('build', 'proxy')
                compose('up', '-d', '--wait', 'proxy')
                result = compose('run', '--rm', '-T', '-e', 'HOST_SENTINEL=' + str(sentinel), 'runner', 'python3', '-c', PROBE)
                print(result.stdout.strip())
                allowlist.write_text('')
                compose('up', '-d', '--force-recreate', '--wait', 'proxy')
                result = compose('run', '--rm', '-T', 'runner', 'curl', '--silent', '--max-time', '10', '--proxy', 'http://172.30.247.2:3128', '--output', '/dev/null', '--write-out', '%{http_connect}', 'https://example.com', check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout.strip(), '403')
                compose('run', '--rm', '-T', 'runner', '/usr/bin/test', '!', '-e', '/state/bootstrap-path-executed')
                print('Empty allowlist: CONNECT 403; bootstrap ignores agent-writable PATH')
            finally:
                compose('down', '--volumes', '--remove-orphans')


if __name__ == '__main__':
    unittest.main()
