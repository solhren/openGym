# Self-hosting this openGym fork

This guide installs the source in this repository on a Linux server using Docker
Compose. It does not require the author's server, domain, private keys or food
databases. The API and web images are built locally; upstream images from
`DuarteSantos8` do **not** represent this fork's Nutrition changes.

The installation runs workout tracking, accounts, personal foods, recipes and
Nutrition synchronization. To add a searchable public food database, follow the
explicit Ciqual acquisition step below. **No database is bundled in Git or
silently downloaded at startup.** The sources are acquired from their public
publisher, independently of any private openGym server.

Ciqual 2025 covers about 3,484 generic foods in the French food supply. Official
French and English names support search; users can keep their own application
language. This is not a global product database: it has no packaged-brand or
barcode coverage. References are per 100 g, including drinks; no density or
100 ml conversion is invented. The inspector reports how many foods have usable
or complete nutrition; unavailable nutrients remain unknown.

The API runs on a Docker network without internet access. This also disables
outgoing push notifications, AI Coach providers and other API features requiring
external services. Both web profiles force local food lookup: the personal-foods
profile refuses catalogue routes, while the Ciqual profile uses an authenticated
local reader. Neither falls back to a remote food API.

## Requirements and resource budget

Use a non-root Linux account that can run Docker, with:

- Git, Python **3.11 or later**, Docker Engine and the Docker Compose plugin.
  Follow the [Docker installation guide](https://docs.docker.com/engine/install/)
  for your distribution. Host Node/npm are not required.
- At least **20 GiB free disk remaining** and **2 GiB available RAM remaining**
  during preparation and backups, plus space for the source copy and archives.
  Allow additional space and memory for image builds. Check the Docker data disk
  too if it differs from your home directory: `docker info --format '{{.DockerRootDir}}'`.
- Network access during cloning/building (registries, Alpine and npm), and during
  the explicit Ciqual acquisition (Anses public sources, under 4 MiB compressed
  in total). The bootstrap uses Python's standard library, with bounded download,
  parsing and database sizes. Runtime food lookup has no provider connection.
- For phones or remote access: a hostname you control, DNS pointing to the
  server, and a reverse proxy providing a browser-trusted HTTPS certificate.
  Passkeys work on `http://localhost`; a plain HTTP LAN IP does not support them.

The API container is limited to 1 GiB RAM with Ciqual, or 512 MiB without a public
catalogue, and one CPU. The web container uses 128 MiB and half a CPU. An empty
registry retains the 1 GiB reader profile so removing a source cannot enable a
remote relay. Builds are separate and not constrained by these runtime limits. Build one image at a time, watch `free -h` and `df -h`, and stop if the
reserve is at risk. These limits are intended for a small personal installation;
no multi-user capacity benchmark is supplied.

## 1. Prepare a new instance

Use a reviewed checkout or future tagged release **containing these tools**.
These changes are currently prepared locally, not published as a release; a clone
of `feature/nutrition` may not contain them. Obtain the validated checkout before
running this guide. Upstream images and the root Compose file are not substitutes.

Set the path to that checkout (keep this variable in your terminal):

```bash
OPENGYM_CHECKOUT="/path/to/reviewed/openGym"
cd "$OPENGYM_CHECKOUT"
test -f scripts/self-hosting/catalogue.py
git rev-parse HEAD
python3 scripts/self-hosting/prepare.py "$HOME/opengym-instance" \
  --origin https://gym.example.com --catalogues recommended
cd "$HOME/opengym-instance"
```

`--catalogues recommended` explicitly acquires the currently recommended public
source, Ciqual 2025. `--catalogues ciqual` is equivalent. A comma-separated list is
accepted only for sources marked available in the supplied descriptors; currently
OFF and wger remain experimental/unavailable. They are not silently downloaded or
accepted as working BYO installations. Omit `--catalogues` or use `none` for only
personal foods and recipes.

Replace `gym.example.com` with your hostname **before** preparing. For a test in
a browser on the Docker host itself, use `--origin http://localhost:8080` instead.
`--port 8081` changes the host port; use `http://localhost:8081` for that local test.
The default project name is `opengym-selfhost`; choose `--project another-name`
and a different port for a separate instance.

Preparation only writes a new directory. It copies tracked source files into
`source/`, excluding credentials, environment files, dependencies, test fixtures,
mobile build trees and runtime/catalogue artifacts. The instance includes a source
inventory, source commit and content hash. It never starts Docker, creates a
certificate or opens a port. Without `--catalogues`, it performs no download;
with an explicit catalogue choice, it acquires and verifies that public source
and validates Compose using the Docker client, without contacting the daemon.
Existing instance directories are refused. If preparation fails, keep the partial directory for diagnosis and
choose a fresh name if source preparation was incomplete. If only acquisition
failed after `instance.json` and `instance.env` were written, retry `catalogue.py
add INSTANCE ciqual`; do not recreate or overwrite account data.

The instance directory is private (0700); `instance.env` and account files use
0600. `data/` is a bind mount owned by the same non-root account that prepared the
instance. Keep its location and ownership stable. The absolute paths in
`instance.env` refer only to **your** instance. Moving it requires updating
`OPENGYM_SOURCE` and `OPENGYM_DATA_DIR` while the stack is stopped.

Define this convenience function in the current terminal:

```bash
dc() { docker compose --env-file instance.env -f compose.yaml "$@"; }
dc config --quiet
```

Do not use the repository's root `docker-compose.yml` or the private-beta scripts
for this procedure. Those are different deployment profiles.

## 2. Choose Nutrition mode, build and start

If you prepared with `--catalogues recommended`, Ciqual is already selected.
Otherwise, add searchable generic foods explicitly before building:

```bash
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" add "$HOME/opengym-instance" ciqual
dc config --quiet
```

This command runs the bootstrap from the instance's frozen `source/` snapshot,
verifies it offline, then prepares the catalogue Compose configuration. It does
not start Docker services. The downloaded cache and first generation live in
`catalogues/ciqual-2025/`.
A small independent snapshot is retained under `catalogues/ciqual-2025-<hash>/`;
`catalogues/registry.json` selects active snapshots. The API mounts `catalogues/`
read-only at `/catalogues`; account data stays separately in `/data`. It uses
`NODE_ENV=production`, not the historical private-beta configuration.
Compose explicitly selects `OPENGYM_CATALOG_LISTEN_HOST=0.0.0.0` inside the private
container network; the API has no host port. Direct host runs default to loopback.

If acquisition or inspection fails, the previous Compose configuration remains
selected. Read the error, keep the incomplete source files for diagnosis and
retry `catalogue.py add INSTANCE ciqual` after resolving the cause. If the server
cannot resume a partial download or the build was interrupted, use `add INSTANCE
ciqual --restart`; this discards only unpublished partial work. A partial download
or database is never a usable catalogue. No private snapshot or upstream API key
is needed. Do not bypass a checksum or licence error.

To run with **personal foods and recipes only**, prepare without `--catalogues`
and skip acquisition. In Nutrition,
choose **Aliments et recettes locaux** (or its translated label). Public food
search will report an unavailable catalogue and barcode lookup is unavailable.
You can add Ciqual later with the command above, then rebuild/recreate both
services below. Existing account and Nutrition data are retained.

```bash
dc build api
dc build web
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" apply "$HOME/opengym-instance"
dc ps
curl --fail http://127.0.0.1:8080/api/health
```

Use the chosen port if different. Both services should become healthy. For
troubleshooting use `dc logs --tail=100 api web`; keep logs private. `dc stop`
stops the instance while retaining data. The web port is bound to **127.0.0.1**;
the API has no published port.

The build uses npm lockfiles. Base image tags and Alpine package repositories can
change: this is not a bit-for-bit reproducible build. For controlled releases,
set `NODE_IMAGE` and `NGINX_IMAGE` in `instance.env` to reviewed compatible
`image@sha256:digest` references before building, and retain the resulting local
images and image IDs. There are no required personal image or catalogue digests.

## 3. HTTPS and the first account

Configure a reverse proxy **on the Docker host** to forward your HTTPS hostname
to `http://127.0.0.1:8080`. A minimal Caddy example is copied into
`Caddyfile.example`:

```caddy
gym.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy installation and certificate issuance are separate administrator steps;
see [Caddy's HTTPS documentation](https://caddyserver.com/docs/automatic-https).
Ensure DNS and required firewall ports are correct. An existing nginx, Traefik or
other proxy can also forward to the loopback web port. A proxy in a separate
container cannot use its own `127.0.0.1` to reach this port; connecting it to this
stack requires an explicitly reviewed network configuration. Subpath deployment
is not configured by this profile.

The outer proxy should allow at least 5 MiB request bodies for synchronization,
48 MiB for `/api/media/` and sufficient time for media uploads.

### Phone app and CORS

Forward `/api/` and `OPTIONS` unchanged; do not add duplicate CORS headers or a login redirect
in front of API routes. The application supplies its own authentication.

Native app pairing requires a compatible separately built app and an authenticated
browser account; this guide does not distribute a mobile binary. Pairing and HTTPS
on a real phone have not been tested for this profile.

### Create the first account

Open `https://gym.example.com` and create a profile using a passkey. When asked
for an invitation, read it privately on the server:

```bash
cat data/bootstrap-invite.txt
```

No account or password is pre-created. Registration requires the generated
128-bit invitation; the first completed profile becomes an administrator. The
invitation is consumed by registration. In Settings → Account, confirm the admin
dashboard is available, add another passkey if possible, and revoke any unused
invitations. New users require an invitation generated by an administrator.
`bootstrap-invite.txt` remains a private record, not a reusable invitation after
it is consumed. Do not send it in a bug report.

Pick the hostname before registering: passkeys are bound to its `RP_ID`.
`OPENGYM_ORIGIN` must match the exact browser origin, including a non-default
port. Changing a hostname does not migrate existing passkeys. Password sign-in
and guest mode are disabled by this profile.

## 4. Manage catalogue selections

List public sources and your selections, or verify selected generations offline:

```bash
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" list "$HOME/opengym-instance"
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" inspect "$HOME/opengym-instance"
```

Source descriptors report geography, languages, search/barcode features, download
and workspace budgets, licence and availability. Ciqual is available by a direct,
pinned publisher download. OFF and wger are explicitly experimental/unavailable
in this installer; large imports or private snapshot hashes are not a portable
installation method. The registry format supports up to eight selected sources,
but this does not imply that eight downloadable datasets are provided today.

Inspection reports the generation SHA-256, row count, usable/complete food counts,
languages and licence. The bootstrap retains source information and attribution
in the manifest, receipt and `NOTICE.txt`. Keep these with the database. Ciqual
uses **Licence Ouverte / Open Licence Etalab 2.0**; it is an Anses dataset, not an
openGym-owned or manufacturer-verified corpus.

An enabled source that is missing, corrupt or unsupported prevents the strict API
profile from starting; it never activates only part of a requested selection.
Reader failures return local-unavailable errors without calling a provider.
The readiness probe checks writable account storage, invitation policy and
catalogue authentication; an anonymous catalogue request must return 401. After
first login, search for a generic food such as `rice` or `riz`, inspect its
reference, add an amount, save it and verify it persists after reloading. This
signed-in check is separate from container readiness.

To reuse a retained, independently acquired Ciqual generation:

```bash
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" use \
  "$HOME/opengym-instance" "$HOME/opengym-previous/catalogues"
```

`use` verifies the input and retains an independent snapshot of the small Ciqual
generation, capped at 64 MiB. It preserves the original directory. To restore an
exact retained hashed snapshot, use this command instead:

```bash
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" use-generation \
  "$HOME/opengym-instance" "$HOME/opengym-previous/catalogues/ciqual-2025-HASH"
```

Replace `HASH` with a retained directory name from that installation. Old registry
files and generation snapshots are retained for recovery. Saved foods, recipes and account documents
are never migrated or deleted by catalogue selection changes.

The registry, Compose configuration and instance metadata are separate files.
Each replacement is atomic; the three-file update is protected by a durable
journal and committed SHA-256 hashes, rather than a single filesystem operation.
An interrupted update blocks `apply` and `inspect` before any container action.
To finish the exact prepared update without touching account data:

```bash
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" recover "$HOME/opengym-instance"
```

Recovery verifies the journal hashes, selected generations and consistency of
the registry, metadata, reviewed source, origin and Compose configuration. It
does not start services. Keep the journal if recovery refuses it; do not delete
the marker or bypass the check with a raw Compose start. Re-run `inspect`, then
use `apply` when ready. `list` reports `configurationPending` during an update.

To deselect a source, or deselect every source:

```bash
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" remove "$HOME/opengym-instance" ciqual
# Alternative: deselect every registered source.
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" disable "$HOME/opengym-instance"
```

Removal records a disabled entry and keeps its files. An empty/disabled registry
stays in strict local mode: catalogue reads are unavailable and there is no remote
fallback. Personal foods and recipes remain available. An old single-Ciqual
selection is converted to a registry by `use` or `add`; account data needs no
migration.

These operations prepare configuration without changing running services. From
the instance directory, build the selected images separately, then explicitly
apply the selection (this recreates API and web):

```bash
dc build api
dc build web
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" apply "$HOME/opengym-instance"
dc ps
```

Configuration is resolved into `compose.yaml`. After changing base-image pins or
other environment settings, re-run the selection operation before building.
There is no scheduled update or automatic image build. Keep old directories,
registry snapshots, image tags and IDs for rollback; do not prune them while they
are your recovery plan.

The [wger/OFF prototype](dev/NUTRITION_LOCAL_CATALOG_PROTOTYPE.md) and
[private Docker beta notes](dev/PERSONAL_BETA_DOCKER.md) describe a separate,
advanced corpus. This installer does not download millions of branded products,
reconstruct the author's databases, or claim global branded/barcode coverage.

## 5. Back up and test a restore

Back up the **whole** `data/` directory, not only `db.json`: it includes accounts,
passkeys, the session secret, workout data, Nutrition publications/partitions,
media and audit records. Guest/browser-only data is not a server backup. Source
snapshots, `instance.env`, `instance.json`, the inventory and final images should
be retained separately for recovery. The account archive records the selected
registry entries and generation hashes, but does not copy public databases. Preserve
the whole `catalogues/` directory separately, including registry snapshots,
sources, manifests, receipts and licence notices, for catalogue rollback.

From the checkout or any directory:

```bash
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/backup.py" \
  "$HOME/opengym-instance" \
  "$HOME/opengym-instance/backups/instance-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
```

The tool validates Compose, confirms its API mount, stops the API for a consistent
archive, and restarts it if it was running, even when archiving fails. A previously
stopped API stays stopped. The web can briefly return 502 during this maintenance.
The output and its `.sha256` sidecar are private. `.partial` files indicate a
failed/incomplete backup. Copy the archive **and checksum** to private storage on
another machine; checksums detect accidental corruption, not malicious replacement.
Do not place backups under `data/`. Archives are not encrypted by this tool.

Test recovery into a new directory with the **same origin**:

```bash
cd "$OPENGYM_CHECKOUT"
python3 scripts/self-hosting/prepare.py "$HOME/opengym-restore" \
  --origin https://gym.example.com \
  --restore "$HOME/opengym-instance/backups/CHOSEN-BACKUP.tar.gz"
```

Restore checks the checksum, metadata, origin and archive paths before extraction;
links and special files are refused. It never overwrites an existing directory.
It preserves data bytes but assigns private permissions to the current instance
owner. Use a compatible source revision and retain the old installation intact.
The new instance starts in personal-foods-only mode; `instance.json` records the
backup's catalogue selection under `restoredCatalogue`. Before building, run
`catalogue.py use` with your retained catalogue root, or acquire Ciqual again and
compare its generation hash with the backup. Acquiring the latest source is not
an exact recovery of an older generation.

Stop the old stack before starting the recovered one with the same project name
and port. In the new directory, redefine `dc` as above, validate, build and start.
Verify the passkey login, workout history, personal foods/recipes and media before
accepting new writes. A restored session secret can keep old sessions valid;
signing out everywhere revokes them. Restoring a backup may revive credentials
or sessions revoked after that backup; keep the recovered instance private until
account access has been reviewed.

## 6. Updates and rollback

Do not run `git pull` inside an instance's `source/` snapshot. Keep it as the
reviewed source used for that release. Use a separate checkout to select and
review the next commit. Reuse the preparation/restore procedure for an update:

1. In the old instance directory, run `dc stop` to stop writes. Make a fresh
   backup with `backup.py`; because the API is stopped, it remains stopped.
2. From the updated checkout, prepare a **new** instance directory with the same
   origin, project name and port and `--restore` that fresh archive. Keep the old
   directory, backup and old image tags/IDs. Re-select the retained read-only
   catalogue with `catalogue.py use NEW_INSTANCE OLD_INSTANCE/catalogues`.
3. From the new instance, validate Compose, build API then web sequentially,
   and start with `catalogue.py apply NEW_INSTANCE`. Review logs and verify account/data access.
4. If validation fails before accepting new writes, stop the new instance and
   start the old Compose configuration. Its previous source, image tags and
   unchanged data directory remain available.

Once writes have been accepted on the new version, switching to the old data
would discard those changes. Take a fresh backup first and check data-format
compatibility; there is no automatic backward migration. Keep both instances
stopped while choosing a recovery point. Do not rebuild or delete the images
needed for rollback and never use `down -v`, prune or a data reset as an update step.

## Validation of the supplied tools

Run the synthetic tests without starting any service:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s scripts/self-hosting/tests -v
```

They exercise invitation preparation, source isolation, archive round trips,
origin checks, corrupt/unsafe archive rejection, backup stop/resume behavior,
catalogue selection/failure/reuse, registry migration/removal, interrupted
three-file publication and recovery, ambient environment isolation, and actual
`docker compose config` parsing when
the CLI is available. Deployment tests use a tiny synthetic catalogue inspector;
the acquisition/parser and reader have separate tests. No image build,
container startup, live passkey ceremony or reverse proxy was run as part of this
preparation: the Docker client is available, but the local daemon socket refused
access. The build/start/HTTPS/login commands above are the outstanding checks
for a Docker-enabled administrator, not recorded successful deployments. Validate
those steps on an isolated installation before relying on it for important data
or opening access to others.
