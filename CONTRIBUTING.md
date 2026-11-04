# Contributing to this openGym fork

This repository is [solhren/openGym](https://github.com/solhren/openGym), based on
[DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym). Nutrition development is currently
on `feature/nutrition`. An upstream release or CI badge is not evidence for this branch.

Small, focused changes are easiest to review: a reproducible bug fix, clearer documentation,
accessibility improvements, or food-data validation with synthetic fixtures.

## Before starting

Read the [README](README.md), [security policy](SECURITY.md) and the relevant implementation notes.
Check the current target branch before proposing a change. Avoid mixing a Nutrition change with
unrelated training, deployment or formatting changes.

As checked on 3 November 2026, this fork has **Issues and Discussions disabled**. Pull requests
are the available repository review mechanism; check the repository's current settings before
relying on a bug-report or discussion link. Upstream community channels belong to the upstream
project and are not a support promise for this fork. For vulnerabilities, use SECURITY.md;
never put exploit details or secrets into a pull request.

## Local development

Use Node.js 22 and npm, matching the repository's CI and Dockerfiles. The commands below use
lockfiles and omit the optional server-side AI SDK. Run them from the repository root. They do
not install a food database or native mobile SDK.

```sh
npm --prefix api ci --omit=optional
npm --prefix frontend ci
mkdir -p data/dev
DATA_DIR="$PWD/data/dev" PORT=3000 RP_ID=localhost ORIGIN=http://localhost:5173 npm --prefix api start
```

Leave the API running. In another terminal, from the repository root:

```sh
API_ORIGIN=http://localhost:5173 npm --prefix frontend run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://localhost:5173`. This is a local development setup; follow
[Self-hosting](docs/SELF_HOSTING.md) for deployment and HTTPS. Keep `data/` private and out of Git.
Use invented profiles, workouts and foods when reproducing bugs or taking screenshots.

The default development server does not provision the experimental SQLite catalogue. Personal
food and recipe workflows can be developed without it. Catalogue work needs the separately
prepared local generation and explicit mode configuration described in the self-hosting and
[implementation notes](docs/dev/NUTRITION_FOOD_CATALOG.md). Do not copy a maintainer's personal
hostnames, private paths, credentials or catalogue digests into a general setup procedure.

## Project layout

| Directory | Purpose |
| --- | --- |
| `frontend/src/views`, `components` | Screens and reusable UI |
| `frontend/src/lib`, `store` | Domain logic, Nutrition contracts, persistence and sync |
| `frontend/android`, `frontend/ios` | Capacitor platform shells |
| `api/` | Node HTTP API, account handling, Nutrition routes and optional coach |
| `web/` | Frontend container and nginx configuration |
| `catalogue/` | Exercise text, translations and separately licensed media |
| `scripts/nutrition-local-catalog/` | Experimental import, normalization and evaluation tools |
| `docs/dev/` | Design notes, historical experiments and validation limits |

## Verification

Run the checks appropriate to the files you changed. For application changes, the main checks
are:

```sh
npm --prefix frontend test
npm --prefix api test
npm --prefix frontend run build
node frontend/scripts/check-locales.mjs
git diff --check
```

For a small fix, run the relevant test files during development, then report the exact suites
you ran. MCP changes have their own package and tests in [mcp/README.md](mcp/README.md).
Documentation-only changes need a whitespace and link review; they do not require installing
mobile SDKs, importing a catalogue or rebuilding the app.

Test behavior where a mistake matters: nutrient units and unknown values; journal snapshots;
account switching; sync conflicts; quota errors; backup validation and restore. Use fixtures
without real user data. A simulator or successful web build does not establish physical-device
behavior. For camera or native changes, state the actual OS, device/build and scenario tested,
and clearly identify any missing platform checks.

Click through changed UI where possible, including keyboard focus, cancellation, narrow screens
and both themes. Put new user-visible strings in all relevant locale packs; preserve placeholders
and follow the existing Brazilian Portuguese inheritance rules.

## Change guidelines

- Keep pure calculations separate from I/O. Validate untrusted data before it becomes a Food,
  Recipe, journal entry or portable backup record.
- Preserve immutable history, source/license metadata, account isolation and pending sync
  operations. A missing provider value must not silently become zero.
- Prefer the surrounding code style and existing dependencies. Explain any new dependency.
- Do not commit data directories, `.env` files, tokens, keystores, personal exports, large source
  dumps or generated catalogue databases. Redact diagnostics before sharing them.
- Do not add or replace `catalogue/media/`. Its third-party license is separate from the code.
  See [NOTICE.md](NOTICE.md). Exercise text and translation changes go through
  [catalogue/README.md](catalogue/README.md); do not edit generated exercise modules by hand.
- Preserve the original project's copyright and notices. A source-code contribution does not
  relicense third-party food data, diagrams, exercise text or images.

## Pull requests and bug evidence

Describe the concrete problem, resulting behavior and validation. Include the target branch,
commit/build, browser or native OS, reproduction steps, expected result and observed result.
State whether catalogue transport was simulated, remote-provider mode or local `wger-v1` mode.
Use redacted configuration names and synthetic records; do not attach your full server data or
backup. Separate measured results from assumptions and remaining device checks.

AI-assisted contributions are welcome under the same review standard: understand the code,
verify the change and explain its effects. Do not submit copied code or data without a compatible
license and required attribution.

Your application-code contribution is offered under the existing project's GNU AGPL terms; see
[LICENSE](LICENSE). Third-party contributions must retain their own applicable notices and terms.
