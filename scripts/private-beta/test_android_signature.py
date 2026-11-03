"""No SDK, network, keystore or real account needed: public metadata fixtures only."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('verify-android-signature.py')
spec = importlib.util.spec_from_file_location('android_signature', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SignatureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='opengym-signature-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.certificate = self.root / 'public.der'
        self.certificate.write_bytes(b'Synthetic public certificate bytes; not a private key')
        self.fingerprint = hashlib.sha256(self.certificate.read_bytes()).hexdigest()
        self.report = self.root / 'report.txt'
        self.report.write_text(f'Signer #1 certificate SHA-256 digest: {self.fingerprint}\n')

    def test_same_certificate(self):
        self.assertEqual(module.verify(self.certificate, self.report), self.fingerprint)

    def test_uppercase_fingerprint(self):
        self.report.write_text(f'Signer #1 certificate SHA-256 digest: {self.fingerprint.upper()}\n')
        self.assertEqual(module.verify(self.certificate, self.report), self.fingerprint)

    def test_observed_ephemeral_signer_is_rejected(self):
        # Public certificate fingerprint of the rejected 41664952165 artifact.
        other = 'a0750170dccbe7ddc51fef2b0780497e02bab3495fc6f91adcecb36aaf0f71d7'
        self.report.write_text(f'Signer #1 certificate SHA-256 digest: {other}\n')
        with self.assertRaisesRegex(ValueError, 'does not match'):
            module.verify(self.certificate, self.report)
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.certificate), str(self.report)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(self.certificate.read_bytes(), result.stdout + result.stderr)

    def test_multiple_signers_rejected(self):
        self.report.write_text(self.report.read_text() + f'Signer #2 certificate SHA-256 digest: {self.fingerprint}\n')
        with self.assertRaises(ValueError):
            module.verify(self.certificate, self.report)

    def test_missing_or_malformed_digest_rejected(self):
        for text in ['', 'No signer', 'Signer #1 certificate SHA-256 digest: abcd\n']:
            with self.subTest(text=text):
                self.report.write_text(text)
                with self.assertRaises(ValueError):
                    module.verify(self.certificate, self.report)

    def test_oversized_public_metadata_rejected(self):
        for target in [self.certificate, self.report]:
            original = target.read_bytes()
            target.write_bytes(b'x' * 65537)
            with self.assertRaises(ValueError):
                module.verify(self.certificate, self.report)
            target.write_bytes(original)

    def test_invalid_utf8_rejected(self):
        self.report.write_bytes(b'\xff')
        with self.assertRaises(ValueError):
            module.verify(self.certificate, self.report)

    def test_cli_public_pin_accepts_and_rejects(self):
        for pin, accepted in [(self.fingerprint, True), ('0' * 64, False), ('not-a-pin', False)]:
            with self.subTest(pin=pin):
                result = subprocess.run([sys.executable, str(SCRIPT), '--sha256', pin, str(self.report)], capture_output=True)
                self.assertEqual(result.returncode == 0, accepted)

    def test_cli_accepts_matching_certificate(self):
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.certificate), str(self.report)], capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'APK signature verified', result.stdout)


if __name__ == '__main__':
    unittest.main()
