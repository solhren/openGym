#!/usr/bin/env python3
"""Stop the instance API, back up its entire private data folder, then resume it."""
import argparse
import json
from pathlib import Path
import subprocess

from state import backup


def offline_backup(instance, output, runner=subprocess.run):
    instance = Path(instance).resolve()
    output = Path(output).absolute()
    if output == instance / 'data' or instance / 'data' in output.parents:
        raise ValueError('Backups must be outside the data directory')
    metadata = json.loads((instance / 'instance.json').read_text())
    if metadata.get('format') != 'opengym-selfhost-instance':
        raise ValueError('A prepared self-hosting instance is required')
    compose = ['docker', 'compose', '--env-file', str(instance / 'instance.env'), '-f', str(instance / 'compose.yaml')]
    def run(args, **kwargs):
        return runner(compose + args, check=True, cwd=instance, **kwargs)
    run(['config', '--quiet'])
    # The published profile always binds this directory. Reject edits that would
    # otherwise back up an unused directory while the real database keeps writing.
    effective = json.loads(run(['config', '--format', 'json'], capture_output=True, text=True).stdout)
    mounts = effective['services']['api']['volumes']
    if not any(item.get('type') == 'bind' and item.get('target') == '/data' and
               Path(item['source']).resolve() == instance / 'data' for item in mounts):
        raise ValueError('API data mount differs from this prepared instance')
    running = run(['ps', '--status', 'running', '-q', 'api'], capture_output=True, text=True).stdout.strip()
    run(['stop', 'api'])
    try:
        backup(instance / 'data', output, metadata)
    finally:
        if running:
            run(['start', 'api'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('instance')
    parser.add_argument('output', help='New .tar.gz path, outside the data folder')
    args = parser.parse_args()
    try:
        output = Path(args.output).absolute()
        data = Path(args.instance).resolve() / 'data'
        if output == data or data in output.parents:
            raise ValueError('Backups must be outside the data directory')
        offline_backup(args.instance, output)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Backup failed: {error}\n')
    print('Backup and SHA-256 checksum written. Keep both private and copy them off the server.')


if __name__ == '__main__':
    main()
