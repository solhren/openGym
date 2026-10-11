# Nutrition server API — step 2.3

This API stores the exact [portable persistence v1](NUTRITION_PERSISTENCE.md) documents.
It adds no client network coordinator, UI, automatic merge, or API dependency. The local
adapters/outbox retain their existing behavior. The server does not read/write `state-*.json`,
change workout `_rev`/`_wid`, extend the profile JSON `S`, or acknowledge local operations.

## Existing architecture and integration

openGym uses a plain Node HTTP server and a method/path route table. Authentication is the
existing signed `gymsid` cookie or paired-mobile Bearer token; `sessionOf` checks the existing
user, disablement, token expiry and session version. Nutrition reuses this function and the
server's unchanged CSRF/CORS middleware. It creates no alternate credentials or public reads.
The worker also checks the authoritative `db.json` before processing, before mutation, before
the head commit point, and before returning success. An unreadable primary account database
fails closed for Nutrition, without changing the legacy server's recovery policy.

The existing workout API stores one per-user JSON document with conditional revisions. Nutrition
uses separate immutable documents and its own conditional head: the training synchronization
routes, revision counters, write-id handling, timers and data files are unchanged.

The existing Coach feature already shares pure sources from `api/coach/core` with the frontend.
Nutrition follows this convention: the existing model/calculation/validation/codec sources move
unchanged to `api/nutrition/core` (apart from import paths), and frontend module paths become
re-exports. The unchanged SHA implementation lives in `api/shared/sha256.js`, also re-exported.
The local store and server share the same history-preservation function. Browser/native
adapters remain frontend-only. The independently built API image does not import frontend
files, React, Capacitor, Vite aliases, or Node-incompatible browser modules.

## HTTP contract

All endpoints require authentication, have `Cache-Control: no-store`, and require exactly one
`generation` query parameter. A generation is stable, explicit and never recreated on login.
Namespace is fixed to `{serverOrigin: canonical configured ORIGIN, profileId: authenticated uid}`;
there is no owner/origin override, list-all-users endpoint, automatic guest adoption, or reset.

| Method and path | Request / result |
| --- | --- |
| `GET /api/nutrition/head` | Head/current manifest, namespace, generation, integrity status |
| `GET /api/nutrition/manifests/{digest}` | Exact current or retained confirmed v1 manifest |
| `GET /api/nutrition/partitions/{digest}` | Requires `manifest={publishedManifestDigest}`; exact current/pending referenced version |
| `PUT /api/nutrition/partitions/{digest}` | Raw v1 partition JSON; durable immutable staging, not a publication |
| `POST /api/nutrition/publications` | `{expectedHead, manifest, head}`; durable conditional publication and immutable receipt |

Paths accept only 64 lowercase hex digest characters. Unknown/duplicate query parameters are
refused. Upload digest must match the verified document. A staged partition/orphan manifest is
not readable history: reads need a published manifest and exact reference/revision/write id.
Older confirmed manifests and their exact partition versions remain accessible.

The portable document bound remains **524288 bytes (512 KiB), including integrity**. The POST
transport bound is 1572864 bytes; each nested portable document still obeys 512 KiB. Bodies
require JSON, strict UTF-8, no content encoding, no duplicate keys (including escaped duplicates)
and at most 64 nesting levels. Validation includes own JSON data properties, snapshot digests
and references, nutrients, dates, partition ids, scope, revisions, marker consistency, and
dataset-wide uniqueness. No coercion, implicit migration or missing-reference substitution occurs.

`expectedHead` is exactly the previously read portable head, or explicitly `null` only for
initialization. Publication verifies next sequence/parent, strictly advancing changed-partition
revisions/new write ids, complete current/pending graphs, record removals tracked by tombstones
or moves, and retained nonregressing edit/tombstone stamps. Retired shard ids cannot be reused.
Client conflict resolution must generate a new valid conditional request; the server never
merges or silently overwrites either client's changes.

Errors are `{error, code, issues?, head?, retryAfter?}`; diagnostics are capped at 32 issues.

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON/query/scope/format/document/reference or publication invariant |
| 401 / 403 | Existing authentication/CSRF refusal |
| 404 | Unknown path, unpublished manifest or unreferenced version in this account/generation |
| 408 / 413 / 415 | Slow body, excessive UTF-8 bytes, unsupported media type/encoding |
| 409 | Stale head/revision, reused commit identity with different request, retired shard, account publication lock busy |
| 429 | Per-account request/write/publication budget exhausted |
| 503 | Busy service/reader lock, interrupted worker, corruption, unsupported stored format, unavailable storage/lock |
| 507 | Account quota, generation quota, disk reserve, `ENOSPC` or `EDQUOT` |

## Stable retries and acknowledgment

`commitId` (1–256 UTF-8 bytes) permanently identifies an exact canonical publication request
inside its account/origin/generation. Before publishing, an immutable checksummed request record
binds its head, expected head and request digest. Its immutable receipt is persisted after the
head is durable. An identical retry returns the original receipt with `repeated: true`, even
after later publications, without moving the current head. Reusing that id with any different
request produces 409. An orphan receipt without its request record cannot acknowledge a retry.

An upload 200 means only that its partition is staged. A publication 200 follows every required
flush, receipt/confirmation write, worker authorization check, and release of the process lock.
A lost connection, killed worker or 503 during publication has an **unknown outcome**: retry the
identical request with the same id. Never discard an operation based on staging, timeout or a
partial response. The future network coordinator must durably bind each frozen local operation
to its exact server request/receipt and scope before calling the existing local acknowledge API.
Local profile ids, offline guest namespaces and server user ids may differ: their explicit
adoption/rebinding protocol belongs to that later coordinator, not this storage endpoint.

## Private files, locks and publication order

```
DATA_DIR/nutrition/SHA256(uid)/
  .lock
  SHA256(canonical({namespace,generation}))/
    p-{digest}.json       immutable v1 partitions
    m-{digest}.json       immutable v1 manifests
    c-{SHA256(commitId)}.json   immutable private request records
    r-{SHA256(commitId)}.json   immutable private receipts
    head.json            portable current head
    previous.json        previous published head
    confirmed.json       checksummed private last-confirmed head + sequence
    {randomUUID}.tmp     possible interrupted writes, retained
```

Raw ids never become paths. New directories are 0700 and files 0600. Symlink/non-regular targets
are refused; reads use `O_NOFOLLOW`, regular-file/size checks and strict UTF-8. The existing data
root is not globally chmodded. Per-account quotas cover every generation/origin under this uid.

Every operation uses an exclusive, nonblocking **OS `flock`**, across workers/API processes,
generations and reads. The trusted worker runs with `flock --no-fork`; an actual process death
releases the kernel lock. There is no expiring lease that permits a delayed writer to resume
after another took ownership. A lock conflict yields 409 for publication and retryable 503 for
reads/uploads. This supports multiple processes on a validated local POSIX filesystem; NFS,
network mounts and multi-host shared storage are not certified by these tests.

Nutrition intentionally uses stricter file I/O than the legacy `durable.js`: close/directory
flush failures must propagate. The legacy writer remains unchanged. Each write creates an
exclusive unique temporary file, writes and fsyncs bytes, closes successfully, renames atomically,
then fsyncs the directory. If write and close both fail, the primary error is preserved. Reusing
an existing immutable file explicitly repeats file/directory flushes before success.

Under the account lock, publication proceeds:

1. Recheck authentication, all portable content, current/pending integrity, conditional head,
   revisions, history preservation, reserved identities, and capacity.
2. Repair a prior published-but-unreceipted commit, if necessary and fully valid.
3. Durably store the immutable proposed manifest and exact request record; partitions must
   already exist durably. Save the previous published head.
4. Recheck authorization; atomically replace/fsync `head.json`. **This is the logical commit point.**
5. Durably store the immutable receipt and separately checksummed confirmed head/sequence.
6. Recheck authorization, terminate the worker/release its lock, then return 200.

Readers under the same lock observe a whole head/manifest, never intermediate partition mixtures.
Receipt and confirmation are acknowledgment barriers after the commit point, not alternate heads.
The lock also covers quota accounting and conditional checks: concurrent publications cannot
both pass a stale comparison, and concurrent generations cannot overspend one account quota.

## Interruption and corruption policy

| Interruption point | Visible state and safe recovery |
| --- | --- |
| Partition/manifest/request temp or staged rename | Old head stays published; identical retry forces missing durability barriers and resumes |
| Previous-head write | Old head remains current; previous never elects a prepared manifest |
| Head rename / directory flush | Either whole old or whole new head; response is unknown until retry/full verification |
| Head durable, receipt missing | Validate the complete committed graph and immutable request, repair receipt/confirmation under lock |
| Receipt or confirmation rename/flush | Retry verifies request identity and full history, repeats barriers; no duplicate commit |
| Invalid/missing primary head or partially restored old head | Verified confirmed head, then previous head, are read-only recovery candidates |
| Corrupt reference/graph or unsupported future format | Fail closed; no publication or automatic overwrite/deletion |

`GET head` normally returns `partially-verified`: it validates the head/manifest/confirmation
headers, not unvisited partitions. Partition reads fully validate their content; publications
always verify current and proposed complete graphs, including pending versions. A fallback
requires a complete verified graph and returns `recovery-required`, which blocks publication.
`uninitialized` requires no head, previous, confirmation or retained confirmed-publication evidence.
A newer stored format blocks fallback/overwrite; committed v0 bytes require an explicit migration
publication, not a server-side in-place rewrite.

The confirmed sequence detects a restored older primary head while the confirmation survives.
No checksummed local marker can detect a wholesale rollback of **all** files to one internally
consistent backup. Recovery from damaged/partial backups needs an operator-reviewed coherent
restore or an explicit new generation, retaining the damaged generation for reconciliation.
This API provides no automatic restoration/reset endpoint. Keep `ORIGIN` stable; a host rename
requires an explicit future namespace migration, not pretending old bytes belong to a new origin.
Back up a coherent snapshot (or stop the API); restore only after stopping every API/worker
using that data directory, preserving private permissions. Replacing a live lock file/directory
would change its inode and invalidate the process-lock assumption. Backups must include the
whole Nutrition tree, not just current heads/partitions or the profile JSON.

## Retention, limits and resources

There is **no automatic garbage collection or TTL**: all staged bytes, request records, receipts,
old manifests, partition versions and interrupted temporary files remain. Removal from the
current manifest/pending list never deletes their physical history. Tombstones/edits have no
age expiry: an offline device may return years later. There is no Nutrition deletion endpoint;
logout/account switching neither reads another namespace nor cleans this directory. The
existing account-administration behavior is unchanged; Nutrition is not wired into its purge.

Default capacity per account: **512 MiB**, **100000 files**, **32 generations**, plus a **32 MiB
free-disk reserve**. `NUTRITION_MAX_BYTES` may change the byte quota (integer ≥ 1048576); invalid
configuration fails explicitly at startup. Quota/real disk errors block further writes and
preserve existing files; operators must increase capacity or perform a future verified archive/
reconciliation workflow. No automatic deletion assumes all devices connected recently.

Manifest v1 remains limited to 512 KiB, so metadata is not unbounded. All retained versions count
against the account quota. There is no guarantee that arbitrary editing frequency fits ten years
within 512 MiB; frequent revisions can cost much more than the compact current history. A future
archive/compaction protocol needs explicit conservation proofs and persistent offline-peer
knowledge before reclaiming any server versions, markers, receipts or temporary candidates.

There are at most **two** active Nutrition requests/workers, reserved before body buffering, with
no unbounded queue. Rate budgets reuse openGym's bounded limiter: 300 requests/minute/account,
600 writes/hour/account, 120 publications/hour/account. Body idle/total limits are 30/120 seconds;
worker timeout is 300 seconds. A worker has a 128 MiB V8 heap ceiling and validates one partition
at a time, retaining only ids/sync markers for history checks, not all historical snapshots.
Account-wide lock conflicts and service saturation are visible/retryable. Limits/rate buckets
are process-local except disk quotas/locks; multiple API replicas multiply request budgets.

Full integrity verification remains O(current + pending data) on every publication; new shard-id
checks and quota accounting also scan retained metadata/files. Immutable reads start a worker
per request. This prioritizes safety; large archives/edit-heavy accounts need later verified
indexes and capacity measurements. The worker heap/timeout limit does not bound all process RSS;
production memory budgets and concurrency need load tests, especially smaller containers.
Memory exhaustion/interruption returns no acknowledgment and never authorizes automatic cleanup.

Linux requires the `flock` executable (`util-linux` on Debian). The API Dockerfile installs
Alpine's small [flock package](https://pkgs.alpinelinux.org/package/v3.22/main/aarch64/flock).
This is the only added system dependency: a kernel-held lock gives crash-safe multi-process
ownership without a npm native addon or unsafe expiring lease. If unavailable, Nutrition fails
closed; unrelated existing endpoints can still start. npm dependencies/lockfiles are unchanged.

## Node 22 revalidation — 2026-10-11

The supplied Node installation is `/home/codex/.local/opt/node22/bin/node`: **22.23.3**, with
**npm 10.9.9**. The shell's default PATH still selects `/usr/bin/node` 20.19.2 / npm 9.2.0.
Revalidation selects Node 22 through command-local PATH only; no global installation, sudo,
network setting, dependency manifest or lockfile is changed.

The repository's API script is `npm test` → `node --test test/*.test.js`; CI runs Node 22 and
`npm ci --omit=optional` in `api/`. The omitted Agent SDK is optional, not required for Nutrition.
The lockfile pins `@simplewebauthn/server` 13.3.2, `undici` 7.30.0 and `web-push` 3.6.7.
Those required API dependencies remain unavailable. The attempted lockfile installation hits
registry download `EAI_AGAIN`, then npm reports `Exit handler never called!`; the npm debug log
records the underlying DNS failures. Offline `npm ci --omit=optional --offline` fails with
`ENOTCACHED` for web-push. The incomplete installation produced empty package directories, not
usable packages; empty directories were removed without deleting any package files.

| Verification under Node 22 | Result |
| --- | --- |
| All Nutrition cases (direct node:test, including ten-year worker fixture) | **69 cases: 65 passed, 0 failed, 4 skipped** |
| Official targeted `node --test` runner | **7 file suites passed**; this environment reports file-level results, not inner skips |
| Existing targeted durability/auth-bookkeeping/limiter/queue/media/docs units | **140 passed**, none failed/skipped |
| Existing workout sync-stamps file | **17 passed**, 3 blocked at server boot by unavailable dependencies |
| Existing HTTP-provider adapter file | **25 passed**, 1 blocked by `listen EPERM` |
| Full `npm test` | **78 file suites: 37 passed, 41 failed**; not a green suite |
| Strict HTTP-required mode | **14 cases: 10 passed, 4 environmental failures, no skips** |

All **41 failing full-suite files were rerun directly** to expose their actual errors: **40**
fail due missing locked API packages (`undici`, `@simplewebauthn/server`, `web-push`), and **1**
(`adapters-http.test.js`) fails on loopback `listen EPERM`. No unexpected/assertion/implementation
failure was identified. Passing units do not certify the blocked server integrations.

The 4 blocked Nutrition cases are the real-loopback HTTP fixture and **three expanded real-server
tests**: existing cookie/Bearer authentication, account isolation and CSRF; exact retries and
concurrent 409 publication; independent workout revisions/write ids plus legacy saves. They
use the actual server/session/CSRF middleware, not injected factory sessions. Dependency absence
or explicitly denied loopback sockets may skip them by default. Set
`NUTRITION_REQUIRE_HTTP_TESTS=1` for validation on the VPS: it turns these conditions into failures
instead of silently accepting a skipped HTTP check. Unexpected boot/assertion errors always fail.

Accessible Nutrition tests exercise real Node 22 workers/files/flock: concurrent publication,
held-lock 409, exact historical receipts, graph validation, scope isolation, disk/close failures,
18 injected interruption phases and actual SIGKILL at four publication stages. The ten-year
fixture still passes with 120 partitions / 10959 entries; this run measured approximately
2.18 s first publication and 4.23 s complete checked update (synthetic data, not production SLA).

Changes during revalidation are limited to `api/test/server-nutrition.test.js`,
`api/test/nutrition-http.test.js` and this report. No production implementation error requiring
a correction was identified. The previous implementation remains uncommitted on feature/nutrition;
step 2.4 is not started. The code has **not** passed real HTTP/auth/CSRF end-to-end validation here.

### Exact commands in the VPS terminal outside the sandbox

Run with the API lockfile and real loopback access. Tests create temporary users/data directories;
they do not use the live server's data. This changes PATH only inside the subshell. A failed
dependency installation stops the sequence. The HTTP-required flag prevents a false green
Nutrition result when HTTP/dependencies are unavailable.

```sh
(
  export PATH="/home/codex/.local/opt/node22/bin:$PATH"
  cd /home/codex/openGym/api || exit 1
  node --version
  npm --version
  node -e 'if (process.versions.node.split(".")[0] !== "22") process.exit(1)' || exit 1
  command -v flock || exit 1
  npm ci --omit=optional || exit 1
  npm ls --omit=optional --depth=0 || exit 1
  NUTRITION_REQUIRE_HTTP_TESTS=1 node --test test/nutrition*.test.js test/server-nutrition.test.js \
    test/sync-stamps.test.js test/server-data*.test.js test/server-cors.test.js \
    test/server-token-refresh.test.js test/server-passkeys.test.js
  NUTRITION_REQUIRE_HTTP_TESTS=1 npm test
)
```

The initial Node 20 observations below are historical, not a claim of current full-server
validation. Android/iOS, actual power loss, NFS and production-load limits remain unchanged.

## Initial validation (Node 20; historical)

Tests use the official shared codec, real private files and real Linux `flock` workers. Route
tests invoke production handlers with Node streams and injected factory sessions, and verify
workers against the durable user database. Separate loopback/full-server tests verify actual
HTTP, cookie authentication, CSRF and workout revisions when the environment allows them.
Injected sessions alone do not certify those existing authentication middlewares.

Targeted server tests: 67 cases, **65 passed, 2 explicitly skipped** (loopback `listen EPERM`;
full server missing locked API npm dependencies). Coverage includes wrong-account/generation/
origin references, malformed bytes/keys/paths, quotas, stale/parallel publication, request
identity reuse, orphan receipts, missing snapshots/partitions, rollback detection, disk/close/
directory flush errors, 18 interruption phases, and real worker SIGKILL at four publication
stages. A real bounded-worker fixture publishes/updates **120 monthly partitions, 10959
entries** across ten years: approximately 3.43 s initial publication, 6.85 s complete checked
update (synthetic oats entries, this development machine; not a general production guarantee).

Commands from `api/` (the direct node:test invocation exposes individual cases as well as files):

```sh
node --input-type=module -e 'await import("./test/nutrition-protocol.test.js"); await import("./test/nutrition-files.test.js"); await import("./test/nutrition-store.test.js"); await import("./test/nutrition-http.test.js"); await import("./test/server-nutrition.test.js"); await import("./test/nutrition-packaging.test.js");'
node test/nutrition-volume.test.js
node --test test/nutrition*.test.js test/server-nutrition.test.js
npm test
```

The official targeted `node --test` runner passes all **7 file suites**. Its file-isolated output
in this environment does not expose inner-case skips; the direct node:test runs above provide
the exact 67-case / 65-pass / 2-skip accounting. During review a real lock-startup race was
corrected: the parent now sends a job only after the locked worker announces readiness, so
`flock` refusing a lock cannot become an IPC EPIPE/false 503. A held-lock regression and parallel
publication tests cover this behavior.

Existing relevant server units: **140 passed** (durability, limiter, password/passkey/device
bookkeeping, queue, media, docs/packaging). Existing workout stamps: **17 unit cases passed**;
its 3 full-server cases fail to start without `@simplewebauthn/server`. The attempted complete
`npm test` reports 35 file suites passed / 41 failed due unavailable API packages / loopback restrictions (76 files at
that run; later packaging/volume cases are verified separately). These are not claimed green.
`npm ci` cannot restore dependencies: offline cache missing `web-push`, online registry DNS
`EAI_AGAIN`. No network configuration or npm manifest/lockfile was changed to work around it.

Official frontend Vitest: **443 tests / 15 files passed**, including all Nutrition and relevant
SHA/profile persistence/media/sync parity cases. Web build passes with existing dynamic-import/
large-chunk warnings. Static Docker import-closure and generated OpenAPI checks pass. Actual
Docker image builds are unavailable (`/var/run/docker.sock` permission denied). Development
Node is 20.19.2; CI/images use Node 22. Full HTTP/auth/CSRF/workout integration must be rerun
with locked API dependencies, permitted loopback sockets and Node 22 before deployment.
Tests cover process death and injected flush faults, not actual host power-loss/storage-firmware
failure, NFS, production load, or real Android/iOS devices (their adapters are untouched).

## Changed-file inventory

42 files: 17 modified, 25 added. No npm manifest/lockfile, native source, training sync logic,
client network coordinator or UI feature is changed.

| Group | Files |
| --- | --- |
| Server implementation (new) | `api/nutrition/{protocol,files,store,executor,worker,routes}.js` |
| Pure shared source (new location) | `api/nutrition/core/{contracts,validate,calculate,recipe,serialization,persistence-contract,persistence-commit,history}.js`, `api/shared/sha256.js` |
| Existing frontend imports preserved | `frontend/src/lib/nutrition/{contracts,validate,calculate,recipe,serialization,persistence-contract,persistence-commit}.js`, `frontend/src/lib/sha256.js`, `frontend/src/lib/nutrition/local-store.js` |
| New tests/scaffolding | `api/test/nutrition-{protocol,files,store,http,volume,packaging}.test.js`, `api/test/server-nutrition.test.js`, `api/test/nutrition-{fixtures,fault-worker}.mjs` |
| Server registration/builds | `api/server.js`, `api/Dockerfile`, `web/Dockerfile` |
| API reference/checks | `api/openapi.yaml`, `api/test/openapi-routes.test.js`, `scripts/build-api-docs.mjs`, generated `website/api.html` |
| Developer documentation | `docs/dev/NUTRITION_PERSISTENCE.md`, `docs/dev/NUTRITION_SERVER_API.md` |
