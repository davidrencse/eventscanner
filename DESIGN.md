# Citysignal visual system

Citysignal is a monochrome NYC event guide. The interface helps someone decide where and when to go in a few seconds while keeping source and coverage limits clear. It uses a bold masthead, open search controls, and an editorial calendar list. Avoid imagery, scores, color coding, enclosing cards, or unsupported claims about hosts and popularity.

## Palette and type

- Page: near black `#0d0d0e`; ink: warm white `#f5f4f0`.
- Secondary text: `#c8c7c2`; quiet text: `#aaa9a4`; rules: `#3b3b3b`.
- Selection is shown through text and a short underline, without a filled box.
- Archivo is used for the wordmark, page title, section headings, and event names. DM Sans carries controls, details, and body text.

## Structure

The masthead names the city experience and shows the last scan time. The search area uses horizontal rules and whitespace instead of an enclosing panel. A broad text field leads, followed by immediate date choices for Tonight, This weekend, and Next 7 days. Source, type, date, price, and sort remain standard select controls with underline affordances. Active filters appear as removable text links above the results.

Each event row is a plan at a glance: a large unboxed date, source and factual tags, title, time and venue, then optional summary and known organizer. Hairline rules separate rows. Actions are labeled Directions, Save, and On [source]. A compact view hides summaries for fast scanning. Known Free/Paid and availability labels are shown without inferring missing prices.

The results area reports count and source coverage. Coverage expands to show per-source listing counts and unavailable pages. Saved events store a small browser snapshot so a future event can remain visible when it drops from the latest scan; those rows tell people to check the original listing.

## Adaptation and states

At phone widths the header becomes a bottom Explore/Saved tab bar and filters form a two-column grid. The date choices scroll horizontally. The site retains loading, partial-source, error, no-results, and saved-empty states. Controls have visible keyboard focus, a skip link, result-count announcements, and at least 44px touch targets for event actions.
