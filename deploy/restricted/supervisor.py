"""External ownership for the restricted launcher; never run in the caller's cgroup."""
import array
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading


def run(workload):
    if len(sys.argv) > 1 and sys.argv[1] == '--supervise':
        return serve(workload, sys.argv[2])
    directory = tempfile.mkdtemp(prefix='t3-codex-owner-')
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(directory + '/control')
    listener.listen(1)
    listener.settimeout(10)
    unit = 't3-codex-owner-' + Path(directory).name.removeprefix('t3-codex-owner-')
    # Do not serialize ambient credentials into systemd's unit properties or journal.
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': os.environ['HOME'],
           'XDG_RUNTIME_DIR': os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')}
    try:
        subprocess.run(['systemd-run', '--user', '--quiet', '--collect', '--unit=' + unit,
                        '--property=StandardOutput=null', '--property=StandardError=null',
                        '--property=TimeoutStopSec=40',
                        '/usr/bin/env', '-i', *[k + '=' + v for k, v in env.items()],
                        sys.executable, str(Path(sys.argv[0]).resolve()), '--supervise', directory],
                       env=env, check=True, timeout=10)
        connection, _ = listener.accept()
        with connection:
            pidfd = os.pidfd_open(os.getpid())
            try:
                connection.sendmsg([b'F'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                            array.array('i', [0, 1, 2, pidfd]))])
            finally:
                os.close(pidfd)
            # Arguments travel over a private socket, not the unit command line.
            connection.sendall(json.dumps(sys.argv).encode() + b'\n')
            stream = connection.makefile('rb')
            ack = json.loads(stream.readline())
            if ack['cgroup'] == Path('/proc/self/cgroup').read_text():
                raise RuntimeError('Cleanup owner did not escape provider cgroup')
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(sig, lambda number, _frame: connection.sendall(bytes([number])))
            connection.sendall(b'G')
            result = stream.readline()
            if not result:
                raise RuntimeError('Cleanup owner exited without reporting completion: ' + unit)
            return int(result)
    finally:
        listener.close()
        # The service owns this directory after connect, including caller SIGKILL.
        shutil.rmtree(directory, ignore_errors=True)


def serve(workload, directory):
    connection = socket.socket(socket.AF_UNIX)
    try:
        connection.settimeout(10)
        connection.connect(directory + '/control')
        _, ancillary, _, _ = connection.recvmsg(1, socket.CMSG_SPACE(4 * array.array('i').itemsize))
        descriptors = array.array('i')
        descriptors.frombytes(ancillary[0][2])
        stdin, stdout, stderr, owner = descriptors
        for source, target in ((stdin, 0), (stdout, 1), (stderr, 2)):
            os.dup2(source, target)
            os.close(source)
        data = b''
        while not data.endswith(b'\n'):
            part = connection.recv(1)
            if not part:
                return 1
            data += part
        sys.argv = json.loads(data)
        connection.sendall(json.dumps({'cgroup': Path('/proc/self/cgroup').read_text()}).encode() + b'\n')
        if connection.recv(1) != b'G':
            return 1
        connection.settimeout(None)
        print('Restricted cleanup owner: ' + Path(directory).name + '.service', file=sys.stderr, flush=True)
        def terminate(number, _frame):
            raise SystemExit(128 + number)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, terminate)
        def watch():
            while True:
                ready, _, _ = select.select([owner, connection], [], [])
                if owner in ready:
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
                message = connection.recv(1)
                os.kill(os.getpid(), message[0] if message else signal.SIGTERM)
                if not message:
                    return
        threading.Thread(target=watch, daemon=True).start()
        try:
            code = workload()
        except SystemExit as error:
            code = error.code
        except Exception as error:
            print(f'Restricted Codex: {error}', file=sys.stderr)
            code = 1
        try:
            connection.sendall(str(code).encode() + b'\n')
        except BrokenPipeError:
            pass
        return code
    finally:
        connection.close()
        shutil.rmtree(directory, ignore_errors=True)
