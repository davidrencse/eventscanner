import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Bookmark, Info, MapPin, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { dateMatches, nyDateKey } from './dates.js';
import './styles.css';

const SOURCES = ['Luma', 'Partiful', 'Eventbrite', 'NYC Parks'];
const TYPES = ['Mixers', 'Tech', 'Music & nightlife', 'Arts & culture', 'Food & drink', 'Business', 'Wellness', 'Big names'];
const WHEN = [['Any date', 'Anytime'], ['Tonight', 'Tonight'], ['Tomorrow', 'Tomorrow'], ['This weekend', 'This weekend'], ['Next 7 days', 'Next 7 days']];
const SORTS = ['Best match', 'Soonest', 'Most interest'];
const DEFAULTS = { q: '', when: 'Any date', type: '', source: '', price: '', sort: 'Best match' };
const PAGE = 30;
const SNAPSHOT_KEYS = ['id', 'source', 'url', 'title', 'start', 'timeKnown', 'venue', 'locality', 'mapsUrl', 'image', 'summary', 'tags', 'companies', 'price', 'spotsLeft', 'availability', 'organizer', 'popularity', 'score'];

const normalizeSavedId = id => {
  if (id.startsWith('eventbrite:https://') && /tickets-(\d+)/.test(id)) return `eventbrite:${/tickets-(\d+)/.exec(id)[1]}`;
  if (id.startsWith('luma:')) return `luma:${id.slice(5).replace(/\/+$/, '')}`;
  return id;
};
const fmt = (value, options) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...options }).format(new Date(value));
const readStore = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be blocked; state stays in memory. */ } };

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const state = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (params.has(key)) state[key] = params.get(key);
  if (!WHEN.some(([value]) => value === state.when)) state.when = DEFAULTS.when;
  if (!SORTS.includes(state.sort)) state.sort = DEFAULTS.sort;
  return { filters: state, view: params.get('view') === 'saved' ? 'saved' : 'explore' };
}

function spotsLabel(event) {
  if (event.availability === 'waitlist') return 'Waitlist';
  if (event.availability === 'sold-out') return 'Sold out';
  if (event.availability === 'closed') return 'Registration closed';
  if (Number.isInteger(event.spotsLeft)) {
    if (event.spotsLeft <= 0) return 'Sold out';
    return event.spotsLeft === 1 ? '1 spot left' : `${event.spotsLeft} spots left`;
  }
  return event.availability === 'few' ? 'Few spots left' : '';
}

function dayLabel(key, now) {
  const today = nyDateKey(now);
  const tomorrow = nyDateKey(new Date(now).getTime() + 86400000);
  const date = new Date(`${key}T12:00:00Z`);
  const long = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(date);
  if (key === today) return { title: 'Today', sub: long };
  if (key === tomorrow) return { title: 'Tomorrow', sub: long };
  return { title: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(date), sub: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(date) };
}

function matches(event, filters, now, skip) {
  const text = filters.q.trim().toLowerCase();
  const start = Date.parse(event.start);
  if (!Number.isFinite(start)) return false;
  if (event.timeKnown ? start < now : nyDateKey(start) < nyDateKey(now)) return false;
  if (skip !== 'source' && filters.source && event.source !== filters.source) return false;
  if (skip !== 'type' && filters.type && !event.tags?.includes(filters.type)) return false;
  if (skip !== 'price' && filters.price && event.price !== filters.price) return false;
  if (skip !== 'when') {
    if (filters.when === 'Tonight' && !event.timeKnown) return false;
    if (!dateMatches(event.start, filters.when, now)) return false;
  }
  if (text && !`${event.title || ''} ${event.description || ''} ${event.organizer || ''} ${event.venue || ''} ${event.locality || ''} ${(event.tags || []).join(' ')} ${(event.companies || []).join(' ')}`.toLowerCase().includes(text)) return false;
  return true;
}

function sortEvents(list, sort) {
  const byStart = (a, b) => Date.parse(a.start) - Date.parse(b.start);
  if (sort === 'Soonest') return list.sort(byStart);
  if (sort === 'Most interest') return list.sort((a, b) => (b.popularity || 0) - (a.popularity || 0) || (b.score || 0) - (a.score || 0));
  return list.sort((a, b) => (a.recommendationRank ?? Infinity) - (b.recommendationRank ?? Infinity) || (b.score || 0) - (a.score || 0) || byStart(a, b));
}

function Thumb({ event }) {
  const [failed, setFailed] = useState(false);
  const initial = (event.title || '?').trim().charAt(0).toUpperCase();
  return <div className="thumb" aria-hidden="true">
    {event.image && !failed
      ? <img src={event.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <span>{initial}</span>}
  </div>;
}

function EventCard({ event, saved, onSave, showDate, stale }) {
  const time = event.timeKnown ? fmt(event.start, { hour: 'numeric', minute: '2-digit' }) : 'Time TBA';
  const date = fmt(event.start, { weekday: 'short', month: 'short', day: 'numeric' });
  const place = [event.venue, event.locality && event.locality !== event.venue ? event.locality : ''].filter(Boolean).join(', ');
  const summary = (event.summary || event.description || '').replace(/\s+/g, ' ').trim();
  const spots = spotsLabel(event);
  const soldOut = event.spotsLeft === 0 || ['sold-out', 'waitlist', 'closed'].includes(event.availability);
  const tags = [...(event.tags || []).filter(tag => tag !== 'Big names' && tag !== 'Around town').slice(0, 2), ...(event.companies || []).slice(0, 2)];
  return <article className="card">
    <Thumb event={event} />
    <div className="card-body">
      <p className="card-when">
        <time dateTime={event.start}>{showDate ? `${date} · ${time}` : time}</time>
        {event.price === 'Free' && <span className="badge badge-good">Free</span>}
        {spots && <span className={`badge ${soldOut ? 'badge-bad' : 'badge-warn'}`}>{spots}</span>}
      </p>
      <h3 className="card-title"><a href={event.url} target="_blank" rel="noopener noreferrer">{event.title}<span className="visually-hidden"> (opens {event.source} in a new tab)</span></a></h3>
      {place && <p className="card-place"><MapPin size={14} aria-hidden="true" />{place}</p>}
      {summary && <p className="card-summary">{summary}</p>}
      <p className="card-meta">
        <span className="source">via {event.source}</span>
        {tags.map(tag => <span key={tag} className="tag">{tag}</span>)}
      </p>
      {event.organizer && <p className="card-host">Hosted by {event.organizer}</p>}
      {stale && <p className="card-stale"><Info size={14} aria-hidden="true" />Not in the latest scan — check the listing before you go.</p>}
      <div className="card-actions">
        <button type="button" className={`icon-btn${saved ? ' is-on' : ''}`} onClick={() => onSave(event)} aria-pressed={saved} aria-label={`Save ${event.title}`}>
          <Bookmark size={18} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" /><span>{saved ? 'Saved' : 'Save'}</span>
        </button>
        {event.mapsUrl && <a className="icon-btn" href={event.mapsUrl} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${place || event.title}`}><MapPin size={18} aria-hidden="true" /><span>Map</span></a>}
        <a className="icon-btn" href={event.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${event.title} on ${event.source}`}><ArrowUpRight size={18} aria-hidden="true" /><span>Open on {event.source}</span></a>
      </div>
    </div>
  </article>;
}

function Chip({ selected, onClick, children, count }) {
  return <button type="button" className={`chip${selected ? ' is-on' : ''}`} aria-pressed={selected} onClick={onClick} disabled={!selected && count === 0}>
    {children}{count !== undefined && <span className="chip-count">{count}</span>}
  </button>;
}

function App() {
  const initial = useMemo(readUrlState, []);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState(initial.view);
  const [filters, setFilters] = useState(initial.filters);
  const [showMore, setShowMore] = useState(Boolean(initial.filters.source || initial.filters.price || initial.filters.sort !== DEFAULTS.sort));
  const [visible, setVisible] = useState(PAGE);
  const [saved, setSaved] = useState(() => { const list = readStore('citysignal-saved', []); return Array.isArray(list) ? [...new Set(list.map(normalizeSavedId))] : []; });
  const [snapshots, setSnapshots] = useState(() => { const value = readStore('citysignal-saved-events', {}); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; });
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Date.now);
  const loadId = useRef(0);
  const headingRef = useRef(null);
  const searchRef = useRef(null);
  const toastTimer = useRef(0);
  const topbarRef = useRef(null);

  useEffect(() => {
    const bar = topbarRef.current;
    const observer = new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`));
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  async function load(force = false, background = false) {
    const requestId = ++loadId.current;
    if (force) setRefreshing(true);
    else if (!background) setLoading(true);
    setError('');
    try {
      const response = await fetch(force ? '/api/refresh' : '/api/events', { method: force ? 'POST' : 'GET', signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error('load failed');
      const body = await response.json();
      if (requestId === loadId.current) setData(body);
    } catch {
      if (requestId === loadId.current) setError('The list didn’t load.');
    } finally {
      if (requestId === loadId.current) { setLoading(false); setRefreshing(false); }
    }
  }

  useEffect(() => {
    load();
    const poll = setInterval(() => { if (!document.hidden) load(false, true); }, 5 * 60000);
    const clock = setInterval(() => setNow(Date.now()), 60000);
    const onKey = e => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    const onPop = () => { const next = readUrlState(); setFilters(next.filters); setView(next.view); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    return () => { clearInterval(poll); clearInterval(clock); window.removeEventListener('keydown', onKey); window.removeEventListener('popstate', onPop); loadId.current++; };
  }, []);

  // Keep filters in the URL so Back works and a filtered list can be shared.
  useEffect(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== DEFAULTS[key]) params.set(key, value);
    if (view === 'saved') params.set('view', 'saved');
    const next = `${window.location.pathname}${params.size ? `?${params}` : ''}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, '', next);
  }, [filters, view]);
  useEffect(() => writeStore('citysignal-saved', saved), [saved]);
  useEffect(() => writeStore('citysignal-saved-events', snapshots), [snapshots]);
  useEffect(() => setVisible(PAGE), [filters, view]);

  const set = useCallback((key, value) => setFilters(current => ({ ...current, [key]: value })), []);
  const toggle = (key, value) => set(key, filters[key] === value ? DEFAULTS[key] : value);
  const clearFilters = () => setFilters(current => ({ ...DEFAULTS, sort: current.sort }));

  function showToast(message, undo) {
    clearTimeout(toastTimer.current);
    setToast({ message, undo });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }
  function toggleSave(event) {
    if (saved.includes(event.id)) {
      const snapshot = snapshots[event.id];
      setSaved(current => current.filter(id => id !== event.id));
      setSnapshots(current => { const next = { ...current }; delete next[event.id]; return next; });
      showToast('Removed from saved', () => {
        setSaved(current => current.includes(event.id) ? current : [...current, event.id]);
        if (snapshot) setSnapshots(current => ({ ...current, [event.id]: snapshot }));
      });
    } else {
      const snapshot = Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, event[key]]));
      snapshot.description = (event.description || '').slice(0, 200);
      setSnapshots(current => ({ ...current, [event.id]: snapshot }));
      setSaved(current => [...current, event.id]);
      showToast('Saved for later', () => {
        setSaved(current => current.filter(id => id !== event.id));
        setSnapshots(current => { const next = { ...current }; delete next[event.id]; return next; });
      });
    }
  }
  function changeView(next) {
    setView(next);
    requestAnimationFrame(() => { window.scrollTo(0, 0); headingRef.current?.focus({ preventScroll: true }); });
  }

  const currentIds = useMemo(() => new Set((data?.events || []).map(event => event.id)), [data]);
  const pool = useMemo(() => {
    if (view !== 'saved') return data?.events || [];
    const live = (data?.events || []).filter(event => saved.includes(event.id));
    const missing = saved.map(id => snapshots[id]).filter(event => event && !currentIds.has(event.id));
    return [...live, ...missing];
  }, [view, data, saved, snapshots, currentIds]);
  const events = useMemo(() => sortEvents(pool.filter(event => matches(event, filters, now)), filters.sort), [pool, filters, now]);
  const typeCounts = useMemo(() => {
    const base = pool.filter(event => matches(event, filters, now, 'type'));
    return Object.fromEntries(TYPES.map(type => [type, base.filter(event => event.tags?.includes(type)).length]));
  }, [pool, filters, now]);
  const whenCounts = useMemo(() => {
    const base = pool.filter(event => matches(event, filters, now, 'when'));
    return Object.fromEntries(WHEN.map(([value]) => [value, base.filter(event => (value !== 'Tonight' || event.timeKnown) && dateMatches(event.start, value, now)).length]));
  }, [pool, filters, now]);
  const savedCount = useMemo(() => saved.filter(id => {
    const event = currentIds.has(id) ? data.events.find(item => item.id === id) : snapshots[id];
    return event && matches(event, DEFAULTS, now);
  }).length, [saved, snapshots, currentIds, data, now]);

  const shown = events.slice(0, visible);
  const grouped = filters.sort === 'Soonest';
  const groups = useMemo(() => {
    if (!grouped) return [];
    const out = [];
    for (const event of shown) {
      const key = nyDateKey(event.start);
      if (out.at(-1)?.key !== key) out.push({ key, items: [] });
      out.at(-1).items.push(event);
    }
    return out;
  }, [grouped, shown]);

  const activeChips = [
    filters.q && ['q', `“${filters.q}”`],
    filters.when !== 'Any date' && ['when', filters.when],
    filters.type && ['type', filters.type],
    filters.source && ['source', filters.source],
    filters.price && ['price', filters.price],
  ].filter(Boolean);
  const moreCount = [filters.source, filters.price].filter(Boolean).length;
  const sources = Object.entries(data?.status || {});
  const failed = sources.filter(([, status]) => status.pagesFailed > 0).map(([name]) => name);
  const updated = data?.updatedAt ? fmt(data.updatedAt, { hour: 'numeric', minute: '2-digit' }) : '';
  const card = event => <li key={event.id}><EventCard event={event} saved={saved.includes(event.id)} onSave={toggleSave} showDate={!grouped} stale={view === 'saved' && !currentIds.has(event.id)} /></li>;

  return <div className="app">
    <a className="skip-link" href="#results">Skip to results</a>
    <header className="topbar" ref={topbarRef}>
      <div className="topbar-inner">
        <a className="brand" href="/" onClick={e => { e.preventDefault(); clearFilters(); changeView('explore'); }}>citysignal<span>NYC</span></a>
        <label className="search">
          <Search size={18} aria-hidden="true" />
          <span className="visually-hidden">Search events</span>
          <input ref={searchRef} type="search" value={filters.q} onChange={e => set('q', e.target.value)} placeholder="Search events, venues, hosts…" enterKeyHint="search" />
          {filters.q ? <button type="button" className="search-clear" onClick={() => { set('q', ''); searchRef.current?.focus(); }} aria-label="Clear search"><X size={16} /></button> : <kbd aria-hidden="true">/</kbd>}
        </label>
        <nav className="tabs" aria-label="Main">
          <button type="button" className={view === 'explore' ? 'is-on' : ''} aria-current={view === 'explore' ? 'page' : undefined} onClick={() => changeView('explore')}>Explore</button>
          <button type="button" className={view === 'saved' ? 'is-on' : ''} aria-current={view === 'saved' ? 'page' : undefined} onClick={() => changeView('saved')}><Bookmark size={16} aria-hidden="true" />Saved{savedCount > 0 && <span className="tab-count">{savedCount}</span>}</button>
        </nav>
      </div>
    </header>

    <div className="filters" role="region" aria-label="Filters">
      <div className="filters-inner">
        <div className="chip-row" role="group" aria-label="When">
          {WHEN.map(([value, label]) => <Chip key={value} selected={filters.when === value} count={value === 'Any date' ? undefined : whenCounts[value]} onClick={() => { set('when', value); if (value !== 'Any date' && filters.sort === 'Best match') set('sort', 'Soonest'); }}>{label}</Chip>)}
          <span className="chip-divider" aria-hidden="true" />
          <button type="button" className={`chip chip-more${showMore || moreCount ? ' is-on' : ''}`} aria-expanded={showMore} aria-controls="more-filters" onClick={() => setShowMore(open => !open)}><SlidersHorizontal size={15} aria-hidden="true" />Filters{moreCount > 0 && <span className="chip-count">{moreCount}</span>}</button>
        </div>
        <div className="chip-row" role="group" aria-label="Type">
          {TYPES.map(type => <Chip key={type} selected={filters.type === type} count={typeCounts[type]} onClick={() => toggle('type', type)}>{type}</Chip>)}
        </div>
        {showMore && <div className="more" id="more-filters">
          <label><span>Source</span><select value={filters.source} onChange={e => set('source', e.target.value)}><option value="">All sources</option>{SOURCES.map(x => <option key={x}>{x}</option>)}</select></label>
          <label><span>Price</span><select value={filters.price} onChange={e => set('price', e.target.value)}><option value="">Any price</option><option>Free</option><option>Paid</option></select></label>
          <label><span>Sort by</span><select value={filters.sort} onChange={e => set('sort', e.target.value)}>{SORTS.map(x => <option key={x}>{x}</option>)}</select></label>
        </div>}
      </div>
    </div>

    <main className="main" id="results">
      <div className="results-head">
        <div>
          <h1 ref={headingRef} tabIndex="-1">{view === 'saved' ? 'Saved' : filters.when === 'Any date' ? 'Upcoming in NYC' : `${WHEN.find(([value]) => value === filters.when)[1]} in NYC`}</h1>
          <p className="status" aria-live="polite">
            {loading && !data ? 'Loading events…' : `${events.length.toLocaleString()} ${events.length === 1 ? 'event' : 'events'}`}
            {grouped ? ' · soonest first' : filters.sort === 'Best match' ? ' · best matches first' : ' · most interest first'}
          </p>
        </div>
        <div className="scan">
          {updated && <span>Updated {updated}</span>}
          <button type="button" className="text-btn" onClick={() => load(true)} disabled={refreshing || loading}><RefreshCw size={14} className={refreshing ? 'spin' : ''} aria-hidden="true" />{refreshing ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>

      {activeChips.length > 0 && <div className="applied" aria-label="Active filters">
        {activeChips.map(([key, label]) => <button key={key} type="button" className="applied-chip" onClick={() => set(key, DEFAULTS[key])} aria-label={`Remove filter ${label}`}>{label}<X size={14} aria-hidden="true" /></button>)}
        {activeChips.length > 1 && <button type="button" className="text-btn" onClick={clearFilters}>Clear all</button>}
      </div>}

      {(failed.length > 0 || data?.stale) && <p className="notice" role="status"><Info size={16} aria-hidden="true" />{failed.length ? `Some ${failed.join(', ')} pages couldn’t be reached, so a few events may be missing.` : 'Showing an earlier list.'} <button type="button" className="text-btn" onClick={() => load(true)}>Try refresh</button></p>}
      {error && data && <p className="notice" role="alert"><Info size={16} aria-hidden="true" />Couldn’t update the list. <button type="button" className="text-btn" onClick={() => load(true)}>Try again</button></p>}

      {loading && !data && <ul className="list" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <li key={i}><div className="card skeleton"><div className="thumb" /><div className="card-body"><i /><i /><i /></div></div></li>)}</ul>}
      {error && !data && <div className="empty"><h2>Couldn’t load events</h2><p>Check your connection, then try again.</p><button type="button" className="btn" onClick={() => load()}>Try again</button></div>}
      {data && !events.length && <div className="empty">
        {view === 'saved' && !saved.length
          ? <><Bookmark size={28} aria-hidden="true" /><h2>Nothing saved yet</h2><p>Tap the bookmark on any event to keep it here. Saves stay in this browser.</p><button type="button" className="btn" onClick={() => changeView('explore')}>Browse events</button></>
          : activeChips.length
            ? <><h2>No events match</h2><p>Try removing a filter{filters.when !== 'Any date' ? ' or widening the date' : ''}.</p><button type="button" className="btn" onClick={clearFilters}>Clear all filters</button></>
            : <><h2>No upcoming events</h2><p>{view === 'saved' ? 'Your saved events have all passed.' : 'The scan may be incomplete.'}</p><button type="button" className="btn" onClick={() => view === 'saved' ? changeView('explore') : load(true)}>{view === 'saved' ? 'Browse events' : 'Refresh'}</button></>}
      </div>}

      {events.length > 0 && (grouped
        ? groups.map(group => { const label = dayLabel(group.key, now); return <section key={group.key} className="day" aria-label={`${label.title}, ${label.sub}`}><h2 className="day-head"><span>{label.title}</span> {label.sub}</h2><ul className="list">{group.items.map(card)}</ul></section>; })
        : <ul className="list">{shown.map(card)}</ul>)}
      {events.length > visible && <div className="more-wrap"><p>Showing {visible} of {events.length.toLocaleString()}</p><button type="button" className="btn btn-quiet" onClick={() => setVisible(n => n + PAGE)}>Show more</button></div>}

      <footer className="foot">
        <p>Public listings from {SOURCES.join(', ')}. Details change — confirm on the original page before you go.</p>
        {sources.length > 0 && <details><summary>Sources and ranking</summary>
          <ul>{sources.map(([name, status]) => <li key={name}>{name}: {status.count ?? 0} listings{status.pagesFailed ? ` (${status.pagesFailed} page${status.pagesFailed === 1 ? '' : 's'} unavailable)` : ''}</li>)}</ul>
          <p>Best match favors mixers and social events, then events people already show interest in. A company name means the listing mentions it, not that the company hosts it.</p>
        </details>}
      </footer>
    </main>

    <div className="toast-region" aria-live="polite">
      {toast && <div className="toast"><span>{toast.message}</span>{toast.undo && <button type="button" onClick={() => { toast.undo(); setToast(null); }}>Undo</button>}</div>}
    </div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
