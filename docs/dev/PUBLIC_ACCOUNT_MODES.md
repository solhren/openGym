# Public account modes

These modes are opt-in backend policies for a public self-hosted installation. They are
independent of `OPENGYM_PRIVATE_BETA`. Without `OPENGYM_INSTANCE_MODE`, historical flags,
responses and beta behavior remain unchanged. Do not combine an explicit mode with the beta.

| Setting | Personal | Multi-user, invitations | Multi-user, public signup |
| --- | --- | --- | --- |
| `OPENGYM_INSTANCE_MODE` | `personal` | `multi-user` | `multi-user` |
| `OPENGYM_SIGNUP_POLICY` | `invite` | `invite` (default) | `public` (explicit) |
| `OPENGYM_MAX_USERS` | `1` | `100` default; integer 2–1000 | `100` default; integer 2–1000 |
| First registration | Private bootstrap invitation | Private bootstrap invitation | Private bootstrap invitation |
| Later registration | Closed | Unused, unrevoked invitation | Open until the account limit |
| Guest transport | Disabled | Disabled | Disabled |

`INVITE_ONLY=1` may remain set for all three profiles. Explicit modes calculate the effective
policy: even public signup needs a valid invitation until the first account exists. That
account becomes administrator. No later ceremony becomes administrator, including ceremonies
prepared before the first account was committed. Both registration paths recheck the policy,
invitation and account limit immediately before adding the account, after asynchronous
verification or password hashing. Personal ownership is persisted as `db.instanceOwner`.

Public signup spends a separate in-memory budget after bootstrap: 10 registration requests
per address per hour and 100 per instance per hour. Options and verification each count;
password registration counts once. Invalid same-origin attempts also count. These budgets
reset on API restart and do not pause passkey sign-in, pairing or device recovery. They are
bounded abuse controls, not a CAPTCHA or an identity check. Invitations remain the default.
The existing password sign-in limits apply independently when passwords are enabled.

`TRUST_PROXY=0` uses the connection address and ignores forged forwarding headers. With this
default, clients behind a reverse proxy share its registration budget. An operator choosing
to trust proxy headers must ensure that untrusted clients cannot supply them directly; this
change does not alter the existing proxy trust rules.

## Configuration and storage

`GET /api/config` adds `instance_mode`, `signup_policy`, `max_users` and
`registration_open` in explicit modes. `invite_only` is dynamic: true before bootstrap,
false afterwards only for public multi-user signup. `registration_open` is false once the
personal owner exists or the multi-user account limit is reached. `allow_guest` is false.
These public fields describe policy, without exposing invitations or account identities.

`OPENGYM_LISTEN_HOST` accepts only `127.0.0.1` (default) or `0.0.0.0`. The container profile
must explicitly use `0.0.0.0`; local tests use `127.0.0.1`. HTTPS, the reverse proxy and a
stable, correct WebAuthn `ORIGIN`/`RP_ID` remain deployment requirements. Host binding does
not configure TLS. In explicit modes this host setting also takes precedence over the
catalogue listener setting.

`DATA_DIR` must be an absolute, normalized path other than `/`, with no symlink ancestor.
The directory must be private (no group/other permissions); a newly created directory uses
0700. The API refuses an existing public directory rather than silently changing host mount
permissions. Secret/database writes and managed-mode workout state writes use 0600.
Nutrition's existing private storage permissions are unchanged.

An existing nonempty database must already contain an administrator. Account identifiers
must be unique and safe; orphan credentials in an otherwise empty database are refused.
Personal mode refuses a database with multiple users or a conflicting owner marker. It
never deletes accounts or promotes an existing user to make a restore fit. A unique existing
administrator may use personal mode without rewriting their account. Lowering a multi-user
limit below the existing count closes signup and keeps existing accounts and sessions.
Back up and inspect restored policy metadata before startup; do not use mode changes to
silently migrate or discard users.

## Isolation and administrator permissions

Authenticated workout and Nutrition routes derive the profile from the current session.
Another profile ID in a query does not select that profile. Nutrition documents are scoped
to the authenticated profile and origin; an administrator is subject to the same boundary.
Paired devices share the same profile and session version, without creating another user.

In explicit modes, `GET /api/admin/users` returns `account_only: true` and account metadata:
identity, creation time, disabled/admin status and invitation reference, plus password/email
metadata only when password login is enabled. It omits training statistics, live presence,
last synchronization and push status. `GET /api/admin/user?id=...` returns only
`{ account_only: true, user: { ...account metadata } }`; it does not read or export workout,
body-weight or Nutrition history. Legacy deployments retain their historical admin exports.
Administrators can manage invitations and disable or delete other accounts, subject to the
existing self/last-admin protections. Personal mode cannot create new invitations.

This removes direct administrative API reads of another person's history; it is not an
end-to-end encryption guarantee. The host and backup operator can read stored files. If the
operator explicitly enables `PASSWORD_LOGIN=1`, an administrator can issue a one-use reset
for a nonadministrator, including a profile previously using only passkeys. Redeeming it
gives access to that profile. Reset issuance revokes its old sessions, preserves passkeys and
is audited as `admin.password.reset`; successful redemption is `auth.password.reset`. Only
a reset-code hash is persisted, and the code is not put in the audit log. This recovery power
must be disclosed to users of password-enabled instances.

Disabling an account denies its cookie and paired bearer access while disabled. Deleting an
account removes its credentials, workout state, Coach credentials and media, and closes
access. It does **not** purge immutable Nutrition versions or operator backups. The current
delete action is not a complete historical-data erasure service.

## Recovery limits

The default profile is passkey-only. Register a second passkey while access works and retain
tested backups. An authenticated owner can authorize a device link using fresh passkey
proof (or their existing password when enabled). The link expires after ten minutes and adds
a passkey to the same profile; it cannot choose another account or reopen personal signup.
It is single-use. Phone pairing codes expire after five minutes and are also single-use.
Pairing grants a session; adding a lasting passkey still requires fresh owner proof.

Sign out everywhere revokes cookie and paired bearer sessions, pending pair codes and device
links. With passwords disabled, password-reset endpoints return 404. If every usable passkey
and owner proof is lost, there is no unauthenticated reset or administrator passkey override.
An already paired device may keep data access, but does not by itself replace owner proof for
adding credentials. Recover using a previously enrolled authenticator or an operator-reviewed
backup; a database restore can also roll back revocation state. Keep the original public
origin and review/revoke sessions after restoration. A backup is sensitive and cannot replace
an authenticator's private key that was never stored in it.

## Reproducible verification

From the checkout root, using Node 22 and the locked API dependencies:

```sh
node --test --test-concurrency=1 api/test/public-account-modes.test.js
node --test --test-concurrency=1 api/test/server-first-user-admin.test.js api/test/server-config-session.test.js api/test/server-admin-state.test.js api/test/server-admin-delete.test.js api/test/server-passkeys.test.js api/test/server-pairing.test.js api/test/server-password.test.js api/test/server-session-revocation.test.js
```

The new HTTP fixture uses disposable private directories, software WebAuthn credentials and
loopback listeners. It covers prepared/concurrent signup, first-admin bootstrap, invitation
revocation/replay, password-hash races, reduced capacity, two-account workout/Nutrition
isolation including the administrator, metadata-only admin responses, disable, recovery,
session revocation, password reset/audit, permissions and conservative startup refusals.
It does not certify hardware authenticators, TLS, Docker deployment or a production restore.
