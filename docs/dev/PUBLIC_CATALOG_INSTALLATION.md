# Portable catalogue installation

This follow-up builds on `review/public-readiness` at `83bfc292`. Its eleven
commits are retained. It does not replace the personal beta deployment, rebuild
its wger/OFF generations, or grant redistribution permission for those databases.

## Sources and user choice

Installation must not depend on the maintainer's machine or assume that users
speak French. A recommended, bounded starter source and an explicit custom
selection share the same local reader boundary. A source is offered for download
only when its actual importer, source version, licence and resource budget have
been checked. A source listed as experimental is not an installed catalogue.

The initial direct acquisition uses Anses Ciqual 2025:

- Official DOI: <https://doi.org/10.57745/RDMHWY>.
- Licence Ouverte / Open Licence Etalab 2.0, with original attribution retained.
- 3,484 generic foods, all with official French and English names.
- Approximately 3.13 MB: one nutrient XLSX plus the official food-name XML.
- Values refer to **100 g of edible portion**, also for beverages. There is no
  assumed density, no fabricated millilitre serving and no invented barcode.
- This is a French food-composition table with bilingual names, not an assertion
  of international retail coverage. It does not provide supermarket brands or
  barcode scanning coverage. Other UI languages use official-name fallback;
  automatic translation is not supplied.

Direct acquisition by the operator avoids publishing a mixed wger/OFF database.
Hashes check transfer integrity, not a cryptographic signature from the publisher.
Public source evidence, immutable file metadata and the acquisition receipt must
remain associated with the generated SQLite. Code licensing, source database
licensing and any images must be considered separately. No product images are
acquired for this starter source.

## Existing contracts retained

The portable Nutrition v1 model and persistence/sync/backup formats are unchanged.
`ciqual:<original-code>` is an added public lookup namespace, separate from a
revision-specific Food ID. Leading zeros are preserved. The DTO contains the
source, its release, source-file hashes, official names and licence. The Food uses
the existing `source.kind = custom` extension with `publicCatalogImport.provider
= ciqual`; it is never labelled wger or OFF.

The local capability protocol retains schema 2 and recognizes `ciqual` and
`multi` providers alongside `wger`. Unknown providers remain rejected. All local
results use the existing validated DTO, units and calculation engine. Search
never writes a Nutrition partition. Selecting and consuming a catalogue food
saves its immutable snapshot and the saved Food through the existing atomic
publication path; later source removal cannot delete those user records.

Projection to an official English name must produce a corresponding Food name
and version identity, without replacing the original source metadata. The public
lookup identity stays unchanged. Unknown values remain null. Qualified source
values such as traces or less-than values are not converted to zero.

## UI behavior

Source attribution follows entries and recipe ingredient snapshots, including
saved foods reused offline. Ciqual-only capability hides barcode/camera actions
because the source supplies no retail identifiers. Existing wger/OFF capabilities
keep their scanner behavior. The product picker shows the selected record's
own provenance and never attributes Ciqual data to wger or Open Food Facts.

## Browser authentication correction

The first integration check found that the ordinary web catalogue transport used
`credentials: omit` even when the strict local profile required a logged-in
session. A healthy protected reader consequently appeared unavailable. A new
regression exercises the default transport and reproduced that refusal. Fixed
same-origin local requests now carry the existing browser cookie; legacy anonymous
provider discovery and external-provider transports retain their prior policy.
Paired Android authentication and its session guards remain unchanged.

## Selection, publication and recovery

The recommended choice is currently `ciqual-2025`. Custom selection checks every
requested source against `public-catalog-sources.json` before changing the
configuration. OFF and wger remain explicitly unavailable in this public installer;
their existing private-beta readers are not automatically portable distributions.
No download size is fabricated for an unavailable corpus.

The version-1 registry has bounded, relative generation paths, explicit enablement
and SHA-256 identities. The runtime verifies every enabled source before becoming
available. Identical generation aliases are deduplicated only after verification.
Different Ciqual hashes or unsupported enabled kinds are refused, not arbitrarily
merged. **This is an extensible registry, not yet a working OFF+wger+Ciqual union.**
There is no shared-barcode inference between generic Ciqual IDs and retail products.

`catalogue.py` prepares a new registry, Compose file and instance metadata under an
exclusive lock. A durable journal precedes these three individually atomic writes;
committed hashes detect a partial publication. `apply` and `inspect` refuse pending
updates. `recover` completes the verified journal without starting containers.
Disabling the last source keeps authenticated local-only mode and never enables a
remote provider. Old registry snapshots and source generations remain available.
Account files are outside the read-only catalogue mount and are not rewritten.

See [the installation and management commands](../SELF_HOSTING.md), including
recovery, backup, update and rollback. Catalogue selection is an administrator CLI
operation in this iteration; there is no new catalogue administration web screen.

## Verified baseline at `d0c6a2d6`

Nutrition, Architecture and DevOps worked in isolated branches and reviewed each
other's boundaries before integration. This baseline precedes further public
account-mode and generic-Android work; later validation must identify its revision.

The real pinned acquisition produced 3,484 rows: **3,006 complete Foods, 473
partial Foods and 5 records without usable nutrients**. All 6,968 French/English
projections passed the existing JavaScript DTO/Food validators, 100 g and 50 g
calculations, and refusal of millilitres without density. These checks establish
faithful conversion, not independent laboratory verification of Anses values.
The SQLite is **14,700,544 bytes**, source files total **3,123,029 bytes**; its SHA-256
is `ffc44acf6cc4f2a29ebc05761cd6cfa637893ae212f9d4cfa6fd01fb126ca506`.

A newly prepared disposable instance from `272e4dcf` received a verified copy of
this small generation. Actual Compose client parsing, deactivation/reactivation,
unchanged account-file hashes and unchanged original source-file hashes were
checked. No large historical catalogue was copied or rebuilt. This was preparation,
not a Docker deployment. The later lexical correction changes SQL ordering only.

| Validation | Result | Scope |
| --- | --- | --- |
| Full frontend | 5,919 passed, 449 files; 0 failures/skips | Real components and service tests, not a browser or phone |
| Full API | 854 passed; 0 failures/skips | HTTP tests required; before final word-prefix ranking change |
| Final targeted API rerun | 48 passed; 0 failures/skips | Reader, HTTP, self-hosted and legacy beta regressions after ranking change |
| Self-hosting tools | 26 passed | Preparation, registry, interrupted publication, archive restore, Compose parsing |
| Bootstrap | 16 passed | Pins, parsing, bad source data, budgets, atomic generations |
| Translation consistency | 18 locales, 2,466 keys each | Structural parity, not human translation approval |
| Web and mobile-flavour web builds | Both passed | No native Gradle/Xcode compilation |

Counts describe separate runs; targeted reruns overlap the full suites and are
not additional coverage totals. Vitest emitted a process-listener warning;
builds retained existing large-chunk and ineffective-dynamic-import warnings.
These warnings were not hidden by raising thresholds.

The HTTP integration registers a disposable first account using a software passkey,
checks anonymous/foreign-origin refusal and pairing, then exercises the real
Nutrition commands, disk bridge, sync, API restart, another device, backup restore
and source removal. The separate optional official-source smoke uses the pinned
generation and normal production validators, checking search, selection, 50 g
journal arithmetic, durable sync, reopen and backup export. A disk test bridge is
not physical Android durability; a software authenticator is not a browser passkey
ceremony. The real React test covers addition, quantity editing, export/restore,
reopen, deletion and offline reuse with deterministic synthetic food records.

### Reproduction

From a reviewed checkout with lockfile dependencies installed and Node 22:

```bash
npm --prefix frontend test -- --maxWorkers=1
(cd api && NUTRITION_REQUIRE_HTTP_TESTS=1 node --test --test-concurrency=1 test/*.test.js)
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/self-hosting/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/nutrition-local-catalog -p test_public_bootstrap.py -v
npm --prefix frontend run build
git diff --check
```

The optional public-generation checks do not download anything:

```bash
node scripts/nutrition-local-catalog/public-catalog-proof.mjs /absolute/public/ciqual-2025
node scripts/nutrition-local-catalog/public-catalog-search-proof.mjs /absolute/public/ciqual-2025
node api/test/public-installation-official-smoke.mjs /absolute/public/ciqual-2025
```

### Performance and relevance

On this Debian host, Node 22.23.3/Python 3.13.5, one reader, existing OS caches,
14 curated FR/EN queries with ten sequential observations each: initialization
**724 ms**, mean query latency **0.26–22.83 ms**, maximum nearest-rank p95
**36.04 ms**. This is a small smoke benchmark, not population coverage, concurrency
capacity or a guaranteed latency. No historical wger/OFF comparison is inferred.

The review found `Camembert` above `Milk, whole` for a fixture query `milk`.
Ranking now considers exact official names, whole terms and a name prefix on a
word boundary before completeness and BM25. A red/green regression proves that
fix. In the actual data, `milk` starts with `Milk kefir` and `egg` with `Egg, raw`.
`Rice starch`, `Chicken fat` and `Banana nectar` can still lead their broad queries:
this is lexical search, not a semantic recommendation. `Nutella` and `Coca-Cola`
correctly return no branded matches. No fuzzy matching or guessed popularity was
introduced.

The reader has a 128 MiB address-space ceiling and bounded IPC/SQL execution;
that is a limit, not measured peak RSS. During the guarded full frontend run,
sampled MemAvailable stayed above **2.36 GiB** and disk above **20.68 GiB**.
Sampling every three seconds does not measure instantaneous minima. Source
acquisition/import peak RSS and image size were not measured here; no Docker image
size or smaller-server minimum is claimed.

## Remaining release gates

Docker CLI and Compose are present, but this session cannot connect to
`unix:///var/run/docker.sock` (permission denied; socket root:docker 0660).
No daemon, container, production service or permission was changed. The commands
for a Docker-authorized operator are not evidence of container execution.

Before presenting a complete public installation as validated: build and run both
images in an isolated Docker environment, follow the guide literally, exercise
HTTPS/browser passkeys and backup/restore there, and test generic Android on an
actual device. OFF/wger acquisition, licensing boundaries and a genuine multi-source
union require their own supported path and conflict tests. Do not bundle the
maintainer's mixed private-beta generations as a shortcut. Source removal and
alias handling must not be described as proof of that future union.
