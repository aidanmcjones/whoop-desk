// CSV export for whoop-desk. Runs in the Electron MAIN process.
//
// Node >= 20, ESM, no dependencies.
//
// Exports:
//   - toCsv(records, columns) -> CSV string
//   - exportCsv({ kind, records, outDir }) -> { path, rows }

import fsp from 'node:fs/promises';
import path from 'node:path';

// -----------------------------------------------------------------------
// Column helpers
// -----------------------------------------------------------------------

// Dot-path lookup, e.g. getPath(record, 'stages.deepMin').
// Returns null (not undefined) when any segment is missing, so downstream
// CSV rendering always sees a clean "empty" value.
function getPath(obj, dotPath) {
  if (obj == null) return null;
  let cur = obj;
  for (const key of dotPath.split('.')) {
    if (cur == null) return null;
    cur = cur[key];
  }
  return cur == null ? null : cur;
}

// A column is either:
//   - a plain string dot-path (header defaults to the path itself), or
//   - { key, header?, format? } for cases needing a custom header or a
//     value transform (e.g. joining an array of tags into a string).
function normalizeColumn(col) {
  if (typeof col === 'string') {
    return { key: col, header: col, format: undefined };
  }
  return {
    key: col.key,
    header: col.header ?? col.key,
    format: col.format,
  };
}

// -----------------------------------------------------------------------
// CSV rendering
// -----------------------------------------------------------------------

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(records, columns) {
  const cols = (columns || []).map(normalizeColumn);
  const lines = [cols.map((c) => csvEscape(c.header)).join(',')];

  for (const record of records || []) {
    const row = cols.map((c) => {
      let value = getPath(record, c.key);
      if (c.format) value = c.format(value, record);
      return csvEscape(value);
    });
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

// -----------------------------------------------------------------------
// Column presets per export kind
// -----------------------------------------------------------------------

const joinTags = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(';');
  return String(value);
};

const PRESETS = {
  recovery: ['date', 'score', 'rhr', 'hrv', 'spo2', 'skinTempC', 'calibrating'],

  sleep: [
    'date',
    'performancePct',
    'durationMin',
    'needMin',
    'efficiencyPct',
    'consistencyPct',
    'stages.deepMin',
    'stages.remMin',
    'stages.lightMin',
    'stages.awakeMin',
    'naps',
  ],

  cycles: ['date', 'strain', 'kilojoules', 'avgHr', 'maxHr'],

  workouts: [
    'date',
    'sport',
    'durationMin',
    'strain',
    'avgHr',
    'maxHr',
    'kilojoules',
    { key: 'zones.z1Min', header: 'zones.z1Min' },
    { key: 'zones.z2Min', header: 'zones.z2Min' },
    { key: 'zones.z3Min', header: 'zones.z3Min' },
    { key: 'zones.z4Min', header: 'zones.z4Min' },
    { key: 'zones.z5Min', header: 'zones.z5Min' },
  ],

  journal: [
    'date',
    { key: 'tags', header: 'tags', format: joinTags },
    'note',
    'createdAt',
  ],
};

// -----------------------------------------------------------------------
// File export
// -----------------------------------------------------------------------

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function exportCsv({ kind, records, outDir }) {
  const columns = PRESETS[kind];
  if (!columns) {
    throw new Error(`Unknown export kind: "${kind}" (expected one of ${Object.keys(PRESETS).join(', ')})`);
  }

  const csv = toCsv(records, columns);
  const fileName = `whoop-${kind}-${todayStr()}.csv`;
  const filePath = path.join(outDir, fileName);

  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(filePath, csv, 'utf8');

  return { path: filePath, rows: (records || []).length };
}
