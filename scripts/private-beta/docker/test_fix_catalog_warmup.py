import importlib.util
import json
import os
import pwd
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

folder = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('warmup_fix', folder/'fix-catalog-warmup.py')
fix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fix)


class InstalledWarmupFixTests(unittest.TestCase):
    def setUp(self):
        environment=patch.dict(os.environ,{"OPENGYM_DEPLOY_OWNER":pwd.getpwuid(os.getuid()).pw_name},clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        runtime = folder.parents[1]/'nutrition-local-catalog/runtime'
        self.tmp = tempfile.TemporaryDirectory(prefix='private-beta-warmup-test-', dir=runtime)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.context = self.root/'source'
        self.file = self.context/fix.TARGET
        self.file.parent.mkdir(parents=True)
        current = (folder.parents[1]/'nutrition-local-catalog/wger-off-reference.py').read_bytes()
        self.file.write_bytes(current.replace(fix.NEW, fix.OLD))
        self.seed()
        for name in ('compose.json', 'compose.lab.json', 'deployment.sha256', 'catalogues.sha256', 'volume-sentinel'):
            (self.root/name).write_text('unchanged '+name)

    def seed(self):
        rows = [{'name': fix.TARGET, 'sha256': fix.sha(self.file.read_bytes())}]
        (self.root/'source-inventory.json').write_text(json.dumps(rows))
        (self.root/'source.sha256').write_text(''.join(v['sha256']+'  source/'+v['name']+'\n' for v in rows))
        (self.root/'prepared.json').write_text(json.dumps({'format': 'opengym-personal-compose-preparation', 'version': 1,
            'complete': True, 'sourceSha256': fix.inventory_hash(rows), 'sourceBytes': self.file.stat().st_size, 'release': 'retain-both-image-tags'}))

    def test_installed_source_patch_keeps_deadline_updates_inventory_and_preserves_every_other_file(self):
        original = self.file.read_bytes()
        before = {p.name: p.read_bytes() for p in self.root.iterdir() if p.is_file()}
        backup = fix.patch(self.root, self.context)
        self.assertEqual(self.file.read_bytes(), original.replace(fix.OLD, fix.NEW))
        self.assertEqual((backup/'reader.py').read_bytes(), original)
        self.assertIn(b'deadline=time.monotonic()+2;', self.file.read_bytes())
        rows = json.loads((self.root/'source-inventory.json').read_text())
        receipt = json.loads((self.root/'prepared.json').read_text())
        self.assertEqual(rows[0]['sha256'], fix.sha(self.file.read_bytes()))
        self.assertEqual(receipt['sourceSha256'], fix.inventory_hash(rows))
        self.assertEqual(receipt['release'], 'retain-both-image-tags')
        self.assertEqual(len(receipt['patches']), 1)
        self.assertIn(fix.sha(self.file.read_bytes()), (self.root/'source.sha256').read_text())
        for name in ('compose.json', 'compose.lab.json', 'deployment.sha256', 'catalogues.sha256', 'volume-sentinel'):
            self.assertEqual((self.root/name).read_bytes(), before[name])
        self.assertIsNone(fix.patch(self.root, self.context))
        self.assertEqual(len(list(self.root.glob('catalog-warmup-backup-*'))), 1)

    def test_unrecorded_edits_are_not_overwritten(self):
        changed = self.file.read_bytes()+b'\n# user edit\n'
        self.file.write_bytes(changed)
        with self.assertRaisesRegex(ValueError, 'unrecorded changes'):
            fix.patch(self.root, self.context)
        self.assertEqual(self.file.read_bytes(), changed)
        self.assertFalse(list(self.root.glob('catalog-warmup-backup-*')))

    def test_patch_refuses_an_already_modified_security_deadline(self):
        original = self.file.read_bytes()
        for already_corrected in (False, True):
            raw = original.replace(fix.OLD, fix.NEW) if already_corrected else original
            self.file.write_bytes(raw.replace(b'deadline=time.monotonic()+2;', b'deadline=time.monotonic()+9;'))
            self.seed()
            with self.assertRaisesRegex(ValueError, 'deadline'):
                fix.patch(self.root, self.context)
        self.assertFalse(list(self.root.glob('catalog-warmup-backup-*')))

    def test_actual_context_is_resolved_from_both_compose_configurations_without_starting_containers(self):
        output = json.dumps({'services': {'backend': {'build': {'context': str(self.context)}}}}).encode()
        with patch.object(fix.subprocess, 'check_output', return_value=output) as render:
            self.assertEqual(fix.resolve_context(self.root), self.context)
            self.assertEqual(render.call_count, 2)
            self.assertTrue(all(c.args[0][-3:] == ['config', '--format', 'json'] for c in render.call_args_list))


if __name__ == '__main__':
    unittest.main()
