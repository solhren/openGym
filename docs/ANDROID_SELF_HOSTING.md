# Android with your own server

The generic Capacitor app pairs with the HTTPS server you enter at runtime. It
does not require the maintainer's domain, account, certificate or signing key.
The same mobile bundle can serve different installations. The personal beta
scripts and release channel in `docs/dev/` are a separate deployment profile;
do not use them as the generic build procedure.

## Prepare the mobile bundle

Use a separate checkout with Node 22 and installed frontend dependencies. Keep
at least 20 GiB of free disk and 2 GiB of available RAM. From the repository root:

```sh
node scripts/android-public/prepare.mjs
node --test --test-concurrency=1 scripts/android-public/prepare.test.mjs
```

The first command checks resources and public manifests and prints the build
profile. It writes no files, contacts no server, reads no signing material and
executes neither a build nor an installation. The profile keeps the web assets
inside the Capacitor shell; no remote WebView URL is configured.

Build the generic web assets explicitly with these public flags, including empty
values that override any local Vite settings:

```sh
cd frontend
VITE_MOBILE=1 VITE_NUTRITION_LOCAL_V1=1 \
VITE_OPENGYM_PERSONAL_BETA=0 VITE_NUTRITION_CATALOG_ORIGIN= \
VITE_UMAMI_SRC= VITE_UMAMI_ID= APP_MEDIA_DIR= VITE_CLIP_EXT=mp4 \
npm run build:mobile
```

This builds and synchronizes the web bundle into the existing Android/iOS
projects; it does **not** build an APK. It stages exercise media already available
in the checkout and fails if the required catalogue media are missing. Keep
`dist/` isolated from ordinary web builds until native packaging is complete.
`build:mobile` checks the mobile flavour and referenced assets in the copies.
Local device mode remains available; this profile's food catalogue requires a
paired server with the local catalogue enabled. Previously saved foods remain
available offline.

For Android packaging, use an already installed Android toolchain as described
in [MOBILE.md](MOBILE.md#prerequisites): JDK 21, SDK platform 35, minSdk 23
(Android 6), targetSdk 35. No toolchain download, APK build, key creation or
signature change is performed by the preparation above. Keep SDK/Gradle updates
separate and rerun the acceptance checks below after changing them.

## Pair and check the network

1. Serve your installation over HTTPS with a certificate trusted by the phone
   and matching its hostname. Keep `ORIGIN` and `RP_ID` consistent with that
   hostname. Use your own installation's account and registration settings.
2. Sign in through the phone's browser, then open Settings → Account → **Pair
   the mobile app**. Enter the five-minute, one-time code and your server address
   in the app's **Connect to my server** screen. WebAuthn stays in the browser;
   the native WebView has a different origin.
3. The app uses its paired session for training and the local food catalogue.
   Catalogue queries, product selection and capability checks carry the same
   Bearer token and any Cloudflare Access headers scoped to that server. An
   unavailable or refused local catalogue does not switch to an anonymous relay
   or an external food provider in this profile.

Let `/api/*` reach openGym unchanged, including `OPTIONS`, `Authorization` and
the native-origin CORS response. Avoid a proxy login page or duplicate CORS
headers. See [phone app and CORS](SELF_HOSTING.md#phone-app-and-cors) and the
Cloudflare Access instructions in [MOBILE.md](MOBILE.md#a-server-behind-cloudflare-access).
Do not put a service token into the build profile. Android also accepts
user-installed certificate authorities and explicitly entered LAN HTTP servers;
HTTPS is the recommended generic setup. HTTP sends pairing and session secrets
without transport encryption.

## Storage, permissions and updates

Generic pairing currently keeps the session in `opengym-remote.json` in the
app's private files, unlike the personal beta's secure-storage session. It is
separate from synced data and JSON exports. Android app isolation protects that
file, but root access, debug extraction and OS backup/transfer have a different
trust boundary. The checked-in backup rules exclude large exercise media from
cloud backup, **not** this pairing file. Revoke sessions from your server after a
lost or transferred device; do not describe generic pairing as Keystore-backed.
Migration of this existing format requires separate native-device validation.

The training mirror and Nutrition storage retain local changes across offline
starts; unsent changes and account scopes survive server rejection. A rejected
session needs pairing again. Keep an exported backup before any signing or
package migration. Do not uninstall or clear app storage to repair pairing.

Camera permission is requested when scanning. Nutrition restricts scans to
EAN/UPC and keeps barcode strings intact. Google's scanner module may need a
first-use Play Services download; scanning can therefore need a network before
its first successful use. Camera permission denial and cancellation must leave
manual food entry available. Health Connect and notification permissions belong
to their optional features; they are not prerequisites for pairing or Nutrition.

Retain your own signing identity and package identifier for every update of your
own distribution. An update must also have a compatible, increasing Android
version code. The repository's debug build uses an `.test` application suffix;
debug and release installs are separate applications. Do not replace, reuse or
regenerate the personal beta's signing identity. A differently signed APK cannot
update that installed application.

The current in-app update checker points to `DuarteSantos8/openGym` upstream
releases. It is **not** a generic channel for your independently signed builds
or the personal beta. Distribute your verified updates manually through your
own channel and retain the package/signing identity; do not rely on that button
to update a fork. APK checksums detect corruption, while Android verifies update
signer compatibility. This preparation does not claim an APK or signer check.

## Acceptance before distributing your build

Automated regression checks, without networking or a native toolchain:

```sh
cd frontend
npm test -- --maxWorkers=1 src/lib/nutrition/catalog/client.mobile-paired.test.js \
  src/lib/nutrition/catalog/mobile-catalog.test.js src/lib/personal-beta.test.js \
  src/lib/api.mobile.test.js src/lib/api.pair-http.test.js \
  src/lib/api.pair-probe.test.js src/lib/scan-native.test.js \
  src/store/useStore.mobile-remote.test.jsx
```

On the actual APK and supported phone versions, verify a new installation paired
to your own HTTPS host; restart with and without a network; create offline
training and Nutrition changes, reconnect and confirm them from the browser;
revoke the session and pair again without losing those changes. Check a food
search/selection behind the same proxy as training, camera denial/cancellation,
first scan, and an update signed with your retained key without uninstalling.
Check optional notification/Health Connect permissions only when enabling those
features. A successful host test or JavaScript suite cannot prove WebView,
Keystore, OEM permission handling or APK update compatibility.

The user has already reported a successful physical ML Kit scanner test on their
personal phone. That is user-provided evidence for that device and build; it is
not a claim that this generic build, another phone or an APK update was tested
by this audit.
