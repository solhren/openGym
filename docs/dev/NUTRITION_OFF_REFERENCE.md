# OFF original-reference proof and streaming plan

26 October 2026. Isolated developer tooling only; no active catalogue, user store,
API route or production configuration changes. The first authorized transfer stopped
before EOF on an invalid source identifier. A second full pass was explicitly
authorized and completed successfully; no third pass or activation is authorized.
See the execution sections below; current pointer files belong only to laboratory
workspaces and no application catalogue was activated.

## Finding: input sets, not aggregate suffixes

The [official nutrition implementation](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/lib/ProductOpener/Nutrition.pm)
and [schema change log](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-api-and-product-schema-change-log/)
distinguish `nutrition.input_sets` from `nutrition.aggregated_set`. Aggregation can
combine sources/references. The API also converts product schemas on read; an API
response alone cannot establish how many original dump rows have the new fields.

A real Coca-Cola response (`5449000000996`) proves the trap: aggregate `per=100g`,
but its carbohydrate/fat/protein/energy provenance points at packaging input
`per=100ml`; the packaging 100g set has none of those declared macros. Treating
that aggregate as 100g would reproduce the bug. `*_100g` suffixes, package sizes,
category guesses and the aggregate's `per` alone are not adequate evidence.

The prototype instead selects a **complete coherent original input set**:

- source `manufacturer`, `packaging` or `usda`, preparation exactly `as_sold`;
- `per` exactly `100g` or `100ml`; provided `per_unit`/`per_quantity` must agree;
- explicitly declared `value` for protein/carbohydrate/fat and at least one
  energy, with expected g/kcal/kJ units; no computed-only values or qualifiers;
- kcal may be converted from explicit kJ by the existing Nutrition converter;
  energy is never reconstructed from macros;
- source-scoped OFF nutrition errors reject the corresponding source/reference;
  unknown/global nutrition/energy errors reject conservatively. A warning about
  a separate serving or rejected packaging set is retained in provenance, not
  mistaken for a defect of a complete manufacturer 100g set. The known missing
  serving-size warning cannot affect a 100g/ml input that does not use servings;
- multiple **conflicting valid** sets produce an unresolved conflict. Standard
  OFF manufacturer/packaging/USDA priority chooses only between identical valid
  nutritional sets. It never overrides conflicting valid values;
- all-zero unknown products stay review-only. Missing values remain unknown;
  no-nutrition declarations, unknown future schema versions (>1004), prototype
  objects/accessors, invalid units and implausible nutrients reject;
- normalization then uses `normalizeProduct` in explicit-reference mode and the
  unchanged core Food validator/calculations. A projected aggregate is only a
  transport representation of that one selected input, not a merge of sources;
- original barcode strings are preserved. Zero-padding aliases require valid
  GS1 checksums; invalid-checksum codes are never silently aliased.

This is a source-aware adapter, not a relaxation of the existing normalizer or
Food contract. Full OFF quality errors, rejected input reasons, selected source,
original code and source hashes stay in provenance. It confirms what OFF declares,
not that contributors' labels are objectively correct. The Nutella packaging data
is indeed inconsistent; only the separately consistent manufacturer set qualifies.

## Real evidence (no full dump)

Two bounded original gzip-prefix captures were made: 200 rows, then an expanded
1,000-row prefix to include original liquid references. Each request was bounded
to a 4 MiB HTTP Range and 32 MiB decoded output. The second prefix contains the
first; **do not sum them as 1,200 independent products**. Actual compressed bytes
read were 589,824 and 3,670,016 (the wire ceiling is 8 MiB across both requests).
Neither prefix reaches the full source gzip footer/CRC. They are not representative
of French products and do not establish prevalence in the whole dump.

`off-raw-reference-1000-20261026` contains 1,000 actual original JSONL rows,
23,582,759 bytes, SHA-256
`15ee114800ed2f42a9a517a25f1f94ccdbd9caec8bb97ad096937aa0bdd42cad`.
The final strict audit accepts **130** (126 mass / **4 volume**), rejects 93 without
a usable coherent set, leaves **776** without original input sets, and rejects one
explicit no-nutrition product. Real original-volume examples include Ruby breakfast,
Smoothie Strawberry & Banana and maple syrup. These 130 are a field/engine audit,
not 130 automatically stored products: the target filter applies separately.
The 776 legacy rows remain unresolved; this method does **not** promise to recover
all old wger products merely by transferring the whole dump.

Eight additional, deliberately curated maintenance-only v3.5 requests were made,
1.1 seconds apart, total 44,937 response bytes. Six products returned, two 404;
no retries. Those API probes are a different source, not original-dump evidence
or a population sample. Runtime openGym has no dependency on these requests.

| Probe | Accepted reference / values | Outcome |
| --- | --- | --- |
| Nutella `3017620422003` | 100g, 539 kcal / P6.3 C57.5 F30.9 | Manufacturer complete; bad packaging rejected; all flags retained |
| Coca-Cola `5449000000996` | 100ml, **180 kJ / 4.184** kcal / P0 C10.6 F0 | Original packaging-volume set; computed-only kcal ignored |
| Milk `3250392190484` | 100ml, 41 kcal / P3.2 C4.8 F1 | Explicit packaging volume |
| Coconut oil `3760295170051` | 100ml, 889 kcal / P0.2 C1.8 F98 | Values preserved as declared, no density assumption |
| Pastry `3531150222020` | 100g, 340 kcal / P6.6 C38 F18 | Explicit packaging mass |
| Yoghurt `3770011205004` | No usable input set | Remains unaddable |
| Water / nonfood control | 404 | No invented replacement or follow-up crawl |

Raw capture and API receipts retain source URLs, size/hash, dates and source kind.
Original raw snapshots remain separate from API-converted records. The API probe
was not used to manufacture missing fields in the dump.

## Target index and isolated SQLite complement

`off-ref-targets-20261026/targets.sqlite`: **980,963** canonical/exact identities,
49,627,136 bytes, 9.61 s construction. It is built from the existing read-only French
OFF/wger identity audit and the complete French Open Prices barcode census:
903,069 wger-only, 29,594 Prices-only and 48,300 shared identities. Source hashes
are pinned in its receipt. French language in wger is not evidence of sale in France;
Prices membership is reported separately. No wger reimport/index rebuild occurs.

`off-ref-final-20261026` is a sealed **sample** complement:

- 100 target records from the 1,000-row dump prefix plus six API products;
- **93 accepted records: 88 original JSONL + 5 API**, 13 unresolved/rejected;
- **5 accepted codes observed in France** in the full Prices census;
- SQLite 204,800 bytes; file `reference-9e9dcf7fd214421b8e9a18e755317e04.sqlite`,
  SHA `34ecf5f2a5d41e59f5bcfd9b0d1d7155799a44f0228b5a149e5f7f4be4744e85`;
- complete **for this captured sample**, `fullDumpVerified=false`,
  `productionAllowed=false`. No application pointer is changed.

Keys are exact codes/validated GTIN aliases. Rows store target membership,
validation status, complete portable Food payload, source/reference provenance and
content fingerprint. Conflicting captured versions never silently choose a winner.
Food IDs include immutable provenance; later source revisions may create new IDs.
No existing library Food, recipe or consumed snapshot is updated. Before real UI
integration, source refresh/dedup policy needs review; this pass does not transplant
public data into users automatically.

The tiny generation is fsynced, checked with SQLite integrity_check, content-hashed
and published via an exclusive new manifest in a **new workspace**. Interruption
before that leaves an unsealed file, never a successful generation. Old generations
are retained. No images, contributor identifiers or credentials enter the Food
projection. Full public raw source captures stay in private workspace directories.
OFF ODbL database / DbCL contents and contributor attribution remain in each Food;
images (separate licences) are not fetched. Public complement stays separate from
personal recipes/journals/backups; no blanket licence claim is made for combining
unrelated private databases.

## Actual journal and frozen benchmark checks

`off-ref-final-journal-20261026/report.json` reports **93/93** actual engine/local
storage laboratory paths: add at 50 **g or ml matching the reference**, close,
reopen, compare snapshot and exact totals, preserve pending offline operations.
Wrong-dimension g/ml quantities reject without a density. No provider calls.
6.52 s; Node per-executable VmHWM **79,908 KiB**. This uses the real commands and
filesystem test bridge; it is not a physical Android/iOS/browser durability test.
A previous proof reported inherited ru_maxrss; the final proof uses Linux VmHWM
and preserves the earlier result rather than overwriting it.

`off-ref-final-coverage-20261026/report.json` reuses the **unchanged** independent
1,000-case / 913-barcode Prices benchmark. Exact validated expected codes go from
**0 to 3** in the isolated complement: milk, coconut oil, pastry. They are the three
captured selected benchmark products, not a randomized test of a full enrichment.
The denominator and missing cases stay fixed. This is a demonstrated lower bound,
**not 90% coverage, not a full-dump gain estimate**, and not an active API/UI result.
The current deployed reader still does not use this experimental reference table.
No text ranking/fuzzy change or semantic relevance claim accompanies this count.

## Prepared streaming extraction and recovery

`off-reference-stream.py` performs **no HTTP**. It reads a gzip stream from stdin
into a new private SQLite staging workspace, retaining projected data **only for
the 980,963 targets**. Source version ID, ETag, length and target-index hash are
part of the durable identity; an altered source/index cannot resume the same job.

- Standard-library bounded gzip/JSONL decode: <=14 GiB compressed, <=256 GiB decoded
  bytes passing through memory, <=8 MiB per line, <=64 KiB retained projection.
- SQLite main cap 2 GiB, cache 16 MiB, staging workspace/journal cap 2.5 GiB checked
  at transaction boundaries. The prototype's general 2 GiB workspace rule is not
  raised globally: this dedicated stage has its separately budgeted journal cap.
- Checkpoints every <=1,000 source rows commit selected rows, decoded-prefix SHA,
  line number and decoded byte count together under SQLite FULL synchronous mode.
- Exclusive nonblocking workspace lock prevents simultaneous writers; SQLite
  recovers an interrupted transaction before a replay. CRC, exact source length
  and integrity_check are required before the completed state is durable.
- Ordinary gzip **cannot safely resume at an arbitrary compressed byte**. Recovery
  replays the **same pinned source from byte zero**, verifies the committed decoded
  prefix hash and skips its already committed rows. Network replay may cost much
  of another 12.35 GiB. No retry or replay is started automatically.
- A completed replay returns the durable result idempotently; a changed source,
  mismatching prefix, CRC/size error, memory/disk guard or timeout cannot publish.
- Wall deadline four hours, 768 MiB process address-space cap, 512 MiB own-process
  RSS guard at checkpoints; system reserves always apply. Bounds are conservative
  aborts, not reservations against unrelated services or proof of physical power
  failure durability.

The staged normalization path `off-reference-overlay.py build --staged-capture`
reads only completed staging and the pinned target index, runs the same persistent
Node adapter sequentially, and seals a new complement only on success. Max 1m
retained records derives from the measured 980,963 targets, not an arbitrary increase;
max SQLite 2 GiB/journal workspace 2.5 GiB, four-hour normalization budget, bounded
IPC and Node heap 128 MiB. Source and Food contracts stay unchanged. An interrupted
normalization is restarted **offline into a new workspace** from completed staging;
it does not yet resume its partial output in place. Partial files are kept and must
be counted in the next preflight; repeated failures cannot consume the 20 GiB reserve.
Nothing automatically deletes them. Even a completed staged normalization remains
`productionAllowed=false`; network/provenance and human publication checks precede
activation. `fullDumpVerified` remains conservative until a real full-source run
is reviewed; a completed local gzip fixture is never labelled a full OFF import.

A separate **local recompression of the genuine 1,000 decoded rows**, not a download,
exercised the complete gzip/CRC/staging path: 1,000 rows, 100 target records, zero
conflicts, 0.464 s. `off-ref-stream-real-prefix/report.json` explicitly says
`localRecompression=true`, `originalOffFullGzipVerified=false`. Subsequent staged
normalization produced **88 accepted original-source target Foods**, exactly the
original-prefix portion of the 93-record mixed proof, in 0.274 s. This validates
wiring, not full-dump speed or full-source CRC.

## Actual source size, budget and required decision

A read-only, conditional **HEAD** at the specific public S3 version succeeded:

- `versionId=1siWeAtliAmhnPfaH..bcEktpzvqWIyF`;
- ETag `"19fdd1231a6a22dfa463b3415ceacd4e-791"`;
- compressed length **13,262,350,813 bytes = about 12.35 GiB**;
- `Accept-Ranges: bytes`, matching version ID; Last-Modified 26 Oct 2026 05:51 UTC;
- snapshot/probe record: `artifacts/off-ref-bulk-preflight.json`.

Multipart ETag is not a SHA-256. Full streaming would compute its own compressed
SHA and verify gzip CRC/length, use verified HTTPS, a fixed official allowlist,
version-specific URL and If-Match. These detect accidental corruption and changed
objects; they are not a publisher digital signature. A final version HEAD/preflight
must pass again immediately before any authorized transfer.

| Additional disk budget (conservative) | GiB |
| --- | ---: |
| Retained full compressed source | **0** |
| Selected staging SQLite + bounded journal | 2.5 |
| New normalized complement + bounded journal | 2.5 |
| One previous complement reserved for rollback | 2.0 |
| Target/control metadata, logs and boundary overshoot allowance | 0.25 |
| **Total additional budget** | **7.25** |

At the measured **33.81 GiB free**, this leaves **26.56 GiB**, above the required
20 GiB. Existing wger generations and all earlier workspaces are already included
in the starting used space and are not deleted or copied. Retaining the 12.35 GiB
source as well would break this conservative budget, so **do not cache it locally**.
The schema/record-size distribution is uncertain: current accepted payload median
is around 1.5 KiB, some exceed 2.6 KiB. Caps may stop an import before all targets
fit; they must not silently rise. No estimate that all 980k become usable is made.

Network for **one** approved full pass: about **13.26 GB / 12.35 GiB**. Pure transfer
at 5 MiB/s is ~42 minutes, at 10 MiB/s ~21 minutes; parsing/validation can dominate
and has not been benchmarked at full size. Prefix transfer times are not used as
full-source performance predictions. Replay is an extra network cost requiring a
separate explicit decision if the budget was for a single pass.

Extraction and normalization run sequentially with low priority, not as concurrent
heavy imports. Start only with >=3 GiB available memory; require >=2 GiB continuously.
Python/native limits and bounded Node IPC aim below ~1 GiB combined; actual full-size
RSS/CPU remain to measure. Stop on reserve/cap violation, massive invalid data,
version mismatch or provider error; preserve staging/old generations and report.
The active web/API/mobile catalogue is never switched automatically.

**Historical decision before the first attempt:** authorize or refuse one pinned
full-source streaming pass. The subsequent authorization and interrupted execution
are documented below; another network pass is now a new decision. The stdin parser's availability
is not network authorization. Legacy products without explicit evidence will remain
unresolved; the 1,000-row prefix is not a basis for promising a French coverage rate.

## Files and reproducible checks

New: `off-reference-capture.py` (eight maintenance probes),
`off-reference-normalize.mjs` (coherent input-set adapter/IPC),
`off-reference-overlay.py` (target union, bounded build/read/coverage),
`off-reference-stream.py` (offline streaming/checkpoint/replay),
`off-reference-proof.mjs` (real local journal proof),
`off-reference.test.mjs`, `test_off_reference.py`.
Modified: `wger-evaluate.mjs` laboratory helper now uses a Food's actual reference
unit instead of hard-coded grams; existing mass proofs retain their fields.
No runtime application source or dependency manifest changed.

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
export TMPDIR="$PWD/scripts/nutrition-local-catalog/artifacts/parquet-runtime-tmp"
python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py' -q
node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs
# Inspect completed work; no network and no rewrite:
python3 -m json.tool scripts/nutrition-local-catalog/artifacts/off-ref-final-20261026/current.json
python3 -m json.tool scripts/nutrition-local-catalog/artifacts/off-ref-final-coverage-20261026/report.json
python3 -m json.tool scripts/nutrition-local-catalog/artifacts/off-ref-final-journal-20261026/report.json
```

Tests cover original g/ml, misleading mixed aggregates, kJ conversion, missing/
computed/qualified/nonfinite values, units, scoped/unscoped errors, conflicting
valid sources, own-property safety, future schemas, provenance/GTIN aliases;
gzip CRC/length, atomic checkpoints/replay, actual SIGKILL after checkpoint,
writer exclusion, resource exhaustion simulation, source/prefix mismatch,
idempotent completed replay, unsealed output refusal and unchanged old manifests.
A SIGKILL or exception is not a physical power-cut test. Final execution counts
and resources are recorded after the final runs below.

### Final checks and current limits

- Prototype Python: **207 passed**, 0 failed/skipped;
  `artifacts/off-reference-python-final-reviewed.log`.
- Prototype Node: **109 passed**, 0 failed/skipped, 6.64 s;
  `artifacts/off-reference-node-release-check.log`. Earlier relaunches concern the
  same tests and are not added to this total.
- Core Vitest: **144 passed / 4 files**, 0 failed/skipped, 61.11 s:
  `calculate.test.js`, `validate.test.js`, `serialization.test.js`, `recipe.test.js`;
  `artifacts/off-reference-core-vitest.log`. No full frontend/API/build rerun is
  claimed for this prototype-only change.
- JavaScript/Python syntax and `git diff --check` pass. No physical device,
  container, browser or power-cut validation is claimed.
- Atomic manifest creation was hardened to fsync a private temporary file then
  link it exclusively. Resume refuses an unrelated generation without a staging
  database, and the workspace lock uses O_NOFOLLOW; regressions verify no other
  manifest/file or permissions can be altered through those paths.
- Latest measured reserves: **33.812 GiB disk / 4.232 GiB available RAM**. The sealed
  wger and French-complement hashes remain unchanged. Branch `feature/nutrition`,
  HEAD `6610d192`; existing dirty worktree preserved, nothing staged/committed/pushed.

The full-size parser and staged normalizer are prepared and have local unit,
SIGKILL/replay and real-prefix wiring evidence, **not a completed full-source
import or proven full-size runtime**. Limits abort conservatively, including a
single unexpectedly oversized/malformed retained record. Such an abort requires
inspection/policy review before replay, not an automatic relaxed limit. Completed
staging can be normalized again offline; incomplete gzip staging may require
another whole-source network replay. Public data raw schemas may change, S3 old
versions may expire and no provider checksum/signature is assumed.

Projection version 2 also retains a bounded selection of original legacy
`nutrition_data_per`, serving quantity/unit/text, package unit and the relevant
legacy nutrient values/units/modifiers. They remain **non-authorizing evidence**
for later offline review, avoiding another bulk transfer merely to inspect them.
Input-set-based validation still refuses ambiguous legacy rows. The projection
version is pinned in the job identity, so a changed extractor cannot silently
append different semantics on resume. Previously completed laboratory stages
are preserved; a changed-version extraction uses a new workspace. The 100 raw
target projections measured 441 / 719.5 / 1,527 bytes min/median/max with this
projection; this small prefix does not establish the full-size distribution.
The V1 proof imports the four required values only; optional fiber/sugar/sodium/
saturated-fat values remain null rather than being synthesized or silently
copied from a different source set.

## Authorized full pass — 26 October 2026 (interrupted)

The user explicitly authorized one full stream of the identified 13,262,350,813-byte
object. The earlier decision-pending text records the state before authorization;
it does not authorize automatic retries or activation.

`off-reference-run.py` wraps the tested extractor. Before its sole GET it checks
both the latest official object and the exact approved version with conditional
HEAD, requiring identical version/ETag/size and verified HTTPS. It holds an
exclusive global import lock in addition to the staging lock. The raw source is
never stored as an archive. A two-second watchdog monitors disk/RAM and stops
conservatively at 20.25 GiB free or 2.25 GiB available (required reserves remain
20/2 GiB); per-executable RSS stays capped at 512 MiB. Nice priority 10 applies only
to this process, not system configuration. Progress is recorded after durable
checkpoints; limits and quotas are unchanged. On failure, the run writes an
incomplete report and never restarts the network automatically.

Planned new workspaces: `off-full-run-20261026` (events/report),
`off-full-stage-20261026` (filtered staging). The existing target index, wger base,
French complement and all earlier samples/generations are reused read-only.
Final counters, measurements and validation results will be appended after the run.

### Authorized attempt stopped — immutable partial evidence

The conditional HEAD checks passed and one GET began. The attempt stopped on
`invalid-stream-code` after 698.23 s (679.81 s CPU). No retry/replay was performed.
The last **durable** checkpoint is 1,351,000 source lines / 31,794,853,572 decoded
bytes, SHA `9928a4553e3ae6ef9f5b2863c0e0721dd70c8718ebfab9fda89fb22101baeea7`.
It retains **550,833 distinct targeted identities**, zero recorded payload conflicts.
SQLite integrity_check passes; no completed source state exists. Earlier live
progress messages (1,348,000 lines / 549,742 identities) were the last printed
30-second progress point, not the final checkpoint found on disk.

At least 5,413,404,682 compressed bytes were read (last emitted progress); the exact
final byte counter/offending identity was not persisted by the first implementation.
The bad string occurs after checkpoint line 1,351,000 and no later than 1,352,000.
Its exact value cannot honestly be reconstructed from the retained projections.
The source archive was not cached, and no full gzip CRC/SHA is available. Do not
label this a finished 13.26 GB transfer or invent an exact offending barcode.

The specific cause is a global producer check requiring every OFF `code` string
to contain 1–64 decimal digits. One original row violated that check; the error
is not a nutrient-unit decision, DNS failure, provider 503, quota failure or lack
of disk/RAM. Applying a target-specific identity constraint to unrelated public
rows unnecessarily stopped the entire stream. The source fragment remains on disk;
no active catalogue or previous generation changed.

The observed extraction peaks/minima: process VmHWM 53,716 KiB; disk free at least
35,670,814,720 bytes; available RAM at least 4,497,420,288 bytes. The failure was
not a resource watchdog event.

### Prepared correction, not a restarted network pass

Strict `stop` remains the default. A separately explicit
`--exclude-invalid-non-target-identities` option prepares the next pass: a malformed
string is excluded only after verifying it is absent from the exact target index.
It is never cast, trimmed, mapped to a guessed barcode or imported as Food. Any
invalid identity that matches a target still aborts. Exclusion is counted and
samples retain line/length/SHA, not potentially sensitive arbitrary raw strings.
A fixed 1,000-exclusion ceiling stops anomalous sources; existing compressed,
expanded, line, memory and SQLite limits are unchanged. The policy is part of the
checkpoint identity so it cannot silently change on resume. Default strict jobs
remain strict. Newly recorded failure receipts also retain the actual line and
byte counters. Regression tests prove these properties.

This correction has **not** been used for another network attempt. Replaying
ordinary gzip from zero would require roughly another 13.26 GB, beyond the single
pass granted, and therefore awaits explicit renewed authorization. A new workspace
would preserve this first attempt's evidence. No cleanup or overwrite is proposed.

### Safe local follow-up (completed on the committed prefix)

`off-reference-partial-audit.py` analyzes only the immutable committed checkpoint,
with the same Node input-set validator and no network. It checks the failed run,
source/target identities and SQLite integrity. It does **not** fabricate a completed
source state, seal a partial catalogue generation or relax `staged_rows` /
`attest_source` requirements. Its report always has `complete=false`,
`extractionComplete=false`, `fullDumpVerified=false`, `productionAllowed=false`;
`analysisComplete=true` only means the checkpoint analysis finished.

Each coherent Food retained in its bounded journal sample carries
`sourceIntegrity=partial-checkpoint-no-full-gzip-crc`, the decoded-prefix checkpoint
SHA and line count. Default journal-sample proof refuses this incomplete source;
a separate explicit `--allow-partial-source` laboratory flag can verify snapshots
and calculations without claiming source completion. Existing full-generation
readers remain strict. Pending original-source bytes are not inferred from data
that happened to be observed or from the subset's nutritional success rate.

New support tools in this attempt: `off-reference-run.py` (one pinned GET/watchdog),
`off-reference-normalization-run.py` (offline supervisor, not used to normalize an
incomplete source), `off-reference-full-report.py` (full-source-only report, not
used on partial data), `off-reference-sample-proof.mjs`,
`off-reference-partial-audit.py`, and their producer-header/partial-boundary tests.
No application source, account, user backup, `.env`, system setting or production
service changed. The completed original samples remain untouched.

### Final results of the interrupted attempt and local analysis

The complete checkpoint analysis is in
`artifacts/off-partial-audit-20261026/report.json`; **it explicitly remains an
incomplete extraction**. No partial reference generation/current pointer is published.

| Actual committed-prefix result | Count |
| --- | ---: |
| Durable source lines (lower bound of actually read lines) | 1,351,000 |
| Distinct targeted identities retained | 550,833 |
| Coherent Food reference / 100g | **470,099** |
| Coherent Food reference / 100ml | **24,461** |
| Coherent total | **494,560** |
| No usable coherent input set | 44,128 |
| Original input sets unavailable | 8,928 |
| Conflicting valid input sets | 3,210 |
| Explicit no-nutrition declaration | 7 |
| Total refused/unresolved targeted identities | **56,273** |
| Coherent codes observed in France in the full Prices census | **30,658** |
| Coherent codes also in the wger-French-language target group | 492,597 |

These are counts for the **captured prefix**, not all OFF or national coverage.
The original 980,963 targets remain unchanged; 430,130 have not been observed in
this prefix. French language and observed sale in France are separate measures.
Input-set rejection details (not additive product counts): unsupported/estimated
reference 27,396; source-scoped quality error 22,023; zero-only review 7,350;
missing/qualified value 5,301; no explicit energy 1,461; inconsistent energies 327;
invalid response/name structure 190; incompatible nutrient unit 1. Multiple rejected
sets can belong to one product; no denominator is inflated by summing them.

The frozen benchmark still has 1,000 cases / 913 supported barcodes. **356** have
coherent reference data within the captured prefix, versus zero in the unchanged
baseline. Of those, 354 were present-but-unusable in wger and two were absent from
wger. The other cases remain unresolved/not yet observed; the uncaptured remainder
is not guessed. There is no new semantic-relevance or 90% claim and nothing is
available in the active API/UI on the strength of this analysis.

The journal-sample proof was **refused by default**, as expected for an incomplete
source. The explicit laboratory-only run then passed **396/396** actual local
add/close/reopen/snapshot/pending-operation checks in 28.69 s: all 356 matched
benchmark foods plus 40 additional unit/source-stratified cases. Its report
`off-partial-journal-20261026/report.json` says `scope=journal-tests-only`,
`partialSourceCoverage=true`, `fullDumpVerified=false`, `applicationActivated=false`.
Wrong-dimensional quantities reject. No provider network, actual account or native
device is used. Node per-executable VmHWM was 106,240 KiB.

Staging SQLite: **632,279,040 bytes (~603 MiB)**; integrity_check `ok`; SHA-256
**`04b25ea8d4953d7d14fc4e38459b7bbae9d6e7d73d0c099a04cf32f3cbe9daf1`**.
Checkpoint analysis took **783.58 s**, with observed Node/Python peaks
104,932/30,580 KiB. Observed available RAM remained >=4,446,040,064 bytes and disk
>=35,667,398,656 bytes during that analysis. The full original gzip CRC/end was
never reached; its integrity is **not** reported as successful. Read-only checking
of the staging is not a substitute for that missing source validation.

A separate identity-shape audit checked all **980,963** target keys: all are
supported numeric exact/GTIN identities. Consequently the string rejected by the
old global source regex cannot be one of these targets. This proves the proposed
non-target exclusion addresses the failure without declaring a malformed target
or ambiguous nutrition valid. Its exact raw string was not retained in the first
attempt. Future failure receipts capture line/length/SHA and read-byte counts.

Validation after corrections:

- **215 Python tests passed**, zero failed/skipped,
  `artifacts/off-authorized-python-final.log` (7.99 s).
- **109 Node prototype tests passed**, zero failed/skipped,
  `artifacts/off-authorized-node-final.log` (6.61 s).
- **396 real-data laboratory journal checks passed** separately, not added to the
  unit-test counts; default incomplete-source refusal verified separately.
- Syntax / `git diff --check` pass. No full app/API/browser/native-device build or
  test claim is made for this maintenance-tool change.

Additional files of this pass: `test_off_reference_run.py` verifies pinned headers;
`test_off_reference_partial.py` proves a checkpoint analysis cannot become a full
source/current generation and does not modify the staging. `test_off_reference.py`
now checks strict versus explicit non-target exclusion, the fixed anomaly ceiling,
known-target protection and failed-source attestation refusal. The source admission
and incomplete-source guards remain strict by default.

**Decision at the end of the first attempt (subsequently authorized below):**
completing the job would replay the pinned
source from byte zero into a **new workspace**, with the explicit non-target fix,
requiring about another **13.26 GB**. The known first-attempt compressed read is
at least 5.41 GB, so cumulative payload would be at least ~18.68 GB. At that point no replay had
started. With about 33.22 GiB then free, the original 7.25 GiB conservative
additional budget would still leave about **25.97 GiB** without deleting any
existing generation/partial evidence. Version/resource/process preflight must run
again before a newly authorized attempt. If the source changes or a protection
fires, stop rather than silently switch sources or raise limits.

## Second explicitly authorized pass — preparation (2026-10-26)

The operator authorized exactly one additional full read of the same pinned
13,262,350,813-byte object. New workspaces `off-full-run2-20261026` and
`off-full-stage2-20261026` preserve the first failed extraction. No automatic
retry or third pass is authorized. No application activation is permitted.

Pre-transfer regressions verify explicit non-target exclusion, the fixed 1,000
anomaly ceiling, all-length malformed-target refusal, bounded diagnostics (ten
hashed examples, no raw invalid identifier), checkpoint replay without double
counting and conflicting identity quarantine. An unnecessary length shortcut in
the malformed-target check was removed: every excluded identity is checked
against the target table, including malformed values longer than 24 characters.
Nutritional conflict rejection and all storage/resource ceilings are unchanged.
Twenty-five reference-tool Python tests passed before network transfer; broader
prototype tests and the conditional source/resource preflight follow. A successful
GET alone will not count as extraction success: gzip EOF/CRC, exact compressed
length, SQLite integrity and source attestation must all succeed.

The second-pass conditional HEAD checks passed against both the current official
object and the pinned immutable S3 version: version
`1siWeAtliAmhnPfaH..bcEktpzvqWIyF`, ETag
`"19fdd1231a6a22dfa463b3415ceacd4e-791"`, 13,262,350,813 compressed bytes.
Start resources: 35,669,893,120 free disk bytes, 4,540,493,824 available RAM bytes.
219 Python and 109 Node prototype tests passed before the GET (no failures/skips).
The reference audit now records captured/uncaptured benchmark codes and each
reference status separately, preserves the original missing query labels, and
checks exact expected barcode identity. It explicitly leaves semantic precision
undefined. Two additional offline integration tests exercise the actual Node
normalizer, source attestation, g/ml preservation, conflicts, immutable benchmark
and rejection of a tampered source receipt.

### Second-pass live confirmation of the first failure

The pinned replay crossed the failed region successfully. A read-only, transactional
checkpoint inspection (not SQLite immutable mode on the active writer) recorded
one excluded identity: **line 1,351,086, empty code, length 0**, SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
This identifies the original failure in the same immutable source. The checkpoint
had advanced to 1,537,000 lines; there was no retry or policy/ceiling change.

### Second pass completed: full gzip and staging verified

The single authorized GET reached EOF and passed gzip CRC, exact compressed length
and SQLite integrity: **4,837,307 rows**, **956,487 retained target identities**,
**17 conflicting identities quarantined**, **two invalid non-target identities**
excluded (empty code at line 1,351,086; oversized 72-character code at line
4,237,237). No raw malformed identifier is logged. Compressed bytes:
13,262,350,813; decoded bytes: 83,990,501,846. Compressed SHA-256:
`eebc0c06538756151bba499ca1f46cdd8bd477360201084f770a227f392766ac`;
decoded SHA-256:
`df1355d16f1ff5524dae7ece86f59cfa48ed8bfb260b740a26cbc2d8983dd30d`.
The run report is `off-full-run2-20261026/report.json`; extraction took about
31 min 29 s. No retries, full local archive, old-generation replacement or
application activation occurred. Offline normalization follows into a new
workspace, with the existing 2 GiB SQLite / 2.5 GiB workspace ceilings unchanged.
Full extraction does not imply that all retained products have usable nutrition.

The full-complement audit preserves the frozen Open Prices frame and reports
reference status for every expected barcode (including absent and rejected).
Exact barcode identity is its explicit relevance criterion; missing human
semantic labels remain missing. Six separately labelled maintenance controls
(Nutella, Coca-Cola, milk, coconut oil, pastry, yoghurt) report their *actual dump*
status and values; accepted controls also enter the offline journal sample.
They do not change the public benchmark denominator, sample, labels or metrics.
The source/input-set strata remain bounded and deterministic. Regression tests
verify that unavailable/conflicting controls are not promoted into Foods.

### Completed experimental normalization

`off-reference-full2-20261026/current.json` was durably written after SQLite
integrity and source attestation succeeded. **956,487 records**, **835,231 accepted**,
**48,357 accepted identities observed in France by Open Prices**. The latter is a
market-observation cohort, not the count of French-language products. The file is
**1,762,095,104 bytes**, SHA-256
`cead4b01ef23bc1e12470820ad4fe06fc1207899c850fa9f1ed835b91c79a6a7`.
Rejected/unresolved records: 79,648 no usable input set; 36,751 original sets absent;
4,826 conflicting valid nutritional sets; 17 conflicting source identities;
13 no-nutrition declarations; one unsupported barcode. These are mutually
exclusive record statuses and sum with accepted records to 956,487.

Normalization supervisor elapsed 1,912.56 s; observed peaks Python 35,660 KiB,
Node 125,928 KiB. Available memory stayed >=4,408,483,840 bytes and free disk
>=32,862,568,448 bytes. Existing limits were not increased.
`fullDumpVerified=true` attests the complete source; `productionAllowed=false`
continues to prohibit treating this developer generation as active application
data. The frozen-frame full audit and journal proof follow separately. The old
`foods` sample command intentionally remains capped at 1,000 and is unsuitable for
materializing this full complement. Future integration must use bounded indexed
reads; it must not raise that sample cap or rebuild the base wger generation.

## Final second-pass validation — authoritative results

The full original source is verified; no third transfer, production activation,
user-store mutation or wger rebuild occurred. The verified generation is
`off-reference-full2-20261026/current.json`, referencing
`reference-3d6c4d417a774d06ad4083e0d8d1e44b.sqlite`. The reference format remains
prototype v1 and portable Nutrition v1 is unchanged.

| Measurement | Verified result |
| --- | ---: |
| Original OFF lines scanned | 4,837,307 |
| Distinct target identities retained | 956,487 |
| Accepted complete coherent Foods | 835,231 |
| Explicit 100 g reference | 803,100 |
| Explicit 100 ml reference | 32,131 |
| Rejected / unresolved target records | 121,256 |
| Accepted observed in France, Open Prices census | 48,357 / 77,894 (62.08%) |
| Accepted also in wger French-language target cohort | 829,044 |
| Source manufacturer / packaging | 8,315 / 826,916 |

Language is not evidence of French market distribution. Cohorts overlap and must
not be added. Reference counts are unique retained identities, not all 4.8 million
source lines. The two invalid non-target identities and the non-target source
products are not nutritional rejections. The original 3,058,354-row wger index
remains unchanged. None of these new Foods is activated in the application.

### Frozen independent benchmark

The frame is still 1,000 cases, including 913 supported expected barcodes and
87 without one; missing query names are retained. `cases.jsonl` SHA-256 is still
`7fef1878b0085ab693eea9ed9f94121e463cb433c71adaaf77df7ebbb0e4a2dd`.
No source sampling, expected code, split or label was changed.

| Stage | Found expected codes | Usable reference |
| --- | ---: | ---: |
| Original wger baseline | 600 | 0 |
| Interrupted first-pass prefix | partial source | 356 |
| Full verified OFF complement | 744 | 544 |

The gain over the prefix is **188**, with **zero lost prefix matches**. Of the
544 valid cases, 515 were in the original wger index and 29 were absent: a future
reader/index integration is still required and a barcode reference match does not
prove text-search reachability. Among supported codes: 544/913 = **59.58%**; 200
are captured but unresolved/rejected (105 no usable set, 60 original sets absent,
35 conflicting valid sets), 169 are absent from this source capture. These
figures do not demonstrate 90% coverage.

The relevance criterion is the exact expected barcode identity (including only
verified GS1 aliases). Human semantic relevance and precision@5 remain unknown;
no fuzzy or text ranking changes were made.

### Real-data journal and controls

**586/586** Foods passed actual offline service/file-backend laboratory paths:
510 mass / 76 volume, add 50 g or ml, close and reopen, identical historical
snapshot, half-reference totals, pending operations retained, wrong dimension
rejected, zero provider calls. The sample includes all 544 valid benchmark codes,
40 deterministic source/unit-stratum controls, and five accepted curated controls,
with duplicates coalesced. It is not 586 independent additional benchmark cases.
No actual account, browser, Android/iOS device or physical power cut was tested.

| Curated control | Actual original dump reference | kcal / protein / carbohydrate / fat |
| --- | --- | --- |
| Nutella, 3017620422003 | 100 g, manufacturer | 539 / 6.3 / 57.5 / 30.9 |
| Coca-Cola, 5449000000996 | 100 ml, packaging | 180 kJ / 4.184 = 43.0210325 kcal / 0 / 10.6 / 0 |
| Pâturages milk, 3250392190484 | 100 ml, packaging | 41 / 3.2 / 4.8 / 1 |
| Coconut oil, 3760295170051 | 100 ml, packaging | 889 / 0.2 / 1.8 / 98 |
| Biobleud pastry, 3531150222020 | 100 g, packaging | 340 / 6.6 / 38 / 18 |
| Yoghurt, 3770011205004 | Original input sets unavailable | Not promoted to a Food |

All numbers are OFF declarations from the pinned original export, not refreshed
API values or verified physical labels. The oil reference remains as declared; no
density is inferred. The incomplete yoghurt is a deliberately retained negative
control. These six curated controls do not change the public benchmark.

### Resource measurements and review corrections

Debian, four vCPU; Node 22.23.3, Python 3.13.5 / SQLite 3.46.1. Source pass
1,888.68 s (CPU 1,784.98 s), normalization supervisor 1,912.56 s, reviewed full audit
142.84 s (CPU 82.04 s), journal 41.39 s. These are per-phase measurements; repeated
checks and test runs must not be summed into a purported single benchmark.

Staging: 1,041,633,280 bytes (~0.970 GiB). Final reference SQLite: 1,762,095,104 bytes
(~1.641 GiB); no gzip or full decoded export retained. End disk about **30.60 GiB**
free, RAM about **4.2 GiB** available. Lowest observed availability in the guarded
source/normalization runs: **32,862,568,448 disk bytes**, **4,408,483,840 RAM bytes**.
These are monitored margins, not a reservation against unrelated VPS services.

Per-process Linux VmHWM: extraction Python 54,424 KiB; normalization Python
35,660 KiB / Node 125,928 KiB; reviewed audit Python **34,304 KiB**; journal Node
109,632 KiB. The first audit reported `getrusage().ru_maxrss = 700,064 KiB`.
A rerun proved that value was already present at startup, while `/proc/self/status`
VmHWM was 19,948 KiB; it was not a comparable post-exec audit peak. Keep the first
report as diagnostic evidence, but use the reviewed report's VmHWM and phase
checkpoints. A fixed 512 MiB actual VmHWM guard was added to the audit. No source,
normalization, disk or anomaly cap was raised. Both complete audits have identical
status/unit/benchmark/control results and identical journal-sample SHA-256.

Functional review: exact barcode identity, complete source receipts, source
collisions, nutritional conflicts, g/ml dimensions, frozen sample and old snapshots
were checked. Durability review identified that new workspace creation needed a
parent directory fsync; `root(new=True)` now syncs BASE immediately after mkdir.
A subsequent explicit parent fsync also preserves entries created earlier in this
run. This is tested and improves the write ordering; it is not a physical
power-cut validation. Old generation hashes are unchanged in the preservation
receipt.

Test isolation review found that prototype `catalog.build()` intentionally lowers
its process address-space soft limit to 256 MiB. Older in-process tests leaked that
limit into later real Node integration tests, causing V8 startup to fail and
`normalizer-output-limit` on EOF. The catalogue, fuzzy-fixture, worker and Docker
lab test cases now restore their entry limit via unittest cleanup. The real limit
is still exercised and verified inside a nested test. Production/import limits
are unchanged; this is test-runner isolation, not a higher catalogue quota.

Validation history (do not add overlapping runs): before the GET, 219 Python and
109 Node passed. The initial expanded 221-test Python run and the first 223-test
cleanup attempt each had two errors from the leaked limit (the Docker lab test
cases were also a source). After all four test classes were isolated, **223/223**
passed; the final run after memory instrumentation also passed **223/223**, zero
failed/skipped, 8.11 s. Final Node run: **109/109**, zero failed/cancelled/skipped,
6.30 s. The **586** real-data journal paths are separate from these unit counts.
Full frontend/API suites and device builds were not rerun: no runtime application
code was changed in this pass.

### Evidence and reproducible offline checks

- `artifacts/off-full-run2-20261026/report.json`: the sole second GET and full CRC.
- `artifacts/off-normalize-run2-20261026/report.json`: complete normalization.
- `artifacts/off-reference-full2-20261026/current.json`: verified generation.
- `artifacts/off-full-audit2-reviewed-20261026/report.json`: authoritative audit,
  benchmark, controls, memory phase checks and sample hash.
- `artifacts/off-full-journal2-20261026/report.json`: 586 journal results.
- `artifacts/off-full-validation2-20261026/report.json` and `receipt.json`:
  before/after, unchanged frame, preservation hashes and source attestation.
- `artifacts/off-authorized2-python-reviewed.log` and
  `off-authorized2-node-final.log`: final unit-suite results.

```sh
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
export TMPDIR="/home/codex/openGym/scripts/nutrition-local-catalog/artifacts/parquet-runtime-tmp"
python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py' -q
node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs
# These create NEW laboratory workspaces and refuse to overwrite existing ones.
python3 scripts/nutrition-local-catalog/off-reference-full-report.py \
  --overlay off-reference-full2-20261026 --benchmark prices-pq-cases-20261026 \
  --workspace off-audit-manual-20261026
node scripts/nutrition-local-catalog/off-reference-sample-proof.mjs \
  off-audit-manual-20261026 off-journal-manual-20261026
git diff --check
```

These commands are offline and do not rebuild wger or activate a catalogue. A
third source GET is neither necessary for these checks nor authorized. Next steps
require human review: validate the remaining coverage gaps, design a bounded
reader/index join for this complement (including products absent from wger), then
exercise development-only API/Web/Android paths and permissions. No production
activation, automatic update, deletion, commit or push is included.

Files changed in this second-pass work: `off-reference-stream.py`,
`off-reference-overlay.py`, `off-reference-full-report.py`, `test_off_reference.py`,
new `test_off_reference_full.py`, `test_catalog.py`, `test_fuzzy.py`,
`test_worker.py`, `test_docker_lab.py`, and the three reference/prototype/benchmark
documents. All pre-existing uncommitted application changes were preserved.

## Read-only application consumer (26 October 2026)

The completed second-pass reference generation is now consumed by the opt-in
development worker `wger-off-reference.py`. A separate 288.6 MiB metadata index
binds verified wger UUIDs to canonical OFF barcodes and indexes accepted OFF names
absent from wger. Neither extraction, immutable Food payloads nor their validation
policy changed. The worker checks the source generation hash, full-dump attestation,
each selected payload signature and its original capture hash; no new transfer or
wger reconstruction is needed. Full deployment/testing instructions and measured
results are maintained in `NUTRITION_FOOD_CATALOG.md`, section “Intégration validée
en développement”. The 544 frozen independent benchmark references remain usable.
This is a development integration, not production activation or approval to publish.
