#!/usr/bin/env python3
"""Patch only the installed Compose frontend tmpfs and deployment checksums.

Run as the configured deployment owner, without sudo. No Docker operation, volume, catalogue,
source snapshot or image is changed. Original files are retained for recovery.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from deployment_owner import verify_deployment_owner

MOUNT = '/var/cache/nginx:rw,nosuid,nodev,noexec,size=4m,uid=101,gid=101,mode=0700'
NAMES = ('compose.json', 'compose.lab.json')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def patch(root):
    root = Path(root).resolve(strict=True)
    verify_deployment_owner(root)
    before, after = {}, {}
    for name in (*NAMES, 'deployment.sha256'):
        file = root / name
        if file.is_symlink() or not file.is_file() or file.stat().st_uid != os.geteuid():
            raise ValueError('Unsafe or unowned deployment file: ' + name)
        if file.stat().st_size > 1024 * 1024:
            raise ValueError('Unexpected deployment file size')
        before[name] = file.read_bytes()
    checks = {}
    for line in before['deployment.sha256'].decode().splitlines():
        digest, name = line.split('  ', 1)
        if name in checks or len(digest) != 64:
            raise ValueError('Invalid deployment checksum list')
        checks[name] = digest
    if any(checks.get(name) != sha(before[name]) for name in NAMES):
        raise ValueError('Compose has unrecorded changes; review before applying this patch')
    for name in NAMES:
        config = json.loads(before[name])
        frontend = config['services']['frontend']
        if frontend.get('read_only') is not True or frontend.get('user') != '101:101':
            raise ValueError('Unexpected frontend permissions; no changes made')
        original = copy.deepcopy(config)
        mounts = frontend.get('tmpfs')
        if not isinstance(mounts, list) or not all(isinstance(v, str) for v in mounts):
            raise ValueError('Unexpected tmpfs configuration')
        cache = [v for v in mounts if v.split(':', 1)[0] == '/var/cache/nginx']
        if cache:
            if cache != [MOUNT]:
                raise ValueError('Existing custom nginx cache mount; review required')
            after[name] = before[name]
            continue
        mounts.append(MOUNT)
        # Deliberately change no other service, protection, limit or mount.
        comparison = copy.deepcopy(config)
        comparison['services']['frontend']['tmpfs'].pop()
        if comparison != original:
            raise ValueError('Patch exceeded frontend tmpfs scope')
        after[name] = (json.dumps(config, indent=2, ensure_ascii=False) + '\n').encode()
    if all(after[n] == before[n] for n in NAMES):
        return None
    after['deployment.sha256'] = ''.join(
        (sha(after[name]) if name in NAMES else digest) + '  ' + name + '\n'
        for name, digest in checks.items()
    ).encode()
    backup = Path(tempfile.mkdtemp(prefix='nginx-tmpfs-backup-', dir=root))
    for name, raw in before.items():
        with (backup / name).open('xb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    # Stage every replacement first. A process interruption leaves the originals
    # in the private backup; never conceal a partial patch by resetting volumes.
    replacements = []
    for name, raw in after.items():
        fd, temporary = tempfile.mkstemp(prefix='.' + name + '-', dir=root)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), (root / name).stat().st_mode & 0o777)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        replacements.append((name, temporary))
    if any((root / name).read_bytes() != raw for name, raw in before.items()):
        raise ValueError('Deployment changed concurrently; backup retained, no replacements published')
    for name, temporary in replacements:
        os.replace(temporary, root / name)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return backup


if __name__ == '__main__':
    try:
        if len(sys.argv) > 2:
            raise ValueError('Usage: python3 fix-nginx-tmpfs.py [deployment-directory]')
        result = patch(sys.argv[1] if len(sys.argv) == 2 else '.')
        print('Both Compose files patched; original files: ' + str(result) if result else 'Both Compose files already corrected; no changes')
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('Refused patch: ' + str(error), file=sys.stderr)
        sys.exit(1)
