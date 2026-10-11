import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Bookmark, Info, MapPin, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { dateMatches, nyDateKey } from './dates.js';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
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
  return <div className="relative aspect-square w-20 shrink-0 self-start overflow-hidden rounded-lg bg-muted sm:w-28" aria-hidden="true">
    {event.image && !failed
      ? <img src={event.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
      : <span className="grid size-full place-items-center bg-gradient-to-br from-brand/25 to-brand/5 font-display text-3xl font-extrabold text-brand">{initial}</span>}
  </div>;
}

function EventCard({ event, saved, onSave, showDate, stale, index }) {
  const time = event.timeKnown ? fmt(event.start, { hour: 'numeric', minute: '2-digit' }) : 'Time TBA';
  const date = fmt(event.start, { weekday: 'short', month: 'short', day: 'numeric' });
  const place = [event.venue, event.locality && event.locality !== event.venue ? event.locality : ''].filter(Boolean).join(', ');
  const summary = (event.summary || event.description || '').replace(/\s+/g, ' ').trim();
  const spots = spotsLabel(event);
  const soldOut = event.spotsLeft === 0 || ['sold-out', 'waitlist', 'closed'].includes(event.availability);
  const tags = [...(event.tags || []).filter(tag => tag !== 'Big names' && tag !== 'Around town').slice(0, 2), ...(event.companies || []).slice(0, 2)];
  return <motion.article
    initial={{ opacity: 0, y: 12 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.3, delay: Math.min(index, 8) * 0.03, ease: 'easeOut' }}
    whileHover={{ y: -2 }}
    className="group relative flex gap-4 rounded-xl border bg-card p-3 text-card-foreground shadow-sm transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-md sm:gap-5 sm:p-4"
  >
    <Thumb event={event} />
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-brand">
        <time dateTime={event.start}>{showDate ? `${date} · ${time}` : time}</time>
        {event.price === 'Free' && <Badge variant="success">Free</Badge>}
        {spots && <Badge variant={soldOut ? 'destructive' : 'warning'}>{spots}</Badge>}
      </div>
      <h3 className="font-display text-base font-bold leading-snug tracking-tight sm:text-lg [overflow-wrap:anywhere]">
        {/* The title link covers the card so the whole card is one large target. */}
        <a href={event.url} target="_blank" rel="noopener noreferrer" className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50 hover:underline underline-offset-4">
          {event.title}<span className="sr-only"> (opens {event.source} in a new tab)</span>
        </a>
      </h3>
      {place && <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{place}</span></p>}
      {summary && <p className="hidden text-sm leading-relaxed text-muted-foreground sm:line-clamp-2">{summary}</p>}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <Badge variant="outline" className="font-semibold">{event.source}</Badge>
        {tags.map(tag => <Badge key={tag} variant="secondary">{tag}</Badge>)}
      </div>
      {event.organizer && <p className="truncate text-xs text-muted-foreground">Hosted by {event.organizer}</p>}
      {stale && <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400"><Info className="size-3.5" aria-hidden="true" />Not in the latest scan — check the listing before you go.</p>}
      <div className="relative z-10 -ml-2 mt-1 flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" className={cn('h-10 sm:h-9', saved && 'text-brand')} onClick={() => onSave(event)} aria-pressed={saved} aria-label={`Save ${event.title}`}>
          <motion.span key={String(saved)} initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }} className="inline-flex">
            <Bookmark fill={saved ? 'currentColor' : 'none'} aria-hidden="true" />
          </motion.span>
          {saved ? 'Saved' : 'Save'}
        </Button>
        {event.mapsUrl && <Button asChild variant="ghost" size="sm" className="h-10 sm:h-9"><a href={event.mapsUrl} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${place || event.title}`}><MapPin aria-hidden="true" />Map</a></Button>}
        <Button asChild variant="ghost" size="sm" className="h-10 sm:h-9"><a href={event.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${event.title} on ${event.source}`}><ArrowUpRight aria-hidden="true" />Open on {event.source}</a></Button>
      </div>
    </div>
  </motion.article>;
}

// Pill with a shared sliding highlight (motion layoutId), the signature effect of animated shadcn kits.
function Chip({ selected, onClick, children, count, group }) {
  return <button type="button" aria-pressed={selected} onClick={onClick} disabled={!selected && count === 0}
    className={cn('relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40',
      selected ? 'border-transparent text-primary-foreground' : 'bg-background hover:bg-accent dark:bg-input/30')}>
    {selected && <motion.span layoutId={`chip-${group}`} className="absolute inset-0 rounded-full bg-primary" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
    <span className="relative">{children}</span>
    {count !== undefined && <span className={cn('relative text-xs tabular-nums', selected ? 'text-primary-foreground/70' : 'text-muted-foreground')}>{count}</span>}
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
  const [now, setNow] = useState(Date.now);
  const loadId = useRef(0);
  const headingRef = useRef(null);
  const searchRef = useRef(null);
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
    toast(message, { action: { label: 'Undo', onClick: undo }, duration: 5000 });
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
  const card = (event, index) => <li key={event.id}><EventCard index={index} event={event} saved={saved.includes(event.id)} onSave={toggleSave} showDate={!grouped} stale={view === 'saved' && !currentIds.has(event.id)} /></li>;
  const container = 'mx-auto w-full max-w-4xl px-4 sm:px-6';

  return <div className="min-h-dvh">
    <a href="#results" className="fixed left-3 top-[-60px] z-50 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground focus:top-3">Skip to results</a>
    <Toaster theme="system" position="bottom-center" toastOptions={{ classNames: { actionButton: '!h-9 !px-3 !text-sm' } }} />

    <header ref={topbarRef} className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-xl">
      <div className={cn(container, 'flex flex-wrap items-center gap-x-4 gap-y-2 py-3 sm:h-16 sm:flex-nowrap sm:py-0')}>
        <a href="/" onClick={e => { e.preventDefault(); clearFilters(); changeView('explore'); }} className="flex flex-1 items-baseline gap-1.5 font-display text-xl font-extrabold tracking-tight sm:flex-none">
          citysignal<span className="text-xs font-bold tracking-wider text-brand">NYC</span>
        </a>
        <label className="relative order-3 w-full sm:order-none sm:flex-1">
          <span className="sr-only">Search events</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input ref={searchRef} type="search" value={filters.q} onChange={e => set('q', e.target.value)} placeholder="Search events, venues, hosts…" enterKeyHint="search" className="h-10 rounded-lg pl-9 pr-10" />
          {filters.q
            ? <Button variant="ghost" size="icon" className="absolute right-1 top-1/2 size-8 -translate-y-1/2" onClick={() => { set('q', ''); searchRef.current?.focus(); }} aria-label="Clear search"><X /></Button>
            : <kbd aria-hidden="true" className="absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 text-xs font-medium text-muted-foreground sm:block">/</kbd>}
        </label>
        <nav aria-label="Main" className="relative flex rounded-lg bg-muted p-1">
          {[['explore', 'Explore'], ['saved', 'Saved']].map(([key, label]) => <button key={key} type="button" onClick={() => changeView(key)} aria-current={view === key ? 'page' : undefined}
            className={cn('relative inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50', view === key ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {view === key && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-md bg-background shadow-sm" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
            <span className="relative inline-flex items-center gap-1.5">{key === 'saved' && <Bookmark className="size-3.5" aria-hidden="true" />}{label}
              {key === 'saved' && savedCount > 0 && <span className="min-w-5 rounded-full bg-brand px-1.5 text-center text-[11px] leading-5 text-white">{savedCount}</span>}</span>
          </button>)}
        </nav>
      </div>
    </header>

    <div className="hero-glow border-b" role="region" aria-label="Filters">
      <div className={cn(container, 'flex flex-col gap-2.5 py-4')}>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:-mx-6 sm:px-6" role="group" aria-label="When">
          {WHEN.map(([value, label]) => <Chip key={value} group="when" selected={filters.when === value} count={value === 'Any date' ? undefined : whenCounts[value]} onClick={() => { set('when', value); if (value !== 'Any date' && filters.sort === 'Best match') set('sort', 'Soonest'); }}>{label}</Chip>)}
          <span className="mx-1 my-1.5 w-px shrink-0 bg-border" aria-hidden="true" />
          <Button variant={showMore || moreCount ? 'secondary' : 'outline'} className="h-9 shrink-0 rounded-full" aria-expanded={showMore} aria-controls="more-filters" onClick={() => setShowMore(open => !open)}>
            <SlidersHorizontal aria-hidden="true" />Filters{moreCount > 0 && <span className="rounded-full bg-brand px-1.5 text-[11px] leading-5 text-white">{moreCount}</span>}
          </Button>
        </div>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:-mx-6 sm:px-6" role="group" aria-label="Type">
          {TYPES.map(type => <Chip key={type} group="type" selected={filters.type === type} count={typeCounts[type]} onClick={() => toggle('type', type)}>{type}</Chip>)}
        </div>
        <AnimatePresence initial={false}>
          {showMore && <motion.div id="more-filters" key="more" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-3">
              <label className="flex flex-col gap-1.5 text-sm font-medium">Source<NativeSelect value={filters.source} onChange={e => set('source', e.target.value)}><option value="">All sources</option>{SOURCES.map(x => <option key={x}>{x}</option>)}</NativeSelect></label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">Price<NativeSelect value={filters.price} onChange={e => set('price', e.target.value)}><option value="">Any price</option><option>Free</option><option>Paid</option></NativeSelect></label>
              <label className="col-span-2 flex flex-col gap-1.5 text-sm font-medium sm:col-span-1">Sort by<NativeSelect value={filters.sort} onChange={e => set('sort', e.target.value)}>{SORTS.map(x => <option key={x}>{x}</option>)}</NativeSelect></label>
            </div>
          </motion.div>}
        </AnimatePresence>
      </div>
    </div>

    <main id="results" className={cn(container, 'pb-24')}>
      <div className="flex items-end justify-between gap-4 pb-4 pt-6">
        <div>
          <h1 ref={headingRef} tabIndex="-1" className="font-display text-2xl font-extrabold tracking-tight outline-none sm:text-3xl">
            {view === 'saved' ? 'Saved' : filters.when === 'Any date' ? 'Upcoming in NYC' : `${WHEN.find(([value]) => value === filters.when)[1]} in NYC`}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
            {loading && !data ? 'Loading events…' : `${events.length.toLocaleString()} ${events.length === 1 ? 'event' : 'events'}`}
            {grouped ? ' · soonest first' : filters.sort === 'Best match' ? ' · best matches first' : ' · most interest first'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          {updated && <span className="hidden sm:inline">Updated {updated}</span>}
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing || loading}><RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden="true" />{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
        </div>
      </div>

      {activeChips.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Active filters">
        <AnimatePresence>{activeChips.map(([key, label]) => <motion.div key={key} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
          <Button variant="secondary" size="sm" className="rounded-full pr-2" onClick={() => set(key, DEFAULTS[key])} aria-label={`Remove filter ${label}`}>{label}<X aria-hidden="true" /></Button>
        </motion.div>)}</AnimatePresence>
        {activeChips.length > 1 && <Button variant="link" size="sm" onClick={clearFilters}>Clear all</Button>}
      </div>}

      {(failed.length > 0 || data?.stale) && <div role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
        <Info className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        {failed.length ? `Some ${failed.join(', ')} pages couldn’t be reached, so a few events may be missing.` : 'Showing an earlier list.'}
        <Button variant="link" size="sm" className="px-1" onClick={() => load(true)}>Try refresh</Button>
      </div>}
      {error && data && <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"><Info className="size-4 text-destructive" aria-hidden="true" />Couldn’t update the list.<Button variant="link" size="sm" className="h-auto p-0" onClick={() => load(true)}>Try again</Button></div>}

      {loading && !data && <ul className="flex flex-col gap-3" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <li key={i} className="flex gap-4 rounded-xl border bg-card p-4"><Skeleton className="size-20 sm:size-28" /><div className="flex flex-1 flex-col gap-2 pt-1"><Skeleton className="h-4 w-1/4" /><Skeleton className="h-5 w-3/4" /><Skeleton className="h-4 w-1/2" /></div></li>)}</ul>}
      {error && !data && <Empty title="Couldn’t load events" text="Check your connection, then try again." action="Try again" onAction={() => load()} />}
      {data && !events.length && (view === 'saved' && !saved.length
        ? <Empty icon={<Bookmark className="size-6" />} title="Nothing saved yet" text="Tap Save on any event to keep it here. Saves stay in this browser." action="Browse events" onAction={() => changeView('explore')} />
        : activeChips.length
          ? <Empty title="No events match" text={`Try removing a filter${filters.when !== 'Any date' ? ' or widening the date' : ''}.`} action="Clear all filters" onAction={clearFilters} />
          : <Empty title="No upcoming events" text={view === 'saved' ? 'Your saved events have all passed.' : 'The scan may be incomplete.'} action={view === 'saved' ? 'Browse events' : 'Refresh'} onAction={() => view === 'saved' ? changeView('explore') : load(true)} />)}

      {events.length > 0 && (grouped
        ? groups.map(group => { const label = dayLabel(group.key, now); return <section key={group.key} aria-label={`${label.title}, ${label.sub}`} className="mt-2">
            <h2 className="sticky z-20 bg-background/90 py-3 text-sm font-medium text-muted-foreground backdrop-blur" style={{ top: 'var(--topbar-h, 64px)' }}><span className="mr-2 font-display text-lg font-extrabold tracking-tight text-foreground">{label.title}</span>{label.sub}</h2>
            <ul className="flex flex-col gap-3">{group.items.map(card)}</ul>
          </section>; })
        : <ul className="flex flex-col gap-3">{shown.map(card)}</ul>)}
      {events.length > visible && <div className="mt-6 flex flex-col items-center gap-2 text-sm text-muted-foreground"><p>Showing {visible} of {events.length.toLocaleString()}</p><Button variant="outline" size="lg" onClick={() => setVisible(n => n + PAGE)}>Show more</Button></div>}

      <footer className="mt-14 border-t pt-5 text-sm leading-relaxed text-muted-foreground">
        <p>Public listings from {SOURCES.join(', ')}. Details change — confirm on the original page before you go.</p>
        {sources.length > 0 && <details className="mt-2">
          <summary className="w-max cursor-pointer font-medium text-foreground/80">Sources and ranking</summary>
          <ul className="my-2">{sources.map(([name, status]) => <li key={name}>{name}: {status.count ?? 0} listings{status.pagesFailed ? ` (${status.pagesFailed} page${status.pagesFailed === 1 ? '' : 's'} unavailable)` : ''}</li>)}</ul>
          <p>Best match favors mixers and social events, then events people already show interest in. A company name means the listing mentions it, not that the company hosts it.</p>
        </details>}
      </footer>
    </main>
  </div>;
}

function Empty({ icon, title, text, action, onAction }) {
  return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-16 text-center">
    {icon && <div className="mb-1 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">{icon}</div>}
    <h2 className="font-display text-xl font-bold">{title}</h2>
    <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
    <Button className="mt-3" size="lg" onClick={onAction}>{action}</Button>
  </motion.div>;
}

createRoot(document.getElementById('root')).render(<App />);
