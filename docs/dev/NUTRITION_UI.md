# Nutrition interface — step 3

## Goal feedback after browser trials

Journal indicators and the selected nutrient in history share `GoalStatus` in
`views/nutrition/common.jsx`. Presentation uses the engine's remaining values;
it does not recalculate targets or change stored records. A null/missing target
shows just the muted `No goal defined` message (`Pas d’objectif défini` in French),
with no unknown target, remaining amount or exceedance. Targets are checked with
`target == null`, so a valid zero target remains defined. A zero target with known
positive intake shows the engine's negative remaining value as an exceedance;
zero intake shows zero remaining. Progress bars require a positive target, avoiding
an invalid max=0. Unknown consumption with a defined target still reports remaining
unavailable; missing data is not interpreted as zero. Overlapping goals retain the
existing explicit warning instead of being described as absent.

Exceeded targets use the explicit translated exceedance text and the scoped
`nutrition-goal-over` style. It mixes the existing theme `--orange` with `--label`
(65%/35%): darker orange for the light theme, lighter orange for dark. This improves
small-text contrast over the unmodified light-theme orange while retaining the
system palette. It is a presentation cue, not an urgent ARIA alert or nutrition
advice. The shared style applies to calories, protein, carbs and fat without
changing calories/macronutrient calculations, writes or sync. The four-column
desktop/two-column mobile grid remains, with min-width:0 on each indicator and
the existing wrapping for long localized messages. All 18 locale packs gain the
same key; new translations are implementation drafts, not independently reviewed
human translations.

Tests and validation (Node 22.23.3 / npm 10.9.9):

* `Journal.indicators.test.jsx` adds 14 real-component cases using `daySummary`
  from the existing engine adapter: no goal, partial/null targets, below/equal/above
  targets for all four nutrients, zero targets with empty/positive intake, unknown
  intake, overlaps, French wording, and CSS media-query application at 320, 390,
  768 and 1,280 px. Styles are read directly from the project because Vitest's
  default CSS import stub cannot test them. Conventional whitespace after `@media`
  keeps equivalent existing rules visible to happy-dom's CSS parser. There is no
  pixel layout or overflow assertion: happy-dom cannot establish those guarantees.
* `Nutrition.test.jsx` additionally switches the real history view between a
  calorie exceedance, a zero protein target, and absent carb/fat targets, through
  the actual selector and persisted records. The empty-journal assertion now checks
  the new absence wording.
* Final regression run below: **190 tests passed in 18 files, 0 failed, 0 skipped**,
  16.91 seconds, including the goal cases, journal/search/recipe/backup journeys,
  guest entry, form controls, Nutrition sessions/commands, training persistence/sync
  and locale compatibility. Older component tests still emit asynchronous `act`
  warnings. Earlier failures were test setup issues (Vite rewriting CSS URLs,
  CSS import stubbing, simulator media parsing) and were corrected without removing
  cases or changing engine validations. The temporary malformed pt-BR key insertion
  was corrected by following its existing `PT_BR_OVERRIDES` structure; its inheritance
  fingerprint test passes unchanged.
* Palette calculation on the actual card backgrounds gives contrast **4.86:1**
  for light (`--surface: #fff`) and **10.54:1** for dark (`--surface: #1c1c1e`).
  This is a calculation from the CSS tokens, not a browser screenshot measurement.
* Frontend build passes; locale consistency passes with **18 languages / 2,429
  keys each**; `git diff --check` passes. No new dependencies, persistence changes,
  API changes or training behavior changes are introduced.

```sh
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
npm test -- src/views/nutrition/Journal.indicators.test.jsx src/views/Nutrition.test.jsx src/App.guest.test.jsx src/App.scroll.test.jsx src/App.no-tabs.test.js src/components/TabBar.test.jsx src/components/ui.test.jsx src/lib/guest.test.js src/lib/api.test.js src/store/useStore.config.test.jsx src/store/useStore.sync.test.jsx src/store/useStore.sync-status.test.jsx src/store/persistence.test.js src/lib/nutrition/use-nutrition.test.jsx src/lib/nutrition/ui-session.test.js src/lib/nutrition/ui-service.test.js src/lib/pt-br-locale.test.js src/lib/locale-coverage.test.js --maxWorkers=2 --reporter=dot
npm run build
node scripts/check-locales.mjs
```

Manual browser check remains: at 320/390/768/1,280 px, in light and dark themes,
inspect a day with no targets, calorie-only targets, zero targets and exceedances.
Check readable wrapping, no horizontal overflow, 2/4 indicator columns and clear
wording without relying on color. Repeat nutrient selection in history. No installed
Firefox/Chromium executable was available for a visual check during this change.

## Search-field event regression

The Firefox trial exposed `TypeError: query.trim is not a function` in Journal.
`query` starts as `''` and is not received via props or read from storage. The
shared `SearchField` forwards the input's React change event to its `onChange`
handler (the same contract as `TextField`). Passing `onChange={setQuery}` put that
SyntheticEvent object into string state on the first keystroke. Filtering then
called `.trim()` on the event. An empty catalogue could temporarily hide this
because the filter callback was never called; a catalogue containing a food,
recipe or recent snapshot exposed the crash. This is a handler-contract error,
not invalid stored food data or a Firefox-specific conversion problem.

The same misuse occurs in Library, shared by personal foods and recipes. Both
search fields also lacked `onClear`, leaving the shared clear button ineffective.
The correction extracts `event.target.value` synchronously in those two
consumers and supplies `onClear={() => setQuery('')}`. The common UI component's
contract and the string-only search/filter logic stay intact; no coercion of
events with `String(query)`, silent fallback or weaker validator is appropriate.
History and backup selects use the Nutrition `Select` wrapper, which intentionally
passes a string. Decimal/TextField/date/checkbox/file handlers extract the appropriate
value, checked state or selected file. Their setter handlers are compatible and
require no change. Goals and recipe editors do not contain another SearchField.

Regression tests exercise the real Journal and Library through NutritionScreen,
with the real search input and durable Nutrition service. They cover typing,
case/accent-insensitive filtering, whitespace, brand/recipe lookup, no matches,
clear-button clicks and manual deletion to an empty input, then a durable entry
addition. The real-App guest journey also searches and adds an entry after
Home → Nutrition → Journal, returns through Home, and verifies the saved entry
without any server publication. No Journal/SearchField/store service is mocked.
IndexedDB and HTTP are simulated browser I/O; a physical Firefox trial remains
necessary and is not replaced by happy-dom tests.

Validation on Node 22.23.3 / npm 10.9.9:

* Before the handler fix, the three new Journal/Library cases failed with
  `query.trim is not a function` at Journal:59 / Library:14. Both extended real-App
  journeys also failed after the ErrorBoundary replaced the crashed journal.
  That reproduction used `-t search`: 5 selected failures, 19 other cases unselected.
* The first full two-file run after the fix had 23 passes and one new test assertion
  occurring before the journal's asynchronous reread finished. Storage already held
  the correct entry. The test now waits for the rendered 190 kcal before asserting
  them, retaining both the durable-record and displayed-total checks.
* Final targeted regressions: **168 passed in 15 files, 0 failed, 0 skipped**,
  13.71 seconds. This includes the 24 Nutrition-screen/real-App cases, shared UI
  components, tab navigation, API handling, guest policy, training persistence/sync,
  and Nutrition command/session/account integration. These counts are one run,
  not a sum of overlapping executions. Existing asynchronous React `act` warnings
  remain in some older component tests; both actual-App journeys assert zero
  console/render errors.
* Separate final focused rerun, `npm test -- src/views/Nutrition.test.jsx
  src/App.guest.test.jsx --maxWorkers=2 --reporter=dot`: **24 passed in 2 files,
  0 failed, 0 skipped**, 7.14 seconds. These are already included in the 168-case
  regression run, not additional distinct tests.
* `npm run build`: passed in 2.13 seconds, with the existing large-chunk and
  ineffective-dynamic-import warnings. `node scripts/check-locales.mjs`: 18 locales,
  2,428 keys each, synchronized. `git diff --check`: passed.

```sh
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
npm test -- src/views/Nutrition.test.jsx src/App.guest.test.jsx src/App.scroll.test.jsx src/App.no-tabs.test.js src/components/TabBar.test.jsx src/components/ui.test.jsx src/lib/guest.test.js src/lib/api.test.js src/store/useStore.config.test.jsx src/store/useStore.sync.test.jsx src/store/useStore.sync-status.test.jsx src/store/persistence.test.js src/lib/nutrition/use-nutrition.test.jsx src/lib/nutrition/ui-session.test.js src/lib/nutrition/ui-service.test.js --maxWorkers=2 --reporter=dot
npm run build
```

Manual Firefox check: Home → Nutrition → Add food. Type part of a known food or
recipe name, try a query with no matches, click Clear and delete the text with the
keyboard. Select a result, enter its quantity, save and return through Home. The
entry and totals must remain visible, with local-only status for a guest and no
ErrorBoundary fallback. Repeat search/clear in Personal foods and Recipes. No
API, portable data, storage, sync or shared form-component contract is modified.

## Guest-entry regression and development API

The first browser trial through an SSH tunnel reproduced a black screen after
`Continue without account`: Shell evaluated the new Nutrition route's Suspense
fallback, `t('Loading…')`, without importing `t`. Route elements are constructed
when the authenticated/guest branch renders, even when Home is the selected route.
The exception was in Shell itself, outside its child ErrorBoundary. The correction
imports the existing translator from `lib/i18n.js`; the existing `useLang()`
subscription continues to update translations. No auth or guest policy is changed.

`App.guest.test.jsx` renders the actual App/HashRouter/Shell/Login/Home and lazy
Nutrition route, with the real store and API client. Browser HTTP is simulated as
502 HTML or an offline fetch rejection, and IndexedDB uses the existing transactional
test model. It clicks the French guest button, checks Home and the tab bar, opens
Nutrition, creates a personal food and revisits it through Home. It checks that
guest writes stay local and that neither a server publication nor a false synchronized
message occurs. This is a component integration test, not a real browser/device test.
An additional real-App test verifies that a successful `allow_guest: false` config
still revokes a previously saved guest entrance; API unavailability does not weaken
that explicit policy. Each test invalidates the account-bound Nutrition singleton
as well as unmounting React, so the next test cannot reuse the previous simulated DB.

Validation of this correction on Node 22.23.3 / npm 10.9.9:

* Removing just the translator import made both new guest-path cases fail with the
  reported `ReferenceError` at Shell/App.jsx:223 (before the policy case was added).
* With the import restored, `npm test -- src/App.guest.test.jsx --maxWorkers=1
  --reporter=verbose`: **3 passed, 0 failed, 0 skipped**.
* Targeted regressions below: **120 passed in 13 files, 0 failed, 0 skipped**,
  12.85 seconds. The 3 new cases are included in that count, not added twice.
  Some existing tests emit React `act` warnings; the new guest cases explicitly
  assert that no render error/console error occurs.
* `npm run build`: passed in 2.00 seconds, retaining the existing large-chunk and
  ineffective-dynamic-import warnings. `node scripts/check-locales.mjs`: 18 locales,
  2,428 keys each, synchronized. `git diff --check`: passed.
* A temporary lexical-reference audit using the installed Babel parser/types
  first examined 16 production UI modules and reported only Shell's missing `t`
  before the fix. The expanded pass examined 39 changed or new production frontend
  modules (including locales), with no unresolved references afterward. This focused
  review is not a general type checker; no dependency was added.
* No API/server source or proxy configuration was changed. No live HTTP or physical
  browser/device validation is claimed here. `ss -ltn` was denied by the sandbox
  (`Cannot open netlink socket: Operation not permitted`), and this session has no
  API_TARGET/API_ORIGIN override; it cannot establish the environment or running
  backend of the user's separate VPS terminal. Use the curl checks below there.

```sh
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
npm test -- src/App.guest.test.jsx src/App.scroll.test.jsx src/App.no-tabs.test.js src/components/TabBar.test.jsx src/lib/guest.test.js src/lib/api.test.js src/store/useStore.config.test.jsx src/store/useStore.sync.test.jsx src/store/useStore.sync-status.test.jsx src/store/persistence.test.js src/views/Nutrition.test.jsx src/lib/nutrition/use-nutrition.test.jsx src/lib/nutrition/ui-session.test.js --maxWorkers=2 --reporter=dot
npm run build
node scripts/check-locales.mjs
```

The `/api/config` and `/api/me` 502 responses are a separate upstream/environment
problem. Vite proxies `/api` to `API_TARGET` (default `http://127.0.0.1:3000`) and
sets Origin to `API_ORIGIN` (default `http://localhost:8080`). The Node API defaults
to PORT 3000, ORIGIN `http://localhost:8080`, and DATA_DIR `/data`. Starting it with
those defaults is inappropriate for a disposable development trial. Missing config
allows guest entry unless the API has positively answered `allow_guest: false`;
an unavailable API must not lock out local guests. Backend availability is not a
prerequisite for local guest Nutrition, but IndexedDB must support strict durability.

For an isolated trial, use separate terminals and a new private development directory:

```sh
# VPS: standalone development API; no production service or production data changes.
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/api
dev_data=$(mktemp -d /tmp/opengym-dev-api.XXXXXX)
PORT=3001 DATA_DIR="$dev_data" ORIGIN=http://localhost:5173 RP_ID=localhost COACH_DISABLED=1 npm start
```

```sh
# VPS: restart Vite so the proxy environment takes effect.
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
API_TARGET=http://127.0.0.1:3001 API_ORIGIN=http://localhost:5173 npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

```sh
# Local computer; replace VPS_HOST with the existing SSH target.
ssh -N -L 5173:127.0.0.1:5173 VPS_HOST
# Open http://localhost:5173. Check the proxy and standalone API from the VPS:
curl -i http://127.0.0.1:3001/api/config
curl -i http://127.0.0.1:5173/api/config
```

Use unoccupied development ports. The API's existing `server.listen(PORT)` does not
restrict its listening address to loopback: these commands do not add firewall rules
or promise that port 3001 is private. Use the VPS's existing access restrictions;
do not expose this disposable backend publicly. The generated directory is new,
contains only development data, and is not deleted by these instructions. Stop the
foreground dev processes with Ctrl-C. `/api/me` returning 401 before sign-in is
normal; `/api/config` should return 200. A tunnel must forward the same local port
used in ORIGIN for passkey/auth testing. Vite's proxy variables are process environment
settings, not a reason to modify application auth, CSRF guards or production compose.

## Integration decisions and invariants

The existing five-tab training navigation stays in place. Home links to `/nutrition`;
Nutrition has its own journal, foods, recipes, goals, history and backup sections. The
route is lazy-loaded. No Nutrition records are added to the training `S` or its sync.
Shared buttons, fields, grouped sections, theme variables and LineChart are reused.
Editors are inline forms: a semantic form, focus on opening, a cancel action, and no
additional global sheet/focus/history implementation.

The UI adapter owns an explicitly scoped local store, the existing Nutrition sync
coordinator and backup service. Authenticated scopes use the existing user id and
canonical server origin; local guests have a separate durable random profile id.
Device identity is durable and generation is `generation-1`. Signing in never silently
adopts guest records. An epoch changes on identity/session changes, including ABA.
Closing an old scope never deletes its data or pending operations.
The first product UI standardizes its local generation as `generation-1`; arbitrary
stores created previously by scripts under other profiles/generations are not silently
adopted. Their validated Nutrition backup can be imported explicitly. A remote scope
or generation mismatch remains an error, never an instruction to reset server data.

Portable v1 namespaces distinguish server **origins**, not deployment subpaths. Two
installations on the same origin with the same account id would otherwise share local
Nutrition data. The separate installation root binds each v1 scope to a hash of the
normalized API base (including its mount path). A different mount is refused, without
deleting data or changing v1. Legacy unbound data cannot be adopted from a subpath;
an explicit transfer/scoping decision is required. A fresh empty mounted installation
can bind, and the original root deployment can retain its legacy scope. Bindings use
the same atomic CAS, contain no credentials/raw paths, retain installation ids and
cap at 1,024. This conservative refusal means two matching-account installations under
one origin cannot both be used under that local scope; use distinct origins/accounts
or a future explicitly reviewed transfer. Do not reset installation identity to bypass
the protection. This is preferable to silently assigning existing history/outbox to
an unrelated deployment.

Daily and history reads use `readDay`/`readPeriod`, with the existing bounded cache.
Library reads need a new, equally validated progressive reader: the former interface
only exposed journal reads or the entire graph. Headers plus selected library partitions
are verified at one paired root. A partial read is never advertised as full verification.
Writes still use full graph validation and CAS: this deliberate cost preserves historical
snapshots, tombstones, conflict archives and durable offline checkpoints. A form carries
its original record; changed/deleted records are refused rather than blindly overwritten.

Calculations come exclusively from calculate.js/recipe.js. Unknown values remain unknown;
zero is a value. Dates are explicit local calendar days, not derived from UTC timestamps.
Goals cover inclusive periods. Multiple applicable goals require explicit user selection
through editing their periods; the dashboard must not choose arbitrarily.

Backups are Nutrition-only. Preview is read-only and restore uses the existing opaque
capability, session guard, preparation journal and publication CAS. Global restoration
stays unavailable. Download/share initiation does not prove external file conservation.

## Components and public APIs

`views/Nutrition.jsx` owns date/section in URL search parameters. The lazy route is
precached by the existing service-worker lazy-assets mechanism. Home adds one entry
card; the five tabs, workout navigation guards and global sync banner remain. Nutrition
status is separate, never inferred from the training banner.

`views/nutrition/` contains Journal/EntryEditor, Library, Editors (food/recipe/goal),
Goals, History, Backup, Conflicts and common presentation helpers. Shared Button,
TextField, SearchField, theme/card CSS and LineChart are reused. Labelled native selects
keep inline forms keyboard-accessible without a new global sheet. Shared NumberField
sanitizes input for training; Nutrition instead parses TextField strings strictly, so
negative/malformed input fails instead of becoming another number. Domain validators
remain authoritative. No dependency is added.

* `ui-service.js`: strict decimal parsing, compatible units, accent/case search,
  inclusive goal selection, calendar-day summaries, stable library/day/period capture,
  and `createNutritionCommands({store,guard,newId})`. Commands expose `save/remove/batch`.
  Each edit carries its original record. CAS rebases at most three times; changed or
  deleted records require review. Field clocks cover intentional edits and preserve
  existing clocks/metadata. New records append to monthly/library shards only after
  the 512 KiB encoder capacity check. Unknown metadata remains intact, including
  ingredient/quantity extensions and JSON-own `__proto__` fields (null-prototype field
  clocks prevent prototype pollution). Replaying an already-achieved exact edit is
  a no-op, without another publication; an incompatible stale edit remains refused.
* `ui-identity.js`: `nutritionInstallationIdentity()` persists random profile/device
  ids in a separate checksummed installation root through physical IDB/private JSON
  CAS. Competing initialization reads the winner. Corruption refuses a new identity;
  no volatile fallback strands native files after WebView localStorage eviction. The
  existing Java/Swift headers/publication methods support this root without changes.
  Optional server binding protects origin-only v1 scopes against mounted deployments.
* `ui-session.js`: `createNutritionUISession()` owns commands, Nutrition sync/backups;
  exposes `day/library/period`, `save/remove/batch`, `synchronize/refresh`,
  `export/preview/restore`, `conflicts/recovery`, `assertCurrent`,
  `subscribe/getSnapshot`, `close`. Successful durable changes advance UI revision.
  Concurrent sync calls await one result; no fabricated acknowledgements.
* `use-nutrition.jsx`: lazy lifetime bound to useStore user/server/guest identity,
  using existing `api()` cookies/Bearer/subpath/Access transport. Route unmount leaves
  deliveries alive; identity/session changes stop/close the old instance. Online/focus
  refresh; successful writes debounce a sync attempt by 800 ms. No periodic polling:
  other devices' changes arrive on opening, focus, reconnect or explicit retry. HMR
  disposes listeners without deleting data.
* `local-store.readLibrary()`: verifies library shards, references, hashes and dataset
  ids under paired-root CAS. Aggregate hydrated library JSON is capped at 16 MiB;
  cache stays 8 entries/8 MiB of estimated allocation. Hits are visited before misses
  to prevent sequential >8-shard thrashing. Partial reads never authorize writes/GC.

## Operational journeys

Journal logs foods/recipes, edits quantity/category/note, confirms deletion and shows
engine-derived kcal/protein/carbs/fat and remaining/exceeded targets. Unknown intake
shows known subtotals without pretending completeness; zero differs from absent values.
Macro distribution is explicitly 4/4/9 energy. Search includes library foods, recipes,
current-day and last-30-day actual entries, loaded only on opening the picker. Results
cap at 100 with a request to refine search. No remote catalogue or fake seed data.

Foods support eight nutrients, g/ml references, explicit density, named portions and
optional default logging quantity. Recipes contain food snapshots, not recipes, and
editable servings/measured cooked g/ml. Editing/deleting library entities never rewrites
logged snapshots; removed foods can remain ingredients. Optional form fields use null
instead of erasing a top-level field. Goals support custom/maintenance/bulk/cut and
inclusive periods. Overlap is reported, never silently resolved into one target.

History reads seven days or the calendar month on demand. Each day lists goals/intake
and links to the journal; charts use existing LineChart for one nutrient. Averages
exclude unlogged/unknown days; segments do not bridge gaps. Day lists are the accessible
alternative. Date ids are local calendar days and never move with travel time zones.
Chart presentation timestamps use local noon to match the reused LineChart's local
tick formatter; UTC noon incorrectly shifted labels in UTC+14. Period arithmetic stays
in UTC over calendar ids, and tooltips retain explicit ids. A component regression
checks the UTC+14 ticks. Unusual historical zone calendar jumps still need manual
inspection with the shared date formatter; persisted ids are never rewritten.

Preserved versions load only on request through bounded full graph reads. Recognized
food/recipe/entry/goal variants can be inspected and copied under a new id. Archives
and tombstones are never pruned or resurrected in place. Copying does not mark a
conflict resolved. `sync-merge.js` remains the only merge algorithm, with no mutable
resolution extension. Status flags conflicts discovered in that lifetime; older
versions remain accessible even after reopening a session.
An archive-copy retry retains its chosen new id until a successful response. If the
first local write committed but its response was lost, the next attempt is the command
service's exact-value no-op rather than another journal entry. This protects retries
while that screen remains mounted; reopening and intentionally copying again remains
a new user action. It does not provide a persistent copy receipt or resolve the archive.

## Backups and recovery

Nutrition-only export reuses existing guarded download/native share. File input feeds
deep preview, available-space estimate, conflict choices and opaque restore capability.
Legacy workout files direct users to Settings; global archives explicitly select only
Nutrition. Global restoration remains blocked. Empty/merge/explicit replace modes are
available. Changed choices require another preview; mode/input changes disable during
preparation. Exact file/mode/choices derive a stable restore id; copy ids also derive
deterministically from backup/key. Preview cannot write data.

Restore cancels the coordinator, retains frozen deliveries and publishes with the
existing preparation/completion journal. Late reports cannot overwrite restore status.
The next sync replays frozen requests before new restored changes. Stale previews must
be rebuilt. Backup shows unfinished preparation status: select the same file/options
to retry, or review a new preview if data changed. No automatic rollback/queue removal.
No eager full-history recovery scan is added to daily opening; recovery details load
when entering Backup. Additional source tombstone/retention rules remain those of 2.5.
Backup and preserved-version screens do not depend on a successful progressive library
read. This keeps export/restore recovery accessible if library loading fails or reaches
its separate 16 MiB limit. The existing full backup/conflict validators still refuse
unsafe or oversized operations; access to these screens grants no recovery bypass.

Export guards run again before browser/native hand-off. Once OS sharing/downloading
starts the app cannot revoke it or prove external saving. Native selection/share
depend on the actual WebView/OS and need physical tests. No new native plugin/package.
Export/restore limits remain those documented in NUTRITION_BACKUP_RESTORE.md.

## Accessibility and localization

Semantic inline forms associate labels, focus the first field, restore surviving
invokers (or the Nutrition heading when an invoker disappears) and allow Escape
cancellation. Buttons have >=44px touch areas, meaningful
labels, busy states and visible focus. Errors use role=alert; saves/sync/loading use
role=status. Counts/remaining/exceeded text conveys meaning without color. Columns
collapse at 600/360px; actions/headers/navigation and long names wrap. Existing app
safe-area/tabbar layout remains; no new modal or focus trap.
Muted text uses a stronger theme-relative mix and secondary button text uses the
label color rather than an arbitrary accent. Measured contrast and actual rendering
still require browser/manual checks; these CSS choices alone do not certify them.

All UI strings use existing i18n. English is source; French additions are development
translations needing human review. The other 17 packs retain English for new strings
explicitly pending locale review; their existing translations remain unchanged. All
18 packs share keys/placeholders. This is not complete human-reviewed translation in
every language. Numbers/dates use dateLocale; decimal comma is accepted. Server errors
are reduced to useful generic messages, never raw auth data or sensitive payloads.

## Critical review findings

1. Functional: stale forms refused, zero/unknown distinct, immutable snapshots tested
   after food/recipe edits/deletion; defaults exposed so removing a referenced portion
   can clear/change its default. Archived entry values now scale actual consumed
   quantity through the engine instead of showing batch values.
   Unknown ingredient draft fields and quantity metadata, including default logging
   quantities, now survive form edits; regression tests exercise all three paths.
   History stops at its requested final day and date navigation clamps to the v1
   year range 0001–9999; boundary dates no longer produce extended ISO years or a
   rendering error in seven-day history.
   Removed default portions now display an explicit incompatible-unit option until
   the user selects a compatible unit or clears the default, rather than visually
   falling back to g while the draft still references the deleted portion. Validators
   continue to refuse the invalid draft; no approximate conversion is invented.
   Backup/preserved-version routing no longer waits for the library: failed partial
   reads cannot hide validated recovery/export services. A UI regression exercises
   actual export with an unavailable library reader.
   Draft density now uses the same strict decimal-comma parser as saving, so `1,1`
   exposes supported g/ml default units immediately instead of requiring a save/reopen
   or a decimal point. Invalid drafts never enable an invented conversion.
   Shard capacity now measures the complete new field clocks/revision/write id before
   selecting a partition. A regression fills the old shard to within 16 bytes of the
   sparse-marker limit and proves the new record moves to another shard with all
   existing data preserved. Existing records that grow beyond a document limit still
   fail safely; this does not introduce an unreviewed relocation of historical ids.
2. Concurrency: requests now await the same sync promise; restore epochs suppress late
   reports; old services disappear immediately on identity change, including slow opens.
   Native identities moved out of WebView localStorage. Post-publication inspection
   failure no longer reports an already durable save as failed creation. Backup choices
   invalidate application until renewed preview; mode controls disable during preparation.
   Origin-only namespaces now refuse ambiguous server mount changes using a durable
   installation binding, rather than changing v1 or transplanting pending operations.
3. UX/maintenance: selected library/day/month heads compared; cache hit ordering avoids
   thrashing; recent search bounded/on-demand; editor completion ignored after unmount.
   There is no automatic history purge. Real visual, contrast, screen-reader and native
   checks remain manual, distinct from simulations.
   Locale subprocess tests now explicitly throw `spawnSync.error`. The sandbox returns
   `EPERM` with an empty output but a misleading zero status: one exit-only case used
   to appear successful without running its checker. Hardening the existing harness
   makes that unavailable execution fail visibly too; no test is skipped or weakened.

No automatic collection is scheduled by the UI. The existing validated collector is
available at storage level; unused immutable objects may consume additional disk until
explicit maintenance. No age-based purge of checkpoints, conflicts, tombstones or
history is introduced. Retained conflict metadata may reach partition limits; writing
then fails safely rather than trimming history. Future maintenance must preserve the
existing pending/reachable-object proof, especially for devices offline for years.

## Ten-year performance — 2026-10-11

Debian, Node 22.23.3; disposable private JSON simulator with real fsync/rename; one
process with explicit GC between observations. 10,959 entries, 130 partitions, 200
personal foods, 100 recipes, 120 tombstones and two offline checkpoints. No React
render, real browser IndexedDB or native-device timing is claimed. Library has ten
shards, more than the bounded cache can retain simultaneously.

| Operation | Time | Document reads | Heap before → after |
| --- | ---: | ---: | ---: |
| Cold day + library + engine indicators | 253.54 ms | 11 | 6.16 → 10.84 MiB |
| Warm day + library | 176.94 ms | 4 | 6.54 → 7.49 MiB |
| Cold month + library | 275.43 ms | 11 | 6.36 → 14.12 MiB |
| Full verification including outbox | 3.05 s | 131 | 6.80 → 12.34 MiB |
| One entry edit, complete validation/publication | 26.97 s | 262 | 6.62 → 99.25 MiB |

RSS began around 207.5 MiB after fixture construction and reached 224.07 MiB after
editing; process peak 233.49 MiB includes construction. These are endpoints, not peak
heap or latency percentiles. Opening avoids full history reconstruction. **Writes
still validate the complete current/retained graph**, a significant latency/CPU limit
for ten-year histories. Busy/error states prevent duplicate submits, but long writes
are not instant or off the main thread. The targeted write-performance review below supersedes the write timings and removes
redundant reconstruction. Reviewed worker/incremental execution remains future work;
integrity, receipts and pending history still authorize every publication. UI refresh itself only reloads selected views.

## Reproduction and manual validation

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
npm test -- src/views/Nutrition.test.jsx src/lib/nutrition/ui-service.test.js src/lib/nutrition/ui-session.test.js src/lib/nutrition/ui-identity.test.js src/lib/nutrition/use-nutrition.test.jsx src/lib/nutrition/local-reader.test.js src/lib/nutrition/backup-file.test.js --maxWorkers=2 --reporter=dot
npm test -- src/views/Nutrition.test.jsx src/lib/nutrition/use-nutrition.test.jsx --maxWorkers=2 --reporter=dot
npm test -- src/lib/nutrition/ui-service.test.js src/lib/nutrition/ui-session.test.js src/lib/nutrition/ui-identity.test.js src/lib/nutrition/local-reader.test.js src/lib/nutrition/backup-file.test.js --maxWorkers=2 --reporter=dot
npm test -- src/lib/nutrition --maxWorkers=2 --reporter=dot
npm test -- --maxWorkers=2 --reporter=dot
node scripts/check-locales.mjs
node --expose-gc scripts/nutrition-ui-benchmark.mjs
npm run build
VITE_MOBILE=1 npm run build -- --outDir /tmp/opengym-nutrition-ui-mobile
cd ..
git diff --check
```

The mobile web command intentionally stops before `cap sync` and media staging. It
does not compile a native app or validate Android/iOS packaging. Validate the built
mobile tag/resources using `checkCopy('/tmp/opengym-nutrition-ui-mobile')` from
`frontend/scripts/check-mobile-bundle.mjs`; use the repository's full mobile workflow
only in the appropriate native build environment.

Strict HTTP checks to reproduce outside the sandbox (temporary test data only):

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/api
NUTRITION_REQUIRE_HTTP_TESTS=1 node --test test/nutrition-http.test.js test/server-nutrition.test.js
node --test test/nutrition-backup-history.test.js
# Optional full unchanged API regression suite, including workout synchronization:
npm test
```

### Recorded executions

Node 22.23.3 / npm 10.9.9, installed lockfile dependencies reused. Separate runs
below overlap; their counts must not be added together.

| Execution | Result | Notes |
| --- | --- | --- |
| Seven focused UI/service/reader/file test files | 76 passed, 0 failed, 0 skipped; 9.49 s | Includes density-comma, complete 512 KiB capacity, recovery access, UTC+14 and lost-copy-response regressions |
| Components + actual account hook | 21 passed, 0 failed, 0 skipped; 8.32 s | Happy-dom, actual service/storage adapter; not browser E2E |
| Five focused service/identity/reader/file test files | 55 passed, 0 failed, 0 skipped; 5.19 s | Unit/integration simulations, including actual temporary private JSON writes |
| Nutrition library + Nutrition screen, earlier run | 541 passed, 0 failed, 0 skipped; 281.31 s | Before the final five UI and capacity regressions; existing ten-year history, backup, crash, queue and synchronization checks |
| Final complete frontend | 5,602 passed, 7 failed, 0 skipped; 427 files; 473.21 s | Only `scripts/check-locales.test.mjs` fails: all seven child launches are denied with `spawnSync EPERM`; no Nutrition/workout test fails |
| Hardened locale subprocess tests | 0 passed, 7 failed, 0 skipped; 742 ms | All seven fail with `spawnSync EPERM`; unlike the old harness, no false positive on a zero status |
| Direct locale checker | Passed: 18 locales / 2,428 keys each | Key/placeholder consistency, not translation quality |
| Web build | Passed; 3.86 s | Existing dynamic-import and large-chunk warnings remain |
| Mobile-flavor web build | Passed; 3.89 s; checkCopy passed | No native compilation, cap sync or physical validation |
| API backup history | 6 passed, 0 failed, 0 skipped | Server evidence/receipt/tombstone protections |
| Strict Nutrition HTTP/interruptions | 10 passed, 1 failed, 0 skipped | Failure: loopback HTTP upload/publication/read, `listen EPERM`; SIGKILL recovery cases passed |
| Strict server Nutrition HTTP | 0 passed, 4 failed, 0 skipped | All four denied loopback listening by sandbox (`EPERM`) |

React component executions can emit `act(...)` warnings for background updates; these
are not suppressed and do not establish browser/rendering accessibility validation.
A direct diagnostic of `spawnSync(process.execPath, ...)` reports `EPERM` with empty
output and status zero.
These tests cannot launch their checker in this sandbox; the strengthened harness
reports all seven failures instead of six plus a false positive. The direct checker
succeeds. Do not disable them: rerun the full command over SSH to validate the
child-process path.
These sandbox executions were not completely green: seven frontend checker cases and
five real-loopback API cases required execution outside the sandbox. All are reported as failed,
not skipped. No browser E2E, visual contrast certification or physical native durability
validation is claimed. The implemented journeys are ready for functional review;
large-history write latency and the manual checks below remain release limitations.

No browser executable was found. Happy-dom tests use actual services and transactional
simulations, not browser E2E. API sources are unchanged; service simulations use the
actual server store. HTTP checks require SSH when sandbox loopback is forbidden.

Use disposable profiles: 320/375/768/1024/1440px, light/dark/RTL, keyboard/screen reader,
virtual keyboards/safe areas, long names/decimal comma; two tabs with concurrent edits
and deletes; close during writing; switch accounts during fetch/export/restore;
reconnect after lost POST, checking receipt-only queue drain. Test real IDB strict
durability/quota/eviction, foods/defaults/recipes/goals, invalid/conflicting backups,
confirmed replacement and legacy files. Follow MOBILE.md for native builds; verify
installation ids after WebView storage eviction, private files, picker/share cancellation,
OS termination and reopen on Android/iOS. No production data. Simulations do not prove
power-loss durability. No Android/iOS compilation or physical trial is claimed.

Future catalogue integration supplies validated Food records with source/license
provenance to the existing picker/library. No OFF or scanner is implemented.

## Targeted write-performance review — 2026-10-11

The existing ten-year write observation is the baseline, not a network-sync timing.
The benchmark now records nested `readForRestore`/`commit` durations and physical
backend calls. `NUTRITION_CPU_PROFILE=/tmp/write.cpuprofile` enables Node's built-in
sampling profiler **only around the entry edit**; `NUTRITION_BENCHMARK_OUTPUT` selects
an output report. No production data is opened and no dependency is added.

Code inspection and the profiles identify repeated work:
restore byte capture decodes the graph before recovery; recovery first migrates and
hydrates, then decodes and hydrates the same committed v1 partition. Any optimization
must retain complete validation of current, queued and staged-delivery graphs,
resource limits, caller capture before awaits, paired-root read guards, final root
CAS, immutable publication and pending-operation preservation. Progressive UI cache
hits remain insufficient evidence to authorize a mutation. No storage-format change
or incremental-authorization architecture is planned in this review.

Baseline sampled profile: the edit took 28.02 s (profiling enabled). Descriptor-based
JSON inspection accounts for about 14.51 s of self samples; canonical encoding about
7.90 s including its property callback, GC 0.79 s. Nested stage timers report 10.24 s
for command capture/recovery and 16.84 s for commit. Backend document-read calls take
0.16 s, durable publish 0.014 s and index publication 0.005 s. These nested/inclusive
figures overlap and must not be added. Hash-job self samples are about 0.049 s; CPU
cost in `contentHash` is mostly canonical encoding, not SHA-256 itself. This points to
repeated descriptor traversal and hydration, rather than disk or network latency.

The first optimization keeps physical read counts unchanged (262 for the edit):
`decodePartitionDocument` returns both validated portable and hydrated data in one
pass, with independent snapshots. Existing `decodePartition` and `migratePartition`
retain their signatures/behavior. Private hydration copies an already descriptor-
validated JSON tree, without executing getters/toJSON; public inputs still use the
original strict canonical capture. Restore byte capture remains guarded and bounded;
complete recovery now performs its sole authoritative decoding immediately afterward.
Commands own that fresh reconstruction and no longer make a second full-history copy.
There is no persistent validation cache or root-only authorization fast path.

Concurrency review found a pre-existing boundary: independent command services sharing
one reader could fail with `read_invalidated` during capture, before reaching the
commit-only retry handler. The retry now encloses the whole attempt, at most three
captures; it handles only stale-root/read-invalidated errors and rechecks the original
form base. Same-record edits still require explicit conflict handling. Regression
coverage includes shared-reader and separate-backend commands, frozen queues, damaged
unrelated history despite warm cache, and all four durable JSON mutation phases.

The optional Node-only `scripts/nutrition-write-profiler.mjs` instruments stage calls
without changing shipped code. Its nested timings overlap. Run it with `--import`;
`NUTRITION_BENCHMARK_SYNC=1` additionally uses an isolated real server store through
direct service calls (no HTTP transport or authentication benchmarking). Writes finish
locally before that separate synchronization measurement. The corpus reports its
source manifest digest so matching before/after runs can prove identical portable input.

The synchronization diagnostic explicitly separates `readDocuments` body counts from
physical file reads: the coordinator still uses eager backend snapshots, which the
old UI read counter did not count. `physicalDocumentReads` includes manifest/header,
snapshot and immutable-publication reads. Full initial sync of two retained checkpoints
performs 131 uploads and two publications, not merely one changed-entry request.
Only source-equivalent scopes/manifest digests may be compared with one another.

Integrity review correction: recovery must validate **all** pending-only extensions,
including backup preparation/receipt/tombstone metadata, not only sync-conflict maps.
The old preliminary scan happened to supply the extra check for `readForRestore`;
removing its duplicate hydration requires carrying that check into recovery explicitly.
A correctly checksummed pending-only document with unsupported backup metadata now
blocks capture and commit; it is never treated as a writable verified state.

### Final before/after comparison

User-provided pre-review VPS validation: 5,609 frontend cases / 427 files passed;
15 targeted HTTP cases passed; 18 packs / 2,428 keys checked. Those results precede
these shared-core changes and do not replace their regression checks below.

Uninstrumented edit measurements, no concurrent tests/benchmarks, separate Node
processes on the same Debian 13 VM (Linux 6.12.57+deb13-cloud-amd64, AMD EPYC-Rome,
4 visible CPUs, Node 22.23.3/npm 10.9.9). Real fsync/rename in the disposable native-
protocol simulator; not physical Capacitor, browser, or network latency measurements.
The corpus is unchanged: 2016–2025, 10,959 entries, 130 partitions, 200 foods,
100 recipes, 120 tombstones, two checkpoints. Source manifest SHA-256 matches in
both reports: `ecf688bc3af5cf0bb98c96ea67cd1d6099873c2fda08f32ce8717aafeaab1ecf`.

| Operation | Before | After | Partition-body reads before / after |
| --- | ---: | ---: | ---: |
| Cold day + library + indicators | 268.40 ms | 250.44 ms | 11 / 11 |
| Warm day + library | 150.25 ms | 160.43 ms | 4 / 4 |
| Cold month + library | 334.02 ms | 290.84 ms | 11 / 11 |
| Full verification, outbox included | 3,168.96 ms | 2,291.04 ms | 131 / 131 |
| Intentional entry edit | **27,317.46 ms** | **9,193.90 ms** | **262 / 262** |

The edit is 2.97 times faster, a 66.34% latency reduction in this observation. This
is one paired observation, not a percentile/median/SLA. The initial independently
repeated baseline was 26,927.64 ms, close to the earlier 26,965.89 ms UI benchmark.
Warm-read differences at this scale are not evidence of a systematic improvement.
The broader immutable document counter is 270 / 270 for the edit, including manifests
read by headers and existing-document checks during publication. It excludes root,
previous-root and index files; it is not a syscall count.

| Edit stage (nested wall times) | Before | After |
| --- | ---: | ---: |
| Command capture + complete recovery | 10,033.03 ms | 3,168.82 ms |
| Remaining preparation/UI bookkeeping, excluding inspect | 848.13 ms | 35.01 ms |
| Commit, including second complete recovery and publication validation | 16,429.70 ms | 5,982.17 ms |
| Backend document-read calls, included above | 158.31 ms | 160.67 ms |
| Durable backend publication, included above | 8.85 ms | 8.80 ms |
| Derived-index publication, included above | 2.63 ms | 3.02 ms |

The stage-instrumented authenticated-scope run independently records 1,047 → 395
hydrations, 1,212,776 → 388,613 JSON inspections and 195,549 → 3,593 canonical encodings
for the edit. The removed work inspected the same private immutable values repeatedly;
all public captures, document/snapshot checksums, domain validators, dataset identity
checks, retained versions, history preservation and CAS guards remain in force.

**Memory is not improved consistently.** For the uninstrumented edit, endpoint heap
is 6.16 → 82.63 MiB before, 7.10 → 91.79 MiB after; RSS 199.21 → 210.07 MiB before,
212.93 → 225.64 MiB after. Process peak RSS, including corpus construction, is
218.95 MiB before and 233.82 MiB after. These are single-process observations subject
to V8 allocation/GC scheduling, not peak-heap/retained-heap or browser guarantees.
The removal of redundant copies does not justify claiming a lower measured RSS.

Separate stage-instrumented synchronization runs use identical authenticated source
manifest `21b4b2c6ab937307f598fefa681d123312796b4f6692ff62a267dc3ac3dc1cb0`.
Both use the real isolated server store via direct calls: 397 calls, 131 uploads,
two publications and durable acknowledgement of both checkpoints. No HTTP auth,
rate limiting, worker scheduling, or network latency is measured by this transport.

| Initial two-checkpoint synchronization | Before | After |
| --- | ---: | ---: |
| Complete coordinator time (instrumented) | 253,394.00 ms | 144,088.96 ms |
| Time in server calls, included above | 24,312.11 ms | 18,861.15 ms |
| Endpoint heap before → after | 6.39 → 472.97 MiB | 6.38 → 316.33 MiB |
| Endpoint RSS before → after | 212.11 → 582.29 MiB | 218.07 → 624.27 MiB |
| Whole-process peak RSS | 590.70 MiB | 649.17 MiB |

Nested timings are diagnostic; concurrent async hash/hydration durations can exceed
elapsed wall time and must not be summed or interpreted as SHA CPU time. The original
`readDocuments` counter reports zero for this eager-sync path; it **does not mean zero
storage reads**. The updated benchmark also reports `backend.snapshot` calls and
physical immutable-document reads for future sync runs. These two recorded sync
runs preceded that counter addition, so their physical read counts are unavailable.

### Reproduction and retained evidence

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
# Normal portable write/read observation:
NUTRITION_BENCHMARK_OUTPUT=/tmp/nutrition-write-after.json node --expose-gc scripts/nutrition-ui-benchmark.mjs
# Optional nested stage timings:
NUTRITION_BENCHMARK_OUTPUT=/tmp/nutrition-write-stages.json node --expose-gc --import ./scripts/nutrition-write-profiler.mjs scripts/nutrition-ui-benchmark.mjs
# Optional sampled CPU profile (edit only):
NUTRITION_CPU_PROFILE=/tmp/nutrition-write.cpuprofile node --expose-gc scripts/nutrition-ui-benchmark.mjs
# Real temporary server, direct transport, separately timed sync:
NUTRITION_BENCHMARK_SYNC=1 NUTRITION_BENCHMARK_OUTPUT=/tmp/nutrition-write-sync.json node --expose-gc --import ./scripts/nutrition-write-profiler.mjs scripts/nutrition-ui-benchmark.mjs
```

Before-source captures remain under `/tmp/nutrition-write-baseline/` for this review:
core serialization/recovery from the confirmed HEAD, pre-optimization local reader
and commands. They contain code only. The optional profiler can load these captures
without replacing worktree files:

```sh
NUTRITION_BENCHMARK_BASELINE=/tmp/nutrition-write-baseline NUTRITION_BENCHMARK_STAGES=0 NUTRITION_BENCHMARK_OUTPUT=/tmp/nutrition-write-before-identical.json node --expose-gc --import ./scripts/nutrition-write-profiler.mjs scripts/nutrition-ui-benchmark.mjs
```

This before command requires the retained captures; `/tmp` is not permanent archival
storage. Source/corpus reports remain `/tmp/nutrition-write-before-identical.json`,
`/tmp/nutrition-write-after.json`, `/tmp/nutrition-write-sync-before.json`,
`/tmp/nutrition-write-sync-after.json`, plus sampled/stage profiles. Each benchmark
creates/cleans only its own temporary storage. Never benchmark against a user profile.

### Residual limits and proposed follow-up, not implemented

Writes remain O(all reachable history), with two guarded reads and full proposed-
graph validation. Nine seconds on this ten-year corpus remains substantial. Initial
sync still creates/reconciles full graphs and field clocks; its eager snapshots can
read unreachable versions too, and its large transient memory remains a real mobile
risk. This review does not claim to fix these architectural costs.

A separate reviewed effort could move pure validation/planning to a worker while
keeping session guards and durable backend publication authoritative. This requires
message/cancellation protocols, main/native-bridge coordination and browser/WebView
validation; it improves UI responsiveness rather than necessarily lowering latency.
Partition-scoped mutations would require trusted complete-dataset identity/clock and
retention proofs, invalidation across tabs/restores, backend transaction/CAS changes
and full corruption/crash testing on both adapter families. An index or cached day
alone cannot supply that proof. These are substantive storage/coordinator changes
requiring an architectural decision, not a safe extension of this small optimization.
No new dependency, format migration, retention expiration, training-sync change or
native-lock modification is introduced here.

### Regression executions for this review

The following runs are separate and overlap; do not sum them. No tests were disabled
or deliberately skipped. The new coverage adds 16 frontend cases and one API case.

| Execution | Result | Environment/interpretation |
| --- | --- | --- |
| Initial full frontend after optimization | 5,616 passed, 9 failed, 0 skipped; 427 files; 393.44 s | Seven locale child-process EPERM failures; two new metadata tests expected an unwrapped error code |
| Initial four focused files | 145 passed, 2 failed, 0 skipped; 60.22 s | Same test expectation mismatch; no change to validation to make them pass |
| Corrected local reader tests | 29 passed, 0 failed, 0 skipped; 1.93 s | Verifier asserts the precise unsupported metadata reason; local recovery asserts its existing exhausted-candidate `no_complete_commit` error |
| Final four focused files | **147 passed, 0 failed, 0 skipped**; 60.36 s | Serialization, recovery/publication, commands and progressive reader |
| Final full frontend | **5,618 passed, 7 failed, 0 skipped**; 427 files (426 passed, one failed); 383.32 s | All seven in `scripts/check-locales.test.mjs`: child launch `spawnSync EPERM`; Nutrition, backup, sync, UI and workout regressions pass |
| API accessible targeted run, isolation disabled for diagnostic visibility | **70 passed, 0 failed, 0 skipped**; eight files; 13.56 s | Protocol, packaging, paths/files, real durable store/worker, volume, backup metadata, legacy persistence/configuration migration |
| Strict real HTTP targeted run, same diagnostic visibility | **10 passed, 5 failed, 0 skipped**; 3.18 s | Exactly five `listen EPERM` failures: loopback upload/publication/read and four actual-server authentication/CSRF/multi-device cases; route-factory and SIGKILL recovery cases pass |
| Broader process-isolated API attempt | 39 file-level passes, 40 file-level failures, 0 skipped; 79 files; 75.36 s | Runner reports file-level results rather than individual assertions; network fixtures cannot bind in the sandbox. This is not a complete API validation; detailed diagnostics for the targeted HTTP cases are above |
| Direct locale checker | Passed: 18 packs / 2,428 keys | No locale edits in this review |
| Web build | Passed; 2.46 s | Existing large-chunk/dynamic-import warnings |
| Mobile-flavor web build + checkCopy | Passed; 2.42 s + tag/resource check | No cap sync, Java/Swift compile, emulator or device execution |
| Git diff / targeted untracked whitespace checks | Passed | No commit or push |

Regression coverage preserves JSON key/prototype safety, independent repeated
snapshots, exact re-encoding, caller capture across awaits, hydration budgets and
recomputed-checksum invalid business data. Commands exercise two backend connections,
same-record conflicts, shared-reader invalidation, all four durable JSON interruption
phases, replay after lost publication response, frozen queue retention and quota
rollback with a warm view. Current/pending-only corruption and dataset duplicates
remain rejected. Existing long-offline retention, IDB abort/concurrency, restore,
multi-device and training-persistence suites ran in the full frontend execution.

The metadata test correction is diagnostic only: recovery intentionally wraps an
unrecoverable local publication as `no_complete_commit`; the streaming verifier
exposes `unsupported_backup_metadata`. Both must reject the same pending-only graph.
The test now checks both boundaries rather than weakening or bypassing validation.

Commands used (Node 22 path as in the earlier reproduction block):

```sh
cd /home/codex/openGym/frontend
npm test -- src/lib/nutrition/persistence-commit.test.js src/lib/nutrition/serialization.test.js src/lib/nutrition/ui-service.test.js src/lib/nutrition/local-reader.test.js --maxWorkers=2 --reporter=dot
npm test -- --maxWorkers=2 --reporter=dot
node scripts/check-locales.mjs
npm run build
VITE_MOBILE=1 npm run build -- --outDir /tmp/opengym-nutrition-ui-mobile
node --input-type=module -e "import { checkCopy } from './scripts/check-mobile-bundle.mjs'; checkCopy('/tmp/opengym-nutrition-ui-mobile')"
cd ../api
# Actual repo Node test files, in-process so this sandbox exposes individual failures:
node --test --experimental-test-isolation=none test/nutrition-protocol.test.js test/nutrition-packaging.test.js test/nutrition-files.test.js test/nutrition-store.test.js test/nutrition-backup-history.test.js test/nutrition-volume.test.js test/durable.test.js test/config-migration.test.js
NUTRITION_REQUIRE_HTTP_TESTS=1 node --test --experimental-test-isolation=none test/nutrition-http.test.js test/server-nutrition.test.js
# Broader attempted runner (same suite as package script, capped concurrency):
NUTRITION_REQUIRE_HTTP_TESTS=1 node --test --test-concurrency=2 test/*.test.js
```

The in-process diagnostics do not replace the repository's process-isolated API
validation. Over SSH, rerun the official commands after these changes:

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
npm test -- --maxWorkers=2 --reporter=dot
cd ../api
NUTRITION_REQUIRE_HTTP_TESTS=1 node --test test/nutrition-http.test.js test/server-nutrition.test.js
NUTRITION_REQUIRE_HTTP_TESTS=1 npm test
```

Logs are `/tmp/nutrition-write-focused-verified.log`,
`/tmp/nutrition-write-frontend-verified.log`, `/tmp/nutrition-write-api-accessible.log`,
`/tmp/nutrition-write-api-http.log`, `/tmp/nutrition-write-api-final.log` and the
build logs. No sandbox rejection has been converted into a skipped or passing case.
Tests on physical Android/iOS, real browser IDB, peak-memory behavior, UI responsiveness
on slow devices and abrupt OS termination remain necessary. Simulation is not a
power-cut test. The optimization is ready for human review, with these release limits
and the architectural follow-up explicitly unresolved.

### Files touched by the targeted review

These are the 16 files changed in this performance pass; the Git worktree also
contains the earlier uncommitted UI implementation.

| Files | Role |
| --- | --- |
| `api/nutrition/core/serialization.js`, `api/nutrition/core/persistence-commit.js` | Single validated portable/domain decode, private copies, discard queued-only expansion after validation |
| `frontend/src/lib/nutrition/local-reader.js`, `frontend/src/lib/nutrition/local-store.js`, `frontend/src/lib/nutrition/ui-service.js` | Guarded byte capture, pending extension checks, owned mutation capture and whole-attempt conflict retry |
| `frontend/src/lib/nutrition/serialization.test.js`, `frontend/src/lib/nutrition/local-reader.test.js`, `frontend/src/lib/nutrition/ui-service.test.js`, `api/test/nutrition-protocol.test.js` | Regression tests described above |
| `frontend/src/lib/nutrition/backup.test-util.js`, `frontend/src/lib/nutrition/backup-volume.test-util.js` | Independent test connection helper; corpus derives namespace/generation from its disposable store for authenticated-scope measurements |
| `frontend/scripts/nutrition-ui-benchmark.mjs`, `frontend/scripts/nutrition-write-profiler.mjs` | Reproducible stage/sampling/memory/physical-read diagnostics and optional direct-server sync |
| `docs/dev/NUTRITION_UI.md`, `docs/dev/NUTRITION_LOCAL_STORAGE.md`, `docs/dev/NUTRITION_PERSISTENCE.md` | Decision rationale, guarantees, measurements, tests and residual limits |
