import test from 'node:test';
import assert from 'node:assert/strict';
import { dateMatches } from './dates.js';

test('this weekend is the coming Saturday and Sunday', () => {
  const friday = new Date('2026-09-25T16:00:00-04:00');
  assert.equal(dateMatches('2026-09-26T18:00:00-04:00', 'This weekend', friday), true);
  assert.equal(dateMatches('2026-09-27T12:00:00-04:00', 'This weekend', friday), true);
  assert.equal(dateMatches('2026-09-25T20:00:00-04:00', 'This weekend', friday), false);
  assert.equal(dateMatches('2026-10-03T12:00:00-04:00', 'This weekend', friday), false);
});

test('sunday stays on the current weekend', () => {
  const sunday = new Date('2026-09-27T15:00:00-04:00');
  assert.equal(dateMatches('2026-09-27T18:00:00-04:00', 'This weekend', sunday), true);
  assert.equal(dateMatches('2026-10-03T12:00:00-04:00', 'This weekend', sunday), false);
  assert.equal(dateMatches('2026-10-04T12:00:00-04:00', 'This weekend', sunday), false);
});

test('today and the next seven days follow New York time', () => {
  const now = new Date('2026-09-24T23:30:00-04:00');
  assert.equal(dateMatches('2026-09-23T12:00:00-04:00', 'Next 7 days', now), false);
  assert.equal(dateMatches('2026-09-25T00:30:00-04:00', 'Today', now), false);
  assert.equal(dateMatches('2026-09-24T23:45:00-04:00', 'Today', now), true);
  assert.equal(dateMatches(new Date(now.getTime() + 7 * 86400000).toISOString(), 'Next 7 days', now), true);
  assert.equal(dateMatches(new Date(now.getTime() + 7 * 86400000 + 60000).toISOString(), 'Next 7 days', now), false);
});

test('tonight and tomorrow use New York dates and evening hours', () => {
  const now = new Date('2026-09-27T14:00:00-04:00');
  assert.equal(dateMatches('2026-09-27T18:00:00-04:00', 'Tonight', now), true);
  assert.equal(dateMatches('2026-09-27T16:30:00-04:00', 'Tonight', now), false);
  assert.equal(dateMatches('2026-09-28T00:30:00-04:00', 'Tonight', now), false);
  assert.equal(dateMatches('2026-09-28T10:00:00-04:00', 'Tomorrow', now), true);
});
