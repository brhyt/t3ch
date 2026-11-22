"""Run one command in an isolated project with explicit HTTPS destinations."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess


def docker_command(context=None):
    if context is not None and (not context.strip() or context.startswith("-")):
        raise ValueError("Docker context must be a nonempty context name.")
    return ["docker", "--context", context] if context is not None else ["docker"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--docker-context', help='Explicit Docker context for every operation; never falls back')
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--allowlist', type=Path, default=Path(__file__).with_name('allowed-domains.txt'))
    parser.add_argument('--image', help='Prebuilt derivative image with a pinned provider CLI installed')
    parser.add_argument('--name', help='Isolated state name; letters, numbers, and hyphens only')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        docker = docker_command(args.docker_context)
    except ValueError as error:
        parser.error(str(error))
    workspace = args.workspace.expanduser().resolve(strict=True)
    allowlist = args.allowlist.expanduser().resolve(strict=True)
    if not workspace.is_dir() or workspace in (Path('/'), Path.home(), Path('/home'), Path('/Users')):
        parser.error('Select a project directory, not a home directory or filesystem root.')
    if not allowlist.is_file():
        parser.error('Allowlist must be a file.')
    name = args.name or hashlib.sha256(str(workspace).encode()).hexdigest()[:12]
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', name):
        parser.error('Name must contain only lowercase letters, numbers, and hyphens.')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('Supply a command after --.')
    project = 't3-restricted-' + name
    env = {**os.environ, 'T3_RESTRICTED_WORKSPACE': str(workspace), 'T3_RESTRICTED_ALLOWLIST': str(allowlist)}
    if args.docker_context is not None:
        env.pop('DOCKER_HOST', None)
        env.pop('DOCKER_CONTEXT', None)
    if args.image:
        env['T3_RESTRICTED_IMAGE'] = args.image
    else:
        env.pop('T3_RESTRICTED_IMAGE', None)
    base = [*docker, 'compose', '-p', project, '-f', str(Path(__file__).with_name('compose.yaml').resolve())]
    def compose(*arguments, check=True):
        return subprocess.run([*base, *arguments], env=env, check=check)
    active = subprocess.run([*base, 'ps', '-q'], env=env, check=True, capture_output=True, text=True)
    if active.stdout.strip():
        parser.error('This isolated state name already has running containers; stop that session first.')
    try:
        if not args.image:
            compose('build', 'proxy')
        compose('up', '-d', '--force-recreate', '--wait', 'proxy')
        return compose('run', '--rm', 'runner', *command, check=False).returncode
    finally:
        compose('down', '--remove-orphans', check=False)


if __name__ == '__main__':
    raise SystemExit(main())
