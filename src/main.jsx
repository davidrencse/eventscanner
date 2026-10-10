import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Bookmark, ChevronDown, Compass, MapPin, RefreshCw, Search, X } from 'lucide-react';
import { dateMatches, nyDateKey } from './dates.js';
import './styles.css';

const SOURCES = ['All sources', 'Luma', 'Partiful', 'NYC Parks'];
const TYPES = ['All types', 'Mixers', 'Tech', 'Big names', 'Arts & culture', 'Food & drink', 'Music & nightlife', 'Wellness', 'Business'];
const DATES = ['Any date', 'Tonight', 'Today', 'Tomorrow', 'This weekend', 'Next 7 days'];
const PRICES = ['Any price', 'Free', 'Paid'];
const QUICK_DATES = ['Tonight', 'This weekend', 'Next 7 days'];
const normalizeSavedId = id => {
  if (id.startsWith('eventbrite:https://') && /tickets-(\d+)/.test(id)) return `eventbrite:${/tickets-(\d+)/.exec(id)[1]}`;
  if (id.startsWith('luma:')) return `luma:${id.slice(5).replace(/\/+$/, '')}`;
  return id;
};
const fmt = (value, options) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...options }).format(new Date(value));
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

function EventRow({ event, saved, onSave, unavailable = false, compact = false }) {
  const month = fmt(event.start, { month: 'short' });
  const day = fmt(event.start, { day: 'numeric' });
  const weekday = fmt(event.start, { weekday: 'short' });
  const time = event.timeKnown ? fmt(event.start, { hour: 'numeric', minute: '2-digit' }) : '';
  const description = (event.summary ?? event.description ?? '').replace(/\s+/g, ' ').trim();
  const summary = description.length > 180 ? `${description.slice(0, 177).trimEnd()}…` : description;
  const topicTags = (event.tags || []).filter(tag => tag !== 'Big names').slice(0, event.companies?.length ? 1 : 2);
  const spots = spotsLabel(event);
  const place = `${event.venue}${event.locality && event.locality !== event.venue ? `, ${event.locality}` : ''}`;
  const facts = [
    { text: event.source, className: 'source-label' },
    ...topicTags.map(text => ({ text })),
    ...(event.companies || []).slice(0, 2).map(text => ({ text })),
    { text: event.price === 'Free' || event.price === 'Paid' ? event.price : 'Check price', className: event.price === 'Free' || event.price === 'Paid' ? 'price-label' : 'price-unknown' },
    ...(spots ? [{ text: spots, className: event.spotsLeft === 0 || ['sold-out', 'waitlist', 'closed'].includes(event.availability) ? 'is-sold-out' : '' }] : []),
  ];
  const whenWhere = time && place ? `${time} at ${place}` : [time, place].filter(Boolean).join(' · ') || 'Time is on the event page';
  return <article className={`event-row${compact ? ' compact' : ''}`}>
    <div className="event-date" aria-label={`${weekday}, ${month} ${day}`}><span>{weekday}</span><strong>{day}</strong><span>{month}</span></div>
    <div className="event-body">
      <p className="event-facts">{facts.map((fact, index) => <span key={`${fact.text}-${index}`} className={fact.className}>{fact.text}</span>)}</p>
      <h3><a href={event.url} target="_blank" rel="noopener noreferrer">{event.title}</a></h3>
      <p className="event-meta">{whenWhere}{!time && place ? '. Time on listing.' : ''}</p>
      {!compact && summary && <p className="event-summary">{summary}</p>}
      {!compact && event.organizer && <p className="event-organizer">Hosted by {event.organizer}</p>}
      {unavailable && <p className="event-unavailable">Not in the latest scan. Check the original listing before you go.</p>}
      <div className="event-actions">
        {event.mapsUrl && <a href={event.mapsUrl} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${place}`}><MapPin size={16} /> Directions</a>}
        <button className={saved ? 'is-saved' : ''} type="button" onClick={() => onSave(event.id)} aria-label={saved ? `Saved. Remove ${event.title}` : `Save ${event.title}`}><Bookmark size={16} fill={saved ? 'currentColor' : 'none'} />{saved ? 'Saved' : 'Save'}</button>
        <a href={event.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${event.title} on ${event.source}`}><ArrowUpRight size={16} /> On {event.source}</a>
      </div>
    </div>
  </article>;
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState('explore');
  const [source, setSource] = useState('All sources');
  const [category, setCategory] = useState('All types');
  const [date, setDate] = useState('Any date');
  const [price, setPrice] = useState('Any price');
  const [sort, setSort] = useState('Best match');
  const [query, setQuery] = useState('');
  const [compact, setCompact] = useState(false);
  const [visibleCount, setVisibleCount] = useState(30);
  const [saved, setSaved] = useState(() => { try { return [...new Set(JSON.parse(localStorage.getItem('citysignal-saved') || '[]').map(normalizeSavedId))]; } catch { return []; } });
  const [savedEvents, setSavedEvents] = useState(() => { try { const value = JSON.parse(localStorage.getItem('citysignal-saved-events') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } });
  const [now, setNow] = useState(Date.now);
  const loadId = useRef(0);
  const headingRef = useRef(null);

  async function load(force = false, background = false) {
    const requestId = ++loadId.current;
    if (force) setRefreshing(true);
    else if (!background) setLoading(true);
    setError('');
    try {
      const response = await fetch(force ? '/api/refresh' : '/api/events', { method: force ? 'POST' : 'GET', signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error('The list didn’t load');
      const body = await response.json();
      if (requestId !== loadId.current) return;
      setData(body);
    } catch (e) {
      if (requestId !== loadId.current) return;
      setError('The list didn’t load');
    } finally {
      if (requestId === loadId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(false, true); }, 5 * 60000);
    const clock = setInterval(() => setNow(Date.now()), 60000);
    return () => { clearInterval(timer); clearInterval(clock); loadId.current++; };
  }, []);
  useEffect(() => { try { localStorage.setItem('citysignal-saved', JSON.stringify(saved)); } catch { /* Saving remains available for this session. */ } }, [saved]);
  useEffect(() => { try { localStorage.setItem('citysignal-saved-events', JSON.stringify(savedEvents)); } catch { /* Storage may be disabled or full. */ } }, [savedEvents]);
  useEffect(() => { window.scrollTo(0, 0); }, [view]);
  useEffect(() => { setVisibleCount(30); }, [view, source, category, date, price, sort, query]);
  function toggleSave(id) {
    if (saved.includes(id)) {
      setSaved(current => current.filter(x => x !== id));
      setSavedEvents(current => { const next = { ...current }; delete next[id]; return next; });
    } else {
      const event = data?.events?.find(item => item.id === id) || savedEvents[id];
      if (event) {
        const snapshot = Object.fromEntries(['id', 'source', 'url', 'title', 'start', 'timeKnown', 'venue', 'locality', 'mapsUrl', 'summary', 'tags', 'companies', 'price', 'spotsLeft', 'availability', 'organizer', 'popularity', 'score'].map(key => [key, event[key]]));
        snapshot.description = (event.description || '').slice(0, 200);
        setSavedEvents(current => ({ ...current, [id]: snapshot }));
      }
      setSaved(current => [...current, id]);
    }
  }
  function changeView(next) {
    setView(next);
    requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    });
  }
  function clearFilters() { setSource('All sources'); setCategory('All types'); setDate('Any date'); setPrice('Any price'); setQuery(''); }

  const currentIds = useMemo(() => new Set((data?.events || []).map(event => event.id)), [data]);
  const missingSaved = useMemo(() => saved.map(id => savedEvents[id]).filter(event => event && !currentIds.has(event.id) && new Date(event.start).getTime() >= Date.now()), [saved, savedEvents, currentIds]);
  const events = useMemo(() => {
    const text = query.trim().toLowerCase();
    const pool = view === 'saved' ? [...(data?.events || []), ...missingSaved] : (data?.events || []);
    const result = pool.filter(event =>
      (view !== 'saved' || saved.includes(event.id)) &&
      (source === 'All sources' || event.source === source) &&
      (category === 'All types' || event.tags?.includes(category)) &&
      (price === 'Any price' || event.price === price) &&
      (date !== 'Tonight' || event.timeKnown) &&
      (Number.isFinite(Date.parse(event.start)) && (event.timeKnown ? Date.parse(event.start) >= now : nyDateKey(event.start) >= nyDateKey(now))) &&
      dateMatches(event.start, date, now) &&
      (!text || `${event.title || ''} ${event.description || ''} ${event.organizer || ''} ${event.venue || ''} ${event.locality || ''} ${(event.tags || []).join(' ')}`.toLowerCase().includes(text))
    );
    if (sort === 'Best match') result.sort((a,b) => (a.recommendationRank ?? Infinity) - (b.recommendationRank ?? Infinity) || b.score - a.score || Date.parse(a.start) - Date.parse(b.start));
    if (sort === 'Soonest') result.sort((a,b) => new Date(a.start) - new Date(b.start));
    if (sort === 'Interest where shown') result.sort((a,b) => (b.popularity || 0) - (a.popularity || 0) || b.score - a.score);
    return result;
  }, [data, view, saved, missingSaved, source, category, date, price, sort, query, now]);
  const savedCount = useMemo(() => {
    return saved.filter(id => currentIds.has(id) || missingSaved.some(event => event.id === id)).length;
  }, [saved, currentIds, missingSaved]);
  const hasFilters = source !== 'All sources' || category !== 'All types' || date !== 'Any date' || price !== 'Any price' || query;
  const failed = Object.entries(data?.status || {}).filter(([, value]) => value.pagesFailed > 0).map(([name]) => name);
  const updated = data?.updatedAt ? fmt(data.updatedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const visibleEvents = events.slice(0, visibleCount);
  const sourceStatus = Object.entries(data?.status || {});

  return <div className="site">
    <a className="skip-link" href="#main-content">Skip to events</a>
    <header className="site-header"><div className="header-inner"><a className="wordmark" href="/" onClick={e => { e.preventDefault(); changeView('explore'); clearFilters(); }}>citysignal<span>.</span></a><span className="city-name">A better night starts here. / NYC</span><nav aria-label="Main navigation"><button className={view === 'explore' ? 'active' : ''} onClick={() => changeView('explore')} aria-current={view === 'explore' ? 'page' : undefined}><Compass className="nav-icon" size={18} /><span className="nav-copy">Explore</span></button><button className={view === 'saved' ? 'active' : ''} onClick={() => changeView('saved')} aria-current={view === 'saved' ? 'page' : undefined}><Bookmark className="nav-icon" size={18} /><span className="nav-copy">Saved <span className="nav-count">{savedCount}</span></span></button></nav></div></header>
    <main className="content" id="main-content">
      <section className="page-heading"><div><h1 ref={headingRef} tabIndex="-1">{view === 'saved' ? 'Plans worth keeping.' : 'Go where the city is.'}</h1><p>{view === 'saved' ? 'Your saved plans, kept in this browser.' : 'The best of what’s happening around New York, all in one place.'}</p></div><div className="scan-info">{updated && <span>Updated {updated} ET</span>}<button onClick={() => load(true)} disabled={refreshing || loading}><RefreshCw size={15} className={refreshing ? 'spinning' : ''} />{refreshing ? 'Checking…' : 'Refresh listings'}</button></div></section>
      <section className="find-section" aria-label="Find events">
        <div className="search-field"><Search size={20} aria-hidden="true" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search events, neighborhoods, or hosts" aria-label="Search events" />{query && <button onClick={() => setQuery('')} aria-label="Clear search"><X size={18} /></button>}</div>
        <div className="quick-dates" aria-label="Quick date filters"><span>Looking for</span>{QUICK_DATES.map(option => <button key={option} type="button" className={date === option ? 'selected' : ''} aria-pressed={date === option} onClick={() => { setDate(date === option ? 'Any date' : option); if (date !== option) setSort('Soonest'); }}>{option}</button>)}</div>
        <div className="filter-row"><label><span>Source</span><select value={source} onChange={e => setSource(e.target.value)}>{SOURCES.map(x => <option key={x}>{x}</option>)}</select><ChevronDown size={15} /></label><label><span>Type</span><select value={category} onChange={e => setCategory(e.target.value)}>{TYPES.map(x => <option key={x}>{x}</option>)}</select><ChevronDown size={15} /></label><label><span>When</span><select value={date} onChange={e => setDate(e.target.value)}>{DATES.map(x => <option key={x}>{x}</option>)}</select><ChevronDown size={15} /></label><label><span>Price</span><select value={price} onChange={e => setPrice(e.target.value)}>{PRICES.map(x => <option key={x}>{x}</option>)}</select><ChevronDown size={15} /></label><label><span>Sort</span><select value={sort} onChange={e => setSort(e.target.value)}><option>Best match</option><option>Soonest</option><option>Interest where shown</option></select><ChevronDown size={15} /></label></div>
      </section>
      <div className="results-heading"><div><h2>{view === 'saved' ? 'Saved plans' : 'The shortlist'}</h2><span aria-live="polite">{loading && !data ? 'Loading events' : events.length === 1 ? '1 event' : `${events.length} events`}</span></div><div className="results-actions"><button className={compact ? 'active' : ''} onClick={() => setCompact(value => !value)} aria-pressed={compact}>{compact ? 'Detailed view' : 'Compact view'}</button>{hasFilters && <button onClick={clearFilters}>Clear filters</button>}</div></div>
      {hasFilters && <div className="applied-filters" aria-label="Active filters">{query && <button onClick={() => setQuery('')}>Search: {query} <X size={13} /></button>}{date !== 'Any date' && <button onClick={() => setDate('Any date')}>{date} <X size={13} /></button>}{category !== 'All types' && <button onClick={() => setCategory('All types')}>{category} <X size={13} /></button>}{price !== 'Any price' && <button onClick={() => setPrice('Any price')}>{price} <X size={13} /></button>}{source !== 'All sources' && <button onClick={() => setSource('All sources')}>{source} <X size={13} /></button>}</div>}
      {sourceStatus.length > 0 && <details className="coverage"><summary>Source coverage: {sourceStatus.filter(([, status]) => status.pagesFailed === 0).length} of {sourceStatus.length} fully checked</summary><div>{sourceStatus.map(([name, status]) => <span key={name}>{name}: {status.count ?? 0} listings{status.pagesFailed > 0 ? `, ${status.pagesFailed} page${status.pagesFailed === 1 ? '' : 's'} unavailable` : ''}</span>)}</div></details>}
      {(failed.length > 0 || data?.stale) && <div className="notice">{failed.length > 0 ? `Couldn’t reach every ${failed.length === 1 ? failed[0] : `${failed.slice(0, -1).join(', ')} and ${failed.at(-1)}`} page, so a few events may be missing.` : 'This is an earlier list. Refresh when you want a newer one.'}</div>}
      {error && data && <div className="notice">The list didn’t load. Check your connection and try again. <button onClick={() => load(true)}>Try again</button></div>}
      {error && !data && <div className="empty-state"><h2>Couldn’t load events</h2><p>Check your connection and try again.</p><button onClick={() => load()}>Try again</button></div>}
      {loading && !data && <div className="loading-state">Checking what’s on in New York…</div>}
      {!loading && !error && !events.length && <div className="empty-state"><h2>{view === 'saved' && !saved.length ? 'No saved plans yet.' : hasFilters ? 'No events match these filters.' : view === 'saved' ? 'No upcoming saved plans.' : 'No events are available right now.'}</h2><p>{view === 'saved' && !saved.length ? 'Save an event to keep it in this browser.' : hasFilters ? 'Try a different date, type, source, or search.' : view === 'saved' ? 'Upcoming saved events will appear here.' : 'The scan may be incomplete. Refresh to check again.'}</p><button onClick={() => { if (hasFilters) clearFilters(); else if (view === 'saved') changeView('explore'); else load(true); }}>{hasFilters ? 'Clear filters' : view === 'saved' ? 'Browse events' : 'Refresh listings'}</button></div>}
      {events.length > 0 && <div className="event-list">{visibleEvents.map(event => <EventRow key={event.id} event={event} saved={saved.includes(event.id)} onSave={toggleSave} unavailable={view === 'saved' && !currentIds.has(event.id)} compact={compact} />)}</div>}
      {events.length > visibleCount && <button className="load-more" onClick={() => setVisibleCount(n => n + 30)}>Show {Math.min(30, events.length - visibleCount)} more</button>}
      <footer><p>Public listings from Luma, Partiful, and NYC Parks. Details change, so open the original page before you go.</p><details><summary>Why this order?</summary><p>Best match leads with mixers and social events, then events people are already interested in. A company name means it was mentioned, not that they officially host it. This is the public events we can find, not every event on each site.</p></details></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
