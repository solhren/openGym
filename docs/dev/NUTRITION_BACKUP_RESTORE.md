# Nutrition backup and restore (step 2.5)

## Analysis and decisions

Existing workout backups are raw state JSON (the state stored under localStorage's
`gym_state_v1`) or store-only ZIPs made by `backup-media.js` / `zip.js`. The legacy JSON
has no versioned backup envelope; ZIP media are content-addressed and checked on import.
Settings calls `useStore.importConflict/importBackup`, which uses workout restore
stamps and its existing conditional sync. Native daily backups are best-effort,
workout-only, with 14-copy retention. Their behavior remains unchanged.
Nutrition uses a different strict-durability IDB/private-files transaction, immutable
512 KiB v1 documents, permanent tombstones, frozen requests and CAS roots. These
stores do not share a transaction with localStorage or the native workout mirror.
A workout import can remain memory-only on quota failure: it cannot currently be
used as a durable participant in an atomic global restore. The conservative policy
is to support global export/inspection, and refuse global application before any
write, until a durable workout participant/journal is available. Nutrition-only
application is operational. Legacy workout files remain readable through the
existing reader, and their missing Nutrition section never means deletion.

## Invariants (established before implementation)

* Reuse v1 business, partition, dataset and conflict-archive validation.
* Capture one root plus its queued/delivery variants; a changing root aborts export.
* Never export cookies, tokens, server/account scope, delivery requests or receipts.
* Preserve complete immutable historical snapshots, deleted markers and variants.
* Imported tombstones are informational; they never authorize deleting target data.
* Import is a new local edit, not a transplanted operation or a remote acknowledgment.
* CAS against the preview head; preserve the frozen queue and unknown network outcomes.
* Default merge never selects a divergent imported value without an explicit choice.
* Replace requires explicit intent, archives prior values and affects known local data
  only. It cannot delete unknown server-only rows. Permanent deleted IDs cannot be reused.
* A receipt and all changed partitions publish together. Never delete original history
  or an unacknowledged operation to recover from failure. No time-based history purge.
* Session identity/epoch is checked before exposing export/preview and before publication.
* SHA-256 detects accidental corruption; it is not an authenticity signature.

Platform and performance results below distinguish simulations from real-device execution.

## Implemented format and public services

`nutrition/backup.js` exports `exportNutritionBackup`, `readNutritionBackup` and
`createNutritionBackup`. The account-bound service takes `{store,getSession,sync,
getWorkouts,getWorkoutRevision}`; its methods are `export()`, `preview(blob,options)`,
`restore(preview)` and `recoveryStatus()`. Workout readers are optional for Nutrition-only
backups; both are mandatory for a global capture.
Sessions use `{userId,serverOrigin,epoch}`. Guest stores require their explicit local
profile ID, null serverOrigin and an epoch too. The host advances epoch for account/local
profile changes and logout/login of the same account; a null session is not a binding.
Previews are opaque in-memory capabilities. Public counts/options cannot mutate the
private publication plan. A restart reparses the archive with the same `restoreId`.

The store-only ZIP contains `opengym-backup-manifest.json` and
`nutrition/<digest>.json`, optionally `workouts/<digest>.json`. No arbitrary extraction
paths are used. Legacy readers reject the new archive rather than importing just its
workouts and pretending the global restore succeeded. The manifest is sealed v1 with
explicit format, envelope schemaVersion, domain/storage versions, per-section version,
current/retained references, exact byte sizes, document kinds and collection counts.
Documents and manifest must be canonical JSON. All entries must be declared exactly
once. Unknown versions, fields and entries are rejected. User metadata inside business
records remains JSON data, never executable HTML/code. Imported reserved maps are validated.

Nutrition documents remain portable v1. Export rewrites only their technical scope
into `{serverOrigin:null,profileId:'backup',generation:'backup-v1'}` and resets partition
revision/writeId/remote hints. Full snapshots and edit/deletion markers remain unchanged;
original device stamps are historical evidence, never restored as causal authority.
Frozen/unsent/delivery partitions are exported as deduplicated retained variants where
they differ from current content. This covers an unknown publication outcome without
exporting requests, queue IDs, server origin, account ID, tokens or receipts.
Stored business conflict archives are exported unchanged. A previous root used only as
a rollback pin and unreachable physical uploads/versions are technical recovery state,
not extra backup datasets; they are included only if referenced by a current, queued or
delivery version. Export never collects these excluded physical objects.

Global export captures an unchanged workout state around the entire Nutrition scan.
It uses the existing workout shape, media sanitization and an explicit public-field
allowlist, omitting active sessions and installation/write identifiers. Media references
remain; binary workout media are **not** included in this new format and are reported
as a warning. Existing media ZIP exports/imports remain operational and unchanged.
Global application is deliberately blocked before any writes. `datasets:'nutrition'`
explicitly restores only Nutrition from a global archive. Workout-only legacy archives
are inspected with the existing reader; their restoration uses the existing workout
flow, not this service. No Nutrition deletion follows an absent section.

## Restore rules, publication and interruption

Options: `{restoreId,mode:'empty'|'merge'|'replace',choices,allowReplace,datasets}`.
Merge is default. Choices are keyed by canonical `[collection,id]`, with
`{action:'keep-local'|'use-backup'|'copy-backup',newId?}`. Divergent values require a
choice. Copy requires an unused new entity ID; the settings singleton cannot be copied.
Field erasure unsupported by v1 requires a new ID rather than pretending merge is an
exact replacement. A permanently deleted ID cannot be resurrected. Explicit replacement
requires `allowReplace:true`; it archives removed local records and creates fresh,
covering tombstones. It preserves unknown server-only data on subsequent sync. A server
edit to a known deleted/replaced ID is retained by sync's existing conflict archive.
This is a local replacement, not an exact server reset. To make decisions about server-only
records, first synchronize and prepare a fresh preview containing those records; an old
offline backup alone never authorizes deleting unknown remote history.

The planner reuses `mergeNutritionDomains`; it does not create another concurrent merge
algorithm. New edits use target-device clocks beyond all target row/field clocks, not
untrusted archive counters. Current/retained divergent snapshots are retained in the
existing `nutritionSyncConflicts` format. Backup tombstones are informational in
`nutritionBackupTombstones`, validated, hashed and unioned by the synchronizer. Local
restore receipts live in `nutritionBackupRestores`, also additively unioned, and are
excluded from export. Neither grants access or acknowledges an operation.

The receipt's restoreId hash binds a request digest (archive, mode, choices, intent).
After a separate metadata-only preparation journal, receipt, complete partitions,
manifest and new offline checkpoint publish in the same existing transaction/root-last
protocol. Retrying after completion, even after later
edits, is a no-op; reusing an ID for another request is refused. Before publication,
CAS checks the preview head. Changed data, freeze/ACK or another tab invalidates the
preview. The optional `commit(input,{guard})` / `expectedHead` additions are backward
compatible and do not alter ordinary edits.

Restore cancels the provided sync runner. A sent request may still commit remotely;
its immutable delivery/frozen operation remain pinned, and the restored checkpoint
queues behind it. Exact replay/receipt registration happens before subsequent merge.
Other runners/tabs are protected by durable CAS; no global cancellation promise is made.
Session guards run before publication and before returning data. Once a native write has
started, logout cannot undo it, but it only targets the captured private scope; completion
is an unknown outcome to the caller until that account reopens and checks the receipt.

Before root publication the old state remains authoritative. After publication the
receipt identifies completion at next startup. No old state is deleted. A failed first
publication can leave orphan documents: reopening reports recovery required, and replay
of the exact archive/options/restoreId can finish only if it preserves every orphan byte.
An unrelated replay is blocked. Corrupt committed state/fallback is read-only and not
repaired or collected by restore. Abandoned unrelated orphans need explicit future
recovery tooling; there is no unsafe automatic cancellation/purge.

## Review corrections (functional and durability passes)

* Empty array collections were initially lost when a prepared import regrouped rows.
  The planner now retains explicit empties; full library reconstruction is asserted.
* Unmarked existing rows needed a strictly lower synthesized target marker, otherwise
  tie ordering could ignore an explicit choice. The incoming target stamp now advances
  beyond that baseline; both variants remain archived.
* Session checks now run even when an asynchronous read/write rejects, avoiding errors
  containing previous-account diagnostic identifiers after a session switch.
* The public conflict list initially shared the private plan's array. Clearing it could
  bypass the refusal and falsely report a restore with no applied rows. Public conflicts
  and operation counts are now deep copies; tampering with applicability/conflicts cannot
  bypass validation or publish a journal. IDB and native regressions assert the head stays
  unchanged after attempted tampering.
* Backup receipts/deletion evidence need additive merge and conservation on clean pulls,
  ordinary edits and server publication. Shared `core/history.js` now protects these
  maps and existing conflict variants against omission or changed hash entries. A prior
  client can still read v1 documents; dropping known evidence is refused rather than
  silently losing it. Workout synchronization is untouched.
* Native first-write interruptions may leave unauthoritative orphan documents. Tests
  prove exact replay without deleting evidence; arbitrary replacement stays blocked.

## Limits and environment adapters

Archive data are capped at 32 MiB / 1,900 documents, manifest at 512 KiB, each Nutrition
partition at 512 KiB and hydrated archive domains at 96 MiB. Nesting is limited to 64,
traversal to 1.5 million nodes. Cycles, repeated JS object references, accessors, custom
prototypes, non-JSON values and prototype-control keys are rejected before serialization.
The ZIP is uncompressed: no expansion/decompression bombs and no ZIP64. Canonical JSON
rejects ambiguous duplicate keys in the new format. Legacy formatting stays supported.

Export hydrates only four documents at a time; its ZIP sink retains immutable Blob data
up to the archive cap. Validation and restore preparation still materialize bounded
hydrated graphs. The backup-specific target capture reads only current/queued/delivery
documents, but preparation and final publication still materialize that entire bounded
graph; native writes cross the bridge in one aggregate batch. Ordinary `read()` is unchanged.
These caps are safety refusals, not a claim of low peak RAM on every device. Mobile
bridge limits, target histories near the cap and origin quotas require device trials.
Browser quota estimates are hints, never reservations; unknown native capacity stays
unknown. A failed quota/write never purges or clears the queue.

Restore receipts, preparation journals and informational deletion maps have no time expiry. They consume
partition space; at the v1 512 KiB boundary the operation refuses before writing.
Future sharding/receipt retention needs a proof covering years-offline devices, not a
simple age limit. Server old versions and local current/prior/frozen/delivery pins retain
their existing policies. Export does not invoke collection or mutate cache/index/queue.

`saveNutritionBackup` uses the existing `shareExportBlob` native adapter (3 MiB base64
chunks) with a generated safe Cache filename, or a browser Blob download. Share failure
keeps the completed export Blob with the caller. File selection is left to the future
host UI; this step exposes Blob-based services and adds no selectors/screens/plugins.
`download-requested` / `shared` indicate handoff to the browser/OS, not proof that an
external backup file was saved. Some share sheets do not report cancellation reliably;
the host must retain the Blob and ask the user to confirm external conservation.
Native sharing is JS-tested via injection, not executed on Android/iOS. Existing Java/
Swift private-store bridges are reused unchanged; no additional fsync/locking guarantee
is inferred from Filesystem/Share. Real device compilation, locked-device behavior,
share cancellation and power cuts remain manual validation work.

### Security/compatibility review

Unknown workout top-level fields now cause export refusal rather than being silently
omitted. Known installation/auth fields are excluded explicitly; a parity test checks
all current `DEF` fields. Workout deletion/edit/order/unit metadata remain exportable.
A future profile field requires deliberate classification before global export resumes.
Lazy legacy-workout adapters allow the Nutrition-only service to import in plain Node
without React/browser globals. A null guest session was insufficient to distinguish ABA
session changes; guest profiles now require an explicit profile/epoch binding as well.
The backup reader rejects unreleased v0 draft partitions in a v1 archive; no untested
migration is invented. Future schema versions require a dedicated validated migrator.
Archives are unencrypted personal data; hashes do not authenticate their creator.

### Bounded target capture

The final review found that the existing eager `read()` loads unreachable physical versions,
although preview only needs its published graph. `readForRestore({maxBytes})` and the
restore-only `commit(...,{maxBytes})` option now capture current/queue/delivery documents
through guarded bounded batches, excluding unreachable versions without deleting them.
The graph is fully revalidated before publication. Ordinary local APIs remain unchanged.
First-write orphan replay is exceptional: the adapters expose orphan listing eagerly, then
its total byte cap is checked. Very large orphan sets still require recovery tooling with
native streaming/list limits; the service cannot claim bounded peak RAM for that case.
AbortSignal cancellation is available for export and preparation; aborting a preview also
invalidates its guard, preventing later application. Once publication starts, its outcome
is determined by the durable receipt, not by a UI cancellation message.

### Historical recipe expansion

Packed snapshots can fit comfortably in a month while the same frozen rows expanded as
inline conflict variants exceed 512 KiB. Imported retained/existing archive variants now
use deterministic `library-bv-<restore-key>-<shard>` partitions, with a conservative 320 KiB
variant budget per shard. They contain no live records and reuse the validated v1 archive
extension. Deduplication also checks variants already in the target. Tests cover 200 frozen
rows sharing a 3 KiB snapshot, which require multiple shards after expansion. A single
oversized variant or a full existing live partition that cannot hold sync's own two-row
conflict evidence still causes a safe capacity refusal; general sync resharding is future work.

Shard IDs reserve all target/archive partition identities before allocation. A correctly
hashed malicious archive could otherwise preselect a generated ID and have its library
replaced in the planning map. Allocation now skips collisions; a regression asserts that
its imported library and historical variant both survive.

The resource review also identified dictionary amplification: a sub-512-KiB partition
could reference a large snapshot hundreds of times and allocate over 100 MiB before a
post-hydration size check. The shared serializer now exposes a conservative packed-to-
hydrated byte estimator and an optional pre-hydration limit. Backup validation and local
backup/restore scans cap cumulative estimated expansion at 96 MiB before allocating it.
Portable v1 and default ordinary serializer behavior remain compatible. Tests construct
600 references to a 200 KiB snapshot and refuse the archive before expansion. A larger
frozen-history test gets a 30-second timeout for its meaningful volume, without changing
any content validation.

## Durable preparation and startup discovery

A final interruption review found that orphan final-publication bytes on a nonempty
store did not identify the intended restore at startup. Restore now first CAS-publishes
a metadata-only journal under `nutritionBackupRestorePreparations`, then publishes all
food/library changes and the completion receipt atomically. Both checkpoints retain
existing queued/frozen/delivery data; unsent checkpoints coalesce by the existing rules.
This journal contains request/base digests, no archive contents, account credentials or
foreign queue state. `recoveryStatus()` identifies `prepared`, `completed` and `base-changed`
restores. The user-visible food graph remains entirely old until final publication.
Both journal and final publication are guarded by revisions/session checks. Technical
journal/receipt maps and their empty partitions are excluded from exports.

A prepared restore binds a digest of target business data, row/field markers and historical
archives, excluding technical revision/receipt state. A resumed request can tolerate
queue-only transitions, but a changed business baseline refuses the old choices with
`restore_prepared_base_changed`. It requires a fresh preview/intent and new restoreId;
old preparation evidence remains preserved. This prevents an automatic crash resume
from overwriting newer data based on an earlier decision. First-journal orphan replay
still requires exactly matching archive/options/id and preserves every staged byte.
Tests inject interruptions through journal and final publication phases, discover the
journal after reopening, and refuse resumption after a concurrent business change.

### Global capture revision barrier

Equality of workout JSON before/after is insufficient against an ABA write (change and
revert). Global export now requires `getWorkoutRevision()` returning `{namespace,revision}`
with a nonreused write token or monotonic counter, and checks the scope against Nutrition.
It checks this token around initial workout capture and after Nutrition's stable-root scan,
then also checks the content. Tokens/ownership are not exported. The future app adapter
must bind this to the owned workout copy (e.g. its `gym_state_wid` plus an in-memory mutation
revision covering quota failures), and refuse unresolved ownership/adoption. The service
cannot manufacture that guarantee from `S` alone. Tests cover identical final JSON after
an ABA write, missing revision readers and cross-account workout scope.

## Integration and recovery API

The service operates on an already opened, account-owned Nutrition store. It does not
authenticate, open another account's store, invoke training synchronization, or install
itself in Settings. The host must provide the actual session epoch and the same Nutrition
sync runner used for that store. A Nutrition-only example:

```js
import { createNutritionBackup } from './nutrition/backup.js'
import { saveNutritionBackup } from './nutrition/backup-file.js'

const backup = createNutritionBackup({ store, getSession, sync })
const exported = await backup.export({ signal })
await saveNutritionBackup(exported)

// file is a user-selected File/Blob; selection is a future host integration.
const preview = await backup.preview(file, {
  restoreId, mode: 'merge', datasets: 'nutrition',
})
// Display warnings/conflicts/space before explicit application. A conflict requires
// another preview with choices; the public preview itself cannot authorize changes.
if (preview.applicable) await backup.restore(preview)
```

`restoreId` is caller-generated, unique to an intention, and must match
`[A-Za-z0-9_-]{1,128}`. Reuse it with the exact same archive/options when recovering;
do not generate a new ID blindly after a lost completion response. Methods return
structured previews. Contract validation throws the existing `NutritionValidationError`
with `issues` containing paths/codes; the reused ZIP/legacy readers retain their existing
typed/code-bearing errors (for example `ZipError.code === 'bad-name'`). I/O/platform
failures must also be surfaced by the host. User-provided names/notes are data; a future UI must render
them as text and never use imported HTML as markup.

At startup in the same account:

1. Call `recoveryStatus()`. `completed` means the durable completion receipt exists;
   `prepared` means the journal exists but the final publication is absent;
   `base-changed` means newer business data invalidated the old decisions.
2. For `prepared`, ask for the same archive and re-create its preview with the exact
   same restoreId/options. No archive payload is persisted by the journal, so a lost
   input file cannot be reconstructed from its digest.
3. For `base-changed`, keep the existing data/evidence and prepare a new intention
   against the current data. Automatic overwrite/resume is forbidden.
4. If reading fails or the store reports `recovery-required`, use the existing local
   inspection/verification facilities. Restore never legitimizes a corrupt root or
   deletes an unrelated orphan set. First-journal unpublished bytes allow only an
   exact byte-preserving replay, tested separately.

An abandoned preparation leaves metadata rather than partly imported food data. There
is no automatic rollback that deletes queued operations, and no expiry of that journal.
No automatic startup hook/UI is added in this step; the recovery API is ready for one.

For a global backup, also provide synchronous `getWorkouts()` and the owned, monotonic
`getWorkoutRevision()` described above. A revision reader for the current useStore is
not automatically installed. A durable global restore needs a workout participant
that reports disk failures, records recoverable intent, and coordinates the two stores;
calling today's `importBackup()` and then Nutrition restore is deliberately unsupported.

## Compatibility and migration policy

| Input | Inspection | Application |
| --- | --- | --- |
| Existing workout JSON | Existing reader after resource/security gates | Existing workout import flow; Nutrition untouched |
| Existing workout media ZIP | Existing reader; media descriptors retained | Existing media import flow; Nutrition untouched |
| New envelope v1, Nutrition only | Full manifest/graph/business validation | Empty, merge, or explicitly authorized replace |
| New envelope v1, global | Both sections validated; omitted binary media reported | Nutrition-only with explicit dataset choice; global blocked |
| Future envelope/domain/storage version | Structured refusal | No writes |
| Unreleased portable v0 draft inside envelope v1 | Refused | No invented migration |

The new service caps the entire input ZIP at 33 MiB (32 MiB data plus envelope
allowance). The unchanged legacy media reader has its own larger limit; previously
supported large media ZIPs must continue through that existing flow. This service does
not reduce that flow's limit. Legacy binary media integrity is checked by the existing
confirmed import, not by this service's read-only preview. Plain legacy JSON goes through its original overlay/migration
rules rather than being converted into Nutrition. Future formats require an explicit
version dispatcher and tested migration, followed by all current validators. Unknown
sealed fields fail closed; ordinary business JSON extensions remain preserved subject
to resource/prototype restrictions and conflict checks.

## Test organization and reproduction

* `backup-format`: canonical manifest, sizes/counts, missing/duplicate/corrupt references,
  unsupported versions, malicious objects/paths, depth and dictionary amplification.
* `backup-restore`: complete library/recipe/template/goal round trips, default conflict
  refusal, explicit choices, permanent tombstones, replace intent, opaque previews,
  frozen queues, idempotence, archive/journal identity collisions and shard capacity.
* `backup-durability`: transactional IDB simulator, real temporary files with fsync/rename,
  first-write phases 1–10 and existing-store phases 1–11, quota/abort, stale roots,
  journal discovery, baseline changes, session/logout ABA and stable global capture.
* `backup-sync`: two/three devices using actual Nutrition server-store/route handlers,
  deleted/concurrent/unknown remote data, frozen delivery replay after a lost response,
  late responses and additive completion/preparation evidence. This does not replace
  real loopback HTTP or real browser/device tests.
* `backup-file` and `backup-workouts`: browser/native JS adapters and allowlist parity
  with the current training defaults, legacy-reader compatibility and unknown fields.
* `backup-volume`: ten-year corpus, repeated recipe snapshots, two offline checkpoints,
  complete export/inspection/preparation/application/reconstruction and count checks.
* API `nutrition-backup-history`: permanent metadata/variant preservation, altered
  hashes, collisions and valid relocation, using the actual server store. A shared
  runtime-neutral validator also rejects malformed reserved restore metadata before
  server upload writes anything; the frontend reexports those same rules. This closes
  a review finding where only the importing client initially enforced their schema.

Use the installed lockfile dependencies and Node 22; no extra dependency is needed:

```sh
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
npm test -- src/lib/nutrition/backup-format.test.js src/lib/nutrition/backup-restore.test.js src/lib/nutrition/backup-durability.test.js src/lib/nutrition/backup-sync.test.js src/lib/nutrition/backup-file.test.js src/lib/backup-workouts.test.js --maxWorkers=2 --reporter=dot
npm test -- src/lib/nutrition/backup-volume.test.js --maxWorkers=1 --reporter=dot
npm test -- src/lib/nutrition --maxWorkers=2 --reporter=dot
npm test -- --maxWorkers=2 --reporter=dot
npm run build
node scripts/nutrition-backup-benchmark.mjs
cd ../api
npm test
# Force real HTTP rather than allowing the pre-existing EPERM skip:
NUTRITION_REQUIRE_HTTP_TESTS=1 node --test test/server-nutrition.test.js test/nutrition-http.test.js
cd ..
git diff --check
```

The benchmark creates and removes only its own temporary directory. It runs each phase
in a separate Node process, requests GC before measurement, and reports heap/RSS and
process peak RSS. Child output is exchanged through files because this sandbox suppresses
child pipes. It imports the portable Nutrition service directly, without Vite/React.

## Measured ten-year performance

Measured on Debian/Linux, Node v22.23.3, temporary private JSON simulator using real
fsync/rename; one isolated process per phase. Corpus: 2016–2025, **10,959 food entries**
(three per day), **130 partitions** (120 journal/10 library), 200 personal foods,
100 recipes, 120 deletion markers, two offline checkpoints. ZIP: **2,594,315 bytes**.
These are single observations, not browser/mobile guarantees or latency percentiles.
The recurring recipe corpus is highly deduplicable; more distinct snapshot versions,
large recipes and metadata can substantially increase archive size and peak allocations.

| Phase | Time | Heap before → after | RSS before → after | Process peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Export | 8.62 s | 5.22 → 23.78 MiB | 60.67 → 111.03 MiB | 111.28 MiB |
| Archive validation | 4.35 s | 5.03 → 29.39 MiB | 62.49 → 111.34 MiB | 111.34 MiB |
| Restore preparation | 20.13 s | 5.16 → 61.21 MiB | 60.68 → 146.37 MiB | 146.37 MiB |
| Restore application | 15.83 s | 11.87 → 47.19 MiB | 147.98 → 172.50 MiB | 190.05 MiB |

Restore timing excludes its already completed preview; that process's peak RSS also
includes preview/warm-up. Heap figures are sampled endpoints, not peak heap or retained
memory after another GC. Reading/preparing current and retained graphs and encoding
the final publication remain CPU/memory intensive despite progressive export. A bound
on estimated JSON size is not a bound on JavaScript heap, Blob backing memory or native
bridge allocations. Near-limit histories may refuse safely rather than exhaust quotas.

## Manual platform validation and remaining work

Run the full frontend/API and strict HTTP commands above in SSH outside this sandbox.
The training regression HTTP tests can also be isolated with:

```sh
cd /home/codex/openGym/api
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
node --test test/sync-stamps.test.js test/server-data-rev.test.js test/server-data-wid.test.js test/server-data-rev-endpoint.test.js test/server-data-reset.test.js
```

Use disposable profiles/files only. On a real browser, open two tabs on the same profile,
modify during export/preview, abort the write transaction, close/reopen, verify old-or-new
complete state and unchanged frozen operation. Test origin quota denial and storage
eviction: no web app can guarantee survival of user-cleared/OS-evicted browser storage;
external backups and persistence permission remain useful. On Android/iOS compile the
unchanged private-store plugin, transfer a Blob through the existing Share adapter,
cancel selection/share, switch accounts and lock the device during each journal/final
phase. Confirm private paths and reopen behavior after OS termination. Simulated phase
interruptions are not equivalent to a power cut or filesystem/OS durability proof.

Further work: the host file-selector/recovery UI; durable workout participant and global
restore journal; real-browser/physical-device memory and crash trials; streaming/bounded
orphan listing in native adapters; metadata sharding and general merge conflict-archive
resharding. None may introduce age-based deletion of unacknowledged or years-offline
evidence. No new dependency, backend endpoint, authentication change, training sync
change, native plugin, or Nutrition screen is introduced by this step.

## Validation record — 2026-10-11

Node **22.23.3**, npm **10.9.9**, Vitest **4.1.11**. Existing project dependencies were
available; no installation or lockfile change was needed. The following are separate
runs with overlapping coverage; their passing counts must not be added together.

| Run | Result | Limits |
| --- | --- | --- |
| Six-file focused frontend command above, after final preview correction | 107 tests passed, 6 files; 0 failures/skips; 13.47 s | IDB/native sharing are simulated/injected |
| Full Nutrition `npm test -- src/lib/nutrition --maxWorkers=2 --reporter=dot`, after final preview correction | 498 passed, 19 files; 0 failures/skips; 274.88 s | Includes all existing Nutrition and ten-year backup/storage/sync tests |
| Full frontend `npm test -- --maxWorkers=2 --reporter=dot` | 5,554 passed, 6 failed, 0 skipped; 421 passed/1 failed files, 422 total; 511.64 s | All six failures in unchanged `scripts/check-locales.test.mjs` |
| Ten-year backup test within the final Nutrition run | Passed; export/validation/preparation/application/full verification completed | Vitest process peak RSS 282.38 MiB includes fixtures/other allocations; separate-process figures above are more comparable |
| Direct API `node test/nutrition-backup-history.test.js` | 6 passed, 0 failures/skips | Actual private server files; no sockets |
| Eight API Nutrition files using `node --test` | 8 file-level passes | This sandbox hides child TAP cases; five nested HTTP cases are skipped, not validated |
| Same eight API files executed individually, `node test/<file>.test.js` | 76 cases: 71 passed, 0 failed, 5 skipped | 1 in nutrition-http, 4 in server-nutrition skipped for loopback EPERM |
| Full API `npm test -- --test-concurrency=2` | 79 file-level cases: 41 passed, 38 failed; 67.01 s | 37 failed files require forbidden loopback sockets; coach-limits fails from suppressed child output |
| Strict direct HTTP `NUTRITION_REQUIRE_HTTP_TESTS=1 node test/nutrition-http.test.js` | 10 non-socket cases passed, 1 real HTTP case failed, 0 skipped | EPERM on listen |
| Strict direct HTTP `NUTRITION_REQUIRE_HTTP_TESTS=1 node test/server-nutrition.test.js` | 0 passed, 4 failed, 0 skipped | EPERM on listen |
| Web `npm run build` | Passed, 2.04 s | Existing large-chunk/dynamic-import warnings |
| Mobile web `VITE_MOBILE=1 npm run build -- --outDir /tmp/opengym-backup-mobile` | Passed, 4.23 s; `checkCopy` passed | No cap sync, Android compilation or iOS compilation |
| Explicit Vite library build of backup.js/backup-file.js, after final preview correction | Passed, 0.36 s | Ensures new service bundles even before UI imports it |
| Direct `node scripts/check-locales.mjs` | Passed: 18 locales, 2,258 keys each | Does not replace the six blocked subprocess tests |
| `git diff --check` plus whitespace checks of new files | Passed | No commit/push |

Child-process diagnostics reproduced `spawnSync.error.code === 'EPERM'`, status 0 and
empty stdout/stderr; asynchronous spawn exited 0 with empty output even for
`console.log(123)`. The unchanged locale tests depend on subprocess output. Four Coach
limits assertions expect a fixture provider response, but its child output is likewise
empty. Those assertions remain failed and must be rerun outside this environment; no
test was disabled, weakened, or classified as passing. Authentication/training HTTP
regressions are included in the blocked full API files and also require SSH validation.

Review found and corrected empty collection reconstruction, unmarked-record ordering,
session error leakage, omitted durable metadata, dictionary amplification, expanded
recipe archive capacity, generated-ID collisions, missing restart preparation evidence,
and ABA workout capture. A late API review added the shared reserved-metadata validator.
Its first new assertion used `missing_field` instead of the project's actual
`required_field` code; the assertion was corrected while keeping strict validation.
The final preview-copy correction was checked by rerunning all 107 focused cases.
A Nutrition run already in progress had cached the old service while picking up the
new tampering assertions: its two failures reproduced the old bug. The fresh full
Nutrition run on unchanged sources passed all 498 cases, as recorded in the table. The broad frontend
run preceded this final correction; earlier/intermediate reruns are not combined with
the final focused results or counted as independent coverage.

The portable Nutrition mechanism is ready for human review. Overall global restoration
remains deliberately unavailable until the durable workout-participant decision, and
environment/platform checks listed above prevent a claim of complete validation.
