#!/usr/bin/env python3
"""Stop the instance API, back up its entire private data folder, then resume it."""
import argparse
import json
import re
from pathlib import Path
import subprocess

from state import backup
from catalogue import configuration_lock, configuration_consistent, prepared_environment


def offline_backup(instance, output, runner=subprocess.run):
    instance = Path(instance).absolute()
    output = Path(output).absolute()
    if output == instance / 'data' or instance / 'data' in output.parents:
        raise ValueError('Backups must be outside the data directory')
    # Hold the same operator lock through stop/copy/restart. A catalogue change
    # must not switch the reviewed configuration underneath a backup.
    with configuration_lock(instance):
        configuration_consistent(instance)
        metadata = json.loads((instance / 'instance.json').read_text())
        if metadata.get('format') != 'opengym-selfhost-instance':
            raise ValueError('A prepared self-hosting instance is required')
        projects = re.findall(r"^OPENGYM_PROJECT='([a-z][a-z0-9-]{0,39})'$", (instance / 'instance.env').read_text(), re.MULTILINE)
        if len(projects) != 1:
            raise ValueError('A single prepared Compose project is required')
        compose = ['docker', 'compose', '--env-file', str(instance / 'instance.env'), '-f', str(instance / 'compose.yaml')]
        environment = prepared_environment()
        def run(args, **kwargs):
            return runner(compose + args, check=True, cwd=instance, env=environment, **kwargs)
        run(['config', '--quiet'])
        # A shell COMPOSE_PROJECT_NAME can redirect stop/start even when the data
        # mount is correct. Ignore ambient overrides and verify the effective name.
        effective = json.loads(run(['config', '--format', 'json'], capture_output=True, text=True).stdout)
        if effective.get('name') != projects[0]:
            raise ValueError('Compose project differs from this prepared instance')
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
