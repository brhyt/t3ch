"""Explicit real T3 adapter proof. No host authentication or external network."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import select
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
image = subprocess.check_output(['docker','--context','default','image','inspect','t3-restricted-codex:0.171.0','--format','{{.Id}}'],text=True).strip()
with tempfile.TemporaryDirectory(prefix='t3-adapter-proof-') as directory:
    root=Path(directory)
    workspace=root/'project'
    workspace.mkdir()
    allowlist=root/'allowlist'
    allowlist.write_text('')
    config=root/'config.json'
    config.write_text(json.dumps(dict(workspace=str(workspace),context='default',image=image,allowlist=str(allowlist),state='adapter-proof')))
    # Reuse the synthetic Responses fixture, never real paid generation.
    tree=ast.parse((ROOT/'test_codex.py').read_text())
    fixture=next(node.args[0].value for node in ast.walk(tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='write_text' and node.args and isinstance(node.args[0],ast.Constant) and isinstance(node.args[0].value,str) and 'class Handler' in node.args[0].value)
    (workspace/'fixture.py').write_text(fixture)
    binary=root/'codex'
    log=root/'launcher.log'
    binary.write_text('#!/bin/sh\nexec '+shlex.quote(str(ROOT/'codex.py'))+' --config '+shlex.quote(str(config))+' "$@" 2>>'+shlex.quote(str(log))+'\n')
    binary.chmod(0o755)
    endpoint=json.loads(subprocess.check_output(['docker','--context','default','context','inspect','default']))[0]['Endpoints']['docker']['Host']
    identity=[str(workspace),workspace.stat().st_dev,workspace.stat().st_ino,'default',endpoint,image,'adapter-proof','']
    volume='t3-codex-'+hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:24]
    cleanup_needed=False
    try:
        result=subprocess.run(['node',str(REPO/'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.restricted-proof.ts')],cwd=REPO,env={**os.environ,'RESTRICTED_PROOF_WORKSPACE':str(workspace),'RESTRICTED_PROOF_BINARY':str(binary),'T3CODE_HOME':str(root/'t3')})
        print('adapter_exit',result.returncode,flush=True)
        if os.environ.get('RESTRICTED_PROOF_KILL_SCOPE') != '1': assert 'This Codex instance is bound to a different workspace.' in log.read_text(), 'missing workspace rejection diagnostic'
        for line in (log.read_text() if log.exists() else '').splitlines():
            if any(word in line for word in ['Restricted Codex:', 'outside', 'error:', 'unexpected']): print(line)
    finally:
        # Await only this fixture's external owners, using kernel process death.
        for unit in set(re.findall(r'Restricted cleanup owner: (\S+)', log.read_text() if log.exists() else '')):
            owner = subprocess.run(['systemctl', '--user', 'show', unit, '-p', 'MainPID', '--value'], capture_output=True, text=True)
            if owner.stdout.strip() not in ('', '0'):
                try:
                    descriptor = os.pidfd_open(int(owner.stdout))
                except ProcessLookupError:
                    pass
                else:
                    try:
                        assert select.select([descriptor], [], [], 60)[0], 'cleanup owner did not exit'
                    finally:
                        os.close(descriptor)
            assert not (Path(tempfile.gettempdir()) / unit.removesuffix('.service')).exists(), 'owner scratch remains'
        # Only projects captured from this test launcher; never global prune.
        projects=set(re.findall(r'Network (t3-codex-[a-f0-9]{16})_',log.read_text() if log.exists() else ''))
        for project in projects:
            containers=subprocess.check_output(['docker','--context','default','ps','-aq','--filter','label=com.docker.compose.project='+project],text=True).split()
            if containers:
                subprocess.run(['docker','--context','default','rm','-f',*containers],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                cleanup_needed=True
                print('forced_test_cleanup',project,flush=True)
            remaining=subprocess.check_output(['docker','--context','default','ps','-q','--filter','label=com.docker.compose.project='+project],text=True).strip()
            assert not remaining, 'running test containers remain'
        for project in projects:
            networks=subprocess.check_output(['docker','--context','default','network','ls','-q','--filter','label=com.docker.compose.project='+project],text=True).split()
            if networks:
                cleanup_needed=True
                subprocess.run(['docker','--context','default','network','rm',*networks],check=True,stdout=subprocess.DEVNULL)
        if subprocess.run(['docker','--context','default','volume','inspect',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0:
            subprocess.run(['docker','--context','default','volume','rm',volume],check=True,stdout=subprocess.DEVNULL)
    assert not cleanup_needed, "launcher left test resources requiring forced cleanup"
    print("cleanup_verified",flush=True)
    raise SystemExit(result.returncode)
