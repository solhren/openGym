# Nutrition local storage — step 2.2

The standalone coordinator reuses [the portable v1 contract](NUTRITION_PERSISTENCE.md).
It does not change `gym_state_v1`, authentication, the UI or network sync. No dependency is added.

## API and isolation

```js
import { createNutritionLocalStore } from '../../lib/nutrition/local-store.js'
import { encodePartition } from '../../lib/nutrition/serialization.js'

const store = await createNutritionLocalStore({
  namespace: { serverOrigin: null, profileId: stableProfileId },
  generation: stableGeneration, deviceId: stableDeviceId,
}) // detects Capacitor; dependencies/backends can be injected
const before = await store.read()
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

Readers copy both roots and document bytes under one readonly transaction/native lock, then
validate/decode outside it. The byte snapshot survives concurrent publication/GC. Every head,
reference and delivery state uses the shared recovery validation. A corrupt current publication
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

Recovery eagerly copies/validates history; memory and startup cost scale with retained data.
Streaming/indexed reads remain an optimization to make without breaking root isolation.
The native bridge currently transfers the complete byte snapshot/batch; 512 KiB bounds each
document, not the aggregate Capacitor message. Device memory/bridge throughput on large archives
must be measured before production activation; bounded reads/staging are a remaining optimization.

## Progressive loading proposal (not implemented)

The v1 manifest already supplies stable shard identities, immutable document digests and queue
pins. Progressive loading can use these without changing portable storage or business models:

1. Read the current/prior roots and their manifests atomically. Validate scope, versions,
   checksums, queue identities and reference descriptors before displaying a valid root.
2. Add bounded backend reads for the requested month/library shards. IndexedDB reads a root
   and those document strings in one readonly transaction; native reads copy a bounded batch
   under the same OS lock. Require the expected root in each batch and restart/reload when
   it changes. A cache is keyed by scope and digest; cached data remains immutable.
3. Decode/validate only those shards for display, with an explicit partially-verified status
   for the whole archive. Background validation visits every current, prior and queued shard
   in bounded batches, accumulating record/marker identities. Global duplicate-id checks and
   complete-reference recovery cannot be claimed on the strength of one loaded month.
4. Keep any derived index rebuildable and tied to the exact manifest digest. Before mutations
   or collection, require complete validation (or a completely verified index plus validation
   of every changed/reference-dependent shard). A restart/root change invalidates a partial
   validation pass; it never promotes unknown/corrupt state to a writable empty archive.
5. Retain the current full `read()` as explicit export/diagnostic functionality. Page reads can
   refresh their root on each call. A multi-page export needing one exact historical view
   requires durable reader pins established atomically with publication and observed by GC.
   Release pins explicitly or only with proof the reader is gone; an inactivity timeout is
   insufficient. Do not add expiring leases to the outbox or deletion-marker retention.

The first optimization should bound reads and avoid repeatedly parsing unchanged documents.
Large imports additionally need bounded native staging of immutable files before the final
root CAS/validation, retaining the existing publish-last protocol. Per-document bounds alone
do not bound bridge messages, duplicated business snapshots or main-thread validation CPU.
Chunked verification/worker decoding and a size-bounded cache are future adapter improvements.
These are local optimizations, not an API/server/network synchronization implementation.

## Targeted review measurements (Debian, 2026-10-10)

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
number of shards and device speed can change these costs substantially. The current eager
implementation is functionally verified; progressive loading is required before activating
large archives in the mobile UI. The 512 KiB individual bound does not solve aggregate memory.

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

## Tests and platform limits

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
