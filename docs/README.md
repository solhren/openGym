# openGym fork documentation

Start with the [fork README](../README.md), then choose a guide below. This is the experimental
Nutrition branch of **solhren/openGym**, based on
[DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym). The original project and its
contributors retain their credit and notices.

## Start here

| Need | Guide |
| --- | --- |
| Understand the beta and its limits | [README](../README.md) |
| Install this fork from source | [Self-hosting](SELF_HOSTING.md) |
| Understand food search, scanning or storage | [FAQ and troubleshooting](FAQ.md) |
| Contribute or reproduce a bug locally | [Contributing](../CONTRIBUTING.md) |
| Review security and private reporting availability | [Security policy](../SECURITY.md) |
| Review the announcement draft and outstanding launch work | [Public launch notes](PUBLIC_LAUNCH.md) |

The minimal self-hosting profile supports personal foods and recipes. It does not ship or
provision the experimental multi-gigabyte food catalogue. Its configuration and verification
steps live in the self-hosting guide, not in a maintainer's personal deployment notes.

## Feature references

| Guide | Scope |
| --- | --- |
| [Nutrition backup and restore](dev/NUTRITION_BACKUP_RESTORE.md) | Nutrition-only restoration, global export and combined-restore limits |
| [Food catalogue](dev/NUTRITION_FOOD_CATALOG.md) | Current local mode, source metadata and historical provider experiments |
| [Catalogue benchmark](dev/NUTRITION_CATALOG_BENCHMARK.md) | Frozen sample methodology and limits of coverage claims |
| [Nutrition UI](dev/NUTRITION_UI.md) | Interface implementation and bounded validation evidence |
| [Phone app](MOBILE.md) | Inherited Capacitor architecture/build reference; upstream downloads are not this fork's beta |
| [Importing training data](DATA_IMPORTS.md) | Inherited workout import formats |
| [AI coach](AI_COACH.md) | Optional integration; availability/network access depends on the deployment profile |
| [MCP server](../mcp/README.md) | Optional assistant access to the data it exposes |
| [HTTP API](API.md) | API reference; inspect current code for branch-specific Nutrition routes |
| [Exercise catalogue](../catalogue/README.md) | Exercise text/translation workflow and media restrictions |

Older guides, the inherited [roadmap](../ROADMAP.md) and [changelog](../CHANGELOG.md), and documents
under `dev/` contain upstream history or previous experiments. Read their dates and status before
applying commands. An upstream demo or release does not demonstrate the Nutrition branch. The
current self-hosting guide takes priority over inherited deployment examples for this fork.

For support and reporting availability, consult the current fork policy in
[Contributing](../CONTRIBUTING.md) and [Security](../SECURITY.md); upstream community channels are
not a support promise for this fork.
