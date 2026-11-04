# Quick start: your own openGym instance

Use a reviewed checkout containing `scripts/self-hosting/prepare.py` and the
matching account-mode API. The local `review/public-readiness` branch is not
published automatically. Once the maintainer has published that reviewed ref,
you can clone it:

```bash
git clone --branch review/public-readiness https://github.com/solhren/openGym.git "$HOME/openGym"
```

If it has not been published, use the supplied validated local checkout instead.
Do not substitute upstream images or assume `feature/nutrition` has these tools.

You need a non-root Linux account with Git, Python 3.11+, Docker and Compose.
Keep at least 20 GiB disk and 2 GiB available RAM free during operations, plus
space for sources, images and backups. These are operating reserves, not a
tested minimum server specification. Full requirements and HTTPS setup are in
[the self-hosting guide](SELF_HOSTING.md).

## Prepare and start

Set the actual checkout path. The example below is for a browser on the Docker
host. For a phone or remote browser, choose `https://gym.example.com` instead,
configure DNS and a trusted HTTPS reverse proxy, and use that hostname before
creating the first account. Passkeys are bound to the chosen hostname.

```bash
OPENGYM_CHECKOUT="/path/to/reviewed/openGym"
cd "$OPENGYM_CHECKOUT"
python3 scripts/self-hosting/prepare.py "$HOME/opengym-instance" \
  --origin http://localhost:8080 --mode personal --catalogues recommended
cd "$HOME/opengym-instance"
dc() { docker compose --env-file instance.env -f compose.yaml "$@"; }
dc config --quiet
dc build api
dc build web
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/catalogue.py" apply "$HOME/opengym-instance"
dc ps
```

Build the images separately and watch the resource reserve. No published fork
image is assumed. Docker container startup and real-device HTTPS/passkeys still
need validation by an administrator with Docker access.

`--mode personal` is the default: one owner, then registrations close. For several
people, use `--mode multi-user`; the administrator invites other accounts.
Multi-user defaults to a ceiling of 100 stored accounts (`--max-users 20` changes
it, within 2..1000). Public signup additionally requires **both** `--signup public`
and `--allow-public-signup`. The first administrator still needs the private code.
Guest access and password login are disabled in all these profiles.

`--catalogues recommended` downloads the small public Ciqual 2025 sources and
selects a verified read-only generation. It covers generic foods in the French
food supply, with official French/English labels; it is not a global branded or
barcode database. OFF and wger are currently marked experimental/unavailable.
Omit `--catalogues` for personal foods and recipes only. API internet access is
disabled, including push and AI providers; no food-provider fallback is enabled.

## First login and routine care

Open the chosen origin, create a profile with a passkey and use the invitation
read privately from the instance directory:

```bash
cat data/bootstrap-invite.txt
```

Confirm Settings → Account exposes the admin dashboard, then add another passkey
if possible. In personal mode there is no second owner. For multi-user invite
mode, generate individual invitation codes in the dashboard. With Ciqual enabled,
search for `rice` or `riz`, inspect the reference, log an amount and reload to
verify it persisted. Local foods and recipes remain available in every profile.

Back up the complete private data folder:

```bash
python3 "$OPENGYM_CHECKOUT/scripts/self-hosting/backup.py" \
  "$HOME/opengym-instance" \
  "$HOME/opengym-instance/backups/instance-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
```

Keep the archive and checksum off the server. Preserve source/image references
and `catalogues/` separately. [Test a restore, update or roll back](SELF_HOSTING.md#5-back-up-and-test-a-restore)
before relying on the instance for important data. Restores preserve recorded
account mode; old backups without one require an explicit choice and do not
remove or promote accounts.

Use `dc stop` to stop services. To uninstall containers and networks while
retaining data, take a final backup and run `dc down`; keep the instance directory.
Do not use `down -v` or global pruning as an uninstall or update step.

If catalogue configuration was interrupted, run `catalogue.py recover INSTANCE`
before inspection or application. It completes the journaled configuration,
without starting services. See the [full guide](SELF_HOSTING.md#4-manage-catalogue-selections)
for source listing, selection, removal and rollback commands.
