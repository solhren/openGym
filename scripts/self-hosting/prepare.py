#!/usr/bin/env python3
"""Prepare a new portable instance. Never starts Docker or contacts a registry."""
import argparse
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
from urllib.parse import urlsplit

from state import private_write, reserve, restore

REPO = Path(__file__).resolve().parents[2]


def browser_origin(value):
    url = urlsplit(value)
    if (url.username or url.password or url.path or url.query or url.fragment or
            url.scheme not in ('http', 'https') or not url.hostname or value != f'{url.scheme}://{url.netloc}' or
            url.hostname != url.hostname.lower() or not re.fullmatch(r'[a-z0-9.-]+', url.hostname)):
        raise ValueError('Use an exact HTTPS origin such as https://gym.example.com (no trailing slash)')
    try:
        port = url.port
    except ValueError:
        raise ValueError('Invalid origin port') from None
    if url.scheme == 'http' and url.hostname != 'localhost':
        raise ValueError('HTTP is supported only for localhost; phones need trusted HTTPS')
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('Invalid origin port')
    canonical = f'{url.scheme}://{url.hostname}'
    if port is not None and port != {'http': 80, 'https': 443}[url.scheme]:
        canonical += ':' + str(port)
    if value != canonical:
        raise ValueError('Use the browser-normalized origin: lowercase hostname, no default port')
    if url.hostname != 'localhost':
        labels = url.hostname.split('.')
        if len(labels) < 2 or len(url.hostname) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels):
            raise ValueError('Use a valid DNS hostname for passkeys')
        try:
            ipaddress.ip_address(url.hostname)
        except ValueError:
            pass
        else:
            raise ValueError('Passkeys require a hostname, not an IP address')
    return url.hostname


def allowed_source(name):
    path = Path(name)
    if any(part.startswith('.') or part in {'node_modules', 'test', 'tests', '__tests__', 'dist', 'build', 'android', 'ios', 'data', 'runtime', 'artifacts'} for part in path.parts):
        return False
    if any(c in name for c in '\r\n\0') or re.search(r'\.(?:test|spec)\.', name) or path.suffix in {'.pem', '.key', '.jks', '.keystore', '.sqlite', '.log'}:
        return False
    return name in {'LICENSE', 'NOTICE.md'} or name.startswith(('api/', 'frontend/', 'catalogue/media/', 'deploy/self-hosting/'))


def env_value(value):
    # Compose single quotes keep spaces, # and $ literal. Refuse quotes/newlines.
    value = str(value)
    if any(c in value for c in "'\r\n\0"):
        raise ValueError('Unsupported quote or newline in installation path')
    return "'" + value + "'"


def prepare(directory, origin, port=8080, project='opengym-selfhost', archive=None, repo=REPO, guard=reserve):
    host = browser_origin(origin)
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', project) or not 1024 <= port <= 65535:
        raise ValueError('Use a lowercase project name and a port from 1024 to 65535')
    target = Path(directory).absolute()
    if target.exists() or target.is_symlink() or not target.parent.is_dir():
        raise ValueError('Choose a new instance directory with an existing parent')
    if target.parent.resolve() != target.parent:
        raise ValueError('The instance parent must not contain symlinks')
    env_value(target)
    repo = Path(repo).resolve()
    names = subprocess.check_output(['git', '-C', str(repo), 'ls-files', '-z']).decode().split('\0')
    names = sorted(name for name in names if name and allowed_source(name))
    if 'deploy/self-hosting/compose.yaml' not in names:
        raise ValueError('Use a checkout containing the committed self-hosting tools')
    size = 0
    for name in names:
        source = repo / name
        if source.is_symlink() or not source.is_file() or source.resolve() != source:
            raise ValueError('Source symlinks and special files are refused')
        size += source.stat().st_size
    guard(target.parent, size + 1024 ** 2)
    target.mkdir(mode=0o700)
    source_dir = target / 'source'
    source_dir.mkdir(mode=0o700)
    inventory = []
    for index, name in enumerate(names):
        source, destination = repo / name, source_dir / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        destination.chmod(0o644)
        with open(destination, 'rb') as stream:
            inventory.append({'name': name, 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()})
        if index % 100 == 0:
            guard(target)
    source_hash = hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()
    release = 'source-' + source_hash[:16]
    for name in ('compose.yaml', 'Caddyfile.example'):
        shutil.copyfile(source_dir / 'deploy/self-hosting' / name, target / name)
    data = target / 'data'
    if archive:
        restore(archive, data, origin, guard=guard)
    else:
        data.mkdir(mode=0o700)
        code = secrets.token_hex(16).upper()
        private_write(data / 'db.json', json.dumps({'users': [], 'creds': [], 'subs': [], 'invites': [
            {'code': code, 'note': 'self-host bootstrap', 'createdBy': 'local-bootstrap',
             'created': datetime.now(timezone.utc).isoformat()}]}).encode())
        private_write(data / 'bootstrap-invite.txt', (code + '\n').encode())
    metadata = {'format': 'opengym-selfhost-instance', 'version': 1, 'origin': origin,
                'release': release, 'sourceCommit': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD']).decode().strip(),
                'sourceSha256': source_hash, 'catalogue': 'none', 'apiEgress': False}
    values = {'OPENGYM_PROJECT': project, 'OPENGYM_RELEASE': release, 'OPENGYM_SOURCE': source_dir,
              'OPENGYM_DATA_DIR': data, 'OPENGYM_ORIGIN': origin, 'OPENGYM_RP_ID': host,
              'OPENGYM_WEB_PORT': port, 'OPENGYM_UID': os.getuid(), 'OPENGYM_GID': os.getgid()}
    private_write(target / 'instance.env', ''.join(key + '=' + env_value(value) + '\n' for key, value in values.items()).encode())
    private_write(target / 'instance.json', (json.dumps(metadata, indent=2) + '\n').encode())
    private_write(target / 'source-inventory.json', (json.dumps(inventory, indent=2) + '\n').encode())
    (target / 'backups').mkdir(mode=0o700)
    guard(target)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--origin', required=True)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--project', default='opengym-selfhost')
    parser.add_argument('--restore', help='Restore a verified offline backup into this new instance')
    args = parser.parse_args()
    if os.getuid() == 0:
        parser.error('Use the non-root account that will own the instance and run Docker')
    try:
        metadata = prepare(args.directory, args.origin, args.port, args.project, args.restore)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Preparation refused: {error}\n')
    print(f"Prepared {metadata['release']}; no Docker command was run. No food catalogue installed.")
    print('Invitation: data/bootstrap-invite.txt inside the private instance directory (not printed).')


if __name__ == '__main__':
    main()
