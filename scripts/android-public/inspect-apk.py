"""Bounded inspection of a compiled APK; signing is verified separately by apksigner."""
import json
from pathlib import Path
import re
import sys
import zipfile


def inspect(apk, permissions):
    if Path(apk).stat().st_size > 512 * 1024**2:
        raise ValueError('APK exceeds inspection limit')
    required = {'android.permission.INTERNET', 'android.permission.CAMERA'}
    names = set(re.findall(r"uses-permission(?:-sdk-23)?: name='([^']+)'", permissions))
    if not required <= names:
        raise ValueError('Missing Internet or scanner camera permission')
    checked = 0
    with zipfile.ZipFile(apk) as archive:
        entries = archive.infolist()
        if len(entries) > 50000 or sum(v.file_size for v in entries) > 1024**3:
            raise ValueError('APK archive exceeds inspection limit')
        if len({v.filename for v in entries}) != len(entries):
            raise ValueError('Duplicate APK archive entries')
        for key in ['assets/public/index.html','assets/capacitor.config.json']:
            if archive.getinfo(key).file_size > 1024**2:
                raise ValueError('Oversized package configuration')
        html = archive.read('assets/public/index.html').decode('utf-8')
        if 'name="opengym-distribution" content="selfhosted"' not in html:
            raise ValueError('Missing self-hosted bundle marker')
        config = json.loads(archive.read('assets/capacitor.config.json'))
        if config.get('server', {}).get('url'):
            raise ValueError('Remote Capacitor shell forbidden')
        for entry in entries:
            name = entry.filename
            if name.startswith('/') or '..' in name.split('/'):
                raise ValueError('Unsafe APK entry')
            if name.endswith(('.keystore', '.jks', '.pem', '.key')) or Path(name).name.startswith('.env'):
                raise ValueError('Private file in APK')
            if not name.startswith('assets/') or not name.endswith(('.html', '.js', '.json', '.css', '.txt')):
                continue
            if entry.file_size > 32 * 1024**2:
                raise ValueError('Oversized text asset')
            data = archive.read(entry)
            if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}', data):
                raise ValueError('Potential secret in APK')
            checked += 1
    return {'permissions': sorted(names), 'textAssetsChecked': checked,
            'remoteShell': False, 'physicalDeviceTested': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Usage: inspect-apk.py APK AAPT_PERMISSIONS_FILE')
        print(json.dumps(inspect(sys.argv[1], Path(sys.argv[2]).read_text())))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
