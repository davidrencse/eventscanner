# Citysignal visual system

Citysignal is an NYC event finder. The interface is built so someone can answer "what should I go to?" in a few seconds, then act (save, get directions, open the listing).

## Principles applied

- **Content first.** No hero banner: the first result sits above the fold on a 390×844 phone and a 1280×800 laptop.
- **Show options instead of making people remember them.** Date and type are always-visible chips, not dropdowns. Less common controls (source, price, sort) sit behind a Filters button.
- **Feedback before commitment.** Each chip shows how many events it would return, and chips that would return none are disabled, so people avoid dead ends.
- **Error recovery.** Every active filter shows as a removable chip with "Clear all". Saving or unsaving shows a toast with Undo. Empty states name the cause and offer one clear next step.
- **Large targets (Fitts's law).** The whole card opens the listing. Actions are labeled text-plus-icon buttons at least 44px tall.
- **Consistency and standards.** Filters live in the URL, so Back, reload, and shared links keep the view. `/` focuses search.
- **Scannability.** With "Soonest" sorting, events are grouped under sticky day headings ("Today", "Tomorrow", "Wednesday"). Time is the first line of each card, in the accent color.

## Tokens

Light and dark themes follow the system setting. Neutral warm greys, one blue accent (`--accent`), and semantic badge colors: green for Free, amber for low availability, red for sold out or waitlist. Archivo is used for headings and titles; DM Sans for everything else.

## Card anatomy

Thumbnail (or initial if there's no image) → time and badges → title → venue → two-line summary (desktop only) → source and tags → host (one line) → Save · Map · Open on [source].
