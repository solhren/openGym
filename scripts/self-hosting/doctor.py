#!/usr/bin/env python3
"""Read-only installation checks. No Docker daemon, HTTP requests or private account reads."""
import sys
sys.dont_write_bytecode = True
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess

from prepare import browser_origin, installation_policy
from catalogue import load_registry, PENDING

GIB = 1024 ** 3


def port_open(port):
    with socket.socket() as connection:
        connection.settimeout(0.25)
        return connection.connect_ex(('127.0.0.1', port)) == 0


def compose_available():
    # Client-only command: never contact a daemon or inspect existing containers.
    try:
        return subprocess.run(['docker', 'compose', 'version', '--short'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=5, check=False).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def diagnose(directory, port=8080, *, find=shutil.which, compose=compose_available,
             probe=port_open, disk=shutil.disk_usage, memory=None):
    """Return bounded, shareable findings; never read db.json, secret or instance.env."""
    rows = []
    def add(level, code, message):
        rows.append({'level': level, 'code': code, 'message': message})
    if sys.version_info < (3, 11):
        add('error', 'python', 'Python 3.11 or newer is required.')
    for binary in ('git', 'docker'):
        add('ok' if find(binary) else 'error', binary, f'{binary} found.' if find(binary) else f'Install {binary} using its official instructions.')
    if find('docker'):
        available = compose()
        add('ok' if available else 'error', 'compose', 'Docker Compose client is available; daemon access is NOT tested.' if available else 'Docker Compose v2 client is unavailable. Install the Compose plugin; do not change running services.')
    target = Path(directory).absolute()
    if target.resolve() != target or target.is_symlink():
        add('error', 'path', 'Choose a path without symlinks. No files were followed or changed.')
        return rows
    parent = target if target.is_dir() else target.parent
    if not parent.is_dir():
        add('error', 'parent', 'Create the parent directory with your regular user before preparing an instance.')
        return rows
    try:
        free = disk(parent).free
        ram = memory if memory is not None else next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
        add('ok' if free >= 20 * GIB and ram >= 2 * GIB else 'error', 'resources',
            f'Available: {free / GIB:.2f} GiB disk, {ram / GIB:.2f} GiB RAM. Keep 20 GiB disk and 2 GiB RAM plus operation size; builds need extra space.')
    except (OSError, StopIteration, ValueError):
        add('error', 'resources', 'Cannot measure disk/RAM reserves. Check df -h and free -h before proceeding.')
    if not os.access(parent, os.W_OK):
        add('error', 'permissions', 'The current user cannot write the instance parent. Use the intended non-root owner; do not make data world-writable.')
    if target.exists():
        try:
            if not target.is_dir():
                raise ValueError('not a directory')
            meta = target / 'instance.json'
            if meta.is_symlink() or meta.stat().st_size > 16384:
                raise ValueError('unsafe metadata')
            value = json.loads(meta.read_text())
            if not isinstance(value, dict) or value.get('format') != 'opengym-selfhost-instance' or type(value.get('version')) is not int or value['version'] != 1:
                raise ValueError('invalid metadata')
            browser_origin(value.get('origin', ''))
            policy = installation_policy(restored=value, allow_public=True)
            required = ('source', 'data', 'compose.yaml', 'instance.env', 'source-inventory.json')
            if any((target / name).is_symlink() or not ((target / name).is_dir() if name in ('source', 'data') else (target / name).is_file()) for name in required):
                raise ValueError('incomplete layout')
            add('ok', 'instance', f"Prepared instance: {policy['instanceMode']}, signup {policy['signupPolicy']}, limit {policy['maxUsers']}. Do not run prepare.py over it.")
            for name in ('data', 'instance.env'):
                if (target / name).stat().st_mode & 0o077:
                    add('warning', 'private-permissions', 'Data/configuration permissions are broader than owner-only; review with the instance owner.')
            catalogue_root = target / 'catalogues'
            if catalogue_root.resolve() != catalogue_root:
                raise ValueError('unsafe catalogue path')
            registry = load_registry(target)
            enabled = [item['id'] for item in registry['catalogues'] if item['enabled']]
            add('ok', 'catalogues', 'Enabled sources: ' + (', '.join(enabled) or 'none (personal foods and recipes remain available).'))
            if (target / PENDING).exists() or (target / PENDING).is_symlink():
                add('error', 'catalogue-pending', 'Interrupted catalogue configuration: run catalogue.py recover INSTANCE, then diagnose again. Do not start services yet.')
            elif not enabled:
                add('info', 'catalogue-next', 'For optional Ciqual or a failed download, run catalogue.py acquire INSTANCE. If it reports an unpublished partial attempt, follow its --restart instructions. Keep all data.')
            add('info', 'next', 'Use the Quick Start build/apply commands for this existing instance; repeat completed preparation without overwriting it. Database integrity and service health are not checked here.')
        except (OSError, ValueError, TypeError, KeyError):
            add('error', 'incomplete', 'Existing directory is incomplete or invalid. Preserve it. Do not overwrite data or regenerate an invitation. Inspect the failed step; use a NEW directory for a fresh preparation, or a verified backup for recovery.')
    else:
        add('ok', 'new', 'New instance path: prepare.py can create it without changing another installation.')
    if not 1024 <= port <= 65535:
        add('error', 'port', 'Choose a local web port between 1024 and 65535.')
    else:
        try:
            occupied = probe(port)
            add('warning' if occupied else 'ok', 'port',
                f'127.0.0.1:{port} already accepts connections. It may be your existing instance; do not stop another service. For a new instance choose another --port and matching localhost --origin.' if occupied else f'127.0.0.1:{port} did not accept a connection. This is a point-in-time probe, not a reserved port.')
        except OSError:
            add('warning', 'port', 'Could not probe the local port. Its availability remains unverified.')
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('instance', help='New or existing instance directory (never changed)')
    parser.add_argument('--port', type=int, default=8080, help='Local web port to probe, default 8080; use your configured port for an existing instance')
    parser.add_argument('--json', action='store_true', help='Bounded findings without private paths, invitations or account contents')
    args = parser.parse_args()
    rows = diagnose(args.instance, args.port)
    if args.json:
        print(json.dumps({'checks': rows, 'daemonChecked': False, 'accountDataRead': False}, indent=2))
    else:
        for row in rows:
            print(f"[{row['level'].upper()}] {row['code']}: {row['message']}")
    return 1 if any(row['level'] == 'error' for row in rows) else 0


if __name__ == '__main__':
    sys.exit(main())
