import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initJournal, SUGGESTED_TAGS } from './journal.mjs';

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whoop-desk-journal-test-'));
}

test('SUGGESTED_TAGS is the documented list', () => {
  assert.deepEqual(SUGGESTED_TAGS, [
    'alcohol',
    'caffeine-late',
    'late-meal',
    'travel',
    'sick',
    'stress',
    'late-screen',
    'early-workout',
    'sauna',
    'reading-before-bed',
  ]);
});

test('initJournal creates journal.json in dataDir', async () => {
  const dataDir = await makeTempDir();
  const store = await initJournal({ dataDir });
  assert.equal(store.filePath, path.join(dataDir, 'journal.json'));
  assert.ok(fs.existsSync(store.filePath));
  const raw = JSON.parse(await fsp.readFile(store.filePath, 'utf8'));
  assert.deepEqual(raw, []);
});

test('addEntry defaults date to today and returns full entry shape', async () => {
  const dataDir = await makeTempDir();
  const store = await initJournal({ dataDir });
  const entry = await store.addEntry({ tags: ['alcohol'], note: 'wine with dinner' });

  assert.ok(entry.id);
  assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(entry.tags, ['alcohol']);
  assert.equal(entry.note, 'wine with dinner');
  assert.ok(entry.createdAt);

  const listed = await store.listEntries();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], entry);
});

test('CRUD round-trip: add, update, list, remove', async () => {
  const dataDir = await makeTempDir();
  const store = await initJournal({ dataDir });

  const e1 = await store.addEntry({ date: '2026-01-01', tags: ['sick'], note: 'flu' });
  const e2 = await store.addEntry({ date: '2026-01-03', tags: ['travel'], note: 'flight' });
  const e3 = await store.addEntry({ date: '2026-01-02', tags: [], note: '' });

  let all = await store.listEntries();
  // newest-first by date
  assert.deepEqual(
    all.map((e) => e.date),
    ['2026-01-03', '2026-01-02', '2026-01-01']
  );

  const updated = await store.updateEntry(e1.id, { note: 'flu, day 2', tags: ['sick', 'stress'] });
  assert.equal(updated.id, e1.id);
  assert.equal(updated.note, 'flu, day 2');
  assert.deepEqual(updated.tags, ['sick', 'stress']);
  assert.equal(updated.date, '2026-01-01'); // untouched fields preserved

  const missingUpdate = await store.updateEntry('does-not-exist', { note: 'x' });
  assert.equal(missingUpdate, null);

  const removed = await store.removeEntry(e2.id);
  assert.equal(removed, true);
  const removedAgain = await store.removeEntry(e2.id);
  assert.equal(removedAgain, false);

  all = await store.listEntries();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((e) => e.id),
    [e3.id, e1.id]
  );

  // Persisted to disk correctly (re-open a fresh store over the same dir).
  const reopened = await initJournal({ dataDir });
  const reloaded = await reopened.listEntries();
  assert.equal(reloaded.length, 2);
});

test('listEntries({ days }) filters to a trailing window', async () => {
  const dataDir = await makeTempDir();
  const store = await initJournal({ dataDir });

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  function addDays(dateStr, delta) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  await store.addEntry({ date: today, tags: [], note: 'today' });
  await store.addEntry({ date: addDays(today, -3), tags: [], note: '3 days ago' });
  await store.addEntry({ date: addDays(today, -10), tags: [], note: '10 days ago' });

  const last7 = await store.listEntries({ days: 7 });
  assert.equal(last7.length, 2);
  assert.ok(last7.every((e) => e.note !== '10 days ago'));

  const all = await store.listEntries({});
  assert.equal(all.length, 3);
});

test('atomic write: no leftover tmp files after operations', async () => {
  const dataDir = await makeTempDir();
  const store = await initJournal({ dataDir });
  await store.addEntry({ tags: [], note: 'a' });
  await store.addEntry({ tags: [], note: 'b' });
  await store.updateEntry((await store.listEntries())[0].id, { note: 'a-updated' });

  const files = await fsp.readdir(dataDir);
  const tmpFiles = files.filter((f) => f.includes('.tmp'));
  assert.deepEqual(tmpFiles, []);
  assert.ok(files.includes('journal.json'));
});

test('concurrent addEntry calls are serialized without lost writes', async () => {
  const dataDir = await makeTempDir();
  const store = await initJournal({ dataDir });

  await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.addEntry({ date: '2026-01-01', tags: [], note: `entry-${i}` }))
  );

  const all = await store.listEntries();
  assert.equal(all.length, 10);
  const ids = new Set(all.map((e) => e.id));
  assert.equal(ids.size, 10); // all ids unique, no clobbered writes
});
