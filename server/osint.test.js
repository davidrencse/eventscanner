import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOsintConfig, DEFAULT_OSINT_CONFIG, buildQueries, classifyEventUrl,
  robotsAllows, braveSearch, createSearchProvider, discoverListings, osintEnabled, searchApiKey,
} from './osint.js';
import { parseListing } from './index.js';

const ldJson = obj => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`;
const nycEvent = (overrides = {}) => ({
  '@context': 'https://schema.org', '@type': 'Event', name: 'NYC Founders Mixer',
  startDate: '2099-01-01T18:00:00-05:00',
  location: { '@type': 'Place', name: 'The Office', address: { '@type': 'PostalAddress', addressLocality: 'New York', postalCode: '10001', streetAddress: '1 Main St' } },
  ...overrides,
});

test('validateOsintConfig applies defaults and rejects bad values', () => {
  assert.equal(validateOsintConfig().provider, 'brave');
  assert.deepEqual(validateOsintConfig().domains, DEFAULT_OSINT_CONFIG.domains);
  assert.throws(() => validateOsintConfig({ enabled: 'yes' }), /enabled must be a boolean/);
  assert.throws(() => validateOsintConfig({ keywords: [] }), /keywords must be a nonempty list/);
  assert.throws(() => validateOsintConfig({ maxQueries: 0 }), /maxQueries/);
  assert.throws(() => validateOsintConfig({ perHostDelayMs: -1 }), /perHostDelayMs/);
});

test('buildQueries scopes to allowlisted domains and caps at maxQueries', () => {
  const queries = buildQueries(validateOsintConfig({ keywords: ['mixer', 'networking'], domains: ['lu.ma', 'partiful.com'], locationTerms: ['NYC'], maxQueries: 3 }));
  assert.equal(queries.length, 3);
  assert.ok(queries.every(q => q.startsWith('site:')));
  assert.ok(queries[0].includes('NYC'));
});

test('classifyEventUrl keeps only allowlisted listing pages and normalizes them', () => {
  assert.deepEqual(classifyEventUrl('https://lu.ma/cool-event?ref=twitter'), { url: 'https://lu.ma/cool-event', host: 'lu.ma', domain: 'lu.ma' });
  assert.deepEqual(classifyEventUrl('https://www.partiful.com/e/abc123#rsvp'), { url: 'https://partiful.com/e/abc123', host: 'partiful.com', domain: 'partiful.com' });
  assert.equal(classifyEventUrl('https://luma.com/nyc'), null, 'discover feed is not a listing');
  assert.equal(classifyEventUrl('https://luma.com/discover/nyc/tech'), null);
  assert.equal(classifyEventUrl('https://partiful.com/u/someone'), null, 'profile is not an event');
  assert.equal(classifyEventUrl('https://example.com/e/abc'), null, 'off-allowlist domain rejected');
  assert.equal(classifyEventUrl('ftp://lu.ma/x'), null, 'non-http scheme rejected');
});

test('robotsAllows honors wildcard disallow with longest-match allow override', () => {
  const robots = 'User-agent: *\nDisallow: /e/\nAllow: /e/public/';
  assert.equal(robotsAllows(robots, '/e/secret'), false);
  assert.equal(robotsAllows(robots, '/e/public/thing'), true);
  assert.equal(robotsAllows(robots, '/other'), true);
  assert.equal(robotsAllows('', '/anything'), true, 'empty robots allows');
});

test('robotsAllows applies the most specific agent group', () => {
  const robots = 'User-agent: *\nDisallow: /\n\nUser-agent: Citysignal\nDisallow:';
  assert.equal(robotsAllows(robots, '/e/x', 'Mozilla/5.0 (compatible; Citysignal/1.0)'), true);
  assert.equal(robotsAllows(robots, '/e/x', 'SomeOtherBot'), false);
});

test('braveSearch parses result urls and surfaces HTTP errors', async () => {
  const okFetch = async () => ({ ok: true, json: async () => ({ web: { results: [{ url: 'https://lu.ma/a' }, { url: 'https://partiful.com/e/b' }, { title: 'no url' }] } }) });
  assert.deepEqual(await braveSearch('q', { apiKey: 'k', fetchImpl: okFetch }), ['https://lu.ma/a', 'https://partiful.com/e/b']);
  const badFetch = async () => ({ ok: false, status: 429, body: { cancel: async () => {} } });
  await assert.rejects(braveSearch('q', { apiKey: 'k', fetchImpl: badFetch }), /HTTP 429/);
});

test('createSearchProvider is null without a key and callable with one', () => {
  assert.equal(createSearchProvider(validateOsintConfig(), {}), null);
  assert.equal(typeof createSearchProvider(validateOsintConfig(), { BRAVE_SEARCH_API_KEY: 'k' }), 'function');
  assert.equal(searchApiKey({ OSINT_SEARCH_API_KEY: 'z' }), 'z');
  assert.equal(osintEnabled(validateOsintConfig(), {}), false, 'disabled without key');
  assert.equal(osintEnabled(validateOsintConfig({ enabled: false }), { BRAVE_SEARCH_API_KEY: 'k' }), false, 'respects config disable');
  assert.equal(osintEnabled(validateOsintConfig(), { BRAVE_SEARCH_API_KEY: 'k' }), true);
});

test('discoverListings dedupes, filters to the allowlist, honors robots, and caps listings', async () => {
  const pages = {
    'https://lu.ma/one': ldJson(nycEvent({ url: 'https://lu.ma/one' })),
    'https://lu.ma/two': ldJson(nycEvent({ name: 'Second', url: 'https://lu.ma/two' })),
    'https://partiful.com/e/p1': ldJson(nycEvent({ url: 'https://partiful.com/e/p1' })),
  };
  const search = async () => [
    'https://lu.ma/one?ref=x', 'https://lu.ma/one', // duplicate after normalization
    'https://lu.ma/two',
    'https://partiful.com/e/p1',
    'https://evil.example.com/e/haxx', // off allowlist, dropped
    'https://luma.com/nyc', // discover feed, dropped
  ];
  const fetchImpl = async (url) => {
    const key = String(url);
    if (key.endsWith('/robots.txt')) return { ok: true, text: async () => 'User-agent: *\nAllow: /' };
    if (pages[key]) return { ok: true, text: async () => pages[key] };
    return { ok: false, status: 404, body: { cancel: async () => {} } };
  };
  const config = validateOsintConfig({ perHostDelayMs: 0, maxListings: 2 });
  const result = await discoverListings(config, { search, fetchImpl, now: () => 0 });
  assert.equal(result.listings.length, 2, 'capped at maxListings');
  assert.ok(result.discoveredUrls.every(u => u.startsWith('https://lu.ma/') || u.startsWith('https://partiful.com/')));
  assert.ok(!result.discoveredUrls.some(u => u.includes('evil.example.com')));
});

test('discoverListings skips pages a robots.txt disallows', async () => {
  const search = async () => ['https://lu.ma/blocked'];
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/robots.txt')) return { ok: true, text: async () => 'User-agent: *\nDisallow: /blocked' };
    throw new Error('should not fetch a disallowed page');
  };
  const result = await discoverListings(validateOsintConfig({ perHostDelayMs: 0 }), { search, fetchImpl, now: () => 0 });
  assert.equal(result.listings.length, 0);
  assert.ok(result.errors.some(e => /robots/.test(e.error)));
});

test('parseListing produces platform-native ids for cross-source dedupe', () => {
  const [luma] = parseListing('https://luma.com/cool', 'luma.com', ldJson(nycEvent({ url: 'https://luma.com/cool' })));
  assert.equal(luma.source, 'Luma');
  assert.equal(luma.id, 'luma:https://luma.com/cool');

  const [partiful] = parseListing('https://partiful.com/e/abc123', 'partiful.com', ldJson(nycEvent({ url: 'https://partiful.com/e/abc123' })));
  assert.equal(partiful.id, 'partiful:abc123');
  assert.equal(partiful.locality, 'New York');

  const [eb] = parseListing('https://www.eventbrite.com/e/thing-tickets-98765', 'eventbrite.com', ldJson(nycEvent({ url: 'https://www.eventbrite.com/e/thing-tickets-98765' })));
  assert.equal(eb.id, 'eventbrite:98765');

  assert.deepEqual(parseListing('https://example.com/e/x', 'example.com', '<html></html>'), []);
});
