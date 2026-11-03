# Food catalogue (step 4)

> **Décision V1 du 25 octobre 2026 :** recherche SQLite sans correction de fautes,
> aucune API alimentaire externe pendant l’utilisation. Le parcours v3.5 à la
> sélection décrit ci-dessous reste un historique expérimental, à remplacer avant
> activation V1. L’évaluation isolée wger/OFF et ses limites sont documentées dans
> `NUTRITION_LOCAL_CATALOG_PROTOTYPE.md` (section Évaluation wger). Aucun changement
> des routes de production ou des données utilisateur lors de cette évaluation.
>
> Le dump wger complet fourni est désormais traité par la voie de maintenance
> `wger-full.mjs` / `wger-generation.py`, dans une génération isolée. Le worker et
> le DTO V1 ne contiennent aucun fallback fournisseur. Le mode de développement
> explicite `NUTRITION_LOCAL_CATALOG_KIND=wger-v1` les raccorde aux routes existantes
> avec une capacité v2 ; hors de ce mode, le comportement précédent est conservé.
> Les fiches OFF à référence ambiguë et
> les mappings de licences non confirmés ne doivent pas être présentés comme
> validés. Voir la section « Import intégral wger fourni » du document prototype.


## État actuel — stabilisation du 27 octobre 2026

Préparation Android privée : voir [ANDROID_PRIVATE_BETA.md](ANDROID_PRIVATE_BETA.md).
Ce profil HTTPS reste explicitement opt-in et non déployé ; il ne remplace pas
le lancement de laboratoire documenté ici. Aucun fournisseur alimentaire n'est
utilisé dans l'un ou l'autre mode local-only.

Le mode **de développement opt-in `wger-v1` avec complément OFF** utilise
exclusivement SQLite pour la recherche et la sélection, Web comme Android.
Le lecteur conserve les 3 058 354 produits wger et complète les références avec
835 231 Foods OFF strictement validés, y compris les identités absentes de wger.
Les sections décrivant le transport fournisseur restent la documentation du mode
historique, inchangé lorsque ce mode expérimental est désactivé. Elles ne décrivent
pas un fallback de la V1 locale. Procédure et résultats actuels en fin de document.

La passe de stabilisation du 27 octobre corrige seulement deux défauts confirmés :
les dates des fixtures de file/routes Coach (sans modifier le produit), et la
perte du code HTTP 409 `catalog-ambiguous-barcode` dans le pont mobile. Le pont
ne transmet que ce code autorisé, jamais le texte/HTML d'une erreur serveur ;
les getters et chaînes excessives sont refusés. Les tests ciblés initiaux passent
(46 API Coach, 44 frontend). Les suites finales réussissent : **805 API et
5 833 frontend**, aucun échec/ignoré. Les résultats et le guide court d'essai sont
consignés dans la section « Stabilisation de nuit » ci-dessous.

## Invariants and implementation decisions

The portable Nutrition v1 contract, local publication protocol, outbox, synchronization
and historical snapshots remain unchanged. Untrusted provider JSON never becomes a
business record without normalization and `validateFood`. Search does not write storage.
A selected food and its journal entry are published together using `service.batch`.
Personal foods stay in `customFoods`; provider revisions stay in `savedFoods`.
Content-addressed provider IDs retain divergent revisions instead of overwriting history.
Deleting a cached search cannot delete a saved product, snapshot or offline operation.

Web reads use the anonymous openGym API relay (`/api/nutrition/catalog/search` and
`/api/nutrition/catalog/product`) to supply a real User-Agent and avoid depending on
provider CORS, including on error responses. Native Android/iOS use the existing
Capacitor HTTP bridge directly with that header, retaining guest access without an
openGym backend. No User-Agent parameter is added to URLs. Web guest catalogue search
requires the API relay; local foods/journaling remain offline. No openGym credentials
or private meal/account data are sent to OFF. Only query, language, barcode and
application identity are sent. Destinations are fixed, not a generic proxy.

Official documentation checked 2026-10-11:
- [API introduction](https://openfoodfacts.github.io/openfoodfacts-server/api/):
  v3 current; v2 deprecated, backwards compatible; text search remains legacy CGI.
- [Product v3](https://openfoodfacts.github.io/documentation/docs/Product-Opener/v3/products/get-api-v3-product-code/)
- [Nutrition schema](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/docs/api/ref/schemas/product_nutrition_v3.yaml)
- [Standardized legacy nutrients](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/docs/api/ref/schemas/product_nutrition.yaml)
- [Search endpoint availability](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-cheatsheet/):
  v2 filter search is not full-text, v3 search is not implemented; legacy CGI remains
  supported but is discouraged for new integrations while Search-a-licious develops.
  It is retained behind this adapter for compatibility with the current text search.
  The image-upload User-Agent parameter reference does not establish read-search behavior.
- [Barcode normalization](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-barcode-normalization/)
- [Caching guidance](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/creating-a-local-cache-of-open-food-facts-data/)
- [Licences](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/)

Provider documents currently report 10 search requests/minute/IP and 15 product
reads/minute/IP. No automatic retries or search-as-you-type. Public deployment owners
should register their use case with OFF as requested in its introduction.

Data database: ODbL 1.0; individual contents: DbCL 1.0. Image licensing is separate
(CC BY-SA per OFF); image bytes are not copied into Nutrition records or backup files.
Provider cache and records are separated from personal foods, with source and license
retained in every snapshot. This separation does not settle the legal classification
of a publicly distributed combined database. Private recipes/history are not published
to OFF. Public redistribution or combining other catalogues requires an ODbL review;
we do not assert that a private backup makes every possible redistribution compliant.

Implementation, tests, performance and remaining device validation are documented
below as the corresponding code is completed.

## Implemented flow and resource boundaries

`catalog/normalize.js` bounds nesting (12), inspected nodes (20,000), strings (10,000
before per-field limits), and rejects getters, prototypes, nonfinite numbers and
pollution keys. DTOs contain only name/brand/code, compatible food, bounded serving
text, warnings, approved image/source URL. The whole raw product is not retained.

Product reads use `/api/v3/product/{code}` with a fields allowlist. Explicit v3
`nutrition.aggregated_set` as-sold 100g/100ml data are supported. Computed-only,
estimated and modified values remain unknown. Legacy CGI search uses standardized
`*_100g` (grams or ml) and `*_serving`, never contributor `*_value` units. kJ / 4.184
is the only energy conversion; contradictory energy values reject the product.
Known serving quantities retain their reference. Ambiguous volume-package legacy
references cannot be added: no silent ml/g assumption and no density invention.
Prepared tables, uninterpretable servings and empty nutrition do not become fake
complete foods. Missing nutrients remain null and the existing engine reports
incomplete journal totals. An invalid nutrient prevents saving that product.

The session-owned cache is memory only, 50 entries / 1 MiB of serialized DTOs,
5-minute search and 24-hour product TTL. Close clears it and aborts requests.
Used products persist durably in `savedFoods`, synchronize and appear in Local foods
and Previously used products after restart or offline. Consulted but unused products
are deliberately reconstructible, not guaranteed after restart. No image bytes cached.
Requests use 1 MiB maximum JSON body, 20-second timeout, max 20 results/page and 20
pages, no automatic retry. At most one request at a time in the JS runtime.
Web reserves no independent external quota: the relay's rolling 60-second budgets
allow 10 searches and 15 product reads, counted only at dispatch of real provider
attempts. Cache and in-flight dedup run first. No per-request fixed interval exists.
Native direct requests reserve the same burstable limits per installation, with
Web Locks and nonprivate timestamp-only localStorage when available. This native
coordination cannot see every other device/app behind the same outgoing IP. 429/503
honors explicit Retry-After without a 60-second floor (60 seconds is the fallback
for absent/invalid provider metadata). Relay-local overload has no countdown.

Web transport calls only the same-origin relay, omits credentials/referrer and rejects
redirects. The relay identifies the app with an HTTP User-Agent, bounds provider reads
and shares a public cache/quota across users (see Firefox correction below). Native transport
reuses installed Capacitor HTTP with fixed HTTPS destination and identification
header. It cannot abort the underlying socket or stream a response before bridge
buffering; timeouts, fields and post-read byte caps mitigate this, but physical memory
and cookie behavior require device validation. Late results cannot populate a closed
session/cache or UI. Search queries necessarily disclose the requested public product
to OFF; meal dates, goals, notes, tokens and account IDs are never sent.

The journal retains meal/date when switching between local and external sources.
Selecting only prepares the existing quantity editor; saving atomically publishes
`savedFoods` + `foodEntries`. Identical saved revisions are no-ops. Content-addressed
IDs preserve changed provider revisions rather than replacing historical snapshots.
Attribution remains visible on journal entries and locally reused products.

## Camera and localization

Manual barcodes support 8, 12, 13 and 14 digit strings. OFF leading-zero normalization
is used only for equivalent identity comparison; input is never converted to a number.
The existing ML Kit plugin is restricted to EAN/UPC for Nutrition; existing gym QR
scan behavior remains unchanged. Web camera reuses `CameraScan` with a decoder
injection and BarcodeDetector EAN/UPC capability check before permission. Firefox
without this detector offers manual entry, not a simulated scanner. Camera frames
stay on-device; cancellation/unmount/detection stop tracks. Native OS scanner cancel
and physical Android/iOS decoding remain to validate.

New strings use the existing i18n keys. French is localized; other locale packs use
explicit English fallback copy pending translation review, not certified localized
translations. The derived Portuguese/Brazilian pack explicitly pins new fallback
keys in its override map to preserve its existing inheritance fingerprint. Responsive layout reuses Nutrition cards/forms and bounded images.

## Validation so far and corrections

Initial normalizer/client tests: 63 passed. Existing UI/session/scan target: 43 passed.
Initial build/locales found an insertion error in the derived pt-BR export; corrected
initially by inheritance, then by explicit overrides after the full locale regression
revealed its fingerprint requirement (see below). A shared SearchField clear button lacked
`type="button"`: inside the catalogue search form it could accidentally submit a
search. Corrected without changing its existing search input contract.
A decoder awaiting a frame after camera unmount could reschedule its timer; guarded
rescheduling and late permission failure to preserve cleanup.

A single live curl probe failed with DNS resolution error in the sandbox. No repeated
provider probes were attempted. Real CORS/API behavior remains an external validation,
not established by simulated fixtures or by the documentation browser.

### Functional review corrections

The first real storage UI test discovered `savedFoods` was present in the portable
contract but absent from the UI command validator allowlist. It now uses the same
`validateFood` as personal foods; malformed external foods still fail the publication.
The catalogue integration tests use the real NutritionScreen, EntryEditor, local
store and publication commands, not a mock save function. Interrupted/quota writes,
replay, shared connections, two actual sync clients with a real server store (direct
transport, not HTTP), and provider snapshots through backup are covered separately.

Pending operations can coalesce before being frozen. Tests explicitly freeze the
first publication when verifying preservation of old delivery payloads; they do not
assume one outbox row per click. Library/head consistency is checked after reopening.

A final-page pagination issue was corrected: previous-page navigation remains usable
when `hasMore` is false. UPC-E scanner results are expanded to UPC-A only when the
scanner reports UPC-E; manual/EAN-8 values are never heuristically expanded. Camera
selection moves focus to the product heading; existing quantity Editor handles
subsequent focus. Body streaming also bounds chunk count to prevent tiny-chunk memory
amplification. Nutrition service imports remain valid in plain Node benchmarks.

### Security/network and UX/maintenance reviews

Three review passes cover functional persistence, untrusted network inputs and UI
maintenance. Additional guards bound streamed chunk count, support only explicit
fixed provider origins/paths in the transport, and test credentials omission and
staging-only public basic-auth. No arbitrary URL/redirect is accepted by the service.
Application version follows openGym's existing build constant; plain Node tools use
its current version fallback. `VITE_OFF_STAGING=1` selects only world.openfoodfacts.net
and its publicly documented off:off credential. Staging foods retain a staging source
URL and provenance flag; test in a disposable local profile, not a real journal.
The normal build uses world.openfoodfacts.org. No endpoint writes to OFF.

A Retry-After is honored up to seven days (malicious/nonfinite values fall back to
60 seconds). This cap bounds an untrusted server's ability to poison the local
throttle permanently; unusually longer provider cooldowns require owner intervention.
OFF image links were verified as CC BY-SA 3.0; approved small images are displayed
unmodified with contributor/source/license links. Product content retains DbCL
metadata. Collections are logically separated but can inhabit the same Nutrition
partition; this is not a legal assertion of physically independent databases.
Public redistribution of combined records/backups needs a separate licence review.

The functional review covered lost writes, references and divergent revisions. The
network review covered stale requests, limits, parser/body caps and account guards.
UX review covered form clear/cancel behavior, last-page navigation, focus, camera
capability fallback, keyboard-accessible controls, and the existing responsive styles.
No physical camera, real browser screenshot, native HTTP socket/cookie behavior or
provider CORS has been validated inside this environment.

## Performance measurements

Reproduce without Internet or real user data:

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
node --expose-gc scripts/nutrition-catalog-benchmark.mjs
NUTRITION_CATALOG_TEN_YEARS=1 node --expose-gc scripts/nutrition-catalog-benchmark.mjs
npm test -- src/views/nutrition/FoodCatalog.test.jsx
```

Linux x64, AMD EPYC-Rome, Node 22.23.3, disposable JSON disk backend,
`--expose-gc`; provider latency replaced by an immediate fixture response. A 20-result
payload is 7,785 bytes; one actual transport invocation, cached DTOs 18,952 bytes.
The table shows the latest of two runs per corpus, not a statistically stable
mobile or real-provider comparison.

| Operation | Empty history ms | Ten-year history ms | Ten-year document reads |
| --- | ---: | ---: | ---: |
| Normalize one product | 2.27 | 3.71 | 0 |
| Parse/normalize 20 results | 22.23 | 21.05 | 0 |
| Cached search | 1.13 | 0.64 | 0 |
| Durable product + intake | 64.02 | 9,170.26 | 271 |
| Selected-day reload | 8.02 | 38.96 | 4 |

Ten-year corpus: 10,959 entries, 130 partitions, 200 custom foods, 100 recipes,
120 tombstones, two offline checkpoints. Heap before/after normalization of 20 results:
6.29 / 8.24 MiB; publication: 6.34 / 96.71 MiB. RSS after publication 226.38 MiB,
including retained allocations from corpus generation. These are boundary samples,
not peak-memory measurements. Full integrity validation/hydration remains costly at
mutation time; no global verification or publication is triggered by query typing.
A future incremental/worker mutation architecture still requires separate review.

Native bridge requests now retain socket exclusion until the original request settles,
even when cancellation has already rejected the caller. This prevents repeated
cancels from accumulating live native sockets. Tests verify bridge options and late
response rejection; these are mocked plugin tests, not physical networking evidence.

### Locale and platform regression corrections

The complete frontend suite caught the pt-BR inheritance fingerprint: new fallback
keys must be explicit reviewed overrides, as its locale contract requires. They are
now pinned in `PT_BR_OVERRIDES`, preserving the existing inheritance fingerprint,
without claiming a Brazilian translation. A staging credential encoding mistake was
corrected and its regression test now decodes the actual Authorization value to
`off:off`, rather than merely duplicating the encoded constant. Native cancellation
tests wait for the bridge request to actually begin before simulating cancellation.

iOS's existing camera-purpose description now includes food product codes; Android
already declares CAMERA and INTERNET. No new plugin or permission is introduced.
Native scans, Android Google module availability, iOS permissions and WebView CORS /
HTTP bridge behavior still require physical tests. Mobile web compilation is separate
from native compilation; cap sync is deliberately not run merely to validate a build.

The component timing test writes numeric-only observations to
`$TMPDIR/opengym-catalog-component-benchmark.json` (OS tmp directory, fixture data).
Measured empty-history picker opening: 15.10 ms; response processing through React
commit for 20 products: 30.79 ms, one request (the component-only run). Happy-dom does not perform real layout
or painting, so these are component commit timings, not Firefox/mobile visual latency.
The result grid additionally bounds min-width and wraps long provider names.

Legacy nutrient qualifiers (for example proteins `< 0.5 g`) also stay unknown instead
of being silently promoted to exact measurements. The v3 modifier rule now has the
same conservative legacy regression. This affects only provider normalization; no
business validators or stored historical values are rewritten.

## Reproducible validation and manual provider checks

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
npm test -- src/lib/nutrition/catalog src/views/nutrition/FoodCatalog.test.jsx src/components/CameraScan.test.jsx src/lib/pt-br-locale.test.js
npm test -- src/lib/nutrition src/views/Nutrition.test.jsx src/views/nutrition src/components/CameraScan.test.jsx src/lib/scan.test.js src/lib/scan-web.test.js src/lib/pt-br-locale.test.js
npm test
node scripts/check-locales.mjs
npm run build
VITE_MOBILE=1 npm run build -- --outDir /tmp/opengym-food-catalog-mobile
node --input-type=module -e "import { checkCopy } from './scripts/check-mobile-bundle.mjs'; checkCopy('/tmp/opengym-food-catalog-mobile')"
cd ../api
node --test --experimental-test-isolation=none --test-reporter=spec test/nutrition-protocol.test.js test/nutrition-packaging.test.js
# Optional strict HTTP regressions on the VPS, outside this sandbox:
NUTRITION_REQUIRE_HTTP_TESTS=1 node --test test/nutrition-http.test.js test/server-nutrition.test.js
cd ..
git diff --check
```

Run full frontend tests directly over SSH to validate the seven subprocess locale
tests blocked here by spawnSync EPERM. They were not removed, disabled or marked
passing. The API protocol/packaging fallback above executes all 15 registered tests;
default isolated Node execution in this sandbox reported file wrappers only, which
was not counted as equivalent to the actual assertions. At that initial validation
point, no server source had changed; the subsequent Firefox correction below adds
the restricted catalogue relay.

For manual browser development, on a disposable profile:

```sh
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
VITE_OFF_STAGING=1 npm run dev -- --host 127.0.0.1 --port 5173
# Client machine:
# ssh -L 5173:127.0.0.1:5173 USER@VPS
```

Guest Nutrition local reads/writes do not require starting the API. Browser OFF
reads now require the public relay. Vite's existing `/api` proxy points to `API_TARGET`
(default `http://127.0.0.1:3000`) and sets Origin to `API_ORIGIN` (default
`http://localhost:8080`). That origin must match the development API's `ORIGIN`.
Use the isolated API launch below; do not start against production `DATA_DIR`.
Staging selection remains `VITE_OFF_STAGING=1`, with public off:off sent server-side
or by native HTTP only. Staging and production can contain different products.

Small read-only provider probe, outside the sandbox (no loops or automatic retries):

```sh
curl --fail-with-body --max-time 20 --max-filesize 1048576 -u off:off \
  -A 'openGym/1.4.1 (https://github.com/solhren/openGym)' \
  'https://world.openfoodfacts.net/api/v3/product/3017620422003?fields=code,product_name,nutrition,nutriments,nutrition_data_per,product_quantity_unit'
# Wait at least six seconds before another product read. Unknown barcode 00000000:
curl --max-time 20 --max-filesize 1048576 -u off:off \
  -A 'openGym/1.4.1 (https://github.com/solhren/openGym)' \
  'https://world.openfoodfacts.net/api/v3/product/00000000?fields=code,product_name,nutrition,nutriments'
# Explicit search; wait ten seconds before a further search:
curl --get --max-time 20 --max-filesize 1048576 -u off:off \
  -A 'openGym/1.4.1 (https://github.com/solhren/openGym)' \
  --data-urlencode 'search_terms=pâte à tartiner' --data 'action=process&json=1&page=1&page_size=20' \
  --data-urlencode 'fields=code,product_name,brands,nutriments,nutrition,nutrition_data_per,product_quantity_unit' \
  'https://world.openfoodfacts.net/cgi/search.pl'
```

Confirm one known product, an unknown code, partial product, text/brand/multiword
search, pages and attribution in Firefox. Verify network inspector sends no openGym
cookies/token/meal data. Confirm correct label base for solids/liquids, missing values,
quantity/meal/date retention, durable save, reload offline, recipes, backup and unchanged
old snapshots. Check clear/cancel/out-of-order requests, account replacement, 429/503
through simulated test fixtures (do not deliberately overload OFF), keyboard focus,
320/375/768/1280px, light/dark, photos failing and no horizontal overflow.

On Android/iOS: build/sync explicitly in a test checkout; test permissions denied,
OS scanner cancel, EAN/UPC including UPC-E expansion, Google scanner module absence,
track/socket cleanup, camera after navigation/account changes, HTTP timeouts, quotas,
restart offline, and native source attribution. Web BarcodeDetector is capability
based; Firefox usually uses manual entry. Physical/native compilation and power-cut
recovery are not implied by happy-dom or mocked plugin tests.

Future work: reviewed localization outside French, migration from legacy text search
when the provider exposes a stable replacement, incremental/worker mutations after
separate architectural review, optional durable cache for unused products with a
separate reconstructible-store design, and licence review before public combined-data
redistribution. No favourites, crawler, provider writes or global restore were added.

A final licence/UI inspection found recipe snapshots correctly retained
`ingredientSources` but the new attribution component displayed direct food sources
only. It now also renders distinct provider ingredient sources for recipe snapshots,
recipe library and ingredient editing. A real UI regression logs a recipe and checks
that attribution remains visible after returning to the journal. This changes only
presentation, not recipe calculations, private-data ownership or snapshot format.

Search result rows display the four main nutrients, their reference amount/unit and
unknown markers, before selection. Photo details are optional and cannot block the
quantity action. Missing or failed photos fall back to the product's text presentation;
photos are not durable offline assets. Detailed verified raw provider responses are
not retained: diagnostics use barcode, source URL, serving text and warning codes,
with normalized selected nutrition stored as the immutable business snapshot. Original
kJ strings, contributor tables and the full raw response are not recoverable offline;
future diagnostic capture would need its own bounded, nonhistorical contract.

The final security pass identified a distinct boundary: generic portable provenance
is JSON metadata, so an imported backup can contain an arbitrary `source.url` even
though fresh provider responses generate safe URLs. Attribution now links only to
fixed OFF HTTPS origins and digit-only product paths; otherwise it retains plain
attribution text. A real library-component test persists such imported metadata and
checks that no attacker link is created. No portable source field is rewritten and
historical integrity is preserved.

Image validation also requires the provider's 100/200/400-pixel derivative filename,
without query/fragment, rather than trusting the name `image_front_small_url` alone.
Original/full-resolution URLs are omitted. Display dimensions do not constrain the
number of bytes downloaded; trusted derivative hosting mitigates this, without a
claim that HTML image loading has a strict pre-download byte cap.

## Current validation results

These rows describe independent executions and must not be added together: the
complete suite includes the targeted groups. No test was disabled to obtain a pass.

| Execution | Result |
| --- | --- |
| Catalogue + existing Nutrition UI + camera + pt-BR target, after final URL/image, timeout and native JSON guards | 154 passed, 11 files, 0 failed/skipped |
| All Nutrition + UI + existing scan regressions, before the six final image/timeout/native-specific cases | 698 passed, 36 files, 0 failed/skipped |
| Real NutritionScreen catalogue component run | 10 passed, 1 file, 0 failed/skipped |
| API protocol/packaging, in-process Node test runner | 15 passed, 0 failed/skipped |
| Direct locale CLI | 18 locales, 2,464 keys each, in sync |
| Web build and mobile-web build/check | Passed; existing bundle-size/dynamic-import warnings remain |
| Provider reads | Not executed successfully: one DNS-blocked sandbox probe; no retry loop |
| Physical/native/browser acceptance | Not executed; scenarios above are required |

The final full frontend run reports **5,752 passed and 7 failed** across 437 files
(436 passed, one failed), 267.08 seconds, zero skipped. It is not fully green
inside the sandbox: the seven existing locale
subprocess cases cannot spawn Node (`EPERM`). The direct checker and locale inheritance
regressions pass, but they do not replace those seven unavailable subprocess tests.

## File map for maintenance

All paths below are relative to the repository. The portable/server/sync core and
package manifests/lockfiles are not modified by this step.

| Created files | Role |
| --- | --- |
| `frontend/src/lib/nutrition/catalog/normalize.js` | Bounded external DTO validation, normalization, immutable food identity and provenance |
| `frontend/src/lib/nutrition/catalog/client.js` | Fixed-origin browser/native reads, shared throttle, response limits, session cache |
| `frontend/src/lib/nutrition/catalog/scan.js` | EAN/UPC browser capability adapter and explicit UPC-E expansion |
| `frontend/src/lib/nutrition/catalog/fixtures.test-util.js` | Synthetic realistic OFF legacy/v3 response fixtures |
| `frontend/src/lib/nutrition/catalog/normalize.test.js`, `client.test.js` | Nutrient/type/URL/security and transport/cache/rate regressions |
| `frontend/src/lib/nutrition/catalog/scan.test.js`, `native.test.js`, `native-transport.test.js` | Barcode/camera capability, existing plugin options and native bridge boundaries |
| `frontend/src/lib/nutrition/catalog/durability.test.js` | Real publications, interruption/replay, outbox, backup and two-client synchronization |
| `frontend/src/views/nutrition/FoodCatalog.jsx`, `FoodCatalog.test.jsx` | Journal-integrated provider search/detail and real component workflows |
| `frontend/src/components/CameraScan.test.jsx` | MediaStream lifecycle regressions on the actual shared component |
| `frontend/scripts/nutrition-catalog-benchmark.mjs` | Disposable disk/ten-year workload benchmark |
| `docs/dev/NUTRITION_FOOD_CATALOG.md` | Main step-4 architecture, decisions, reviews, validation and limitations |

| Modified files | Role |
| --- | --- |
| `frontend/src/lib/nutrition/ui-service.js`, `ui-session.js` | Validated savedFoods commands and account-owned catalogue lifetime |
| `frontend/src/views/nutrition/Journal.jsx` | Source toggle and atomic saved-product/intake command |
| `frontend/src/views/nutrition/Library.jsx` | Local used-products group and recipe attribution |
| `frontend/src/views/nutrition/Editors.jsx`, `common.jsx` | Ingredient/snapshot attribution and safe navigation of restored source metadata |
| `frontend/src/components/CameraScan.jsx`, `frontend/src/lib/scan.js` | Optional product decoder/format restriction, retained QR behavior and safe cleanup |
| `frontend/src/components/ui.jsx` | Non-submitting clear action in a shared search form |
| `frontend/src/nutrition.css` | Scoped image sizing, wrapping and narrow-screen layout |
| `frontend/src/locales/{ar,bn,de,es,fr,hi,hu,it,ko,pl,pt-BR,pt,ru,th,tr,uk,zh-TW,zh}.js` | 35 synchronized keys; French copy and explicit English fallback elsewhere |
| `frontend/ios/App/App/Info.plist` | Existing camera-purpose description expanded to product codes |
| `docs/dev/NUTRITION_UI.md` | Existing interface documentation linked to the catalogue and new attribution boundaries |

The UX error-path review also found a timed-out transport was indistinguishable from
an intentional cancel: both became AbortError and the component correctly ignored
user cancellation, inadvertently hiding timeouts. The client now reports timeouts as
structured network failures, while explicit abort/session closure remains silent.
A fake-clock transport test covers the actual 20-second boundary; the real component
also exercises an offline transport failure before the 429 case. No automatic retry
is introduced.

Reading the installed Capacitor 7 Android `HttpRequestHandler.readData` and iOS
`HttpRequestHandler.buildResponse` revealed another real native compatibility issue:
`application/json` is parsed into an object even when responseType is `text`. The
adapter now accepts both representations, inspects parsed objects without invoking
getters, and conservatively budgets encoding before constructing a second full text
copy. Numeric/array overhead is intentionally overcounted; some large native objects
can be refused below the 1-MiB textual cap. String and object bridge regressions pass
independently. Native buffering before JavaScript remains outside this guard and
requires device verification; mocked text-only responses would have masked this bug.

The last native-source correction required a fresh full-suite run: an intermediate
run was still compiling/loading files while those tests changed and observed the
older text-only client alongside new object tests. Its two native failures were not
counted as a valid final result. The separate targeted run loads the corrected
client and passes; the final complete run starts only after all source/test edits.

Native OS scan-screen cancellation delegates to the existing ML Kit scan API; React
unmount alone is not a verified way to dismiss that native screen. Its late code is
ignored after account/navigation changes, and the user can cancel the OS screen.
Background/camera release in that scenario needs physical verification. The browser
scanner has separately tested track cleanup on detection, cancel and late permission.

The native rate-limit review also requires status-first handling: non-200 bridge
bodies are discarded, preserving status/Retry-After before any success-body validation.
A malformed or oversized 429/503 page therefore cannot mask the required cooldown.
A plugin regression checks that its unused body is not inspected or executed. This
cannot prevent the native plugin itself buffering/parsing the response before the
bridge; that separate SDK limitation remains documented.

The checked openGym web CSP only restricts frame ancestors; its API download CSP is
not the application's HTML policy. No deployment headers were changed. Custom hosting
CSP must allow the fixed provider/API and image origins. Browser camera requires a
secure context (HTTPS or localhost through the SSH tunnel). Browser catalogue traffic
now needs `connect-src 'self'`, not provider CORS permission. Product images still need
the fixed OFF image origin. Staging authentication is performed in the relay/native
transport and no longer introduces a browser preflight against OFF. A production
read-only probe with a disposable local profile is:

```sh
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
npm run dev -- --host 127.0.0.1 --port 5173
# Public production product read, without the staging Authorization header:
curl --fail-with-body --max-time 20 --max-filesize 1048576 \
  -A 'openGym/1.4.1 (https://github.com/solhren/openGym)' \
  'https://world.openfoodfacts.org/api/v3/product/3017620422003?fields=code,product_name,nutrition,nutriments,nutrition_data_per,product_quantity_unit'
```

No provider write or private openGym server operation is involved. A restricted public
relay was added after Firefox validation exposed the browser-direct failure. Owner
registration/application-identification acceptance and live provider validation remain
manual release checks; observing fixtures is not proof of them.

Final code validation: the 154-test target passed (11 files, zero failed/skipped),
then the complete 5,759-test run above executed against stable source. All seven
remaining failures are spawnSync Node EPERM in `scripts/check-locales.test.mjs`; no
current implementation failure was observed. Direct locales report 18 / 2,464 keys.
API protocol/packaging reports 15 passes, zero failed/skipped. Final web build 2.54 s,
mobile-web build 3.05 s and artifact check passed. Existing large-chunk/ineffective
dynamic-import warnings and timing notices are retained, not hidden.

Re-run the full `npm test` and, if desired, the strict HTTP commands above directly
over SSH. Provider reads, browser CORS/identity, visual layout and physical scanning
are still unvalidated here. The implementation is ready for technical review, with
these release checks and the ten-year write cost explicitly outstanding; this is
not a declaration of definitive project-step validation. No commit or push was made.

## Firefox transport correction (2026-10-11)

Real Firefox testing exposed HTTP 503 and a missing provider CORS header. The latter
prevents JavaScript reading the error; it does not cause the provider's HTTP status.
OFF documents 503 for global infrastructure throttling, but that alone does not
establish the cause of this particular incident. This correction does not make an
unavailable provider return 200: it exposes errors and respects cooldowns.
A User-Agent query parameter was
incorrectly justified using an image-upload reference, not the search read endpoint.
It is removed. Browsers use two fixed public openGym relay routes; native
Capacitor HTTP retains its real identification header. Guest access remains anonymous
when that API is available; durable local foods and journaling need no catalogue API.
The relay shares the server's provider quota, bounds cache/response sizes, rejects
arbitrary URLs/parameters, and propagates 429/503 cooldowns without automatic retries.
This correction supersedes the initial browser-direct design and its historical
validation totals above; current validation results are recorded below.


### Relay contract and review

`api/nutrition/food-catalog.js` exposes a factory and two anonymous GET routes.
Search accepts only `q` (2–120 characters after normalization), `page` (1–20),
`lc` (two lowercase letters), `staging` (`0`/`1`); product lookup instead accepts
`code` (8 or 12–14 digits, string). Repeated/unknown fields and oversized URLs are
rejected. Provider hosts, paths, field selection and page size are compiled constants.
Staging selects only world.openfoodfacts.net and its public test Basic credential.
No client URL, cookie, Authorization, forwarded header or personal document is used
upstream. Origin/Sec-Fetch-Site checks refuse foreign browser requests; the client
address uses existing trusted-proxy and IPv6 normalization. These public routes do
not alter Nutrition authentication/publications or training sync.

Responses are streamed with a 1 MiB decompressed/forwarded ceiling, at most 4096
chunks, strict UTF-8/JSON, 12 levels / 20,000 nodes and string/array bounds. Pollution
keys and invalid search/product envelopes are refused. The frontend still applies
its independent normalization and `validateFood`; raw provider records never become
Food objects directly. Redirects are refused. The 15-second provider timeout covers body reads
as well as connecting; subscribers have an 18-second total queue/read deadline. Non-success bodies are cancelled, never forwarded as HTML.
Review added cleanup even when Content-Length or validation rejects early; upstream
the four-slot concurrency bound remains held through stream cleanup. Cancellation
removes only that subscriber; an orphaned queued job spends no budget, while an
orphaned active read is aborted and retains its already-reserved quota.

Public in-memory LRU: at most 50 responses / 8 MiB, search TTL 5 minutes and product
TTL 24 hours, keyed by complete provider query/language/page/environment. Cache
values are cloned; no account/session identity or disk writes. This cache is distinct
from account-owned frontend DTO cache (50 / 1 MiB), savedFoods, snapshots and outbox.
Cached public data remain usable during provider cooldown. Bounded dispatch permits
four provider reads, 64 queued distinct jobs, 16 queued jobs per peer and 32 subscribers
per identical job. It rotates active peer queues without allocating unused shares.
The global rolling budget is 10 searches / 15 product reads in any 60 seconds for
this API egress, including staging. Registered users do not enter this calculation.
Cached requests still have per-address 60/minute and global 300/minute anti-abuse
limits with bounded counters; these return untimed catalog-client-rate-limited,
not an external quota countdown. Provider 429/503 retain their status and explicit
Retry-After (up to 7 days). Actual 429 throttles protect both kinds; 503 availability
cooldowns are scoped to the failing kind, preserving barcode during a search outage. HTTP dates are supported;
absent/invalid provider backoff defaults to 60 seconds. There are no automatic
quota-refill retries, direct-browser fallbacks or rotating destinations.

Tradeoff: browser users share the VPS's provider IP and availability. Native clients
retain per-device direct requests. This limiter is per API process; multiple replicas,
other software sharing the public IP, or rapid process restarts require a shared
quota or deployment coordination before scaling. Memory cache/quotas reset on restart.
A restricted relay is deliberately chosen instead of setting browser User-Agent
(which cannot be relied upon), disabling CORS, or introducing an arbitrary HTTP proxy.
No new dependency, network setting, Docker service or data migration is required.

### Isolated Firefox/VPS validation

Start a development API in a separate terminal, on an unused port and disposable data
(directory path printed below). This does not change production services or data:

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/api
CATALOG_DEV_DATA=$(mktemp -d /tmp/opengym-catalog-dev.XXXXXX)
printf 'Development data: %s\n' "$CATALOG_DEV_DATA"
PORT=3001 DATA_DIR="$CATALOG_DEV_DATA" ORIGIN=http://localhost:8080 npm start
```

In another VPS terminal:

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
API_TARGET=http://127.0.0.1:3001 API_ORIGIN=http://localhost:8080 npm run dev -- --host 127.0.0.1 --port 5173
```

Client machine: `ssh -L 5173:127.0.0.1:5173 USER@VPS`. Open
`http://localhost:5173`, Continue without account → Nutrition → Add food → Open Food
Facts → `nutella` → Search. Network should show `/api/nutrition/catalog/search?...`
on localhost, **no User-Agent query parameter or browser request to search.pl**.
Only the API connects to OFF with its custom HTTP User-Agent. Confirm readable
429/503 messages, quantity/save, offline reuse and no effect on personal foods.
Stop the two development processes with Ctrl-C. Physical native HTTP remains to test
on Android/iOS; its header behavior is covered by plugin mocks, not real devices.

A single controlled direct provider probe (no retries) isolates upstream availability
from the openGym relay. It failed here with curl exit 6 / DNS resolution, so no claim
about a successful live nutella search or the actual upstream 503 cause is possible.
Run once outside sandbox, preserving headers/body for diagnosis:

```sh
curl --connect-timeout 5 --max-time 20 --max-filesize 1048576 \
  -D /tmp/opengym-off-nutella-headers.txt -o /tmp/opengym-off-nutella-body.json \
  -A 'openGym/1.4.1 (https://github.com/solhren/openGym)' --get \
  --data-urlencode 'search_terms=nutella' --data-urlencode 'action=process' \
  --data-urlencode 'json=1' --data-urlencode 'page_size=2' --data-urlencode 'page=1' \
  --data-urlencode 'fields=code,product_name,nutriments,nutrition,nutrition_data_per,product_quantity_unit' \
  'https://world.openfoodfacts.org/cgi/search.pl'
```

If 503 persists, inspect status, Retry-After and response text before another attempt.
CORS does not affect this server/terminal read. Respect the returned cooldown; do not
run the direct probe concurrently with additional searches on the same VPS IP.


### Validation of the Firefox correction (before demand-based budget)

| Group | Result |
|---|---|
| Frontend Nutrition/library/journal/recipe/snapshot/backup/sync/camera/locale inheritance | 705 passed, 34 files, 0 failed/skipped, 135.30 s |
| Actual App/Shell guest path with API 502/offline and local Nutrition | 3 passed, 1 file, 0 failed/skipped, 7.76 s |
| API relay + OpenAPI + packaging + Nutrition protocol + existing rate limiter | 77 passed, 5 files, 0 failed/cancelled/skipped, 472.71 ms |
| Relay real HTTP + real server route registration | 8 environmental failures (4 per file), `listen EPERM`, 0 passed/skipped; not validated |
| Web build | Passed, 2.29 s |
| Mobile web build and artifact check | Passed, 2.37 s; no native build/device execution implied |
| Direct locale checker | 18 locales, 2,464 keys each synchronized |
| Live nutella provider probe | Blocked before HTTP: DNS resolution / curl exit 6 |
| Git whitespace / Node syntax checks | Passed |

The catalogue-only development rerun passed 115 tests / 7 files before adding the
last native header regression; those tests and the added native regression are
included in the final 705-test run, not added to it. Earlier exploratory fixture
failures were corrected: localized fixture names override the generic name, a
closed UI session also closes its store, and DOM URL implementations cannot replace
Node file URLs in server imports. None of these justified relaxing production food
validation. The real component test now uses a fresh isolated store and exercises the
actual frontend client and actual relay factory with provider I/O simulated.

The full 5,759-test frontend suite was not repeated for this focused correction;
its earlier seven subprocess EPERM results remain historical, not a current full-suite
pass. The eight new HTTP tests are present and intentionally fail when socket binding
is denied; they were not skipped to obtain a green result. The backend source change
requires the following real HTTP validation over SSH before release.

Commands actually used for final groups:

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
npm test -- src/lib/nutrition src/views/Nutrition.test.jsx src/views/nutrition src/components/CameraScan.test.jsx src/App.test.jsx src/lib/pt-br-locale.test.js
# The App.test.jsx filter matched no file; the real existing guest test ran separately:
npm test -- src/App.guest.test.jsx
npm run build
VITE_MOBILE=1 npm run build -- --outDir /tmp/opengym-off-relay-mobile
node --input-type=module -e "import {checkCopy} from './scripts/check-mobile-bundle.mjs';const errors=checkCopy('/tmp/opengym-off-relay-mobile');if(errors.length){console.error(errors);process.exit(1)}"
node scripts/check-locales.mjs
cd ../api
node --test --experimental-test-isolation=none --test-reporter=spec test/food-catalog.test.js test/openapi-routes.test.js test/nutrition-packaging.test.js test/nutrition-protocol.test.js test/rate-limit.test.js
# Outside sandbox, real sockets (simulated OFF, no Internet needed):
node --test test/food-catalog-http.test.js test/server-food-catalog.test.js
# Existing strict HTTP Nutrition regression, after adding routes:
NUTRITION_REQUIRE_HTTP_TESTS=1 node --test test/nutrition-http.test.js test/server-nutrition.test.js
cd ..
git diff --check
```

The existing Docker COPY of `nutrition/` includes the relay; the API package version
used in identification is already copied. Its dependency closure is covered by the
packaging regression. No Docker/service or global environment configuration changed.
No additional frontend translation keys were needed: existing network/rate-limit
messages report relay errors.

Synthetic relay measurement: Node 22.23.3 / Linux, 20 public fixture products,
3,615-byte JSON, 1 injected provider call, cold read 65.782 ms (including first Response
runtime initialization), mean of 100 cached reads 0.138 ms. One cached response held
3,615 serialized bytes; post-GC heap delta 2,415,464 bytes includes HTTP/Response
runtime initialization, not only the cache. This is a single diagnostic sample,
not browser paint, HTTP latency or a real provider benchmark. Server cache ceiling
and oversized-response/byte-LRU regressions provide the resource guarantees; the
existing ten-year durable mutation benchmark is unaffected by this transport fix.

## Demand-based provider budget

The fixed 10/6-second pacing underused OFF's actual 10 searches / 15 product reads
per minute/IP and introduced false waiting even with unused budget. It is replaced
by separate global rolling 60-second budgets, shared by actual relay network attempts
on the API's outgoing connection. Registered account count is not involved. Public
cache hits and in-flight identical-query subscribers do not reserve provider budget.
A bounded round-robin dispatcher fairly schedules pending client streams; anonymous
random tab tags distinguish ordinary simultaneous users even behind one ingress IP.
Tags are not authentication and do not replace address/global anti-abuse controls.
Native direct HTTP uses an installation rolling budget; browser client reserves no
second quota for relay requests. Only external exhaustion/provider backoff
produces a countdown; local concurrency/anti-abuse errors remain untimed.


### Fairness, lifecycle and remaining egress limits

The dispatcher groups incoming work by normalized client address plus an optional
`X-openGym-Catalog-Client` random 128-bit tab tag. The frontend generates this tag
without requiring randomUUID, keeps it only in module memory, and never sends it to
OFF or writes it into Nutrition data. It is not an account/device credential.
This distinguishes ordinary browsers sharing a NAT or Vite proxy address without
reading the account database. Missing tags share their incoming address group.
Abusive tag rotation cannot bypass the separate address/global request limits, but
anonymous fairness is not a Sybil-proof authentication scheme. Neither this tag nor
any cookie/Authorization header is part of provider requests or public cache keys.

A lone active stream can spend the entire 10/15 budget immediately, including bursts.
When several streams have queued work, round-robin grants them turns. Previously
spent quota cannot be reassigned to a user arriving later, and no share is reserved
for inactive users. Network concurrency produces ordinary loading, not a fabricated
quota countdown. Queue overflow/anti-abuse responses use a separate local code that
the trusted relay response wrapper maps to existing untimed request-in-progress UX.
External exhaustion alone yields the exact ceiling of the oldest live reservation's
remaining time, or provider backoff if greater. Provider Retry-After zero is preserved.

Cache hits and identical pending subscriptions precede quota checks and reservation.
A reserved slot is recorded synchronously just before fetch. DNS/network failures,
partial delivery and cancelled active requests are not refunded: the server cannot
prove a provider never saw them. Queued cancelled requests are removed and do not
reserve any slot. A subscriber's cancellation never aborts another subscriber's
shared request. When the last active subscriber goes, abort its provider read while
holding the concurrency slot until cleanup; closing a tab removes its queued work.
The wait/deadline timers reject a request; they never trigger a new provider attempt.

Quota storage remains in process memory, independent of account count or changes.
One API process serving one egress/IP is the supported limiter deployment. Multiple
workers/replicas sharing an outgoing IP, other provider consumers on that IP and
native devices behind a common NAT require coordinated external budgeting; we cannot
infer them by counting registered users or discovering one nominal public IP. A
shared durable budget across replicas/restarts would be separate infrastructure work.
Native v2 local rate metadata migrates only genuine v1 blocked-until values and
ignores obsolete fixed per-query due times. Native installation windows are burstable. The web client does not gate requests
behind a second quota or local cooldown: the relay always gets the chance to serve
its public cache or the other still-available request-kind budget.

Tests cover full immediate allowance, exact rolling expiry, independent budgets,
work sharing between actual peers, coalesced duplicates at exhaustion, cache reuse,
subscriber cancellation, abandoned queues, bounded overload and explicit short
Retry-After. Existing nutrient/snapshot/history validation remains unchanged.


### Critical review corrections for demand-based limits

The web limiter initially propagated a search-exhaustion cooldown to both request
kinds. That would have hidden the still-available product budget and public server
cache. Default web requests now leave quota/cooldown decisions entirely to the relay;
frontend DTO cache is still checked first. Injected test limiters remain supported.
Native requests enforce their budget at actual bridge dispatch, inside the lock
callback; aborted reservations spend nothing and cancelled active attempts are kept.

A native localStorage write failure could reload an older persisted bucket and lose
observed in-memory attempts. Loading now merges timestamp multiplicities with memory
and retains the latest bounded reservations. The regression simulates eight saved
attempts plus two failed metadata writes, then verifies that the eleventh request is
refused, including through a new limiter instance. This does not claim durability
of lost metadata after a physical power cut; native installation quotas remain
best-effort with respect to other devices sharing its IP.

Explicit short, zero and expired HTTP-date Retry-After values are honored without a
minimum artificial minute. Malformed or signed numeric intervals use the 60-second
fallback; upper bounds remain seven days. Provider 429 cooldowns protect both kinds; 503 availability and local exhaustion
block only the affected kind.


A final native review found that an immediately fulfilled bridge reply could win
Promise.race even when cancellation occurred during dispatch. Transport now checks
the signal after the race before exposing the reply; the bridge still retains its
quota and exclusion until actual completion. A plugin regression reproduces this
immediate-response case. This is not a physical-device validation.

### Files and reproducible validation for demand-based limits

The change touches the relay (`api/nutrition/food-catalog.js`), its tests
(`api/test/food-catalog.test.js`), API reference (`api/openapi.yaml`), platform client
and limiter (`frontend/src/lib/nutrition/catalog/client.js`), client and native
transport tests (`client.test.js`, `native-transport.test.js`), this reference and
`NUTRITION_UI.md`. No Nutrition data format, local publication, synchronization,
authentication, UI layout or dependency changed. Pre-existing step-4 edits are kept.

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
npm test -- src/lib/nutrition/catalog src/views/nutrition/FoodCatalog.test.jsx
npm test -- src/lib/nutrition src/views/Nutrition.test.jsx src/views/nutrition src/components/CameraScan.test.jsx src/App.guest.test.jsx src/lib/pt-br-locale.test.js
npm run build
VITE_MOBILE=1 npm run build -- --outDir /tmp/opengym-catalog-budget-mobile-release
node --input-type=module -e "import {checkCopy} from './scripts/check-mobile-bundle.mjs';const errors=checkCopy('/tmp/opengym-catalog-budget-mobile-release');if(errors.length){console.error(errors);process.exit(1)}"
node scripts/check-locales.mjs
cd ../api
node --test --experimental-test-isolation=none --test-reporter=spec test/food-catalog.test.js test/openapi-routes.test.js test/nutrition-packaging.test.js test/nutrition-protocol.test.js test/rate-limit.test.js
# Outside sandbox; real sockets with simulated provider (no OFF traffic):
node --test test/food-catalog-http.test.js test/server-food-catalog.test.js
cd ..
git diff --check
```

No live-provider burst was performed: quota/round-robin/cancellation tests use
injected fixtures and clocks. The existing isolated Vite/API launch above remains
valid. Manual testing should use explicit ordinary searches, cached repeats and a
second browser/tab, not an automated provider load test. Four real relay HTTP and
four real server tests were attempted again: all eight are blocked by listen EPERM,
with no passing/skipped tests; no claim of new real HTTP validation is made here.
Android/iOS bridge and shared-NAT behavior still require physical device checks.

### Final demand-based validation results

| Group (latest run only) | Result |
|---|---|
| Catalogue client/native + actual Nutrition component | 126 passed / 7 files, 0 failed/skipped, 6.85 s |
| Broad Nutrition/storage/backup/sync/UI + actual App guest + locale inheritance | 718 passed / 35 files, 0 failed/skipped, 138.85 s |
| API relay/protocol/packaging/OpenAPI/rate-limiter | 90 passed / 5 files, 0 failed/cancelled/skipped, 420.94 ms |
| Real relay HTTP + actual API HTTP | 8 blocked by listen EPERM, 0 passed/skipped; not validated |
| Web build | Passed, 2.42 s |
| Mobile web build + artifact verification | Passed, 2.37 s; no physical/native validation implied |
| Locale checker | 18 locales / 2,464 keys synchronized |
| Git diff/syntax/new-file whitespace checks | Passed |

The 126-test catalogue target is included in the 718-test broad run; do not add the
totals. Earlier reruns are superseded, not cumulative. The complete frontend/API
suites were not repeated for this focused change. Existing chunk-size/dynamic-import
build warnings remain visible. No dependency, commit, push or production operation
was made. Branch remains feature/nutrition, HEAD 6610d192, with prior step-4 work kept.

## Recurrent 503 / 60-second diagnostic (2026-10-12)

Code tracing establishes that the reported old HTTP 503 + catalog-rate-limited can
only originate from a provider HTTP 503. Local quota refusal is HTTP 429; fetch/DNS
exceptions are HTTP 502 or timeout 504. Missing/invalid provider Retry-After causes
the 60-second fallback, so the old response confused unavailability and exhaustion.
Local rejections do not renew that timestamp; a genuine new 503 after expiry can
legitimately create another protective cooldown. Later owner-provided direct VPS probes confirm CGI 503 with the official temporary
unavailability page and product v3 200. The page does not distinguish high demand
from anonymous-search access restrictions. The correction separates 503 availability from quota and adds
privacy-preserving internal provenance logging and regression coverage. No provider
limit is removed, and success requires another real VPS validation.

### Confirmed VPS evidence and correction boundaries

The owner directly queried OFF: `/api/v3/product/3017620422003` returned 200 and
Nutella nutrition; `/cgi/search.pl?search_terms=nutella...` returned the official
“Page temporarily unavailable” HTML and 503. This proves **upstream search failure**,
not spent openGym quota. Demand versus anonymous-access restriction remains unknown.
The old 60 seconds were the fallback for missing/invalid Retry-After. Local refusals
never renewed it, but concurrent fallback 503 responses could move its deadline.
They now share one incident; an explicit provider hint may extend it, and a genuine
new failing request after expiry may start another interval. No automatic retry.

| Cause | HTTP / code | X-openGym-Catalog-Source |
|---|---|---|
| Local external-attempt budget exhausted | 429 / catalog-rate-limited | local-budget |
| Local anti-abuse/queue overload | 429 / catalog-client-rate-limited, no countdown | local-overload |
| Provider 429 | 429 / catalog-rate-limited | provider-http |
| Provider 503 | 503 / catalog-provider-unavailable | provider-http |
| Existing cooldown | Original provider status/code, remaining Retry-After | provider-cooldown |
| Fetch/DNS/connection/TLS | 502 / catalog-network-error, no cooldown | network |
| Timeout | 504 / catalog-network-error, no cooldown | timeout |
| Invalid/oversized successful data | 502 / validation code, no cooldown | validation |

Search 503 now blocks only new text searches, preserving product/barcode reads.
Product 503 similarly leaves search available. Actual 429 keeps a broader protective
scope. Native metadata also persists per-kind 503 deadlines. Ambiguous global
backoffs stored by older clients expire normally rather than being deleted. Cached
valid results remain readable. The UI names the failing search mode, reuses existing
translations, and keeps Barcode and Local foods and recipes available. Portable v1,
snapshots, history and outbox are unchanged.

Logging never includes queries, barcodes, URLs, peer/account IDs, cookies/tokens,
raw headers, provider body or raw exception text. Default logging records actual
provider/transport failures. `OFF_CATALOG_TRACE=1` enables scheduling/cache/dedup,
quota/cooldown decisions, expiry and success. `ready` with `diagnosticVersion:1`
identifies the instrumented process. `dispatch` counts attempted fetch calls;
`upstream-response` counts HTTP responses received. Neither proves delivery to the
remote application. Unknown-delivery attempts retain reserved quota conservatively.
Observers cannot break service. No public diagnostic/state endpoint was introduced.

### Official alternatives and conditions checked 2026-10-12

| Option | Verified capability and access documentation | Decision |
|---|---|---|
| Legacy CGI | Keyword search documented but discouraged. General OFF read guidance asks for custom User-Agent, not login; live anonymous rejection needs policy clarification. | Keep bounded explicit requests/cache and report unavailable; do not assume cookies authorize access. |
| Search-a-licious | Official text-search successor linked by OFF at search.openfoodfacts.org. GET/POST /search, q, langs, pagination, fields; success uses hits. POST keeps query out of URL. Current API source calls it public, without route login dependency. | Candidate permanent adapter after confirming public-instance access, quotas and nutrient fields; no automatic fallback during CGI restriction. |
| v2 /api/v2/search | Structured tags/brands/categories filters, not arbitrary text; deprecated but supported. | Not an equivalent replacement for the text input. Separate explicit filtered browsing could be considered. |
| Product v3 | Working barcode lookup; v3/search/full text is not documented as implemented. | Preserve existing product adapter. |
| Self-hosted Search-a-licious | Official deployable Elasticsearch/Redis search stack with data-export indexing. | Future opt-in resource/licence/architecture review; no installation or catalogue import here. |

Primary sources:
- [OFF endpoint availability](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-cheatsheet/)
- [OFF access/rate guidance](https://openfoodfacts.github.io/openfoodfacts-server/api/)
- [Search-a-licious API reference](https://openfoodfacts.github.io/search-a-licious/users/ref-openapi/)
- [Current API source](https://github.com/openfoodfacts/search-a-licious/blob/main/app/api.py)
- [Query and response types](https://github.com/openfoodfacts/search-a-licious/blob/main/app/_types.py)
- [Architecture/deployment](https://openfoodfacts.github.io/search-a-licious/)

The public Search-a-licious root was unavailable to the documentation browser
(internal fetch error); no live alternative search was sent. Public anonymous
availability, rate limits, registration requirements, identification and operational
guarantees remain to confirm with OFF (reuse@openfoodfacts.org / official developer
channels). An API declared public in source does not prove that a deployed proxy
allows access. Product Opener limits are not automatically its quotas.

A future adapter must pin destinations, validate hits/schema/pagination/language,
confirm trustworthy nutrient reference coverage, and retain normalizeProduct /
validateFood and immutable snapshots. Missing index data/portions cannot be invented.
No host/IP rotation, staging fallback, special identification exemptions, scraping,
blind authentication or automatic provider switching was implemented. Authenticated
CGI is an option only after OFF confirms and documents permitted usage. openGym
credentials must never be forwarded; no account creation or provider contact occurred.

### Safe VPS diagnosis and pending real validation

Use a development API only; respect the current Retry-After before one restart to
load the updated code. Do not restart repeatedly to clear limits or touch Docker /
production services. Start tracing with disposable data on the unused development port:

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/api
CATALOG_DIAG_DATA=$(mktemp -d /tmp/opengym-catalog-diag.XXXXXX)
OFF_CATALOG_TRACE=1 PORT=3001 DATA_DIR="$CATALOG_DIAG_DATA" ORIGIN=http://localhost:5173 npm start
```

Vite must match that configured Origin:

```sh
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
API_TARGET=http://127.0.0.1:3001 API_ORIGIN=http://localhost:5173 npm run dev -- --host 127.0.0.1 --port 5173
```

One API search respects the real relay budget:

```sh
curl --connect-timeout 2 --max-time 20 -i -H 'Origin: http://localhost:5173' \
  'http://127.0.0.1:3001/api/nutrition/catalog/search?lc=fr&staging=0&q=nutella&page=1'
```

Correlate dispatch → upstream-response → provider-error and attempt number.
503/provider-http with retryPolicy fallback confirms actual upstream CGI 503.
One immediate local repeat during cooldown spends no external call: expect
provider-cooldown, a non-increasing remaining delay, no new dispatch. Do not loop.
After the full interval, one optional retry either recovers (200) or newly logs an
upstream failing attempt; another genuine 503 legitimately creates a new interval.

One product check during search-only cooldown verifies the preserved working path:

```sh
curl --connect-timeout 2 --max-time 20 -i -H 'Origin: http://localhost:5173' \
  'http://127.0.0.1:3001/api/nutrition/catalog/product?lc=fr&staging=0&code=3017620422003'
```

Firefox must show text-search unavailability rather than quota exhaustion, functional
Barcode quantity/addition, Local foods and recipes and unchanged durable history /
pending operations. No alternative search traffic occurs automatically. Owner-provided
OFF evidence establishes supplier failure; the corrected relay/UI still require real
VPS/browser validation before declaring the incident resolved.

### Final outage-classification validation results

Results below describe the latest runs for this correction, not accumulated reruns
or the earlier demand-based limiter validation above. Node 22.23.3 was used; fixtures
and injected clocks do not contact OFF.

| Group | Latest result |
|---|---|
| Catalogue client/native + actual Nutrition component | 130 passed / 7 files, 0 failed/skipped, 5.29 s |
| Broad Nutrition/storage/backup/sync/UI + actual App guest + locale inheritance | 722 passed / 35 files, 0 failed/skipped, 136.18 s |
| API relay/protocol/packaging/OpenAPI/rate-limiter | 101 passed / 5 files, 0 failed/cancelled/skipped, 464.28 ms |
| Real relay HTTP | 5 failed at socket setup with listen EPERM, 0 passed/skipped; environment-blocked |
| Real API HTTP | 4 failed at socket setup with listen EPERM, 0 passed/skipped; environment-blocked |
| Web build | Passed, 2.29 s |
| Mobile web build and bundle artifact check | Passed, 1.84 s; not physical Android/iOS validation |
| Locales | 18 locales / 2,464 keys synchronized |
| Syntax and git diff --check | Passed |

The 130-test target is included in the 722-test run and must not be added to it.
Complete frontend/API suites were not repeated for this focused correction.
Existing build warnings about large chunks and dynamic imports remain visible.
The nine real HTTP tests were attempted, not skipped, and their socket failures
must not be presented as successful validation.

One controlled live search attempt from this sandbox failed at DNS resolution:
the relay returned 502/catalog-network-error, source network, category dns, without
a cooldown or Retry-After. No HTTP response from OFF was received. A local curl
could not reach the VPS development listener here either. These are environment
limits; the direct 200/503 evidence above was supplied by the owner on the VPS.
No repeated external probes, alternative-host fallback or load test was performed.

Reproduce the available checks with:

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
npm test -- src/lib/nutrition/catalog src/views/nutrition/FoodCatalog.test.jsx
npm test -- src/lib/nutrition src/views/Nutrition.test.jsx src/views/nutrition src/components/CameraScan.test.jsx src/App.guest.test.jsx src/lib/pt-br-locale.test.js
npm run build
VITE_MOBILE=1 npm run build -- --outDir /tmp/opengym-catalog-503-mobile
node --input-type=module -e "import {checkCopy} from './scripts/check-mobile-bundle.mjs';const errors=checkCopy('/tmp/opengym-catalog-503-mobile');if(errors.length){console.error(errors);process.exit(1)}"
node scripts/check-locales.mjs
cd ../api
node --test --experimental-test-isolation=none --test-reporter=spec test/food-catalog.test.js test/openapi-routes.test.js test/nutrition-packaging.test.js test/nutrition-protocol.test.js test/rate-limit.test.js
# In the VPS terminal outside the sandbox; fixtures, no OFF traffic:
node --test test/food-catalog-http.test.js test/server-food-catalog.test.js
cd ..
git diff --check
```

Files changed for this diagnostic/correction: API relay and its unit/HTTP tests,
OpenAPI error documentation, catalogue client and tests, actual FoodCatalog view
and component tests, this reference and NUTRITION_UI.md. Prior step-4 work remains
in the working tree. No dependency, durable Nutrition format, history/snapshot,
outbox, workout synchronization or production configuration changed. No commit or
push was made. The error-handling correction is ready for VPS/browser validation;
working upstream text search and production access to its successor remain open.


## Recherche SQLite expérimentale (désactivée par défaut)

La préparation locale est décrite dans
[NUTRITION_LOCAL_CATALOG_PROTOTYPE.md](NUTRITION_LOCAL_CATALOG_PROTOTYPE.md).
Les routes catalogue existantes gardent leur contrat. Le relais local ne démarre qu'en
NODE_ENV=development avec NUTRITION_LOCAL_CATALOG=1, workspace explicite et DATA_DIR
isolé hors production. Python/prototype ne sont pas requis par l'image API production
inchangée ; ce mode exige actuellement un checkout de développement complet.
Texte = SQLite ; code = SQLite puis relais OFF v3 si absent/indisponible. Les erreurs
locales ne créent aucun faux Retry-After ni quota fournisseur. Qualité/provenance
validées sont conservées dans la source des nouveaux aliments, sans modifier anciens
snapshots ni schéma portable utilisateur. Aucun repli automatique du texte vers CGI.
Source SQLite/génération sont indiquées en en-têtes ; Node/Python sont arrêtés avec le
serveur de lab. Des scripts de copie publique/read-only et de smoke Docker sont fournis.
Les vrais corpus diversifiés, Docker et HTTP/browser restent non validés dans la sandbox.
Ne pas activer en production sur la seule base des unités réussies. Les commandes SSH,
limites et résultats détaillés sont dans la référence ci-dessus, sans duplication ici.

## Suggestions locales et retour arrière

La capacité publique `GET /api/nutrition/catalog/capabilities` retourne uniquement
`schemaVersion:1,textSearch:local|explicit-remote`, sans stockage utilisateur ni appel
fournisseur. Elle partage les contrôles d'origine et budgets publics du catalogue.
Le frontend active alors une combobox avec temporisation de 300 ms. Toutes ses
suggestions portent `local=1` : le serveur refuse si le relais local n'est plus
actif. Ce garde-fou survit à un rollback pendant qu'une page reste ouverte. Aucun
paramètre `local` ne va à OFF. Le mode distant reste déclenché explicitement.

Le catalogue v3 ajoute un vocabulaire/trigrammes et une correction OSA bornée après
zéro résultat littéral. FTS5/BM25, préfixes et valeurs nutritionnelles restent les
mêmes ; anciens catalogues v1/v2 lisibles sans correction. Voir le prototype pour
les mesures et limites de rappel. Aucun catalogue entier n'a été récupéré : tailles
actuelles inconnues à cause du DNS sandbox. Réserve disque renforcée à 20 Gio.

## Priorité V1 Web + Android — 12 octobre 2026

Le TSV est un index d’identités publiques, pas une preuve de référence nutritionnelle. Le parcours V1 charge une fiche OFF v3 à la sélection, jamais pendant les suggestions. Un cache public durable séparé garde les fiches validées, leur date, référence et provenance ; les aliments enregistrés et snapshots restent dans le stockage personnel v1 inchangé. L’expérience locale reste désactivée en production.

L’extrait réel reçu `tsv-sample-20261012T164242` comporte 5 000 lignes, 211 colonnes, SHA-256 `b37f5e31003c5b3738475b1d387ef260b83230b6c0ede843be3e1c998398bd4f`. Il contient `brands`, mais aucun nom localisé ni référence 100 g / 100 ml explicite. Import isolé : 4 196 identités, 804 rejets, 0 références exploitables. Ces premières lignes ne sont pas représentatives du catalogue. Le fichier source, les générations existantes et les données personnelles sont conservés.

Préflight mesuré : 50,67 Gio libres, environ 3,78 Gio disponibles en RAM, quatre CPU, sans swap. Réserves obligatoires : 20 Gio disque, 2 Gio RAM disponible. Les limites 100 000 lignes / 512 Mio ne sont pas relevées sans démonstration sur un échantillon diversifié ; l’import complet et la publication dans l’application restent bloqués tant que ce dimensionnement et les validations Docker/appareil ne sont pas acquis.

### Parcours sélection et cache v3 effectivement implémenté

`catalog-local.js` conserve la recherche SQLite sans appel OFF. En mode expérimental,
la route produit utilise `catalog-product-cache.js` avant la consultation OFF v3,
y compris quand le code existe dans le TSV. Le client combobox hydrate à la sélection,
conserve date/repas, protège les réponses tardives et n’ouvre l’éditeur qu’avec une fiche
normalisée. Le moteur de calcul et les snapshots utilisateur v1 ne changent pas.

Cache public : `artifacts/public-v3-cache/<workspace>/`, distinct des générations
montées en lecture seule et de `DATA_DIR`. Fichiers par code/langue, schéma cache 1,
API `v3.5`, validateur 2, date, référence, état `validated` ou `unusable`, provenance
ODbL/DbCL, SHA-256 de l’enveloppe de données. Le hash détecte des corruptions et ne
constitue pas une signature. Revalidation réelle à chaque lecture. Entrée ≤64 Kio,
10 000 fichiers nominalement (au plus 16 écritures en vol), 16 consultations en vol,
déduplication avant le budget OFF, TTL sept jours, aucune boucle de retry. Un seul
processus API possède ce répertoire ; le partage entre plusieurs réplicas doit être
traité avant un tel déploiement. Aucun cache ni reçu d’un compte n’y entre.

Écriture : fichier exclusif, fsync, rename atomique, fsync du répertoire. Une entrée
corrompue est un cache miss ; les restes `.partial` ne sont pas utilisés ni purgés.
Quota/permissions/réserve disque insuffisants : erreur explicite, sans faux délai de
60 secondes. La marge 20 Gio disque est vérifiée avant une écriture. Les anciennes
fiches fiables peuvent être rendues périmées lors d’un incident réseau/429/503 ;
la date et le statut sont transmis, le cache est indiqué dans l’écran. Un nouveau
contenu invalide ou un 404 ne ressuscite pas une ancienne fiche. Aucune donnée
personnelle n’est détruite quand le cache est indisponible.

En sélection v3, `requireExplicitReference` refuse de déduire g/ml du suffixe
`_100g`, refuse une préparation ambiguë et les erreurs nutritionnelles déclarées.
Dans le cache V1, seule une référence explicite du `nutrition.aggregated_set`
normalisé de v3.5 permet l’ajout. Une référence explicite et des valeurs partielles peuvent rester utilisables :
les valeurs manquantes restent `null` et les totaux sont annoncés incomplets.
Les anciennes normalisations à la portion restent compatibles hors du cache V1 ;
la fiche v3.5 normalise la quantité à 100 g ou 100 ml. Aucune densité n’est inventée. Les appels historiques de normalisation
restent compatibles, et les contrats Food/persistance/sauvegarde ne sont pas modifiés.

Android invité peut utiliser le même backend public avec un build explicitement
configuré `VITE_NUTRITION_CATALOG_ORIGIN=https://votre-serveur`. Un serveur appairé
prend priorité. Aucun token/cookie n’est ajouté aux consultations du catalogue.
Sans serveur configuré, le mobile conserve le comportement distant explicite et
les produits déjà enregistrés ; il ne dispose pas magiquement du catalogue SQLite.

### Correction de revue : version OFF et budget commun

La documentation officielle précise que les anciens `_100g` désignent 100 g **ou**
100 ml, et que `nutrition_data_per=100g` est un réglage de saisie legacy, insuffisant
pour prouver le dénominateur. Le relais du mode local consulte donc l’endpoint fixe
`/api/v3.5/product/<code>` derrière la route openGym inchangée `/product`. Le mode
distant classique garde `/api/v3/product`. Le choix 3.5 est interne/configuré, jamais
un paramètre libre d’une requête publique. Les nouvelles versions OFF 3.6 concernent
notamment les tags ; leur migration n’est pas entreprise pendant ce gel V1.

Le cache demande l’agrégat `as_sold`, `per=100g|100ml`, dont les unités normalisées
sont documentées par OFF ; une unité explicitement contradictoire est refusée. Les
anciennes entrées de cache validateur 1 ne sont pas acceptées comme validateur 2.
Les snapshots et Foods existants ne sont pas recalculés. Cette adaptation doit
être éprouvée sur quelques vrais produits v3.5 depuis SSH ; aucune fiabilité clinique
ou exactitude garantie des contributions OFF n’est promise.

La revue a aussi supprimé deux instances de budget distinctes dans le chargeur
expérimental : le cache produit et les éventuels appels staging partagent maintenant
**le même relais**, donc le même budget effectif par IP sortante.

Sources officielles : [schéma nutrition normalisée v3](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/docs/api/ref/schemas/product_nutrition_v3.yaml),
[ancien schéma](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/docs/api/ref/schemas/product_nutrition.yaml),
[versions de schéma](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/docs/api/ref-api-and-product-schema-change-log.md).

Le bilan de validation V1 et les commandes reproductibles sont centralisés dans
[NUTRITION_LOCAL_CATALOG_PROTOTYPE.md](NUTRITION_LOCAL_CATALOG_PROTOTYPE.md#dernier-durcissement-des-temporaires-et-bilan-des-exécutions).
Ce bilan distingue les mesures OFF réelles, les fixtures et les validations non
exécutées. Le cache est borné et volontairement sans purge automatique pour cette
V1 expérimentale ; atteindre sa capacité exige une maintenance explicite du cache
public, jamais une suppression des Foods/snapshots/opérations utilisateur. Le budget
est partagé **dans un seul processus API** ; plusieurs réplicas ou plusieurs autres
services utilisant OFF derrière la même IP nécessitent une coordination supplémentaire.


## V1 locale wger — complément et benchmark public (26 octobre 2026)

Le relais de développement `catalog-wger.js` ne construit aucun client alimentaire distant. Recherche, UUID et codes-barres utilisent exclusivement le worker SQLite. `VITE_NUTRITION_LOCAL_V1=1` impose également ce choix côté client : un serveur ancien/indisponible n’entraîne aucun repli OFF, sur Web comme sur Android. La source wger/USDA, les licences individuelles et les libellés français proposés sont affichés ; les snapshots conservent le Food original. Les Foods utilisés sont mémorisés atomiquement avec l’entrée et retrouvables dans la bibliothèque. La restauration globale reste interdite.

La base complète reste inchangée : 124 943 candidats techniques. Un complément v2 obligatoire pour le lecteur V1 met 3 943 profils à quatre zéros en revue, sans toucher aux données personnelles : 121 000 candidats restent ajoutables dans ce mode. Cela ne valide pas chaque produit contre son étiquette fabricant. Les barcodes OFF ambigus restent non ajoutables.

Les 18 cas curatés ne constituent plus une mesure de couverture. Voir [benchmark public](NUTRITION_CATALOG_BENCHMARK.md) pour les 1 000 cas OFF réels, l’absence de succès exact ajoutable sur ce préfixe biaisé, et les captures Open Prices/OFF à obtenir hors sandbox. Les instructions de laboratoire, budgets, générations et preuves sont centralisés dans [le prototype](NUTRITION_LOCAL_CATALOG_PROTOTYPE.md). Les descriptions historiques de transport direct/v3 ci-dessus ne décrivent pas le mode local V1.

## Validated original OFF complement integration — in progress (26 October 2026)

The authorized development integration pins the existing wger generation, its
French quality complement and the verified full OFF reference generation. It never
modifies these files. A new auxiliary FTS/identity-binding index stores only names,
brands, canonical barcode keys and verified wger UUID links; Food payloads remain
in the original reference SQLite. This is a derived index, not another wger import
or a download. Planned explicit ceilings: 768 MiB index DB / 1 GiB workspace,
<=1,000,000 reference rows, <=5,000,000 bindings, 256 MiB process RSS, four hours.
Current free disk ~30.60 GiB and available RAM ~4.24 GiB allow this extra <=1 GiB
while retaining >=20 GiB disk / >=2 GiB RAM; stronger start/watch margins apply.

Only proven OFF source URL/barcode correspondences become bindings. GS1 aliases
require valid checksums; malformed/all-zero codes are never guessed. Wger UUIDs
without reliable mappings remain separate. Search merges literal FTS matches and
deduplicates verified identities before pagination. Exact name matches precede
different products even when the exact match lacks usable nutrition. Within each
match class, usable references precede review-only records. No fuzzy or provider
fallback exists on this path. Metadata hashes pin all generations for the reader
lifetime. Selected OFF Foods retain their original values, source, licences and
content-addressed identifiers; portable persistence/synchronization are unchanged.

The mode stays explicitly development-only, disabled by default, with an isolated
DATA_DIR. Missing/corrupt configured references fail closed, never to an external
food API. New catalogue DTO IDs may identify original OFF barcodes as well as
wger UUIDs; legacy wger-only mode and provider mode retain their existing behavior.
The existing journal quantity editor and durable service.batch remain the sole
path for user writes. Subsequent sections record implementation/test evidence.

### Implemented local join and first real-data checks

The new index `wger-off-search-20261026` is complete: **835,231 metadata rows**,
**832,481 proven UUID bindings**, **302,596,096 bytes** (~288.6 MiB). Build took
609.28 s, CPU 439.08 s, observed RSS ~44 MiB. This did not change or rebuild wger,
the reference database or the French complement. No download occurred. The new
`NUTRITION_LOCAL_CATALOG_REFERENCE` and `_REFERENCE_INDEX` environment variables
are an all-or-none optional pair in the existing development-only `wger-v1` mode.
Missing, corrupt or mismatched sources fail closed. No provider/cache constructor
is used on this path. The worker pins all four immutable generations.

The public envelope and capability v2 remain compatible with the V1 path. Stable
lookup IDs now include `off:<canonical-key>` in addition to `wger:<uuid>`; they
are not Food snapshot IDs. A legacy bound UUID read includes its explicit
`lookupId` and returns the same canonical OFF descriptor. Only valid GS1 padding
aliases coalesce. Invalid-checksum identities remain exact, and all-zero codes
are not guessed as aliases. OFF Foods are validated with their declared unit,
source/input-set lineage, full-source hash, licenses and matching barcode.
Private Foods/recipes/history/outbox never enter these databases.

Search applies exact-name / prefix / brand / token match classes first, then
usable reference, completeness, factual France-market observation (the bounded
48,357 accepted Open Prices identities), language hint and BM25. This is not
invented popularity. Verified duplicate identities coalesce before counting and
pagination. Unverified UUIDs remain distinct; uncertain nutrition stays visible
with explicit non-addable status. A different usable product does not displace
an exact unusable name match. No fuzzy correction runs.

Real-data review found avoidable cold-query I/O in the union: it initially read
wger payload pages for every candidate and materialized the union twice. The
query now uses the existing covering `search_rank_idx`, aggregates verified
identities once and counts with a window. `addable=0` already encodes source
conflicts in the sealed base; bindings are admitted only for conflict-free rows.
No check was relaxed. A bounded, optional metadata warm read after source hashing
reduces eviction-induced cold latency without reading/reconstructing Food bodies
or raising the two-second search deadline. Only source metadata/docsize indexes
are warmed, with a separate three-second startup warm budget.

First real runtime check `reference-app-check-20261026/report.json`: anonymous
HTTP plus actual client and file backend, all 14 common French searches succeeded;
five real Foods passed add/edit/reopen/delete with pending operations retained and
zero external provider calls. The unchanged independent barcode frame returns
**629 identities, 544 addable**, zero loss of the 544 verified reference cases.
This differs from the source audit's 744 retained identities: rejected OFF-only
rows absent from wger are intentionally not added to the new search index. Wger's
600 baseline identities plus 29 newly usable OFF-only cases yield 629 here.
It is not a regression or proof of 90% coverage. Mean/p95 barcode lookup through
the actual worker and DTO boundary: 1.82 / 3.49 ms; startup 24.25 s; full check
33.68 s. These are local service measurements, not browser paint/device timings.

Review tests also fixed fixture setup lifecycle errors: close owns/closes its
store, and a new session's initial inspection must run before checking pending
UI status. React tests use the real screen, command service and file backend,
wait for actual asynchronous journal reload, and cover both g and ml. No
application lifecycle behavior was changed to satisfy the tests. Full suites,
builds, isolated API boot and manual instructions are recorded below.

## Intégration validée en développement — 26 octobre 2026

### Résultat et limites de la mesure

Le lecteur raccorde quatre générations **immuables**. Aucun catalogue préexistant
n'a été remplacé, aucun téléchargement ni nouvel import wger n'a eu lieu. Le nouvel
index de 302 596 096 octets est seulement un index de recherche et de correspondances.
Il ne recopie pas les Foods du complément de 1 762 095 104 octets. Ensemble, les
quatre fichiers SQLite occupent environ 6,91 Gio. Leurs SHA-256 restent épinglés
par le worker et par l'index dérivé ; une discordance interdit la lecture.

La jointure expose **956 231 identités de sélection utilisables** : 835 231 OFF
(803 100 pour 100 g, 32 131 pour 100 ml), plus 121 000 wger non liés, après les
exclusions déjà approuvées. Ce total n'est pas un nombre de codes-barres uniques,
ni un taux de couverture française. Des sources non rapprochables restent
distinctes ; aucune fusion par simple ressemblance de nom n'est effectuée.

Rapport reproductible `artifacts/reference-app-final-20261026/report.json` :

| Contrôle | Résultat |
| --- | --- |
| Cadre indépendant Open Prices inchangé | 1 000 cas, 913 codes supportés |
| Codes retrouvés / ajoutables | 629 / 544 (59,58 % des 913) |
| Références validées précédemment perdues | 0 |
| Nouveaux cas ajoutables absents de wger | 29 |
| Recherches françaises usuelles | 14 réussies, 20 résultats chacune |
| Parcours HTTP puis journal durable réel | 5 produits, g et ml, modification/réouverture/suppression |
| Appels fournisseur | 0 |
| Codes-barres, moyenne / p95 | 1,63 / 3,60 ms |
| Recherches texte, min / max mesurés | 92,8 / 547,1 ms |
| Démarrage avec vérification complète | 29,60 s |
| Contrôle complet | 36,17 s |
| Pic RSS Python / Node | 56,86 / 107,42 Mio |

Environnement : Debian, Python 3.13.5, SQLite 3.46.1, Node 22 ; mesures locales
pendant des tests frontend, pas des mesures de rendu Firefox/Android. Nutella,
Coca-Cola, lait, riz, pâtes, yaourt, œufs, banane et poulet ont chacun 20/20 résultats
ajoutables dans la première page ; Carrefour 14/20, Auchan 12/20, Leclerc 18/20,
Nestlé 10/20, Bonne Maman 17/20. Une correspondance exacte non ajoutable peut
légitimement précéder un produit différent ajoutable. Ces 14 contrôles sont des
smoke tests curatés ; seul le cadre Open Prices indépendant sert à mesurer la
couverture par code. La pertinence sémantique de chaque résultat n'a pas été
évaluée par un panel humain.

**Référence déclarée cohérente ne signifie pas étiquette certifiée exacte.** Des
contributeurs peuvent déclarer du riz en ml ou du lait en g. Le lecteur restitue
la déclaration originale, affiche l'unité et la source, et ne corrige jamais ces
cas par une supposition sur le nom. Une revue de qualité des données reste utile.
Les 369 codes non ajoutables du cadre ne sont pas considérés comme couverts.

### Revue de concurrence, intégrité et compatibilité

Le contrôle de démarrage ne tient pas dans le délai courant de 30 secondes
sur chaque charge disque : une relance avait échoué `worker-timeout`. Le
superviseur dispose désormais d'un délai initial **90 secondes maximum** lorsque
le complément est configuré. Les requêtes chaudes gardent leur délai de 30 secondes
(file comprise), la file garde 16 places et SQLite conserve son plafond de deux
secondes. Le réchauffement facultatif de métadonnées reste borné à trois secondes.
Une requête échouée n'est pas rejouée ; après crash, le prochain processus doit
refaire les vérifications. Le test `worker.test.mjs` vérifie démarrage lent,
timeout chaud et redémarrage. Aucun plafond d'import source n'a été relevé.

Deux erreurs de fixtures ont été corrigées : la suppression d'un répertoire de
test pouvait chevaucher une lecture/indexation dérivée encore en cours ; le bridge
de test ferme désormais les admissions et attend ses files. Un serveur invité
ne crée pas nécessairement `db.json` ; le test vérifie maintenant la conservation
de son absence aussi. Le DATA_DIR de test serveur reste hors des artefacts publics.
Ce sont des corrections des tests, sans modification des adaptateurs de stockage
utilisateur. Les suites complètes doivent être lancées **successivement**, pour
ne pas faire échouer le préflight de fixture d'index (3 Gio de RAM disponibles).

Les réponses OFF restent vérifiées à la frontière JS avec `validateFood` :
référence identique, quatre nutriments présents, identité/barcode cohérents,
source fixe HTTPS, ODbL/DbCL et lignée de l'export complète. Les marqueurs de
suppression, snapshots, recettes, sauvegardes et opérations non acquittées suivent
les mécanismes préexistants. La recherche ne publie aucune donnée personnelle.
La sélection et l'entrée passent ensemble par `service.batch`. Les deux tests
React g/ml utilisent le véritable écran, les commandes et le backend fichiers
simulé ; ils ne constituent pas des essais sur appareil natif.

Les images ne sont pas chargées dans cette voie. Les attributions OFF (contributeurs,
ODbL, DbCL, lien produit) et wger/USDA/licence d'origine restent dans chaque Food et
snapshot. Les données personnelles ne sont jamais insérées dans les bases publiques.
Une redistribution publique du catalogue assemblé nécessite la revue des obligations
des différentes licences ; cette intégration expérimentale n'affirme pas régler
toutes les questions juridiques de redistribution.

### Lancer Firefox, dans des terminaux SSH séparés

Depuis `/home/codex/openGym`, avec les dépendances du dépôt déjà installées :

```bash
# Terminal 1. Crée son propre DATA_DIR ; aucun .env ni secret de production lu.
bash scripts/nutrition-local-catalog/start-reference-dev.sh
```

Attendre `gym-api on :3301` (hashs de plusieurs Gio ; environ 30 secondes ici).
Un port déjà occupé doit être traité comme un arrêt : ne pas tuer un service existant.

```bash
# Terminal 2
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
API_TARGET=http://127.0.0.1:3301 API_ORIGIN=http://localhost:5175 \
 VITE_NUTRITION_LOCAL_V1=1 npm run dev -- --host 127.0.0.1 --port 5175 --strictPort
```

```bash
# Depuis le poste du navigateur ; remplacer VPS par son hôte SSH habituel.
ssh -N -L 5175:127.0.0.1:5175 -L 3301:127.0.0.1:3301 codex@VPS
```

Ouvrir `http://localhost:5175`, « Continuer sans compte », Nutrition. Vérifier
recherche pendant la frappe, clavier/flèches/Entrée/Escape, quantité g ou ml,
ajout/modification/suppression et rechargement. Essayer Nutella `3017620422003`,
Coca-Cola `5449000000996`, lait `3250392190484`. Le réseau doit montrer seulement
les routes catalogue openGym, aucun appel API OFF/wger. Un clic volontaire sur
un lien d'attribution ouvre évidemment le site source, sans requête alimentaire
automatique. Sans backend, les aliments déjà sauvegardés restent dans la
bibliothèque locale ; les nouvelles recherches dans le catalogue serveur nécessitent
l'API openGym, même en l'absence de connexion au fournisseur.

Contrôle SSH sans compte :

```bash
curl --fail --show-error 'http://127.0.0.1:3301/api/nutrition/catalog/capabilities'
curl --fail --show-error 'http://127.0.0.1:3301/api/nutrition/catalog/search?q=Nutella&lc=fr&page=1'
curl --fail --show-error 'http://127.0.0.1:3301/api/nutrition/catalog/product?code=5449000000996'
```

Attendus : capacité `selection:local-only`, source `local-wger`, fiche Coca-Cola
`reference:{amount:100,unit:"ml"}`. Les erreurs locales restent explicites sans
fallback fournisseur. La désactivation consiste à arrêter ces processus de
développement ; aucune configuration de production n'a été modifiée. Le mode
historique, sans les variables opt-in, garde son comportement précédent.

### Android debug et Docker : validations restantes

Le build `build:mobile` réussit, y compris `cap sync` et le contrôle des trois
bundles. L'APK n'a pas été compilé : Java/JAVA_HOME et Android SDK/adb ne sont pas
disponibles ici. iOS signale l'absence de `xcodebuild` ; aucune compilation iOS ou
validation physique n'est revendiquée. Le variant debug existant utilise déjà
`ch.duartesantos.opengym.test` (suffixe `.test`), sans changer le release.

Sur un environnement Android configuré (JDK 21, SDK et adb), depuis le dépôt :

```bash
cd frontend
VITE_NUTRITION_LOCAL_V1=1 VITE_NUTRITION_CATALOG_ORIGIN=http://127.0.0.1:3301 npm run build:mobile
cd android
./gradlew --no-daemon --max-workers=2 assembleDebug
# Poste connecté au téléphone et disposant du tunnel SSH local 3301 ci-dessus :
adb reverse tcp:3301 tcp:3301
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Autre méthode : ouvrir `frontend/android` dans Android Studio et construire le
variant **debug** après le build mobile. Ne pas désinstaller/effacer une application
existante. Utiliser le profil invité de test et vérifier toucher, clavier virtuel,
rotation, g/ml, réouverture et réutilisation hors ligne. Le nouvel APK est requis
pour embarquer les flags Vite ; un ancien APK ne suffit pas.

Docker n'a pas été exécuté : accès refusé au socket `/var/run/docker.sock`.
`Dockerfile.api-lab` seul a été complété ; le Dockerfile de production est inchangé.
Depuis un terminal ayant déjà les permissions Docker, sans sudo :

```bash
cd /home/codex/openGym
docker build -f scripts/nutrition-local-catalog/Dockerfile.api-lab -t opengym-ref-lab .
# Les générations sont privées 0700/0600 : utiliser le même UID non root que leur
# propriétaire, plutôt que chmod/chown ou recopier plusieurs Gio.
test "$(id -u)" -ne 0
CATALOG_ARTIFACTS=/home/codex/openGym/scripts/nutrition-local-catalog/artifacts
docker run --name opengym-ref-lab --read-only --network none --cpus 1.5 \
 --memory 768m --pids-limit 64 --user "$(id -u):$(id -g)" \
 --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
 -e NODE_ENV=development -e PORT=3302 -e DATA_DIR=/tmp/ref-dev \
 -e ORIGIN=http://localhost:5175 -e NUTRITION_LOCAL_CATALOG=1 \
 -e NUTRITION_LOCAL_CATALOG_KIND=wger-v1 \
 -e NUTRITION_LOCAL_CATALOG_WORKSPACE=wger-full-registered-20261025 \
 -e NUTRITION_LOCAL_CATALOG_COMPLEMENT=wger-fr-quality-20261026 \
 -e NUTRITION_LOCAL_CATALOG_REFERENCE=off-reference-full2-20261026 \
 -e NUTRITION_LOCAL_CATALOG_REFERENCE_INDEX=wger-off-search-20261026 \
 --mount type=bind,src="$CATALOG_ARTIFACTS/wger-full-registered-20261025",dst=/app/scripts/nutrition-local-catalog/artifacts/wger-full-registered-20261025,readonly \
 --mount type=bind,src="$CATALOG_ARTIFACTS/wger-fr-quality-20261026",dst=/app/scripts/nutrition-local-catalog/artifacts/wger-fr-quality-20261026,readonly \
 --mount type=bind,src="$CATALOG_ARTIFACTS/off-reference-full2-20261026",dst=/app/scripts/nutrition-local-catalog/artifacts/off-reference-full2-20261026,readonly \
 --mount type=bind,src="$CATALOG_ARTIFACTS/wger-off-search-20261026",dst=/app/scripts/nutrition-local-catalog/artifacts/wger-off-search-20261026,readonly \
 opengym-ref-lab
```

Dans un autre terminal, attendre la ligne de démarrage puis :

```bash
docker exec opengym-ref-lab node --input-type=module -e '
const r=await fetch("http://127.0.0.1:3302/api/nutrition/catalog/product?code=5449000000996");
const b=await r.json();if(r.status!==200||b.product.reference.unit!=="ml")process.exit(1);console.log(b.product.name,b.product.reference);'
docker stats --no-stream opengym-ref-lab
docker stop opengym-ref-lab
```

Le serveur expérimental écoute volontairement sur loopback dans le conteneur ;
ce contrôle utilise `docker exec`, sans publication de port ni modification des
services existants. Nom de conteneur/image déjà présent : arrêter la procédure,
ne pas effacer un conteneur existant. Conserver 20 Gio disque et 2 Gio RAM libres
avant la construction. Répéter sur des copies de fixtures absentes/corrompues,
jamais en altérant les générations réelles. La validation Docker reste ouverte.

### Validation automatisée finale et reproduction

Node **22.23.3**, npm **10.9.9**. Les résultats ci-dessous sont les dernières
exécutions complètes de chaque groupe ; ne pas les additionner à leurs relances
ou aux tests ciblés qu'ils incluent. Aucun test ignoré/annulé dans ces groupes.

| Groupe | Résultat | Journal dans `artifacts/` |
| --- | --- | --- |
| Frontend complet | **5 830 réussis / 441 fichiers**, 0 échec, 435,62 s | `integration-frontend-reviewed.log` |
| API complète, HTTP réel compris | **796 réussis, 7 échecs préexistants**, 803 tests, 119,71 s | `integration-api-final.log` |
| Prototype Python complet | **227 réussis**, 9,36 s | `integration-python-reviewed.log` |
| Prototype Node complet | **110 réussis**, 8,56 s | `integration-prototype-node.log` |
| Contrats API / packaging / configuration ciblés | **20 réussis** (déjà inclus dans API) | `integration-contracts-final.log` |
| Locales | **18 langues × 2 466 clés synchronisées** | commande ci-dessous |
| Build Web / mobile | réussis ; synchronisation Capacitor et bundles contrôlés | `integration-web-build.log`, `integration-mobile-build.log` |

Les sept échecs API se trouvent dans `coach-limits.test.js` (2), `jobs.test.js`
(4), `routes.test.js` (1). Une copie de **HEAD 6610d192** extraite par `git archive`
dans un nouveau workspace a reproduit exactement ces sept échecs : **37 réussis,
7 échecs sur les 44 tests des trois fichiers** (`integration-api-baseline.log`).
Les fixtures entraînement du 20 juillet sortent désormais de la fenêtre mobile
de 12 semaines du Coach ; la fixture fournisseur répond `nochange`, contrairement
aux attentes `ready`, ou la séance de debrief n'est plus disponible. Aucun code
Coach/entraînement n'a été modifié pour obtenir un résultat vert.

Les relances intermédiaires ont réellement échoué : nettoyage du bridge de test
frontend, hypothèse `db.json` existant pour un invité, et préflight de construction
de fixture pendant la charge frontend (<3 Gio disponibles mais toujours >2 Gio).
Les deux premiers cas ont été corrigés dans les fixtures, le dernier en exécutant
les suites successivement, sans abaisser la protection ressources. Les journaux
intermédiaires sont conservés. Un avertissement Vitest `MaxListenersExceededWarning`
apparaît dans la suite complète, sans test échoué ; il n'a pas été masqué. Les
builds signalent les avertissements de chunks volumineux et d'import scan mixte.

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
export TMPDIR=/home/codex/openGym/scripts/nutrition-local-catalog/artifacts/parquet-runtime-tmp
mkdir -p "$TMPDIR"
# Lancer successivement, avec les ressources vérifiées avant chaque suite.
(cd frontend && npm test -- --maxWorkers=2)
(cd api && node --test --test-concurrency=2 test/*.test.js)
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py'
node --test --test-concurrency=1 scripts/nutrition-local-catalog/*.test.mjs
(cd frontend && node scripts/check-locales.mjs)
# Le nom de workspace doit être nouveau : aucun rapport existant n'est écrasé.
node scripts/nutrition-local-catalog/reference-runtime-check.mjs reference-check-new
git diff --check
```

Le TMPDIR du projet évite le petit tmpfs `/tmp` et permet aux contrôles disque de
rester actifs. Les tests suppriment uniquement les fixtures qu'ils créent. Le
contrôle réel conserve son rapport, utilise un journal neuf et ne lit aucun compte
de développement/production. Les générations d'origine sont montées/logiquement
ouvertes en lecture seule. Ressources mesurées pendant la dernière validation
réelle : **30,29 Gio disque et 3,49 Gio MemAvailable** ; aucun swap. Aucun test
de coupure électrique, Firefox réel, appareil Android ou conteneur Docker n'est
assimilé aux simulations.

### Fichiers de cette intégration et maintenance

- `wger-off-reference.py` : index dérivé et jointure de lecture ;
  `test_wger_off_reference.py` : déduplication, unités, pagination, interruption,
  corruption et absence de fuzzy. `off-integration-fixtures.mjs` : Foods synthétiques
  normalisés par le moteur réel, uniquement pour tests.
- `wger-v1-reader.py`, `wger-worker-client.mjs`, `worker-client.mjs`,
  `worker.test.mjs`, `wger-api-adapter.mjs` : raccordement, protocole borné,
  démarrage et projection stricte du DTO.
- `reference-runtime-check.mjs`, `start-reference-dev.sh` : contrôle réel isolé
  et lanceur sans configuration/identité de production héritée ; `.gitignore`
  du prototype exclut ses répertoires runtime et artefacts.
- `Dockerfile.api-lab` et son `.dockerignore` : dépendances de lecture ajoutées
  à l'image de test uniquement ; aucun Dockerfile de production modifié.
- `api/nutrition/catalog-local.js`, `catalog-wger.js`,
  `api/shared/nutrition-catalog-identity.js`, `api/openapi.yaml` : configuration
  opt-in, identités barcode/UUID, routes et documentation de contrat.
- `api/test/catalog-reference.test-util.js`, `catalog-reference-http.test.js`,
  `catalog-local.test.js`, `catalog-wger.test.js`, `server-local-catalog.test.js` :
  HTTP réel, worker, journal durable, séparation des données, configuration et
  fixtures conformes aux contrats.
- `frontend/src/lib/nutrition/catalog/{identity.js,local-product.js,client.js,off-local-product.test.js}` :
  identité partagée, validation, sélection et tests de frontières.
- `frontend/src/views/nutrition/{FoodCatalog.jsx,FoodCatalog.test.jsx}` : statut
  non ajoutable, provenance, parcours React g/ml complets ;
  `frontend/src/lib/nutrition/local-storage.test-util.js` : fermeture du bridge
  de simulation avant nettoyage, sans modification du stockage natif réel.
- Documents : cette référence, `NUTRITION_LOCAL_CATALOG_PROTOTYPE.md` et
  `NUTRITION_OFF_REFERENCE.md`. Les sections historiques restent identifiées
  comme telles. Les nombreux autres changements présents dans le worktree
  avant cette mission sont conservés et ne sont pas attribués à ce raccordement.

Conclusion : **mode expérimental prêt pour essais manuels**, pas V1 autorisée à
publier. Restent Firefox, Android physique/APK, Docker/permissions, revue des
anomalies contributives de source et obligations de redistribution, et correction
séparée des fixtures Coach pour rendre la suite API entière verte. Aucun commit,
push, déploiement, mise à jour automatique ou activation de production effectué.

## Stabilisation de nuit — 27 octobre 2026

### Corrections limitées, sans changement du périmètre produit

Les sept échecs API historiques sont résolus : `recentSampleState` fournit aux
seuls tests de files/routes Coach une séance de la veille et des pesées récentes.
`sampleState` garde ses dates fixes pour les tests de payload ayant leur propre
horloge. Les scénarios explicitement vides/anciens ne sont pas rajeunis. Les tests
du helper couvrent une année future, le changement d'année et le 29 février.
Le debrief compare sa date à la fixture effective, plus à une constante de juillet.
Ni la fenêtre de douze semaines, ni le Coach, ni les entraînements produit n'ont
été modifiés. Résultat : **805 tests API réussis, zéro échec/ignoré**, dont 46 tests
ciblés initialement (inclus dans la suite complète, à ne pas additionner).

Une régression réelle du chemin mobile a été corrigée : le bridge public ignorait
les corps d'erreur HTTP 409 ; le vrai client catalogue ne pouvait donc pas
reconnaître `catalog-ambiguous-barcode`. Il reçoit maintenant uniquement ce code
autorisé. Les corps HTML, les chaînes >1 024 caractères, les champs accessoires
et getters ne sont pas propagés ; une autre erreur 409 reste une annulation/
erreur réseau explicite. Les tests passent par le bridge et le véritable client
local-only, pour des réponses natives objet et JSON. Les limites, licences,
authentifications et politiques de repli restent inchangées.

### Contrôles réellement effectués

Les journaux de cette passe se trouvent dans le nouveau workspace ignoré
`artifacts/night-stability-20261027/`. Le lancement **exact** du script API et de
la commande Vite ci-dessous a été testé sur loopback avec un DATA_DIR neuf. La
page Vite et le flag V1 sont servis, `/api/config` et les capacités répondent 200
à travers le véritable proxy. Huit recherches (lots de quatre concurrentes) sont
réussies, 20 résultats chacune, entre 127 et 817 ms file comprise. L'API personnelle
reste authentifiée (401 invité), une origine étrangère reste refusée (403), les
paramètres arbitraires sont refusés (400) et un code absent retourne 404. Les
processus Vite/API de contrôle ont ensuite été arrêtés ; leurs workers ne restent
pas en arrière-plan.

Le contrôle réel `reference-night-20261027/report.json` réussit les 14 recherches,
les cinq parcours journal durables en g/ml et le cadre indépendant figé :
**629 retrouvés, 544 ajoutables sur 913**, zéro référence perdue, zéro appel
fournisseur. Démarrage vérifié 26,94 s, code-barres moyenne/p95 1,54/3,45 ms,
contrôle complet 33,21 s ; pic Python 57,18 Mio et Node 112,89 Mio. Ces mesures
ne sont pas des temps de rendu navigateur ni des tests physiques Android.

Les déclarations nutritionnelles originales restent identiques : par exemple
Nutella `3017620422003`, pour 100 g : 539 kcal, 6,3 g protéines, 57,5 g glucides,
30,9 g lipides ; Coca-Cola `5449000000996`, pour 100 ml : environ 43,02 kcal,
0 g protéines, 10,6 g glucides, 0 g lipides. Ces valeurs sont des contrôles de
ces fiches de l'export, pas des constantes appliquées à tous les produits de marque.
Les valeurs absentes restent absentes et aucune équivalence g/ml n'est déduite.

### Guide court pour l'essai humain

Utiliser un **profil navigateur de test**, pas le profil contenant des données
habituelles ; une fenêtre privée convient au premier essai mais sa fermeture
supprime son stockage temporaire. Dans deux terminaux SSH distincts :

```bash
# Terminal API : attendre « gym-api on :3301 » avant de continuer (~30 s).
cd /home/codex/openGym
bash scripts/nutrition-local-catalog/start-reference-dev.sh
```

```bash
# Terminal Vite
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
API_TARGET=http://127.0.0.1:3301 API_ORIGIN=http://localhost:5175 \
 VITE_NUTRITION_LOCAL_V1=1 npm run dev -- --host 127.0.0.1 --port 5175 --strictPort
```

Depuis le poste utilisateur :

```bash
ssh -N -L 5175:127.0.0.1:5175 -L 3301:127.0.0.1:3301 codex@VPS
```

Ouvrir `http://localhost:5175` → continuer sans compte → Nutrition. Essayer
Nutella, Coca-Cola, lait, riz, pâtes, yaourt, œufs, Carrefour/Auchan/Leclerc.
Vérifier nom/marque, source/licence et surtout **100 g ou 100 ml** ; ajouter 50
puis modifier à 75 dans l'unité proposée, vérifier les macros, recharger et
supprimer. Les aliments déjà enregistrés doivent rester réutilisables dans la
bibliothèque locale sans fournisseur. Relever : recherche/code/date exacte,
unité inattendue, doublon, donnée perdue, message d'erreur ou capture de console.
Aucune requête automatique vers OFF/wger ne doit apparaître. Ne pas chercher à
« corriger » une référence contributive en changeant son unité sans preuve.
Arrêter avec Ctrl+C les terminaux de développement après l'essai ; ne pas tuer
un processus existant si un port est occupé.

### Android : préparation seulement

Configuration vérifiée : SDK compile/target **35**, minimum **23**, Gradle
**8.11.1**, plugin Android **8.7.2**, langage Java **21**. Le debug reste
`ch.duartesantos.opengym.test`, libellé **OpenGymTest**, distinct du release.
`VITE_NUTRITION_LOCAL_V1=1` impose le local-only ;
`VITE_NUTRITION_CATALOG_ORIGIN=http://127.0.0.1:3301` utilise le tunnel du poste
relié au téléphone par `adb reverse`. Un serveur appairé, s'il existe, reste
prioritaire sur ce point d'accès invité ; utiliser le profil invité de test.
HTTP loopback est déjà permis par les réglages natifs existants, inchangés.
Java/adb ne sont pas disponibles sur ce VPS ; aucun outil lourd n'a été installé.
La procédure de build debug ci-dessus nécessite donc un poste équipé de JDK 21,
SDK 35 et platform-tools/adb. Aucun APK ni appareil physique n'est déclaré validé.

### Intégrité, revue et limites de cette passe

Les générations restent identiques, ouvertes en lecture seule. Les empreintes
complètes sont vérifiées au démarrage du lecteur ; la version logique reste
`468716ae3687ff0edb99b6cc3fb5013ac47a750b90769d208a5ce620f760e1b8`.
Des `PRAGMA quick_check` supplémentaires ont réussi sur la table d'index FTS
wger `products_fts_idx`, le complément de qualité et le nouvel index de jointure
(respectivement ~0,03 s, ~0,002 s et ~6,65 s). Le contrôle structurel **global**
de la base wger de ~5 Gio a été interrompu volontairement après ~129 secondes
d'I/O ; son journal contient donc `OperationalError: interrupted`, pas un constat
de corruption ni une validation complète. Aucune écriture n'était autorisée.
Les validations complètes de construction antérieures, les SHA-256 épinglés et
les tests de corruption/reconstruction sur fixtures restent applicables ; aucun
catalogue n'a été reconstruit ou remplacé pendant cette passe.

Revue fonctionnelle : noms/marques, priorités exactes, statut non ajoutable,
sources et licences, unités et quatre nutriments, ajout/modification/suppression
et réouverture contrôlés par les tests et les fiches réelles. Revue concurrence :
requêtes HTTP en lots, annulation/réponses tardives, reprise du worker et absence
de processus orphelin contrôlées ; les opérations durables utilisent toujours le
service existant. Revue sécurité/maintenance : refus d'origine/paramètres privés,
frontière du DTO, filtrage de l'erreur native et dates de fixtures vérifiés. Aucun
secret ni compte réel n'est nécessaire aux contrôles.

Les deux builds réussissent après correction. Le bundle Android contient bien
`http://127.0.0.1:3301`, et le contrôle mobile valide les copies Web/Android/iOS.
Les avertissements de chunks volumineux/imports statiques-dynamiques, et l'absence
de `xcodebuild` pour iOS restent signalés, sans assimilation à une compilation
native. La suite Vitest émet encore son avertissement `MaxListenersExceededWarning`
déjà observé ; il n'a pas été supprimé artificiellement. Aucun navigateur réel
ou appareil n'a été testé dans cette session. Docker n'a pas été réessayé pendant
cette passe ; la restriction de socket précédemment documentée reste à vérifier
depuis un terminal autorisé.

Fichiers de stabilisation uniquement :
`api/test/{helpers.mjs,helpers.test.js,coach-limits.test.js,jobs.test.js,routes.test.js}`,
`frontend/src/lib/nutrition/catalog/{public-relay.js,public-relay.test.js}`,
ce document et `docs/MOBILE.md`. Les autres changements du worktree sont conservés.

### Résultats finaux de la stabilisation

| Groupe | Commande depuis le dépôt, sauf mention | Résultat final |
| --- | --- | --- |
| Frontend complet | `cd frontend && npm test -- --maxWorkers=2` | **5 833 / 441 fichiers**, 0 échec/ignoré, 395,24 s |
| API complète | `cd api && node --test --test-concurrency=2 test/*.test.js` | **805 réussis**, 0 échec/ignoré, 122,50 s |
| Prototype Python | `python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py'` | **227 réussis**, 9,36 s |
| Prototype Node | `node --test --test-concurrency=1 scripts/nutrition-local-catalog/*.test.mjs` | **110 réussis**, aucun ignoré, 8,52 s |
| Traductions | `node frontend/scripts/check-locales.mjs` | **18 × 2 466 clés** synchronisées |
| Web | `cd frontend && VITE_NUTRITION_LOCAL_V1=1 npm run build -- --outDir ../scripts/nutrition-local-catalog/artifacts/night-stability-20261027/web` | réussi, 2,28 s |
| Mobile | `cd frontend && VITE_NUTRITION_LOCAL_V1=1 VITE_NUTRITION_CATALOG_ORIGIN=http://127.0.0.1:3301 npm run build:mobile` | réussi, sync Capacitor et bundles contrôlés |
| Git | `git diff --check` | réussi |

Utiliser Node 22 (`PATH=/home/codex/.local/opt/node22/bin:$PATH`) et un TMPDIR
neuf dans `scripts/nutrition-local-catalog/runtime/` pour les tests ; les petits
tmpfs ne disposent pas des 20 Gio requis par les préflights. Les groupes complets
frontend et API ont été exécutés successivement. Les 46/44 tests ciblés du début
sont déjà inclus dans les suites complètes, ne pas additionner les relances.

Les logs sont `coach-target.log`, `frontend-target.log`, `api-full.log`,
`frontend-full.log`, `python-full.log`, `prototype-node.log`, `web-build.log`,
`mobile-build.log`, `proxy-http.log`, `sqlite-integrity.log` (interrompu comme
expliqué ci-dessus), `sqlite-indexes.log`, `api-dev.log` et `vite-dev.log` dans
le workspace de cette nuit. Aucun échec applicatif restant identifié par cette
passe ; les limites navigateur/appareil et l'inspection structurelle globale
interrompue restent distinctes des tests automatisés réussis.

**Décision : prêt pour un essai humain Firefox**, en laboratoire local-only.
L'APK/Android physique et l'activation V1 restent à valider séparément. Aucun
processus de développement de cette passe n'est laissé actif, aucun catalogue,
profil réel, snapshot ou opération utilisateur n'a été remplacé. Aucun commit,
push, merge ou déploiement n'a été effectué.
