import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SNAPSHOT_PATH = 'data/events.json';

export function snapshotEvents(events) {
  return `${JSON.stringify({
    version: 1,
    events: events.map(({ score, ...event }) => event).sort((a, b) => a.id.localeCompare(b.id)),
  }, null, 2)}\n`;
}

export async function syncSnapshotToGithub(contents, { repository, token, branch = 'main', fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token || !branch) {
    throw new Error('GitHub sync needs GITHUB_REPOSITORY, GITHUB_TOKEN, and GITHUB_BRANCH');
  }
  const url = `https://api.github.com/repos/${repository}/contents/${SNAPSHOT_PATH}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Citysignal-recon',
  };
  const current = await fetchImpl(`${url}?ref=${encodeURIComponent(branch)}`, { headers, signal: AbortSignal.timeout(15000) });
  if (current.status !== 404 && !current.ok) throw new Error(`GitHub read failed: HTTP ${current.status}`);
  const remote = current.ok ? await current.json() : null;
  const bytes = Buffer.from(contents);
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (remote?.sha === blobSha) return false;
  const response = await fetchImpl(url, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ message: 'Update NYC event snapshot', content: bytes.toString('base64'), branch, ...(remote?.sha ? { sha: remote.sha } : {}) }),
  });
  if (!response.ok) throw new Error(`GitHub commit failed: HTTP ${response.status}`);
  return true;
}

export async function publishScan(events, root, syncToGithub = false) {
  const file = path.join(root, SNAPSHOT_PATH);
  const next = snapshotEvents(events);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let previous = '';
  try { previous = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const changed = previous !== next;
  if (changed) {
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, next);
    await fs.rename(temporary, file);
  }
  if (syncToGithub) await syncSnapshotToGithub(next, {
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    branch: process.env.GITHUB_BRANCH || 'main',
  });
  return changed;
}
