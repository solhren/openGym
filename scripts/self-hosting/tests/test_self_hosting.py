import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
REPO = TOOLS.parents[1]
sys.path.insert(0, str(TOOLS))
from prepare import browser_origin, prepare
from state import backup, restore
from backup import offline_backup


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

    def test_prepare_private_invite_tracked_snapshot_and_repeat_refusal(self):
        instance, metadata = self.prepared()
        self.assertEqual(metadata['catalogue'], 'none')
        self.assertEqual(metadata['apiEgress'], False)
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
                stdout = json.dumps({'services': {'api': {'volumes': [{'type': 'bind', 'target': '/data', 'source': str(instance / ('wrong' if wrong else 'data'))}]}}})
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
