// OSINT discovery source.
//
// This source finds events that organizers have already published to the open
// web and that search engines have already indexed. It runs keyword searches
// through a configured search API, keeps only result URLs on an allowlist of
// public event platforms, and reads each listing's public structured data.
//
// Scope and limits, on purpose:
//   - Public pages only. It never signs in, never sends cookies or tokens, and
//     reads nothing that a logged-out visitor could not already load.
//   - No guessing. Queries are plain keywords; it never enumerates, brute
//     forces, or mutates event ids, slugs, or invite codes to find unlisted
//     pages. It can only surface URLs a search engine already returns.
//   - Polite. It honors robots.txt, identifies itself, spaces out requests to
//     each host, and caps how much it fetches per scan.
//
// The search API key is read from the environment, never from config, and the
// source stays disabled until one is present.

import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_OSINT_CONFIG = Object.freeze({
  enabled: true,
  provider: 'brave',
  keywords: ['mixer', 'networking', 'tech happy hour', 'founders social', 'startup meetup', 'ai meetup'],
  locationTerms: ['NYC', 'New York'],
  domains: ['lu.ma', 'luma.com', 'partiful.com', 'eventbrite.com'],
  maxQueries: 8,
  resultsPerQuery: 10,
  maxListings: 40,
  perHostDelayMs: 1500,
  concurrency: 3,
  respectRobots: true,
  userAgent: 'Mozilla/5.0 (compatible; Citysignal/1.0; +public-event-discovery)',
});

export function validateOsintConfig(value = {}) {
  const config = { ...DEFAULT_OSINT_CONFIG, ...value };
  if (typeof config.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  if (typeof config.provider !== 'string' || !config.provider.trim()) throw new Error('provider must be a nonempty string');
  for (const key of ['keywords', 'locationTerms', 'domains']) {
    if (!Array.isArray(config[key]) || !config[key].length || config[key].some(x => typeof x !== 'string' || !x.trim())) {
      throw new Error(`${key} must be a nonempty list of strings`);
    }
  }
  for (const [key, max] of [['maxQueries', 50], ['resultsPerQuery', 50], ['maxListings', 200], ['concurrency', 10]]) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > max) throw new Error(`${key} must be an integer from 1 to ${max}`);
  }
  if (!Number.isInteger(config.perHostDelayMs) || config.perHostDelayMs < 0 || config.perHostDelayMs > 60000) throw new Error('perHostDelayMs must be an integer from 0 to 60000');
  if (typeof config.respectRobots !== 'boolean') throw new Error('respectRobots must be a boolean');
  if (typeof config.userAgent !== 'string' || !config.userAgent.trim()) throw new Error('userAgent must be a nonempty string');
  return config;
}

export async function loadOsintConfig(root) {
  try {
    return validateOsintConfig(JSON.parse(await fs.readFile(path.join(root, 'config', 'osint.json'), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return validateOsintConfig();
    throw error;
  }
}

// The key lives in the environment only, like GITHUB_TOKEN. Never store it in config.
export function searchApiKey(env = process.env) {
  return env.BRAVE_SEARCH_API_KEY || env.OSINT_SEARCH_API_KEY || '';
}

export function osintEnabled(config = DEFAULT_OSINT_CONFIG, env = process.env) {
  return Boolean(config.enabled) && Boolean(searchApiKey(env));
}

export function buildQueries(config) {
  const location = config.locationTerms[0];
  const queries = [];
  for (const domain of config.domains) {
    for (const keyword of config.keywords) {
      queries.push(`site:${domain} ${keyword} ${location}`);
    }
  }
  return queries.slice(0, config.maxQueries);
}

// Allowlist gate plus a light "looks like an event listing" filter, so we skip
// platform home pages, discover feeds, and profile pages rather than fetching them.
const LISTING_PATTERNS = [
  { suffix: 'lu.ma', test: segments => segments.length === 1 && !['nyc', 'discover', 'explore', 'signin', 'login', 'join'].includes(segments[0]) },
  { suffix: 'luma.com', test: segments => segments.length === 1 && !['nyc', 'discover', 'explore', 'signin', 'login', 'join'].includes(segments[0]) },
  { suffix: 'partiful.com', test: segments => segments[0] === 'e' && Boolean(segments[1]) },
  { suffix: 'eventbrite.com', test: segments => segments[0] === 'e' && Boolean(segments[1]) },
];

export function classifyEventUrl(rawUrl, domains = DEFAULT_OSINT_CONFIG.domains) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const domain = domains.map(d => d.toLowerCase()).find(d => host === d || host.endsWith(`.${d}`));
  if (!domain) return null;
  const pattern = LISTING_PATTERNS.find(p => host === p.suffix || host.endsWith(`.${p.suffix}`));
  if (!pattern) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!segments.length || !pattern.test(segments)) return null;
  // Normalize: drop query and fragment so the same listing dedupes.
  const url = `https://${host}/${segments.join('/')}`;
  return { url, host, domain };
}

// A deliberately small robots.txt reader: find the group for our user-agent (or
// the wildcard group), then apply longest-match Allow/Disallow semantics.
export function robotsAllows(robotsTxt, pathname, userAgent = DEFAULT_OSINT_CONFIG.userAgent) {
  if (!robotsTxt || typeof robotsTxt !== 'string') return true;
  const token = userAgent.toLowerCase();
  const groups = [];
  let current = null;
  let collectingAgents = false;
  for (const line of robotsTxt.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const colon = clean.indexOf(':');
    if (colon < 0) continue;
    const field = clean.slice(0, colon).trim().toLowerCase();
    const value = clean.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!collectingAgents || !current) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) { current = { agents: ['*'], rules: [] }; groups.push(current); }
      collectingAgents = false;
      if (value) current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const matchAgent = agents => agents.some(a => a === '*' || token.includes(a));
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  if (!chosen.length) return true;
  let decision = true;
  let best = -1;
  for (const group of chosen) {
    if (!matchAgent(group.agents)) continue;
    for (const rule of group.rules) {
      if (pathname.startsWith(rule.path) && rule.path.length > best) {
        best = rule.path.length;
        decision = rule.allow;
      }
    }
  }
  return decision;
}

export async function braveSearch(query, { apiKey, fetchImpl = fetch, count = 10, userAgent = DEFAULT_OSINT_CONFIG.userAgent, timeoutMs = 15000 }) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(20, Math.max(1, count))));
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey, 'User-Agent': userAgent },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    try { await response.body?.cancel?.(); } catch { /* status is the error */ }
    throw new Error(`Brave search HTTP ${response.status}`);
  }
  const data = await response.json();
  const results = data?.web?.results;
  if (!Array.isArray(results)) return [];
  return results.map(result => result?.url).filter(value => typeof value === 'string');
}

const PROVIDERS = { brave: braveSearch };

export function createSearchProvider(config, env = process.env, fetchImpl = fetch) {
  const apiKey = searchApiKey(env);
  const provider = PROVIDERS[config.provider];
  if (!apiKey || !provider) return null;
  return query => provider(query, { apiKey, fetchImpl, count: config.resultsPerQuery, userAgent: config.userAgent });
}

const delay = ms => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());

async function fetchText(url, { fetchImpl, userAgent, timeoutMs = 15000 }) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    try { await response.body?.cancel?.(); } catch { /* status is the error */ }
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

// Discover public listing pages. Returns { url, host, html } per fetched page,
// plus the queries run and any per-URL errors. Parsing into events happens in
// the caller, which owns the event shape and the NYC/upcoming filters.
export async function discoverListings(config, { search, fetchImpl = fetch, now = Date.now, log = () => {} } = {}) {
  if (!search) throw new Error('No search provider configured (set BRAVE_SEARCH_API_KEY)');
  const queries = buildQueries(config);
  const discovered = new Map();
  const searchErrors = [];
  for (const query of queries) {
    try {
      for (const rawUrl of await search(query)) {
        const classified = classifyEventUrl(rawUrl, config.domains);
        if (classified && !discovered.has(classified.url)) discovered.set(classified.url, classified);
      }
    } catch (error) {
      searchErrors.push({ query, error: error.message });
      log(`osint search failed for ${query}: ${error.message}`);
    }
  }
  const targets = [...discovered.values()].slice(0, config.maxListings);
  if (!targets.length) {
    if (searchErrors.length) throw new Error(`OSINT search failed: ${searchErrors[0].error}`);
    return { queries, discoveredUrls: [], listings: [], errors: searchErrors };
  }

  const byHost = new Map();
  for (const target of targets) {
    if (!byHost.has(target.host)) byHost.set(target.host, []);
    byHost.get(target.host).push(target);
  }

  const robotsCache = new Map();
  const robotsFor = async host => {
    if (!config.respectRobots) return null;
    if (robotsCache.has(host)) return robotsCache.get(host);
    let text = '';
    try { text = await fetchText(`https://${host}/robots.txt`, { fetchImpl, userAgent: config.userAgent }); }
    catch { text = ''; /* no robots or unreachable: default to allow, like common crawlers */ }
    robotsCache.set(host, text);
    return text;
  };

  const listings = [];
  const errors = [...searchErrors];
  const hosts = [...byHost.entries()];
  let nextHost = 0;
  await Promise.all(Array.from({ length: Math.min(config.concurrency, hosts.length) }, async () => {
    while (nextHost < hosts.length) {
      const [host, hostTargets] = hosts[nextHost++];
      const robotsTxt = await robotsFor(host);
      let last = 0;
      for (const target of hostTargets) {
        if (robotsTxt && !robotsAllows(robotsTxt, `/${target.url.split('/').slice(3).join('/')}`, config.userAgent)) {
          errors.push({ url: target.url, error: 'blocked by robots.txt' });
          continue;
        }
        const wait = config.perHostDelayMs - (now() - last);
        if (wait > 0) await delay(wait);
        last = now();
        try {
          const html = await fetchText(target.url, { fetchImpl, userAgent: config.userAgent });
          listings.push({ url: target.url, host, html });
        } catch (error) {
          errors.push({ url: target.url, error: error.message });
        }
      }
    }
  }));
  return { queries, discoveredUrls: targets.map(target => target.url), listings, errors };
}
