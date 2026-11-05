import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from doctor import diagnose, compose_available
from prepare import prepare


class DoctorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.instance = self.root / 'instance'
        self.options = dict(find=lambda name: '/fixture/' + name, compose=lambda: True,
                            probe=lambda port: False, disk=lambda path: SimpleNamespace(free=22 * 1024 ** 3), memory=3 * 1024 ** 3)

    def check(self, **options):
        return diagnose(self.instance, **{**self.options, **options})

    def prepared(self):
        self.instance.mkdir()
        for name in ('source', 'data'):
            (self.instance / name).mkdir(mode=0o700)
        for name in ('instance.env', 'source-inventory.json', 'compose.yaml'):
            (self.instance / name).write_text('PRIVATE_SENTINEL_NOT_TO_READ')
            (self.instance / name).chmod(0o600)
        (self.instance / 'data/db.json').write_text('PRIVATE_SENTINEL_NOT_TO_READ')
        (self.instance / 'instance.json').write_text(json.dumps({
            'format': 'opengym-selfhost-instance', 'version': 1, 'origin': 'https://gym.example.com',
            'instanceMode': 'multi-user', 'signupPolicy': 'invite', 'maxUsers': 20}))

    def test_new_destination_prerequisites_and_port_are_checked_without_creation(self):
        rows = self.check()
        self.assertFalse(any(x['level'] == 'error' for x in rows))
        self.assertFalse(self.instance.exists())
        self.assertTrue(any(x['code'] == 'new' for x in rows))
        self.assertEqual(self.check(probe=lambda _: True)[-1]['level'], 'warning')
        self.assertIn('do not stop another service', self.check(probe=lambda _: True)[-1]['message'])

    def test_missing_clients_low_resources_and_inaccessible_port_are_explicit(self):
        rows = self.check(find=lambda _: None, memory=1024)
        self.assertEqual({x['code'] for x in rows if x['level'] == 'error'}, {'git', 'docker', 'resources'})
        def denied(_): raise PermissionError()
        self.assertEqual(self.check(probe=denied)[-1]['level'], 'warning')

    def test_existing_instance_does_not_read_or_print_private_data_and_is_unchanged(self):
        self.prepared()
        def inventory(): return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.instance.rglob('*') if p.is_file()}
        before = inventory()
        original = Path.read_text
        def guarded(path, *args, **kwargs):
            if path.name in ('instance.env', 'db.json', 'secret', 'bootstrap-invite.txt'):
                raise AssertionError('private file read')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', guarded):
            rows = self.check()
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(rows))
        self.assertIn('multi-user, signup invite, limit 20', json.dumps(rows))
        self.assertEqual(inventory(), before)

    def test_interrupted_catalogue_has_recovery_instruction_without_executing_it(self):
        self.prepared()
        (self.instance / '.catalogue-update.json').write_text('{}')
        rows = self.check()
        self.assertTrue(any(x['code'] == 'catalogue-pending' and x['level'] == 'error' for x in rows))
        self.assertTrue((self.instance / '.catalogue-update.json').exists())

    def test_partial_preparation_and_oversized_metadata_remain_untouched(self):
        self.instance.mkdir()
        survivor = self.instance / 'keep.txt'
        survivor.write_text('keep')
        self.assertTrue(any(x['code'] == 'incomplete' for x in self.check()))
        (self.instance / 'instance.json').write_text(' ' * 16385)
        self.assertTrue(any(x['code'] == 'incomplete' for x in self.check()))
        self.assertEqual(survivor.read_text(), 'keep')

    def test_symlinks_are_not_followed(self):
        self.instance.symlink_to(self.root, target_is_directory=True)
        self.assertTrue(any(x['code'] == 'path' for x in self.check()))

    def test_compose_check_is_client_only_and_bounded(self):
        with patch('doctor.subprocess.run', return_value=SimpleNamespace(returncode=0)) as run:
            self.assertTrue(compose_available())
            self.assertEqual(run.call_args.args[0], ['docker', 'compose', 'version', '--short'])
            self.assertEqual(run.call_args.kwargs['timeout'], 5)
        with patch('doctor.subprocess.run', side_effect=FileNotFoundError):
            self.assertFalse(compose_available())

    def test_localhost_port_mismatch_fails_before_creating_anything(self):
        with self.assertRaisesRegex(ValueError, 'same port'):
            prepare(self.instance, 'http://localhost:8080', port=8081)
        self.assertFalse(self.instance.exists())


if __name__ == '__main__':
    unittest.main()
