#!/usr/bin/env python3
"""Opt-in, single-workspace Codex binaryPath transport (Linux Docker only)."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import threading


def workspace_path(value):
    path = Path(value)
    if not path.is_absolute() or path != path.resolve(strict=True):
        raise ValueError('Workspace must be an absolute canonical path without symlinks.')
    if not path.is_dir() or len(path.parts) < 4 or path == Path.home():
        raise ValueError('Select a disposable project directory, not a system/home root.')
    if path.parts[1] not in ('home', 'tmp', 'srv', 'mnt', 'opt'):
        raise ValueError('Workspace must be below /home, /tmp, /srv, /mnt or /opt.')
    for root, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            item = Path(root) / name
            if item.is_symlink():
                if not item.resolve().is_relative_to(path):
                    raise ValueError('Workspace contains an escaping symlink.')
            elif item.is_file() and item.stat().st_nlink != 1:
                raise ValueError('Workspace contains a hardlinked file.')
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        mount = Path(line.split()[4].replace('\\040', ' '))
        if mount != path and mount.is_relative_to(path):
            raise ValueError('Workspace contains a nested mount.')
    return path


def validate_frame(frame, workspace):
    """Validate protocol path fields, never rewrite arbitrary prompt strings."""
    params = frame.get('params') or {}
    paths = []
    if 'cwd' in params and params['cwd'] is not None:
        paths.append(params['cwd'])
    # T3 probes skills using its server cwd. Unmounted paths resolve only inside
    # the container; let Codex report unavailable skills without killing health probes.
    if frame.get('method') == 'thread/resume' and params.get('path'):
        raise ValueError('Resume by filesystem path is unsupported; use thread id.')
    for value in paths:
        if not isinstance(value, str) or not Path(value).is_absolute() or not Path(value).resolve().is_relative_to(workspace):
            raise ValueError('This Codex instance is bound to a different workspace.')


def main():
    if len(sys.argv) < 4 or sys.argv[1] != '--config':
        raise ValueError('Usage: codex.py --config /absolute/operator-config.json CODEX_ARGS...')
    config_path = Path(sys.argv[2]).resolve(strict=True)
    config = json.loads(config_path.read_text())
    if set(config) != {'workspace', 'context', 'image', 'allowlist', 'state'}:
        raise ValueError('Config requires exactly workspace, context, image, allowlist, state.')
    workspace = workspace_path(config['workspace'])
    allowlist = Path(config['allowlist']).resolve(strict=True)
    if config_path.is_relative_to(workspace) or allowlist.is_relative_to(workspace):
        raise ValueError('Operator config and allowlist must be outside the workspace.')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', config['image']):
        raise ValueError('Image must be a locally built immutable sha256 image ID.')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', config['context']):
        raise ValueError('Explicit Docker context required.')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', config['state']):
        raise ValueError('Invalid state name.')
    docker = ['docker', '--context', config['context']]
    # Do not inherit Docker endpoint overrides or Compose interpolation from T3.
    env = {key: value for key, value in os.environ.items() if not key.startswith(('DOCKER_', 'COMPOSE_', 'T3_RESTRICTED_'))}
    context = subprocess.check_output([*docker, 'context', 'inspect', config['context']], env=env)
    endpoint = json.loads(context)[0]['Endpoints']['docker']['Host']
    if not endpoint.startswith('unix://'):
        raise ValueError('Only a local Unix-socket Docker context is supported.')
    identity = [str(workspace), workspace.stat().st_dev, workspace.stat().st_ino, config['context'], endpoint, config['image'], config['state'], allowlist.read_text()]
    digest = hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:24]
    project = 't3-codex-' + secrets.token_hex(8)
    subnet = f'10.{128 + secrets.randbelow(100)}.{secrets.randbelow(256)}'
    env.update(T3_RESTRICTED_WORKSPACE=str(workspace), T3_RESTRICTED_TARGET=str(workspace),
               T3_RESTRICTED_IMAGE=config['image'], T3_RESTRICTED_STATE_VOLUME='t3-codex-' + digest,
               T3_RESTRICTED_SUBNET=subnet + '.0/24', T3_RESTRICTED_PROXY_IP=subnet + '.2',
               T3_RESTRICTED_RUNNER_IP=subnet + '.3')
    base = [*docker, 'compose', '-p', project, '-f', str(Path(__file__).with_name('compose.yaml'))]
    child = None
    interrupted = 0
    def stop(signum, _frame):
        nonlocal interrupted
        interrupted = signum
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGTERM)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    def operation(*args):
        nonlocal child
        if interrupted:
            raise SystemExit(128 + interrupted)
        child = subprocess.Popen([*base, *args], env=env, stdin=subprocess.DEVNULL, stdout=sys.stderr, pass_fds=(write_fd,))
        code = child.wait()
        if interrupted:
            raise SystemExit(128 + interrupted)
        if code:
            raise RuntimeError(f'Docker operation failed ({code})')
    # Snapshot the allowlist so workload/operator changes cannot widen a live session.
    with tempfile.TemporaryDirectory(prefix='t3-codex-') as temporary:
        snapshot = Path(temporary) / 'allowlist'
        snapshot.write_text(identity[-1])
        snapshot.chmod(0o644)
        env['T3_RESTRICTED_ALLOWLIST'] = str(snapshot)
        read_fd, write_fd = os.pipe()
        guardian = subprocess.Popen(
            [sys.executable, '-c',
             'import os,subprocess,sys\nos.read(int(sys.argv[1]),1)\n'
             'result = subprocess.run(sys.argv[2:],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)\n'
             'try: os.write(2,result.stdout)\n'
             'except OSError: pass\n'
             'sys.exit(result.returncode)',
             str(read_fd), *base, 'down', '--remove-orphans', '--timeout', '0'],
            env=env, pass_fds=(read_fd,), start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=sys.stderr)
        os.close(read_fd)
        try:
            operation('up', '-d', '--wait', '--wait-timeout', '45', '--no-build', '--pull', 'never', 'proxy')
            if interrupted:
                raise SystemExit(128 + interrupted)
            args = sys.argv[3:]
            app_server = 'app-server' in args
            child = subprocess.Popen([*base, 'run', '--rm', '--no-deps', '--pull', 'never', '-T', 'runner', '/usr/local/bin/node', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', *args],
                                     env=env, stdin=subprocess.PIPE if app_server else None)
            errors = []
            def relay():
                try:
                    def lines():
                        pending = b''
                        while True:
                            chunk = os.read(0, 65536)
                            if not chunk:
                                if pending:
                                    yield pending
                                return
                            pending += chunk
                            while b'\n' in pending:
                                line, pending = pending.split(b'\n', 1)
                                yield line + b'\n'
                    for line in lines():
                        validate_frame(json.loads(line), workspace)
                        child.stdin.write(line)
                        child.stdin.flush()
                except (ValueError, TypeError, AttributeError) as error:
                    errors.append(str(error))
                    print(str(error), file=sys.stderr)
                    child.terminate()
                except BrokenPipeError:
                    pass
                finally:
                    child.stdin.close()
            if app_server:
                threading.Thread(target=relay, daemon=True).start()
            code = child.wait()
            return 128 + interrupted if interrupted else (1 if errors else code)
        finally:
            # The engine owns workload termination, even if Compose's attach client died.
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(sig, signal.SIG_IGN)
            os.close(write_fd)
            if guardian.wait(timeout=35):
                raise RuntimeError('Cleanup failed; inspect the Docker project ' + project)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Restricted Codex: {error}', file=sys.stderr)
        raise SystemExit(1)
