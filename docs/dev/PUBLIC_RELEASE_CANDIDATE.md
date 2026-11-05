# Public release candidate: integration and acceptance

This is a working acceptance record, **not a release approval**. Work continues on
`review/public-readiness`; `main`, `feature/nutrition`, the personal deployment,
its databases and Android signing key are outside this integration's changes.
The eleven commits through `83bfc292` are retained. The portable-catalogue baseline
through `d0c6a2d6` is recorded separately in
[PUBLIC_CATALOG_INSTALLATION.md](PUBLIC_CATALOG_INSTALLATION.md).

## Current work allocation

Specialists reuse isolated worktrees rather than making more complete source
copies on the shared host. The coordinator integrates reviewed commits only onto
the review branch. Three specialists can run concurrently; remaining work is
scheduled after a slot becomes available.

| Work | Owner | Boundaries |
| --- | --- | --- |
| Explicit personal/multi-user policies, account isolation | Architecture/Security | API authentication/configuration and API regressions |
| Mode selection and administration walkthrough | Installation/DevOps | Installer, Compose templates, backup metadata and installation docs |
| Generic Android identity, HTTPS and protected session storage | Android | Explicit generic build, mobile settings/auth adaptation and mobile tests |
| Source selection and truthful catalogue capabilities | Nutrition | Source metadata, verified readers and catalogue tests |
| Browser usability and accessibility | UX | Reuse prior review; verify changed public flows and correct demonstrated failures |
| Beginner documentation and launch draft | Documentation | Consolidate implemented behavior, actual evidence and outstanding gates |
| Cross-review, integration and final validation | Coordinator | No deployment, no publication, no production data |

Production behavior must remain unchanged when a new public profile is not
explicitly enabled. No public account mode implies public workouts or meals.
Installer source choices must not claim a working reader or licence verification
that has not been supplied.

### Managed registration UI

The existing login screen used `registration_open` only for the personal beta;
it otherwise always offered profile creation. Managed public modes now honor that
server flag as well, including failing closed when a recognized mode has not yet
provided availability. Sign-in and device linking remain accessible. Legacy
instances keep their prior behavior. Registration remains enforced on the API;
hiding an action is not an authorization boundary.

`Login.password.test.jsx` reproduces closed and unknown availability, first-owner
invitation setup, closure after refreshed config and explicitly open multi-user
registration. Five assertions failed before the UI correction. The final targeted
run with device-link, guest and password-form regressions passed **50/50**, zero
skips. The real registration sheet now provides translated accessible input names
using existing locale keys. This does not establish browser passkey or native
authenticator behavior.

### Managed account administration

The legacy administrator detail response contains workout data. Explicit public
modes instead return `account_only: true` and account metadata; their API guards
are tested separately. The real Admin component now handles that shape without
inventing zero workouts, reading absent arrays or offering a user-data export.
The account list exposes keyboard-operable buttons, and the personal mode does
not offer new invitations. Existing legacy/private-beta responses retain their
original UI path.

Three component regressions failed before this adaptation. The final Admin and
password-administration run passed **12/12**. A failed account-detail request now
shows an explicit error instead of an endless loader; its response is ignored
after navigation. Deletion warnings distinguish removing account access from
purging retained Nutrition versions or operator backups. The administration page
remains the existing English-only operator interface; this is a documented locale
limit, not a claim that all operator messages have been translated.

### Unavailable configuration on first web launch

Browser preparation exposed a legacy fallback: `guestAllowed(null)` permits local
guest use when the API is unavailable. That behavior is appropriate to old builds,
but contradicts an explicitly account-required public installation. The public
web Dockerfile now sets `VITE_OPENGYM_MANAGED_WEB=1`. Only that web profile closes
the guest entrance even before config arrives, waits for explicit registration
availability and offers a configuration retry. Native local-only use and legacy
web defaults remain unchanged. Two new real Login component tests failed before
the fix; the final six-file login/admin/guest run passed **36/36**, no skips.
The browser smoke must use this same build flag. This does not replace API access
checks: an unauthenticated client must still be refused independently of the UI.

## Acceptance gates

Mark a gate passed only with the revision, command and evidence scope. Software
authenticators, fixture catalogues and disk test bridges remain distinct from a
browser authenticator, public source data and a physical phone.

| Gate | Baseline evidence / remaining work |
| --- | --- |
| Core regression suites | Final: 5,948 frontend / 452 files and 864 API tests pass, zero failures/skips; earlier unsuccessful runs retained below |
| Source acquisition | Pinned official Ciqual download/import/projection verified; OFF/wger not portable in this installer yet |
| Source management | Registry selection/removal/recovery and original-data preservation verified; no complete cross-source union claim |
| Personal mode | Explicit one-owner policy, registration races and actual browser first-owner flow passed; Docker/TLS still open |
| Multi-user mode | Real loopback HTTP tests passed: invitation/public policies, two accounts, independent data and sessions; container acceptance still open |
| First account | Real API and Chromium registration passed using a virtual WebAuthn authenticator; no hardware-authenticator/TLS claim |
| Browser journal | Chromium with real API, IndexedDB and official Ciqual passed search, edit, reload, restore and offline reuse |
| Docker build and boot | **Blocked:** local daemon socket permission denied; CLI configuration parsing only |
| Docker recovery | Script/HTTP fixture tests pass; actual container backup, restore and restart remain unverified |
| HTTPS | Operator-owned domain/proxy/certificate required; no production proxy modified |
| Generic Android | Separate HTTPS/secure-session profile implemented and regression-tested, including late native callbacks; no native APK compilation or phone acceptance |
| Update identity | Generic APK must have its own stable signing identity; personal key must not be read, changed or reused |
| Translation/visual review | 18 locales × 2,466 keys; real Chromium official-source journey across eight width/theme combinations; physical/mobile accessibility remains manual |
| Resource budget | Shared host reserves 20 GiB disk and 2 GiB available RAM; no smaller-server minimum certified |
| Reporting/support | Maintainer must enable and verify a private vulnerability channel and usable support channel |
| Publication | No push, GitHub release, APK distribution or Reddit post is authorized by this work |

## Remaining manual acceptance sequence

After the reviewed source is made available and an authorized Docker test host has
adequate resources:

1. Follow the quick start from a fresh checkout and a **new** private instance
   directory. Record image IDs, commit, source manifests and resource usage.
2. Start the personal instance, finish first-account passkey registration and
   prove another profile cannot register. Do not reuse an existing production
   account or data directory.
3. Independently prepare a multi-user instance; create two synthetic profiles.
   Verify they cannot read or overwrite each other's workouts, saved foods,
   journals, media, sessions or Nutrition publications. Check admin-only actions.
4. With the explicitly acquired source, search, inspect reference/provenance,
   add a quantity, edit/delete, reload and reuse a saved product offline. Unknown
   nutritional values must remain unknown. A Ciqual-only instance must not
   advertise barcode coverage.
5. Deselect/reselect the source and interrupt a configuration publication in a
   disposable copy. Verify recovery and preserved saved foods/journal snapshots.
6. Back up, restore to another **new** directory, then rehearse update and rollback
   before accepting new writes. Never use volume deletion as an update step.
7. Verify HTTPS and a separately compiled generic Android build on a real phone:
   pairing, session reopening, camera refusal/scan where the installed source has
   barcodes, offline data, server/account change and same-key APK update.
8. Review licences, known limitations, reporting channels and release notes.
   Publish only capabilities actually validated by this sequence.

Stopping the old instance before rollback protects writes; reverting to an older
data copy after new writes is not a safe automatic rollback. Keep both recovery
copies until their contents and format compatibility have been checked.

The final report must enumerate outstanding gates instead of treating successful
unit tests as proof of a complete public deployment.

## Final consolidation — 4 November 2026

### Scope delivered and explicit limits

The public installer has working source acquisition, inspection, generation and
selection for **Ciqual 2025 only**. It provides 3,484 generic food identities,
3,479 with a safe addable Food projection (3,006 with complete core nutrition),
official French/English names and a 100 g reference. It neither converts liquids
to ml nor invents missing values. Its 14,700,544-byte SQLite and approximately
3.13 MB publisher downloads are independent of the maintainer's private datasets.

The registry and source lifecycle are implemented; a usable **mixed OFF/wger/Ciqual
union is not delivered**. OFF/wger remain unavailable in the portable selector.
The earlier operator-owned catalogue and personal beta are preserved. Proposed
small BYO exports were not integrated without their reader/provenance/conflict
tests. Do not replace this missing functionality with a download of private
catalogue generations or a claim of international retail coverage.

Personal and multi-user account policies are opt-in. Default new installations
require invitations, have no guest access or password login, and make the first
account an administrator only after its private bootstrap invitation. Public signup
requires an explicit installer acknowledgement and has address/instance budgets
and an account ceiling. Administrator UI/API manage account metadata; direct
private-history exports are absent in these modes. Host operators remain trusted;
explicitly enabling password recovery changes the administrator's powers. See
[PUBLIC_ACCOUNT_MODES.md](PUBLIC_ACCOUNT_MODES.md).

The generic Android profile uses `fr.solhren.opengym.selfhosted.debug`, a separately
retained signing key and runtime HTTPS server selection. The personal identity/key
is unchanged. A security review reproduced two races: a delayed secure read could
replace a later pairing; a timed-out native write could finish after another write.
Reads now share the transition lock. An uncertain native operation blocks further
session transitions and clears HTTP credentials until a full app-process restart.
Tests deliberately complete those callbacks late. This is **not** native I/O
cancellation, power-loss certification or proof on a phone. See
[Android self-hosting](../ANDROID_SELF_HOSTING.md).

### Cross-review correction: safe instance backup

An independent reviewer proved with the real Docker Compose CLI that an ambient
`COMPOSE_PROJECT_NAME` could redirect `backup.py` to an unrelated stack while its
`/data` mount check still passed. No daemon command was used in that reproduction.
The corrected backup uses the same prepared environment for every Compose call,
validates the exact project name and data mount before stopping, and holds the
configuration lock through stop/archive/restart. An interrupted catalogue
configuration is refused first. All 34 installer/backup tests pass; new tests use
real Compose parsing and simulated stop/start. A second reviewer checked the fix.
Manual Docker commands outside these scripts are not covered by their lock.

### Actual browser acceptance

`scripts/self-hosting/browser-smoke.mjs` is an opt-in developer harness. It creates
a temporary private account directory, starts its own API and Vite on loopback,
uses an already installed trusted Playwright/Chromium and shuts them down in
`finally`. It does not install a browser, start Docker, use a production account
or modify the supplied read-only official Ciqual generation.

Chromium **156.0.8078.4** passed seven journey assertions:

1. First owner through the actual Login and a virtual WebAuthn authenticator.
2. Dynamic English `milk` search, keyboard selection, source/100 g display.
3. Log 50 g, edit to 75 g and reload from actual IndexedDB/session state.
4. Download Nutrition backup, select the file, verify/preview and restore.
5. Delete/reuse the retained food while the browser is offline.
6. Personal account administration without invitation creation/private-history UI.
7. Fresh browser with API config 503: no guest/signup entrance, explicit retry,
   then recovery to the closed personal policy.

There were zero page errors or external requests in the main journey. Widths
320, 390, 768 and 1280 px, in light/dark themes, had no horizontal document
overflow. A 390 px dark screenshot was inspected. These checks do not certify all
visual states, screen readers, Firefox, TLS, hardware passkeys or Android.
Two harness setup issues were corrected without changing product behavior:
existing Chromium needed its existing local shared-library directory, and the
food option selector needed to be scoped to the listbox rather than the meal select.

Reproduce with an existing trusted Playwright installation and browser cache:

```sh
export PATH="/path/to/node22/bin:$PATH"
export PLAYWRIGHT_MODULE="/absolute/path/to/playwright/index.mjs"
export PLAYWRIGHT_BROWSERS_PATH="/absolute/path/to/installed/browser-cache"
# If using locally extracted browser libraries, also supply LD_LIBRARY_PATH
# and FONTCONFIG_FILE for that trusted installation.
node scripts/self-hosting/browser-smoke.mjs /absolute/path/to/verified/ciqual-2025
```

The harness reserves 20.25 GiB disk and 2.25 GiB available RAM, samples each second
and aborts its own processes if a reserve is lost. Its disposable synthetic test
state/screenshots/evidence stay in ignored runtime directories. It uses port 5198
with strict binding, and never kills an existing listener.

### Consolidated validation

The final API run passed **864 tests**, zero failures/cancellations/skips, in
97.34 s of test-runner time. Command: `cd api && npm test -- --test-concurrency=1`.
A separate strict real-HTTP confirmation passed **15/15**, zero skips, with
`NUTRITION_REQUIRE_HTTP_TESTS=1 node --test --test-concurrency=1
api/test/nutrition-http.test.js api/test/server-nutrition.test.js`. These 15 are
included in the full suite; they are not additional distinct coverage.

`python3 -m unittest discover -s scripts/self-hosting/tests -v` passed **34/34**.
`node --test --test-concurrency=1 scripts/android-public/*.test.mjs` passed **7/7**.
`node frontend/scripts/check-locales.mjs` found **18 locales × 2,466 matching keys**.
Final frontend/build results are recorded below; earlier targeted runs are
development evidence, not totals to add to the complete suite.

Docker runtime remains blocked by daemon-socket permission. No image build,
container launch, image-size/startup-RAM measurement or container backup rehearsal
is claimed. Java, Android SDK and adb are absent; no generic APK is built. The
nearby disk reserve also rules out unmeasured media/SDK duplication. Native
packaging and physical-device acceptance remain mandatory release gates.

### Final Android bundle and regression corrections

The first final frontend run reported **5,943 passed / 3 failed**, in 452 files
(404.28 s), with no skips. All three failures were in `Settings.update.test.jsx`:
its mocked updater omitted the newly exported `AUTOMATIC_UPDATES` capability.
The fixture now declares that contract; a new test verifies that generic Android
neither invokes the updater nor offers another distribution's APK. The real
Settings effect skips the updater in that profile; legacy Android behavior remains
tested. A six-file targeted run then passed **54/54**, zero skips. The next complete run had **5,948 assertions passed but 10 unhandled errors**
(405.52 s), so it was not a successful run. Four other Settings fixtures also
needed to declare the new updater capability. All five affected files then passed
**29/29**, without unhandled errors; no product validation was relaxed. The final
complete rerun is recorded separately below.

Inspection also found a personal-server constant retained in the generic JS bundle
by an unconditional personal-session key construction. That construction is now
conditional, and the explicit public Android profile has an empty personal origin
even if a stale host override is inherited. The personal profile's original origin
is unchanged. Fresh Web and generic mobile-web builds succeeded from `045752fe`.
The mobile copy check, distribution marker, referenced assets and service-worker
stamp passed, and **no `https://gym.solhren.fr` string remained in its JS assets**.
These Vite builds do not include media staging, Capacitor sync, Gradle or an APK.
The builder that performs those steps is prepared for an equipped machine.

### Work trace and safety boundary

The six specialist areas are represented by preserved initial commits and later
focused work: Architecture/Security (account policies and HTTP isolation),
Nutrition (pinned source/import/projection and bilingual search), UX (real
components and browser harness), DevOps (installer, source lifecycle, backups),
Android (generic profile and late-native-I/O regression fixes), Documentation
(quick start, architecture, FAQ/security policy and unpublished Reddit draft).
Cross-review found the Android session races and Compose-project backup defect;
the coordinator integrated corrections only on `review/public-readiness`.
Some follow-up specialists exhausted their session quotas; the coordinator
completed the bounded browser and backup verification without discarding work.

All eleven original commits through `83bfc292` remain ancestors. List the additional
local commits with `git log --oneline 83bfc292..review/public-readiness`; list affected
files with `git diff --name-status 83bfc292 review/public-readiness`. They use the
maintainer's existing Git author identity. No push, merge to `feature/nutrition` or
`main`, release, APK publication or production deployment was performed.

The final source check found no tracked `.env`, keystore or SQLite file, no private
key marker and no changed file over 1 MiB in this follow-up. This targeted scan is
not a guarantee against every secret. Runtime catalogues, test account state,
logs and captures remain ignored. No old catalogue or worktree was deleted.

Documentation checks found 78 local link targets present in the consolidated
files; the documentation specialist separately checked 57 local links and anchors.
The earlier default API dependency audit excluded optional Coach packages and
found zero alerts in that runtime set. Optional Coach/MCP alerts recorded in
[PUBLIC_READINESS.md](PUBLIC_READINESS.md) remain a separate follow-up; no new
all-dependencies clean-audit claim is made.

### Closing verification — recorded 5 November 2026

The final complete frontend run finished on 4 November at code revision
`c7e4919d` (which includes all four corrected Settings fixtures): **5,948 tests in
452 files passed**, exit code 0, no failed/skipped tests or unhandled errors.
Runner duration: **398.00 s**; guarded process duration: 399.079 s. Command:

```sh
npm --prefix frontend test -- --maxWorkers=2
```

The previous runs are not added to this total. The pre-existing Vitest
`MaxListenersExceededWarning` appeared, without an unhandled error or test
failure; no listener limit or validation was relaxed to hide it.

| Final check | Result | Evidence scope |
| --- | --- | --- |
| Frontend complete suite | 5,948 / 452 files, all passed | Actual final run above |
| API complete suite | 864 passed, 0 failed/skipped | Real loopback HTTP included |
| Strict Nutrition HTTP confirmation | 15 passed, 0 failed/skipped | Overlaps the complete API suite |
| Installer / backup / restore | 34 passed | Actual Compose CLI parsing; simulated daemon lifecycle |
| Android build/preflight scripts | 7 passed | Configuration/signature-check logic, not a compiled APK |
| Locales | 18 × 2,466 aligned keys | Structural consistency, not human translation approval |
| Browser journey | 7 journey checks, 8 width/theme checks passed | Actual Chromium/API/IndexedDB, official Ciqual, virtual passkey |
| Web build | Passed | Explicit managed web profile, Vite only |
| Generic mobile-web build | Passed | Vite profile, asset/flavour checks, no personal host in JS |
| Docker runtime / generic native APK | Not executed | Socket permission / missing Java and SDK |
| Source whitespace / documentation links | Passed | Git diff check and local link checks |

Environment: Node 22.23.3, npm 10.9.9, Python 3.13.5. Final frontend sampled minimum
available RAM: **2.538 GiB**, disk **20.487 GiB**; the earlier unsuccessful frontend
run sampled RAM down to 2.481 GiB. The guard never had to stop a process for resource
exhaustion. At closing inspection, disk was about **20.485 GiB** and available RAM
about **4.13 GiB**, without swap. These shared-host figures are not an image build
budget or a certified minimum server specification.

Ciqual search performance is the previously recorded same-generation measurement:
14 curated French/English queries, 10 repetitions each, one reader and warm OS
caches; initialization **723.72 ms**, highest p95 **36.04 ms** for `lait`. The
SQLite is 14,700,544 bytes. These small-dataset timings are not a speed comparison
with the three-million-row personal catalogue or proof of international coverage.
Broad English query ordering remains lexical (for example `rice` can lead with
rice starch). No new large dataset or index reconstruction was performed.

**Decision: ready for maintainer review and an isolated Docker acceptance test;
not yet a validated public beta or a Reddit launch.** Remaining gates are real
Docker build/boot/lifecycle, HTTPS/hardware authenticator acceptance, generic APK
compilation and phone tests, a portable multi-provider catalogue path, and an
actual private security-reporting/support channel. Optional Coach/MCP dependency
findings and media/data distribution rights must remain visible in release review.
The beginner path that exists today is personal or multi-user Web preparation with
optional Ciqual; OFF/wger portable installation and a published generic APK are not
being advertised as available.
