import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from deployment_owner import verify_deployment_owner

class OwnerTests(unittest.TestCase):
    def check_owner(self, uid=1234, real=None, file_uid=None, env=None):
        name='root' if uid == 0 else 'fixture-owner'
        root=SimpleNamespace(stat=lambda: SimpleNamespace(st_uid=uid if file_uid is None else file_uid))
        with patch.dict(os.environ, env or {}, clear=True), patch('os.geteuid',return_value=uid), patch('os.getuid',return_value=uid if real is None else real), patch('pwd.getpwuid',return_value=SimpleNamespace(pw_name=name)):
            return verify_deployment_owner(root)

    def test_current_owner_default_and_explicit(self):
        self.assertEqual(self.check_owner(),1234)
        self.assertEqual(self.check_owner(env={'OPENGYM_DEPLOY_OWNER':'fixture-owner'}),1234)

    def test_wrong_owner_unowned_directory_sudo_and_setuid_refused(self):
        for options in [{'env':{'OPENGYM_DEPLOY_OWNER':'other'}},{'file_uid':999},{'real':999},{'env':{'SUDO_USER':'admin'}},{'env':{'SUDO_UID':'0'}}]:
            with self.subTest(options=options), self.assertRaises(ValueError):self.check_owner(**options)

    def test_root_is_never_implicit_and_explicit_root_still_checks_ownership_and_sudo(self):
        with self.assertRaises(ValueError):self.check_owner(uid=0)
        self.assertEqual(self.check_owner(uid=0,env={'OPENGYM_DEPLOY_OWNER':'root'}),0)
        for options in [{'file_uid':999},{'env':{'OPENGYM_DEPLOY_OWNER':'root','SUDO_USER':'admin'}}]:
            with self.subTest(options=options), self.assertRaises(ValueError):self.check_owner(uid=0,**options)
