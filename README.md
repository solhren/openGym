# openGym — training and nutrition, on your own server

Plan workouts, log sets and body weight, and keep a food journal in one self-hosted app.

This is [solhren/openGym](https://github.com/solhren/openGym), a fork of
[DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym). Duarte Santos and the upstream
contributors built the original application. This fork adds an experimental Nutrition workflow
and local food-catalogue integration. The application code retains its GNU AGPL license;
third-party data and media have separate terms.

**Status: experimental beta on `feature/nutrition`.** The upstream `main` branch, upstream demo,
container tags and APK releases do not establish what is included or tested in this fork.
There is no general public release or public Nutrition catalogue download promised here.

[Get started](#quick-start) · [FAQ](docs/FAQ.md) · [Self-hosting](docs/SELF_HOSTING.md) ·
[Contribute](CONTRIBUTING.md) · [Security](SECURITY.md)

## What you can do

- **Train:** create weekday or rotating routines, run guided sessions, record sets, use rest
  timers and review workout history. The inherited exercise library includes instructions and
  media with [separate usage restrictions](NOTICE.md).
- **Track progress:** log body weight and review training charts and personal records.
- **Keep a food journal:** enter personal foods, quantities and meals; save recipes; review daily
  calories, protein, carbohydrates and fat against goals you choose.
- **Preserve meal history:** entries keep food or recipe snapshots so later edits to a saved food
  do not silently rewrite old meals. Nutrition includes its own backup preview and restore flow.
- **Use your own devices:** a web interface and installable PWA, with account-based synchronization
  when connected to your server. Capacitor mobile sources are included.
- **Optionally search a local food catalogue:** the experimental `wger-v1` mode searches a
  separately prepared SQLite catalogue on your server and supports barcode lookup. Camera access
  depends on the browser or native build, permissions and device.

The AI coach and [MCP integration](mcp/README.md) are optional. Review their configuration and
what data they expose before enabling them. Neither is required for workout or food logging.

## Preview

**Synthetic demonstration data, French interface.** These screenshots show real Nutrition UI
components with invented meals, goals and a simulated catalogue response. They contain no real
account or user history and do not demonstrate live catalogue coverage or camera scanning.

<table>
<tr>
<td><img src="docs/assets/nutrition/journal-mobile-light.png" width="250" alt="Synthetic mobile Nutrition journal in French, light theme, with example meals and nutrient totals"></td>
<td><img src="docs/assets/nutrition/picker-mobile-dark.png" width="250" alt="Synthetic food picker in French, dark theme, with a simulated yogurt result"></td>
</tr>
<tr><td>Journal · light theme</td><td>Catalogue picker · dark theme</td></tr>
</table>

[Wider dark-theme preview](docs/assets/nutrition/journal-tablet-dark.png) ·
[Image provenance and limits](docs/assets/nutrition/README.md)

## Quick start

Start with the [self-hosting guide](docs/SELF_HOSTING.md) for a source-built instance of **this
fork**. It covers prerequisites, configuration, HTTPS, persistence and verification. Do not
assume an upstream prebuilt image contains the Nutrition changes.

```sh
git clone --branch feature/nutrition https://github.com/solhren/openGym.git
cd openGym
```

Then follow the guide's deployment steps. Its minimal profile supports personal foods and recipes;
a portable full-catalogue installation is not provided. For a development server with hot reload, use
[Contributing](CONTRIBUTING.md#local-development).

Once the app is running:

1. Open your instance and create a profile, or use local guest mode if the operator allows it.
2. Create a simple workout routine and log a set to check the training workflow.
3. Open **Nutrition**, create a personal food from a label, and add a quantity to today's journal.
4. Set goals only if you want them. Missing goals and missing nutrient values are not zeroes.
5. Export a Nutrition backup and keep it somewhere outside the browser or phone.

**Food logging does not require a multi-gigabyte catalogue.** No nutrition database is shipped in
Git, and ordinary setup does not automatically download or build one. The local catalogue is an
additional operator-managed service/data preparation step. Without it, use personal foods and
recipes. See the [FAQ](docs/FAQ.md#why-is-food-search-empty-or-unavailable).

Passkeys on another device require HTTPS with a correctly configured hostname and origin.
Choose the public hostname before creating accounts. Server operators can read stored data;
self-hosting is not end-to-end encryption.

## Food data and current limits

The evaluated local generation retains **3,058,354 wger product rows** and adds **835,231 strictly
validated Open Food Facts food records**. These are processing counts, not the number of distinct
foods you can necessarily add, and not a bundled database.

In a frozen independent benchmark, **544 of 913 supported sample barcodes were addable (59.6%)**.
This measures that particular sample and generation. It does not establish coverage of French
supermarkets, relevance of search results, or nutritional accuracy. See the
[benchmark methodology](docs/dev/NUTRITION_CATALOG_BENCHMARK.md) and
[catalogue implementation notes](docs/dev/NUTRITION_FOOD_CATALOG.md).

Current limitations include:

- Local catalogue setup is experimental; importing, updating and redistributing a composed
  catalogue still need operator work and a separate license review.
- Local search has no typo correction. Some products are absent, ambiguous or lack enough
  trustworthy quantity/nutrition information to add safely.
- Nutrition supports Nutrition-only restore. Applying a combined workout-and-Nutrition restore
  is deliberately blocked; export does not imply every dataset can be restored together.
- The personal Android beta and a real scanner test provide limited device evidence. They do
  not certify arbitrary phones, browser cameras, iOS, or recovery after physical power loss.
- Long archives can increase write, sync and recovery costs. Back up before relying on a beta
  for your only copy of history.
- This is a tracker, not a clinical or dietary recommendation service. Check food values and
  units against the package label.

Some older guides describe upstream behavior or earlier Nutrition experiments. For this fork,
start here and in the current self-hosting guide; development notes are implementation evidence,
not universal deployment instructions.

## Documentation and project layout

| Need | Start here |
| --- | --- |
| Deploy and verify your instance | [Self-hosting](docs/SELF_HOSTING.md) |
| Understand storage, search or scanning behavior | [FAQ and troubleshooting](docs/FAQ.md) |
| Build Android for your own server | [Generic Android guide](docs/ANDROID_SELF_HOSTING.md) |
| Work on the code | [Contributing](CONTRIBUTING.md) |
| Understand security and reporting availability | [Security policy](SECURITY.md) |
| Review Nutrition backup behavior | [Backup design and limits](docs/dev/NUTRITION_BACKUP_RESTORE.md) |
| Review the launch draft and evidence limits | [Public launch notes](docs/PUBLIC_LAUNCH.md) |

`frontend/` contains React, Vite and the Capacitor shells. `api/` contains the Node HTTP API and
Nutrition synchronization endpoints. `web/` serves the built web app through nginx. `catalogue/`
holds the exercise catalogue. `scripts/nutrition-local-catalog/` holds experimental food-catalogue
preparation and validation tools; it is separate from the local journal storage on each device.

## License and attribution

- **Application code:** GNU AGPL v3 or later, as declared by the package metadata; see
  [LICENSE](LICENSE) and preserve the existing [NOTICE.md](NOTICE.md), including upstream
  attribution and its stated additional permission. The [AGPL text, section 13](https://www.gnu.org/licenses/agpl-3.0.html#section13)
  addresses corresponding source for modified versions used over a network.
- **Exercise text, diagrams and media:** follow [NOTICE.md](NOTICE.md). In particular, the Gym
  visual exercise media are not AGPL assets or a freely reusable media pack. This fork does not
  grant additional media permissions or certify the scope of the upstream media agreement.
- **Food records:** keep each record's source, author and license information. wger is a data
  source, not one blanket license for all imported records; its
  [official license notes](https://wger.readthedocs.io/en/latest/#licence) describe its initial
  ingredient data separately from application code.
- **Open Food Facts:** database rights use [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/);
  individual contents use [DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/). Product images
  have separate CC BY-SA terms and may involve other rights. See the
  [official OFF licensing guide](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/).

Keeping attribution in snapshots is part of the implementation, not a determination that every
combined database or publicly shared backup is lawful to redistribute. Public redistribution of
the composed catalogue has **not** been validated. Review the actual records, source terms and
intended distribution before publishing data.
