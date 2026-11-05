# Browser-only demo

The fork's static demo is prepared for GitHub Pages. **It is not published yet.**
It runs the real interface and local persistence, with fictional workout history,
four editable example foods (including one with an unknown nutrient), a recipe
and two breakfast entries. Examples are not dietary advice or a verified food catalogue.
Sample names are French when first opened in French, otherwise English.

You can create foods, log quantities in g/ml, edit/delete entries, make recipes,
set goals, explore workouts and use Nutrition's backup preview/export/restore.
Changes stay in this browser (localStorage for training, IndexedDB for Nutrition).
Clearing site data can lose them. Do not enter private health information into a demo.

No account, API, remote food search, scanner, server synchronization or bulk catalogue
is provided. The inherited Coach demonstration uses scripted local responses, not AI.
Exercise illustrations are replaced with a project-owned neutral SVG; restricted
exercise photos/videos are not staged for this deployment.

## Try locally

Use Node.js 22 and the repository's locked frontend dependencies:

```sh
npm --prefix frontend ci
npm --prefix frontend run build:demo
npm --prefix frontend run preview -- --outDir dist-demo --host 127.0.0.1 --port 5177 --strictPort
```

Open `http://localhost:5177/#/nutrition`. On a remote development machine, forward
`ssh -L 5177:127.0.0.1:5177 USER@HOST`; this does not use the production backend.
Always serve the demo on **its own origin**, never over an existing openGym installation:
the inherited workout demo shares that origin's workout storage keys. Nutrition uses
a distinct `demo-…` namespace and seeds only an empty durable store, atomically.
The Settings demo reset restores **workout** examples; it does not erase Nutrition.

The build ignores `.env` files and inherited `VITE_*` flags. Output: `frontend/dist-demo/`.
Do not copy private files or `catalogue/media` into it. API transports reject requests
in demo builds and the Nutrition picker exposes only local foods/recipes.

## Maintainer publication (pending)

The dedicated manual `demo-preview.yml` workflow builds this folder and can publish it
to GitHub Pages only in `solhren/openGym`, when launched by `solhren` from
`review/public-readiness`. It has no production/VPS access and uses no private secrets.
It does not publish the inherited upstream demo or change `main`.

Before publishing, verify the authenticated GitHub account is `solhren`. Review and push
the source changes. A workflow must exist on the repository's default branch before
GitHub exposes its manual dispatch; changing that branch or merging the workflow is
a separate maintainer decision ([GitHub's manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)). Under Settings → Pages, select **GitHub Actions**.
Run **Browser-only demo** on `review/public-readiness`, first with publication disabled
to inspect the artifact, then explicitly enable publication. Use the deployment's
reported URL; do not advertise a live demo before it succeeds.
The `github-pages` environment must allow the reviewed branch; deployment permissions
follow [GitHub's Pages workflow requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Validation

Executed locally on 5 November 2026 with Node 22.23.3:

- Targeted frontend suite: **93 passed, 10 files, 0 failed/skipped** (21.09 s).
  Covers the seed, units/unknowns, concurrency, interrupted write retry, preserved edits,
  API blockade and existing App/guest, Nutrition, media and exercise behavior.
- After the final demo-only status display change, the Nutrition component file was
  rerun: **25 passed**, 0 failed/skipped (7.92 s). These 25 are a subset of the 93,
  not additional unique tests.
- Additional ordinary API media/mobile regressions: **11 passed, 2 files**, 0 failed/skipped
  (2.88 s). These are different tests from the 93 above.
- Publication-policy tests: **10 passed**, 0 failed/skipped. The new workflow remains
  manual, owner/repository/branch guarded, with deployment disabled by default.
- Static build succeeded, including with deliberately incompatible mobile/personal/
  analytics `VITE_*` environment flags supplied to the wrapper: they were stripped.
  Output is about **24 MiB**, mostly language/exercise text; no exercise videos,
  SQLite catalogue or private files are staged. Existing large-chunk and mixed
  static/dynamic-import warnings remain; this is not a bundle-size optimization.
- Real **Chromium 156.0.8078.4**, disposable browser profile, static server only:
  Pages-style `/openGym/` path, Home → Nutrition, local search, 200 ml intake, quantity edit, confirmed deletion,
  personal food creation and reloading all passed with real IndexedDB. Four widths
  (360/390/768/1440 px) had no horizontal overflow. Light/dark screenshots captured.
  Zero API/external requests and zero unhandled page errors during this sequence.
  Earlier harness attempts used incorrect link/searchbox/exact-label selectors;
  these were fixed to match the real UI; they were not application crashes.

Reproduce the targeted checks from the repository root:

```sh
npm --prefix frontend test -- --maxWorkers=1 \
  src/lib/nutrition/demo-seed.test.js src/lib/api.demo.test.js \
  src/lib/nutrition/use-nutrition.test.jsx src/lib/nutrition/ui-session.test.js \
  src/views/Nutrition.test.jsx src/App.guest.test.jsx src/lib/api.test.js \
  src/lib/demoSeed.test.js src/components/Media.test.jsx src/lib/exercises.clip-ext.test.js
npm --prefix frontend test -- --maxWorkers=1 src/lib/api.media.test.js src/lib/api.mobile.test.js
node --test scripts/publication/check.test.mjs
```

For the real browser check, use an **existing trusted Playwright installation and
its Chromium binary** (optional developer tool, not a project dependency):

```sh
npm --prefix frontend run build:demo
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/demo/browser-smoke.mjs
```

Set `PLAYWRIGHT_BROWSERS_PATH`/loader-library paths only if your local Playwright
installation requires them. The harness opens only a random loopback port, rejects
API/external requests, uses disposable browser storage, retains synthetic screenshots
under the ignored prototype runtime directory and closes its server/browser in `finally`.
Do not interpret it as Firefox/Safari, HTTPS service-worker or Android acceptance.

First-run French/English sample naming is covered by deterministic seed tests;
existing example names intentionally do not change when the UI language changes.
Locale validation: **18 locales × 2,467 keys**, synchronized. `git diff --check` passed.
The full frontend/API suites were not repeated for this demo-only change.
No production deployment, Docker build or Android test is required for this static demo.
