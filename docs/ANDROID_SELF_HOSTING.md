# Android with your own openGym server

The **self-hosted Android profile** is a separate distribution. It asks for your
own HTTPS server at runtime; it embeds no server address, account, invitation or
API token. It uses the existing Capacitor, secure-storage and ML Kit plugins.
It is not the maintainer's personal APK, and does not update that installation.

**Current validation:** JavaScript, React and build-configuration tests are
available. No JDK, Android SDK or `adb` is installed in this development session;
no self-hosted APK has been compiled, installed or tested on a phone. Do not
advertise a downloadable generic APK until the packaging and phone checks below
have passed. The personal scanner's earlier successful phone test does not
validate this new profile.

## Connect, use and update

1. Install a verified APK from the distributor whose package and signing identity
   you intend to keep. The new debug package is
   `fr.solhren.opengym.selfhosted.debug`, labelled **openGym Self-hosted**.
2. Open your server in a browser, create or sign in to your account, then use
   **Settings → Account → Pair the mobile app**. Enter the one-time code and your
   HTTPS server address in **Connect to my server**. No passkey is created in the
   WebView: its origin is different from your server's passkey relying party.
3. Search the server's enabled food catalogues, select a product, verify its
   reference and record a quantity. A Ciqual-only server has generic foods by
   weight, no brand barcodes; its scanner action is deliberately unavailable.
   Barcode coverage depends on an actually installed barcode-capable catalogue.
4. Restart, then repeat offline with an already saved food. Local data remains
   on this device and pending synchronization is not reported as server success.
5. Install updates over the old APK, using the **same package and signing key**
   and an increasing version code. Do not uninstall or clear storage to update.
   This profile does not query or install the upstream project's APK updates;
   obtain a verified update from your own distributor.

Local-only device mode remains available, without a server food catalogue.
Changing accounts or servers uses the existing **Disconnect** flow: retry pending
uploads or retain/export the account's owed data as offered before pairing again.
Do not use Android's Clear storage as a server switch. Nutrition keeps separate
namespaces for the account and origin and preserves its pending operations and
historical food snapshots. There is no automatic import from the personal beta's
app sandbox: synchronize or export there before changing distributions.

## Server and transport requirements

Use a valid HTTPS certificate matching the hostname, with `ORIGIN` and `RP_ID`
configured for that origin. Bare hostnames default to HTTPS. This public profile
refuses HTTP, embedded credentials, path prefixes, queries, fragments and control
characters in server addresses. Subpath hosting is not configured. Android's
normal hostname/certificate verification remains enabled; intentionally installed
user CAs are allowed alongside system CAs. The new Android network-security
profile refuses cleartext; no certificate validation is disabled.

Forward `/api/*` and `OPTIONS` to openGym without a login redirect or duplicate
CORS headers. Authentication requests reject redirects. Pairing and catalogue
requests use the selected origin; catalogue responses are rejected when their
captured session has changed. The local-only catalogue setting never falls back
to a food provider. An unavailable catalogue does not affect saved foods.

See [self-hosting](SELF_HOSTING.md#phone-app-and-cors) for proxy configuration.
Cloudflare Access headers, if explicitly configured, remain scoped to that server.
Never put them into build flags. Personal and multi-user servers use the same
pairing protocol; server access policies apply independently to every account.

## Secure persistence and failure recovery

`VITE_OPENGYM_PUBLIC_ANDROID=1` opts into this profile. It is incompatible with
`VITE_OPENGYM_PERSONAL_BETA=1` and requires the mobile bundle.

The existing secure-storage plugin encrypts the public session using Android
Keystore-backed AES-GCM. The app verifies a stored value by reading it back
**before** activating the credential in HTTP transport. A failed write cannot be
reported as a successful pairing. It does not use the Coach's memory fallback.
Renewal uses the same durable path. No second plaintext token or migration copy
is created in `opengym-remote.json`; older distributions retain their own behavior.
Concurrent pairing/disconnect/local-choice transitions are refused. A renewal
from a previous origin, account or token cannot overwrite the current session.
Secure-session reads use that same transition lock: a delayed startup read must
finish before another pairing can begin.

A missing session means first use. An unreadable or malformed secure session is
an explicit `secure-session-unavailable` startup state with **Try again**, not
an empty guest installation. The error path leaves workout mirrors, Nutrition
partitions and pending operations unchanged. Unlock the device and retry; if the
error persists, retain app data and collect the logs below. There is no automatic
key reset, local-data deletion or forced re-pairing.

A native timeout is a different state, `secure-session-restart-required`. A
JavaScript timer does **not** cancel a native write; its completion may still
change the stored session. The public profile therefore blocks all further
session reads, pairings, renewals and disconnects and clears the in-memory HTTP
credential. A late callback never unlocks it or starts another session change.
Do not merely reload the WebView: use Android Settings → Apps → openGym Self-hosted
→ **Force stop**, then reopen. Do **not** choose Clear storage or uninstall. The
new process reads and validates the session actually left in secure storage;
the failed pairing may have persisted despite its timeout. This is conservative
recovery from an uncertain outcome, not a promise that the native write was
cancelled or rolled back. Verify this procedure on a physical device before
distributing the APK.

Cloud Auto Backup is disabled for this profile. Explicit cloud/device-transfer
rules also exclude the secure plugin's encrypted preferences and legacy pairing
file: encrypted device credentials must not be transplanted to another Keystore.
Some OEMs treat device transfer differently; test it on supported phones. Keep
server backups and explicit workout/Nutrition exports. Do not promise OS backup
as the recovery path. Rooted devices, debug extraction and a compromised app
runtime remain outside the secure-storage guarantee.

The changes do not alter the personal beta's package, signing environment, backup
rules, trusted endpoints or existing legacy app's plaintext pairing format.

## Build on an equipped workstation

Use a reviewed clean checkout and preinstalled **Node 22, JDK 21, Android SDK
platform 35 and build-tools 35.0.0**. Do not use the personal beta build script.
See [Android's signing guide](https://developer.android.com/studio/publish/app-signing)
and [MOBILE.md](MOBILE.md#prerequisites). This project targets SDK 35 and minSdk 23;
this is a sideloaded debug build, not a claim of current Play Store eligibility.

Keep at least 20 GiB free and 2 GiB RAM available **throughout** a build, with extra
space for npm, Gradle caches, staged exercise media and output. The read-only
preflight checks current reserves; it is not a prediction of peak build resources.
No Android toolchain or signing key is downloaded/generated by the scripts.

```sh
node scripts/android-public/prepare.mjs
npm --prefix frontend ci
node --test --test-concurrency=1 scripts/android-public/*.test.mjs
```

Supply a **separate retained debug keystore** (`androiddebugkey`, store/key
password `android`) kept outside the checkout. Do not use
`ANDROID_BETA_DEBUG_KEYSTORE_BASE64` or `OPENGYM_ANDROID_DEBUG_KEYSTORE`. For a
brand-new distribution only, create its first key using Android Studio/keytool
and keep a private backup. If an APK is already installed, recover its original
key instead of generating another one.

```sh
export ANDROID_HOME=/absolute/path/to/installed/android-sdk
export OPENGYM_PUBLIC_ANDROID_KEYSTORE=/absolute/private/selfhosted-debug.keystore
export OPENGYM_PUBLIC_ANDROID_VERSION_CODE=1  # increase for every distributed update
node scripts/android-public/build.mjs
```

The builder uses the existing `npm run build:mobile` (including media staging and
`cap sync`), then Gradle `assembleDebug` with one worker. It sets the explicit
public flags, clears personal/backend/analytics overrides and requires the
self-hosted flavour marker in the Android assets. It verifies `apksigner`, the
certificate against the supplied key, the package and version using `aapt`, and
writes an APK, checksum and public metadata under a fresh ignored
`scripts/nutrition-local-catalog/artifacts/selfhosted-apk-*` directory.
It does not publish them. Android signing verification is distinct from a SHA-256
file checksum. This script has not been exercised with the native toolchain here.

No generic GitHub workflow or public signing secret is provisioned by this work.
The existing personal workflows remain separate. A future manual workflow must
use a new distribution-specific retained secret, the builder above, minimum read
permissions and explicit artifact verification; it must never borrow the personal
beta's secret or automatically generate replacement keys.

## Tests and acceptance

```sh
npm --prefix frontend test -- --maxWorkers=1 \
  src/lib/public-android.test.js src/App.public-session.test.jsx \
  src/lib/personal-beta.test.js src/lib/remote.test.js src/lib/update.test.js \
  src/lib/nutrition/catalog/client.mobile-paired.test.js \
  src/lib/nutrition/catalog/mobile-catalog.test.js \
  src/lib/api.mobile.test.js src/lib/api.pair-http.test.js \
  src/lib/api.pair-probe.test.js src/lib/scan-native.test.js \
  src/store/useStore.mobile-remote.test.jsx
node --test --test-concurrency=1 scripts/android-public/*.test.mjs
```

These tests simulate Capacitor I/O; the startup regression exercises the actual
App, Shell and store, without replacing them with a mock. The server and session
transport are simulated. The API's separate HTTP tests cover real server auth.
None of these prove native Keystore, Gradle resource merging, OEM backup behavior,
physical camera operation or signer-compatible APK installation.

Recorded validation for this change: **125 tests passed in 15 frontend files**;
after the final startup-screen adjustment, **11 tests passed in its two affected
files** (overlapping rerun, not 136 distinct tests). **7 Node script tests** passed.
The mobile-flavour Vite build and its asset/marker checks passed, without native
synchronization or packaging. The 18 locales retained 2,466 keys each. Existing
Vite chunk-size and ineffective-dynamic-import warnings remain; no warning was
silenced. No tests were skipped in these runs. Android/SDK tools were not installed.

Cross-review then reproduced two asynchronous races: a native write could finish
after its JS timeout and overwrite a subsequent pairing, and an unlocked startup
read could return an older session after a new pairing. The shared read/mutation
lock and fail-closed timeout state fix these in the public profile. Deferred
native read/write regressions and the real startup error screen passed in a
**65-test, seven-file** rerun, including personal-session, Coach secret storage,
paired catalogue and offline workout regressions (zero failures/skips). These are
overlapping tests, not additional distinct coverage to add to the earlier count.

Before distribution, test first pairing, restart, revoked session and recovery;
offline edits and synchronization; two accounts and two servers with the same
account identifier; vault error without data loss; native camera denial, cancel,
EAN-8/EAN-13/UPC scan and absent product; g/ml only with a verified reference;
local food persistence; an update signed by the retained key without uninstalling.
ML Kit's Google Play Services scanner model can need a first-use download; no
camera image is uploaded to the food server. Devices without compatible Play
Services need explicit testing and retain manual barcode entry.

For a failing app, preserve data and collect targeted logs on your own workstation:

```sh
adb devices
adb shell pidof -s fr.solhren.opengym.selfhosted.debug
# Use the returned PID; open the app, reproduce once, then stop logcat with Ctrl-C.
adb logcat --pid=RETURNED_PID -v threadtime
```

Review logs privately and redact URLs, accounts, tokens and personal food data
before attaching them to an issue. Never collect or publish the secure preference
file or signing keystore.

Android references: [backup rules](https://developer.android.com/identity/data/autobackup),
[network security](https://developer.android.com/privacy-and-security/security-config).
