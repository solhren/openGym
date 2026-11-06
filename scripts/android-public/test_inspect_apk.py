import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
spec=importlib.util.spec_from_file_location('apk_inspect',Path(__file__).with_name('inspect-apk.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PERMISSIONS="uses-permission: name='android.permission.INTERNET'\nuses-permission: name='android.permission.CAMERA'"
class InspectionTests(unittest.TestCase):
    def fixture(self, extra=None, config=None):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        apk=Path(folder.name)/'fixture.apk'
        with zipfile.ZipFile(apk,'w') as z:
            z.writestr('assets/public/index.html','<meta name="opengym-distribution" content="selfhosted">')
            z.writestr('assets/capacitor.config.json',json.dumps(config or {'appId':'org.example'}))
            for name,value in (extra or {}).items():z.writestr(name,value)
        return apk
    def test_local_shell_permissions_and_bounded_text_evidence(self):
        r=m.inspect(self.fixture(),PERMISSIONS)
        self.assertFalse(r['remoteShell']);self.assertEqual(r['textAssetsChecked'],2)
        with self.assertRaises(ValueError):m.inspect(self.fixture(),'')
    def test_remote_shell_private_files_and_traversal_are_rejected(self):
        with self.assertRaises(ValueError):m.inspect(self.fixture(config={'server':{'url':'https://example.com'}}),PERMISSIONS)
        for name in ['assets/key.jks','assets/.env','../escape.txt']:
            with self.subTest(name=name),self.assertRaises(ValueError):m.inspect(self.fixture({name:'synthetic'}),PERMISSIONS)
    def test_secret_detection_and_corrupt_apk(self):
        with self.assertRaises(ValueError):m.inspect(self.fixture({'assets/public/private.txt':'-----BEGIN PRIVATE KEY-----'}),PERMISSIONS)
        apk=self.fixture();apk.write_bytes(b'not an apk')
        with self.assertRaises(zipfile.BadZipFile):m.inspect(apk,PERMISSIONS)
