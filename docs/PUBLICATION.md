# Source beta publication: maintainer checklist and review

**Prepared 5 November 2026, locally on `review/public-readiness`, starting at
`d6f6ad50`. No push, tag, Release, APK, container publication or Reddit post was
performed.** This is a source beta candidate for maintainer review, not a claim
that a new Docker installation or generic Android APK is already validated.

## Scope of this beta

The current portable scope is Web self-hosting source, personal or multi-user
accounts, workout tracking, Nutrition journaling, personal foods/recipes and an
optional Ciqual 2025 starter. Use [Quick start](QUICK_START.md) and
[Self-hosting](SELF_HOSTING.md), not the legacy root Compose configuration.

| Profile | First account | Later registration | Personal data |
| --- | --- | --- | --- |
| Personal (default) | Private bootstrap invitation, first owner | Closed, one account | Account-private; host administrator trusted |
| Multi-user (default invitation policy) | Same protected first administrator | Admin-created invitations; default ceiling 100 accounts | Separate journals, workouts, foods and sessions |
| Multi-user with explicit public signup | Same private first-admin bootstrap | Requires both `--signup public` and `--allow-public-signup` | Still private; public signup is not public sharing |

Both managed profiles disable guests and password login. Account ceilings are
not concurrent-user performance promises. Do not use a passkey hostname change,
password bypass or clearing browser data as a recovery shortcut. Follow the
[account policy and recovery documentation](dev/PUBLIC_ACCOUNT_MODES.md).

The public API network has no provider internet access. The starter has no
external food-provider fallback; push notifications and optional remote AI
providers are also unavailable in that network profile. Private, previously
provisioned wger/OFF deployments remain separate and unchanged.

These are **explicitly deferred**, not completed in this preparation:

- Real Docker installation, lifecycle, image-size and resource acceptance.
- Generic Android APK compilation, physical pairing/storage/scanner tests and
  native iOS acceptance. The personal APK is not a generic release artifact.
- International OFF/wger installation and a unified portable multi-provider
  catalogue. Ciqual is regional French composition data with official French
  and English names; it does not supply international branded products/barcodes.

Keep [README limitations](../README.md#food-data-and-current-limits) visible:
combined workout + Nutrition restore remains blocked; missing nutrients are
unknown, and operator-readable server data are not end-to-end encrypted.

## Security review

### Repository and history scope

The starting checkout contained 21,166 tracked files. A bounded scan examined
7,971 text files (60,608,649 bytes), plus 15,286 patch lines in the existing review
commits relative to `feature/nutrition`. No high-confidence private-key, GitHub
token, AWS access-key or Slack-token pattern was found. The two credential-style
URLs found in source are synthetic refusal fixtures in
`client.mobile-paired.test.js` and `test_public_bootstrap.py`; no real credential
was identified. No tracked file exceeded 10 MiB and no tracked private `.env`,
SQLite, keystore, APK or source archive was found. Ignore rules were checked for
those types and the catalogue `artifacts/`/`runtime/` directories.

This was not a specialist secret scanner, full forensic Git-history audit,
binary-content inspection or external penetration test. It does not prove the
absence of every secret. Private environment files and signing keys were not
opened. Historical personal-beta hostnames and scripts remain intentional public
configuration; they are not inputs to the public installer. Maintainers should
also enable GitHub secret scanning/push protection where available and review
any alerts before publication. Never publish ignored workspaces to "complete"
the source archive.

### Dependencies

The following lockfile audits were executed against the npm registry on
5 November 2026, without installing/upgrading packages or using `audit fix`:

| Scope and command (from repository root) | Moderate | High | Total | Exit |
| --- | ---: | ---: | ---: | ---: |
| `npm audit --package-lock-only` | 0 | 0 | 0 | 0 |
| `npm --prefix frontend audit --package-lock-only` | 6 | 2 | 8 | 1 |
| `npm --prefix frontend audit --package-lock-only --omit=dev` | 0 | 0 | 0 | 0 |
| `npm --prefix api audit --package-lock-only --omit=dev --omit=optional` | 0 | 0 | 0 | 0 |
| `npm --prefix api audit --package-lock-only --omit=dev` (includes optional Coach tree) | 4 | 2 | 6 | 1 |
| `npm --prefix mcp audit --package-lock-only --omit=dev` | 4 | 2 | 6 | 1 |

All returned valid audit reports, with no critical findings. Nonzero exits above
are **real dependency findings**, not environmental test failures. Advisory counts
overlap; do not sum them as unique vulnerabilities.

The default public API Dockerfile omits optional/dev packages. The public web
image serves built assets with nginx, not the Vite server or Happy DOM. This
narrows exposure; it does not establish safety for other profiles or build hosts.

Development findings include Happy DOM ([host-code execution](https://github.com/advisories/GHSA-834v-8h66-3h79),
[SSRF](https://github.com/advisories/GHSA-c8p4-j97h-3vg8),
[cookie scope](https://github.com/advisories/GHSA-5fpq-26gf-qwcr)),
Vite/editor handling ([editor argument interpretation](https://github.com/advisories/GHSA-r825-w8mm-5pxw),
[cross-origin middleware](https://github.com/advisories/GHSA-9jrq-w75r-8gcw),
[filesystem allowance](https://github.com/advisories/GHSA-rq7h-c2jc-7f22)), Vitest/mocker,
glob/minimatch and rimraf's transitive tree. Do not expose development/test servers
to untrusted networks or parse untrusted documents in test tooling.

Coach/MCP findings include [body-parser DoS](https://github.com/advisories/GHSA-27r3-jxmh-p828),
[Zod collection exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
Hono static path decoding, fast-uri, ip-address and qs. These integrations are not
recommended by the portable default. Audit fixes require separate dependency
review and targeted behavior tests; MCP's reported Zod fix includes a major-version
change. No blanket or forced dependency upgrade was made just to obtain a green audit.

### Workflows and repository settings

- External Actions are pinned to full commit SHAs. Checkout does not retain Git
  credentials. Default `GITHUB_TOKEN` permissions are read-only; publishing write
  permissions remain limited to explicitly guarded jobs.
- The inherited Docker publisher, Pages deployment and GitLab mirror are restricted
  to `DuarteSantos8/openGym`. A release/tag in this fork must not publish legacy
  images or an upstream demo implicitly. This does not introduce a public image
  pipeline; self-hosters build the reviewed source themselves.
- Personal APK jobs still require the owner, personal branch and manual event.
  Their signing key, APK identity and release link were not modified or accessed.
  They cannot produce a generic APK from this public-review branch.
- The existing API CI now requires Nutrition HTTP tests rather than allowing an
  unavailable listener to be treated as acceptance. Legacy API-image checks remain
  present; those checks do not validate `deploy/self-hosting`.
- `Publication policy` runs small YAML/policy tests on relevant PRs/pushes. It does
  not execute publishers or replace GitHub's own workflow validation. No Actions
  run was triggered during this preparation.

A read-only GitHub API check on **5 November 2026** found the repository public,
default branch `main`, **Issues disabled**, **Discussions disabled**, and **private
vulnerability reporting disabled**. Templates cannot change these settings.
There is no verified alternative private contact. The [security policy](../SECURITY.md)
therefore instructs reporters to retain sensitive details until a channel exists.

## Licence evidence

| Material | Evidence and permitted claim | Remaining boundary |
| --- | --- | --- |
| Application code | Existing [LICENSE](../LICENSE), AGPL-3.0-or-later package metadata and upstream copyright/notices retained | Preserve corresponding source and existing section-7 app-store permission; this is not a relicense of third-party assets |
| Body diagrams and exercise text | MIT notices and source lineage in [NOTICE.md](../NOTICE.md); original openGym additions use its code licence | Retain notices; do not treat all media as exercise text |
| Ciqual 2025 | Official [dataset metadata](https://entrepot.recherche.data.gouv.fr/api/datasets/:persistentId/?persistentId=doi:10.57745/RDMHWY) declares `etalab 2.0`; [official terms](https://www.data.gouv.fr/pages/legal/licences/etalab-2-0) allow reuse/redistribution with source/date attribution | Keep Anses attribution, data date, transformations and generated notices; no endorsement or independently guaranteed nutrition accuracy |
| Gym visual media | The [upstream notice](https://raw.githubusercontent.com/DuarteSantos8/openGym/main/NOTICE.md) declares permission for unmodified ≤180 px media in non-commercial openGym forks | Private agreement not available for independent verification; [provider terms](https://gymvisual.com/content/3-terms-and-conditions-of-use) restrict transfer/standalone reuse. Maintainer must confirm the intended distribution fits that permission; no blanket redistribution claim |
| Nutrition screenshots | [Documented synthetic captures](assets/nutrition/README.md), real UI with fixture data, no food photos or real histories | Keep “Synthetic demo data” caption and project attribution; not live coverage/device proof |
| Existing upstream graphics/screenshots | Retained assets and upstream notices; no new promotional rights grant | Do not infer a separate stock-media licence or permission to reuse exercise imagery outside openGym |
| OFF/wger | Original record/database/image terms remain separate; source-specific notices retained | No bulk dataset or composed private catalogue is published here; no portable international redistribution conclusion is made |

The official Ciqual metadata check returned dataset version **1.0 / RELEASED**,
publication **2025-11-19T16:29:04Z**, with data filenames dated **2025-11-03**.
The selected unrestricted files are `alim_2025_11_03.xml` (1,581,031 bytes) and
`Table Ciqual 2025_FR_2025_11_03.xlsx` (1,541,998 bytes). Acquisition keeps the
existing pinned SHA-256 checks, manifest and notice. The dataset publication date
and the underlying data date are distinct. No data files were downloaded in this
publication review; the earlier importer/record validation is retained.

The media header check inspected **13,108 WebP/MP4 files**, all within **180 × 180**.
That verifies the size condition, **not** the licence grant itself. No media,
licence text or catalogue data were replaced. Before distributing source archives
containing those assets, confirm the non-commercial-fork permission with the
rights holder if its scope is uncertain. Do not publish a separate media pack,
extract larger native assets, or advertise the whole repository as uniformly AGPL.

## Verification performed for this preparation

Only targeted checks were run; application behavior and lockfiles were not changed.

```sh
# Node 22; the root js-yaml dependency already exists in package-lock.json
node --test scripts/publication/check.test.mjs
node scripts/publication/check.mjs
node scripts/catalogue/check-media.mjs
git diff --check
```

- Publication regression tests: **9 passed, 0 failed, 0 skipped**. They reject
  missing/bypassable publisher guards, wrong personal branch/owner, mutable
  Actions, persisted checkout credentials, elevated permissions, privileged
  events, broad secret inheritance and shell interpolation of event text.
- YAML/policy: **8 workflows and 4 forms** parsed and checked. This is static
  validation, not a successful GitHub execution or a general workflow compiler.
- Media header check: **13,108 passed**. No legal permission is inferred from it.
- Local documentation links and whitespace checked; no application suite or build
  was rerun for prose/template/workflow changes.
- Audit exits and limits are listed above. No real Docker/native test was run.

The earlier application acceptance record remains at
[PUBLIC_RELEASE_CANDIDATE.md](dev/PUBLIC_RELEASE_CANDIDATE.md): **5,948 frontend
and 864 API tests** passed at the recorded revisions. Those are historical
results, not new runs or additional coverage from this preparation. Strict HTTP,
real Chromium and simulated tests are distinguished there. No image, APK or
production deployment inherits a validation claim from that record alone.

## Manual GitHub checklist

1. **Review this exact source candidate and licence boundary.** Read the diff,
   `NOTICE.md`, this audit and [Unreleased changelog](../CHANGELOG.md). Confirm the
   media permission for the intended distribution. Do not attach a composed food
   database, private settings, logs, signing keys, backups, APK or untested image.
2. **Publish only the reviewed ref when ready.** No push has been made here.
   Decide separately which branch will become the public default. GitHub forms,
   security-policy discovery and manual-workflow availability depend on default-
   branch contents; pushing a review branch alone is insufficient. Review a PR or
   change the default branch manually as appropriate; do not blindly merge into
   `main` or the existing personal beta. Preserve their current deployments.
3. **Enable Issues and a private reporting channel.** Under repository Settings,
   enable Issues; under Security/Advanced Security enable private vulnerability
   reporting ([GitHub instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)).
   Verify Security → Advisories → **Report a vulnerability** and the fork's issue
   chooser using another account. The private-report YAML is prepared but does
   not activate the feature. Discussions are optional. Update the dated reporting
   status in SECURITY/FAQ/CONTRIBUTING only after checking the real setting.
4. **Review repository protection and CI.** Enable available secret scanning and
   push protection, read-only workflow defaults, approval for outside-contributor
   runs and branch/PR review rules. Inspect the proposed workflow diff before
   running untrusted changes. Run `Publication policy` and the appropriate existing
   CI against the reviewed ref; do not select the personal APK release input.
5. **If releasing source now, label it explicitly.** A suggested unused tag is
   `nutrition-public-beta.1` (proposal only; check for collisions). Target the exact
   reviewed commit, mark **pre-release**, not latest, and use the notes below.
   GitHub's source archives contain tracked media, so licence review applies even
   with no uploaded assets. Do not claim tested Docker/Android artifacts.
6. **Before broader installation promotion**, record the deferred Docker lifecycle
   and generic Android checks on authorized test hosts. International OFF/wger is
   future scope, not a hidden prerequisite for this source beta. Review the
   [Reddit draft](PUBLIC_LAUNCH.md) only after publication/support links actually
   work; no post is prepared for automatic submission.

## Suggested prerelease notes (source only)

> openGym Nutrition — source beta preview
>
> This fork adds Nutrition journaling, personal foods, recipes, snapshot-preserving
> history and independent backup/restore to openGym's workout tracker. The portable
> installer source supports personal or multi-user accounts with private data and
> invitations by default. An optional small Ciqual 2025 starter provides generic
> foods with official French/English names; it has no retail barcode coverage.
>
> This release is for source review and controlled testing. Real Docker lifecycle
> acceptance and generic Android compilation/physical tests remain manual work.
> There is no validated generic APK or prebuilt public image in this prerelease.
> International OFF/wger installation is deferred; combined dataset restore is
> intentionally unavailable. Development/optional integration advisories and the
> distinct media/data licences are documented in PUBLICATION.md and SECURITY.md.
>
> Follow QUICK_START.md from the exact tagged source, preserve independent backups,
> and use the repository's verified private channel for vulnerabilities. Existing
> personal-beta deployment/catalogues and signing identity are not replaced.

Insert the actual tag/commit, working feedback links and updated validation results
when publishing. Do not silently copy inherited upstream release/version claims.
