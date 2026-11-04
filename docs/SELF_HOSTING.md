# Self-hosting this openGym fork

This guide installs the source in this repository on a Linux server using Docker
Compose. It does not require the author's server, domain, private keys or food
databases. The API and web images are built locally; upstream images from
`DuarteSantos8` do **not** represent this fork's Nutrition changes.

The supplied profile runs workout tracking, accounts, personal foods and recipes,
and Nutrition synchronization. **No food catalogue is included or downloaded.**
Public food search and barcode lookup are unavailable. In Nutrition, choose
**Aliments et recettes locaux** to create or reuse your own foods. The catalogue
screen can report an unavailable catalogue; this does not provide a replacement
food database.

The API runs on a Docker network without internet access. This also disables
outgoing push notifications, AI Coach providers and other API features requiring
external services. The web profile forces local food lookup and refuses catalogue
routes, so it cannot silently fall back to a food provider. This is a minimal
self-hosting profile, not a claim that every upstream feature is enabled.

## Requirements and resource budget

Use a non-root Linux account that can run Docker, with:

- Git, Python **3.11 or later**, Docker Engine and the Docker Compose plugin.
  Follow the [Docker installation guide](https://docs.docker.com/engine/install/)
  for your distribution. Host Node/npm are not required.
- At least **20 GiB free disk remaining** and **2 GiB available RAM remaining**
  during preparation and backups, plus space for the source copy and archives.
  Allow additional space and memory for image builds. Check the Docker data disk
  too if it differs from your home directory: `docker info --format '{{.DockerRootDir}}'`.
- Network access during cloning and building (image registry, Alpine packages and
  npm). Runtime food lookup does not use these services.
- For phones or remote access: a hostname you control, DNS pointing to the
  server, and a reverse proxy providing a browser-trusted HTTPS certificate.
  Passkeys work on `http://localhost`; a plain HTTP LAN IP does not support them.

The API container is limited to 512 MiB RAM and one CPU; the web container to
128 MiB and half a CPU. Builds are separate and not constrained by these runtime
limits. Build one image at a time, watch `free -h` and `df -h`, and stop if the
reserve is at risk. These limits are intended for a small personal installation;
no multi-user capacity benchmark is supplied.

## 1. Prepare a new instance

Clone this fork, then select a reviewed commit or release containing these tools.
The branch below is the current development source, not an immutable release:

```bash
git clone --branch feature/nutrition https://github.com/solhren/openGym.git "$HOME/openGym"
cd "$HOME/openGym"
git rev-parse HEAD
python3 scripts/self-hosting/prepare.py "$HOME/opengym-instance" \
  --origin https://gym.example.com
cd "$HOME/opengym-instance"
```

Replace `gym.example.com` with your hostname **before** preparing. For a test in
a browser on the Docker host itself, use `--origin http://localhost:8080` instead.
`--port 8081` changes the host port; use `http://localhost:8081` for that local test.
The default project name is `opengym-selfhost`; choose `--project another-name`
and a different port for a separate instance.

Preparation only writes a new directory. It copies tracked source files into
`source/`, excluding credentials, environment files, dependencies, test fixtures,
mobile build trees and runtime/catalogue artifacts. The instance includes a source
inventory, source commit and content hash. It never starts Docker, creates a
certificate, opens a port or calls a registry. Existing instance directories are
refused. If preparation fails, keep the partial directory for diagnosis and
choose a fresh name; do not treat a partial result as an initialized instance.

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

## 2. Build, start and inspect

```bash
dc build api
dc build web
dc up -d --no-build
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

## 4. Food catalogue: an explicit optional prerequisite

You can log Nutrition using personal foods and recipes without a public database.
There is currently **no supported one-command portable installation of the full
local catalogue**. Enabling a flag or mounting an empty directory does not install
one. Do not substitute upstream images or enable the remote relay to simulate a
local catalogue.

A future/advanced local-catalogue deployment needs all of the following:

1. Lawfully obtained SQLite generations with their original licence, source and
   attribution metadata; complete manifests; and verified byte counts and SHA-256
   digests. Do not copy someone else's personal deployment hashes as defaults.
2. A reader image containing the matching Python/SQLite FTS5 runtime, worker and
   adapter sources, and a compatible server configuration that listens on the
   container network. The minimal API image here intentionally lacks that reader.
3. Read-only mounts of verified generations, sufficient disk/RAM and measured
   startup/search behavior under the intended resource limits. Query results
   must preserve provenance and the 20-result search limit.
4. Consistent strict-local configuration in API, web and any native build, with
   no external food-provider fallback on missing/corrupt data or reader failure.

The [local catalogue prototype](dev/NUTRITION_LOCAL_CATALOG_PROTOTYPE.md) and
[private Docker beta notes](dev/PERSONAL_BETA_DOCKER.md) describe development work,
not portable installation instructions. The beta assumes pre-existing snapshots
and a personal deployment. This missing portable catalogue path remains a public
launch limitation; this guide does not claim a database of usable products ships
with the repository. No catalogue is reconstructed or downloaded by these tools.

## 5. Back up and test a restore

Back up the **whole** `data/` directory, not only `db.json`: it includes accounts,
passkeys, the session secret, workout data, Nutrition publications/partitions,
media and audit records. Guest/browser-only data is not a server backup. Source
snapshots, `instance.env`, `instance.json`, the inventory and final images should
be retained separately for recovery. A catalogue, if installed in an advanced
profile, needs its own manifests, licensed generations and recovery plan.

From the checkout or any directory:

```bash
python3 "$HOME/openGym/scripts/self-hosting/backup.py" \
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
cd "$HOME/openGym"
python3 scripts/self-hosting/prepare.py "$HOME/opengym-restore" \
  --origin https://gym.example.com \
  --restore "$HOME/opengym-instance/backups/CHOSEN-BACKUP.tar.gz"
```

Restore checks the checksum, metadata, origin and archive paths before extraction;
links and special files are refused. It never overwrites an existing directory.
It preserves data bytes but assigns private permissions to the current instance
owner. Use a compatible source revision and retain the old installation intact.

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
   directory, backup and old image tags/IDs.
3. From the new instance, validate Compose, build API then web sequentially,
   and start with `dc up -d --no-build`. Review logs and verify account/data access.
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
origin checks, corrupt/unsafe archive rejection, backup stop/resume behavior and
actual `docker compose config` parsing when the CLI is available. No image build,
container startup, live passkey ceremony or reverse proxy was run as part of this
preparation. Validate those steps on your own isolated installation before relying
on it for important data or opening access to others.
