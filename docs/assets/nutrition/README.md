# Nutrition screenshots — synthetic demonstration data

These PNG files were copied unchanged from an isolated UI validation run of this fork on
3 November 2026. They render real Nutrition components with synthetic meals, invented goals
and a simulated catalogue response. The interface is shown in French. No real user account,
private host, actual food-catalogue database or product photograph appears in them.

| File | Viewport and content |
| --- | --- |
| `journal-mobile-light.png` | 390 px wide, light theme, synthetic journal |
| `picker-mobile-dark.png` | 390 px wide, dark theme, simulated food search result |
| `journal-tablet-dark.png` | 768 px wide, dark theme, same synthetic journal |

The source validation script is `browser-review.mjs` in the isolated `nutrition-ui-layout`
worktree's ignored `scripts/nutrition-local-catalog/runtime/ui-validation/` directory. It used
headless Chromium, a French locale and blocked external network requests. The journal examples
include banana, oats, milk and yogurt; the picker result is a fixture, not a live provider query.
Runtime validation tools are not required to view these copied images.

These images illustrate a specific beta UI revision. They do not prove live catalogue coverage,
camera behavior, all-device responsiveness or screen-reader conformance. The locally stored
pending-operation banner is part of the synthetic scenario, not an account's sync status.

When reusing the screenshots in documentation or a project post, retain the project attribution
and the visible caption **“Synthetic demo data.”** The UI comes from openGym by Duarte Santos and
contributors, with this fork's Nutrition changes; see [LICENSE](../../../LICENSE) and
[NOTICE.md](../../../NOTICE.md). This screenshot pack grants no additional rights over third-party
exercise media or food photographs; none were added to the pack.
