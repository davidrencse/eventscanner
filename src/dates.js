const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

export function nyDateKey(value) {
  return nyDate.format(new Date(value));
}

function shiftDateKey(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekendKeys(now) {
  const today = nyDateKey(now);
  const [year, month, day] = today.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const saturday = shiftDateKey(today, weekday === 0 ? -1 : 6 - weekday);
  return [saturday, shiftDateKey(saturday, 1)];
}

export function dateMatches(start, filter, now = new Date()) {
  if (filter === 'Any date') return true;
  const eventTime = new Date(start).getTime();
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(eventTime) || !Number.isFinite(nowDate.getTime())) return false;
  if (filter === 'Today') return nyDateKey(eventTime) === nyDateKey(nowDate);
  if (filter === 'Tonight') {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(eventTime)));
    return nyDateKey(eventTime) === nyDateKey(nowDate) && hour >= 17;
  }
  if (filter === 'Tomorrow') return nyDateKey(eventTime) === shiftDateKey(nyDateKey(nowDate), 1);
  if (filter === 'Next 7 days') return eventTime >= nowDate.getTime() && eventTime <= nowDate.getTime() + 7 * 86400000;
  if (filter === 'This weekend') return weekendKeys(nowDate).includes(nyDateKey(eventTime));
  return true;
}
