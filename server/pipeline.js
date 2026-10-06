import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PREFERENCES = Object.freeze({ interests: ['Mixers', 'Tech'], daysAhead: 30, limit: 30, freeOnly: false, maxPerOrganizer: 3 });
const SOCIAL_SIGNAL = /\b(mixer|networking|happy hour|meetup|meet-up|founder[s']? social|community gathering|meet and greet)\b/i;
const TECH_SIGNAL = /\b(ai|artificial intelligence|tech|startup|founder|developer|software|product|hackathon|fintech|venture|robotics|data science|cybersecurity|engineering)\b/i;

export function validatePreferences(value = {}) {
  const preferences = { ...DEFAULT_PREFERENCES, ...value };
  if (!Array.isArray(preferences.interests) || !preferences.interests.length || preferences.interests.some(x => typeof x !== 'string' || !x.trim())) throw new Error('interests must be a nonempty list of tags');
  for (const [key, max] of [['daysAhead', 90], ['limit', 100], ['maxPerOrganizer', 100]]) {
    if (!Number.isInteger(preferences[key]) || preferences[key] < 1 || preferences[key] > max) throw new Error(`${key} must be an integer from 1 to ${max}`);
  }
  if (typeof preferences.freeOnly !== 'boolean') throw new Error('freeOnly must be a boolean');
  return preferences;
}

export async function loadPreferences(root) {
  try { return validatePreferences(JSON.parse(await fs.readFile(path.join(root, 'config', 'discovery.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return validatePreferences(); throw error; }
}

export function buildRecommendations(scan, input = DEFAULT_PREFERENCES, now = Date.now()) {
  const preferences = validatePreferences(input);
  const candidates = [];
  for (const event of scan.events) {
    const start = Date.parse(event.start);
    const interests = preferences.interests.filter(tag => event.tags?.includes(tag));
    if (!interests.length || event.spotsLeft === 0 || ['sold-out', 'waitlist', 'closed'].includes(event.availability) || !Number.isFinite(start) || start < now || start > now + preferences.daysAhead * 86400000) continue;
    if (preferences.freeOnly && event.price !== 'Free') continue;
    const reasons = interests.map(tag => `${tag} match`);
    const stale = Boolean(event.stale || scan.status?.[event.source]?.pagesFailed);
    const daysAway = (start - now) / 86400000;
    const title = event.title || '';
    const context = `${event.organizer || ''} ${event.description || ''}`;
    const titleSocial = SOCIAL_SIGNAL.test(title);
    const titleTech = TECH_SIGNAL.test(title);
    const contextSocial = SOCIAL_SIGNAL.test(context);
    const contextTech = TECH_SIGNAL.test(context);
    let score = interests.length * 18 + Math.max(0, 10 - daysAway * 0.35);
    if (titleSocial) score += 12;
    else if (contextSocial) score += 3;
    if (titleTech) score += 10;
    else if (contextTech) score += 3;
    if (titleSocial && titleTech) { score += 8; reasons.push('Tech networking in title'); }
    if (event.organizer?.trim()) { score += 3; reasons.push('Organizer listed'); }
    const popularity = Number(event.popularity);
    if (event.popularity !== null && event.popularity !== undefined && Number.isFinite(popularity) && popularity > 0) {
      score += Math.min(8, Math.log10(popularity + 1) * 3);
      reasons.push('Attendance reported');
    }
    if (event.spotsLeft !== null && event.spotsLeft !== undefined && Number(event.spotsLeft) > 0) { score += 3; reasons.push('Tickets available'); }
    if (event.availability === 'open') { score += 8; reasons.push('Registration open'); }
    if (event.timeKnown) { score += 1; reasons.push('Start time listed'); }
    if (event.price === 'Free') { score += 3; reasons.push('Confirmed free'); }
    else if (event.price === 'Paid') score += 1;
    if (event.approvalRequired) { score -= 2; reasons.push('Host approval required'); }
    if (stale) { score -= 15; reasons.push('Source coverage incomplete; confirm listing'); }
    candidates.push({ ...event, recommendationScore: Math.round(score * 10) / 10, reasons, stale });
  }
  candidates.sort((a, b) => b.recommendationScore - a.recommendationScore || Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  const seen = new Set();
  const organizers = new Map();
  const events = [];
  for (const event of candidates) {
    // Only collapse cross-platform listings with the same title and exact start.
    const key = `${event.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}|${event.start}`;
    const organizer = event.organizer?.trim().toLowerCase();
    if (seen.has(key) || (organizer && (organizers.get(organizer) || 0) >= preferences.maxPerOrganizer)) continue;
    seen.add(key);
    if (organizer) organizers.set(organizer, (organizers.get(organizer) || 0) + 1);
    events.push(event);
    if (events.length === preferences.limit) break;
  }
  return { generatedAt: new Date(now).toISOString(), scannedAt: scan.updatedAt, complete: Object.values(scan.status || {}).length > 0 && Object.values(scan.status).every(source => source.pagesFailed === 0), preferences, candidateCount: candidates.length, events, status: scan.status };
}

export async function writeRecommendations(result, root, filename = 'recommendations.json') {
  const file = path.join(root, '.cache', filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  await fs.rename(`${file}.tmp`, file);
}
