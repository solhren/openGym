"""Compare apksigner's verified signer with a keytool-exported public certificate.

The caller must first run `apksigner verify --print-certs`. This comparison binds
that valid signature to the retained key; it does not replace APK verification.
Neither input contains a private key or a password.
"""
import hashlib
from pathlib import Path
import re
import sys


def verify(certificate, report):
    certificate, report = Path(certificate), Path(report)
    if not 0 < certificate.stat().st_size <= 65536:
        raise ValueError('Invalid public signing metadata size')
    expected = hashlib.sha256(certificate.read_bytes()).hexdigest()
    return verify_pinned(expected, report)


def verify_pinned(expected, report):
    """Distribution needs only the pinned public fingerprint, never a private key."""
    report = Path(report)
    if not re.fullmatch(r'[0-9a-f]{64}', expected) or not 0 < report.stat().st_size <= 65536:
        raise ValueError('Invalid public signing metadata size')
    actual = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$',
                        report.read_text(encoding='utf-8'), re.MULTILINE)
    if len(actual) != 1 or actual[0].lower() != expected:
        raise ValueError('APK signing certificate does not match the retained debug key')
    return expected


if __name__ == '__main__':
    try:
        if len(sys.argv) == 4 and sys.argv[1] == '--sha256':
            verify_pinned(sys.argv[2], sys.argv[3])
        elif len(sys.argv) == 3:
            verify(sys.argv[1], sys.argv[2])
        else:
            raise ValueError('Usage: verify-android-signature.py CERTIFICATE_DER APKSIGNER_REPORT | --sha256 PUBLIC_FINGERPRINT APKSIGNER_REPORT')
        print('APK signature verified against the retained debug key')
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
