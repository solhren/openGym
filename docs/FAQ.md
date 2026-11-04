# FAQ and troubleshooting

These answers describe the Nutrition beta in **solhren/openGym**, on `feature/nutrition`.
For deployment commands and configuration, start with [Self-hosting](SELF_HOSTING.md).

## Is this the original openGym?

It is a fork of [DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym), with Nutrition
and local food-catalogue work. Upstream deserves credit for the original training app. Its demo,
release assets, roadmap and support channels belong to that project; they do not demonstrate
this fork's Nutrition functionality. Some inherited documentation still describes upstream.

## Can I start without importing a food catalogue?

Yes. Create personal foods from package labels, save recipes and add them to your journal.
No nutrition database is included in Git or automatically downloaded by ordinary setup. The
experimental local search mode needs a separately prepared server-side SQLite generation.
The number of imported rows is not a promise that every row is safe to add.

## Why is food search empty or unavailable?

First check whether your instance has an actual catalogue configured. Personal food storage on
your phone/browser and the server's public-food catalogue are different components. A working
journal does not mean a SQLite catalogue has been installed.

In local `wger-v1` mode, an unavailable worker or missing generation must be fixed on the server;
there is no automatic remote-provider fallback. Follow the current self-hosting guide and inspect
redacted server diagnostics. Do not copy generation paths or digests from another installation.

If search works but a particular food is missing, try a simpler product or brand name, then its
barcode. Local search has no typo correction and some records are deliberately unavailable
because their unit reference, nutrients, provenance or license mapping cannot be established.
You can create a personal food from the label instead. Do not substitute a similarly named
product without comparing its quantity basis and values.

## Does offline mode include the whole catalogue?

No. In local catalogue mode, “local” means on **your server**. A phone still needs to reach that
server for catalogue searches and new product lookups. Already saved foods, recipes and journal
entries use device storage and can be used offline once the app and local data are available.
Offline edits wait for synchronization; check the Nutrition status after reconnecting.

The older provider mode has different network behavior and may contact Open Food Facts. Being
self-hosted alone does not prove a build is using local-only food lookup.

## Why won't the scanner read a product?

Camera permission, browser support, lighting and the native build all matter. Use HTTPS in a
browser, allow camera access, and try entering the barcode manually. A successful scan only
reads a code; it does not prove the catalogue contains a complete food record for it.

A real scanner was tested in the personal Android beta. This is limited evidence for that
setup, not certification for all Android phones, browser cameras or iOS. Include OS, app commit,
browser/native mode and the exact failing step in a bug description, using a non-sensitive
example barcode.

## Can I use it on iPhone?

The web/PWA interface is the starting point. Native iOS sources exist, but this fork does not
claim a generally validated native iOS Nutrition release. Browser/PWA storage, permissions and
background execution can differ from Android; test your device and export a backup. The
inherited [mobile guide](MOBILE.md) explains the architecture and build process; its upstream APK
links are not a Nutrition release download for this fork.

## Why do calories or macros differ from the package?

Check whether the label uses 100 g, 100 ml, a serving or the whole container. Grams and
millilitres are not interchangeable without a known density. Product versions and rounded
labels can differ too. Unknown nutrient values stay unknown; they must not be treated as zero.
Review source details before logging a quantity. Goals are optional values you choose, not
personalized dietary advice.

## Does editing a food change yesterday's meal?

Journal entries retain their food or recipe snapshot. Editing a library item does not silently
rewrite historical meal values. Edit the relevant entry if you intend to correct that meal.
Keep source and license details when importing or sharing records.

## Where is my data, and what should I back up?

Guest data belongs to the local browser or app installation. Signed-in data can synchronize
with your own server; server operators can read server-side records. This is not end-to-end
encryption. Browser storage can be cleared and devices can be lost.

Use Nutrition's own export, preview and restore flow. Workout-only backups do not include a
Nutrition guarantee. Combined exports can be inspected, but applying a combined workout and
Nutrition restore is intentionally blocked. Nutrition-only restore is supported. New combined
exports also warn that binary workout media are not included; preserve the existing media
backup separately if needed. See [backup format and limits](dev/NUTRITION_BACKUP_RESTORE.md).
Keep exports private and outside the device; verify a restore on a disposable test profile
before depending on a backup plan.

## Nutrition is stuck loading or shows a storage error. What next?

Record the app commit/build and exact message. Keep the original local data intact. If the app
opens far enough, export a backup before reinstalling, clearing storage or changing accounts.
Check that your installed beta includes the Android startup correction; rebuilding web assets
alone does not update an installed APK.

A local journal opening error and a catalogue search outage have different causes. Server
catalogue installation does not repair device journal storage. Report redacted diagnostics with
the failing step and platform; do not upload a full backup or data directory publicly.

## Sign-in or pairing fails. What should I check?

Follow the self-hosting guide's authentication and proxy checks. The public URL, `ORIGIN` and
`RP_ID` must match the intended deployment; passkeys require a secure context and are bound to
their hostname. Choose that hostname before registration. Avoid changing it as a troubleshooting
shortcut. For native pairing, the reverse proxy must allow the app's intended API requests and
CORS handling. Never include the pairing code or token in a bug report.

## Can I reuse the code, food data or exercise images?

They have different licenses. Application code uses GNU AGPL; preserve the original copyright
and [third-party notices](../NOTICE.md). Exercise media are separately licensed and are not a
freely reusable asset collection. Food records retain source-specific terms; Open Food Facts
uses ODbL for its database and DbCL for contents, with separate terms for images. See the
[README's attribution section](../README.md#license-and-attribution) and linked official sources.
Public redistribution of the composed catalogue or a combined backup has not been validated.

## Where can I get help or report a bug?

As checked on 3 November 2026, this fork has Issues and Discussions disabled and no verified
private vulnerability-reporting channel. Check the repository's current settings and
[Contributing](../CONTRIBUTING.md) for contribution guidance. Do not assume upstream chat is
support for this fork. Follow [SECURITY.md](../SECURITY.md) for sensitive findings and never post
credentials or personal history in a public report.
