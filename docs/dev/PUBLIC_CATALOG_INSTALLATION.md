# Portable catalogue installation

This follow-up builds on `review/public-readiness` at `83bfc292`. Its eleven
commits are retained. It does not replace the personal beta deployment, rebuild
its wger/OFF generations, or grant redistribution permission for those databases.

## Sources and user choice

Installation must not depend on the maintainer's machine or assume that users
speak French. A recommended, bounded starter source and an explicit custom
selection share the same local reader boundary. A source is offered for download
only when its actual importer, source version, licence and resource budget have
been checked. A source listed as experimental is not an installed catalogue.

The initial direct acquisition uses Anses Ciqual 2025:

- Official DOI: <https://doi.org/10.57745/RDMHWY>.
- Licence Ouverte / Open Licence Etalab 2.0, with original attribution retained.
- 3,484 generic foods, all with official French and English names.
- Approximately 3.13 MB: one nutrient XLSX plus the official food-name XML.
- Values refer to **100 g of edible portion**, also for beverages. There is no
  assumed density, no fabricated millilitre serving and no invented barcode.
- This is a French food-composition table with bilingual names, not an assertion
  of international retail coverage. It does not provide supermarket brands or
  barcode scanning coverage. Other UI languages use official-name fallback;
  automatic translation is not supplied.

Direct acquisition by the operator avoids publishing a mixed wger/OFF database.
Hashes check transfer integrity, not a cryptographic signature from the publisher.
Public source evidence, immutable file metadata and the acquisition receipt must
remain associated with the generated SQLite. Code licensing, source database
licensing and any images must be considered separately. No product images are
acquired for this starter source.

## Existing contracts retained

The portable Nutrition v1 model and persistence/sync/backup formats are unchanged.
`ciqual:<original-code>` is an added public lookup namespace, separate from a
revision-specific Food ID. Leading zeros are preserved. The DTO contains the
source, its release, source-file hashes, official names and licence. The Food uses
the existing `source.kind = custom` extension with `publicCatalogImport.provider
= ciqual`; it is never labelled wger or OFF.

The local capability protocol retains schema 2 and recognizes `ciqual` and
`multi` providers alongside `wger`. Unknown providers remain rejected. All local
results use the existing validated DTO, units and calculation engine. Search
never writes a Nutrition partition. Selecting and consuming a catalogue food
saves its immutable snapshot and the saved Food through the existing atomic
publication path; later source removal cannot delete those user records.

Projection to an official English name must produce a corresponding Food name
and version identity, without replacing the original source metadata. The public
lookup identity stays unchanged. Unknown values remain null. Qualified source
values such as traces or less-than values are not converted to zero.

## UI behavior

Source attribution follows entries and recipe ingredient snapshots, including
saved foods reused offline. Ciqual-only capability hides barcode/camera actions
because the source supplies no retail identifiers. Existing wger/OFF capabilities
keep their scanner behavior. The multi-source picker shows the selected record's
own provenance and never attributes Ciqual data to wger or Open Food Facts.

## Validation in progress

The implementation and independent reviews are being completed in isolated
worktrees. Frontend tests exercise DTO validation and the real React journal with
synthetic records; they are not a real-food correctness audit or a Docker test.
Source acquisition and importer tests independently check the official data.

Docker CLI and Compose are present, but this session cannot connect to
`unix:///var/run/docker.sock` (permission denied; socket root:docker 0660).
No daemon, container, production service or permission was changed. Commands
provided for a Docker-authorized operator are not evidence of container execution.

This document will be finalized with the actual installation commands, test
counts, source availability and remaining gates after integration.
