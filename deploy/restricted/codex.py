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


def workload():
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
    creating = False
    interrupted = 0
    def stop(signum, _frame):
        nonlocal interrupted
        interrupted = signum
        if not creating and child is not None and child.poll() is None:
            child.send_signal(signal.SIGTERM)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    output_threads = []
    def spawn(command, stdin, stdout):
        # A dead server may close its log pipes too. Keep draining Docker output
        # so EPIPE cannot abort a still outstanding create request.
        process = subprocess.Popen(command, env=env, stdin=stdin,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def forward(source, target):
            with source:
                while chunk := source.read1(65536):
                    try:
                        view = memoryview(chunk)
                        while view:
                            view = view[os.write(target, view):]
                    except OSError:
                        pass
        for source, target in ((process.stdout, stdout), (process.stderr, 2)):
            thread = threading.Thread(target=forward, args=(source, target), daemon=True)
            thread.start()
            output_threads.append(thread)
        return process
    def operation(*args):
        nonlocal child, creating
        if interrupted:
            raise SystemExit(128 + interrupted)
        creating = True
        try:
            child = spawn([*base, *args], subprocess.DEVNULL, 2)
            code = child.wait()
        finally:
            creating = False
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
        try:
            operation('up', '-d', '--wait', '--wait-timeout', '45', '--no-build', '--pull', 'never', 'proxy')
            if interrupted:
                raise SystemExit(128 + interrupted)
            args = sys.argv[3:]
            app_server = 'app-server' in args
            # Compose owns its create request in this external service. Cancellation
            # may stop its attach client only after the daemon acknowledges start.
            # Killing the client sooner could leave an outstanding daemon create.
            creating = True
            runner = project + '-runner'
            child = spawn([*base, 'run', '--name', runner, '--rm', '--no-deps', '--pull', 'never', '-T', 'runner', '/usr/local/bin/node', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', *args],
                                     subprocess.PIPE if app_server else None, 1)
            errors = []
            def await_creation():
                nonlocal creating
                while child.poll() is None:
                    try:
                        result = subprocess.run([*docker, 'inspect', '--format', '{{.State.Status}}', runner],
                                                env=env, capture_output=True, text=True, timeout=10)
                    except subprocess.TimeoutExpired:
                        continue
                    if result.returncode == 0 and result.stdout.strip() in ('running', 'exited', 'dead'):
                        try:
                            print('Restricted runner started: ' + runner, file=sys.stderr, flush=True)
                        except OSError:
                            pass
                        creating = False
                        if (interrupted or errors) and child.poll() is None:
                            child.terminate()
                        return
                    threading.Event().wait(0.1)
            threading.Thread(target=await_creation, daemon=True).start()
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
                    if not creating:
                        child.terminate()
                except BrokenPipeError:
                    pass
                finally:
                    child.stdin.close()
            if app_server:
                threading.Thread(target=relay, daemon=True).start()
            code = child.wait()
            for thread in output_threads:
                thread.join()
            return 128 + interrupted if interrupted else (1 if errors else code)
        finally:
            # The engine owns workload termination, even if Compose's attach client died.
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(sig, signal.SIG_IGN)
            cleanup = spawn([*base, 'down', '--remove-orphans', '--timeout', '0'], subprocess.DEVNULL, 2)
            try:
                cleanup_code = cleanup.wait(timeout=30)
            except subprocess.TimeoutExpired:
                cleanup.kill()
                cleanup.wait()
                raise
            for thread in output_threads:
                thread.join(timeout=1)
            if cleanup_code:
                raise RuntimeError('Cleanup failed; inspect the Docker project ' + project)


if __name__ == '__main__':
    try:
        from supervisor import run
        raise SystemExit(run(workload))
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Restricted Codex: {error}', file=sys.stderr)
        raise SystemExit(1)
