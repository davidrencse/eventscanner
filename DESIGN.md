# Citysignal visual system

Citysignal is a monochrome NYC event guide. The interface helps someone decide where and when to go in a few seconds while keeping source and coverage limits clear. It uses a bold masthead, a practical search console, and a calendar-like list. Avoid imagery, scores, color coding, or unsupported claims about hosts and popularity.

## Palette and type

- Page: near black `#090909`; search panel: charcoal `#161616`.
- Primary text: warm white `#f5f5f2`; secondary text: `#c8c8c5`; quiet text: `#a4a4a0`.
- Rules: `#3d3d3b`; selected quick filter: white fill with near black text.
- Archivo is used for the wordmark, page title, section headings, and event names. DM Sans carries controls, details, and body text.

## Structure

The masthead names the city experience and shows the last scan time. A search console starts with one broad text field, then immediate date choices for Tonight, This weekend, and Next 7 days. Source, type, date, and sort remain standard select controls. Active filters appear as removable chips above the results.

Each event row is a plan at a glance: calendar date, source and factual tags, title, time and venue, then optional summary and known organizer. Actions are labeled Directions, Save, and On [source]. A compact view hides summaries for fast scanning. Known Free/Paid and availability labels are shown without inferring missing prices.

The results area reports count and source coverage. Coverage expands to show per-source listing counts and unavailable pages. Saved events store a small browser snapshot so a future event can remain visible when it drops from the latest scan; those rows tell people to check the original listing.

## Adaptation and states

At phone widths the header becomes a bottom Explore/Saved tab bar and filters form a two-column grid. The date choices scroll horizontally. The site retains loading, partial-source, error, no-results, and saved-empty states. Controls have visible keyboard focus, a skip link, result-count announcements, and at least 44px touch targets for event actions.
