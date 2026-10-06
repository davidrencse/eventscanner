import test from 'node:test';
import assert from 'node:assert/strict';

test('foreign and unknown locations without postal codes are not assumed NYC', () => {
  assert.equal(isNycLocation({ locality: 'San Francisco' }), false);
  assert.equal(isNycLocation({ locality: '' }), false);
  assert.equal(isNycLocation({ locality: 'Astoria' }), true);
});

test('cancelled Eventbrite server data removes the JSON-LD copy', () => {
  const url = 'https://www.eventbrite.com/e/mixer-tickets-123';
  const event = { '@type': 'Event', url, name: 'Mixer', startDate: '2026-10-05', location: { '@type': 'Place', address: { addressLocality: 'New York' } } };
  const html = `<script type="application/ld+json">${JSON.stringify(event)}</script><script>window.__SERVER_DATA__ = ${JSON.stringify({ search_data: { events: { results: [{ url, eventbrite_event_id: '123', is_cancelled: true }] } } })};</script>`;
  assert.deepEqual(parseEventbrite(html), []);
  assert.deepEqual(ldEvents(`<script type="application/ld+json">${JSON.stringify({ ...event, eventStatus: 'https://schema.org/EventCancelled' })}</script>`), []);
});

test('a sold-out ticket tier does not mark all ticket tiers sold out', () => {
  const event = { '@type': 'Event', url: 'https://luma.com/tiers', name: 'Mixer', startDate: '2026-10-05', location: { '@type': 'Place', address: { addressLocality: 'New York' } }, offers: [{ availability: 'https://schema.org/SoldOut' }, { availability: 'https://schema.org/InStock' }] };
  assert.equal(parseLuma(`<script type="application/ld+json">${JSON.stringify(event)}</script>`)[0].spotsLeft, null);
  const base = { title: 'Tech networking mixer', start: new Date(Date.now() + 86400000).toISOString() };
  assert.ok(enrich({ ...base, spotsLeft: 0 }).score < enrich(base).score);
  assert.equal(mapsUrl({ latitude: null, longitude: -73.9 }), '');
});
import { ldEvents, parseLuma, parseEventbrite, parseParks, fetchLumaFeed, enrich, isNycLocation, isUpcoming, mergeEvent, mapsUrl, spotCount, resetScanCache, scan } from './index.js';

test('reads events from direct JSON-LD, graphs, and lists once', () => {
  const html = [
    '<script type="application/ld+json">{"@graph":[{"@type":"Event","url":"https://example.com/a","name":"A"}]}</script>',
    '<script type="application/ld+json">{"itemListElement":[{"item":{"@type":"Event","url":"https://example.com/b","name":"B"}},{"item":{"@type":"Event","url":"https://example.com/a","name":"A"}}]}</script>',
  ].join('');
  assert.deepEqual(ldEvents(html).map(event => event.name), ['A', 'B']);
});

test('Eventbrite excludes virtual listings from NYC results', () => {
  const events = [
    { '@type': 'Event', url: 'https://www.eventbrite.com/e/physical', name: 'Gallery night', startDate: '2026-10-01T19:00:00-04:00', location: { '@type': 'Place', name: 'Gallery', address: { addressLocality: 'Brooklyn', postalCode: '11201' } } },
    { '@type': 'Event', url: 'https://www.eventbrite.com/e/virtual', name: 'Virtual gallery night', startDate: '2026-10-01T19:00:00-04:00', eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode', location: { '@type': 'VirtualLocation', url: 'https://example.com/stream' } },
  ];
  const html = `<script type="application/ld+json">${JSON.stringify({ itemListElement: events.map(item => ({ item })) })}</script>`;
  assert.deepEqual(parseEventbrite(html).map(event => event.title), ['Gallery night']);
});

test('Eventbrite prices require explicit offer amounts', () => {
  const offers = [[{ price: 0 }], [{ price: '12.50' }], [{ price: 0 }, { price: null }], null];
  const events = offers.map((offer, index) => ({
    '@type': 'Event', url: `https://www.eventbrite.com/e/price-${index}`, name: `Price ${index}`,
    startDate: '2026-10-01T19:00:00-04:00', offers: offer,
    location: { '@type': 'Place', name: 'Gallery', address: { addressLocality: 'Brooklyn', postalCode: '11201' } },
  }));
  const html = `<script type="application/ld+json">${JSON.stringify({ itemListElement: events.map(item => ({ item })) })}</script>`;
  assert.deepEqual(parseEventbrite(html).map(event => event.price), ['Free', 'Paid', null, null]);
});

test('Eventbrite listing data adds exact local time and summary to a deduplicated event', () => {
  const url = 'https://www.eventbrite.com/e/networking-night-tickets-123456789';
  const item = { url, name: 'Networking night', eventbrite_event_id: '123456789', start_date: '2026-09-28', start_time: '18:00', end_date: '2026-09-28', end_time: '20:00', summary: 'Meet founders in Midtown.', is_online_event: false, is_cancelled: false, urgency_signals: { messages: ['fewTickets'] }, primary_venue: { name: 'The Hall', address: { city: 'New York', postal_code: '10036', address_1: '311 West 43rd Street', latitude: '40.7584564', longitude: '-73.9900329' } }, tags: [{ prefix: 'EventbriteFormat', display_name: 'Meeting or Networking Event' }] };
  const ld = { itemListElement: [{ item: { '@type': 'Event', url, name: 'Networking night', startDate: '2026-09-28', location: { '@type': 'Place', name: 'The Hall', address: { addressLocality: 'New York', postalCode: '10036' } } } }] };
  const html = `<script type="application/ld+json">${JSON.stringify(ld)}</script><script>window.__SERVER_DATA__ = ${JSON.stringify({ search_data: { events: { results: [item] } } })};</script>`;
  const events = parseEventbrite(html);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'eventbrite:123456789');
  assert.equal(events[0].start, '2026-09-28T22:00:00.000Z');
  assert.equal(events[0].timeKnown, true);
  assert.match(events[0].description, /Meet founders in Midtown/);
  assert.equal(events[0].venue, 'The Hall');
  assert.equal(events[0].availability, 'few');
  assert.equal(events[0].mapsUrl, 'https://www.google.com/maps/search/?api=1&query=40.7584564,-73.9900329');
});

test('NYC Parks events keep local start times and exclude routine kids programming', () => {
  const rows = [
    { guid: '1', title: 'Moli&#232;re in the Park', description: 'A <b>free</b> play', starttime: '2026-09-24T19:30:00.000', link: { url: 'http://www.nycgovparks.org/events/play' }, categories: 'Art | Theater', parkids: 'B123', location: 'Prospect Park', coordinates: '40.660204, -73.968956' },
    { guid: '2', title: 'Kids in Motion', starttime: '2026-09-24T10:00:00.000', link: { url: 'http://www.nycgovparks.org/events/kids' }, categories: 'Sports' },
  ];
  const events = parseParks(rows);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Molière in the Park');
  assert.equal(events[0].start, '2026-09-24T23:30:00.000Z');
  assert.equal(events[0].locality, 'Brooklyn');
  assert.equal(events[0].url, 'https://www.nycgovparks.org/events/play');
  assert.equal(events[0].mapsUrl, 'https://www.google.com/maps/search/?api=1&query=40.660204,-73.968956');
  assert.equal(events[0].price, null);
  assert.equal(parseParks([{ ...rows[0], guid: 'winter', starttime: '2027-01-15T19:30:00.000' }])[0].start, '2027-01-16T00:30:00.000Z');
});

test('explicit mixers rank above gatherings with generic community language', () => {
  const base = { start: new Date(Date.now() + 86400000).toISOString(), description: '', organizer: '', popularity: null };
  const mixer = enrich({ ...base, title: 'Founders networking mixer' });
  const workshop = enrich({ ...base, title: 'Pottery workshop', description: 'Join our creative community.' });
  assert.ok(mixer.score > workshop.score);
  assert.ok(mixer.tags.includes('Mixers'));
  assert.ok(!workshop.tags.includes('Mixers'));
});

test('company tags require event context, not city nicknames or social links', () => {
  const base = { start: new Date(Date.now() + 86400000).toISOString(), organizer: '', popularity: null };
  assert.deepEqual(enrich({ ...base, title: 'The Big Apple Brunch', description: '' }).companies, []);
  assert.deepEqual(enrich({ ...base, title: 'Ice cream pop up', description: 'Follow our TikTok for updates.' }).companies, []);
  assert.deepEqual(enrich({ ...base, title: 'Engineering meetup', description: 'Hosted by Google in New York.' }).companies, ['Google']);
  assert.deepEqual(enrich({ ...base, title: 'Microsoft developer night', description: '' }).companies, ['Microsoft']);
});

test('invalid and elapsed start times are excluded', () => {
  assert.equal(isUpcoming({ start: 'bad', timeKnown: true }), false);
  assert.equal(isUpcoming({ start: new Date(Date.now() - 3600000).toISOString(), timeKnown: true }), false);
  assert.equal(isUpcoming({ start: new Date(Date.now() + 3600000).toISOString(), timeKnown: true }), true);
});

test('a source outage keeps the last upcoming events and reports stale results', async () => {
  resetScanCache();
  const originalFetch = global.fetch;
  let outage = false;
  global.fetch = async url => {
    if (outage || !String(url).includes('get-paginated-events')) throw new Error('Source unavailable');
    return {
      ok: true,
      json: async () => ({ entries: [{
        event: { visibility: 'public', location_type: 'offline', url: 'test-event', name: 'NYC mixer', start_at: new Date(Date.now() + 86400000).toISOString(), geo_address_info: { city: 'New York' } },
        calendar: { name: 'Test host' },
      }], has_more: false }),
    };
  };
  try {
    const first = await scan(true);
    assert.equal(first.events.length, 1);
    outage = true;
    const second = await scan(true);
    assert.equal(second.events.length, 1);
    assert.equal(second.stale, true);
    assert.ok(second.status.Luma.pagesFailed > 0);
  } finally {
    global.fetch = originalFetch;
    resetScanCache();
  }
});

test('Luma keeps fetched cursor pages when a later page fails', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 2) throw new Error('Second page unavailable');
    return { ok: true, json: async () => ({
      entries: [{ event: { visibility: 'public', location_type: 'offline', url: 'page-one', name: 'Page one event', start_at: new Date(Date.now() + 86400000).toISOString() } }],
      has_more: true, next_cursor: 'next-page',
    }) };
  };
  try {
    const events = await fetchLumaFeed();
    assert.equal(events.length, 1);
    assert.match(events.partialError.message, /Second page unavailable/);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Luma registration status takes precedence over a remaining spot count', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({
    entries: [{
      event: { visibility: 'public', location_type: 'offline', url: 'closed-event', name: 'Closed event', start_at: new Date(Date.now() + 86400000).toISOString() },
      ticket_info: { spots_remaining: 86, is_sold_out: false, require_approval: true },
      registration_availability: 'sold-out',
    }], has_more: false,
  }) });
  try {
    const [event] = await fetchLumaFeed();
    assert.equal(event.spotsLeft, 86);
    assert.equal(event.availability, 'sold-out');
    assert.equal(event.approvalRequired, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Luma hybrid listings keep the physical venue and a stable id', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Event',
    name: 'Hybrid mixer',
    url: 'https://luma.com/hybrid-mixer/',
    startDate: '2026-10-02T19:00:00-04:00',
    remainingAttendeeCapacity: 4,
    location: [
      { '@type': 'VirtualLocation', url: 'https://luma.com/hybrid-mixer' },
      { '@type': 'Place', name: 'The Roof', address: { addressLocality: 'Brooklyn', postalCode: '11201' } },
    ],
  })}</script>`;
  const events = parseLuma(html);
  assert.equal(events.length, 1);
  assert.equal(events[0].venue, 'The Roof');
  assert.equal(events[0].locality, 'Brooklyn');
  assert.equal(events[0].postalCode, '11201');
  assert.equal(events[0].id, 'luma:https://luma.com/hybrid-mixer');
  assert.equal(events[0].spotsLeft, 4);
  assert.match(events[0].mapsUrl, /The%20Roof/);
});

test('NYC zip+4 codes stay in the city and other regions stay out', () => {
  assert.equal(isNycLocation({ locality: 'Brooklyn', venue: 'Hall', postalCode: '11201-1234' }), true);
  assert.equal(isNycLocation({ locality: 'New York', venue: 'Hall', postalCode: '07030' }), false);
  assert.equal(isNycLocation({ locality: 'Hoboken', venue: 'Hall', postalCode: '' }), false);
  assert.equal(isNycLocation({ locality: 'New York', venue: 'Hall', postalCode: 'not-a-zip' }), false);
});

test('a longer description does not drop popularity, price, or an exact start', () => {
  const merged = mergeEvent(
    { id: 'luma:https://luma.com/a', title: 'Mixer', description: '', summary: '', popularity: 80, price: 'Free', organizer: 'Host', image: 'https://img.example/a.jpg', postalCode: '', timeKnown: true, start: '2026-10-01T23:00:00.000Z', end: null },
    { id: 'luma:https://luma.com/a', title: 'Mixer', description: 'A longer public description', summary: 'A longer public description', popularity: null, price: null, organizer: '', image: '', postalCode: '10001', timeKnown: false, start: '2026-10-01T16:00:00.000Z', end: null },
  );
  assert.equal(merged.description, 'A longer public description');
  assert.equal(merged.popularity, 80);
  assert.equal(merged.price, 'Free');
  assert.equal(merged.organizer, 'Host');
  assert.equal(merged.image, 'https://img.example/a.jpg');
  assert.equal(merged.postalCode, '10001');
  assert.equal(merged.timeKnown, true);
  assert.equal(merged.start, '2026-10-01T23:00:00.000Z');
  const kept = mergeEvent(
    { description: 'Short', spotsLeft: 12, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=1,2', availability: null },
    { description: 'A longer public description', spotsLeft: null, mapsUrl: '', availability: 'few' },
  );
  assert.equal(kept.spotsLeft, 12);
  assert.equal(kept.mapsUrl, 'https://www.google.com/maps/search/?api=1&query=1,2');
  assert.equal(kept.availability, 'few');
});

test('spot counts and map links use only source-provided places', () => {
  assert.equal(spotCount(10, false), 10);
  assert.equal(spotCount(0, false), 0);
  assert.equal(spotCount(165, true), 0);
  assert.equal(spotCount(null, false), null);
  assert.equal(mapsUrl({ latitude: '40.75', longitude: '-73.99' }), 'https://www.google.com/maps/search/?api=1&query=40.75,-73.99');
  assert.match(mapsUrl({ query: '311 West 43rd Street, New York, NY 10036' }), /311%20West%2043rd%20Street/);
  assert.equal(mapsUrl({ query: 'New York, NY' }), '');
  assert.equal(mapsUrl({ href: 'https://www.google.com/maps/search/?api=1&query=144%20Avenue%20A' }), 'https://www.google.com/maps/search/?api=1&query=144%20Avenue%20A');
});

test('park titles with invalid character references still parse', () => {
  const events = parseParks([{ guid: 'x', title: 'Caf&#x110000; night', description: '', starttime: '2026-09-24T19:30:00.000', link: { url: 'http://www.nycgovparks.org/events/cafe' }, categories: 'Art', parkids: 'M1' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Caf night');
  assert.equal(events[0].locality, 'Manhattan');
});

test('refresh starts another scan after the one already running', async () => {
  resetScanCache();
  const originalFetch = global.fetch;
  let started = 0;
  let releaseFirst;
  let markWaiting;
  const waiting = new Promise(resolve => { markWaiting = resolve; });
  const blocked = new Promise(resolve => { releaseFirst = resolve; });
  global.fetch = async url => {
    if (!String(url).includes('get-paginated-events')) throw new Error('Source unavailable');
    started += 1;
    const id = started;
    if (id === 1) {
      markWaiting();
      await blocked;
    }
    return {
      ok: true,
      json: async () => ({ entries: [{
        event: { visibility: 'public', location_type: 'offline', url: `event-${id}`, name: 'NYC mixer', start_at: new Date(Date.now() + 86400000).toISOString(), geo_address_info: { city: 'New York' } },
      }], has_more: false }),
    };
  };
  try {
    const first = scan(false);
    await waiting;
    const second = scan(true);
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.events[0].url, 'https://luma.com/event-1');
    assert.equal(secondResult.events[0].url, 'https://luma.com/event-2');
  } finally {
    releaseFirst();
    global.fetch = originalFetch;
    resetScanCache();
  }
});
