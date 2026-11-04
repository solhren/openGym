# Security policy

This policy applies to **solhren/openGym** and its experimental Nutrition branch. It does not
promise support from the upstream openGym maintainer or cover a third party's hosted instance.

## Reporting availability

**Checked 3 November 2026:** GitHub private vulnerability reporting is disabled for this fork.
Issues and Discussions are also disabled. No alternative private security contact has been
verified for this repository. Do not send sensitive findings to an invented email address,
an upstream community room or a public pull request.

Check this repository's [Security page](https://github.com/solhren/openGym/security) for an updated
policy and a **Report a vulnerability** button before submitting details. GitHub's private report
form is available only when the repository enables it; see
[GitHub's reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).
If no private channel is available, retain the sensitive details until the maintainer publishes
one. A verified private channel is an outstanding requirement before a public beta announcement.

Do not include passwords, session cookies, pairing codes, tokens, private keys, `.env` files,
personal meal history, photos or complete data directories in a report. A useful report contains
the affected commit/build, deployment mode, minimal reproduction with synthetic data, impact,
and relevant redacted logs. Use your own test instance and accounts.

## Version and response policy

The Nutrition work is an experimental branch. There is no declared supported release range,
maintenance schedule, response deadline or bounty for this fork. An inherited package version
or upstream release tag does not identify a maintained release of this branch. Record the exact
commit and image/build identity when reporting a problem. Review changes and back up data before
upgrading; follow the [self-hosting guide](docs/SELF_HOSTING.md).

## Security model

- **The operator is trusted.** Server data is accessible to the host administrator. Workouts,
  Nutrition and backups are not end-to-end encrypted. Restrict host, volume and backup access.
- **Transport needs HTTPS.** Configure the exact origin and passkey relying-party hostname.
  Plain HTTP on a network can expose passwords, pairing codes and session credentials.
  `localhost` development is different from an unsecured LAN hostname or address.
- **Passkeys do not encrypt journal data.** Their private keys stay with the authenticator, but
  protecting sign-in does not prevent an operator or compromised host reading server files.
- **Guest data is local.** Clearing browser/site data or uninstalling the app can remove local
  history. Local storage and device-private files are not a substitute for exported backups.
- **Nutrition uses separate storage and sync.** A regular workout backup or an apparently healthy
  workout sync does not prove Nutrition was backed up or synchronized. Check Nutrition status
  and use its backup flow. Combined dataset restore remains blocked.
- **Food data is untrusted input.** Validation, immutable snapshots and content hashes help detect
  malformed records or accidental corruption. Hashes do not prove a publisher's identity or
  the nutritional accuracy of a source record.
- **External services depend on configuration.** The opt-in local `wger-v1` catalogue mode uses
  the local SQLite worker without an external food-provider fallback during use. The historical
  provider mode can send searches/barcodes to Open Food Facts. Confirm which mode you run.
- **AI and integrations are optional.** A configured coach can send selected data to its provider;
  an enabled MCP client can read the data exposed by that integration. Check configuration and
  provider terms before enabling either. Optional build-time analytics also depend on operator
  configuration; do not infer a universal privacy guarantee from a default build.

Authentication, cross-profile access, malicious imports, unsafe catalogue paths or network
requests, script injection, and unintended public deployment exposure are all relevant security
concerns. Report a concrete dependency vulnerability with its affected runtime path when possible;
scanner output alone does not establish exploitability. These notes do not certify that the
application has had a complete security audit.

## Operating an instance

Keep the API behind the intended web/reverse proxy boundary, use HTTPS for remote access, and
limit public registration deliberately. Validate proxy trust, allowed origins, admin assignment,
file permissions, request limits and backup recovery for your environment. Do not expose data
directories or catalogue generation files as a static download. A catalogue manifest or checksum
is not a credential or an authorization boundary.

Public food search can consume resources even when personal records require authentication.
Review rate limits, timeouts and worker bounds before making it public. Separately prepared
catalogues can be large; do not grant import/upload or arbitrary filesystem access to visitors.

The existing tests include simulations and bounded local HTTP checks. A personal Android beta
and an individual scanner test do not prove iOS support, every device's storage behavior, physical
power-loss durability or the safety of an internet-facing multi-user deployment. Validate your
actual configuration and keep a recovery copy before relying on the beta.
