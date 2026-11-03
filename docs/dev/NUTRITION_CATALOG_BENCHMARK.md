# Public food catalogue benchmark

**Latest execution:** direct Open Prices Parquet acquired and evaluated successfully on 26 October 2026; see the final section. The OFF label join remains incomplete after provider HTTP errors. Historical sandbox limitations below describe earlier runs, not the current network state.

This reference replaces the 18 hand-curated generic queries as **coverage evidence**. They remain useful regression tests for selected translations; they cannot establish 90% coverage of French food logging.

## Public sources examined (26 October 2026)

| Source | What it actually supplies | Use and limits |
| --- | --- | --- |
| [Open Prices](https://huggingface.co/datasets/openfoodfacts/open-prices), [official card](https://huggingface.co/datasets/openfoodfacts/open-prices/raw/main/README.md) | Observed prices, barcodes, raw-food categories, dates and shops/countries. The viewer currently reports about 335k **observations**, not unique foods. Packaged-product names can be absent. | Primary source of independent French-market barcode cases. Deduplicate products; report observation counts separately. Contributor/shop concentration is not national purchasing frequency. This is not a search-query log or a nutrition source. |
| [Open Food Facts product database](https://huggingface.co/datasets/openfoodfacts/product-database) | Multilingual product names, brands, barcodes, countries, quality fields and projected nutrition. The viewer currently reports about 4.84m food rows. | Supplies independent product-title cases and, when available in a separately captured file, labels for Open Prices barcodes. French language does not by itself prove distribution in France. The simplified projection does not resolve the original 100 g / 100 ml ambiguity. Its overlap with wger/OFF must be reported. |
| [Amazon ESCI](https://github.com/amazon-science/esci-data), [official README](https://raw.githubusercontent.com/amazon-science/esci-data/main/README.md) | Actual shopping queries and human Exact/Substitute/Complement/Irrelevant judgements; the small ranking set has 48,300 queries. English/US, Spanish/ES and Japanese/JP; product identities are Amazon IDs. | Methodological reference for human judgements and nDCG. No French food subset or reliable GTIN mapping is supplied. Do not translate its queries and call that measured French behaviour, or transfer its relevance labels to wger IDs. No ESCI dataset download, model or training dependency was added. |

Open Prices data is ODbL; proof images have separate CC BY-SA 4.0 terms and are not downloaded. OFF data/contents retain ODbL/DbCL attribution. ESCI publishes an Apache-2.0 repository licence and NOTICE, which must accompany any eventual reuse. None of these public datasets grants access to personal openGym information. Raw captured pages stay in ignored, private prototype workspaces; benchmark projections omit contributor hashes, receipt images/paths, coordinates, prices and user identifiers.

## Frozen protocol

1. Capture without looking at openGym search results. **Open Prices now uses its direct official Parquet**, with a full scan of `location_osm_address_country_code == FR` and seeded selection after deduplication. Do not retry the failing price `/filter` endpoint. The retained Viewer collector is optional for OFF-only stratified captures; the [documented Dataset Viewer `/filter`](https://huggingface.co/docs/dataset-viewer/filter) also supplies the separate bounded OFF label join. Neither is required to acquire the price frame.
2. Viewer OFF captures remain capped at 20 pages × 100 rows, 32 MiB total, 8 MiB/page, 600 seconds, 256 MiB process address space; HTTPS only, fixed host/paths, no credentials, no retry. The direct price Parquet has separate 64 MiB/batch-decoding caps described below. Each page, URL, offset, byte count and SHA-256 is retained. A DNS/429/503/timeout error leaves an explicitly incomplete receipt. Source populations can change between pages; retained bytes make the captured benchmark reproducible, not a globally atomic snapshot of a daily-updated provider.
3. `public-benchmark.py prepare` verifies all capture hashes and the complete envelope. Keep only French-market evidence, deduplicate barcode identities (GS1 canonical aliases only for valid checksums), and freeze at most 2,000 cases by seeded hash. Missing names, unsupported titles and unresolved labels remain visible in denominators. Do not keep only foods already addable to the journal.
4. Titles are **product-title queries**, not user search logs. Exact title evaluation is a diagnostic, not semantic relevance ground truth. Cases with the same normalized title share a development/validation/test split. Since same products with changed titles could still leak across splits in future joined captures, do not train a learned ranker on this first protocol.
5. Evaluate the immutable base and quality complement locally, without external requests or writes to user storage. Read-only barcode presence/addability, exact expected barcode in the first five text results, syntax/label failures, latency, RSS and resource budgets are separate metrics. “Any usable result” is explicitly **not a relevant result**.
6. `judgements.jsonl` preserves the displayed top results with `esciJudgement:null`. Human labelling E/S/C/I is needed before reporting semantic precision@5 or nDCG@5; these metrics remain null. Do not treat a similarly named product with a different preparation, brand or unit as an exact hit.

## Reproducible commands

The **Direct Open Prices Parquet strategy** below contains the current copy-and-paste SSH procedure. The old `public-benchmark-sample.py --source prices-fr --fetch` command is retained as historical tooling but is no longer recommended or invoked. Its existing captures remain readable. OFF label batches reuse the existing tool after the price cases are frozen.

`public-benchmark-labels.py` joins the frozen price case codes using the documented Dataset Viewer comparison filters: at most 50 exact codes per OR predicate, 20 requests for 1,000 codes, 32 MiB and 600 seconds, no retry. It queries the OFF **dataset**, not the food-product API. Original code strings are retained; no guessed aliases are added. Empty batches/missing codes are recorded as missing data, not retried or removed from the price frame. The returned code and row identity must belong to the requested batch. Schema drift, duplicates, truncated required fields or unexpectedly large results abort with an incomplete receipt. Five additional deterministic tests cover this collector. It has not yet obtained real label pages here because of the known DNS restriction.

Two independent small random captures would have very few matching codes; the bounded code-batch projection is therefore the preferred label join. The separate `off-fr` stratified capture remains useful as an independent product-title frame. Never obtain missing labels from the catalogue under test and call that independent coverage. Open Prices observations with unresolved food-domain/category or label evidence remain explicit and need review; a missing OFF match alone does not prove a non-food product.

## Current evidence and pending work

`public-off-prefix-v1-20261026` freezes 1,000 cases from the existing genuine 5,000-row official TSV prefix: 1,319 French-market unique identities were eligible; 248 of those source identities lack names. Hash selection is independent of catalogue results; splits are 599 development, 198 validation, 203 test. This is much larger than the curated queries, but the original low-barcode prefix remains biased. Its results must be labelled **prefix diagnostic**, not representative French coverage.

Open Prices acquisition was attempted once here and stopped with `sample-dns-error`; no retry or dump download occurred. Broader public-source measurements therefore remain pending SSH capture. Automated tests cover deterministic strata, source selection independent of hits, deduplication, missing labels, split grouping, corrupted/truncated inputs and an incomplete receipt on network failure. The final prototype suite passes 181 Python tests, including eleven public-benchmark/label tests, and 95 Node tests; these are separate executions, not additional public data observations.

### Final prefix diagnostic run

Input cases are unchanged (`casesSha256=6188ae17f5a38283f94a64d0d8977a67cf93deb026821389dff5d3497730c6e5`). `public-off-eval-final-20261026/report.json` reports **1,000/1,000 evaluated**, 803 executable title queries, 190 missing labels, seven titles outside the supported query contract and one identity without a supported barcode. There are 311 expected barcodes present. All 311 have four declared macros passing the numerical business rules, but **zero** have a reference usable for journal import. Exact expected addable barcode in top five: zero. An unrelated usable result appears in 111 searches; that is not a relevance success. These figures confirm that units/provenance, rather than simply missing macro numbers, block this prefix cohort.

Measured on Debian, Python 3.13.5 / SQLite 3.46.1, complete real wger base plus the quality complement: mean text search **4.09 ms**, p95 **15.74 ms** over the 803 executed queries; 3.57 s evaluation after 11.70 s startup integrity hashing; 3.34 s CPU; Python peak RSS **38,312 KiB**. No network calls. These are local title diagnostics with warm OS cache, not browser latency or a national coverage estimate. The result pool and null human judgements remain in `judgements.jsonl` for independent annotation.

The sampler now rejects truncation of required identity/title/country fields, while permitting and recording truncation of irrelevant image/environmental fields. It never uses the latter for nutrition. This prevents an unrelated large cell from forcing a different, potentially biased slice.

Remaining: obtain the bounded Open Prices and OFF captures over SSH, resolve food-domain/label gaps independently of the tested catalogue, review source/shop/time concentration, and label a held-out result pool. Open Prices prices/receipts are not food-search logs, not nutrition data and not a national purchase panel. Unknown product-domain or unresolved-label cases must remain explicit; no precision/90% claim can be derived from them. ESCI supplies the judgement methodology, not French ground truth for these identifiers.

## Direct Open Prices Parquet strategy (26 October 2026)

The France Dataset Viewer capture returned HTTP 500 on SSH. Do **not** keep retrying that endpoint. The preferred price acquisition is now the [official `prices.parquet`](https://huggingface.co/datasets/openfoodfacts/open-prices/tree/main). The Hub page consulted announces about 34.5 MB; it changes daily. A cached raw pointer can describe an older revision: never combine a size or hash from `main` at different times. The collector requests Hub metadata once (`?blobs=true`), pins its commit, and verifies the file against that revision's LFS size and SHA-256. This is corruption detection tied to HTTPS publisher metadata, not a digital signature.

`public-benchmark-parquet.py fetch` is a plan unless `--fetch` is explicit. No `/filter` or food-product API is used. Allowlisted HTTPS Hub/CDN redirects only, at most four redirects, no credentials/retries, 64 MiB source cap, 1 MiB metadata cap, 600 s deadline and per-socket 30 s timeout. New private workspace only; 0700 directory/0600 source. A partial file is never accepted; failed downloads leave an incomplete receipt, remove only their own partial file and preserve all other workspaces. No source/capture can replace an existing workspace.

`project` rechecks the source SHA, length, PAR1 header/footer and bounded footer length. Maintenance-only PyArrow 26.0.0 (Apache-2.0) validates actual column types and reads only id, barcode, country code and optional title/category, in batches of 256 on one thread. No pandas or full-table conversion. Boundaries: 2m observations, 200 columns, 4 MiB footer, 64 MiB selected decoded data per row group, 4 MiB batch, 192 MiB Arrow allocations, RSS check at 512 MiB between batches, 300 s CPU/600 s wall time, 256 MiB projection workspace and SQLite's 128 MiB page cap. These checks are conservative abort conditions, not a kernel memory reservation; a native decoder can transiently allocate between checks. The file is publisher-hash-verified before decoding, thrift limits/extensions are constrained, and system availability checks preserve the 20 GiB disk/2 GiB available RAM reserves. A different dataset shape or growth beyond the caps needs review, not automatic cap increases.

No complete Parquet expansion is written to disk. A private SQLite census deduplicates all `country_code == 'FR'` observations by barcode (valid GS1 canonical aliases only), including observations with absent names. Invalid/absent barcodes remain unresolved observation cases, with explicit counters; they are not claimed as distinct known foods. Duplicate observation IDs abort. Contradictory source titles become unresolved instead of choosing the convenient title. Seeded hashes select at most 2,000 identities **after the complete France scan**, irrespective of title availability, addability or catalogue hits; default 1,000. Projection is compatible with the existing `prepare`, label batch collector and `evaluate`. It retains no contributor hash, receipt path/image, coordinates, shop identity, price or date. The full downloaded public source contains such fields and must stay private/unpublished. No proof images are downloaded.

The same seed and a case budget no larger than the frozen projection are required by `prepare`. Counts distinguish all source rows, France observations, deduplicated identities, unresolved titles and sampled cases. The join uses a separate OFF capture, never wger names, before any query is evaluated. Missing OFF labels stay in the denominator; a provider error leaves an incomplete label capture. There is no automatic retry or alternate endpoint loop. The projection and later labels **do not resolve the original OFF 100 g / 100 ml reference**. Existing addability and human-relevance rules remain unchanged; precision/nDCG stay null without judgements. French contributor/shop sampling remains a limitation even though this reads all price rows.

The Parquet dependency is isolated in `requirements-benchmark.txt`; it is not an API/frontend/Docker runtime dependency. The following SSH command also works when Debian lacks `ensurepip`: create a venv without pip, then use pip's [documented standalone zipapp](https://pip.pypa.io/en/stable/installation/#standalone-zip-application) inside that venv. No sudo, global install or service change. The zipapp is a maintenance bootstrap tool, not part of production.

```bash
(
  set -euo pipefail
  cd /home/codex/openGym
  umask 077
  CATALOG_TOOLS=scripts/nutrition-local-catalog
  BENCH_RUN=$(date -u +%Y%m%dT%H%M%SZ)
  PRICES_RAW="prices-pq-$BENCH_RUN"
  PRICES_FR="prices-fr-$BENCH_RUN"
  PRICES_IDS="price-ids-$BENCH_RUN"
  PRICES_LABELS="price-labels-$BENCH_RUN"
  PRICES_BENCH="price-bench-$BENCH_RUN"
  PRICES_RESULTS="price-results-$BENCH_RUN"
  BENCH_ENV="$CATALOG_TOOLS/artifacts/arrow-$BENCH_RUN"

  # Checks reserves before either dependency or data download.
  python3 "$CATALOG_TOOLS/preflight.py"
  python3 -c 'import sys; sys.path.insert(0,"scripts/nutrition-local-catalog"); from catalog import resources,BASE,require; b=resources(BASE); require(b["freeDiskBytes"]>=21*1024**3 and b["availableMemoryBytes"]>=3*1024**3,"insufficient-benchmark-headroom"); print(b)'
  python3 -m venv --without-pip "$BENCH_ENV"
  mkdir "$BENCH_ENV/tmp"
  export TMPDIR="$PWD/$BENCH_ENV/tmp"
  curl --fail --show-error --proto '=https' --connect-timeout 15 --max-time 60 \
    --max-filesize 16777216 https://bootstrap.pypa.io/pip/pip.pyz \
    -o "$BENCH_ENV/pip.pyz"
  "$BENCH_ENV/bin/python" "$BENCH_ENV/pip.pyz" --isolated --disable-pip-version-check install \
    --no-cache-dir --retries 0 --timeout 30 --only-binary=:all: --no-deps \
    -r "$CATALOG_TOOLS/requirements-benchmark.txt"
  "$BENCH_ENV/bin/python" "$CATALOG_TOOLS/check-public-parquet.py"

  python3 "$CATALOG_TOOLS/public-benchmark-parquet.py" fetch \
    --workspace "$PRICES_RAW" --fetch
  "$BENCH_ENV/bin/python" "$CATALOG_TOOLS/public-benchmark-parquet.py" project \
    --source "$PRICES_RAW" --workspace "$PRICES_FR" --cases 1000
  python3 "$CATALOG_TOOLS/public-benchmark.py" prepare \
    --source "$PRICES_FR" --workspace "$PRICES_IDS" --cases 1000

  # Barcode/addability diagnostic can run NOW, even when names remain absent.
  python3 "$CATALOG_TOOLS/public-benchmark.py" evaluate \
    --benchmark "$PRICES_IDS" --base wger-full-registered-20261025 \
    --complement wger-fr-quality-20261026 --workspace "$PRICES_RESULTS" --seconds 300

  printf '\nCapture: %s\nProjection: %s\nBenchmark: %s\nResults: %s\n' \
    "$PRICES_RAW" "$PRICES_FR" "$PRICES_IDS" "$PRICES_RESULTS"
  # Optional independent OFF label projection: separate, bounded, no retries.
  python3 "$CATALOG_TOOLS/public-benchmark-labels.py" \
    --benchmark "$PRICES_IDS" --workspace "$PRICES_LABELS" --fetch
  python3 "$CATALOG_TOOLS/public-benchmark.py" prepare \
    --source "$PRICES_FR" --labels "$PRICES_LABELS" \
    --workspace "$PRICES_BENCH" --cases 1000
  python3 "$CATALOG_TOOLS/public-benchmark.py" evaluate \
    --benchmark "$PRICES_BENCH" --base wger-full-registered-20261025 \
    --complement wger-fr-quality-20261026 --workspace "label-results-$BENCH_RUN" --seconds 300
)
```

Stop on any nonzero exit, checksum/schema mismatch, incomplete receipt or reserve violation. Keep the printed workspace names. A failure of the optional OFF label step does not invalidate the completed price census or barcode evaluation; it leaves title-based evaluation unresolved. Do not run either source collector again in a retry loop. Budget 1 GiB total headroom conservatively for the capped source/projection and isolated reader/tool files; no multi-gigabyte OFF export is involved. All artefacts remain ignored and no application catalogue is published.

### Validation of this change

- `python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_public*.py' -q`: **22 passed**, zero skipped; eleven are new Parquet transport/projection tests. They use simulated HTTP and bounded row generators, not a real Parquet codec. Cover pinned revision/SHA/length, partial transfers and body timeout, DNS/500, HTTPS redirect allowlist/budget, footer/receipt tampering, FR census, duplicates, contradictory/missing labels, deterministic ordering, privacy and reuse of the existing prepare contract.
- Full prototype Python suite: **192 passed**, zero skipped, 7.13 s (`artifacts/parquet-python-final.log`). Run with `TMPDIR` on the repository's disk. An initial run on `/tmp` failed with 63 errors/seven failures because that tmpfs has less than the required 20 GiB disk reserve; no validation was weakened. The subsequent disk-backed run is separate, not an addition to those results.
- Node prototype regression suite: **95 passed**, zero skipped, 6.20 s (`artifacts/parquet-node-regression.log`), Node 22 with `--experimental-test-isolation=none`.
- `check-public-parquet.py` defines **four actual PyArrow/Parquet checks**, including missing country, numeric barcode rejection and real-codec end-to-end projection. It exits explicitly with `parquet-reader-missing-install-isolated-pyarrow` here; **zero of these four ran**. They are required in SSH before declaring Parquet decoding validated. No reader was installed globally or added to an application image.
- One actual Hub acquisition attempt: `prices-parquet-20261026/capture.json` is incomplete with **`parquet-dns-error`**, before any Parquet bytes. No retry and no price `/filter` call. Consequently there is **no new real France census, row/schema inspection, catalogue evaluation, RAM/import or coverage measurement** from this file yet. The previous TSV-prefix results are not substituted for these missing measurements.
- `py_compile` and `git diff --check` pass. Runtime frontend/API routes, user stores, historical snapshots and active catalogue manifests are untouched in this change; their full application suites were not rerun for this maintenance-only change.

Portable test command preserving the reserve check:

```bash
cd /home/codex/openGym
BENCH_TMP=$(mktemp -d scripts/nutrition-local-catalog/artifacts/parquet-tests.XXXXXX)
TMPDIR="$PWD/$BENCH_TMP" python3 -m unittest discover \
  -s scripts/nutrition-local-catalog -p 'test_*.py' -q
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs
```

## Completed real Parquet run — network-enabled session, 26 October 2026

### Acquisition and provenance

The sandbox DNS failure was confirmed by a successful read-only DNS/HTTPS check outside it. After network access was expanded, ordinary `getent ahosts huggingface.co` and `curl -I --max-time 15 https://huggingface.co` both succeeded (HTTP 200, TLS checks active). No resolver, TLS, firewall, environment or production setting was modified.

The source had already been obtained before the session interruption and was **reused after verification**, not downloaded again:

- capture: `prices-pq-20261026-network`;
- revision: `6b75f0ba63ca5673bc1cdfba47af941a47341b53`;
- source: `https://huggingface.co/datasets/openfoodfacts/open-prices/resolve/6b75f0ba63ca5673bc1cdfba47af941a47341b53/prices.parquet`;
- exact file bytes: **34,456,811**, SHA-256 **`622e8abb9bfb181d8d0c58c0eb5721fd54950e8ea79c6de9c612cf46239378c4`**, matching Hub LFS metadata;
- capture time: 1.25 s, HTTPS/allowlist/size/hash checks passed;
- actual schema: **48 columns**, **335,600 observations**, **328 row groups**. Identity is int64, barcode/title/country code are strings. All rows of the five needed columns were decoded; irrelevant private/public-contributor fields were not decoded or exported. The whole source file is hash-checked, but this is not semantic validation of every unused column.

The isolated `arrow-20261026-network` environment contains PyArrow **26.0.0**. The versioned pip zipapp URL returned 404; the official documented unversioned `pip.pyz` succeeded and reports **pip 26.2.2**. The copy-and-paste setup above is corrected; do not keep requesting the 404 URL. Reader/tool files occupy **174,091,288 bytes** without following Python symlinks. No global packages, application dependencies, services or runtime images were changed.

### Complete France scan and frozen cases

`prices-fr-pq-20261026` is complete, independently selected before any catalogue query:

| Census metric | Actual count |
| --- | ---: |
| Source observations | 335,600 |
| Observations with country code exactly FR | 215,926 |
| Other observations | 119,674 |
| Duplicate product observations collapsed | 129,769 |
| Distinct supported-barcode identities | **77,894** |
| Observations without a supported barcode, retained as unresolved cases | **8,263** |
| Combined identity/observation frame | 86,157 |
| Identities with unresolved titles | 39,498 |
| Of those, identities with contradictory source titles | 23,092 |

The barcode count means supported barcode **format**, not that every checksum or food-domain is validated. Canonical zero-padding aliases are used only when the GS1 checksum is valid; otherwise identity remains the exact source string. Three observations have malformed nonempty barcode strings. Raw/no-barcode cases are **observations**, not deduplicated known products, and must not be called 8,263 additional unique foods.

The 1,000 hash-selected cases include 913 supported barcodes and 87 cases without one. Titles: 533 usable source names, 196 missing/unsupported names and 271 contradictory names made unresolved conservatively. Nothing was removed based on wger presence or addability. Splits: 580 development, 210 validation, 210 test. `prices-pq-cases-20261026/cases.jsonl` SHA-256: **`7fef1878b0085ab693eea9ed9f94121e463cb433c71adaaf77df7ebbb0e4a2dd`**; benchmark manifest SHA: `53d0875e4169899a0986c62835eb8d6f69b2d827a3e9246a4b7290a6b06d08ea`.

Projection scan: **18.65 s wall / 12.41 s CPU**. Recorded `ru_maxrss` **101,260 KiB** is a conservative high-water observation with the pre-exec inheritance caveat explained below. Dedup SQLite: **17,149,952 bytes**; private JSONL projection: **191,889 bytes**. No full decoded source is materialized and no wger generation is rebuilt.

### Wger + French complement evaluation

`prices-pq-eval-20261026/report.json` reports **1,000/1,000 cases evaluated**, complete. Base/complement hashes match the existing sealed generations (`1ec86569…5cca` and `139054d4…c862`). Evaluation makes **zero network calls** and never writes to user storage.

| Metric | Result |
| --- | ---: |
| Expected barcodes present in wger | **600 / 913** |
| Present barcodes with four declared values passing numerical rules | **600** |
| Expected barcodes with a usable original nutrition reference | **0** |
| Expected products actually addable without network | **0** |
| Executable title queries | 506 |
| Missing/unresolved query labels | 467 |
| Titles outside the existing query contract | 27 |
| Search errors | 0 |
| Exact expected addable barcode in first five | 0 |
| Queries returning some other usable food | 8 — **not a successful match** |

All 600 matched variants are `off-derived`, with reference evidence `wger-declared-100g-original-off-base-unavailable` and issue `off-100g-or-100ml-reference-lost`. This independently confirms the reference blocker. It does not justify marking those products valid, interpreting price units as nutrition units, or deriving calories. The other 313 supported barcodes are absent from the tested generation. Search results are the V1 reader's usable-food pool; zero exact addable hits does **not** demonstrate bad raw FTS ranking independently of its reference eligibility filter.

Warm query mean **1.010 ms**, p95 **2.507 ms**, over 506 queries. Evaluation **0.924 s wall / 0.752 s CPU**, after **11.951 s startup integrity verification**, which reads the sealed base. Recorded Python peak RSS **36,284 KiB**. These are local worker diagnostics, not browser/network/device timings. Human relevance judgements remain null: no precision@5/nDCG or 90% national coverage claim is made. Open Prices contributors, shops and time coverage are not a purchase panel. Food-domain gaps/nonfood observations and raw categories still need independent review, not silent exclusion based on wger results.

### Independent OFF label join: not complete

The planned join covers the **913 frozen original code strings**, in **19 batches**, capped at 32 MiB/600 seconds with no automatic retry. `prices-pq-labels-20261026/sample-manifest.json` is incomplete: the first provider request returned **HTTP 422**. A single diagnostic request to read an explanatory error body subsequently returned **HTTP 500**: `Authentication check on the Hugging Face Hub failed or timed out…`. No tokens or login were used; this message does not prove that authentication is required for the public dataset. The cause of the earlier 422 is not established. Attempts stopped; no product API calls or large OFF dataset downloads followed.

The original price cases and barcode evaluation remain valid, but they have **not** been enriched with a complete independent OFF label source. The Dataset Viewer also documents a 5 GB indexing limitation/`partial:true`; the collector rejects partial results rather than treating them as products absent from OFF. Do not remove unresolved cases or substitute wger names. Error status/body summaries are retained in `parquet-off-label-diagnostic.json`; signed URLs and private contributor fields are not logged.

### Corrections and final validation

1. Initial real-codec checks aborted conservatively on the RSS guard (two errors/four checks). A controlled 128 MiB parent/exec diagnostic proved that Linux `ru_maxrss` can include a launcher's previous memory: parent 142,268 KiB, new child rusage 142,452 KiB, while the child's `/proc/self/status` VmHWM was only 10,768 KiB. The reader now uses **VmHWM for this executable**, failing closed if unavailable. **The 512 MiB limit is unchanged**. Future projection reports name the metric `linux-process-VmHWM`; sealed previous reports were not overwritten. A regression confirms the correct metric, and a real-codec check still rejects a simulated 600 MiB process peak. Limits on Arrow allocation/batches/groups and system reserves remain intact.
2. OFF label identity is the requested product code, not an assumption about how independent filtered responses assign `row_idx`. Duplicate/unrequested codes still abort. A two-batch regression proves that response row indexes may repeat without losing or conflating products. This correction does not turn the failed provider capture into a successful one.
3. The unresolvable versioned pip URL is replaced in the procedure with the official standalone zipapp URL; its actually observed version is recorded above. Temporary directories in the SSH procedure are explicitly placed under the repository.

Final tests, each a separate execution:

- Python prototype: **194 passed**, zero failed/skipped, 7.28 s (`parquet-network-python-final.log`).
- Actual PyArrow codec/projection: **5 passed**, zero failed/skipped, 0.042 s (`parquet-real-codec-final.log`). These validate real generated Parquet files; the real official source was separately scanned completely as described above.
- Node prototype regression: **95 passed**, zero failed/skipped, 6.64 s (`parquet-network-node-final.log`).
- `git diff --check`: passed. No runtime API/frontend code changed in this continuation, so their complete suites and builds were not needlessly repeated. No browser, Docker, APK or device validation is claimed.

Commands to inspect the already completed work **without any new download or evaluation**:

```bash
cd /home/codex/openGym
python3 -m json.tool scripts/nutrition-local-catalog/artifacts/prices-pq-20261026-network/capture.json
python3 -m json.tool scripts/nutrition-local-catalog/artifacts/prices-fr-pq-20261026/sample-manifest.json
python3 -m json.tool scripts/nutrition-local-catalog/artifacts/prices-pq-cases-20261026/benchmark.json
python3 -m json.tool scripts/nutrition-local-catalog/artifacts/prices-pq-eval-20261026/report.json
```

Outcome: the direct-Parquet benchmark is operational and supplies real broader evidence. **The French food V1 is not unblocked**: validated original nutrition references and independently resolved labels/food-domain relevance still need work. Nothing was published to the application or to an active catalogue.

Final resource/Git check for this continuation: **33.890 GiB disk free / 4.144 GiB MemAvailable**, above both reserves. Branch `feature/nutrition`, HEAD `6610d192`; 38 tracked modified files and 143 untracked files including pre-existing work, nothing staged. The current base/complement SHA-256 values still equal the evaluated sealed generations. No production configuration, account, user backup, `.env`, active catalogue generation, commit or deployment was modified.

### Reference-resolution proof following this benchmark

[NUTRITION_OFF_REFERENCE.md](NUTRITION_OFF_REFERENCE.md) records a subsequent
bounded original JSONL/input-set proof. The original 1,000 benchmark cases and
913-barcode denominator remain unchanged. A **sample** reference complement now
validates **three** expected codes (milk, coconut oil, pastry) and journal-tests
its 93 targeted Foods offline. The three benchmark hits were deliberately captured
schema probes, so this is a technical demonstrated lower bound, not an unbiased
estimate of how much a full import will recover. Original raw-source and API
provenance remain distinct. No nutritional reference is inferred from Prices,
no ranking metric is relabelled as a success, and the full OFF transfer remains
subject to explicit authorization. Original 600/913 presence and 0 validated
references describe the unchanged baseline generation, which was not rewritten.

### Interrupted full-stream follow-up (no full-import claim)

The authorized OFF stream stopped before EOF on a malformed original code string.
Its immutable committed prefix contains 550,833 target identities. The separate
read-only partial analysis keeps `complete=false`, `extractionComplete=false` and
`fullDumpVerified=false`, and leaves the original 1,000 cases / 913 barcode frame
unchanged. It finds **356 coherent expected references** in that prefix (354 from
the baseline's previously unusable wger matches, two absent from wger), compared
with zero baseline valid references. No remaining source/case is assumed covered;
this is not the completed full-dump benchmark or national coverage.

All 356 matched foods plus 40 stratified examples pass laboratory-only journal
checks (396 total), with an explicit partial-source integrity marker. Default
source admission refuses that incomplete source. No active reader/catalogue is
switched, and full source CRC/size validation has not passed. Full details and the
new network authorization boundary are in [NUTRITION_OFF_REFERENCE.md](NUTRITION_OFF_REFERENCE.md).

## Full original OFF references: frozen-frame rerun, 26 October 2026

The second authorized source pass reached gzip EOF and CRC with 4,837,307 rows.
The original 1,000-case / 913-supported-barcode Open Prices frame is unchanged
(SHA-256 `7fef1878b0085ab693eea9ed9f94121e463cb433c71adaaf77df7ebbb0e4a2dd`).

| Stage | Exact expected codes found | Reference valid for journal |
| --- | ---: | ---: |
| Existing wger + French quality complement | 600 | 0 |
| First-pass partial reference audit | partial | 356 |
| Full verified OFF reference complement | 744 | 544 |

544/913 = **59.58%** supported-code coverage (544/1,000 = 54.4% of all cases),
**188** new validated cases over the prefix, no lost prefix matches. 515 validated
cases were already in wger; 29 were absent, so they need future bounded reader and
search-index integration. Found-but-not-validated: 105 without a usable input set,
60 without original sets, 35 with conflicting valid sets. Another 169 codes were
not captured. The 87 cases without supported codes and the missing names are not
dropped or invented. Exact expected barcode identity establishes this metric's
product match, not human semantic relevance or precision@5. Nothing demonstrates
90% coverage. No ranking/fuzzy changes or source query-label backfill occurred.

In the complete Open Prices France census, 48,357/77,894 target identities have a
validated reference (62.08%). French-language wger identities (829,044 accepted)
are a separate overlapping cohort, not evidence of geographic availability.

586 distinct Foods passed laboratory offline journal paths, including every one
of the 544 valid benchmark codes, deterministic unit/source strata and separately
reported curated controls (overlaps coalesced). These are not 586 extra independent
benchmark cases. 510 use g, 76 use ml; dimension errors reject, reopening preserves
snapshots and offline pending operations, provider network calls are zero.

The reviewed audit and first full audit have identical data results and sample
SHA-256, `ec9fcbf1c37aa8fcc2a7bb0a272de950438bf301dd8f532da9569b302dc330f0`.
Authoritative files: `off-full-audit2-reviewed-20261026/report.json`,
`off-full-journal2-20261026/report.json`, and
`off-full-validation2-20261026/{report,receipt}.json` under prototype artifacts.
No catalogue was activated, old hashes are preserved, and no browser/native or
production availability claim follows from reference validation. Commands and
limitations: [NUTRITION_OFF_REFERENCE.md](NUTRITION_OFF_REFERENCE.md#final-second-pass-validation--authoritative-results).
