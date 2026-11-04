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

## Acceptance gates

Mark a gate passed only with the revision, command and evidence scope. Software
authenticators, fixture catalogues and disk test bridges remain distinct from a
browser authenticator, public source data and a physical phone.

| Gate | Baseline evidence / remaining work |
| --- | --- |
| Core regression suites | Baseline: 5,919 frontend and 854 API tests pass; changed behavior requires new targeted tests |
| Source acquisition | Pinned official Ciqual download/import/projection verified; OFF/wger not portable in this installer yet |
| Source management | Registry selection/removal/recovery and original-data preservation verified; no complete cross-source union claim |
| Personal mode | Explicit one-owner policy and registration race tests in progress |
| Multi-user mode | Invitation/public policies, independent data and session tests in progress |
| First account | Baseline real HTTP with disposable software passkey; new policies and actual browser ceremony remain to verify |
| Browser journal | Real component tests pass; actual browser with the new installation profile remains to verify |
| Docker build and boot | **Blocked:** local daemon socket permission denied; CLI configuration parsing only |
| Docker recovery | Script/HTTP fixture tests pass; actual container backup, restore and restart remain unverified |
| HTTPS | Operator-owned domain/proxy/certificate required; no production proxy modified |
| Generic Android | Build/profile improvements in progress; no native APK compilation or device acceptance claimed |
| Update identity | Generic APK must have its own stable signing identity; personal key must not be read, changed or reused |
| Translation/visual review | Baseline 18 locales structurally aligned; prior Chromium fixture screenshots labelled synthetic |
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
