# Public release preparation

This document tracks the isolated public-readiness review based on
`feature/nutrition` at `2a6133bd06489b6b92dd8fc5034f03083448c39b`.
The review is not a release announcement. Work is integrated only on
`review/public-readiness`, pending human validation; neither `main` nor
`feature/nutrition` is updated automatically.

The installation follow-up is documented in
[PUBLIC_CATALOG_INSTALLATION.md](PUBLIC_CATALOG_INSTALLATION.md). The findings and
counts below describe the original review through `83bfc292`, not later changes.

## Coordination and boundaries

Six specialist missions are assigned in two waves because the environment allows
three active sub-agents plus the coordinator. Each mission uses its own worktree.
The first wave covers architecture/security, Nutrition/data quality, and UX.
The second covers installation/DevOps, Android, and documentation/launch.
Important changes receive a review by a different specialist before integration.

No production requests, deployment, service changes, private data/key access,
large catalogue reconstruction, or APK publication are authorized by this review.
Keep at least 20 GiB disk and 2 GiB available RAM. Dependency changes and resource
intensive tests are coordinated; existing locked dependencies are reused where
possible. Synthetic fixtures and loopback HTTP are distinct from physical-device
and production validation.

## Initial findings under investigation

| Area | Initial finding | Planned evidence/action |
| --- | --- | --- |
| API | Session can be revoked while a request body is still being received | Slow HTTP request regression and targeted mutation guard |
| Dependencies | API lock contains undici 7.30.0; audit identifies patched 7.30.1 | Compatible lockfile remediation and API tests; optional Coach SDK exposure assessed separately |
| Nutrition | Barcode overlay may hide an independent wger identity sharing the same code | Synthetic collision regression; deduplicate only proven links |
| UX | Active bottom navigation is visual only; delete confirmation does not manage focus | Accessible route state and confirmation focus tests |
| Self hosting | Personal deployment is not evidence of a portable public installer | Independent generic installation path review |
| Android | Personal signed APK does not establish a generic distribution process | Separate generic build/auth/storage review, no personal key changes |
| Documentation | Historical development evidence and personal setup need a clear public entry point | README, self-hosting links, limitations, contribution/security policy and launch draft |

These are investigation items, not claims of completed fixes or verified security.
Final commits, measurements, cross-reviews, executed tests and remaining gates are
recorded below after the corresponding work has actually completed.

## Completed first wave (isolated commits)

| Mission | Specialist commit | Review branch commit | Validation supplied by specialist |
| --- | --- | --- | --- |
| Architecture/security | `0b86a15d` | `dc7b849e` | 82 targeted API tests; production audit excluding optional dependencies: zero |
| Nutrition/data | `5a4949eb` | `e306267b` | 46 Python + 6 API tests; read-only real catalogue benchmark |
| UX/accessibility | `0d42b66d` | `9d41f283` | 49 component tests; Chromium keyboard flow and eight viewport/theme checks |

These counts refer to separate targeted runs, not a new full-suite total.
Cross-review and combined validation remain pending. Optional Coach/MCP packages
still have six audit alerts each (two high); no exploitability is demonstrated for
the stdio MCP process. The API default deployment omits the optional Coach SDK.

Nutrition measurements distinguish correctness from speed: preserving independent
barcode collisions increases the three observed lookups from 0.40/0.40/1.28 ms to
4.45/5.18/2.79 ms. This is intentional validation work, not a speed improvement.
The unchanged SQL search for `lait` took 1,768 ms on its first measured pass and
367 ms on the second, with 20 usable first-page products. Reader initialization
and hash verification took 31.865 s separately; Python RSS peaked at 57,464 KiB.
These observations are not p95 values or a new national coverage measurement.
The independent Open Prices sample is unchanged and has not been recomputed.

## Public release gates already identified

- A public installer must not depend on personal catalogue generations, private
  paths, the personal domain or signing key. A core-only path is being prepared;
  a portable ready-to-use catalogue is still a separate gate.
- The repository's private vulnerability reporting, Issues and Discussions were
  observed disabled. A suitable security contact channel must be enabled/verified
  by the maintainer before a public launch; this review does not change settings.
- A generic Android build is distinct from the owner's signed APK and physical
  scanner test. It must use the paired server and a maintainer-owned update key.
- Asynchronous authentication revalidation beyond JSON body reads, including raw
  media upload, needs explicit review; the JSON regression is not a global proof.

## Six specialist deliveries and peer review

| Mission | Delivered work | Additional specialist commits | Cross-review |
| --- | --- | --- | --- |
| Architecture/security | Revocation fence for JSON and raw uploads; undici patch | `9f4b7fc1` media publication guard | Android specialist approved JSON identity assumptions and media guard; 11 media/revocation cases rerun |
| Nutrition/data | Preserve independent barcode collisions; bounded test fixture headroom | `5a492189` test-only resource isolation | DevOps approved barcode handling, 20-result ambiguity guard and test-only budget mock |
| UX/design | Announce grouped current route; accessible inline delete confirmation | `0d42b66d` | Documentation specialist checked behavior/claims and evidence limits |
| Installation/DevOps | Portable source-built core stack, private initialization, backup/restore and guide | `0b0cf68c`, `e7c2d339` | Nutrition specialist found archive/type/origin defects, then approved fixes; 11 tests rerun |
| Android/mobile | Authenticate paired catalogue transport, generic preparation, stale-body guard | `72cd26ad`, `aab283a2` | Security specialist approved origin/token/body guards; 14 dedicated cases rerun |
| Documentation/launch | Fork README, security/contribution/FAQ/index, synthetic captures, Reddit draft | `ae7d1b4c` | UX specialist reviewed links, attribution and claims; coordinator restored passkey-session advice and legacy links |

All commits are local and attributed to `solhren <solhren@proton.me>`.
No push, default-branch change, release or APK publication is performed.

### Defects caught in the second pass

- Raw media was publishable after logout/all or account disablement; deleting the
  account during the stream could instead cause a 500. The new optional
  authorization assertion runs after receiving the stream and after flush,
  immediately before irreversible publication, with no intervening await.
  Synthetic 1 KiB uploads reproduce the original defect; existing damaged media
  remains untouched if authorization expires during flush.
- Generic Android pairing updates transport credentials before its asynchronous
  persistence and store update finish. A body arriving during this interval
  could pass the old UI epoch guard. The transport now retains its session
  assertion through bounded body consumption, parsing and normalization. Tests
  use the actual connect path with deferred filesystem persistence, not merely
  a manually changed UI guard.
- A restoration archive could label required `secret`/`db.json` entries as
  directories or contain conflicting file/ancestor paths. Type/hierarchy checks
  now reject these before creating the destination. Alternative numeric IPv4
  spellings are rejected before preparing an origin/passkey configuration.
- Four API integration fixtures originally hit the real 22 GiB import headroom
  guard despite containing only four synthetic products and three references.
  Only that fixed-size fixture subprocess simulates resource metadata; actual
  import locks, hashes, SQL, DTO and HTTP validation still run. A regression
  explicitly verifies the production builder rejects 22 GiB minus one byte,
  without SQLite/current publication or modified source manifests. No runtime
  guard, CLI option, environment bypass or production quota is changed.

### Portable core profile: explicit limits

The new `deploy/self-hosting` profile is independent of the owner's domain,
private files and catalogue generations. It binds only its web entry to loopback,
uses non-root read-only containers and a private data directory, and requires an
operator-managed HTTPS reverse proxy and first-user invitation.
It intentionally has **no food database** and refuses food-provider relay routes.
The API network has no outbound access: server push/Coach/other outbound services
are unavailable. Personal foods and recipes are the supported Nutrition path.
This is a useful core installer, not completion of a portable offline catalogue.
Only Compose configuration and fixture-based scripts were tested; no image was
built or started and no clean-server installation is certified by this review.

### Evidence boundaries

The maintainer reports a working personal Web/Android beta and a real phone
barcode test. This review does not replace that with a simulated hardware claim:
the new generic profile and changes here still need device verification.
Removing a passkey does not revoke its existing sessions; the public policy again
points users to Sign out everywhere for a lost key/device.

The initial complete API run (before the test-fixture isolation fix) recorded
**835 passed, 4 failed, 1 skipped out of 840**. The four failures were the import
headroom refusal above, not masked HTTP/auth failures. The existing reminder test
skipped just after midnight UTC because its same-day past window cannot then be
constructed. The subsequent complete run is recorded separately below; these
runs must never be added together as a pass total.

## Final combined validation — 4 November 2026

| Check | Final result | Scope / command |
| --- | --- | --- |
| Complete frontend suite | 5,893 passed / 447 files, no failures/skips; 802.21 s | `cd frontend && npm test -- --maxWorkers=1` |
| Complete API suite, final run | 840 passed, no failures/skips; 258.34 s | `cd api && NUTRITION_REQUIRE_HTTP_TESTS=1 node --test --test-concurrency=1 test/*.test.js` |
| Python wger tests | 47 passed; 5.471 s | `python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_wger*.py' -q` |
| Self-hosting tools | 11 passed; 0.358 s | `python3 -W error::ResourceWarning -m unittest discover -s scripts/self-hosting/tests -v` |
| Generic Android preparation | 4 passed; 0.103 s | `node --test --test-concurrency=1 scripts/android-public/prepare.test.mjs` |
| Web build | Success; Vite 2.68 s | `cd frontend && npm run build` |
| Generic mobile-web build | Success; Vite 2.12 s; mobile copy check passed | Vite mobile/local-only profile below, no APK or native sync |
| Translation consistency | 18 locales × 2,466 keys | `node frontend/scripts/check-locales.mjs` |
| API production dependency audit | Zero findings excluding dev/optional | `npm audit --package-lock-only --omit=dev --omit=optional --ignore-scripts --json` in `api/` |
| Docs and assets | 107 affected/incoming local links/anchors validated, including explicit HTML IDs; image provenance checked | Standard-library link check plus specialist review |
| Source checks | 46 changed/new files inspected; no detected private key/token/database/APK or file over 1 MiB | Targeted pattern/artifact checks, not a guarantee against every possible secret |
| Diff | Whitespace check passed | `git diff --check` |

Do not add targeted, repeated or peer-review counts to the complete-suite totals.
The first failed API run is retained above; its final rerun was complete rather
than only rerunning the four fixture cases. The previously conditional midnight
reminder test executed normally in the final run after its time window became
constructible. No skip was removed or test disabled.

Run tests with Node 22.23.3, Python 3.13.5 and an on-disk `TMPDIR` inside the ignored
runtime directory; the small `/tmp` filesystem is unsuitable for catalogue tests.
The frontend dependencies were reused through an ignored symlink; the API used
locked undici 7.30.1 from the specialist's isolated installation. No global
installation, production data, network proxy, DNS or Docker service was changed.

The generic mobile-web build used:

```sh
cd frontend
VITE_MOBILE=1 VITE_NUTRITION_LOCAL_V1=1 VITE_OPENGYM_PERSONAL_BETA=0 \
VITE_NUTRITION_CATALOG_ORIGIN= VITE_UMAMI_SRC= VITE_UMAMI_ID= \
APP_MEDIA_DIR= VITE_CLIP_EXT=mp4 NODE_OPTIONS=--max-old-space-size=512 \
npm run build -- --outDir ../scripts/nutrition-local-catalog/runtime/public-validation/mobile-web
node --input-type=module -e "import { checkCopy } from './scripts/check-mobile-bundle.mjs'; checkCopy('../scripts/nutrition-local-catalog/runtime/public-validation/mobile-web')"
```

This is a web-assets build check, not `cap sync`, Gradle, a compiled APK, signing
verification or a physical-device test. Docker Compose configuration was checked
with the actual CLI without contacting its daemon; no Docker image or container
was built/started. The standalone MCP suite was not rerun (no MCP source changed).

Tests/builds were monitored every three seconds with at least 20.25 GiB disk and
2.25 GiB available RAM as stop thresholds. Lowest sampled values across monitored
runs were **21.747 GiB disk** and **2.475 GiB available RAM**. No run was stopped by
these guards. Sampling does not certify the absence of shorter external-system
resource fluctuations. Original catalogue generations and all evidence remain.

Warnings remain visible: the serialized frontend run emits a process
`MaxListenersExceededWarning` for unhandled-rejection listeners; no application
leak is established by that warning. Vite reports a large bundle and the existing
scanner static/dynamic import overlap. Limits/listener counts were not raised and
these warnings were not silenced.

The dependency correction is supported by the official
[undici advisory](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c).
The optional Coach/MCP audit findings are a separate follow-up; zero default API
findings must not be advertised as zero findings in every supported configuration.

## Prioritized handoff

1. **Before a public installation claim:** build/start this exact generic profile
   on a disposable server, verify HTTPS/passkey/bootstrap, exercise login/pairing,
   workout/Nutrition persistence, stop/start, backup recovery and image rollback.
2. **Before catalogue-driven V1 promotion:** supply and validate a portable path
   for operators to prepare/use reliable local catalogue data without personal
   paths or hard-coded generations; settle distribution rights before offering
   any database/media download. Core personal-food support alone does not meet
   the maintainer's catalogue requirement for V1.
3. **Before a Reddit launch:** enable/verify a private security-reporting channel
   and a support/feedback channel, then update the security policy and launch
   checklist to reflect actual repository settings.
4. **Before a generic Android artifact:** build with a maintainer-controlled stable
   key and chosen package/channel, then test pairing/scan/g/ml/edits/reopen/offline
   and update behavior on hardware. Do not reuse or expose the personal key.
5. **Follow-up hardening:** remediate optional dependency alerts where compatible,
   investigate the serialized-test listener warning, measure search p95/human
   relevance on a representative corpus and improve bundle sizing. Do not raise
   SQL/storage limits or invent nutritional references to improve headline counts.

Decision: **ready for human code review; partially ready for a public release**.
Six real specialist missions, corrective second passes and cross-reviews produced
concrete tested improvements. The deployment, data-distribution and hardware gates
above are not resolved by passing unit/integration tests. No external publication
is authorized or performed by this preparation.

## Complete changed-file inventory

```text
CONTRIBUTING.md
README.md
SECURITY.md
api/media.js
api/package-lock.json
api/package.json
api/server.js
api/test/catalog-reference.test-util.js
api/test/server-session-revocation.test.js
deploy/self-hosting/Caddyfile.example
deploy/self-hosting/Dockerfile.api
deploy/self-hosting/Dockerfile.api.dockerignore
deploy/self-hosting/Dockerfile.web
deploy/self-hosting/Dockerfile.web.dockerignore
deploy/self-hosting/compose.yaml
deploy/self-hosting/nginx.conf
docs/ANDROID_SELF_HOSTING.md
docs/DATA_IMPORTS.md
docs/FAQ.md
docs/NIX.md
docs/PUBLIC_LAUNCH.md
docs/README.md
docs/SELF_HOSTING.md
docs/SELF_HOSTING_HTTPS.md
docs/assets/nutrition/README.md
docs/assets/nutrition/journal-mobile-light.png
docs/assets/nutrition/journal-tablet-dark.png
docs/assets/nutrition/picker-mobile-dark.png
docs/dev/NUTRITION_UI.md
docs/dev/PUBLIC_READINESS.md
frontend/src/components/TabBar.jsx
frontend/src/components/TabBar.test.jsx
frontend/src/lib/api.js
frontend/src/lib/nutrition/catalog/client.js
frontend/src/lib/nutrition/catalog/client.mobile-paired.test.js
frontend/src/lib/nutrition/catalog/mobile-catalog.test.js
frontend/src/views/nutrition/DeleteAction.accessibility.test.jsx
frontend/src/views/nutrition/common.jsx
scripts/android-public/prepare.mjs
scripts/android-public/prepare.test.mjs
scripts/nutrition-local-catalog/test_wger_off_reference.py
scripts/nutrition-local-catalog/wger-off-reference.py
scripts/self-hosting/backup.py
scripts/self-hosting/prepare.py
scripts/self-hosting/state.py
scripts/self-hosting/tests/test_self_hosting.py
```

Local validation artifacts are retained under the integration worktree
`scripts/nutrition-local-catalog/runtime/public-validation/` (ignored).
The read-only catalogue benchmark script/JSON remain in the Nutrition worktree
`scripts/nutrition-local-catalog/runtime/public-quality-evidence/` (ignored).
These evidence paths are not runtime installation dependencies.
