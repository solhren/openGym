#!/usr/bin/env python3
"""Acquire or select the public Ciqual catalogue without starting any service."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys

from state import private_write, regular_tree, reserve

REGISTRY_FORMAT = 'opengym-public-catalogue-registry'


def available_catalogues(source):
    file = Path(source) / 'scripts/nutrition-local-catalog/public-catalog-sources.json'
    if file.stat().st_size > 65536 or file.is_symlink():
        raise ValueError('Invalid catalogue sources descriptor')
    value = json.loads(file.read_text())
    if not isinstance(value, dict) or value.get('format') != 'opengym-public-catalogue-sources' or value.get('version') != 1:
        raise ValueError('Unsupported catalogue sources descriptor')
    return value


def plan_catalogues(source, requested):
    if requested is None or requested == 'none':
        return []
    descriptors = available_catalogues(source)
    names = descriptors['recommended'] if requested == 'recommended' else requested.split(',')
    names = list(dict.fromkeys('ciqual-2025' if name == 'ciqual' else name for name in names))
    if not 1 <= len(names) <= 8:
        raise ValueError('Choose one to eight explicitly available catalogues')
    for name in names:
        descriptor = next((value for value in descriptors['sources'] if value.get('id') == name), None)
        if not descriptor or descriptor.get('available') is not True or descriptor.get('kind') != 'ciqual-local':
            raise ValueError(f'Catalogue {name} is unavailable; list sources before selecting it')
    return names


def load_registry(instance):
    file = instance / 'catalogues/registry.json'
    if not file.exists():
        return {'format': REGISTRY_FORMAT, 'version': 1, 'catalogues': []}
    if file.is_symlink() or file.stat().st_size > 65536:
        raise ValueError('Unsafe catalogue registry')
    value = json.loads(file.read_text())
    if (not isinstance(value, dict) or set(value) != {'format', 'version', 'catalogues'} or value['format'] != REGISTRY_FORMAT or
            type(value['version']) is not int or value['version'] != 1 or not isinstance(value['catalogues'], list) or len(value['catalogues']) > 8):
        raise ValueError('Unsupported catalogue registry')
    ids = set()
    for item in value['catalogues']:
        if (not isinstance(item, dict) or set(item) != {'id', 'kind', 'directory', 'enabled', 'catalogueSha256'} or
                any(not isinstance(item[key], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', item[key]) for key in ('id', 'directory')) or
                not isinstance(item['kind'], str) or len(item['kind']) > 40 or type(item['enabled']) is not bool or
                not isinstance(item['catalogueSha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', item['catalogueSha256']) or item['id'] in ids):
            raise ValueError('Invalid catalogue registry entry')
        ids.add(item['id'])
    return value


def freeze_catalogue(instance, source_root, receipt, guard=reserve, generation=False):
    """Retain a small independent immutable snapshot; never mutate its source."""
    directory = source_root if generation else source_root / receipt['workspace']
    entries = regular_tree(directory)
    size = sum(info.st_size for _, info in entries)
    if size > 64 * 1024 ** 2:
        raise ValueError('Only bounded Ciqual snapshots up to 64 MiB can be copied')
    inventory = []
    for file, info in entries:
        relative = file.relative_to(directory).as_posix()
        if file.is_file():
            with file.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            inventory.append((relative, digest))
    digest = hashlib.sha256(json.dumps(sorted(inventory)).encode()).hexdigest()
    name = 'ciqual-2025-' + digest[:12]
    root = instance / 'catalogues'
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink() or root.resolve() != root:
        raise ValueError('Unsafe instance catalogue root')
    target = root / name
    guard(instance, size + 1024 ** 2)
    if not target.exists():
        temporary = root / ('.ciqual-stage-' + secrets.token_hex(8))
        temporary.mkdir(mode=0o700)
        for file, info in entries:
            destination = temporary / file.relative_to(directory)
            if file.is_dir():
                destination.mkdir(mode=0o755, parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                shutil.copyfile(file, destination)
                destination.chmod(0o444)
                with destination.open('rb') as stored:
                    os.fsync(stored.fileno())
        os.rename(temporary, target)
        directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    # Reuse is allowed only if every sealed byte still matches the inspected
    # source. Changed or extra files never become an active registry entry.
    actual = []
    for file, info in regular_tree(target):
        if file.is_file():
            with file.open('rb') as stream:
                actual.append((file.relative_to(target).as_posix(), hashlib.file_digest(stream, 'sha256').hexdigest()))
    if sorted(actual) != sorted(inventory):
        raise ValueError('Sealed catalogue snapshot changed')
    return {'id': 'ciqual-2025', 'kind': 'ciqual-local', 'directory': name,
            'enabled': True, 'catalogueSha256': receipt['catalogueSha256']}


def atomic_write(path, data):
    temporary = path.with_name(path.name + '.' + secrets.token_hex(8) + '.tmp')
    private_write(temporary, data)
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def inspect_catalogue(instance, root, runner=subprocess.run, generation=False):
    root = Path(root).absolute()
    if not root.is_dir() or root.resolve() != root or root.is_symlink():
        raise ValueError('Choose an existing catalogue root without symlinks')
    bootstrap = instance / 'source/scripts/nutrition-local-catalog/public-bootstrap.py'
    result = runner([sys.executable, str(bootstrap), 'inspect-generation' if generation else 'inspect', str(root)],
                    check=True, capture_output=True, text=True,
                    env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'})
    if len(result.stdout) > 65536:
        raise ValueError('Catalogue inspection response is too large')
    value = json.loads(result.stdout)
    if (not isinstance(value, dict) or value.get('kind') != 'ciqual-local' or
            value.get('workspace') != 'ciqual-2025' or
            not re.fullmatch(r'[a-f0-9]{64}', str(value.get('catalogueSha256', ''))) or
            type(value.get('rows')) is not int or not 1 <= value['rows'] <= 100000 or
            type(value.get('usableFoodCount')) is not int or not 1 <= value['usableFoodCount'] <= value['rows']):
        raise ValueError('A verified, usable Ciqual catalogue is required')
    return root, value


def compose_config(instance, catalogue_root=None, runner=subprocess.run):
    templates = instance / 'source/deploy/self-hosting'
    command = ['docker', 'compose', '--env-file', str(instance / 'instance.env'),
               '-f', str(templates / 'compose.yaml')]
    environment = dict(os.environ)
    if catalogue_root is not None:
        command += ['-f', str(templates / 'compose.catalogue.yaml')]
        environment['OPENGYM_CATALOGUE_ROOT'] = str(catalogue_root)
    result = runner(command + ['config', '--format', 'json'], check=True, capture_output=True,
                    text=True, cwd=instance, env=environment)
    if len(result.stdout) > 1024 * 1024:
        raise ValueError('Compose configuration response is too large')
    effective = json.loads(result.stdout)
    api, web = effective['services']['api'], effective['services']['web']
    if (set(api['networks']) != {'private'} or api.get('ports') or
            not effective['networks']['private'].get('internal') or
            any(port.get('host_ip') != '127.0.0.1' for port in web.get('ports', [])) or
            api['environment'].get('INVITE_ONLY') != '1' or
            api['environment'].get('ALLOW_GUEST') != '0' or
            not any(mount.get('type') == 'bind' and mount.get('target') == '/data' and
                    mount.get('source') == str(instance / 'data') for mount in api['volumes'])):
        raise ValueError('Compose account/network boundary mismatch')
    if catalogue_root is not None:
        expected = {'OPENGYM_SELF_HOSTED_CATALOG': '1', 'NUTRITION_LOCAL_CATALOG': '1',
                    'NUTRITION_LOCAL_CATALOG_KIND': 'public-registry', 'OPENGYM_CATALOG_REGISTRY': '/catalogues/registry.json'}
        if (any(api['environment'].get(key) != value for key, value in expected.items()) or
                not any(mount.get('type') == 'bind' and mount.get('source') == str(catalogue_root) and
                        mount.get('target') == '/catalogues' and mount.get('read_only') is True and
                        mount.get('bind', {}).get('create_host_path') is False for mount in api['volumes'])):
            raise ValueError('Compose catalogue boundary mismatch')
    return effective


def configure(instance, root=None, runner=subprocess.run, guard=reserve, remove=None, generation=False):
    instance = Path(instance).absolute()
    if instance.resolve() != instance:
        raise ValueError('Instance paths must not contain symlinks')
    metadata = json.loads((instance / 'instance.json').read_text())
    if metadata.get('format') != 'opengym-selfhost-instance':
        raise ValueError('A prepared self-hosting instance is required')
    lock = os.open(instance / '.catalogue.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, 'w') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        registry = load_registry(instance)
        if root is not None:
            root, receipt = inspect_catalogue(instance, root, runner=runner, generation=generation)
            entry = freeze_catalogue(instance, root, receipt, guard=guard, generation=generation)
            registry['catalogues'] = [value for value in registry['catalogues'] if value['id'] != entry['id']] + [entry]
        elif remove is None:
            for entry in registry['catalogues']:
                entry['enabled'] = False
        else:
            selected = next((value for value in registry['catalogues'] if value['id'] == remove), None)
            if selected is None:
                raise ValueError('Catalogue is not registered')
            selected['enabled'] = False
        if len(registry['catalogues']) > 8:
            raise ValueError('Catalogue registry supports at most eight entries')
        registry_root = instance / 'catalogues'
        registry_root.mkdir(mode=0o700, exist_ok=True)
        if registry_root.is_symlink() or registry_root.resolve() != registry_root:
            raise ValueError('Unsafe instance catalogue root')
        payload = (json.dumps(registry, indent=2) + '\n').encode()
        registry_sha = hashlib.sha256(payload).hexdigest()
        for entry in registry['catalogues']:
            if entry['enabled']:
                if entry['kind'] != 'ciqual-local':
                    raise ValueError('Enabled catalogue kind is unavailable; no partial activation')
                _, checked = inspect_catalogue(instance, registry_root / entry['directory'], runner=runner, generation=True)
                if checked['catalogueSha256'] != entry['catalogueSha256']:
                    raise ValueError('Registered catalogue hash mismatch')
        # An empty/disabled registry remains a strict local mode. Removing the
        # last source must never reactivate the historical remote OFF relay.
        effective = compose_config(instance, registry_root, runner=runner)
        selection = {'kind': 'public-registry', 'root': str(registry_root),
                     'registrySha256': registry_sha, 'catalogues': registry['catalogues']}
        metadata['catalogue'] = selection
        # Publish configuration only after both offline integrity and Compose
        # validation have passed. A failed inspection leaves the old mode intact.
        old = registry_root / 'registry.json'
        if old.exists():
            old_data = old.read_bytes()
            old_sha = hashlib.sha256(old_data).hexdigest()
            snapshot = registry_root / ('registry-' + old_sha + '.json')
            if not snapshot.exists():
                private_write(snapshot, old_data)
        atomic_write(old, payload)
        atomic_write(instance / 'compose.yaml', (json.dumps(effective, indent=2) + '\n').encode())
        atomic_write(instance / 'instance.json', (json.dumps(metadata, indent=2) + '\n').encode())
    return selection


def acquire(instance, runner=subprocess.run, guard=reserve, restart=False):
    instance = Path(instance).absolute()
    if instance.resolve() != instance:
        raise ValueError('Instance paths must not contain symlinks')
    bootstrap = instance / 'source/scripts/nutrition-local-catalog/public-bootstrap.py'
    if not bootstrap.is_file() or not (instance / 'instance.json').is_file():
        raise ValueError('Prepare an instance from source containing the catalogue bootstrap first')
    guard(instance)
    root = instance / 'catalogues'
    # The bootstrap owns bounded downloading, integrity, publication and retry.
    # No Docker daemon, account directory or runtime provider is involved.
    runner([sys.executable, str(bootstrap), 'acquire', str(root)] + (['--restart'] if restart else []), check=True,
           env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'})
    return configure(instance, root, runner=runner, guard=guard)


def apply(instance, runner=subprocess.run):
    instance = Path(instance).absolute()
    command = ['docker', 'compose', '--env-file', str(instance / 'instance.env'), '-f', str(instance / 'compose.yaml')]
    runner(command + ['config', '--quiet'], check=True, cwd=instance)
    # Explicit operator action only. The images must have been built first.
    runner(command + ['up', '-d', '--no-build', '--force-recreate', 'api', 'web'], check=True, cwd=instance)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    for action in ('acquire', 'inspect', 'disable', 'use', 'use-generation', 'list', 'add', 'remove', 'apply'):
        command = commands.add_parser(action)
        command.add_argument('instance')
        if action in ('use', 'use-generation'):
            command.add_argument('catalogue_root', help='Existing verified catalogue root, containing ciqual-2025/')
        if action in ('add', 'remove'):
            command.add_argument('catalogue', help='Source id or ciqual alias; remove retains files and snapshots')
        if action in ('acquire', 'add'):
            command.add_argument('--restart', action='store_true', help='Restart only unpublished partial downloads/builds; preserve verified generations')
    args = parser.parse_args()
    try:
        instance = Path(args.instance).absolute()
        if args.action == 'list':
            value = {'available': available_catalogues(instance / 'source'), 'registry': load_registry(instance)}
        elif args.action == 'apply':
            apply(instance)
            print('Selected configuration applied; inspect Compose status and logs.')
            return
        elif args.action == 'add':
            plan_catalogues(instance / 'source', args.catalogue)
            value = acquire(instance, restart=args.restart)
        elif args.action == 'remove':
            name = 'ciqual-2025' if args.catalogue == 'ciqual' else args.catalogue
            value = configure(instance, remove=name)
        elif args.action == 'acquire':
            value = acquire(instance, restart=args.restart)
        elif args.action in ('use', 'use-generation'):
            value = configure(instance, args.catalogue_root, generation=args.action == 'use-generation')
        elif args.action == 'disable':
            value = configure(instance)
        else:
            metadata = json.loads((instance / 'instance.json').read_text())
            selected = metadata.get('catalogue')
            if isinstance(selected, dict) and selected.get('kind') == 'public-registry':
                registry = load_registry(instance)
                value = {'registry': registry, 'inspections': []}
                for entry in registry['catalogues']:
                    if entry['enabled']:
                        _, checked = inspect_catalogue(instance, instance / 'catalogues' / entry['directory'], generation=True)
                        if checked['catalogueSha256'] != entry['catalogueSha256']:
                            raise ValueError('Registered catalogue hash mismatch')
                        value['inspections'].append(checked)
            else:
                root = selected['root'] if isinstance(selected, dict) else instance / 'catalogues'
                _, value = inspect_catalogue(instance, root)
        print(json.dumps(value, sort_keys=True))
        if args.action not in ('inspect', 'list'):
            print('Configuration prepared; build api then web and recreate with up -d --no-build. No service was started.')
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Catalogue configuration refused: {error}\n')


if __name__ == '__main__':
    main()
