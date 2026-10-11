# Nutrition synchronization — step 2.4

`frontend/src/lib/nutrition/sync.js` coordinates the existing [portable v1 format](NUTRITION_PERSISTENCE.md),
[local storage](NUTRITION_LOCAL_STORAGE.md) and [authenticated Nutrition API](NUTRITION_SERVER_API.md).
There is no UI, automatic application startup, server-route change, dependency or change to
`gym_state_v1`, workout revisions or training synchronization.

## Entry points and identity

```js
import { createAppNutritionSync } from '../../lib/nutrition/sync.js'

// Open the local store with the authenticated uid, canonical configured server origin and
// the SAME stable dataset generation on every device. Never generate a new one on boot.
const coordinator = await createAppNutritionSync({ store })
await store.commit({ commitId, partitions }) // durable local checkpoint first
const result = await coordinator.run()
// On logout/account/server change, stop this runner and close its scoped store.
coordinator.stop()
store.close()
```

The application adapter lazily reuses `api()` for same-origin cookies, paired mobile Bearer
authentication, deployment subpaths, Cloudflare Access headers and existing request timeouts.
Its session epoch changes when the application user object or server changes. A subscription
cancels awaiting work immediately; it neither modifies the application store nor schedules
training synchronization. The authenticated `/api/me` uid is checked at the beginning of a run.
Each remote document, publication and receipt independently checks namespace and generation.
Cookies changed by another tab cannot authorize writing the old user's namespace into the
new account: the server derives ownership from its current session and validates the body.

The injectable `createNutritionSync({ store, getSession, transport, ... })` uses
`getSession() -> {userId, serverOrigin, epoch} | null`. Epoch **must** change on logout/login,
including A → B → A or a new login to A. Never use only uid as the session token. The transport
has the existing `api(path, options)` interface and rejects HTTP errors with `{status,data}`.
No credentials are stored in Nutrition documents. Guest scopes and different origins/uids/
generations are refused, not implicitly adopted or merged. Binding a guest/imported dataset
to an account requires an explicit future adoption operation. A conventional shared initial
generation such as `nutrition-v1` can be chosen by the future bootstrap; this module does not
discover or select another device's generation. A development proxy whose page origin differs
from the configured server origin needs an explicitly scoped adapter.

`run()` is bounded to 12 passes by default and returns `{status,pending,publications,conflicts}`,
plus a structured error/retry hint when necessary. Statuses are `synced`, `pending`, `offline`,
`unsupported`, `auth-required`, `deferred`, `blocked` and `session-changed`. `pending` is
conservative if the run stops before inspecting the queue; it is not a queue count. Call again
on reconnect, application resume, intentional writes or an explicit retry. The runner installs
no background timers. Respect `retryAfter`/backoff for `deferred`; do not retry a blocked format,
corruption or capacity error indefinitely. A pass limit leaves its durable queue intact.

## Durable publication protocol

1. Business edits use `store.commit()`. Its current data and unsent checkpoint are durable
   together. A network call never substitutes for local persistence.
2. `beginPending()` durably freezes the oldest checkpoint. Later user edits remain in a
   distinct coalesced unsent checkpoint. Frozen partitions/operation digest cannot change.
3. Read a server head and its included manifest; validate all referenced immutable partitions,
   digests, snapshot references, identities and dataset coherence. Reuse matching validated local
   documents. A local revision hint can rebuild portable bytes only when the resulting hash
   matches the authenticated descriptor. No change is accepted from a recovery-required server.
4. Verify the server still conserves acknowledged clean partitions. Merge the frozen checkpoint
   into that graph. A partially restored server cannot silently omit another clean local month.
5. Build a new conditional publication with a fresh cryptographic id, server parent/sequence,
   advancing changed-partition revisions/write ids and an empty server outbox. `stageDelivery()`
   validates the entire graph and freezes **the exact request** in the local root before network
   writes: operation id/digest, expected head, new head, canonical request digest and upload hashes.
   The request manifest and its complete graph are immutable local documents, pinned durably in
   the same IDB transaction/native locked publication as that root. One durable plan wins by CAS.
6. PUT only changed partition versions. Staging success is not an acknowledgment. POST the exact
   saved `{expectedHead,manifest,head}`. Server commit ids and receipts bind this request forever.
7. Validate the receipt checksum, supported version, namespace, generation, commit id, request
   digest and exact head. `acknowledgeDelivery()` repeats this validation and atomically removes
   only the corresponding frozen operation and its delivery envelope. Later unsent operations
   survive. The legacy identity-only `acknowledge()` cannot bypass an active delivery receipt.
8. Drain subsequent checkpoints on fresh server graphs. Once the queue is empty, import the
   complete validated remote graph through a local CAS publication, without creating echo
   operations. A concurrent user write prevents this import and starts another pass. Import
   retains clocks/snapshots, invalidates the date cache and preserves acknowledged conflict data.

Local and server publication sequences are independent. A portable partition can be imported
verbatim when its revision advances locally; otherwise a new local revision/write id carries
the same business data and a non-authoritative `sync.remote` revision hint. A poll with identical
business content does not create another local publication. All document/root bounds remain
512 KiB UTF-8. Failed validation, serialization, quota, disk or close errors keep the operation.

The local root v1 has an optional `delivery` field; roots from steps 2.1–2.3 remain readable.
Portable partitions/manifests/heads remain exactly v1 and no native plugin change is required:
the bridges already store opaque bounded roots and `p-`/`m-` immutable documents. An older
Nutrition implementation that cannot read the optional envelope fails closed/read-only while
it is present. Older openGym applications continue using their separate workout store/API.

## Merge and deletion rules

`sync-merge.js` is pure and validates input/output using the shared business and v1 validators.
Identity is `(collection,id)` globally, not partition position. A remote existing owner keeps
the stable physical partition; additions retain their partition id. Moving an entity cannot
duplicate it. Explicitly empty array collections are retained. Recipes, templates, goals and
settings use the same rules; consumed snapshots are complete immutable values, independent of
later food/recipe edits. Record ids must be globally unique, stable and never recycled.

Lamport stamps order counter then device id. Equal counters from different devices advance to
a deterministic resolution stamp (`nutrition-merge-v1`) covering both inputs. Identical stamps
with divergent values also advance. Full-record markers select an atomic record; when both
records have field maps, direct fields merge independently. The aggregate resolution clock
covers the known field clocks, including one stronger than the
other writer's whole-record clock. Reserved conflict archives are checked against their hashes
and the same business/marker validators before import, reads or publication. Preserve existing
field markers and stamp every intentionally changed field. Snapshot, quantity, ingredients and template items
are atomic fields. An invalid mixed business record is refused, leaving the frozen checkpoint.

Different complete input records are retained under
`extensions.nutritionSyncConflicts = {version:1, records:{[sha256]:{collection,id,record,marker}}}`.
Each variant includes its complete snapshot/provenance and is hash-deduplicated. This conservative
archive can include older sequential values as well as concurrent conflicts: Lamport clocks
alone do not prove causality. Unknown divergent extensions and future archive formats are
refused. A clean pull refuses dropped archive variants and changed values with unchanged clocks
unless the old complete record is explicitly archived. No conflict review UI is included yet.

A tombstone wins permanently over any live copy of that entity id, even an edit with a higher
clock from a years-offline device. Its stamp covers all record/field clocks; the live variant is
archived. Undo/recreation requires a new id. Tombstones and field markers have no age expiry.
An absent optional field cannot silently remove another device's known field/marker: the known
value and complete divergent records are kept. Use an explicit empty/nullable business value
where its validator permits it; general field-erasure requires a future protocol extension.
Divergent existing records without real edit markers are blocked for explicit repair. Previously
unmarked **new** ids can be stamped from their durable operation stamp. No validation is relaxed.

Logical deletions propagate as tombstones. Empty physical partitions are retained on the server;
the runner does not propagate partition retirement or purge published historical versions.
An externally retired id, reused commit id or stale-partition error is blocked rather than
recycled automatically; explicit recovery/resharding must preserve all business records and
markers. Server manifests with pending operations from another protocol are also blocked rather
than silently clearing that outbox.

## Interruption and concurrent-run recovery

| Interruption/refusal | Recovery |
| --- | --- |
| Before local save or freezing finishes | No network publication; reread the local CAS outcome. |
| During delivery persistence | Root is old or fully published; orphan bytes have no authority. Reopen the same scope. |
| During partition uploads | Retry the saved delivery and immutable PUTs. Nothing is acknowledged. |
| Publication accepted, response lost/timeout/HTTP 503 | Retry the exact request and id after restart. The server repairs/returns its durable receipt, even after newer commits. |
| `409 nutrition-stale-head` | Durably discard only the rejected delivery envelope, retain the frozen operation, reread and rebase with a fresh id. |
| Busy/429/auth/other 409/capacity | Keep the exact request; defer, renew the correct session or repair the cause. |
| Receipt received, local acknowledgment interrupted | IDB abort retains it; native failure may have committed it. Reopen/read and replay only if still pending. |
| User changes during flight | Later unsent checkpoint survives every receipt, restart and cleanup. |
| Account/server/session changes or stop | Race cancellation and ignore late replies; retained data/request belongs only to its original scope. A physically started old-scope request may finish there. |
| Damaged current/delivery graph | Use existing complete fallback read-only; do not overwrite, acknowledge or collect. Preserve evidence and repair/export explicitly. |
| Empty/older/incomplete restored server | Keep local history; refuse untracked loss before publication/import. Restore verified server history or perform explicit recovery. |

Per-instance runs share one promise. A module queue serializes same-scope coordinators in one
realm; Web Locks additionally serialize browser tabs when available. Without Web Locks,
root CAS elects one frozen delivery and simultaneous requests replay that same publication id.
Late acknowledgments cannot match a different current delivery. `cancel()` invalidates a run;
`stop()` permanently closes the runner, but never deletes or rebinds the store. Correct session
lifecycle integration must stop/close old objects; a subscription cannot see a cookie switch
that never reaches app state, so `/api/me`, document scope and server authorization remain essential.

Cleanup pins current and previous roots, both queue checkpoints, and each root's delivery
manifest/complete graph. No timeout, TTL, receipt from another operation, account change or
assumption that every device reconnects can unpin unacknowledged data. Server retention is
unchanged and indefinite. Archive/marker/version growth can reach existing limits; refuse
writes with the queue intact, never delete history to make room. Explicit splitting, conflict
review, backups and a proven cross-device retention protocol remain future work.

## Validation and remaining limits

Vitest covers pure merge/receipt contracts, both local backends, lost responses/restarts/GC,
local quota/disk faults, concurrent devices/tabs, real API route handlers + worker/flock/files,
session changes, older servers, deletion and partial restoration. The volume test uses ten
calendar years, 120 journal partitions, daily recurring recipe snapshots and a library shard;
it verifies round trips, an unchanged poll with no partition exchange and a one-month update.
Existing local-storage and workout/media sync tests remain relevant. No permanent dependency
is added; IndexedDB/native devices use the existing transactional/filesystem simulators here.

`api/test/server-nutrition.test.js` also runs the client against the actual HTTP server when
loopback sockets are available. Sandbox `EPERM`/`EACCES` is explicitly skipped, not a successful
authentication/network test. On the VPS, with Node 22 and the locked dependencies installed:

```sh
cd /home/codex/openGym/frontend
npm test -- src/lib/nutrition
cd ../api
NUTRITION_REQUIRE_HTTP_TESTS=1 node --test test/server-nutrition.test.js test/nutrition-http.test.js
node --test test/sync-stamps.test.js test/server-data-rev.test.js test/server-data-wid.test.js test/server-data-rev-endpoint.test.js test/server-data-reset.test.js
```

Network transfer is incremental, but graph validation/merge/publication still eagerly loads
the entire affected dataset and can be expensive with ten years of expanded recipe snapshots.
Daily/monthly UI reads retain their existing bounded progressive reader. This is not a measured
browser/native memory ceiling or proof of OS/hardware flush guarantees. Browser crash/multi-tab
tests, Android/iOS power loss, token changes during native requests and representative mobile
memory/quotas require real-device validation. Nothing is automatically wired to the UI yet.
