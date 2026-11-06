"""Publish only a verified personal APK using the repository's Actions token.

No private signing key is needed. GITHUB_TOKEN deliberately suppresses release
workflow cascades, especially the existing Docker publisher. Run via Tests' manual
android_release_run input; never invoke publication with a personal token locally.
"""
import urllib.parse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

REPO = 'solhren/openGym'
TAG = 'android-personal-beta'
TITLE = 'openGym — Bêta Android personnelle'
APK = 'opengym-beta-debug.apk'
PIN = '8c883ac845e2abd0d04e9f6230cf5362e5c61f749723b55c09fbf456881218d8'
MARKER = '<!-- opengym-personal-beta-v1 '
MAX_APK = 512 * 1024 * 1024


def require(ok, message):
    if not ok:
        raise ValueError(message)


def validate_run(run, jobs):
    require(run.get('repository', {}).get('full_name') == REPO and run.get('head_repository', {}).get('full_name') == REPO, 'Unexpected source repository')
    require(run.get('actor', {}).get('login') == REPO.split('/')[0] and run.get('head_branch') == 'feature/nutrition', 'Unexpected source actor or branch')
    require(run.get('event') == 'workflow_dispatch' and run.get('path') == '.github/workflows/test.yml', 'Unexpected source workflow')
    require(run.get('status') == 'completed' and run.get('conclusion') == 'success', 'Source run is not successful')
    require(type(run.get('run_attempt')) is int and run['run_attempt'] > 0 and re.fullmatch('[0-9a-f]{40}', run.get('head_sha', '')), 'Invalid source revision')
    required = {'test', 'api', 'mcp', 'api-image', 'android-personal-beta / apk'}
    require(0 < jobs.get('total_count', 0) <= 100 and jobs['total_count'] == len(jobs.get('jobs', [])), 'Incomplete source jobs')
    passed = {j['name'] for j in jobs['jobs'] if j.get('status') == 'completed' and j.get('conclusion') == 'success'}
    require(required <= passed, 'Required source jobs did not pass')


def select_artifact(run, artifacts):
    name = f"opengym-personal-debug-{run['id']}-{run['run_attempt']}"
    found = [a for a in artifacts if a.get('name') == name]
    require(len(found) == 1 and found[0].get('expired') is False and 0 < found[0].get('size_in_bytes', 0) <= MAX_APK, 'Missing, expired or oversized APK artifact')
    return name


def approved_origin():
    value = os.environ.get('OPENGYM_ORIGIN', '')
    parsed = urllib.parse.urlsplit(value)
    require(parsed.scheme == 'https' and parsed.hostname and parsed.username is None and parsed.password is None and not parsed.path and not parsed.query and not parsed.fragment and value == 'https://' + parsed.netloc, 'Set OPENGYM_ORIGIN to the approved HTTPS backend origin')
    return value


def validate_bundle(folder):
    expected = {APK, APK + '.sha256', 'build.json'}
    require({p.name for p in folder.iterdir()} == expected, 'Unexpected artifact files')
    require(all(p.is_file() and not p.is_symlink() for p in folder.iterdir()), 'Unsafe artifact file')
    apk = folder / APK
    require(0 < apk.stat().st_size <= MAX_APK and (folder / 'build.json').stat().st_size <= 4096 and (folder / (APK + '.sha256')).stat().st_size <= 256, 'Artifact size limit')
    manifest = json.loads((folder / 'build.json').read_text(encoding='utf-8'))
    require(manifest.get('origin') == approved_origin() and manifest.get('applicationId') == 'ch.duartesantos.opengym.test' and manifest.get('variant') == 'debug', 'Unexpected APK profile')
    require(manifest.get('localOnly') is True and manifest.get('personalAccountRequired') is True, 'Unsafe APK configuration')
    checksum = re.fullmatch(r'([0-9a-f]{64})[ \t]+\*?opengym-beta-debug\.apk\n?', (folder / (APK + '.sha256')).read_text())
    require(checksum is not None, 'Invalid APK checksum manifest')
    digest = hashlib.sha256()
    with apk.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    require(digest.hexdigest() == checksum[1], 'APK checksum mismatch')
    with zipfile.ZipFile(apk) as archive:
        entries = archive.infolist()
        require(len(entries) <= 50000 and sum(i.file_size for i in entries) <= 1024 * 1024 * 1024, 'APK archive size limit')
        for item in entries:
            parts = item.filename.split('/')
            require(not item.filename.startswith('/') and '..' not in parts and not item.filename.endswith(('.keystore', '.jks', '.env', '.sqlite', '.sqlite3', '.parquet')) and parts[-1] not in {'bootstrap-invite.txt', 'db.json'}, 'Private or unsafe APK entry')
        require(archive.getinfo('assets/public/index.html').file_size <= 1024 * 1024, 'Mobile HTML size limit')
        require(b'opengym-flavor' in archive.read('assets/public/index.html'), 'Not a mobile bundle')
    return digest.hexdigest()


def select_release(releases):
    # GitHub may rename a draft's missing tag to untagged-* when its target changes.
    found = [r for r in releases if r.get('tag_name') == TAG or
             (r.get('draft') is True and r.get('name') == TITLE and
              re.fullmatch(r'untagged-[0-9a-f]{8,64}', r.get('tag_name', '')) and
              MARKER in (r.get('body') or ''))]
    require(len(found) <= 1 and (len(releases) < 100 or bool(found)), 'Ambiguous or incomplete release listing')
    return found[0] if found else None


def previous_manifest(release):
    require(release.get('name') == TITLE and release.get('prerelease') is True and release.get('immutable') is not True, 'Refusing to modify an unrelated release')
    body = release.get('body') or ''
    require(len(body) <= 32768, 'Unexpected release body')
    found = re.findall(re.escape(MARKER) + r'(\{[^\n]+\}) -->', body)
    require(len(found) == 1, 'Unrecognized personal release')
    metadata = json.loads(found[0])
    require(metadata.get('certificate_sha256') == PIN and type(metadata.get('run_id')) is int and type(metadata.get('attempt')) is int, 'Unexpected previous signer or run')
    require(all(a.get('name') == APK for a in release.get('assets', [])), 'Refusing to replace unrelated release assets')
    return metadata


def validate_order(previous, run):
    require((int(run['id']), run['run_attempt']) >= (previous['run_id'], previous['attempt']), 'Refusing to replace a newer build')


def verify_uploaded(release, digest, size):
    assets = release.get('assets', [])
    require(len(assets) == 1 and assets[0].get('name') == APK and assets[0].get('state') == 'uploaded' and assets[0].get('size') == size and assets[0].get('digest') == 'sha256:' + digest, 'Uploaded release APK is not verified')
    url = f'https://github.com/{REPO}/releases/download/{TAG}/{APK}'
    actual_url = assets[0].get('browser_download_url', '')
    # Drafts without a published tag have an untagged-* URL. After publication
    # only the fixed channel URL is accepted. Hash/size checks apply in both states.
    temporary = re.fullmatch(re.escape(f'https://github.com/{REPO}/releases/download/') + r'untagged-[0-9a-f]{8,64}/' + re.escape(APK), actual_url)
    require(actual_url == url or (release.get('draft') is True and temporary), 'Unexpected release download URL')
    return url


class GitHub:
    def command(self, *args, body=None, optional=False):
        environment = os.environ.copy()
        environment.pop('GH_DEBUG', None)
        result = subprocess.run(['gh', *args], input=body, text=True, capture_output=True, timeout=900, env=environment)
        if optional and result.returncode and '(HTTP 404)' in result.stderr:
            return None
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or 'GitHub command failed')
        return result.stdout

    def api(self, endpoint, *, body=None, optional=False, method='GET'):
        args = ['api', '--hostname', 'github.com', '--method', method, 'repos/' + REPO + '/' + endpoint]
        if body is not None:
            args += ['--input', '-']
        raw = self.command(*args, body=json.dumps(body) if body is not None else None, optional=optional)
        return None if raw is None else json.loads(raw)


def main(run_id):
    approved_origin()  # Fail before reading/downloading or publishing with a missing target.
    require(re.fullmatch(r'[1-9][0-9]{0,19}', run_id) is not None, 'Invalid run ID')
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == REPO and os.environ.get('GITHUB_ACTOR') == REPO.split('/')[0] and os.environ.get('GITHUB_REF') == 'refs/heads/feature/nutrition' and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and bool(os.environ.get('GH_TOKEN')), 'Publication requires the owner-dispatched repository workflow token')
    publication_sha = os.environ.get('GITHUB_SHA', '')
    require(re.fullmatch('[0-9a-f]{40}', publication_sha), 'Invalid publication revision')
    gh = GitHub()
    run = gh.api('actions/runs/' + run_id)
    jobs = gh.api(f"actions/runs/{run_id}/attempts/{run['run_attempt']}/jobs?per_page=100")
    validate_run(run, jobs)
    page = gh.api(f'actions/runs/{run_id}/artifacts?per_page=100')
    require(page['total_count'] <= 100 and page['total_count'] == len(page['artifacts']), 'Artifact listing limit')
    name = select_artifact(run, page['artifacts'])
    root = Path(tempfile.mkdtemp(prefix='opengym-release-', dir=os.environ['RUNNER_TEMP']))
    folder = root / 'artifact'
    gh.command('run', 'download', run_id, '--repo', REPO, '--name', name, '--dir', str(folder))
    digest = validate_bundle(folder)
    apk = folder / APK
    tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/35.0.0'
    report = root / 'signer.txt'
    with report.open('w') as stream:
        subprocess.run([str(tools / 'apksigner'), 'verify', '--print-certs', str(apk)], stdout=stream, check=True, timeout=120)
    subprocess.run([sys.executable, str(Path(__file__).with_name('verify-android-signature.py')), '--sha256', PIN, str(report)], check=True)
    badging = subprocess.check_output([str(tools / 'aapt'), 'dump', 'badging', str(apk)], text=True, timeout=120)
    require("package: name='ch.duartesantos.opengym.test'" in badging, 'Unexpected actual Android package')
    releases = gh.api('releases?per_page=100')
    release = select_release(releases)
    metadata = {'run_id': int(run_id), 'attempt': run['run_attempt'], 'source_sha': run['head_sha'], 'publication_sha': publication_sha, 'sha256': digest, 'certificate_sha256': PIN}
    body = f"Bêta Android personnelle, authentification obligatoire sur {approved_origin()}.\n\nTélécharger **{APK}**, puis installer sans désinstaller la version précédente. Aucun secret ni donnée personnelle embarqués ; scanner et utilisation réelle à vérifier sur téléphone.\n\nCompilation : https://github.com/{REPO}/actions/runs/{run_id}\n\nCommit source : `{run['head_sha']}`\n\nSHA-256 APK : `{digest}`\n\nCertificat stable SHA-256 : `{PIN}`\n\n{MARKER}{json.dumps(metadata, separators=(',', ':'))} -->\n"
    if release is not None:
        validate_order(previous_manifest(release), run)
    reference = gh.api('git/ref/tags/' + TAG, optional=True)
    if reference is not None:
        require(reference['object']['type'] == 'commit', 'Unexpected beta tag type')
        old = reference['object']['sha']
        if old != publication_sha:
            require(release is not None and gh.api(f"compare/{old}...{publication_sha}")['status'] == 'ahead', 'Refusing non-forward beta tag update')
            gh.api('git/refs/tags/' + TAG, method='PATCH', body={'sha': publication_sha, 'force': False})
    if release is None:
        release = gh.api('releases', method='POST', body={'tag_name': TAG, 'target_commitish': publication_sha, 'name': TITLE, 'body': body, 'draft': True, 'prerelease': True, 'make_latest': 'false'})
    assets = release.get('assets', [])
    if not (len(assets) == 1 and assets[0].get('digest') == 'sha256:' + digest and assets[0].get('size') == apk.stat().st_size):
        gh.command('release', 'upload', release['tag_name'], str(apk), '--repo', REPO, '--clobber')
    release = gh.api('releases/' + str(release['id']))
    url = verify_uploaded(release, digest, apk.stat().st_size)
    # Address a draft by immutable release ID: CLI tag lookup can fail before
    # GitHub creates the tag, even though its uploaded assets are already valid.
    gh.api('releases/' + str(release['id']), method='PATCH', body={'tag_name': TAG, 'target_commitish': publication_sha, 'name': TITLE, 'body': body, 'draft': False, 'prerelease': True, 'make_latest': 'false'})
    final = gh.api('releases/' + str(release['id']))
    require(final.get('draft') is False and final.get('prerelease') is True, 'Release publication not confirmed')
    verify_uploaded(final, digest, apk.stat().st_size)
    print(json.dumps({'release': final['html_url'], 'apk': url, 'source_run': int(run_id), 'sha256': digest}, ensure_ascii=False))
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as summary:
        summary.write(f'### Android personal beta\n\n[Download APK]({url})\n\nSource run: {run_id}\n\nSHA-256: `{digest}`\n')


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2, 'Usage: publish-android-release.py SUCCESSFUL_RUN_ID')
        main(sys.argv[1])
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
