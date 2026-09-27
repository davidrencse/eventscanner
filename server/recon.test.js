import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { snapshotEvents, syncSnapshotToGithub } from './recon.js';

test('event snapshot is stable across scan order and changing rank scores', () => {
  const a = { id: 'a', title: 'First', score: 80 };
  const b = { id: 'b', title: 'Second', score: 70 };
  assert.equal(snapshotEvents([b, a]), snapshotEvents([{ ...a, score: 79 }, { ...b, score: 71 }]));
  assert.deepEqual(JSON.parse(snapshotEvents([b, a])).events.map(event => event.id), ['a', 'b']);
});

test('GitHub sync commits only when the snapshot differs', async () => {
  const contents = snapshotEvents([{ id: 'a', title: 'First' }]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (!options.method) return { ok: true, json: async () => ({ sha: 'old-sha', content: Buffer.from('old snapshot').toString('base64') }) };
    return { ok: true };
  };
  assert.equal(await syncSnapshotToGithub(contents, { repository: 'owner/repo', token: 'test', branch: 'main', fetchImpl }), true);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].options.body).sha, 'old-sha');
  assert.equal(Buffer.from(JSON.parse(calls[1].options.body).content, 'base64').toString('utf8'), contents);

  calls.length = 0;
  const same = async (url, options) => {
    calls.push({ url, options });
    const bytes = Buffer.from(contents);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return { ok: true, json: async () => ({ sha, content: '' }) };
  };
  assert.equal(await syncSnapshotToGithub(contents, { repository: 'owner/repo', token: 'test', fetchImpl: same }), false);
  assert.equal(calls.length, 1);
});
