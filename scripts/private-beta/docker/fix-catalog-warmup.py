#!/usr/bin/env python3
"""Apply the one-SELECT warmup fix to the installed frozen backend context.

Run as solhren. Compose config is read only to locate the real build context.
No image build, container action, catalogue/volume access or secret is involved.
"""
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

TARGET = 'scripts/nutrition-local-catalog/wger-off-reference.py'
OLD = b'SELECT count(*)FROM products INDEXED BY search_rank_idx'
NEW = b'SELECT count(id)FROM products INDEXED BY search_rank_idx'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def inventory_hash(entries):
    return sha(''.join(v['name'] + '\0' + v['sha256'] + '\n' for v in entries).encode())


def resolve_context(root):
    contexts = []
    for name in ('compose.lab.json', 'compose.json'):
        raw = subprocess.check_output(['docker', 'compose', '--env-file', 'images.conf', '-f', name,
                                       'config', '--format', 'json'], cwd=root)
        contexts.append(Path(json.loads(raw)['services']['backend']['build']['context']).resolve(strict=True))
    if contexts[0] != contexts[1]:
        raise ValueError('Lab and production use different contexts; review required')
    return contexts[0]


def patch(root, context=None):
    root = Path(root).resolve(strict=True)
    if os.geteuid() == 0 or root.stat().st_uid != os.geteuid():
        raise ValueError('Run as the deployment owner (solhren), not sudo python')
    context = resolve_context(root) if context is None else Path(context).resolve(strict=True)
    if not context.is_relative_to(root) or context.name != 'source':
        raise ValueError('Expected a source context within this deployment')
    package = context.parent
    file = context / TARGET
    paths = {'reader.py': file, **{n: package/n for n in ('source-inventory.json', 'source.sha256', 'prepared.json')}}
    before = {}
    for name, path in paths.items():
        if path.is_symlink() or path.resolve(strict=True) != path or not path.is_file() or path.stat().st_uid != os.geteuid() or path.stat().st_size > 8*1024**2:
            raise ValueError('Unsafe source or metadata file: ' + name)
        before[name] = path.read_bytes()
    inventory = json.loads(before['source-inventory.json'])
    receipt = json.loads(before['prepared.json'])
    if receipt.get('format') != 'opengym-personal-compose-preparation' or receipt.get('version') != 1 or receipt.get('complete') is not True:
        raise ValueError('Unrecognized source preparation receipt')
    entries = [v for v in inventory if v['name'] == TARGET]
    if len(entries) != 1 or entries[0]['sha256'] != sha(before['reader.py']):
        raise ValueError('Reader has unrecorded changes; no files written')
    checks = before['source.sha256'].decode().splitlines()
    if checks != [v['sha256'] + '  source/' + v['name'] for v in inventory]:
        raise ValueError('Source checksums do not match inventory')
    if inventory_hash(inventory) != receipt.get('sourceSha256'):
        raise ValueError('Source inventory does not match receipt')
    if before['reader.py'].count(b'deadline=time.monotonic()+2;') != 1:
        raise ValueError('Unexpected search deadline; no files written')
    if OLD not in before['reader.py'] and before['reader.py'].count(NEW) == 1:
        return None
    if before['reader.py'].count(OLD) != 1 or NEW in before['reader.py']:
        raise ValueError('Unexpected reader version; review required')
    # Only the warmup expression changes. Keep the request deadline verbatim.
    after = {'reader.py': before['reader.py'].replace(OLD, NEW)}
    ast.parse(after['reader.py'])
    old_source_hash = receipt['sourceSha256']
    entries[0]['sha256'] = sha(after['reader.py'])
    receipt['sourceSha256'] = inventory_hash(inventory)
    receipt['sourceBytes'] += len(after['reader.py']) - len(before['reader.py'])
    receipt.setdefault('patches', []).append({'kind': 'catalog-covering-warmup-v1',
        'previousSourceSha256': old_source_hash, 'sourceSha256': receipt['sourceSha256']})
    after['source-inventory.json'] = (json.dumps(inventory, indent=2) + '\n').encode()
    after['source.sha256'] = ''.join(v['sha256']+'  source/'+v['name']+'\n' for v in inventory).encode()
    after['prepared.json'] = (json.dumps(receipt, indent=2) + '\n').encode()
    backup = Path(tempfile.mkdtemp(prefix='catalog-warmup-backup-', dir=package))
    for name, raw in before.items():
        with (backup/name).open('xb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    replacements = []
    for name, raw in after.items():
        fd, temporary = tempfile.mkstemp(prefix='.catalog-warmup-', dir=paths[name].parent)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), paths[name].stat().st_mode & 0o777)
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        replacements.append((paths[name], temporary))
    if any(path.read_bytes() != before[name] for name, path in paths.items()):
        raise ValueError('Concurrent edit detected; backup retained, no replacements published')
    for path, temporary in replacements:
        os.replace(temporary, path)
    for directory in {package, file.parent}:
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    return backup


if __name__ == '__main__':
    try:
        if len(sys.argv) > 2:
            raise ValueError('Usage: python3 fix-catalog-warmup.py [deployment-directory]')
        result = patch(sys.argv[1] if len(sys.argv) == 2 else '.')
        print('Backend source patched; original files: ' + str(result) if result else 'Warmup already corrected; no changes')
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print('Refused patch: ' + str(error), file=sys.stderr)
        sys.exit(1)
