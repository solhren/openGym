# Public launch notes and Reddit draft

**Draft for maintainer review — not published.** This describes the experimental Nutrition work
in `solhren/openGym`, not a released upstream openGym feature. Evidence and repository settings
were reviewed on 3 November 2026; documentation was consolidated on 4 November
against the local public-installation candidate. The repository settings have not
been rechecked during that consolidation. No announcement is ready to post until
the gates below have recorded evidence. Commands inspected in documentation are
not a claim that Docker or Android packaging ran successfully.

## What can be said today

The fork combines the inherited workout/body-weight tracker with Nutrition journaling, personal
foods, recipes, optional goals, snapshot-preserving history and Nutrition-only backup/restore.
The public candidate adds explicit personal and multi-user account policies,
source-built Docker preparation, catalogue lifecycle commands and offline instance
backup/restore tools. Personal mode admits one owner; multi-user mode uses
invitations by default, with deliberate opt-in public signup. First-admin setup
always requires a private invitation. Browser registration and account-only
administration honor these policies; data does not become public in multi-user mode.

The portable installer currently acquires only Ciqual 2025 directly from its
publisher: 3,484 generic foods, 3,479 addable, official English/French names and
explicit 100 g references. Missing nutrients remain unknown. It has no retail
barcodes, brand catalogue or general international coverage. It is optional;
personal foods and recipes work independently. Selection/removal retains existing
saved foods and snapshots. A registry capable of several sources is not evidence
of a working multi-provider union: portable OFF/wger readers remain unavailable.

The older, separately provisioned local `wger-v1` catalogue can serve search and
barcode lookup without a provider fallback. Its private generations are not a
public installation prerequisite or a bundled download. Historical provider mode
still exists outside the new strict local installation profile.

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

## Release checklist

Use [the acceptance record](dev/PUBLIC_RELEASE_CANDIDATE.md) for actual commands,
revisions and results. Do not aggregate overlapping test runs as extra coverage.
This list intentionally stays open until its evidence has been supplied.

| Gate | Current evidence and remaining condition |
| --- | --- |
| Source available | Local review commits exist; publish an explicitly reviewed ref before telling users to clone it |
| Independent food acquisition | Official small Ciqual source/import/projection and bilingual local search verified; mixed OFF/wger installation not delivered |
| Account policy | New HTTP and UI tests cover first-owner, invitation/public policy and account isolation; real container/proxy acceptance remains |
| Clean Docker install | **Unverified:** daemon permission denied in the development environment; run the guide literally with new data on an authorized host |
| Lifecycle | Script tests cover policy/configuration checks and recovery; execute container backup, restore, update and rollback before claiming end-to-end operation |
| Browser | Follow the coordinator's real-browser evidence; component tests or a virtual authenticator do not certify physical passkeys/TLS |
| Generic Android | Source changes under review; no generic APK compilation or phone acceptance established here |
| Resources | Source/import/search measured; no image-size, startup-RAM or multi-user-capacity claim without a real container measurement |
| Security/support | Enable and verify private reporting and an actual feedback channel before recruiting testers |
| Licences/artifacts | Review the exact distributed code, media and data; no composed private catalogue is being redistributed |

The public candidate must not be labelled a validated public beta while these
critical installation and artifact gates remain open. The personal beta remains
separate evidence, with a different deployment and signing identity.

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
| Catalogue setup | Optional small Ciqual bootstrap with English/French labels; OFF/wger portable imports unavailable; no complete multi-source union or database in Git |
| Accounts | Personal or multi-user policies; passkey-only default; no anonymous recovery of lost authenticators |
| Search | No typo correction; missing/ambiguous records and incomplete nutrition references |
| Coverage | One frozen sample; no general French retail coverage or human relevance claim |
| Backup | Nutrition-only restore supported; combined dataset application blocked |
| Storage and sync | Long histories can raise write/recovery costs; keep independent backups |
| Native platforms | Personal Android evidence; generic APK compilation, its phone acceptance and native iOS remain outstanding |
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
> I'm preparing a self-hosted installation with a choice of one-owner or multi-user
> mode. Multiple accounts keep separate journals; it is not a public sharing feed.
> Invitations are the default, and the first administrator uses a private setup code.
>
> Personal foods work without a database import. The optional small Ciqual starter
> comes directly from Anses with official English/French food names and explicit
> 100 g references. It covers generic foods in the French food supply, not worldwide
> brands or barcodes. The much larger wger/Open Food Facts catalogue used by my
> personal beta is not yet a portable download supplied by this installer.
>
> The public installer still needs a clean Docker execution before I can recommend
> it to public testers. The generic Android build also needs compilation and device
> acceptance; my personal APK is not a download for other servers.
>
> This is still a beta. My personal Web/Android beta works and I tested barcode scanning on a
> phone. The changes in this review and the generic build still need device validation; I
> haven't validated every phone or native iOS. Search has no typo correction, some foods
> can't be added because their source data is incomplete or ambiguous, and combined workout +
> Nutrition restore is currently blocked. Self-hosting also means looking after your backups.
>
> Repository: https://github.com/solhren/openGym
>
> Installation source: [insert the actually published, reviewed commit or tag here].
>
> Screenshots use synthetic demo data. The app code is AGPL; food data and exercise media have
> separate licenses. I'm not distributing a composed food catalogue as part of this announcement.
>
> I'd be interested in feedback on the food-entry workflow, the clarity of quantities and
> sources, and the practical setup steps for a self-hosted tracker.

Before using this first-person draft, the maintainer should confirm that its experience claims
match their own. Match the community's current self-promotion and project-post rules, disclose
that this is your fork, and include a working feedback channel once one exists. Do not post this
draft while the reporting and release requirements above remain unresolved. Replace
the source placeholder only after that ref is published, and revise the evidence
paragraphs when the corresponding tests have actually succeeded.

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
