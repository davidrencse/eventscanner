const endpoint = process.env.SCAN_URL || 'http://localhost:3001/api/events';
const response = await fetch(endpoint, { signal: AbortSignal.timeout(90000) });
if (!response.ok) throw new Error(`Scanner returned HTTP ${response.status}`);
const data = await response.json();
if (!Array.isArray(data.events)) throw new Error('Scanner did not return an event list');
const names = ['Luma', 'Partiful', 'NYC Parks'];
const counts = Object.fromEntries(names.map(name => [name, data.events.filter(event => event.source === name).length]));
const ids = new Set();
const now = Date.now();
const nyDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
for (const event of data.events) {
  if (!event.id || !event.title || !event.start || !event.url) throw new Error(`Incomplete event: ${event.id || 'unknown'}`);
  if (ids.has(event.id)) throw new Error(`Duplicate event: ${event.id}`);
  ids.add(event.id);
  if (event.timeKnown ? new Date(event.start).getTime() < now - 120000 : nyDate(event.start) < nyDate(now)) throw new Error(`Past event: ${event.url}`);
  const host = new URL(event.url).hostname;
  if (!['luma.com', 'partiful.com', 'www.eventbrite.com', 'www.eventbrite.ca', 'www.eventbrite.co.uk', 'www.nycgovparks.org'].includes(host)) throw new Error(`Unexpected event URL: ${event.url}`);
}
for (const name of names) if (!counts[name] && !data.status?.[name]?.pagesFailed) throw new Error(`${name} returned no upcoming events`);
console.log(`Checked ${data.events.length} unique upcoming events: ${names.map(name => `${name} ${counts[name]}`).join(', ')}.`);
const failed = Object.entries(data.status || {}).filter(([, status]) => status.pagesFailed).map(([name, status]) => `${name} (${status.pagesFailed} page failures)`);
if (failed.length) console.warn(`Partial source coverage: ${failed.join(', ')}`);
