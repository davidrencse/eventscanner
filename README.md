# Citysignal NYC

A live NYC event dashboard for public listings on Luma, Partiful, and NYC Parks. It ranks upcoming events with a preference for mixers and social gatherings, and labels events by source and topic.

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

### Oracle host

The Oracle instance runs Citysignal from `/home/ubuntu/citysignal` using [deploy/citysignal-oracle.service](deploy/citysignal-oracle.service). The service starts on boot and scans every 15 minutes. Check it with `sudo systemctl status citysignal` or `curl http://127.0.0.1:3001/api/health` on the instance. OpenClaw runs independently as a user service.

The Oracle network currently blocks public access to port 3001. To view the dashboard from your computer without changing cloud firewall rules, run `ssh -i PATH_TO_KEY -L 3001:127.0.0.1:3001 ubuntu@132.145.200.98` and open `http://localhost:3001`. To publish the site directly, allow the chosen HTTP port in the Oracle Cloud ingress rules and the instance firewall, then put HTTPS in front of the app.

Eventbrite was removed as a source because it returns HTTP 405 to both this Oracle instance and GitHub Actions. When any source fails, the server keeps its upcoming events from `data/events.json`, marks the result stale, and leaves the published snapshot intact. The other sources continue refreshing. `GITHUB_SYNC` is off on this host because no GitHub token is configured.

## Data and ranking

### Mixer and tech discovery pipeline

`config/discovery.json` controls the shortlist: NYC **Mixers** and **Tech**, the next 30 days, up to 30 results, and at most three events per named organizer. Set `freeOnly` to require confirmed free admission. The pipeline prioritizes events matching both interests, then timing, reported interest, known start times, and free admission. Sold-out events are excluded; incomplete source coverage reduces ranking and is explained in each result. Identical normalized titles at the same start time are deduplicated across sources. Unknown prices and ticket availability remain unknown.

The running server produces `.cache/recommendations.json` at startup and after each scheduled scan, including partial scans. `GET /api/recommendations` returns an up-to-date shortlist with ranking reasons and source status. The dashboard's **Best match** sort puts shortlisted events first, polls every five minutes while visible, and removes elapsed events every minute. `GET /api/health` includes `degraded`, source failures, cycle timestamps, next run time, and the last pipeline error; HTTP 200 reports process liveness, so inspect `degraded` for data quality monitoring. Manual refreshes are limited to one per minute across clients.

Run a standalone discovery pass with `npm run discover`. It writes the shortlist and exits unsuccessfully if no matching events are found. `npm run discover -- --strict` also exits unsuccessfully for incomplete source coverage, while retaining the artifact for inspection. Standalone scans fetch fresh sources without reading or overwriting the server's scan cache. The server must stay running for its 15-minute scan schedule; `npm start` or either supplied systemd service runs it continuously.

Run `npm run discover:luma` for a Luma-only shortlist in `.cache/luma-recommendations.json`. Discovery also reads Luma's NYC tech and AI pages. The shortlist favors explicit tech networking in titles, known organizers, reported attendance, and available tickets; it excludes listings marked sold out, waitlist, or closed by Luma. Host approval is noted and slightly lowers the rank. Luma says its Discover pages are curated and do not include every public event, so this remains a ranked selection of visible listings rather than a complete Luma catalog.

`.github/workflows/ci.yml` tests and builds changes. `.github/workflows/discovery.yml` runs discovery hourly and on manual dispatch, and uploads a seven-day shortlist artifact even when coverage is incomplete. These workflows become available after the code is pushed to GitHub with Actions enabled; scheduled runs use the default branch and may be delayed. They do not deploy the server or update the live dashboard. Public source blocking and incomplete catalogs mean the pipeline cannot guarantee every event or availability.

- The scanner reads Luma's public NYC discovery feed (up to ten cursor pages of 50 events, with the city page as a fallback), Partiful's NYC Explore and Partilist pages, and NYC Parks' public upcoming feed. The Parks scan starts at the current NYC date and skips selected high volume children's programs, Shape Up classes, and ongoing exhibits. It refreshes in the background every 15 minutes and when you click **Refresh**.
- Only future-starting public events within 90 days and within New York City are shown. Listings from different pages are deduplicated. The scan is broad but is not a complete catalog of any platform.
- Events with only a date say **Time on listing**.
- Event rows show **Free** or **Paid** only when the public listing provides an explicit price. Otherwise they say **Check price**. The price filter includes only listings with a confirmed Free or Paid value.
- Best match favors explicit mixers and networking events, then considers timing, Partiful interest counts when available, and tech or company mentions. Broad words such as “community” alone do not make an event a mixer. It is not a paid ranking or quality guarantee.
- Company tags require the name in the event title or organizer, or an explicit hosting or partnership mention in the description. They do not verify a sponsor or host.
- Saved events are stored in the browser only. Older Eventbrite bookmarks are migrated to stable event IDs.

If a platform changes its page structure or blocks fetching, the dashboard reports incomplete source coverage and keeps fetched Luma cursor pages or earlier results from failed pages when available. The server stores its last successful scan in `.cache/scan.json` so a restart does not erase that fallback. Eventbrite requests pause briefly after an HTTP 429 response. Links always open the original listing for confirmation and RSVP.
