import hashlib
import io
import json
import os
from contextlib import closing
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
REPO = TOOLS.parents[1]
sys.path.insert(0, str(TOOLS))
from prepare import browser_origin, prepare, installation_policy
from state import backup, restore
from backup import offline_backup
from catalogue import (acquire, apply, configure, load_registry, plan_catalogues,
                       recover, inspect_selected, configuration_consistent,
                       atomic_write, compose_config, PENDING, CONFIG_FILES)


class SelfHostingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        shutil.copytree(REPO / 'deploy/self-hosting', self.repo / 'deploy/self-hosting')
        (self.repo / 'api').mkdir()
        (self.repo / 'api/server.js').write_text('// synthetic source, no server started\n')
        (self.repo / 'api/.env').write_text('DO_NOT_COPY=private\n')
        (self.repo / 'api/test').mkdir()
        (self.repo / 'api/test/fixture.json').write_text('{}')
        (self.repo / 'frontend').mkdir()
        (self.repo / 'frontend/package.json').write_text('{}')
        public_tools = self.repo / 'scripts/nutrition-local-catalog'
        public_tools.mkdir(parents=True)
        # A tiny offline inspector for deployment tests. The real bootstrap has
        # its own source/licence/parser tests in scripts/nutrition-local-catalog.
        (public_tools / 'public-bootstrap.py').write_text('''import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[2]) if sys.argv[1]=='inspect-generation' else Path(sys.argv[2])/'ciqual-2025'
receipt=json.loads((root/'receipt.json').read_text())
with (root/'catalog.sqlite').open('rb') as source:
 if hashlib.file_digest(source,'sha256').hexdigest()!=receipt['catalogueSha256']:sys.exit(1)
print(json.dumps(receipt))
''')
        (public_tools / 'public-catalog-sources.json').write_text(json.dumps({
            'format': 'opengym-public-catalogue-sources', 'version': 1,
            'recommended': ['ciqual-2025'], 'sources': [
                {'id': 'ciqual-2025', 'kind': 'ciqual-local', 'available': True},
                {'id': 'off', 'available': False}, {'id': 'wger', 'available': False}]}))
        (public_tools / 'test_fixture.py').write_text('DO_NOT_COPY = True\n')
        health = self.repo / 'scripts/self-hosting'
        health.mkdir()
        shutil.copyfile(TOOLS / 'health.mjs', health / 'health.mjs')
        (self.repo / 'LICENSE').write_text('fixture license')
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        subprocess.run(['git', '-C', str(self.repo), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)

    def tearDown(self):
        self.temporary.cleanup()

    def prepared(self, name='instance with spaces', origin='https://gym.example.com', archive=None):
        instance = self.root / name
        metadata = prepare(instance, origin, repo=self.repo, archive=archive, guard=lambda *args: None)
        return instance, metadata

    def data(self, instance):
        data = instance / 'data'
        (data / 'secret').write_text('synthetic-session-secret')
        (data / 'nutrition').mkdir()
        (data / 'nutrition/partition.json').write_text('{"food":"fixture rice"}')
        (data / 'uploads').mkdir()
        (data / 'uploads/fixture.bin').write_bytes(b'\x00\x01fixture')
        return data

    def archive(self):
        instance, metadata = self.prepared()
        data = self.data(instance)
        output = self.root / 'backup.tar.gz'
        backup(data, output, metadata, guard=lambda *args: None)
        return output, data

    def custom_archive(self, name, entries):
        output = self.root / (name + '.tar.gz')
        metadata = json.dumps({'format': 'opengym-selfhost-backup', 'version': 1,
                               'origin': 'https://gym.example.com', 'release': 'fixture'}).encode()
        with tarfile.open(output, 'w:gz') as archive:
            for name, kind, payload in [('opengym-backup.json', 'file', metadata), *entries]:
                item = tarfile.TarInfo(name)
                item.type = tarfile.DIRTYPE if kind == 'directory' else tarfile.REGTYPE
                item.size = len(payload) if kind == 'file' else 0
                archive.addfile(item, io.BytesIO(payload) if kind == 'file' else None)
        output.with_name(output.name + '.sha256').write_text(hashlib.sha256(output.read_bytes()).hexdigest())
        return output

    def public_catalogue(self):
        root = self.root / 'public catalogue'
        generation = root / 'ciqual-2025'
        generation.mkdir(parents=True)
        with closing(sqlite3.connect(generation / 'catalog.sqlite')) as connection:
            connection.execute('CREATE TABLE foods(id TEXT PRIMARY KEY, name TEXT)')
            connection.execute('INSERT INTO foods VALUES(?,?)', ('ciqual:1', 'Synthetic rice'))
            connection.commit()
        receipt = {'kind': 'ciqual-local', 'workspace': 'ciqual-2025', 'rows': 1,
                   'usableFoodCount': 1, 'completeFoodCount': 1,
                   'catalogueSha256': hashlib.sha256((generation / 'catalog.sqlite').read_bytes()).hexdigest()}
        (generation / 'receipt.json').write_text(json.dumps(receipt))
        return root, receipt

    def test_prepare_private_invite_tracked_snapshot_and_repeat_refusal(self):
        instance, metadata = self.prepared()
        self.assertEqual(metadata['catalogue'], 'none')
        self.assertEqual(metadata['apiEgress'], False)
        self.assertEqual(metadata['instanceMode'], 'personal')
        self.assertEqual(metadata['signupPolicy'], 'invite')
        self.assertEqual(metadata['maxUsers'], 1)
        self.assertEqual((instance / 'data').stat().st_mode & 0o777, 0o700)
        self.assertEqual((instance / 'instance.env').stat().st_mode & 0o777, 0o600)
        code = (instance / 'data/bootstrap-invite.txt').read_text().strip()
        self.assertRegex(code, r'^[0-9A-F]{32}$')
        db = json.loads((instance / 'data/db.json').read_text())
        self.assertEqual(db['users'], [])
        self.assertEqual(db['invites'][0]['code'], code)
        self.assertTrue((instance / 'source/api/server.js').exists())
        self.assertFalse((instance / 'source/api/.env').exists())
        self.assertFalse((instance / 'source/api/test').exists())
        self.assertTrue((instance / 'source/scripts/nutrition-local-catalog/public-bootstrap.py').exists())
        self.assertTrue((instance / 'source/scripts/self-hosting/health.mjs').exists())
        self.assertFalse((instance / 'source/scripts/nutrition-local-catalog/test_fixture.py').exists())
        (self.repo / 'api/server.js').write_text('changed checkout')
        self.assertNotEqual((instance / 'source/api/server.js').read_text(), 'changed checkout')
        with self.assertRaises(ValueError):
            prepare(instance, metadata['origin'], repo=self.repo, guard=lambda *args: None)

    def test_origins_and_unsafe_sources_fail_before_instance_creation(self):
        for value in ['http://192.168.1.3:8080', 'https://user:secret@gym.example.com', 'https://gym.example.com/', 'https://gym.example.com/a', 'https://gym.example.com?x=1', 'https://gym.example.com:99999', 'https://GYM.example.com', 'https://gym.example.com:443', 'https://127.0.0.1', 'https://bad-.example.com']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                browser_origin(value)
        self.assertEqual(browser_origin('http://localhost:8080'), 'localhost')
        (self.repo / 'api/server.js').unlink()
        (self.repo / 'api/server.js').symlink_to('/etc/hostname')
        target = self.root / 'unsafe'
        with self.assertRaises(ValueError):
            prepare(target, 'https://gym.example.com', repo=self.repo, guard=lambda *args: None)
        self.assertFalse(target.exists())

    def test_personal_and_multi_user_policies_are_explicit_and_public_requires_acknowledgment(self):
        self.assertEqual(installation_policy(), {'instanceMode': 'personal', 'signupPolicy': 'invite', 'maxUsers': 1})
        self.assertEqual(installation_policy('multi-user'), {'instanceMode': 'multi-user', 'signupPolicy': 'invite', 'maxUsers': 100})
        self.assertEqual(installation_policy('multi-user', 'public', 12, True),
                         {'instanceMode': 'multi-user', 'signupPolicy': 'public', 'maxUsers': 12})
        for values in [('personal', 'public', 1, True), ('personal', 'invite', 2, False),
                       ('multi-user', 'public', 100, False), ('multi-user', 'invite', 1, False),
                       ('multi-user', 'invite', 1001, False)]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                installation_policy(*values)
        for mode, signup, maximum, acknowledgment in [('personal', 'public', 1, True), ('multi-user', 'public', 100, False)]:
            target = self.root / ('unsafe-mode-' + mode)
            with self.assertRaises(ValueError):
                prepare(target, 'https://gym.example.com', repo=self.repo, guard=lambda *args: None,
                        mode=mode, signup=signup, max_users=maximum, allow_public=acknowledgment)
            self.assertFalse(target.exists())

    def test_dollar_sign_in_instance_path_is_refused_before_creation(self):
        target = self.root / 'instance $UNSET_VARIABLE'
        with self.assertRaisesRegex(ValueError, 'dollar sign'):
            prepare(target, 'https://gym.example.com', repo=self.repo, guard=lambda *args: None)
        self.assertFalse(target.exists())

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_multi_user_modes_resolve_to_prepared_environment_and_keep_bootstrap_private(self):
        for signup in ('invite', 'public'):
            with self.subTest(signup=signup):
                target = self.root / ('multi-' + signup)
                metadata = prepare(target, 'https://gym.example.com', repo=self.repo, guard=lambda *args: None,
                                   mode='multi-user', signup=signup, max_users=20, allow_public=signup == 'public')
                env = compose_config(target)['services']['api']['environment']
                self.assertEqual(env['OPENGYM_INSTANCE_MODE'], 'multi-user')
                self.assertEqual(env['OPENGYM_SIGNUP_POLICY'], signup)
                self.assertEqual(env['OPENGYM_MAX_USERS'], '20')
                self.assertEqual(env['OPENGYM_LISTEN_HOST'], '0.0.0.0')
                self.assertEqual(env['INVITE_ONLY'], '1')
                self.assertEqual(env['ALLOW_GUEST'], '0')
                db = json.loads((target / 'data/db.json').read_text())
                self.assertEqual(db['users'], [])
                self.assertEqual(len(db['invites']), 1)
                self.assertRegex(db['invites'][0]['code'], '^[0-9A-F]{32}$')
                self.assertEqual(metadata['signupPolicy'], signup)

    def test_restore_preserves_mode_and_legacy_requires_operator_choice_without_account_migration(self):
        source = self.root / 'multi-source'
        metadata = prepare(source, 'https://gym.example.com', repo=self.repo, guard=lambda *args: None,
                           mode='multi-user', max_users=5)
        data = self.data(source)
        db = json.loads((data / 'db.json').read_text())
        db['users'] = [{'id': 'existing-a', 'admin': True}, {'id': 'existing-b', 'admin': False}]
        (data / 'db.json').write_text(json.dumps(db))
        original = (data / 'db.json').read_bytes()
        current = self.root / 'multi-mode.tar.gz'
        backup(data, current, metadata, guard=lambda *args: None)
        recovered = self.root / 'multi-recovered'
        restored_meta = prepare(recovered, metadata['origin'], repo=self.repo, guard=lambda *args: None, archive=current)
        self.assertEqual(restored_meta['instanceMode'], 'multi-user')
        self.assertEqual(restored_meta['maxUsers'], 5)
        self.assertEqual((recovered / 'data/db.json').read_bytes(), original)
        with self.assertRaisesRegex(ValueError, 'different instance mode'):
            prepare(self.root / 'wrong-restored-mode', metadata['origin'], repo=self.repo,
                    guard=lambda *args: None, archive=current, mode='personal')
        legacy_meta = {key: value for key, value in metadata.items() if key not in ('instanceMode', 'signupPolicy', 'maxUsers')}
        legacy = self.root / 'legacy.tar.gz'
        backup(data, legacy, legacy_meta, guard=lambda *args: None)
        incomplete = self.root / 'legacy-no-mode'
        with self.assertRaisesRegex(ValueError, 'Legacy backup'):
            prepare(incomplete, metadata['origin'], repo=self.repo, guard=lambda *args: None, archive=legacy)
        self.assertFalse((incomplete / 'instance.env').exists())
        with self.assertRaisesRegex(ValueError, 'account count exceeds'):
            prepare(self.root / 'legacy-personal', metadata['origin'], repo=self.repo,
                    guard=lambda *args: None, archive=legacy, mode='personal')
        explicit = self.root / 'legacy-multi'
        chosen = prepare(explicit, metadata['origin'], repo=self.repo, guard=lambda *args: None,
                         archive=legacy, mode='multi-user', max_users=5)
        self.assertEqual(chosen['instanceMode'], 'multi-user')
        self.assertEqual((explicit / 'data/db.json').read_bytes(), original)
        self.assertEqual((data / 'db.json').read_bytes(), original)

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_apply_refuses_core_mode_drift_before_any_container_action(self):
        instance, _ = self.prepared()
        file = instance / 'instance.env'
        file.write_text(file.read_text().replace("OPENGYM_INSTANCE_MODE='personal'", "OPENGYM_INSTANCE_MODE='multi-user'"))
        calls = []
        def runner(command, **kwargs):
            calls.append(command)
            return subprocess.run(command, **kwargs)
        with self.assertRaisesRegex(ValueError, 'instance mode'):
            apply(instance, runner=runner)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][-3:], ['config', '--format', 'json'])

    def test_complete_backup_restore_preserves_bytes_and_origin(self):
        archive, original = self.archive()
        restored, _ = self.prepared('restored', archive=archive)
        for path in original.rglob('*'):
            if path.is_file():
                destination = restored / 'data' / path.relative_to(original)
                self.assertEqual(path.read_bytes(), destination.read_bytes())
                self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError):
            restore(archive, self.root / 'different-origin', 'https://other.example.com', guard=lambda *args: None)
        with self.assertRaises(ValueError):
            restore(archive, restored / 'data', 'https://gym.example.com', guard=lambda *args: None)

    def test_numeric_ipv4_spellings_refused_without_rejecting_normal_domains(self):
        for host in ['127.1', '0177.1', '0x7f.1', '2130706433', '0x7f000001',
                     '017700000001', '127.0.0.0x1', '0x', 'gym.08', 'gym.0x']:
            with self.subTest(host=host):
                target = self.root / ('numeric-' + host)
                with self.assertRaisesRegex(ValueError, 'IP address'):
                    prepare(target, 'https://' + host, repo=self.repo, guard=lambda *args: None)
                self.assertFalse(target.exists())
        for host in ['gym.example.com', '123.example.com', '001.example.com',
                     'gym.example123', 'dead.beef', 'gym.0xg']:
            with self.subTest(host=host):
                self.assertEqual(browser_origin('https://' + host), host)

    def test_restore_required_state_must_be_regular_files_before_target_creation(self):
        for index, directories in enumerate([{'data/secret'}, {'data/db.json'}, {'data/secret', 'data/db.json'}]):
            with self.subTest(directories=directories):
                entries = [(name, 'directory' if name in directories else 'file', b'fixture')
                           for name in ['data/secret', 'data/db.json']]
                archive = self.custom_archive('required-directory-' + str(index), entries)
                target = self.root / ('required-target-' + str(index))
                with self.assertRaisesRegex(ValueError, 'required data'):
                    restore(archive, target, 'https://gym.example.com', guard=lambda *args: None)
                self.assertFalse(target.exists())

    def test_restore_file_ancestor_conflicts_refused_in_both_archive_orders(self):
        required = [('data/secret', 'file', b'secret'), ('data/db.json', 'file', b'{}')]
        conflicts = [('data/a', 'file', b'a'), ('data/a/b', 'file', b'b')]
        for index, entries in enumerate([conflicts, list(reversed(conflicts))]):
            with self.subTest(order=index):
                archive = self.custom_archive('file-ancestor-' + str(index), required + entries)
                target = self.root / ('conflict-target-' + str(index))
                with self.assertRaisesRegex(ValueError, 'file ancestor'):
                    restore(archive, target, 'https://gym.example.com', guard=lambda *args: None)
                self.assertFalse(target.exists())

    def test_restore_allows_directory_entry_after_its_descendant(self):
        entries = [('data/secret', 'file', b'secret'), ('data/db.json', 'file', b'{}'),
                   ('data/a/b', 'file', b'fixture'), ('data/a', 'directory', b'')]
        archive = self.custom_archive('directory-after-descendant', entries)
        target = self.root / 'valid-directory-order'
        restore(archive, target, 'https://gym.example.com', guard=lambda *args: None)
        self.assertEqual((target / 'a/b').read_bytes(), b'fixture')

    def test_corrupt_backup_refused_without_creating_target(self):
        archive, _ = self.archive()
        with open(archive, 'ab') as stream:
            stream.write(b'corruption')
        target = self.root / 'restored'
        with self.assertRaisesRegex(ValueError, 'checksum'):
            restore(archive, target, 'https://gym.example.com', guard=lambda *args: None)
        self.assertFalse(target.exists())

    def test_unsafe_tar_members_refused_before_extraction(self):
        for kind in ['traversal', 'symlink', 'hardlink', 'absolute', 'duplicate']:
            with self.subTest(kind=kind):
                file = self.root / (kind + '.tar.gz')
                with tarfile.open(file, 'w:gz') as archive:
                    item = tarfile.TarInfo({'traversal': 'data/../../escape', 'absolute': '/tmp/escape'}.get(kind, 'data/entry'))
                    if kind in ['symlink', 'hardlink']:
                        item.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
                        item.linkname = '../../escape'
                    archive.addfile(item)
                    if kind == 'duplicate':
                        archive.addfile(item)
                file.with_name(file.name + '.sha256').write_text(hashlib.sha256(file.read_bytes()).hexdigest())
                target = self.root / ('target-' + kind)
                with self.assertRaises(ValueError):
                    restore(file, target, 'https://gym.example.com', guard=lambda *args: None)
                self.assertFalse(target.exists())

    def test_backup_resume_after_failure_and_refuses_wrong_mount(self):
        instance, _ = self.prepared()
        calls = []
        wrong = False
        def runner(command, **kwargs):
            args = command[6:]
            calls.append(args)
            stdout = ''
            if args == ['config', '--format', 'json']:
                stdout = json.dumps({'name': 'opengym-selfhost', 'services': {'api': {'volumes': [{'type': 'bind', 'target': '/data', 'source': str(instance / ('wrong' if wrong else 'data'))}]}}})
            elif args and args[0] == 'ps':
                stdout = 'fake-api-container-id\n'
            return subprocess.CompletedProcess(command, 0, stdout)
        with patch('backup.backup', side_effect=ValueError('synthetic disk failure')):
            with self.assertRaisesRegex(ValueError, 'synthetic disk failure'):
                offline_backup(instance, self.root / 'failed.tar.gz', runner=runner)
        self.assertIn(['stop', 'api'], calls)
        self.assertEqual(calls[-1], ['start', 'api'])
        calls.clear()
        wrong = True
        with self.assertRaisesRegex(ValueError, 'mount differs'):
            offline_backup(instance, self.root / 'wrong.tar.gz', runner=runner)
        self.assertNotIn(['stop', 'api'], calls)

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_backup_uses_prepared_environment_for_every_compose_command(self):
        instance, _ = self.prepared()
        calls = []
        def runner(command, **kwargs):
            args = command[6:]
            calls.append(args)
            self.assertNotIn('COMPOSE_PROJECT_NAME', kwargs['env'])
            self.assertFalse(any(key.startswith('OPENGYM_') for key in kwargs['env']))
            if args[0] == 'config':
                return subprocess.run(command, **kwargs)  # Real CLI parser; never the daemon.
            return subprocess.CompletedProcess(command, 0, 'synthetic-api-id' if args[0] == 'ps' else '')
        with patch.dict(os.environ, {'COMPOSE_PROJECT_NAME': 'unrelated-service', 'OPENGYM_PROJECT': 'wrong',
                                     'OPENGYM_DATA_DIR': '/never-touch', 'OPENGYM_RELEASE': 'wrong'}):
            with patch('backup.backup') as save:
                offline_backup(instance, self.root / 'safe.tar.gz', runner=runner)
                save.assert_called_once()
        self.assertIn(['stop', 'api'], calls)
        self.assertEqual(calls[-1], ['start', 'api'])

    def test_backup_refuses_wrong_project_or_pending_configuration_before_stopping(self):
        instance, _ = self.prepared()
        calls = []
        def runner(command, **kwargs):
            args = command[6:]; calls.append(args)
            value = {'name': 'unrelated-service', 'services': {'api': {'volumes': [
                {'type': 'bind', 'target': '/data', 'source': str(instance / 'data')}]}}}
            return subprocess.CompletedProcess(command, 0, json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'project differs'):
            offline_backup(instance, self.root / 'wrong-project.tar.gz', runner=runner)
        self.assertFalse(any(args[0] in ('ps', 'stop', 'start') for args in calls))
        calls.clear(); (instance / PENDING).write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Incomplete catalogue update'):
            offline_backup(instance, self.root / 'pending.tar.gz', runner=runner)
        self.assertEqual(calls, [])

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_catalogue_profile_uses_readonly_data_and_keeps_account_network_boundaries(self):
        instance, _ = self.prepared()
        root, receipt = self.public_catalogue()
        original = (instance / 'data/db.json').read_bytes()
        selection = configure(instance, root, guard=lambda *args: None)
        effective = json.loads((instance / 'compose.yaml').read_text())
        api, web = effective['services']['api'], effective['services']['web']
        self.assertEqual(selection['catalogues'][0]['catalogueSha256'], receipt['catalogueSha256'])
        self.assertEqual(api['build']['target'], 'catalogue')
        self.assertEqual(api['environment']['NUTRITION_LOCAL_CATALOG_KIND'], 'public-registry')
        self.assertEqual(api['environment']['OPENGYM_CATALOG_REGISTRY'], '/catalogues/registry.json')
        self.assertEqual(api['environment']['OPENGYM_SELF_HOSTED_CATALOG'], '1')
        self.assertEqual(api['environment']['OPENGYM_CATALOG_LISTEN_HOST'], '0.0.0.0')
        catalogue_mount = next(item for item in api['volumes'] if item['target'] == '/catalogues')
        self.assertTrue(catalogue_mount['read_only'])
        self.assertFalse(catalogue_mount['bind']['create_host_path'])
        self.assertEqual(set(api['networks']), {'private'})
        self.assertTrue(effective['networks']['private']['internal'])
        self.assertNotIn('ports', api)
        self.assertEqual(web['ports'][0]['host_ip'], '127.0.0.1')
        self.assertEqual(web['build']['args']['NGINX_CONFIG'], 'nginx.catalogue.conf')
        self.assertEqual(api['healthcheck']['test'], ['CMD', 'node', '/app/scripts/self-hosting/health.mjs'])
        self.assertEqual((instance / 'data/db.json').read_bytes(), original)
        for service in (api, web):
            self.assertTrue(service['read_only'])
            self.assertEqual(service['cap_drop'], ['ALL'])
            self.assertEqual(service['security_opt'], ['no-new-privileges:true'])

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_failed_catalogue_inspection_preserves_selected_configuration(self):
        instance, _ = self.prepared()
        root, _ = self.public_catalogue()
        configure(instance, root, guard=lambda *args: None)
        before = {name: (instance / name).read_bytes() for name in ('compose.yaml', 'instance.json')}
        with open(root / 'ciqual-2025/catalog.sqlite', 'ab') as stream:
            stream.write(b'corruption')
        with self.assertRaises(subprocess.CalledProcessError):
            configure(instance, root, guard=lambda *args: None)
        for name, payload in before.items():
            self.assertEqual((instance / name).read_bytes(), payload)

    def test_failed_acquisition_leaves_existing_mode_unchanged(self):
        instance, _ = self.prepared()
        before = {name: (instance / name).read_bytes() for name in ('compose.yaml', 'instance.json', 'data/db.json')}
        calls = []
        def fail(command, **kwargs):
            calls.append(command)
            raise subprocess.CalledProcessError(1, command)
        with self.assertRaises(subprocess.CalledProcessError):
            acquire(instance, runner=fail, guard=lambda *args: None)
        self.assertEqual(len(calls), 1)
        self.assertIn('acquire', calls[0])
        self.assertNotIn('docker', calls[0])
        for name, payload in before.items():
            self.assertEqual((instance / name).read_bytes(), payload)

    def test_catalogue_choices_reject_unavailable_sources_before_creating_instance(self):
        self.assertEqual(plan_catalogues(self.repo, 'recommended'), ['ciqual-2025'])
        self.assertEqual(plan_catalogues(self.repo, 'ciqual,ciqual-2025'), ['ciqual-2025'])
        self.assertEqual(plan_catalogues(self.repo, 'none'), [])
        for choice in ('off', 'wger', 'ciqual,off', 'unknown'):
            with self.subTest(choice=choice):
                target = self.root / ('unavailable-' + choice)
                with self.assertRaisesRegex(ValueError, 'unavailable'):
                    prepare(target, 'https://gym.example.com', repo=self.repo,
                            guard=lambda *args: None, catalogues=choice)
                self.assertFalse(target.exists())

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_prepare_recommended_selects_registry_after_explicit_acquisition(self):
        root, _ = self.public_catalogue()
        instance = self.root / 'recommended-instance'
        def fixture_acquisition(target, guard):
            return configure(target, root, guard=guard)
        with patch('catalogue.acquire', side_effect=fixture_acquisition) as acquisition:
            metadata = prepare(instance, 'https://gym.example.com', repo=self.repo,
                               guard=lambda *args: None, catalogues='recommended')
        self.assertEqual(acquisition.call_count, 1)
        self.assertEqual(metadata['catalogue']['kind'], 'public-registry')
        self.assertEqual(metadata['catalogue']['catalogues'][0]['id'], 'ciqual-2025')
        self.assertEqual(json.loads((instance / 'compose.yaml').read_text())['services']['api']['environment']['OPENGYM_SELF_HOSTED_CATALOG'], '1')

    def test_catalogue_resource_reserve_refuses_snapshot_before_configuration_change(self):
        from types import SimpleNamespace
        instance, _ = self.prepared()
        root, _ = self.public_catalogue()
        before = (instance / 'compose.yaml').read_bytes()
        with patch('state.shutil.disk_usage', return_value=SimpleNamespace(free=20 * 1024 ** 3 - 1)):
            with self.assertRaisesRegex(ValueError, '20 GiB'):
                configure(instance, root)
        self.assertEqual((instance / 'compose.yaml').read_bytes(), before)
        self.assertFalse((instance / 'catalogues/registry.json').exists())

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_registry_migrates_single_selection_and_retains_previous_generations_on_remove(self):
        instance, metadata = self.prepared()
        root, receipt = self.public_catalogue()
        metadata['catalogue'] = {**receipt, 'root': str(root)}
        (instance / 'instance.json').write_text(json.dumps(metadata))
        private_state = (instance / 'data/db.json').read_bytes()
        first = configure(instance, root, guard=lambda *args: None)
        old_directory = instance / 'catalogues' / first['catalogues'][0]['directory']
        old_bytes = (old_directory / 'catalog.sqlite').read_bytes()
        with closing(sqlite3.connect(root / 'ciqual-2025/catalog.sqlite')) as connection:
            connection.execute('INSERT INTO foods VALUES(?,?)', ('ciqual:2', 'Another synthetic food'))
            connection.commit()
        receipt.update(rows=2, usableFoodCount=2, completeFoodCount=2,
                       catalogueSha256=hashlib.sha256((root / 'ciqual-2025/catalog.sqlite').read_bytes()).hexdigest())
        (root / 'ciqual-2025/receipt.json').write_text(json.dumps(receipt))
        second = configure(instance, root, guard=lambda *args: None)
        self.assertNotEqual(first['catalogues'][0]['directory'], second['catalogues'][0]['directory'])
        self.assertEqual((old_directory / 'catalog.sqlite').read_bytes(), old_bytes)
        self.assertTrue(list((instance / 'catalogues').glob('registry-*.json')))
        configure(instance, remove='ciqual-2025')
        registry = load_registry(instance)
        self.assertFalse(registry['catalogues'][0]['enabled'])
        self.assertTrue(old_directory.exists())
        self.assertTrue((instance / 'catalogues' / second['catalogues'][0]['directory']).exists())
        self.assertEqual((instance / 'data/db.json').read_bytes(), private_state)
        effective = json.loads((instance / 'compose.yaml').read_text())
        self.assertEqual(effective['services']['api']['environment']['NUTRITION_LOCAL_CATALOG'], '1')
        self.assertEqual(effective['services']['api']['environment']['NUTRITION_LOCAL_CATALOG_KIND'], 'public-registry')
        restored = configure(instance, old_directory, generation=True, guard=lambda *args: None)
        self.assertEqual(restored['catalogues'][0]['catalogueSha256'], first['catalogues'][0]['catalogueSha256'])
        self.assertEqual((old_directory / 'catalog.sqlite').read_bytes(), old_bytes)

    def test_registry_rejects_unsafe_directory_and_unknown_schema(self):
        instance, _ = self.prepared()
        (instance / 'catalogues').mkdir()
        for value in [[], {'format': 'wrong', 'version': 1, 'catalogues': []},
                      {'format': 'opengym-public-catalogue-registry', 'version': 1, 'catalogues': [
                          {'id': 'escape', 'kind': 'ciqual-local', 'directory': '../data', 'enabled': True, 'catalogueSha256': 'a' * 64}]}]:
            with self.subTest(value=value):
                (instance / 'catalogues/registry.json').write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    load_registry(instance)

    def test_apply_is_an_explicit_operator_action_with_no_image_build(self):
        instance, _ = self.prepared()
        calls = []
        def runner(command, **kwargs):
            calls.append(command[6:])
            if command[-3:] == ['config', '--format', 'json']:
                return subprocess.run(command, **kwargs)
            return subprocess.CompletedProcess(command, 0)
        apply(instance, runner=runner)
        self.assertEqual(calls[-2:], [['config', '--quiet'], ['up', '-d', '--no-build', '--force-recreate', 'api', 'web']])

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_interrupted_three_file_publication_refuses_apply_and_inspect_until_recovered(self):
        root, _ = self.public_catalogue()
        for stop_after in (0, 1, 2, 3):
            with self.subTest(completed_files=stop_after):
                instance, _ = self.prepared('interrupted-' + str(stop_after))
                first = configure(instance, root, guard=lambda *args: None)
                original_data = (instance / 'data/db.json').read_bytes()
                snapshot = instance / 'catalogues' / first['catalogues'][0]['directory']
                original_catalogue = (snapshot / 'catalog.sqlite').read_bytes()
                original_registry = (instance / CONFIG_FILES[0]).read_bytes()
                completed = 0
                def interrupted(path, content):
                    nonlocal completed
                    atomic_write(path, content)
                    relative = path.relative_to(instance).as_posix()
                    if relative in CONFIG_FILES:
                        completed += 1
                    if (stop_after == 0 and relative == PENDING) or (relative in CONFIG_FILES and completed == stop_after):
                        raise OSError('simulated publication interruption')
                with patch('catalogue.atomic_write', side_effect=interrupted):
                    with self.assertRaisesRegex(OSError, 'simulated publication interruption'):
                        configure(instance, remove='ciqual-2025')
                self.assertTrue((instance / PENDING).exists())
                calls = []
                def runner(command, **kwargs):
                    calls.append(command)
                    return subprocess.CompletedProcess(command, 0)
                for action in (apply, inspect_selected):
                    with self.assertRaisesRegex(ValueError, 'recover'):
                        action(instance, runner=runner)
                self.assertEqual(calls, [])
                with self.assertRaisesRegex(ValueError, 'recover'):
                    configure(instance, root, guard=lambda *args: None)
                selection = recover(instance, runner=runner)
                self.assertFalse(selection['catalogues'][0]['enabled'])
                self.assertFalse((instance / PENDING).exists())
                configuration_consistent(instance)
                self.assertEqual(calls, [])  # Recovery starts no container/service.
                self.assertEqual((instance / 'data/db.json').read_bytes(), original_data)
                self.assertEqual((snapshot / 'catalog.sqlite').read_bytes(), original_catalogue)
                saved_registry = instance / 'catalogues' / ('registry-' + hashlib.sha256(original_registry).hexdigest() + '.json')
                self.assertEqual(saved_registry.read_bytes(), original_registry)
                apply(instance, runner=runner)
                self.assertEqual(len(calls), 2)
                self.assertEqual(calls[-1][-6:], ['up', '-d', '--no-build', '--force-recreate', 'api', 'web'])

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_tampered_recovery_payload_is_rejected_without_publishing(self):
        instance, _ = self.prepared()
        root, _ = self.public_catalogue()
        configure(instance, root, guard=lambda *args: None)
        def stop(path, content):
            atomic_write(path, content)
            if path.name == PENDING:
                raise OSError('simulated interruption before files')
        with patch('catalogue.atomic_write', side_effect=stop):
            with self.assertRaises(OSError):
                configure(instance, remove='ciqual-2025')
        before = {name: (instance / name).read_bytes() for name in CONFIG_FILES}
        journal = json.loads((instance / PENDING).read_text())
        journal['files']['compose.yaml']['content'] += 'corruption'
        (instance / PENDING).write_text(json.dumps(journal))
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            recover(instance)
        self.assertTrue((instance / PENDING).exists())
        for name, content in before.items():
            self.assertEqual((instance / name).read_bytes(), content)

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_apply_refuses_changes_after_committed_hashes(self):
        instance, _ = self.prepared()
        root, _ = self.public_catalogue()
        configure(instance, root, guard=lambda *args: None)
        metadata = json.loads((instance / 'instance.json').read_text())
        metadata['release'] = 'unreviewed-build'
        (instance / 'instance.json').write_text(json.dumps(metadata))
        calls = []
        with self.assertRaisesRegex(ValueError, 'changed after publication'):
            apply(instance, runner=lambda command, **kwargs: calls.append(command))
        self.assertEqual(calls, [])

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_ambient_opengym_environment_does_not_override_reviewed_instance(self):
        instance, metadata = self.prepared()
        with patch.dict(os.environ, {'OPENGYM_ORIGIN': 'https://different.example.com',
                                    'OPENGYM_RP_ID': 'different.example.com', 'OPENGYM_RELEASE': 'unreviewed-build',
                                    'OPENGYM_SOURCE': '/unreviewed', 'OPENGYM_UID': '0', 'OPENGYM_GID': '0',
                                    'OPENGYM_INSTANCE_MODE': 'multi-user', 'OPENGYM_SIGNUP_POLICY': 'public', 'OPENGYM_MAX_USERS': '1000',
                                    'COMPOSE_PROJECT_NAME': 'unreviewed-project'}):
            effective = compose_config(instance)
        api = effective['services']['api']
        self.assertEqual(api['environment']['ORIGIN'], metadata['origin'])
        self.assertEqual(api['environment']['RP_ID'], 'gym.example.com')
        self.assertEqual(api['image'], 'opengym-selfhost-api:' + metadata['release'])
        self.assertEqual(api['build']['context'], str(instance / 'source'))
        self.assertEqual(api['user'], str(os.getuid()) + ':' + str(os.getgid()))
        self.assertEqual(effective['name'], 'opengym-selfhost')
        self.assertEqual(api['environment']['OPENGYM_INSTANCE_MODE'], 'personal')
        self.assertEqual(api['environment']['OPENGYM_SIGNUP_POLICY'], 'invite')
        self.assertEqual(api['environment']['OPENGYM_MAX_USERS'], '1')

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_catalogue_backup_reference_restore_and_disable_preserve_private_data(self):
        instance, _ = self.prepared()
        root, receipt = self.public_catalogue()
        configure(instance, root, guard=lambda *args: None)
        data = self.data(instance)
        archive = self.root / 'catalogue-account-backup.tar.gz'
        metadata = json.loads((instance / 'instance.json').read_text())
        backup(data, archive, metadata, guard=lambda *args: None)
        with tarfile.open(archive) as saved:
            provenance = json.load(saved.extractfile('opengym-backup.json'))
            self.assertEqual(provenance['catalogue']['catalogues'][0]['catalogueSha256'], receipt['catalogueSha256'])
            self.assertFalse(any('catalog.sqlite' in name for name in saved.getnames()))
        restored, restored_meta = self.prepared('restored-ciqual', archive=archive)
        self.assertEqual(restored_meta['restoredCatalogue']['catalogues'][0]['catalogueSha256'], receipt['catalogueSha256'])
        self.assertEqual(restored_meta['catalogue'], 'none')
        configure(restored, root, guard=lambda *args: None)
        before = (restored / 'data/db.json').read_bytes()
        configure(restored)
        effective = json.loads((restored / 'compose.yaml').read_text())
        self.assertEqual(effective['services']['api']['environment']['NUTRITION_LOCAL_CATALOG'], '1')
        self.assertEqual(effective['services']['api']['environment']['NUTRITION_LOCAL_CATALOG_KIND'], 'public-registry')
        self.assertTrue(any(item['target'] == '/catalogues' and item['read_only'] for item in effective['services']['api']['volumes']))
        self.assertTrue(all(not item['enabled'] for item in load_registry(restored)['catalogues']))
        self.assertEqual((restored / 'data/db.json').read_bytes(), before)
        self.assertTrue((root / 'ciqual-2025/catalog.sqlite').exists())

    @unittest.skipUnless(shutil.which('node'), 'Node unavailable for readiness probe test')
    def test_catalogue_health_probe_requires_storage_account_policy_and_authentication(self):
        for status, writable, invite_only, expected in [(401, True, True, 0), (200, True, True, 1), (503, True, True, 1), (401, False, True, 1), (401, True, False, 1)]:
            with self.subTest(catalogue_status=status, writable=writable, invite_only=invite_only):
                program = '''globalThis.fetch = async url => ({
status: url.endsWith('/capabilities') ? Number(process.argv[1]) : 200,
json: async () => url.endsWith('/health') ? {writable:process.argv[3]==='true'} : {allow_guest:false,invite_only:process.argv[4]==='true'}
}); await import(process.argv[2]);'''
                result = subprocess.run(['node', '--input-type=module', '-e', program, str(status), (TOOLS / 'health.mjs').as_uri(), str(writable).lower(), str(invite_only).lower()], capture_output=True, text=True)
                self.assertEqual(result.returncode, expected, result.stderr)

    @unittest.skipUnless(shutil.which('node'), 'Node unavailable for readiness probe test')
    def test_health_accepts_multi_user_public_bootstrap_transition_and_checks_declared_policy(self):
        cases = [('personal', 'invite', 1, True, 1, 0),
                 ('multi-user', 'invite', 100, True, 100, 0),
                 ('multi-user', 'public', 100, True, 100, 0),
                 ('multi-user', 'public', 100, False, 100, 0),
                 ('personal', 'invite', 1, False, 1, 1),
                 ('multi-user', 'public', 100, False, 999, 1)]
        for mode, signup, limit, invite_only, reported_limit, expected in cases:
            with self.subTest(mode=mode, signup=signup, invite_only=invite_only, reported_limit=reported_limit):
                body = {'allow_guest': False, 'invite_only': invite_only, 'instance_mode': mode,
                        'signup_policy': signup, 'max_users': reported_limit, 'registration_open': True}
                program = '''process.env.OPENGYM_INSTANCE_MODE=process.argv[1];process.env.OPENGYM_LISTEN_HOST='127.0.0.1';
process.env.OPENGYM_SIGNUP_POLICY=process.argv[2];process.env.OPENGYM_MAX_USERS=process.argv[3];
globalThis.fetch=async url=>({status:url.endsWith('/capabilities')?401:200,
json:async()=>url.endsWith('/health')?{writable:true}:JSON.parse(process.argv[4])});
await import(process.argv[5]);'''
                result = subprocess.run(['node', '--input-type=module', '-e', program, mode, signup,
                                         str(limit), json.dumps(body), (TOOLS / 'health.mjs').as_uri()], capture_output=True, text=True)
                self.assertEqual(result.returncode, expected, result.stderr)

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable')
    def test_real_compose_parser_and_network_resource_boundaries(self):
        instance, _ = self.prepared()
        result = subprocess.run(['docker', 'compose', '--env-file', str(instance / 'instance.env'), '-f', str(instance / 'compose.yaml'), 'config', '--format', 'json'], check=True, text=True, capture_output=True)
        config = json.loads(result.stdout)
        api, web = config['services']['api'], config['services']['web']
        self.assertTrue(config['networks']['private']['internal'])
        self.assertEqual(set(api['networks']), {'private'})
        self.assertNotIn('ports', api)
        self.assertEqual(web['ports'][0]['host_ip'], '127.0.0.1')
        self.assertEqual(api['environment']['INVITE_ONLY'], '1')
        self.assertEqual(api['environment']['NUTRITION_LOCAL_CATALOG'], '0')
        self.assertEqual(api['mem_limit'], '536870912')
        self.assertEqual(web['mem_limit'], '134217728')
        self.assertEqual(web['tmpfs'], ['/tmp:rw,nosuid,nodev,size=64m,mode=1777'])
        for service in (api, web):
            self.assertTrue(service['read_only'])
            self.assertEqual(service['cap_drop'], ['ALL'])


if __name__ == '__main__':
    unittest.main()
