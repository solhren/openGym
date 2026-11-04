#!/usr/bin/env python3
"""Prepare a new portable instance. Never starts Docker or contacts a registry."""
import argparse
from datetime import datetime, timezone
import hashlib
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
        # Browsers interpret a numeric final label as IPv4 notation, including
        # short, octal, hexadecimal and integer spellings that ipaddress rejects.
        # Reject that syntax locally instead of resolving a hostname or accepting
        # an origin that the browser will silently normalize to an IP address.
        if re.fullmatch(r'(?:[0-9]+|0x[0-9a-f]*)', labels[-1]):
            raise ValueError('Passkeys require a hostname, not an IP address')
        if len(labels) < 2 or len(url.hostname) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels):
            raise ValueError('Use a valid DNS hostname for passkeys')
    return url.hostname


def allowed_source(name):
    path = Path(name)
    if any(part.startswith('.') or part in {'node_modules', 'test', 'tests', '__tests__', 'dist', 'build', 'android', 'ios', 'data', 'runtime', 'artifacts'} for part in path.parts):
        return False
    if any(c in name for c in '\r\n\0') or re.search(r'\.(?:test|spec)\.', name) or path.suffix in {'.pem', '.key', '.jks', '.keystore', '.sqlite', '.log'}:
        return False
    if name.startswith(('scripts/nutrition-local-catalog/', 'scripts/self-hosting/')):
        return len(path.parts) == 3 and path.suffix in {'.py', '.mjs', '.js', '.json'} and not path.name.startswith('test_')
    return name in {'LICENSE', 'NOTICE.md'} or name.startswith(('api/', 'frontend/', 'catalogue/media/', 'deploy/self-hosting/'))


def env_value(value):
    # Keep spaces and # literal; refuse values Compose cannot round-trip safely.
    value = str(value)
    if any(c in value for c in "'$\r\n\0"):
        raise ValueError('Unsupported quote, dollar sign or newline in installation path')
    return "'" + value + "'"


def installation_policy(mode=None, signup=None, max_users=None, allow_public=False, restored=None, user_count=0):
    """Resolve installation settings without changing or promoting any account."""
    old_mode = restored.get('instanceMode') if restored else None
    if restored is not None and old_mode is None and mode is None:
        raise ValueError('Legacy backup has no instance mode; restore with --mode personal or --mode multi-user explicitly')
    if old_mode is not None and old_mode not in ('personal', 'multi-user'):
        raise ValueError('Invalid instance mode in backup metadata')
    if old_mode is not None and mode is not None and old_mode != mode:
        raise ValueError('Restoring into a different instance mode requires a server migration; keep the recorded mode')
    mode = mode or old_mode or 'personal'
    signup = signup or (restored.get('signupPolicy') if restored else None) or 'invite'
    max_users = max_users if max_users is not None else (restored.get('maxUsers') if restored else None)
    max_users = max_users if max_users is not None else (1 if mode == 'personal' else 100)
    if mode not in ('personal', 'multi-user') or signup not in ('invite', 'public'):
        raise ValueError('Choose personal or multi-user mode and invite or public signup')
    if mode == 'personal' and (signup != 'invite' or type(max_users) is not int or max_users != 1):
        raise ValueError('Personal mode has one owner and closes registration; public signup and larger limits are refused')
    if mode == 'multi-user' and (type(max_users) is not int or not 2 <= max_users <= 1000):
        raise ValueError('Multi-user mode requires --max-users from 2 to 1000 (default 100)')
    if signup == 'public' and not allow_public:
        raise ValueError('Public signup requires both --mode multi-user --signup public and --allow-public-signup')
    if user_count > max_users:
        raise ValueError('Restored account count exceeds the selected instance limit; no accounts were removed')
    return {'instanceMode': mode, 'signupPolicy': signup, 'maxUsers': max_users}


def prepare(directory, origin, port=8080, project='opengym-selfhost', archive=None, repo=REPO, guard=reserve,
            catalogues=None, mode=None, signup=None, max_users=None, allow_public=False):
    host = browser_origin(origin)
    policy = installation_policy(mode, signup, max_users, allow_public) if not archive or mode is not None else None
    from catalogue import plan_catalogues
    requested = plan_catalogues(repo, catalogues)
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
    restored = None
    if archive:
        restored = restore(archive, data, origin, guard=guard)
        db = json.loads((data / 'db.json').read_text())
        if not isinstance(db, dict) or not isinstance(db.get('users'), list):
            raise ValueError('Restored account database has no valid users list')
        policy = installation_policy(mode, signup, max_users, allow_public, restored, len(db['users']))
    else:
        data.mkdir(mode=0o700)
        code = secrets.token_hex(16).upper()
        private_write(data / 'db.json', json.dumps({'users': [], 'creds': [], 'subs': [], 'invites': [
            {'code': code, 'note': 'self-host bootstrap', 'createdBy': 'local-bootstrap',
             'created': datetime.now(timezone.utc).isoformat()}]}).encode())
        private_write(data / 'bootstrap-invite.txt', (code + '\n').encode())
    metadata = {'format': 'opengym-selfhost-instance', 'version': 1, 'origin': origin,
                'release': release, 'sourceCommit': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD']).decode().strip(),
                'sourceSha256': source_hash, 'catalogue': 'none', 'apiEgress': False, **policy}
    if restored is not None:
        metadata['restoredCatalogue'] = restored.get('catalogue', 'none')
    values = {'OPENGYM_PROJECT': project, 'OPENGYM_RELEASE': release, 'OPENGYM_SOURCE': source_dir,
              'OPENGYM_DATA_DIR': data, 'OPENGYM_ORIGIN': origin, 'OPENGYM_RP_ID': host,
              'OPENGYM_WEB_PORT': port, 'OPENGYM_UID': os.getuid(), 'OPENGYM_GID': os.getgid(),
              'OPENGYM_INSTANCE_MODE': policy['instanceMode'], 'OPENGYM_SIGNUP_POLICY': policy['signupPolicy'],
              'OPENGYM_MAX_USERS': policy['maxUsers']}
    private_write(target / 'instance.env', ''.join(key + '=' + env_value(value) + '\n' for key, value in values.items()).encode())
    private_write(target / 'instance.json', (json.dumps(metadata, indent=2) + '\n').encode())
    private_write(target / 'source-inventory.json', (json.dumps(inventory, indent=2) + '\n').encode())
    (target / 'backups').mkdir(mode=0o700)
    guard(target)
    if requested:
        from catalogue import acquire
        acquire(target, guard=guard)
        metadata = json.loads((target / 'instance.json').read_text())
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--origin', required=True)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--project', default='opengym-selfhost')
    parser.add_argument('--restore', help='Restore a verified offline backup into this new instance')
    parser.add_argument('--catalogues', help='Explicit downloads: recommended or ciqual; default none. List other sources with catalogue.py list')
    parser.add_argument('--mode', choices=['personal', 'multi-user'], help='Default personal for a new instance; inherit a recorded mode on restore')
    parser.add_argument('--signup', choices=['invite', 'public'], help='Default invite; public is an explicit multi-user option')
    parser.add_argument('--max-users', type=int, help='Personal is fixed at 1; multi-user default 100, allowed 2..1000')
    parser.add_argument('--allow-public-signup', action='store_true', help='Acknowledge public registration after the first administrator has used the private bootstrap invite')
    args = parser.parse_args()
    if os.getuid() == 0:
        parser.error('Use the non-root account that will own the instance and run Docker')
    try:
        metadata = prepare(args.directory, args.origin, args.port, args.project, args.restore, catalogues=args.catalogues,
                           mode=args.mode, signup=args.signup, max_users=args.max_users, allow_public=args.allow_public_signup)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Preparation refused: {error}\n')
    mode = 'public catalogue registry selected' if isinstance(metadata['catalogue'], dict) else 'personal foods only'
    print(f"Prepared {metadata['release']}; {metadata['instanceMode']} / {metadata['signupPolicy']}; {mode}. No service was started.")
    print('Invitation: data/bootstrap-invite.txt inside the private instance directory (not printed).')


if __name__ == '__main__':
    main()
