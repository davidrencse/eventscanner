# Citysignal UX review — September 2026

## Method

Three subagents ran ten distinct, code-informed persona walkthroughs of the existing interface. These were simulated reviews, not interviews or surveys with real people. They inspected `src/main.jsx`, `src/styles.css`, `src/dates.js`, and the product brief. The recommendations were compared with published UX research and accessibility guidance.

## Ten walkthroughs

| Perspective | Main friction observed |
| --- | --- |
| Newcomer seeking a mixer tonight | Today includes daytime events, and the best-match list can begin with later dates. |
| Weekend planner | Time and place were below description, slowing comparison. |
| Keyboard or screen reader user | No skip link or announced result count; repeated Open links lacked event names. |
| Local scanning a long list | Thirty expanded rows at a time made quick scanning tiring. |
| Mobile commuter | Date intent and neighborhood were slower to find than the event title. |
| Cautious attendee | Source, known price, and organizer information were not all equally visible. |
| Returning saver | Saved IDs could disappear from view when an event dropped from the latest scan. |
| Spontaneous social seeker | No direct Tonight or Tomorrow path. |
| Organizer or source skeptic | A company tag could be confused with a verified host; original source needed clear labeling. |
| Visitor facing an incomplete scan | Zero results and partial coverage needed clearer explanations and recovery actions. |

## Decisions implemented

1. Put Tonight, This weekend, and Next 7 days in quick date controls; add Tomorrow to the date selector. Time-sensitive quick choices sort by Soonest.
2. Turn each listing into a faster plan preview: strong calendar date, title, then time and venue before prose. Add a compact view.
3. Show known Free or Paid status, known organizer, and a source-specific outbound action. Do not infer missing price or host details.
4. Show removable active filters, source coverage, and per-source counts. Give no-result states a recovery action that matches the actual state.
5. Store a small snapshot when an event is saved, so a future plan remains visible if the listing is missing from a later scan; label that case clearly.
6. Add a skip link, event-specific accessible action names, result-count announcements, and keyboard focus management on view changes.

These choices align with [Baymard's research on applied-filter visibility](https://baymard.com/research-articles/how-to-design-applied-filters), its [search and results research](https://baymard.com/research/ecommerce-search), and [W3C guidance on pointer target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) and [visible focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance).

## Next validation

These simulations are directional. A real usability study would ask NYC residents to complete a tonight, weekend, and saved-plan task on their own phone, then measure task success and points of confusion. No real participants were recruited for this pass.

## October 2026 redesign — scripted usability tasks

The UI was rebuilt (see DESIGN.md). A Playwright script ran these tasks against the build at desktop (1280×800, light) and phone (390×844, dark, touch) sizes:

| Task | Result (both sizes) |
| --- | --- |
| See a first result without scrolling | Pass (top at 348px on desktop, 444px on phone) |
| Find a mixer happening tomorrow | Two taps (Tomorrow, Mixers); state saved in the URL |
| Save an event, confirm it, and find it in Saved | Pass, with toast, Undo, and tab badge |
| Recover from a search with zero results | One tap ("Clear all filters") |
| Keyboard: jump to search | `/` focuses search |
| Interactive targets smaller than 32px | None |
| Horizontal page scroll / runtime errors | None |

These are still scripted checks, not sessions with real people. The next step is a moderated study with 5 NYC residents on their own phones, measuring how many complete the tonight, weekend, and saved-plan tasks, how long each takes, and their SUS score.
