# Public launch notes and Reddit draft

**Draft for maintainer review — not published.** This describes the experimental Nutrition work
in `solhren/openGym`, not a released upstream openGym feature. Evidence and repository settings
were reviewed on 3 November 2026. Recheck them before posting. The development commands in
CONTRIBUTING.md were checked against package scripts and Vite/API configuration; they were not
executed as a clean installation during this documentation pass.

## What can be said today

The fork combines the inherited workout/body-weight tracker with Nutrition journaling, personal
foods, recipes, optional goals, snapshot-preserving history and Nutrition-only backup/restore.
A separately provisioned local `wger-v1` SQLite catalogue can serve search and barcode lookup
without an external food-provider fallback during normal use. This mode is opt-in; older
provider behavior remains in the code when it is not selected.

The maintainer reports a working personal Web/Android beta and tested barcode scanning on a
phone. Changes in this review and the generic build still need device validation. That is one
setup's evidence. Browser UI screenshots and automated fixture tests support specific UI and
logic claims; they do not establish all-device, iOS, production security or hardware durability.

The evaluated generation retains 3,058,354 wger product rows and includes 835,231 strictly
validated OFF foods. These are separate processing counts, with overlapping identities and
rejected/non-addable source rows. The frozen independent sample yielded 544 addable barcodes
out of 913 supported sample barcodes (59.6%). Do not call that “59.6% of France,” a search quality
score, or a count of products that every installation receives. Keep the
[benchmark methodology](dev/NUTRITION_CATALOG_BENCHMARK.md) alongside any numbers.

## Outstanding launch requirements

- Establish and verify a private vulnerability-reporting channel. GitHub's read-only repository
  API check returned `enabled: false` for private reporting, and Issues/Discussions were disabled.
  [GitHub explains how the reporting button depends on this setting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
  Update SECURITY.md after the actual channel is available; no address or response SLA is assumed.
- Review the [self-hosting guide](SELF_HOSTING.md) against a clean source build and the exact
  intended release commit. A documented command is not evidence of successful installation.
  An upstream image/tag is not a tested image of this Nutrition branch.
- Resolve the license/permission review for any data or media distributed with a release.
  Preserve upstream AGPL attribution and NOTICE.md. The right to distribute a composed food
  catalogue has not been validated. The optional Ciqual starter fetches about 3.13 MB directly from Anses under
  Licence Ouverte 2.0, with attribution. This is separate from the mixed wger/OFF
  catalogue and does not settle its redistribution review. No automatic bulk OFF
  or wger import is offered.
- Choose an actual support and feedback workflow before inviting public testers. Do not send
  users to disabled Issues/Discussions or promise upstream maintainers will support the fork.
- Identify the exact source commit, artifact origin and platform evidence for anything offered
  as an installable beta. Private account/host configuration is not a public installation guide.

No GitHub settings, release, website, Reddit post or external deployment is created by this
file. The requirements above describe remaining maintainer work; they do not assert approval
or a completed public launch.

## Known limitations to keep visible

| Area | Limit |
| --- | --- |
| Catalogue setup | Optional small Ciqual bootstrap; OFF/wger portable imports unavailable; no database in Git |
| Search | No typo correction; missing/ambiguous records and incomplete nutrition references |
| Coverage | One frozen sample; no general French retail coverage or human relevance claim |
| Backup | Nutrition-only restore supported; combined dataset application blocked |
| Storage and sync | Long histories can raise write/recovery costs; keep independent backups |
| Native platforms | Personal Android evidence; native iOS and broad hardware validation outstanding |
| Privacy | Host operator can read server data; optional integrations change network/data exposure |
| Licensing | Code, database rights, record contents and media require separate consideration |
| Support | No fork support SLA; reporting/settings need attention before announcing a public beta |

## Screenshot pack

Use the three files documented in [assets/nutrition/README.md](assets/nutrition/README.md).
They show the real UI with synthetic French-language data and a simulated catalogue transport.
Label them “Synthetic demo data” in any post. Do not describe the picker image as a live wger/OFF
query or proof of barcode scanning. No real profile, account screenshot or private host URL is
needed to show the interface.

## Reddit draft (English)

Suggested title:

> I'm working on an openGym fork with nutrition logging and an optional local food catalogue

Suggested body:

> I've been working on a Nutrition beta in my fork of openGym, a self-hosted workout and
> body-weight tracker originally built by Duarte Santos and the openGym contributors.
>
> The goal is to keep workouts and a food journal in one app: personal foods, recipes, meal
> quantities, calorie/macro goals and a history that keeps the food values used when you logged
> a meal. Nutrition has its own backup and restore flow.
>
> There's also an experimental server-side SQLite catalogue using wger records and a validated
> Open Food Facts complement. In that mode, searches and barcode lookups use your server with
> no external food-provider fallback during use. You can log personal foods without importing
> a catalogue. A new explicit starter bootstrap acquires generic Ciqual foods with official
> English/French names directly from Anses; it has no retail barcodes. This installer
> still needs a clean Docker execution before I can recommend it to public testers.
>
> This is still a beta. My personal Web/Android beta works and I tested barcode scanning on a
> phone. The changes in this review and the generic build still need device validation; I
> haven't validated every phone or native iOS. Search has no typo correction, some foods
> can't be added because their source data is incomplete or ambiguous, and combined workout +
> Nutrition restore is currently blocked. Self-hosting also means looking after your backups.
>
> Code and current limitations: https://github.com/solhren/openGym/tree/feature/nutrition
>
> Screenshots use synthetic demo data. The app code is AGPL; food data and exercise media have
> separate licenses. I'm not distributing a composed food catalogue as part of this announcement.
>
> I'd be interested in feedback on the food-entry workflow, the clarity of quantities and
> sources, and the practical setup steps for a self-hosted tracker.

Before using this first-person draft, the maintainer should confirm that its experience claims
match their own. Match the community's current self-promotion and project-post rules, disclose
that this is your fork, and include a working feedback channel once one exists. Do not post this
draft while the reporting and release requirements above remain unresolved.

## Attribution and sources reviewed

[LICENSE](../LICENSE) and [NOTICE.md](../NOTICE.md) remain the repository's source of code and
third-party notices. The [GNU AGPL text](https://www.gnu.org/licenses/agpl-3.0.html) includes its
network-source provisions; this documentation does not replace the license.

The [official wger documentation](https://wger.readthedocs.io/en/latest/#licence) distinguishes
its application license from initial ingredient data. Imported wger records must retain the
specific source and license metadata attached to them, including USDA or OFF lineage where
present; “from wger” is not a universal relicense.

The [official OFF licensing guide](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/)
separates the database (ODbL), individual contents (DbCL) and images (CC BY-SA, potentially with
other rights). Read [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) and
[DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/) for their actual terms. Maintaining
provenance or separating personal foods in storage does not itself settle whether a public
composition is a derivative or collective database. No legal compliance finding is made here.
