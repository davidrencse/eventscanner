# Citysignal NYC

A live NYC event dashboard for public listings on Luma, Partiful, Eventbrite, and NYC Parks. It ranks upcoming events with a preference for mixers and social gatherings, and labels events by source and topic.

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The Node scanner runs on port 3001. For a production build:

```bash
npm run build
npm start
```

The production site and API are served from port 3001 (or `PORT`).

## Continuous recon scanner

The Node server scans on startup and again 15 minutes after each completed scan, even when nobody opens the site. A scan with complete source coverage writes `data/events.json` with stable event fields sorted by ID. It omits the changing rank score so a scan only changes the file when event data changes. Incomplete scans still update the web API but do not replace the published snapshot.

For a managed host, use the included [render.yaml](render.yaml) Blueprint and choose a paid web service plan so the process stays awake. Render's Free web services spin down when idle. You can also run it on a Linux server: clone the repository to `/opt/citysignal`, install Node.js, run `npm ci && npm run build`, and install [deploy/citysignal.service](deploy/citysignal.service) as a systemd unit. Create the `citysignal` user and give it ownership of the checkout. Enable it with `sudo systemctl enable --now citysignal`. Change `User`, `WorkingDirectory`, or `ExecStart` in the unit if your server uses different paths. Put a reverse proxy with HTTPS in front of port 3001 for a public site.

With `GITHUB_SYNC=1`, each scan compares the snapshot with `data/events.json` on GitHub and commits it through the GitHub Contents API only when the content changes. Set `GITHUB_REPOSITORY` to `owner/repo`, `GITHUB_BRANCH` to the target branch, and `GITHUB_TOKEN` to a fine-grained token with **Contents: Read and write** permission for that repository. Store the token as a host secret, never in the repository. Without `GITHUB_SYNC=1`, scans and local snapshots still run, but no GitHub request is made. The Render Blueprint deploys code changes automatically and ignores snapshot-only commits.

With the API running, verify the live result:

```bash
npm run check:scan
```

## Data and ranking

- The scanner reads Luma's public NYC discovery feed (up to ten cursor pages of 50 events, with the city page as a fallback), Partiful's NYC Explore and Partilist pages, 28 bounded Eventbrite NYC city/category pages, and NYC Parks' public upcoming feed. The Parks scan starts at the current NYC date and skips selected high volume children's programs, Shape Up classes, and ongoing exhibits. It refreshes in the background every 15 minutes and when you click **Refresh**.
- Only future-starting public events within 90 days and within New York City are shown. Eventbrite virtual listings are excluded using their structured location data. Listings from different pages are deduplicated. The scan is broad but is not a complete catalog of any platform.
- Eventbrite's city listings often expose exact local start and end times plus short summaries in page data. The scanner uses those when available. Events with only a date say **Time on listing**.
- Best match favors explicit mixers and networking events, then considers timing, Partiful interest counts when available, and tech or company mentions. Broad words such as “community” alone do not make an event a mixer. It is not a paid ranking or quality guarantee.
- Company tags require the name in the event title or organizer, or an explicit hosting or partnership mention in the description. They do not verify a sponsor or host.
- Saved events are stored in the browser only. Older Eventbrite bookmarks are migrated to stable event IDs.

If a platform changes its page structure or blocks fetching, the dashboard reports incomplete source coverage and keeps fetched Luma cursor pages or earlier results from failed pages when available. The server stores its last successful scan in `.cache/scan.json` so a restart does not erase that fallback. Eventbrite requests pause briefly after an HTTP 429 response. Links always open the original listing for confirmation and RSVP.
"# eventscanner" 
