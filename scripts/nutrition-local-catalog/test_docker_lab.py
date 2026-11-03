import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from catalog import Catalog, CatalogError, build, workspace
from test_catalog import record, protocol, preserve_address_space_limit
spec=importlib.util.spec_from_file_location('docker_lab',Path(__file__).with_name('docker-lab.py'))
lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab)

class DockerLabTest(unittest.TestCase):
    def setUp(self):
        preserve_address_space_limit(self)
    def test_public_clone_permissions_and_source_integrity_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder, patch('catalog.BASE',Path(folder)):
            root=workspace('source');build(root,io.BytesIO(protocol([record()])))
            before=(root/'current.json').read_bytes();source_mode=root.stat().st_mode
            result=lab.prepare('source','clone')
            with contextlib.closing(Catalog(Path(result['directory']))) as reader:self.assertEqual(reader.barcode('00012345'),record())
            self.assertEqual((root/'current.json').read_bytes(),before);self.assertEqual(root.stat().st_mode,source_mode)
            self.assertEqual(Path(result['directory']).stat().st_mode&0o777,0o755)
            with self.assertRaises(FileExistsError):lab.prepare('source','clone')
    def test_corruption_only_targets_new_copy_and_source_remains_readable(self):
        with tempfile.TemporaryDirectory() as folder, patch('catalog.BASE',Path(folder)):
            root=workspace('source');build(root,io.BytesIO(protocol([record()])))
            result=lab.prepare('source','bad-copy',True)
            with self.assertRaises(CatalogError):Catalog(Path(result['directory']))
            with contextlib.closing(Catalog(root)) as reader:self.assertEqual(reader.barcode('00012345'),record())
            with self.assertRaises(CatalogError):lab.prepare('source','source')

if __name__=='__main__':unittest.main()
