import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRecommendations, validatePreferences, loadPreferences, writeRecommendations } from './pipeline.js';

const now = Date.parse('2026-10-04T12:00:00Z');
const event = (id, props = {}) => ({ id, title: `Event ${id}`, source: 'Luma', start: '2026-10-05T22:00:00Z', tags: ['Tech'], timeKnown: true, ...props });
const scan = events => ({ events, updatedAt: new Date(now).toISOString(), status: { Luma: { pagesFailed: 0 } } });

test('shortlist favors tech mixers and excludes unavailable, past, unrelated, and distant events', () => {
  const result = buildRecommendations(scan([
    event('tech'), event('both', { tags: ['Mixers', 'Tech'] }), event('sold', { spotsLeft: 0 }),
    event('past', { start: '2026-10-03T12:00:00Z' }), event('distant', { start: '2026-12-01T12:00:00Z' }),
    event('other', { tags: ['Wellness'] }), event('invalid', { start: 'bad' }),
  ]), undefined, now);
  assert.deepEqual(result.events.map(e => e.id), ['both', 'tech']);
  assert.ok(result.events[0].reasons.includes('Mixers match'));
  assert.equal(result.complete, true);
});

test('shortlist deduplicates platforms and limits organizer domination', () => {
  const events = [event('a', { title: 'Tech Mixer' }), event('b', { title: 'Tech Mixer', source: 'Partiful' }),
    ...Array.from({ length: 5 }, (_, i) => event(`host-${i}`, { organizer: 'Same Host' }))];
  assert.equal(buildRecommendations(scan(events), undefined, now).events.length, 4);
});

test('failed sources are penalized and confirmed-free filtering excludes unknown prices', () => {
  const input = scan([event('fresh', { source: 'Partiful', price: 'Free' }), event('stale', { price: 'Free' }), event('unknown')]);
  input.status = { Luma: { pagesFailed: 1 }, Partiful: { pagesFailed: 0 } };
  const result = buildRecommendations(input, { freeOnly: true }, now);
  assert.deepEqual(result.events.map(e => e.id), ['fresh', 'stale']);
  assert.equal(result.events[1].stale, true);
  assert.equal(result.complete, false);
});

test('clear tech networking and ticket evidence outrank vague tag matches', () => {
  const result = buildRecommendations(scan([
    event('vague', { title: 'Community Evening', tags: ['Mixers', 'Tech'], description: 'Meet other members of our data community.' }),
    event('clear', { title: 'AI Founders Networking Mixer', tags: ['Mixers', 'Tech'], organizer: 'NYC Builders', popularity: 80, spotsLeft: 25, price: 'Free' }),
    event('sold', { title: 'AI Founders Networking Mixer', tags: ['Mixers', 'Tech'], spotsLeft: 0 }),
    event('closed-with-spots', { title: 'AI Founders Networking Mixer', tags: ['Mixers', 'Tech'], spotsLeft: 86, availability: 'sold-out' }),
  ]), undefined, now);
  assert.deepEqual(result.events.map(e => e.id), ['clear', 'vague']);
  assert.ok(result.events[0].reasons.includes('Tech networking in title'));
  assert.ok(result.events[0].reasons.includes('Tickets available'));
});

test('confirmed open registration outranks unknown availability', () => {
  const result = buildRecommendations(scan([
    event('unknown', { title: 'AI Mixer', tags: ['Mixers', 'Tech'] }),
    event('open', { title: 'AI Mixer', tags: ['Mixers', 'Tech'], availability: 'open' }),
  ]), undefined, now);
  assert.equal(result.events[0].id, 'open');
  assert.ok(result.events[0].reasons.includes('Registration open'));
});

test('configuration rejects invalid values and pipeline writes a readable artifact', async () => {
  assert.throws(() => validatePreferences({ daysAhead: -1 }));
  assert.throws(() => validatePreferences({ interests: [] }));
  assert.throws(() => validatePreferences({ freeOnly: 'yes' }));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'citysignal-test-'));
  try {
    const preferences = await loadPreferences(root);
    const result = buildRecommendations(scan([event('a')]), preferences, now);
    await writeRecommendations(result, root);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.cache/recommendations.json'), 'utf8')), result);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
