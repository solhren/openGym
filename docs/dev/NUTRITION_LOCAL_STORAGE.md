# Nutrition local storage — step 2.2 and progressive reads

The standalone coordinator reuses [the portable v1 contract](NUTRITION_PERSISTENCE.md).
It does not change `gym_state_v1`, authentication, the UI or network sync. No dependency is added.

Step 2.4 adds a dedicated [Nutrition synchronization coordinator](NUTRITION_SYNC.md). Its optional
root delivery envelope pins the exact server request, manifest and complete graph before network
publication. Cleanup and full verification also include these pins; identity-only acknowledgment
cannot bypass an active delivery's validated server receipt. Progressive day/month reads remain
separate from full mutation/synchronization validation. No portable v1 or native bridge format changes.

## API and isolation

```js
import { createNutritionLocalStore } from '../../lib/nutrition/local-store.js'
import { encodePartition } from '../../lib/nutrition/serialization.js'

const store = await createNutritionLocalStore({
  namespace: { serverOrigin: null, profileId: stableProfileId },
  generation: stableGeneration, deviceId: stableDeviceId,
}) // detects Capacitor; dependencies/backends can be injected
const before = await store.readMonth(requestedMonth)
await store.commit({ commitId: uniqueCommitId, partitions: [await encodePartition(domainPartition)] })
await store.collect() // maintenance failure must not invalidate an already committed save
store.close()
```

The caller supplies stable profile/device/generation ids and a canonical server origin (or null).
Never substitute tokens, emails, display names or an unscoped current-server setting. SHA-256 of
canonical `{namespace, generation}` determines the database/private directory. Profile names and
partition ids never become paths. Accounts, servers and generations cannot adopt each other's
data. Closing/logging out does not delete history/outbox. Do not regenerate the generation on open.
An adapter cannot be opened for a second scope while it is open/opening. Closing a store is
permanent for that store object and idempotent; subsequent calls fail with `storage_closed`.
Use a new store object for the next account. An adapter may be reused only after close.
Cancelled asynchronous opens cannot replace a later connection. A save still preparing when
the store closes cannot publish; an already-started physical transaction/call remains scoped
to its original account and may finish. Reopen that original scope to determine its outcome.

`commit` accepts encoded partitions with existing revision/write-id/edit/tombstone rules. Multiple
writes/removals form one publication. Records can move between shards atomically; disappearing
records require a destination or explicit tombstone. Tombstones cannot silently disappear. Callers
stamp intentional business edits; the durable counter advances past known record/field/operation
stamps and is exposed by `read().counter`. On `stale_root`, reload/rebase intentional edits rather
than retrying a stale whole-partition replacement. An exact immediately repeated commit is
recognized by its request digest; a different request reusing the current commit id is rejected.
Compaction must also retain record/field edit markers and nonregressing deletion stamps. A stamp
may stay identical or advance its counter; equal counters from different devices are not proven
supersession and are conservatively refused. Deletion must retain/advance all stamps of the
removed record, including its fields. No age/receipt-based marker pruning is implemented. A future
merge protocol must explicitly define conflict ordering and safe marker retirement; storage does
not invent a merge policy. Moving records between shards must carry their markers too.

## Physical publication

IndexedDB uses one database per scope, with `roots`/`documents`. Hashes, JSON bounds and validation
run before the transaction. One `readwrite` transaction compares the root, checks immutable-object
collisions, writes changed partitions/manifest, retains the published old root, and publishes the
new root and queue state together. Completion, not individual request success, resolves the save.
Aborts/quota failures roll back all stores. IDB isolation serializes connections/tabs without
expiring leases. Confirmed `durability: strict` is required; unsupported engines refuse writes.
Version changes close old connections. There is no volatile/localStorage fallback.
Forced closure invalidates the connection and aborted transactions do not report success.
Ordinary `close()` permits already-started transactions to finish; their outcome belongs to
their original scope. `strict` is an API durability hint, not independent proof that a browser
or storage device honors every flush; actual-engine crash tests remain necessary. See the
[IndexedDB transaction and connection algorithms](https://w3c.github.io/IndexedDB/#closing-connection).

Native files use private Android `files/opengym-nutrition/<scope>/` and iOS
`Library/opengym-nutrition/<scope>/`. The project-owned Capacitor `NutritionStorage` bridge supplies
locking/fsync/CAS missing from Filesystem. Android registers it alongside app plugins; iOS uses a
bridge-controller subclass to register its instance while keeping package auto-registration.
Only native bootstrap changes; there is no Nutrition screen. I/O runs off the main thread, under
an OS file lock (FileLock/flock) released by process death. Publication under this lock:

1. Compare `root.json` to the expected local root, or recognize the exact published new root.
2. Write immutable `p-<digest>.json`/`m-<digest>.json` through unique temporary files; force file,
   rename on the same filesystem, force directory.
3. Durably replace `previous.json` with the actually published old root.
4. Durably replace `root.json` last, including head and delivery state.

iOS additionally requests `F_FULLFSYNC`. Failed flush/rename/permission/disc operations propagate;
guarantees are not silently downgraded. Failure after root rename but before response has an
unknown outcome: reopen/read and verify the exact request/commit. Orphan documents never become
published history. Hardware ignoring flushes remains outside software guarantees.
Both bridges acknowledge only after releasing the lock and closing its descriptor. iOS attempts
each close once, preserves a primary error, and reports a late unlock/close failure if the body
succeeded. The temporary data descriptor must close successfully before rename. Android uses
checked try-with-resources before resolving. Native text reads reject malformed UTF-8; a lossy
replacement character must not conceal byte corruption even if decoded JSON/checksums match.
See Apple's [close(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/close.2.html)
and [fsync(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html).
Missing both roots with existing documents reports recovery, not a fresh empty store. Only a
first-write replay retaining every existing document byte-for-byte may publish without a root;
an unrelated initialization/cleanup is refused, since lost roots could hide published history.

## Persistent outbox

An independently versioned/checksummed local root v1 wraps the portable head, durable counter,
request digest, `unsentId` and `inFlightId`. Portable partition/manifest/head formats stay v1;
their manifest retains actual operations and pinned versions. Delivery state is never a sidecar
preference and is published atomically with the referenced manifest.

Only the checkpoint never handed to a sender is coalesced: latest full dirty partitions and
partition removals, retaining complete journal records, snapshots, edits and tombstones. It is
a state checkpoint, not an audit log of intermediate edits. Moves/recreated shards update both
sets. An unsent checkpoint must point to current versions. `beginPending()` freezes it durably
before returning its operation/content digest/exact partition payloads. Calls after restart
redeliver the same bundle indefinitely. Subsequent edits create/coalesce a separate checkpoint.
There is at most one frozen and one unsent operation: no timeout, lease expiry, inactivity purge
or heuristic acknowledgment. Offline edit count no longer grows the inline operation list.

`acknowledge({operationId, operationDigest})` removes only the exact frozen bundle. The future
network coordinator must call it solely after a durable, scope-correct, idempotent server receipt.
The local API checks identity, not server authenticity; no server/network is implemented here.
Lost receipts require future server id/digest idempotency. Later unsent changes/history survive.
Queue size still grows with dirty/removed shards; the 512 KiB manifest limit remains. Oversized
plans fail without truncation. Unbounded shard metadata will require explicit future segmentation.

## Recovery, retention and capacity

Full readers copy both roots and document bytes under one readonly transaction/native lock,
then validate/decode outside it. The byte snapshot survives concurrent publication/GC. Every
head, reference and delivery state uses the shared recovery validation. A corrupt current publication
with a complete prior root yields `recovery-required`, exposing prior history/diagnostics, and
blocks writes, queue transitions and cleanup. Newer unsent evidence is preserved, never overwritten
by automatic rollback. No complete root means visible failure; future formats refuse fallback.
Manual repair/import/export is a future workflow.

`collect()` validates both current/prior roots and pins all their current and queued versions.
Snapshots stay embedded in pinned partitions. Both root comparisons and deletions share the
transaction/OS lock; intervening publication invalidates GC. Native abandoned temporary files are
cleaned only under that lock. Corrupt fallback also blocks collection. Current history, frozen
payloads and tombstones never expire with age or offline peers. The explicit maintenance API must
be called periodically by future host integration; no app-global scheduler is introduced here.
Without maintenance unreachable versions grow. Retention normally covers two roots plus the frozen
checkpoint, but genuine journal/tombstone/removal metadata continues to grow.

All documents are bounded to 512 KiB physical UTF-8 including envelopes. `storageStatus()` reports
browser estimate/persistence and requests persistence only with `requestPersistence: true`.
Quota errors never trigger history eviction or queue deletion. Estimates cannot reserve space.
User-cleared storage, origin changes, app removal, private browsing and hardware failure still need
external backups. Android's existing 25 MiB cloud-backup cap is unchanged and cannot guarantee a
ten-year archive. Consistent export/restore and server conservation remain future stages.

Full recovery, mutations, export and collection still eagerly copy/validate history. Their
memory and CPU cost scale with retained data. Progressive opening and period reads below avoid
this path. Large native publications still transfer a complete write batch: 512 KiB bounds each
document, not that aggregate message. Bounded write staging remains future work.

## Progressive loading (implemented, portable v1 unchanged)

Opening reads only the current/prior roots, their candidate manifests and an optional local
date index. `inspect()` validates head/manifest checksums, scope, descriptor and queue rules,
and returns `partially-verified` for a normal publication. It does not certify unvisited
partitions. Header fallback still invokes complete recovery before accepting an older root
at opening. Corruption discovered later fails the selected read or complete verification;
the existing full `read()` provides complete recovery diagnostics. Nothing automatically
rolls back a root or acknowledges/removes an operation.

The added public methods are:

```js
await store.readDay('2026-10-10')
await store.readMonth('2026-10')
await store.readPeriod({ start: '2026-09-15', end: '2026-10-15' })
await store.verify()
store.cacheStatus()
store.invalidateCache() // required by a future restore entrypoint, including same-root restores
```

Period results contain `{ status, head, entries, issues, verification }`. Dates are inclusive;
entries are cloned, ordered by date then id, and preserve complete historical snapshots.
Physical granularity remains the v1 shard: a day request may decode its entire monthly shard,
but never requires the unrelated years. The `verification` field distinguishes headers from
selected partitions. `read()` keeps its
existing complete export/recovery behavior. No UI, server or network synchronization is added.

Portable v1 permits entry dates outside the month in the journal id. Filtering identifiers
alone would silently miss those records. A derived date index records the actual minimum/
maximum entry dates of every current journal shard, its complete reference descriptor,
namespace/generation and exact manifest digest. All matching shards are decoded/validated,
including misplaced dates. Selected shards also undergo cross-shard identity checks; global
duplicates in unvisited shards require complete verification.

The index is a separately checksummed, bounded local v1 envelope, stored under `index` in the
existing IndexedDB `roots` store (no DB upgrade), or privately as atomic `index.json` beside
native roots. Portable roots/manifests/partitions remain unchanged. Publication computes it
from fully validated domains and saves it under a separate paired-root CAS. Optional index
persistence failures report `indexIssue` on commit/verification without undoing a durable
publication/outbox. Missing, stale, corrupt or
unrecognized hints trigger a complete bounded validation pass before a period read, followed
by index rebuilding. Thus old archives have one expensive first period read when the derived
index can be persisted; failed persistence may require repeating this scan. Hints are never
authority for writes, collection, retention or outbox transitions. Checksums detect corruption,
not an actor who can rewrite and reseal local documents. No automatic history eviction occurs.

`readDocuments()` copies at most four document strings under a readonly IDB transaction or
native OS lock, comparing both expected roots in that same operation. Each document remains
bounded to 512 KiB. Period reads normally request one shard at a time; verification batches
four. A final empty batch checks both roots even for cache-only reads. Concurrent publication/
collection forces a retry (at most three attempts); data from different heads is never returned
as one period. Already copied bytes survive collection. No expiring reader pin is needed for
one such read; a future export spanning separately returned pages will need an explicit
consistent-view/pinning protocol.

The per-store LRU caches private decoded domains by immutable digest. Defaults are eight
entries and 8 MiB of accounted bytes, configurable via `cache: { maxEntries, maxBytes }`;
zero disables caching. Accounting is four times expanded JSON UTF-8 size, a conservative
budget rather than an exact engine heap measurement. Oversized entries bypass the cache.
Returned entries are cloned. Root changes, publication, collection, explicit restoration
invalidation, failed full verification and close clear it; invalidation also prevents late
reads repopulating old data.
After `invalidateCache()`, the next period read rebuilds the date index from real documents.
A same-root external disk modification can remain invisible to a warm cache until explicit
invalidation or uncached verification; a future restore workflow must coordinate other writers.

`verify()` always bypasses the cache. It validates every current and pending-operation version
once in bounded batches, including frozen payloads, and accumulates global identity/tombstone
sets without retaining all hydrated snapshots. It checks the root pair at the end and rebuilds
the index. Prior-root completeness is still checked by full recovery/collection. Identity sets,
manifests and result entries grow with the archive/request: this is bounded document loading,
not constant total memory. Whole-archive period requests still allocate the entire result.

All mutations and cleanup retain the complete existing recovery/validation path. They never
use partial-read status or a date index as proof of archive safety. Pending operations, pinned
versions and tombstones retain their indefinite retention rules. The optional index grows
with journal shards and has the same 512 KiB physical bound; oversized indexes fail explicitly
without truncation. Future very large shard counts need explicit metadata segmentation.

Worker decoding, resumable verification and bounded native write staging are future work.
Tests exercise the real JS adapters with IDB/native protocol simulators; native additions and
actual browser scheduling still require the device tests below.

## Targeted review measurements before progressive loading (Debian, 2026-10-10)

The final official Vitest selection passed **418/418 tests in 14 files**, with no skipped
tests, in 302.04 seconds (`--maxWorkers=2`). This includes the complete Nutrition suite and
existing SHA-256, store persistence, stamp parity, media IDB/files and sync-merge regressions.
The local coordinator/bridge files contain 84 tests, including account-switch races, forced
connection aborts at five writes, late native-close failures, strict UTF-8 and frozen-document
corruption. The newly reproduced rebinding/marker-loss cases failed before their fixes.
The web build passed with existing chunk-size/dynamic-import warnings. JavaScript syntax,
UTF-8/whitespace, Xcode plist/source membership, storyboard and Android registration checks
passed. These checks are static for the native code, not a native compilation.

The 120-month native-files simulator fixture contains 36,000 complete recurring-recipe entries
(300/month), with one deduplicated snapshot per shard. After collection it retains 120 partition
documents and two manifests; one unsent operation references all 120 current shards:

| Measured quantity | Result |
| --- | ---: |
| Immutable document bytes (excludes small roots/lock/filesystem overhead) | 7,674,371 (7.32 MiB) |
| Current manifest | 34,149 bytes (33.35 KiB) |
| Largest document | 63,524 bytes (62.04 KiB) |
| Five-year read | 15.02 s |
| Ten-year cold open (validates archive) | 29.30 s |
| Ten-year read after open (validates archive again) | 30.00 s |
| Add second five-year batch | 62.25 s |
| Full collection/validation | 44.65 s |
| Test process maximum RSS | 501,796 KiB (490.04 MiB) |
| Process RSS at end / JS heap used at end | 228.95 / 118.02 MiB |

These are synthetic Node/Debian observations, not mobile/browser latency or minimum application
memory requirements: the test retains expected entries/encoded partitions and performs complete
equality assertions. Native bridge copies are not included. Recipe complexity, provenance,
number of shards and device speed can change these costs substantially. These measurements
describe the earlier eager implementation. The 512 KiB individual bound alone does not solve
aggregate memory; the progressive measurements use isolated processes below.

The 2,000-publication offline test retains exactly five physical documents after periodic
collection (three partition versions, two manifests), two operations, a manifest below 4 KiB,
and the unchanged first frozen payload. Counts describe this single-shard fixture; the genuine
journal, marker and removed-shard metadata still grows and is never silently truncated.

Real IndexedDB was unavailable: no browser engine is installed/cached and the npm download
probe failed with `curl: (6) Could not resolve host: registry.npmjs.org`. No network settings
or permanent dependencies were changed. Android's offline compile stopped before compilation
because Java/JAVA_HOME is missing. Swift/Xcode/iOS SDKs are absent on Debian. Remaining device
tests must verify plugin discovery, private directories/protection before first unlock, actual
FileLock/flock contention, fsync/F_FULLFSYNC/rename and close failures, forced app/browser death,
quota/disk failures, multi-tab scheduling, and bridge memory with the volume fixture. Power-loss
durability and browser adherence to the strict hint cannot be proved by the simulators.

## Progressive comparative measurements (Debian, 2026-10-10)

Run the dependency-free benchmark from `frontend/`:

```sh
node --expose-gc scripts/nutrition-local-benchmark.mjs /tmp/nutrition-benchmark.json
```

Node v20.19.2, 120 monthly v1 shards, 36,000 entries (300/month), complete recurring recipe
snapshots and one pending checkpoint. The fixture is committed before measuring; the local
date index is available. Each scenario runs in an isolated process on the same temporary
files using the native-protocol simulator. Cold means an empty application cache, not a cold
OS filesystem cache. Scenarios run sequentially without the test suite in parallel. Each
count is asserted; these are single observations, not latency percentiles or device results.
The comparative baseline is the unchanged eager `read()` followed by date filtering, with
the same fixture and codec. Times below exclude opening and, for warm reads, the initial fill.

| Operation | Elapsed | Partition reads | Peak process RSS | Heap used after operation |
| --- | ---: | ---: | ---: | ---: |
| Eager read then day filter (10 entries) | 29,198.43 ms | 120 | 239.77 MiB | 149.79 MiB |
| Day, empty application cache (10 entries) | 195.43 ms | 1 | 70.25 MiB | 6.30 MiB |
| Day, warm cache | 41.69 ms | 0 | 71.38 MiB | 6.18 MiB |
| Eager read then month filter (300 entries) | 29,199.79 ms | 120 | 181.48 MiB | 96.93 MiB |
| Month, empty application cache (300 entries) | 202.14 ms | 1 | 69.49 MiB | 7.74 MiB |
| Month, warm cache | 69.80 ms | 0 | 71.66 MiB | 7.57 MiB |
| Uncached full verification, 36,000 entries | 14,685.71 ms | 120 | 109.40 MiB | 16.29 MiB |
| Complete eager reconstruction, 36,000 entries | 29,152.14 ms | 120 | 240.58 MiB | 149.94 MiB |

Opening from headers measured **46.91 ms** without hydrating any partition (other scenarios:
42.98–75.29 ms). Each request also reads/validates the manifest and performs paired-root guards;
those costs are included. The JSON report's document-read counter includes the manifest, so
it is one greater than the partition count in this fixture. Cached reads still reread headers.
Both day/month cold reads add opening time (51.20/47.15 ms) when used as the first application
request. Their one decoded shard accounts for 673,696 bytes (0.64 MiB) of the cache budget.

The runtime starts at about 58 MiB RSS and 3.99 MiB heap after GC. RSS peaks include startup,
warming and runtime overhead; the last column is live-plus-uncollected heap at the sampling
point, not a peak-heap measurement. Warm-read peak RSS therefore includes its preceding cold
fill. GC scheduling explains differences between eager scenarios. Native bridge serialization,
real OS locks, mobile process memory, browser IndexedDB and slower-device CPU are not modeled.
Complete recovery/writes/collection remain eager and retain their previous volume limitations;
the optimization concerns opening, requested periods and bounded complete verification.

## Tests and platform limits

After this optimization, the official Vitest selection below passed **443/443 tests in 15
files**, with no skipped tests, in **271.21 seconds** (`--maxWorkers=2`): 330 Nutrition tests
and 113 existing SHA/store/media/stamp/sync regressions. The new progressive-reader file
contains 25 tests for both backends, covering actual-date indexing, cache bounds/ownership,
missing/corrupt hints, unvisited corruption, global duplicates, concurrent publication/GC,
closed/aborted reads and preservation of pending/frozen operations. The complete 5/10-year
codec tests, ten-year local storage/queue/GC test and 2,000 offline-publication test passed.
The web build passed in 2.18 seconds with existing chunk-size/dynamic-import warnings.
JavaScript syntax, UTF-8, whitespace and static native registration/method/plist checks passed.
No browser engine, Java or Swift/Xcode SDK is installed here; real IndexedDB/native execution
was not performed. No permanent dependency, network setting, server API or network sync changed.

Vitest tests the real JS adapters/coordinator. The IDB simulator implements working-copy isolation,
cross-connection serialization, completion and rollback, but is not a browser engine. The native
bridge simulator uses real temporary UTF-8 files, fsync and atomic rename on Debian, with injected
interruptions after publication/queue phases. Tests include long offline queues, history movement,
quota/corruption/conflicts, and recurring recipes over monthly shards. Existing codec tests also
reconstruct complete 5/10-year histories. These tests do not compile/run Swift/Android, verify OS
file locks on devices, or emulate failing hardware flushes. Real Chrome/Firefox/WebKit, native
build/registration, locked-device and abrupt-power-loss tests remain required.

```sh
cd frontend
npm test -- src/lib/nutrition src/lib/sha256.test.js src/store/persistence.test.js \
  src/lib/sync-stamps-parity.test.js src/lib/media-store-idb.test.js src/lib/media-store-fs.test.js \
  src/lib/sync-merge.test.js --maxWorkers=2 --reporter=verbose
```
