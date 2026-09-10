// Journal store for whoop-desk: a flat JSON-file-backed CRUD store for
// free-text/tag day notes (used to correlate against WHOOP metrics).
//
// Node >= 20, ESM, no npm dependencies. Writes are atomic (write to a
// tmp file in the same directory, then rename) so a crash mid-write can
// never leave journal.json truncated or corrupt.
//
// Exports:
//   - SUGGESTED_TAGS: string[]
//   - initJournal({ dataDir }) -> Promise<Store>
//
// Store (the object initJournal resolves to) exposes:
//   - filePath: string                                    — <dataDir>/journal.json
//   - addEntry({ date, tags, note }) -> Promise<Entry>     — date defaults to today (America/Chicago)
//   - updateEntry(id, patch) -> Promise<Entry|null>        — null if id not found
//   - removeEntry(id) -> Promise<boolean>                  — false if id not found
//   - listEntries({ days } = {}) -> Promise<Entry[]>       — newest-first; days limits to trailing N days
//
// Entry shape: { id, date, tags, note, createdAt }

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const SUGGESTED_TAGS = [
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
];

const TIMEZONE = 'America/Chicago';

const chicagoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function todayChicago() {
  return chicagoDateFormatter.format(new Date()); // YYYY-MM-DD
}

function addDaysISO(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readEntries(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeEntriesAtomic(filePath, entries) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.journal.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  await fsp.writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
  await fsp.rename(tmpPath, filePath);
}

function dateDesc(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const aCreated = a.createdAt || '';
  const bCreated = b.createdAt || '';
  if (aCreated === bCreated) return 0;
  return aCreated < bCreated ? 1 : -1;
}

export async function initJournal({ dataDir }) {
  if (!dataDir) throw new Error('initJournal requires { dataDir }');
  await fsp.mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'journal.json');

  if (!fs.existsSync(filePath)) {
    await writeEntriesAtomic(filePath, []);
  }

  // Serialize all mutations issued through this store instance so
  // concurrent calls can't race each other's read-modify-write cycle.
  let queue = Promise.resolve();
  function enqueue(fn) {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  async function addEntry({ date, tags = [], note = '' } = {}) {
    return enqueue(async () => {
      const entries = await readEntries(filePath);
      const entry = {
        id: makeId(),
        date: date || todayChicago(),
        tags: Array.isArray(tags) ? [...tags] : [],
        note: note || '',
        createdAt: new Date().toISOString(),
      };
      entries.push(entry);
      await writeEntriesAtomic(filePath, entries);
      return entry;
    });
  }

  async function updateEntry(id, patch = {}) {
    return enqueue(async () => {
      const entries = await readEntries(filePath);
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) return null;
      const updated = { ...entries[idx], ...patch, id: entries[idx].id };
      entries[idx] = updated;
      await writeEntriesAtomic(filePath, entries);
      return updated;
    });
  }

  async function removeEntry(id) {
    return enqueue(async () => {
      const entries = await readEntries(filePath);
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) return false;
      entries.splice(idx, 1);
      await writeEntriesAtomic(filePath, entries);
      return true;
    });
  }

  async function listEntries({ days } = {}) {
    const entries = await readEntries(filePath);
    let filtered = entries;
    if (days != null) {
      const cutoff = addDaysISO(todayChicago(), -(days - 1));
      filtered = entries.filter((e) => e.date >= cutoff);
    }
    return [...filtered].sort(dateDesc);
  }

  return { filePath, addEntry, updateEntry, removeEntry, listEntries };
}
