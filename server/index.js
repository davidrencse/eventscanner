import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishScan } from './recon.js';
import { buildRecommendations, loadPreferences, writeRecommendations } from './pipeline.js';
import { loadOsintConfig, validateOsintConfig, osintEnabled, createSearchProvider, discoverListings } from './osint.js';

const PORT = Number(process.env.PORT || 3001);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_MAIN = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(ROOT, '.cache', 'scan.json');
const CACHE_MAX_AGE = 24 * 60 * 60000;
const RECON_INTERVAL = 15 * 60 * 1000;
const SOURCES = [
  { name: 'Luma', url: 'https://api.luma.com/discover/get-paginated-events', parse: parseLuma, kind: 'luma-api' },
  { name: 'Luma', url: 'https://luma.com/nyc', parse: parseLuma },
  { name: 'Luma', url: 'https://luma.com/discover/nyc/tech', parse: parseLuma },
  { name: 'Luma', url: 'https://luma.com/discover/nyc/ai', parse: parseLuma },
  { name: 'Partiful', url: 'https://partiful.com/explore/NYC', parse: parsePartiful },
  { name: 'Partiful', url: 'https://partiful.com/explore/partilist', parse: parsePartiful },
  { name: 'NYC Parks', url: 'https://data.cityofnewyork.us/resource/w3wp-dpdi.json', kind: 'parks-api' },
  ...['events', 'networking', 'technology--events', 'parties--events', 'art--events', 'music--events', 'food-and-drink--events', 'health--events'].flatMap((section, i) =>
    Array.from({ length: i < 4 ? 5 : 2 }, (_, page) => ({
      name: 'Eventbrite',
      url: `https://www.eventbrite.com/d/ny--new-york/${section}/?page=${page + 1}`,
      parse: parseEventbrite,
    }))
  ),
];
// OSINT web-discovery source: finds events organizers already published to the
// open web and that a search engine already indexed. Public pages only; it is
// off unless config enables it and a search API key is present in the environment.
let osintConfig;
try { osintConfig = validateOsintConfig(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'osint.json'), 'utf8'))); }
catch { osintConfig = validateOsintConfig(); }
if (osintEnabled(osintConfig, process.env)) {
  SOURCES.push({ name: 'Community (web)', url: 'osint:search', kind: 'osint' });
}
let cache = null;
let pending = null;
let pendingIsForced = false;
const pageCache = new Map();
let eventbriteCooldownUntil = 0;
const pipelineHealth = { running: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, nextRunAt: null };
let lastManualRefresh = 0;
const nyDayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const nyDay = value => nyDayFormatter.format(new Date(value));
const nyOffsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });

if (IS_MAIN) {
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (saved.version === 1 && Date.now() - Date.parse(saved.cache?.updatedAt) < CACHE_MAX_AGE && Array.isArray(saved.cache?.events)) {
      cache = saved.cache;
      for (const [url, snapshot] of saved.pages || []) {
        if (snapshot && Date.now() - snapshot.fetchedAt < CACHE_MAX_AGE && Array.isArray(snapshot.events)) pageCache.set(url, snapshot);
      }
      eventbriteCooldownUntil = Number(saved.eventbriteCooldownUntil) || 0;
    }
  } catch { /* no usable snapshot yet */ }
}

function saveCache() {
  if (!IS_MAIN) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const temporary = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, cache, pages: [...pageCache], eventbriteCooldownUntil }));
    fs.renameSync(temporary, CACHE_FILE);
  } catch (error) {
    console.warn(`Could not save scan cache: ${error.message}`);
  }
}

function scriptJson(html, predicate) {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (predicate(match[1])) {
      try { return JSON.parse(match[2].trim()); } catch { /* continue */ }
    }
  }
  return null;
}

function assignedJson(html, name) {
  const marker = html.indexOf(`${name} = `);
  if (marker < 0) return null;
  const start = marker + name.length + 3;
  if (html[start] !== '{') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function ldEvents(html) {
  const results = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if ((value['@type'] === 'Event' || (Array.isArray(value['@type']) && value['@type'].includes('Event'))) && !/EventCancelled|EventPostponed/.test(value.eventStatus || '')) results.push(value);
    if (value['@graph']) visit(value['@graph']);
    if (value.itemListElement) visit(value.itemListElement);
    if (value.item) visit(value.item);
  };
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/type=["']application\/ld\+json["']/i.test(match[1])) continue;
    try {
      visit(JSON.parse(match[2].trim()));
    } catch { /* ignore unrelated JSON-LD */ }
  }
  return [...new Map(results.map(event => [event.url || event['@id'], event])).values()];
}

function imageUrl(value) {
  if (Array.isArray(value)) return value[0] || '';
  if (typeof value === 'string') return value;
  return value?.url || value?.upload?.url || '';
}

function dateValue(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T16:00:00Z`).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function nyLocalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value || '')) return null;
  const localAsUtc = new Date(`${value.replace(/Z$/, '')}Z`);
  if (Number.isNaN(localAsUtc.getTime())) return null;
  const offsetAt = date => {
    const zone = nyOffsetFormatter.formatToParts(date).find(part => part.type === 'timeZoneName')?.value || '';
    const match = zone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    return match ? (Number(match[2]) * 60 + Number(match[3] || 0)) * (match[1] === '+' ? 1 : -1) : null;
  };
  const firstOffset = offsetAt(localAsUtc);
  if (firstOffset === null) return null;
  let instant = new Date(localAsUtc.getTime() - firstOffset * 60000);
  const actualOffset = offsetAt(instant);
  if (actualOffset !== null && actualOffset !== firstOffset) instant = new Date(localAsUtc.getTime() - actualOffset * 60000);
  return instant.toISOString();
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    if (!Number.isInteger(point) || point < 0 || point > 0x10FFFF || (point >= 0xD800 && point <= 0xDFFF)) return '';
    return String.fromCodePoint(point);
  })
    .replace(/&(?:amp|quot|apos|lt|gt|nbsp);/gi, entity => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' })[entity.toLowerCase()] || entity)
    .replace(/\s+/g, ' ').trim();
}

function spotCount(remaining, soldOut) {
  if (soldOut === true) return 0;
  if (remaining === null || remaining === undefined || remaining === '') return null;
  const count = Number(remaining);
  if (!Number.isInteger(count) || count < 0 || count > 100000) return null;
  return count;
}

function mapsUrl({ latitude, longitude, query, href } = {}) {
  if (typeof href === 'string' && /^https:\/\/(?:www\.)?google\.com\/maps\//i.test(href)) return href;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (latitude != null && longitude != null && String(latitude).trim() && String(longitude).trim() && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
  const text = cleanText(query);
  if (!text || /^(new york( city)?|nyc|new york, ny|ny)$/i.test(text)) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`;
}

function coordinatePair(value) {
  if (value && typeof value === 'object') return { latitude: value.latitude ?? value.lat, longitude: value.longitude ?? value.lng };
  const match = String(value || '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return {};
  return { latitude: Number(match[1]), longitude: Number(match[2]) };
}

function lumaPlace(geo = {}) {
  const shown = geo.mode === 'shown' && (geo.full_address || geo.address);
  const venue = shown ? (geo.address || geo.sublocality || 'New York City') : (geo.sublocality || geo.city_state || 'New York City');
  const locality = geo.city || 'New York';
  const postalCode = String(geo.full_address || '').match(/\b\d{5}\b/)?.[0] || '';
  const query = shown ? (geo.full_address || [geo.address, geo.city_state].filter(Boolean).join(', ')) : [geo.sublocality, geo.city_state].filter(Boolean).join(', ');
  return { venue, locality, postalCode, mapsUrl: mapsUrl({ ...coordinatePair(geo.place_coordinate), query }) };
}

function offerSoldOut(offers) {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  return list.length > 0 && list.every(offer => /SoldOut/i.test(String(offer?.availability || '')));
}

function offerPrice(offers) {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  const prices = list.map(offer => offer?.price).filter(price => price !== null && price !== undefined && price !== '' && Number.isFinite(Number(price)) && Number(price) >= 0).map(Number);
  if (!prices.length) return null;
  if (prices.some(price => price > 0)) return 'Paid';
  return prices.length === list.length ? 'Free' : null;
}

function parseParks(rows) {
  const boroughs = { M: 'Manhattan', B: 'Brooklyn', Q: 'Queens', X: 'Bronx', R: 'Staten Island' };
  return rows.filter(row => row.guid && row.title && row.starttime && row.link?.url)
    .filter(row => !/(kids? in motion|summer sports experience|ongoing (museum|outdoor museum) exhibit)/i.test(row.title)
      && !/Best for Kids|Recreation Center Programming|Virtual\/Online Events|Shape Up NYC/i.test(row.categories || ''))
    .map(row => ({
      id: `parks:${row.guid}`, source: 'NYC Parks', url: row.link.url.replace(/^http:/, 'https:'),
      title: cleanText(row.title), description: cleanText(row.description),
      start: nyLocalDate(row.starttime), end: nyLocalDate(row.endtime), timeKnown: true,
      venue: cleanText(row.location || row.parknames || 'NYC Park'), locality: boroughs[row.parkids?.[0]] || 'New York City', postalCode: '',
      image: row.image?.url?.replace(/^http:/, 'https:') || '', organizer: 'NYC Parks', price: null, popularity: null,
      spotsLeft: null, availability: null,
      mapsUrl: mapsUrl({ ...coordinatePair(row.coordinates), query: [row.location, row.parknames, 'New York'].filter(Boolean).join(', ') }),
    }));
}

async function discardBody(response) {
  try { await response.body?.cancel?.(); } catch { /* The HTTP status is the error that matters. */ }
}

async function fetchParks() {
  const url = new URL('https://data.cityofnewyork.us/resource/w3wp-dpdi.json');
  url.searchParams.set('$where', `starttime >= '${nyDay(Date.now())}T00:00:00' and categories not like '%Best for Kids%' and categories not like '%Recreation Center Programming%' and categories not like '%Virtual/Online Events%'`);
  url.searchParams.set('$order', 'starttime ASC');
  url.searchParams.set('$limit', '1000');
  const response = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(18000) });
  if (!response.ok) {
    await discardBody(response);
    throw new Error(`NYC Parks HTTP ${response.status}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('NYC Parks feed format changed');
  return parseParks(rows);
}

function physicalLocation(event) {
  const locations = Array.isArray(event.location) ? event.location : [event.location];
  return locations.find(location => location && location['@type'] !== 'VirtualLocation' && (location.address?.addressLocality || location.address?.postalCode)) || null;
}

function lumaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://luma.com');
    if (!/(^|\.)luma\.com$/i.test(parsed.hostname)) return parsed.toString();
    const slug = parsed.pathname.replace(/^\/+|\/+$/g, '');
    return slug ? `https://luma.com/${slug}` : 'https://luma.com';
  } catch {
    return raw;
  }
}

function parseLuma(html) {
  return ldEvents(html).flatMap(event => {
    const location = physicalLocation(event);
    const url = lumaUrl(event.url || event['@id']);
    if (!location || !url || url === 'https://luma.com') return [];
    return [{
      id: `luma:${url}`, source: 'Luma', url,
      title: event.name, description: event.description || '', start: dateValue(event.startDate), end: dateValue(event.endDate), timeKnown: true,
      venue: location.name || 'New York City', locality: location.address?.addressLocality || 'New York',
      postalCode: location.address?.postalCode || '',
      image: imageUrl(event.image),
      organizer: (Array.isArray(event.organizer) ? event.organizer : [event.organizer]).filter(Boolean).map(item => item.name).filter(Boolean).join(', '),
      price: offerPrice(event.offers),
      popularity: null,
      spotsLeft: spotCount(event.remainingAttendeeCapacity, offerSoldOut(event.offers)),
      availability: null,
      mapsUrl: mapsUrl({ latitude: location.geo?.latitude, longitude: location.geo?.longitude, query: [location.address?.streetAddress || location.name, location.address?.addressLocality, location.address?.postalCode].filter(Boolean).join(', ') }),
    }];
  });
}

async function fetchLumaFeed() {
  const events = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    try {
      const url = new URL('https://api.luma.com/discover/get-paginated-events');
      url.searchParams.set('discover_place_api_id', 'discplace-Izx1rQVSh8njYpP');
      url.searchParams.set('pagination_limit', '50');
      if (cursor) url.searchParams.set('pagination_cursor', cursor);
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Citysignal/1.0)', 'Referer': 'https://luma.com/nyc', 'Accept': 'application/json' }, signal: AbortSignal.timeout(18000) });
      if (!response.ok) {
        await discardBody(response);
        throw new Error(`Luma feed HTTP ${response.status}`);
      }
      const data = await response.json();
      if (!Array.isArray(data.entries)) throw new Error('Luma feed format changed');
      events.push(...data.entries.flatMap(entry => {
        const event = entry.event;
        const url = lumaUrl(event?.url);
        if (event?.visibility !== 'public' || event?.location_type !== 'offline' || !url || url === 'https://luma.com' || !event.name) return [];
        const place = lumaPlace(event.geo_address_info);
        return [{
          id: `luma:${url}`, source: 'Luma', url,
          title: event.name, description: '',
          start: dateValue(event.start_at), end: dateValue(event.end_at), timeKnown: true,
          venue: place.venue, locality: place.locality, postalCode: place.postalCode,
          image: event.cover_url || '', organizer: entry.calendar?.name || '',
          price: entry.ticket_info?.is_free === true ? 'Free' : entry.ticket_info?.is_free === false ? 'Paid' : null,
          popularity: entry.guest_count || null,
          spotsLeft: spotCount(entry.ticket_info?.spots_remaining, entry.ticket_info?.is_sold_out === true),
          availability: entry.registration_availability || null,
          approvalRequired: entry.ticket_info?.require_approval ?? null,
          mapsUrl: place.mapsUrl,
        }];
      }));
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    } catch (error) {
      if (!events.length) throw error;
      events.partialError = error;
      break;
    }
  }
  if (!events.length) throw new Error('No public Luma events found');
  return events;
}

// Map a single public listing's JSON-LD Event into our event shape. Used for
// platforms whose individual event pages expose schema.org structured data.
function eventFromJsonLd(event, { url, id, source }) {
  const location = physicalLocation(event);
  if (!location || !event?.name) return null;
  return {
    id, source, url,
    title: event.name, description: cleanText(event.description), summary: cleanText(event.description),
    start: dateValue(event.startDate), end: dateValue(event.endDate), timeKnown: !/^\d{4}-\d{2}-\d{2}$/.test(event.startDate || ''),
    venue: location.name || location.address?.streetAddress || 'New York City',
    locality: location.address?.addressLocality || 'New York', postalCode: location.address?.postalCode || '',
    image: imageUrl(event.image),
    organizer: (Array.isArray(event.organizer) ? event.organizer : [event.organizer]).filter(Boolean).map(item => item.name).filter(Boolean).join(', '),
    price: offerPrice(event.offers), popularity: null,
    spotsLeft: spotCount(event.remainingAttendeeCapacity, offerSoldOut(event.offers)), availability: null,
    mapsUrl: mapsUrl({ latitude: location.geo?.latitude, longitude: location.geo?.longitude, query: [location.address?.streetAddress || location.name, location.address?.addressLocality, location.address?.postalCode].filter(Boolean).join(', ') }),
  };
}

// Parse one public listing page into events, keeping platform-native ids so a
// web-discovered event dedupes against the same event from a platform feed.
function parseListing(url, host, html) {
  const h = String(host || '').toLowerCase();
  if (h === 'luma.com' || h.endsWith('.luma.com') || h === 'lu.ma' || h.endsWith('.lu.ma')) return parseLuma(html);
  if (h === 'partiful.com' || h.endsWith('.partiful.com')) {
    const slug = (() => { try { return new URL(url).pathname.split('/').filter(Boolean)[1] || url; } catch { return url; } })();
    return ldEvents(html).flatMap(event => { const e = eventFromJsonLd(event, { url, id: `partiful:${slug}`, source: 'Partiful' }); return e ? [e] : []; });
  }
  if (h === 'eventbrite.com' || h.endsWith('.eventbrite.com')) {
    return ldEvents(html).flatMap(event => { const e = eventFromJsonLd(event, { url, id: eventbriteId(event.url || url), source: 'Eventbrite' }); return e ? [e] : []; });
  }
  return [];
}

async function fetchOsint() {
  const config = await loadOsintConfig(ROOT);
  const search = createSearchProvider(config, process.env);
  if (!search) throw new Error('OSINT search provider is not configured (set BRAVE_SEARCH_API_KEY)');
  const { listings } = await discoverListings(config, { search });
  const events = [];
  const seen = new Set();
  for (const listing of listings) {
    for (const event of parseListing(listing.url, listing.host, listing.html)) {
      if (!event?.id || seen.has(event.id)) continue;
      seen.add(event.id);
      // Keep the platform-native id/url for dedupe and link-through, but label
      // the discovery method so the dashboard can show how it was found.
      events.push({ ...event, source: 'Community (web)' });
    }
  }
  if (!events.length) throw new Error('No public events found');
  return events;
}

function parsePartiful(html) {
  const data = scriptJson(html, attrs => /id=["']__NEXT_DATA__["']/.test(attrs));
  const page = data?.props?.pageProps || {};
  const items = [
    ...(page.trendingSection?.items || []),
    ...(page.trendingSections?.NYC?.items || []),
    ...(page.sections || []).filter(section => !section.region || section.region === 'NYC').flatMap(section => section.items || []),
    ...(page.feedItems || []),
  ];
  return items.filter(item => item.type === 'event' && item.event?.id).map(({ event: e }) => ({
    id: `partiful:${e.id}`, source: 'Partiful', url: `https://partiful.com/e/${e.id}`,
    title: e.title, description: e.description || '', start: dateValue(e.startDate), end: dateValue(e.endDate), timeKnown: true,
    venue: e.locationInfo?.mapsInfo?.name || e.locationInfo?.neighborhood || 'New York City',
    locality: e.locationInfo?.neighborhood || e.locationInfo?.mapsInfo?.approximateLocation || 'New York',
    postalCode: (e.locationInfo?.mapsInfo?.addressLines || []).join(' ').match(/\b\d{5}\b/)?.[0] || '',
    image: imageUrl(e.image), organizer: '', price: null,
    popularity: (Number(e.interestedGuestCount) || 0) + (Number(e.goingGuestCount) || 0),
    spotsLeft: null, availability: null,
    mapsUrl: mapsUrl({ href: e.locationInfo?.mapsInfo?.googleMapsUrl, query: [...(e.locationInfo?.mapsInfo?.addressLines || []), e.locationInfo?.mapsInfo?.name].filter(Boolean).join(', ') }),
  }));
}

function eventbriteId(url, id) {
  return `eventbrite:${id || /tickets-(\d+)/.exec(url || '')?.[1] || url}`;
}

function parseEventbrite(html) {
  const listings = ldEvents(html).filter(e => physicalLocation(e)).map(e => {
    const location = physicalLocation(e);
    return {
      id: eventbriteId(e.url), source: 'Eventbrite', url: e.url,
      title: e.name, description: cleanText(e.description), summary: cleanText(e.description), start: dateValue(e.startDate), end: dateValue(e.endDate), timeKnown: !/^\d{4}-\d{2}-\d{2}$/.test(e.startDate || ''),
      venue: location.name || location.address?.streetAddress || 'New York City', locality: location.address?.addressLocality || '',
      postalCode: location.address?.postalCode || '',
      image: imageUrl(e.image), organizer: e.organizer?.name || '', price: offerPrice(e.offers), popularity: null,
      spotsLeft: spotCount(e.remainingAttendeeCapacity, offerSoldOut(e.offers)), availability: null,
      mapsUrl: mapsUrl({ latitude: location.geo?.latitude, longitude: location.geo?.longitude, query: [location.address?.streetAddress || location.name, location.address?.addressLocality, location.address?.postalCode].filter(Boolean).join(', ') }),
    };
  });
  const byId = new Map(listings.map(event => [event.id, event]));
  const found = assignedJson(html, 'window.__SERVER_DATA__')?.search_data?.events?.results;
  const results = Array.isArray(found) ? found : [];
  for (const item of results) {
    const id = eventbriteId(item.url, item.eventbrite_event_id || item.id);
    if (item.is_online_event || item.is_cancelled) { byId.delete(id); continue; }
    if (!item.url || !item.name || !item.primary_venue?.address) continue;
    const previous = byId.get(id);
    const start = nyLocalDate(`${item.start_date}T${item.start_time}`);
    const end = nyLocalDate(`${item.end_date}T${item.end_time}`);
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const description = cleanText([item.summary, ...tags.filter(tag => ['EventbriteFormat', 'EventbriteCategory', 'EventbriteSubCategory'].includes(tag.prefix)).map(tag => tag.display_name)].filter(Boolean).join(' '));
    byId.set(id, {
      ...previous, id, source: 'Eventbrite', url: item.url, title: cleanText(item.name),
      description: description || previous?.description || '',
      summary: cleanText(item.summary) || previous?.summary || '',
      start: start || previous?.start || null, end: end || previous?.end || null,
      timeKnown: Boolean(start) || previous?.timeKnown || false,
      venue: cleanText(item.primary_venue.name) || previous?.venue || 'New York City',
      locality: item.primary_venue.address.city || previous?.locality || '',
      postalCode: item.primary_venue.address.postal_code || previous?.postalCode || '',
      image: item.image?.url || previous?.image || '',
      organizer: previous?.organizer || '', price: previous?.price || null, popularity: previous?.popularity || null,
      spotsLeft: previous?.spotsLeft ?? null,
      availability: (Array.isArray(item.urgency_signals?.messages) && item.urgency_signals.messages.includes('fewTickets') ? 'few' : null) || previous?.availability || null,
      mapsUrl: mapsUrl({
        latitude: item.primary_venue.address.latitude,
        longitude: item.primary_venue.address.longitude,
        query: item.primary_venue.address.localized_address_display || [item.primary_venue.address.address_1, item.primary_venue.address.city, item.primary_venue.address.region, item.primary_venue.address.postal_code].filter(Boolean).join(', '),
      }) || previous?.mapsUrl || '',
    });
  }
  return [...byId.values()];
}

const COMPANY_NAMES = ['Google', 'Microsoft', 'Meta', 'Amazon', 'Apple', 'OpenAI', 'Anthropic', 'Nvidia', 'Stripe', 'Bloomberg', 'JPMorgan', 'Goldman Sachs', 'Adobe', 'Salesforce', 'Spotify', 'IBM', 'TikTok', 'Netflix', 'Uber'];
const COMPANY_RULES = COMPANY_NAMES.map(name => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [name, new RegExp(`\\b${escaped}\\b`, 'i'), new RegExp(`\\b(?:hosted|presented|sponsored|organized) by.{0,40}\\b${escaped}\\b|\\b(?:partnership|collaboration) with.{0,40}\\b${escaped}\\b`, 'i')];
});
const SOCIAL_STRONG = /\b(mixer|networking|happy hour|meet and greet|speed friending|speed dating|social hour|social club|meet new people|make new friends)\b/i;
const SOCIAL_MEDIUM = /\b(meetup|hangout|hangs|potluck|gathering|community night|community meetup|connect with|meet fellow|meet other)\b/i;
const RULES = [
  ['Tech', /\b(ai|artificial intelligence|tech|startup|founder|developer|software|product|hackathon|web3|crypto|fintech|data|venture|vc|climate tech|robotics)\b/i],
  ['Arts & culture', /\b(art|gallery|museum|film|fashion|design|creative|exhibit|book|literary|poetry)\b/i],
  ['Food & drink', /\b(food|dinner|brunch|wine|cocktail|tasting|chef|restaurant|pizza|coffee)\b/i],
  ['Music & nightlife', /\b(music|concert|dj|dance|party|nightlife|rave|live set)\b/i],
  ['Wellness', /\b(yoga|wellness|fitness|run club|pilates|meditation|hike|walk|workout)\b/i],
  ['Business', /\b(business|career|professional|leadership|marketing|finance|investor|entrepreneur)\b/i],
];

function enrich(e, now = Date.now()) {
  const title = e.title || '';
  const description = e.description || '';
  const organizer = e.organizer || '';
  const text = `${title} ${description} ${organizer}`;
  const tags = RULES.filter(([, re]) => re.test(text)).map(([tag]) => tag);
  const strongTitle = SOCIAL_STRONG.test(title);
  const mediumTitle = SOCIAL_MEDIUM.test(title);
  const strongDescription = SOCIAL_STRONG.test(e.description || '');
  const mediumDescription = SOCIAL_MEDIUM.test(e.description || '');
  const socialScore = strongTitle ? 22 : mediumTitle ? 12 : strongDescription ? 7 : mediumDescription ? 3 : 0;
  if (socialScore) tags.unshift('Mixers');
  const companies = COMPANY_RULES.filter(([name, re, hosted]) => {
    const titleMatch = re.test(title) && !(name === 'Apple' && /\bbig apple\b/i.test(title)) && !(name === 'TikTok' && /\btiktok (hits|songs|viral)\b/i.test(title));
    if (titleMatch || re.test(organizer)) return true;
    return hosted.test(description);
  }).map(([name]) => name);
  if (companies.length) tags.unshift('Big names');
  if (!tags.length) tags.push('Around town');
  const startTime = new Date(e.start).getTime();
  const daysAway = Number.isFinite(startTime) ? Math.max(0, (startTime - now) / 86400000) : 0;
  const popularity = Number(e.popularity);
  const popularityBoost = Number.isFinite(popularity) && popularity > 0 ? Math.min(8, Math.log10(popularity + 1) * 2.5) : 0;
  const score = Math.min(99, Math.round(50 + Math.max(0, 10 - daysAway * 0.35) + popularityBoost + (companies.length ? 4 : 0) + (tags.includes('Tech') ? 3 : 0) + socialScore + (tags.includes('Music & nightlife') ? 2 : 0)));
  return { ...e, tags: [...new Set(tags)], companies, score: e.spotsLeft === 0 || ['sold-out', 'waitlist', 'closed'].includes(e.availability) ? Math.max(0, score - 50) : score };
}

function mergeEvent(previous, next) {
  const nextText = next.description?.length || 0;
  const previousText = previous.description?.length || 0;
  const preferred = nextText > previousText ? { ...previous, ...next } : { ...next, ...previous };
  return {
    ...preferred,
    description: nextText > previousText ? next.description : (previous.description || ''),
    summary: (next.summary?.length || 0) > (previous.summary?.length || 0) ? next.summary : (previous.summary || next.summary || ''),
    popularity: next.popularity ?? previous.popularity ?? null,
    price: next.price ?? previous.price ?? null,
    organizer: next.organizer || previous.organizer || '',
    image: next.image || previous.image || '',
    postalCode: next.postalCode || previous.postalCode || '',
    spotsLeft: next.spotsLeft ?? previous.spotsLeft ?? null,
    availability: next.availability || previous.availability || null,
    approvalRequired: next.approvalRequired ?? previous.approvalRequired ?? null,
    mapsUrl: next.mapsUrl || previous.mapsUrl || '',
    timeKnown: Boolean(next.timeKnown || previous.timeKnown),
    start: next.timeKnown || !previous.timeKnown ? (next.start || previous.start) : previous.start,
    end: next.end || previous.end || null,
  };
}

function isNycLocation(event) {
  const place = `${event.locality || ''} ${event.venue || ''}`.toLowerCase();
  if (/\b(jersey city|newark|hoboken|edison|asbury park|fishkill|bohemia|croton on hudson|florida, ny)\b/.test(place)) return false;
  if (event.postalCode) {
    const zip = Number(String(event.postalCode).match(/\d{5}/)?.[0]);
    if (!Number.isFinite(zip)) return false;
    return (zip >= 10000 && zip <= 10499) || (zip >= 11004 && zip <= 11005) || (zip >= 11100 && zip <= 11499) || (zip >= 11600 && zip <= 11699);
  }
  return /\b(new york|nyc|manhattan|brooklyn|queens|bronx|staten island|astoria|williamsburg|bushwick|greenpoint|long island city|harlem|soho|tribeca|chelsea|flushing|ridgewood|dumbo|park slope|bed.?stuy|crown heights|lower east side|east village|west village|midtown|upper east side|upper west side)\b/.test(place);
}

function isUpcoming(event, now = Date.now()) {
  const start = new Date(event.start).getTime();
  return Number.isFinite(start) && (!event.timeKnown ? nyDay(start) >= nyDay(now) : start >= now) && start < now + 90 * 86400000;
}

// Placeholder/junk titles that slip in from source pages and carry no real event.
const PLACEHOLDER_TITLE = /^(?:untitled|no title|title|test(?:ing)?|tba|tbd|rsvp|register|event|events|new event|sample|example|draft|private event)$/i;

// Prune low-signal listings: empty, placeholder, or non-text titles that make
// for useless cards even when the rest of the fields parse. Date and location
// quality are handled by isUpcoming and isNycLocation.
function isQualityEvent(event) {
  const title = cleanText(event?.title);
  if (title.length < 3) return false;
  if (PLACEHOLDER_TITLE.test(title)) return false;
  if (/^https?:\/\//i.test(title)) return false; // title is just a link
  if (!/[\p{L}\p{N}]/u.test(title)) return false; // no letters or digits (emoji/punctuation only)
  return true;
}

async function fetchSource(source) {
  if (source.kind === 'luma-api') return fetchLumaFeed();
  if (source.kind === 'parks-api') return fetchParks();
  if (source.kind === 'osint') return fetchOsint();
  if (source.name === 'Eventbrite' && Date.now() < eventbriteCooldownUntil) throw new Error('Eventbrite is temporarily rate limited');
  const response = await fetch(source.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Citysignal/1.0; public-event-discovery)', 'Accept': 'text/html' }, signal: AbortSignal.timeout(18000) });
  if (source.name === 'Eventbrite' && response.status === 429) {
    const header = response.headers.get('retry-after');
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    eventbriteCooldownUntil = Date.now() + Math.min(CACHE_MAX_AGE, Math.max(15 * 60000, Number.isFinite(delay) ? delay : 0));
  }
  if (!response.ok) {
    await discardBody(response);
    throw new Error(`HTTP ${response.status}`);
  }
  const events = source.parse(await response.text());
  if (!events.length) throw new Error('No public events found');
  return events;
}

async function fetchAllSources(sources = SOURCES) {
  const results = new Array(sources.length);
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (next < sources.length) {
      const index = next++;
      try {
        const value = await fetchSource(sources[index]);
        const oldSnapshot = pageCache.get(sources[index].url);
        const previous = oldSnapshot && Date.now() - oldSnapshot.fetchedAt < CACHE_MAX_AGE ? oldSnapshot.events : [];
        const byEvent = new Map();
        if (value.partialError) {
          for (const event of [...previous, ...value]) {
            const prior = byEvent.get(event.id);
            byEvent.set(event.id, prior ? mergeEvent(prior, event) : event);
          }
        }
        const merged = value.partialError ? [...byEvent.values()] : value;
        pageCache.set(sources[index].url, { events: merged, fetchedAt: value.partialError && previous.length ? oldSnapshot.fetchedAt : Date.now() });
        results[index] = { status: 'fulfilled', value: merged, partialError: value.partialError, reused: Boolean(value.partialError && previous.length) };
      } catch (reason) {
        const snapshot = pageCache.get(sources[index].url);
        results[index] = { status: 'rejected', reason, value: snapshot && Date.now() - snapshot.fetchedAt < CACHE_MAX_AGE ? snapshot.events : [] };
      }
    }
  }));
  return results;
}

async function scanLuma() {
  const sources = SOURCES.filter(source => source.name === 'Luma');
  const results = await fetchAllSources(sources);
  const status = { Luma: { ok: false, count: 0, pagesOk: 0, pagesFailed: 0 } };
  const byId = new Map();
  for (const result of results) {
    if (result.status === 'fulfilled') {
      status.Luma.ok = true;
      status.Luma.pagesOk++;
      if (result.partialError) {
        status.Luma.pagesFailed++;
        status.Luma.error = result.partialError.message;
      }
    } else {
      status.Luma.pagesFailed++;
      status.Luma.error = result.reason?.message || 'Unavailable';
    }
    for (const event of result.value) {
      if (!event.id || !/^https?:\/\//i.test(event.url || '') || !event.title || !event.start || !isNycLocation(event) || !isUpcoming(event) || !isQualityEvent(event)) continue;
      byId.set(event.id, byId.has(event.id) ? mergeEvent(byId.get(event.id), event) : event);
    }
  }
  const events = [...byId.values()].map(event => enrich(event)).sort((a, b) => b.score - a.score || Date.parse(a.start) - Date.parse(b.start));
  status.Luma.count = events.length;
  return { events, status, updatedAt: new Date().toISOString(), stale: status.Luma.pagesFailed > 0 };
}

async function scanOsint() {
  const source = { name: 'Community (web)', url: 'osint:search', kind: 'osint' };
  const results = await fetchAllSources([source]);
  const status = { 'Community (web)': { ok: false, count: 0, pagesOk: 0, pagesFailed: 0 } };
  const byId = new Map();
  for (const result of results) {
    if (result.status === 'fulfilled') { status['Community (web)'].ok = true; status['Community (web)'].pagesOk++; }
    else { status['Community (web)'].pagesFailed++; status['Community (web)'].error = result.reason?.message || 'Unavailable'; }
    for (const event of result.value) {
      if (!event.id || !/^https?:\/\//i.test(event.url || '') || !event.title || !event.start || !isNycLocation(event) || !isUpcoming(event) || !isQualityEvent(event)) continue;
      byId.set(event.id, byId.has(event.id) ? mergeEvent(byId.get(event.id), event) : event);
    }
  }
  const events = [...byId.values()].map(event => enrich(event)).sort((a, b) => b.score - a.score || Date.parse(a.start) - Date.parse(b.start));
  status['Community (web)'].count = events.length;
  return { events, status, updatedAt: new Date().toISOString(), stale: status['Community (web)'].pagesFailed > 0 };
}

function resetScanCache() {
  cache = null;
  pending = null;
  pendingIsForced = false;
  pageCache.clear();
  eventbriteCooldownUntil = 0;
}

async function scan(force = false) {
  if (pending) {
    if (!force || pendingIsForced) return pending;
    try { await pending; } catch { /* The refresh still needs a new pass. */ }
    return scan(true);
  }
  if (!force && cache && Date.now() - new Date(cache.updatedAt).getTime() < 15 * 60000) {
    const events = cache.events.filter(event => isUpcoming(event)).map(event => enrich(event)).sort((a, b) => b.score - a.score || Date.parse(a.start) - Date.parse(b.start));
    const status = Object.fromEntries(Object.entries(cache.status || {}).map(([name, value]) => [name, { ...value, count: events.filter(event => event.source === name).length }]));
    return { ...cache, events, status };
  }
  pendingIsForced = force;
  pending = (async () => {
    const results = await fetchAllSources();
    const status = {};
    const byId = new Map();
    results.forEach((result, i) => {
      const source = SOURCES[i].name;
      status[source] ||= { ok: false, count: 0, pagesOk: 0, pagesFailed: 0 };
      if (result.status === 'fulfilled') {
        status[source].ok = true;
        status[source].pagesOk++;
        if (result.partialError) {
          status[source].pagesFailed++;
          status[source].error = result.partialError.message || 'Incomplete feed';
        }
      } else {
        status[source].pagesFailed++;
        status[source].error = result.reason?.message || 'Unavailable';
      }
      result.value.forEach(e => {
        if (!e.id || !/^https?:\/\//i.test(e.url || '') || !e.title || !e.start || !isNycLocation(e) || !isUpcoming(e) || !isQualityEvent(e)) return;
        const previous = byId.get(e.id);
        byId.set(e.id, previous ? mergeEvent(previous, e) : e);
      });
    });
    // A new server has no page cache yet. Keep published events from sources
    // that reject this scan until a later scan can refresh them.
    let publishedFallbackUsed = false;
    if (IS_MAIN && Object.values(status).some(source => source.pagesFailed)) {
      try {
        const publishedFile = path.join(ROOT, 'data', 'events.json');
        const published = JSON.parse(fs.readFileSync(publishedFile, 'utf8'));
        if (Date.now() - fs.statSync(publishedFile).mtimeMs < CACHE_MAX_AGE && published.version === 1 && Array.isArray(published.events)) {
          for (const event of published.events) {
            if (!status[event.source]?.pagesFailed || byId.has(event.id)) continue;
            if (!event.id || !/^https?:\/\//i.test(event.url || '') || !event.title || !event.start || !isNycLocation(event) || !isUpcoming(event) || !isQualityEvent(event)) continue;
            byId.set(event.id, event);
            publishedFallbackUsed = true;
          }
        }
      } catch { /* No published snapshot is available. */ }
    }
    // A full outage should not replace the last usable scan with an empty result.
    if (![...Object.values(status)].some(value => value.pagesOk) && cache && Date.now() - Date.parse(cache.updatedAt) < CACHE_MAX_AGE) {
      const events = cache.events.filter(e => isUpcoming(e));
      for (const name of Object.keys(status)) status[name].count = events.filter(e => e.source === name).length;
      return { ...cache, events, stale: true, status };
    }
    const events = [...byId.values()].map(event => enrich(event)).sort((a,b) => b.score - a.score || new Date(a.start) - new Date(b.start));
    for (const name of Object.keys(status)) status[name].count = events.filter(e => e.source === name).length;
    cache = { events, status, updatedAt: new Date().toISOString(), stale: publishedFallbackUsed || results.some(result => result.reused || (result.status === 'rejected' && result.value.length > 0)) };
    saveCache();
    return cache;
  })().finally(() => { pending = null; pendingIsForced = false; });
  return pending;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
export { ldEvents, parseLuma, parseEventbrite, parseParks, fetchLumaFeed, enrich, isNycLocation, isUpcoming, isQualityEvent, mergeEvent, mapsUrl, spotCount, resetScanCache, scan, scanLuma, scanOsint, parseListing, eventFromJsonLd };

async function eventsResponse(force) {
  const result = await scan(force);
  const recommendations = buildRecommendations(result, await loadPreferences(ROOT));
  const ranks = new Map(recommendations.events.map((event, index) => [event.id, index + 1]));
  return { ...result, events: result.events.map(event => ({ ...event, recommendationRank: ranks.get(event.id) ?? null })) };
}

async function runReconCycle() {
  pipelineHealth.running = true;
  pipelineHealth.lastStartedAt = new Date().toISOString();
  pipelineHealth.nextRunAt = null;
  try {
    const result = await scan(true);
    await writeRecommendations(buildRecommendations(result, await loadPreferences(ROOT)), ROOT);
    const complete = Object.values(result.status).every(source => source.pagesFailed === 0);
    if (!complete) {
      console.warn(`Recon scan: ${result.events.length} events; snapshot skipped because source coverage is incomplete`);
    } else {
      const changed = await publishScan(result.events, ROOT, process.env.GITHUB_SYNC === '1');
      console.log(`Recon scan: ${result.events.length} events${changed ? ', snapshot updated' : ''}`);
    }
    pipelineHealth.lastCompletedAt = new Date().toISOString();
    pipelineHealth.lastError = null;
  } catch (error) {
    pipelineHealth.lastError = error.message;
    console.error(`Recon scan failed: ${error.message}`);
  } finally {
    pipelineHealth.running = false;
    pipelineHealth.nextRunAt = new Date(Date.now() + RECON_INTERVAL).toISOString();
    setTimeout(runReconCycle, RECON_INTERVAL);
  }
}

if (IS_MAIN) http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
    if (pathname === '/api/events' && req.method === 'GET') return json(res, 200, await eventsResponse(false));
    if (pathname === '/api/recommendations' && req.method === 'GET') return json(res, 200, buildRecommendations(await scan(false), await loadPreferences(ROOT)));
    if (pathname === '/api/refresh' && req.method === 'POST') {
      if (Date.now() - lastManualRefresh < 60000) return json(res, 429, { error: 'Please wait a minute before refreshing again.' });
      lastManualRefresh = Date.now();
      return json(res, 200, await eventsResponse(true));
    }
    if (pathname === '/api/health') return json(res, 200, { ok: true, updatedAt: cache?.updatedAt || null, degraded: !cache || Date.now() - Date.parse(cache.updatedAt) > RECON_INTERVAL * 2 || Boolean(pipelineHealth.lastError) || Object.values(cache.status || {}).some(source => source.pagesFailed), pipeline: pipelineHealth, sources: cache?.status || {} });
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown API route or method' });
    const dist = path.join(ROOT, 'dist');
    if (!fs.existsSync(dist)) return json(res, 404, { error: 'Build the web app with npm run build or use npm run dev.' });
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(dist, relative);
    const relativeToDist = path.relative(dist, file);
    if (relativeToDist.startsWith(`..${path.sep}`) || relativeToDist === '..' || path.isAbsolute(relativeToDist)) return json(res, 403, { error: 'Forbidden' });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dist, 'index.html');
    const stream = fs.createReadStream(target);
    stream.on('error', () => {
      if (!res.headersSent) json(res, 500, { error: 'Could not read file' });
      else res.destroy();
    });
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
    stream.pipe(res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: 'Scan failed' });
  }
}).listen(PORT, () => {
  console.log(`Citysignal API listening on http://localhost:${PORT}`);
  setTimeout(runReconCycle, 0);
});
