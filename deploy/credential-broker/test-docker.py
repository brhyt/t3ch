#!/usr/bin/env python3
"""Disposable synthetic test. Docker host/controller is trusted; workload is not."""
import json
from datetime import datetime, timezone
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent
PREFIX = 'broker-test-' + uuid.uuid4().hex[:12]
IMAGE = PREFIX + ':test'
containers, networks = [], []
secret = 'synthetic-' + secrets.token_hex(32)
transcript = []

def docker(*args, stdin=None):
    p = subprocess.run(['docker', *args], input=stdin, text=True, capture_output=True, timeout=90)
    transcript.append(p.stdout + p.stderr)
    if p.returncode:
        raise RuntimeError('Docker command failed: ' + args[0] + ': ' + p.stderr.replace(secret, '[REDACTED]'))
    return p.stdout.strip()

def check(value, label):
    if not value:
        raise RuntimeError('FAIL: ' + label)
    print('PASS: ' + label, flush=True)

def js(container, code):
    return docker('exec', '-i', container, 'node', '--input-type=module', stdin=code)

def request(container, url, value=None, headers=None, method='POST'):
    code = "const r = await fetch(" + json.dumps(url) + ',' + json.dumps({
        'method': method, 'headers': headers or {},
        **({'body': json.dumps(value)} if value is not None else {})}) + ",); console.log(JSON.stringify({status:r.status, body:await r.json(), headers:Object.fromEntries(r.headers)}));"
    return json.loads(js(container, code))

def ready(container, since=None):
    # Wait for a startup event, rather than repeated health checks.
    p = subprocess.Popen(['docker', 'logs', '--follow', *(['--since', since] if since else []), container], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        import select
        if not select.select([p.stdout], [], [], 15)[0] or p.stdout.readline().strip() != 'ready':
            raise RuntimeError('Container startup failed')
    finally:
        p.terminate()
        p.wait(timeout=5)

def create(name, network, command, mounts=(), env=()):
    container = PREFIX + '-' + name
    args = ['create', '--name', container, '--network', network, '--network-alias', name,
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', '1000:1000',
            '--pids-limit', '64', '--memory', '128m', '--cpus', '1', '--ulimit', 'core=0']
    for mount in mounts:
        args += ['--mount', mount]
    for item in env:
        args += ['-e', item]
    docker(*args, IMAGE, *command)
    containers.append(container)
    return container

try:
    docker('build', '--quiet', '-t', IMAGE, str(ROOT))
    disabled = subprocess.run(['docker', 'run', '--rm', '--network', 'none', IMAGE], text=True, capture_output=True, timeout=30)
    transcript.append(disabled.stdout + disabled.stderr)
    check(disabled.returncode != 0 and disabled.stderr.strip() == 'broker startup failed', 'broker disabled without explicit synthetic opt-in')
    for suffix in ['work', 'upstream']:
        name = PREFIX + '-' + suffix
        docker('network', 'create', '--internal', name)
        networks.append(name)
    with tempfile.TemporaryDirectory(prefix=PREFIX + '-', dir=os.environ.get('TMPDIR')) as temp:
        credential = Path(temp) / 'synthetic'
        credential.write_text(secret)
        credential.chmod(0o444)  # Namespace separation, deliberately not same-user file secrecy.
        mount = f'type=bind,src={credential},dst=/run/credential,readonly'
        fixture = f'type=bind,src={ROOT / "fixture.mjs"},dst=/app/fixture.mjs,readonly'
        upstream = create('upstream', networks[1], ['node', '/app/fixture.mjs'], [mount, fixture])
        broker = create('broker', networks[0], ['node', '/app/broker.mjs'], [mount], ['BROKER_SYNTHETIC_ONLY=1'])
        docker('network', 'connect', networks[1], broker)
        workload = create('workload', networks[0], ['node', '-e', 'setInterval(()=>{}, 100000)'])
        for c in [upstream, broker, workload]:
            docker('start', c)
        ready(upstream)
        ready(broker)
        def issue(ttl=30000):
            r = request(broker, 'http://127.0.0.1:8081/leases', {'scope': 'fixture.ping', 'ttlMs': ttl})
            if r['status'] != 201:
                raise RuntimeError('Issuance failed')
            return r['body']['token']
        def operate(token, **kw):
            return request(workload, 'http://broker:8080/operate', {'scope': 'fixture.ping', 'lease': token}, **kw)
        def stats(mode='ok'):
            return request(upstream, 'http://127.0.0.1:8081/' + mode)['body']
        token = issue()
        check(operate(token)['body'] == {'ok': True} and stats()['accepted'] == 1, 'authorized operation injects exact synthetic credential')
        check(operate(token)['status'] == 403, 'single-use replay denied')
        check(operate('0' * 64)['status'] == 403, 'unknown lease denied')
        token = issue()
        check(request(workload, 'http://broker:8080/operate', {'scope': 'other', 'lease': token})['status'] == 400, 'wrong scope denied')
        check(request(broker, 'http://127.0.0.1:8081/leases', {'scope': 'other', 'ttlMs': 1000})['status'] == 400, 'controller cannot grant other scope')
        check(request(broker, 'http://127.0.0.1:8081/leases', {'scope': 'fixture.ping', 'ttlMs': 30001})['status'] == 400, 'TTL cap enforced')
        expired = issue(1)
        check(operate(expired)['status'] == 403, 'expired lease denied across container exec boundary')
        revoked = issue()
        request(broker, 'http://127.0.0.1:8081/revoke', {'token': revoked})
        check(operate(revoked)['status'] == 403, 'revoked lease denied')
        for field, value in [('url', 'http://upstream:8080/trap'), ('path', '/trap'), ('method', 'GET'), ('command', 'cat /run/credential'), ('headers', {'authorization': 'bypass'})]:
            check(request(workload, 'http://broker:8080/operate', {'scope': 'fixture.ping', 'lease': token, field: value})['status'] == 400, 'caller-controlled ' + field + ' rejected')
        check(operate(token, headers={'Authorization': 'Bearer bypass'})['status'] == 400, 'authorization passthrough rejected')
        check(operate(token, headers={'Proxy-Authorization': 'Bearer bypass'})['status'] == 400, 'proxy authorization passthrough rejected')
        for path in ['/operate?url=http://upstream/trap', '/fixture/ping', '/leases', '/revoke']:
            check(request(workload, 'http://broker:8080' + path, {})['status'] == 404, 'workload route restricted: ' + path)
        check(request(workload, 'http://broker:8080/operate', method='GET')['status'] == 404, 'wrong HTTP method rejected')
        concurrent = issue()
        statuses = json.loads(js(workload, "console.log(JSON.stringify(await Promise.all([1,2].map(async()=>{ const r=await fetch('http://broker:8080/operate',{method:'POST',body:JSON.stringify(" + json.dumps({'scope': 'fixture.ping', 'lease': concurrent}) + ")}); return r.status; }))));"))
        check(sorted(statuses) == [200, 403], 'concurrent replay permits only one operation')
        stats('redirect')
        redirect = issue()
        check(operate(redirect)['status'] == 502 and stats('redirect')['trapped'] == 0, 'redirect refused without contacting redirect target')
        check(operate(redirect)['status'] == 403, 'failed operation still consumes lease')
        stats('reflect')
        reflected = operate(issue())
        check(reflected['body'] == {'error': 'operation failed'} and 'x-secret' not in reflected['headers'], 'upstream secret-bearing body and headers discarded')
        upstream_ip = json.loads(docker('inspect', upstream))[0]['NetworkSettings']['Networks'][networks[1]]['IPAddress']
        blocked_ip = js(workload, "try { await fetch('http://" + upstream_ip + ":8080/fixture/ping', {signal:AbortSignal.timeout(1000)}); console.log('reachable'); } catch { console.log('blocked'); }")
        check(blocked_ip == 'blocked', 'workload cannot reach upstream by direct IP')
        isolation = js(workload, """
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
for (const p of ['/run/credential','/var/run/docker.sock','/run/docker.sock','/proc/1/root/run/credential']) {
  if (fs.existsSync(p)) throw new Error('isolation failure');
}
if (spawnSync('mount',['-t','tmpfs','tmpfs','/mnt']).status === 0) throw new Error('mount allowed');
for (const url of ['http://broker:8081/leases','http://upstream:8080/fixture/ping']) {
  let reachable = false;
  try { await fetch(url, {signal: AbortSignal.timeout(1000)}); reachable = true; } catch {}
  if (reachable) throw new Error('network reachable');
}
console.log('isolated');
""")
        check(isolation == 'isolated', 'workload cannot read credential, mount filesystem, reach admin or upstream, or access engine socket')
        state = json.loads(docker('inspect', workload))[0]
        check(state['Mounts'] == [] and state['HostConfig']['CapDrop'] == ['ALL'] and state['HostConfig']['ReadonlyRootfs'], 'workload has no shared mounts and runs without capabilities')
        check(all(json.loads(docker('network', 'inspect', n))[0]['Internal'] for n in networks), 'both fixture networks are internal')
        since = datetime.now(timezone.utc).isoformat()
        docker('restart', '-t', '1', broker)
        ready(broker, since)
        check(operate(token)['status'] == 403, 'broker restart invalidates outstanding leases')
        docker('stop', '-t', '1', upstream)
        check(operate(issue())['body'] == {'error': 'operation failed'}, 'upstream network failure is sanitized')
        for c in containers:
            docker('logs', c)
        check(all(secret not in text for text in transcript), 'responses, Docker output and container logs contain no synthetic credential')
        print('ALL TESTS PASSED', flush=True)
finally:
    for c in reversed(containers):
        docker('rm', '-f', c)
    for n in reversed(networks):
        docker('network', 'rm', n)
    docker('image', 'rm', IMAGE)
