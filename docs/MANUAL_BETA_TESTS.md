# Manual beta acceptance: Docker and generic Android

These are **instructions for future manual tests**, not a record that they passed.
Use disposable accounts and new directories on a test host. Do not use a production
origin, data directory, signing key or catalogue. Record commit, OS, versions and
pass/fail/blocked beside each checkbox; keep private codes and data out of reports.

Stop when disk reserve would fall below **20 GiB**, available RAM below **2 GiB**,
a data-isolation check fails, or configuration points outside the lab. Build one
image at a time. Never use global Docker pruning, `down -v`, Clear storage or an
uninstall as a repair step. Keep every previous instance and verified backup.

## A. Fresh Docker installation

Prerequisites: non-root Linux user, Git, Python 3.11+, Docker Engine/Compose v2,
reviewed source checkout. [Quick start](QUICK_START.md) explains the portable scope;
[Self-hosting](SELF_HOSTING.md) covers HTTPS and recovery. The local example assumes
a browser on the Docker host. For remote access, configure your own trusted HTTPS
origin and proxy **before** registering passkeys; an HTTP LAN IP is insufficient.

Prepare one disposable lab (from the checkout root):

```bash
OPENGYM_CHECKOUT="$PWD"
OPENGYM_LAB="$HOME/opengym-acceptance-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$OPENGYM_LAB"
python3 scripts/self-hosting/doctor.py "$OPENGYM_LAB/personal" --port 18080
python3 scripts/self-hosting/prepare.py "$OPENGYM_LAB/personal" \
  --origin http://localhost:18080 --port 18080 \
  --project opengym-acceptance-personal --mode personal --catalogues recommended
cd "$OPENGYM_LAB/personal"
dc() { docker compose --env-file instance.env -f compose.yaml "$@"; }
dc config --quiet
dc build api
dc build web
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" apply "$PWD"
dc ps
```

- [ ] Every diagnostic error is resolved. A busy port is investigated, not freed
  by stopping another service. `recommended` acquires only the small pinned Ciqual
  files. A failed download has a clear retry path; existing files are preserved.
- [ ] API/web become healthy. No API port is published; web binds loopback only.
  Capture image IDs, sizes and `docker stats --no-stream` **for these containers**.
  Inspect only lab logs with `dc logs --tail 100 api web`; redact before sharing.
- [ ] Open `http://localhost:18080`, privately read `data/bootstrap-invite.txt`,
  create the owner with a passkey, then add a second passkey. Incognito access
  cannot obtain private data; a second account cannot register in personal mode.
- [ ] Settings → Account → Admin shows Personal instance, limit 1, no extra
  invitations. The page distinguishes account management from operator backups
  and catalogue commands. No guest/password route is offered by this profile.
- [ ] Log a synthetic workout and reload. Open Nutrition, search `rice`, `riz`,
  `milk`, `lait`, choose a relevant food, inspect its **100 g** reference, enter
  75 g and save. Ciqual drinks are also per 100 g: no ml conversion is invented.
- [ ] Edit the entry to 100 g, reload, delete it, then add another. Create a
  personal food and a recipe. Check source attribution and an incomplete food:
  unknown nutrients must never appear as zero. Missing goals remain optional.
- [ ] Test 360 px and desktop widths, light/dark, keyboard arrows/Enter/Escape,
  result announcements and quantity inputs. At Ciqual-only setup the scanner is
  absent, since this source has no retail barcodes.
- [ ] Export Nutrition in its own screen. Preview the file without altering data,
  then merge it in the **disposable** account. Confirm no duplicate replay or
  silent overwrite. Combined workout + Nutrition restoration stays unavailable.
- [ ] Disconnect the client network after saving a food. Log it locally, reload,
  reconnect and verify pending synchronization completes. Catalogue lookup may
  be unavailable offline; saved foods and existing journal entries must survive.

Check complete instance backup and restore (lab only):

```bash
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/backup.py" \
  "$OPENGYM_LAB/personal" "$OPENGYM_LAB/personal/backups/acceptance.tar.gz"
# The backup tool briefly stops only the validated lab API, then restores its prior state.
cd "$OPENGYM_LAB/personal"
dc stop
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/prepare.py" "$OPENGYM_LAB/restored" \
  --origin http://localhost:18080 --port 18080 --project opengym-acceptance-restored \
  --restore "$OPENGYM_LAB/personal/backups/acceptance.tar.gz"
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" use \
  "$OPENGYM_LAB/restored" "$OPENGYM_LAB/personal/catalogues"
cd "$OPENGYM_LAB/restored"
dc build api
dc build web
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" apply "$PWD"
dc ps
```

- [ ] Account/passkeys, workout and Nutrition records survive. Catalogue integrity
  checks pass. No first-account reset or unrequested migration occurs.
- [ ] For rollback, stop **restored** services, return to the **personal** instance
  and run its `catalogue.py apply`. Verify the earlier data again. Do not edit data
  in both copies: rollback after new writes requires a deliberate recovery plan.
- [ ] Stop each lab stack from its own directory. Do not delete its data or volumes.

Multi-user is a second **new** lab, not a mode switch over those accounts:

```bash
cd "$OPENGYM_CHECKOUT"
python3 scripts/self-hosting/doctor.py "$OPENGYM_LAB/multi" --port 18081
python3 scripts/self-hosting/prepare.py "$OPENGYM_LAB/multi" \
  --origin http://localhost:18081 --port 18081 --project opengym-acceptance-multi \
  --mode multi-user --max-users 3
cd "$OPENGYM_LAB/multi"
dc build api
dc build web
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" apply "$PWD"
```

- [ ] Use its distinct bootstrap invitation to create the administrator. Create
  one invitation, copy it and register account B in a separate browser profile.
  Reusing/revoking a code behaves correctly. Denied clipboard access does not
  claim success; the code can be selected and copied manually.
- [ ] A and B create different synthetic workouts and personal Nutrition entries.
  Each sees only its own records, foods and backups. B cannot open Admin. The
  managed administrator sees account metadata, not another account's histories.
- [ ] Disable B: further requests fail; retained data are preserved. Re-enable B
  and verify login/recovery. Check the account ceiling and explicit policy text.
- [ ] Public signup is **optional**: test only in a third fresh directory/project
  on another free port using `--mode multi-user --signup public --allow-public-signup`.
  First-admin bootstrap remains private; later signup is limited and users remain
  isolated. Do not expose this disposable test to the internet unintentionally.

To retry failed preparation, use [the recovery table](QUICK_START.md#if-preparation-was-interrupted).
Do not regenerate invitations or overwrite a directory to make a test pass.

## B. Generic Android

Build on an equipped workstation, **not on the shared VPS**. Use Node 22, JDK 21,
SDK platform 35/build-tools 35.0.0 and the reviewed source. Follow the full
[generic Android guide](ANDROID_SELF_HOSTING.md), especially signing and backups.

```bash
node scripts/android-public/prepare.mjs
npm --prefix frontend ci
node --test --test-concurrency=1 scripts/android-public/*.test.mjs
export ANDROID_HOME=/absolute/path/to/android-sdk
export OPENGYM_PUBLIC_ANDROID_KEYSTORE=/absolute/private/selfhosted-debug.keystore
export OPENGYM_PUBLIC_ANDROID_VERSION_CODE=1
node scripts/android-public/build.mjs
```

Use a **separate retained key**, never the personal beta key. For updates, use the
same key/package and increment version code. The builder verifies package,
certificate and metadata, then prints the output directory. Read `build.json` and
SHA-256 before transferring the APK privately to the phone. With USB debugging,
install that exact file with `adb install -r /absolute/path/to/the-produced.apk`.
Without ADB, open the APK on the phone and authorize that installer when Android
asks. Do not uninstall an existing compatible build to update it.

- [ ] APK is actually compiled; package is `fr.solhren.opengym.selfhosted.debug`,
  distinct from the personal beta. Record certificate fingerprint and version.
  No personal backend, token or invitation is embedded; do not publish the key.
- [ ] Launch: **Connect to my server**, no personal domain prefilled. HTTPS help is
  visible. HTTP, a URL with credentials or `/api` path is refused before sending
  a pairing code. A bare hostname is accepted as HTTPS.
- [ ] Open the test server in a browser, sign in and obtain **Settings → Account →
  Pair the mobile app**. Enter that HTTPS origin/code. Keyboard submit works;
  repeated taps do not create overlapping attempts. Offline/timeout errors remain
  visible without erasing fields. No proxy/Authelia login page replaces `/api`.
- [ ] Close/reopen and force-stop/reopen: session and saved meals survive. Search,
  choose a quantity, add/edit/delete and reload. Saved foods work offline and later
  synchronize; local save is never labelled server success.
- [ ] Permission review: camera is requested only on explicit scan. Refusal and
  cancellation preserve the journal and release capture. Inspect the merged
  manifest: inherited notifications, alarms, foreground service, Health Connect
  and package-install permissions are separate from food scanning; no new runtime
  permission was added by this follow-up. Record what the device actually asks.
- [ ] **Scanner data gate:** Ciqual cannot satisfy barcode lookup. On Ciqual-only
  installations verify the button is hidden and mark product-scan acceptance
  **blocked by catalogue coverage**, not passed. With a separately verified,
  barcode-capable *test* catalogue, scan an EAN-13/EAN-8/UPC; test known, absent,
  ambiguous and non-addable records. Verify g/ml against its certified reference,
  add a meal and confirm no external food-provider request. Do not download large
  datasets or point these tests at production to satisfy this checkbox.
- [ ] Server/account switch: export or synchronize pending work, use the existing
  Disconnect flow, then pair another disposable account/origin. It must not see
  the first account's journal. Re-pair the first account and check retained work.
- [ ] Install a second build over the first with a higher version code and the
  same signing certificate. Session, journal and historical snapshots survive.

If secure storage reports an uncertain timeout, follow the Android guide's
**Force stop** recovery; never Clear storage. Keep logs private and redact codes,
tokens and meals. Simulated component tests are not physical Android acceptance.


Generic APK distribution follow-up: use `android-selfhosted.yml`, a separate retained
public debug key/certificate pin and an increasing public versionCode. The personal
APK cannot be updated in-place by the generic package. Keep both installed; follow
[the migration steps](ANDROID_SELF_HOSTING.md#personal-apk-migration-and-first-public-build)
and verify original exports/server data before removing any installation. The workflow
and simulated tests do not check these physical-phone acceptance items for you.
