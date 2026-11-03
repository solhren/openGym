"""Offline publication guards; no GitHub credentials, SDK or private signing keys."""
import hashlib
import copy
import contextlib
import io
import shutil
import subprocess
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('publish-android-release.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def run_fixture():
    return {'id': 100, 'run_attempt': 1, 'repository': {'full_name': m.REPO}, 'head_repository': {'full_name': m.REPO}, 'actor': {'login': 'solhren'}, 'head_branch': 'feature/nutrition', 'event': 'workflow_dispatch', 'path': '.github/workflows/test.yml', 'status': 'completed', 'conclusion': 'success', 'head_sha': 'a' * 40}


def jobs_fixture():
    return {'total_count': 5, 'jobs': [{'name': name, 'status': 'completed', 'conclusion': 'success'} for name in ['test', 'api', 'mcp', 'api-image', 'android-personal-beta / apk']]}


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='opengym-public-release-test-')
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)

    def bundle(self, extra=None):
        with zipfile.ZipFile(self.folder / m.APK, 'w') as z:
            z.writestr('assets/public/index.html', '<meta name="opengym-flavor" content="mobile">')
            if extra:
                z.writestr(extra, 'synthetic fixture')
        digest = hashlib.sha256((self.folder / m.APK).read_bytes()).hexdigest()
        (self.folder / (m.APK + '.sha256')).write_text(digest + '  ' + m.APK + '\n')
        (self.folder / 'build.json').write_text(json.dumps({'origin': 'https://gym.solhren.fr', 'localOnly': True, 'personalAccountRequired': True, 'applicationId': 'ch.duartesantos.opengym.test', 'variant': 'debug', 'physicalDeviceTested': False}))
        return digest

    def release(self):
        meta = {'run_id': 99, 'attempt': 1, 'certificate_sha256': m.PIN}
        return {'name': m.TITLE, 'prerelease': True, 'body': m.MARKER + json.dumps(meta) + ' -->', 'assets': []}

    def test_valid_source_and_jobs(self):
        m.validate_run(run_fixture(), jobs_fixture())

    def test_wrong_account_repository_branch_or_workflow_refused(self):
        for key, value in [('actor', {'login': 'someone-else'}), ('head_repository', {'full_name': 'other/repo'}), ('repository', {'full_name': 'other/repo'}), ('head_branch', 'main'), ('path', '.github/workflows/other.yml'), ('event', 'pull_request')]:
            with self.subTest(key=key):
                run = run_fixture(); run[key] = value
                with self.assertRaises(ValueError): m.validate_run(run, jobs_fixture())

    def test_failed_incomplete_or_skipped_build_refused(self):
        for state in ['failure', 'skipped', 'cancelled']:
            jobs = jobs_fixture(); jobs['jobs'][-1]['conclusion'] = state
            with self.assertRaises(ValueError): m.validate_run(run_fixture(), jobs)
        run = run_fixture(); run['conclusion'] = 'failure'
        with self.assertRaises(ValueError): m.validate_run(run, jobs_fixture())
        jobs = jobs_fixture(); jobs['jobs'].pop()
        with self.assertRaises(ValueError): m.validate_run(run_fixture(), jobs)

    def test_only_exact_nonexpired_attempt_artifact(self):
        artifact = {'name': 'opengym-personal-debug-100-1', 'expired': False, 'size_in_bytes': 300}
        self.assertEqual(m.select_artifact(run_fixture(), [artifact]), artifact['name'])
        for changed in [{'expired': True}, {'name': 'opengym-personal-debug-100-2'}, {'size_in_bytes': m.MAX_APK + 1}]:
            with self.assertRaises(ValueError): m.select_artifact(run_fixture(), [artifact | changed])
        with self.assertRaises(ValueError): m.select_artifact(run_fixture(), [artifact, artifact])

    def test_valid_bundle(self):
        digest = self.bundle()
        self.assertEqual(m.validate_bundle(self.folder), digest)

    def test_corruption_and_checksum_path_injection_refused(self):
        self.bundle(); (self.folder / (m.APK + '.sha256')).write_text('0' * 64 + '  ' + m.APK + '\n')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'): m.validate_bundle(self.folder)
        (self.folder / (m.APK + '.sha256')).write_text('0' * 64 + '  ../../private.env\n')
        with self.assertRaisesRegex(ValueError, 'checksum manifest'): m.validate_bundle(self.folder)

    def test_unexpected_files_and_symlinks_refused(self):
        self.bundle(); extra = self.folder / '.env'; extra.write_text('synthetic fixture')
        with self.assertRaises(ValueError): m.validate_bundle(self.folder)
        extra.unlink(); manifest = self.folder / 'build.json'; original = manifest.read_text(); manifest.unlink()
        with tempfile.TemporaryDirectory(prefix='opengym-public-fixture-') as other:
            target = Path(other) / 'outside.json'; target.write_text(original); manifest.symlink_to(target)
            with self.assertRaisesRegex(ValueError, 'Unsafe artifact file'): m.validate_bundle(self.folder)

    def test_unsafe_apk_profile_refused(self):
        self.bundle(); path = self.folder / 'build.json'; original = json.loads(path.read_text())
        for changed in [{'localOnly': False}, {'personalAccountRequired': 1}, {'origin': 'http://localhost'}, {'applicationId': 'ch.duartesantos.opengym'}, {'variant': 'release'}]:
            path.write_text(json.dumps(original | changed))
            with self.assertRaises(ValueError): m.validate_bundle(self.folder)

    def test_private_archive_entries_refused(self):
        for entry in ['assets/.env', 'assets/key.keystore', 'assets/catalog.sqlite', 'assets/bootstrap-invite.txt', '../private']:
            self.bundle(entry)
            with self.assertRaisesRegex(ValueError, 'Private or unsafe'): m.validate_bundle(self.folder)

    def test_previous_release_must_be_owned_and_use_same_signer(self):
        release = self.release(); self.assertEqual(m.previous_manifest(release)['run_id'], 99)
        for changed in [{'name': 'Unrelated release'}, {'prerelease': False}, {'immutable': True}, {'body': ''}, {'assets': [{'name': 'private-backup.zip'}]}, {'body': release['body'].replace(m.PIN, '0' * 64)}]:
            with self.assertRaises(ValueError): m.previous_manifest(release | changed)

    def test_old_build_rejected_same_attempt_repeat_allowed(self):
        old = {'run_id': 100, 'attempt': 1}; m.validate_order(old, run_fixture())
        m.validate_order({'run_id': 99, 'attempt': 1}, run_fixture())
        for old in [{'run_id': 101, 'attempt': 1}, {'run_id': 100, 'attempt': 2}]:
            with self.assertRaises(ValueError): m.validate_order(old, run_fixture())

    def test_remote_asset_requires_server_checksum_and_only_apk(self):
        asset = {'name': m.APK, 'state': 'uploaded', 'size': 300, 'digest': 'sha256:' + 'a' * 64, 'browser_download_url': f'https://github.com/{m.REPO}/releases/download/{m.TAG}/{m.APK}'}
        self.assertEqual(m.verify_uploaded({'assets': [asset]}, 'a' * 64, 300), asset['browser_download_url'])
        for changed in [{'digest': None}, {'size': 301}, {'state': 'starter'}, {'name': 'other.apk'}, {'browser_download_url': 'https://other.invalid/file'}]:
            with self.assertRaises(ValueError): m.verify_uploaded({'assets': [asset | changed]}, 'a' * 64, 300)
        with self.assertRaises(ValueError): m.verify_uploaded({'assets': [asset, asset]}, 'a' * 64, 300)

    def test_draft_temporary_url_allowed_only_until_publication(self):
        canonical = f'https://github.com/{m.REPO}/releases/download/{m.TAG}/{m.APK}'
        temporary = f'https://github.com/{m.REPO}/releases/download/untagged-4529196a9a4d0dc097f4/{m.APK}'
        asset = {'name': m.APK, 'state': 'uploaded', 'size': 300, 'digest': 'sha256:' + 'a' * 64, 'browser_download_url': temporary}
        self.assertEqual(m.verify_uploaded({'draft': True, 'assets': [asset]}, 'a' * 64, 300), canonical)
        with self.assertRaises(ValueError): m.verify_uploaded({'draft': False, 'assets': [asset]}, 'a' * 64, 300)
        with self.assertRaises(ValueError): m.verify_uploaded({'draft': True, 'assets': [asset | {'browser_download_url': temporary.replace(m.REPO, 'other/repo')}]}, 'a' * 64, 300)
        with self.assertRaises(ValueError): m.verify_uploaded({'draft': True, 'assets': [asset | {'digest': None}]}, 'a' * 64, 300)

    def test_recognized_renamed_draft_is_resumed_without_duplicate(self):
        draft = self.release() | {'draft': True, 'tag_name': 'untagged-4529196a9a4d0dc097f4'}
        self.assertEqual(m.select_release([draft]), draft)
        self.assertIsNone(m.select_release([draft | {'body': 'unrelated'}]))
        with self.assertRaises(ValueError): m.select_release([draft, draft | {'tag_name': m.TAG}])

    def test_publication_and_resume_use_release_id_not_draft_tag_lookup(self):
        digest = self.bundle(); fixture = self.folder; actual_run = subprocess.run
        canonical = f'https://github.com/{m.REPO}/releases/download/{m.TAG}/{m.APK}'
        def asset():
            return {'name': m.APK, 'state': 'uploaded', 'size': (fixture / m.APK).stat().st_size,
                    'digest': 'sha256:' + digest,
                    'browser_download_url': f'https://github.com/{m.REPO}/releases/download/untagged-4529196a9a4d0dc097f4/{m.APK}'}
        class FakeGitHub:
            def __init__(fake, resumed):
                fake.uploads = 0; fake.creates = 0; fake.published = False
                fake.release = (self.release() | {'id': 7, 'draft': True, 'tag_name': 'untagged-4529196a9a4d0dc097f4',
                    'target_commitish': 'c' * 40, 'assets': [asset()], 'html_url': canonical.rsplit('/', 1)[0]}) if resumed else None
            def command(fake, *args, **kwargs):
                if args[:2] == ('run', 'download'):
                    dest = Path(args[args.index('--dir') + 1]); dest.mkdir(parents=True)
                    for name in [m.APK, m.APK + '.sha256', 'build.json']: shutil.copyfile(fixture / name, dest / name)
                elif args[:2] == ('release', 'upload'):
                    fake.uploads += 1; fake.release['assets'] = [asset()]
                else:
                    raise AssertionError('Draft tag-based publication is forbidden: ' + str(args[:2]))
                return ''
            def api(fake, endpoint, *, body=None, method='GET', **kwargs):
                if endpoint == 'actions/runs/100': return run_fixture()
                if endpoint.endswith('/jobs?per_page=100'): return jobs_fixture()
                if endpoint.endswith('/artifacts?per_page=100'):
                    return {'total_count': 1, 'artifacts': [{'name': 'opengym-personal-debug-100-1', 'expired': False, 'size_in_bytes': 300}]}
                if endpoint == 'releases?per_page=100': return [copy.deepcopy(fake.release)] if fake.release else []
                if endpoint.startswith('git/ref/'): return None
                if endpoint == 'releases' and method == 'POST':
                    fake.creates += 1; fake.release = body | {'id': 7, 'assets': [], 'html_url': canonical.rsplit('/', 1)[0]}
                    return copy.deepcopy(fake.release)
                if endpoint == 'releases/7' and method == 'PATCH':
                    self.assertIs(body['draft'], False); self.assertEqual(body['tag_name'], m.TAG)
                    self.assertEqual(body['make_latest'], 'false'); fake.release.update(body)
                    fake.release['assets'][0]['browser_download_url'] = canonical; fake.published = True
                    return copy.deepcopy(fake.release)
                if endpoint == 'releases/7': return copy.deepcopy(fake.release)
                raise AssertionError('Unexpected API operation: ' + endpoint)
        def tool_run(args, **kwargs):
            if str(args[0]).endswith('/apksigner'):
                kwargs['stdout'].write('Signer #1 certificate SHA-256 digest: ' + m.PIN + '\n')
                return subprocess.CompletedProcess(args, 0)
            return actual_run(args, capture_output=True, **kwargs)
        for resumed in [False, True]:
            with self.subTest(resumed=resumed), tempfile.TemporaryDirectory(prefix='opengym-publisher-test-') as runtime:
                fake = FakeGitHub(resumed)
                env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': m.REPO, 'GITHUB_ACTOR': 'solhren',
                       'GITHUB_REF': 'refs/heads/feature/nutrition', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                       'GITHUB_SHA': 'b' * 40, 'GH_TOKEN': 'synthetic-test-token', 'RUNNER_TEMP': runtime,
                       'GITHUB_STEP_SUMMARY': str(Path(runtime) / 'summary.md'), 'ANDROID_HOME': runtime}
                with patch.dict(os.environ, env, clear=True), patch.object(m, 'GitHub', return_value=fake), \
                     patch.object(m.subprocess, 'run', side_effect=tool_run), \
                     patch.object(m.subprocess, 'check_output', return_value="package: name='ch.duartesantos.opengym.test'"), \
                     contextlib.redirect_stdout(io.StringIO()):
                    m.main('100')
                self.assertTrue(fake.published); self.assertEqual(fake.creates, 0 if resumed else 1)
                self.assertEqual(fake.uploads, 0 if resumed else 1)
                self.assertIn(canonical, (Path(runtime) / 'summary.md').read_text())

    def test_local_or_untrusted_context_cannot_publish(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(m, 'GitHub', side_effect=AssertionError('must not reach GitHub')):
            for run in ['100', '1;bad', '../main', '0']:
                with self.assertRaises(ValueError): m.main(run)


if __name__ == '__main__':
    unittest.main()
