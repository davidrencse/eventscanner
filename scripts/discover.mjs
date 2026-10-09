import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, scanLuma, scanOsint } from '../server/index.js';
import { buildRecommendations, loadPreferences, writeRecommendations } from '../server/pipeline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preferences = await loadPreferences(root);
const lumaOnly = process.argv.includes('--luma');
const osintOnly = process.argv.includes('--osint');
const scanResult = osintOnly ? await scanOsint() : lumaOnly ? await scanLuma() : await scan(true);
const result = buildRecommendations(scanResult, preferences);
const filename = osintOnly ? 'osint-recommendations.json' : lumaOnly ? 'luma-recommendations.json' : 'recommendations.json';
await writeRecommendations(result, root, filename);
console.log(JSON.stringify({ count: result.events.length, complete: result.complete, output: `.cache/${filename}`, sources: result.status,
  top: result.events.slice(0, 10).map(event => ({ title: event.title, start: event.start, score: event.recommendationScore, url: event.url })) }, null, 2));
if (!result.events.length || (process.argv.includes('--strict') && !result.complete)) process.exitCode = 1;
