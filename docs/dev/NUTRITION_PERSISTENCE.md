# Nutrition persistence contract — step 2, serialization only

Step 2.2 implements the local adapters and delivery/retention policy in
[Nutrition local storage](NUTRITION_LOCAL_STORAGE.md). The portable formats below stay v1;
an additional local root publishes delivery state atomically and allows unsent compaction.

The pure modules in `api/nutrition/core` define storage bytes and publication rules.
`frontend/src/lib/nutrition` preserves its existing public imports through re-exports of the
same source. Step 2.3 adds an independent [server API](NUTRITION_SERVER_API.md); sharing the
validators/codec avoids a divergent server implementation and does not change portable v1 bytes.
They do not open IndexedDB, write files, change the existing profile store, call APIs, merge
devices or connect to the UI. The domain records and validators from step 1 remain unchanged.
No npm dependency, schema key in `S`, existing workout limit, or native resource is changed.

## Modules and boundaries

| Module | Responsibility |
| --- | --- |
| `persistence-contract.js` | Version constants, structured errors, canonical JSON, SHA-256, scope, ids, sync metadata |
| `serialization.js` | Domain/storage conversion, snapshot dictionary, bounded JSON, explicit format migration |
| `persistence-commit.js` | Manifest/head validation, immutable publication plans, completeness checks, recovery |

All functions are independent of React and the existing storage implementation. SHA-256 reuses
openGym's `sha256Hex`: standard Web Crypto when available, otherwise the existing equivalent
pure-JavaScript SHA-256 implementation. HTTP LAN/guest contexts therefore keep the same digests
and format without a new dependency or a weaker hash. Actual hashing failure produces a
structured error. Node is imported only by tests.

`NutritionPersistenceError` extends the existing `NutritionValidationError`. Errors contain
`issues: [{ path, code }]`; business reconstruction uses the existing domain validators and
may throw their `NutritionValidationError`. Nothing is coerced or silently repaired.

## Independent storage format

A version 1 partition has these fields:

| Field | Contract |
| --- | --- |
| `format` | `opengym-nutrition-partition` |
| `storageVersion`, `domainVersion` | Both currently 1; storage and business versions are independent |
| `namespace` | `{ serverOrigin: null \| canonical HTTP(S) origin, profileId: nonempty string }` |
| `generation` | Explicit nonempty reset/restore generation, supplied by the caller |
| `id`, `kind` | Stable filesystem-safe partition id and matching `journal` or `library` |
| `records` | Collection names mapped to packed rows; settings remain one JSON object |
| `snapshots` | Full immutable food/recipe snapshots keyed by canonical SHA-256 hex digest |
| `sync` | Local revision/write id, edit/deletion markers and optional known remote revision |
| `extensions` | Optional JSON object for future storage metadata |
| `integrity` | `{ algorithm: 'sha256', digest }` over all other fields |

`journal` partitions accept only `foodEntries`; `library` partitions accept `customFoods`,
`savedFoods`, `recipes`, `mealTemplates`, `nutritionGoals`, `nutritionSettings`. Collections
may be absent or empty; this distinction survives conversion. There must be at most one
record with a given id per collection in the complete published dataset; there is only one
settings object. A dictionary entry may remain unreferenced, but still must be valid and
correctly hashed. No garbage collection is performed here.

Packed rows are explicit envelopes, separate from business fields:

| Collection | Packed row |
| --- | --- |
| Custom/saved foods | `{ foodRef }` |
| Journal | `{ value: entryWithoutSnapshot, snapshotRef }` |
| Recipes | `{ value: recipeWithoutIngredients, ingredients: [{ value: ingredientWithoutFood, foodRef }] }` |
| Meal templates | `{ value: templateWithoutItems, items: [{ value: itemWithoutSnapshot, snapshotRef }] }` |
| Goals | `{ value: goal }` |

Storage envelopes reject unknown fields. Business `value` objects retain all valid additional
JSON metadata, including names such as `snapshotRef` that might otherwise collide with the
storage format. Required nested business fields cannot be embedded in `value` to override a
dictionary reference.

## Fidelity and deduplication

The digest covers the **entire** snapshot: id, name, reference, nutrients, portions, defaults,
recipe yield, ingredient provenance, licensing notices and additional metadata. Equal content
with different object key order shares a digest; different array order or metadata does not.
Food ids alone never identify historical content. Each partition owns its dictionary, so a
historical entry does not depend on the current catalogue or another partition.

All numbers retain JavaScript/JSON precision without nutritional rounding. Missing nutrients,
null and zero remain distinct. No density, macro value or energy value is inferred. Decoding
creates separate snapshot objects for each entry/ingredient/template item; mutating a decoded
food cannot modify another entry or the original stored partition. Inputs are captured before
any asynchronous hash operation, so caller mutation cannot race serialization.

The JSON rules from step 1 also apply at this boundary: data must use own enumerable data
properties and ordinary/null-prototype objects, with no accessors, unsupported values or
cycles. Neither getters nor `toJSON` run. Reconstruction preserves JSON values, not JavaScript
prototype identity or shared object identity. Signed numeric zero (`-0`) is additionally
rejected with `json_negative_zero`, because standard JSON cannot distinguish it from `0`;
there is no silent normalization. Ordinary numeric zero is preserved.

Canonical JSON sorts object keys by JavaScript code-unit order, preserves array order, and
uses standard JSON scalar encoding. SHA-256 uses its UTF-8 bytes. Partition, manifest and head
checksums cover their complete payload excluding only the root `integrity` field. Snapshot
hashes are checked separately, even if an outer checksum was recomputed. Integrity detects
accidental corruption; it does not authenticate a user or replace API authorization.

Each serialized document is limited to **512 KiB of UTF-8 JSON**, including metadata and
integrity. Oversized reads/writes produce `document_too_large`; nothing is truncated. The future
writer must choose another explicit shard before reaching that limit, with headroom for
tombstones and later edits. This budget bounds individual documents, not a user's history;
long text or large recipes can require smaller batches. Storage quotas, physical capacity and
hydrated in-memory sizes still need adapter-level handling.

## Stable placement

`journalPartitionId('2026-10', 'device-a-0')` returns
`journal-2026-10-device-a-0`; `libraryPartitionId('device-a-0')` returns
`library-device-a-0`. The shard is an explicit 1–64 character alphanumeric/underscore/hyphen
token, beginning with an alphanumeric character. Months are validated calendar months.
Paths, traversal, slashes and unspecified partition families are rejected.

The month is the **creation/placement month**, not the editable consumption date `d`.
Callers persist the assignment and choose globally unique device/batch shards. Editing the
date or meal category leaves the partition id intact. A future calendar index must inspect
`d`, rather than assume the partition month describes every contained meal. Intentional
repartitioning/compaction must use the multi-partition publication protocol and preserve entry
ids; no repartitioning or automatic id generation is implemented here.

## Synchronization metadata

`sync` contains `{ revision, writeId, edits, tombstones, remote? }`:

- Revision is a nonnegative safe integer. Revision 0 has `writeId: null`; positive revisions
  require a nonempty write id. A replacement partition must advance its **local** revision and
  use a different write id. This is distinct from the existing profile API's revision.
- Optional `remote: { revision, writeId }` records the last known remote partition version,
  with the same numeric rules; local edits do not imply that remote state has acknowledged them.
- Edit markers are `{ collection, id, stamp, fields? }`; tombstones use the same identity and
  stamp with no fields. Settings use the reserved id `$`.
- A stamp is `{ counter: positive safe integer, deviceId: nonempty string }`, reserved for a
  future logical clock. Callers manage counters; there is no wall-clock read or merge algorithm.
- An edit must refer to a live local row. A tombstone cannot coexist with a live row. Duplicate
  markers, live/deleted conflicts and duplicate ids across published partitions are rejected.
- Field stamps refer to **own direct fields**, with immutable `id` and `schemaVersion` excluded.
  A quantity or snapshot is one atomic field; `quantity.amount` cannot be stamped separately.
- Tombstones are never expired by age or capped in this module. Safe compaction requires future
  device/server acknowledgement rules; offline data must not resurrect silently.

Scope includes server origin, stable profile id and generation. A different server, account or
reset generation cannot be mixed into a commit or adopted during recovery. Guest adoption,
login, reset and restore will need explicit adapter workflows. An empty new generation can be
planned, but replacing the old generation's published pointer remains a separate, explicit
coordinator operation; this code does not bypass head comparison for a reset.

## Multi-partition publication and interruption recovery

The manifest (`opengym-nutrition-manifest`) contains version/scope, `commitId`, `parentCommitId`,
safe-integer `sequence`, all current partition descriptors and `pendingOperations`. A partition
descriptor is `{ id, digest, revision, writeId }`. Descriptors identify **exact immutable versions**,
not just filenames. A head (`opengym-nutrition-head`) contains version/scope, `commitId` and
`manifestDigest`. Both documents are independently checksummed.

`prepareCommit` takes a validated base manifest (or explicit null initialization), changed
partitions, an explicit new commit id, optional physical partition removals and optional full
pending-operation list. It returns `{ expectedHead, writes, manifest, head }`. Unchanged
partition references and pending operations are retained by default. `assertPublishable`
compares the current head with the expected one and verifies the whole proposed dataset,
including queued historical versions. A plan alone is not a successful publication.
Optional operation/removal lists default only when absent; an explicit null is invalid.

The future adapter/coordinator **must** implement:

1. Serialize writers or use a real compare-and-swap against the expected head; a check followed
   by an unguarded write is insufficient. A stale head requires reload/replanning.
2. Persist changed immutable blobs under `(namespace, generation, partitionId, digest)`.
3. Persist the immutable manifest. Verify every current and pending-operation reference.
4. Cross the durability barrier, then publish the head **last**, preserving a previous published
   head for recovery. Comparison with the expected head must be atomic with this final update,
   or a writer lock must cover the complete publication. Two successful preliminary checks do
   not reserve the head. IndexedDB can put these updates in one transaction; native/server files
   need durable write/rename ordering. This module does no I/O and cannot itself provide fsync.
5. Retain blobs/manifests reachable from published fallback heads and queued operations. Remove
   orphans only after durable publication and a later safe garbage-collection decision.

`recoverCommit` takes the expected namespace/generation, **published** heads in preference order
(current, then retained backups), available manifests and partition objects. It reconstructs
only a complete matching commit. Prepared manifests with no published head are ignored. It
never mixes a new journal with an old library just because both files exist. Missing/corrupt
data can select a complete previous commit with `status: 'fallback'` and diagnostic `issues`.
A fallback can lose access to changes after that older commit: the adapter must report it and
retain incomplete newer blobs for diagnosis/recovery, rather than silently declaring success.
If no complete published head exists, `no_complete_commit` is raised. Only an explicitly
published empty manifest represents an empty dataset; missing storage is not treated as empty.
Fallback never crosses the requested generation, preventing resurrection after reset.
Unsupported storage/domain/business-record versions and committed blobs requiring migration
block recovery with a structured version/migration error, even if an older complete head exists.
An older application must not turn a valid newer-format history into a stale writable dataset.
Missing or checksum-corrupt documents remain eligible for the explicitly reported fallback.

Retrying an unchanged `prepareCommit` input produces the same bytes and head. Repeating
publication after a lost acknowledgement is rejected as `stale_head`; the coordinator can
recover the current published head and compare its exact digest with the proposed head to
recognize completion. This helper does not automatically acknowledge retries, nor offer an
exactly-once network guarantee. Commit/operation ids must be unique across their full namespace
and generation, not just the current manifest; retired shard ids must not be recycled. Callers
must persist the device identity and logical counter and manage those allocation rules.

All hashing/JSON validation must finish before opening an IndexedDB write transaction.
Awaiting `assertPublishable` (which awaits Web Crypto) inside that transaction can let it close
before publication. The adapter must compare the stored head again inside the transaction and
confirm its completion before reporting success. Native/server adapters must report actual
durability capabilities: the installed Capacitor Filesystem interface exposes write/rename,
but no fsync operation; the existing server helper's directory fsync is best effort. A rename
alone is not evidence that a power cut cannot lose acknowledged bytes.

Pending operations are `{ id, stamp, partitions, removedPartitionIds }`. Their stable id prepares
idempotent retries; referenced immutable partition versions pin the exact offline payload even
after later local edits. They are committed with the dataset manifest. Missing pinned versions
make that commit incomplete. Omitting `pendingOperations` retains the queue; supplying an
explicit replacement list supports later acknowledged removal. Enqueue/acknowledgement policy,
network retries, server conflict detection and actual merging are deferred. Physical partition
removal is also explicit; its caller must eventually prove it safe for queued deletions, remote
devices and fallback retention. This helper grants no automatic deletion policy.

## Versions and migrations

Readers reject future/unsupported storage or domain versions instead of dropping fields.
Version 0 is a documented **inline draft/import format**, not a previously shipped database:
same partition header, domain `records` containing full snapshots, no snapshot dictionary, and
the same integrity envelope. `migratePartition` validates it before producing version 1.
Ids, scope, generation, revisions, markers, provenance and metadata are retained. Current-format
migration is idempotent and does not mutate its input. Corrupt legacy data is not repaired.

Committed manifests require current-format blobs. A migration must write new immutable blobs
and publish a new complete manifest; mutating an existing blob would invalidate historical
references and pending payloads. Future versions need an explicit migration step and fixtures;
the domain version can evolve independently of the storage representation. Unknown business
metadata and the `extensions` object already allow many additive changes without a new format.

## Capacity and retained-version risks

The 512 KiB limit is an application budget for each canonical UTF-8 document, including its
checksum. Tests accept exactly 524,288 bytes and reject one additional byte. Native adapters
must write the returned compact string with UTF-8 encoding; IndexedDB adapters must apply the
same JSON budget even when storing objects. UTF-16 string length, base64 length and actual
browser quota accounting are different measures. The current server's 5 MiB body limit does
not guarantee that an arbitrary multi-partition request fits: future transport must measure
the entire encoded envelope and use bounded batches. No endpoint/limit change is made here.

This budget also applies to the **single root manifest and its pending-operation list**.
There is no automatic segmentation of manifests/outboxes in version 1. A synthetic size
measurement with 122 partition descriptors (300-entry batches for ten years), UUID-length
operation/write ids, and one partition reference per pending operation gives:

| Pending operations | Manifest UTF-8 bytes |
| --- | --- |
| 0 | 21,733 |
| 1,640 | 524,105 |
| 1,641 | 524,412 — exceeds the limit |

This is a fixture, not a capacity promise: longer metadata or operations referencing several
partitions reduce that threshold. At ten operations per day, this example allows about 164
days without queue acknowledgement/compaction. Thus ten years of **journal entries** fitting
in partitions does not establish ten years of an uncompacted offline queue. Oversized plans
fail without truncating operations or replacing the published manifest. Before enabling writes,
the coordinator needs headroom, surfaced capacity errors and a lossless queue policy: compact
only operations provably superseded and safe to retry, preserve deletion stamps, and retain
in-flight versions until acknowledgement. A segmented outbox/root, if required for unbounded
queues or many more shards, needs an explicit future format migration; it is not implemented.

Pinned full partition versions can dominate disk use even when snapshots deduplicate within
each partition. The recurring-recipe fixture with 300 entries is 61,724 bytes: retaining ten
distinct versions per day for a year would use approximately 215 MiB before filesystem overhead,
versus retaining just the current history. Retaining every past commit indefinitely therefore
needs a separate retention decision. Garbage collection must retain everything reachable from
the current head, retained published fallback heads, pending operations and active readers;
staging writers also need protection from concurrent collection. Age alone proves none of this.
Tombstones and field stamps need acknowledgement-aware compaction; active shards require room
for growing metadata or an atomic split. The current pure recovery helper clones its available
input and eagerly reconstructs the current dataset/checks queued versions, so large queues also
raise startup CPU/memory cost. Bounded/lazy I/O and validation indexes belong to the adapters.

Backups must contain a complete published manifest and all pinned versions, or use a separately
specified consistent export/restore workflow. Existing Android backup rules mention the 25 MB
cloud-backup cap and exclude only exercise media; nutrition must not silently rely on that
backup for a large queue/version archive. Browser eviction, storage exhaustion, application
removal and power-cut durability remain adapter/export concerns, not guarantees of this codec.

## Usage and validation

```js
const stored = await encodePartition({
  id: journalPartitionId('2026-10', 'device-a-0'), kind: 'journal',
  namespace: { serverOrigin: null, profileId: 'local-profile' }, generation: 'generation-1',
  records: { foodEntries: entries },
  sync: { revision: 0, writeId: null, edits: [], tombstones: [] },
})
const text = await stringifyPartition(stored)
const restored = await decodePartition(await parsePartition(text))
// restored.records.foodEntries can be passed directly to sumFoodEntries.
```

Adjacent Vitest tests exercise canonical hashing against Node's independent SHA-256, actual
JSON round trips, recipes/templates, immutable historical snapshots, invalid references,
corruption, structured errors, migrations, concurrent publication, interruption recovery,
scope/reset isolation and pinned offline versions. Volume tests reconstruct 18,270 and 36,530
entries (ten entries/day over 5 and 10 years starting in 2020), with recurring recipes in bounded
300-entry partitions, comparing every restored row and its calorie sum. They do not substitute
an adapter or simulate successful disk/network I/O.

```sh
cd frontend
npm test -- src/lib/nutrition src/store/persistence.test.js src/lib/sync-stamps-parity.test.js
```
