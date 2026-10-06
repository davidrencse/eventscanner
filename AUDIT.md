# Code audit and discovery changes

Scope: Node scanner, normalization, ranking, cache handling, API, browser state, date filters, and deployment workflows. Existing uncommitted changes were preserved.

## Fixed

- Cancelled or postponed JSON-LD events were accepted. Cancelled or online Eventbrite server records could leave their JSON-LD copy behind.
- A sold-out ticket tier incorrectly marked an event sold out even when another tier was available. Sold-out listings were not penalized in general ranking.
- Events outside NYC with missing ZIP codes passed location validation. The filter now requires recognized NYC location text when a ZIP is absent. This conservative list can omit uncommon neighborhoods without borough or ZIP evidence.
- Eventbrite times already containing seconds were corrupted by appending another seconds component.
- Missing latitude values could turn into zero-valued map coordinates.
- HTTP-date Retry-After values were ignored; cooldowns now accept numeric seconds and dates, bounded to 24 hours.
- Cached ranking scores did not age. They are recalculated when served.
- Published fallback data could be reused indefinitely. It is now limited by file age to 24 hours; file age is a fallback approximation, not source verification time.
- The browser never refreshed listings automatically, and elapsed events remained on screen. Visible tabs now poll and expire events.
- Blocked or full local storage could crash React effects; null saved-event data could break access. These cases now degrade to session-only storage.
- The next-seven-days filter accepted past events, and saved lists were not sorted for Best match.
- Manual refresh requests could repeatedly trigger upstream work. They now have a shared one-minute cooldown, in addition to existing scan concurrency control.
- Unknown API paths incorrectly returned the app HTML. They now return a JSON error.

## Added

- Configurable mixer/tech ranking, explanation fields, sold-out exclusion, organizer diversity, cross-source duplicate suppression, atomic shortlist output, and a recommendations API.
- Continuous shortlist generation integrated into the existing server schedule, with partial coverage retained and identified.
- Observable cycle state and source health, a standalone discovery command, regression tests, build CI, and hourly GitHub Actions discovery artifacts.

## Operational limits

Public feeds are bounded and may block requests. Ranking is a preference heuristic, not a quality guarantee. JSON-LD cancellation signals and structured Eventbrite cancellations are handled, but not every source exposes cancellations. Exact-title/start deduplication intentionally avoids fuzzy merging of distinct events. GitHub workflows and remote service changes require pushing/deploying this checkout; creating their files does not activate them remotely. The health endpoint exposes liveness separately from degraded data coverage.
