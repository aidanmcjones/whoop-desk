import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { toCsv, exportCsv } from './export.mjs';

test('toCsv: basic header + rows', () => {
  const csv = toCsv([{ a: 1, b: 'x' }, { a: 2, b: 'y' }], ['a', 'b']);
  assert.equal(csv, 'a,b\n1,x\n2,y');
});

test('toCsv: empty records still produces header row', () => {
  const csv = toCsv([], ['a', 'b']);
  assert.equal(csv, 'a,b');
});

test('toCsv: quotes a value containing a comma', () => {
  const csv = toCsv([{ a: 'foo,bar' }], ['a']);
  assert.equal(csv, 'a\n"foo,bar"');
});

test('toCsv: doubles embedded quotes and wraps in quotes', () => {
  const csv = toCsv([{ a: 'she said "hi"' }], ['a']);
  assert.equal(csv, 'a\n"she said ""hi"""');
});

test('toCsv: wraps a value containing a newline', () => {
  const csv = toCsv([{ a: 'line1\nline2' }], ['a']);
  assert.equal(csv, 'a\n"line1\nline2"');
});

test('toCsv: wraps a value containing a carriage return', () => {
  const csv = toCsv([{ a: 'line1\r\nline2' }], ['a']);
  assert.equal(csv, 'a\n"line1\r\nline2"');
});

test('toCsv: does not quote a plain value', () => {
  const csv = toCsv([{ a: 'plain' }], ['a']);
  assert.equal(csv, 'a\nplain');
});

test('toCsv: dot-path lookup resolves nested fields', () => {
  const csv = toCsv([{ stages: { deepMin: 42 } }], ['stages.deepMin']);
  assert.equal(csv, 'stages.deepMin\n42');
});

test('toCsv: dot-path lookup handles multiple nesting levels', () => {
  const csv = toCsv([{ a: { b: { c: 'deep' } } }], ['a.b.c']);
  assert.equal(csv, 'a.b.c\ndeep');
});

test('toCsv: missing dot-path segment renders as empty, not "undefined"', () => {
  const csv = toCsv([{ stages: {} }], ['stages.deepMin']);
  assert.equal(csv, 'stages.deepMin\n');
});

test('toCsv: dot-path on a record missing the parent key renders as empty', () => {
  const csv = toCsv([{}], ['stages.deepMin']);
  assert.equal(csv, 'stages.deepMin\n');
});

test('toCsv: dot-path through a null intermediate value renders as empty', () => {
  const csv = toCsv([{ stages: null }], ['stages.deepMin']);
  assert.equal(csv, 'stages.deepMin\n');
});

test('toCsv: null and undefined values render as empty string', () => {
  const csv = toCsv([{ a: null, b: undefined, c: 0 }], ['a', 'b', 'c']);
  assert.equal(csv, 'a,b,c\n,,0');
});

test('toCsv: false and 0 are preserved (not treated as empty)', () => {
  const csv = toCsv([{ a: false, b: 0 }], ['a', 'b']);
  assert.equal(csv, 'a,b\nfalse,0');
});

test('toCsv: column object with custom header', () => {
  const csv = toCsv([{ a: 1 }], [{ key: 'a', header: 'Column A' }]);
  assert.equal(csv, 'Column A\n1');
});

test('toCsv: column object with format() transforms the value (tags join)', () => {
  const csv = toCsv(
    [{ tags: ['sick', 'travel'] }, { tags: [] }, { tags: null }],
    [{ key: 'tags', header: 'tags', format: (v) => (Array.isArray(v) ? v.join(';') : '') }]
  );
  assert.equal(csv, 'tags\nsick;travel\n\n');
});

test('toCsv: an array value stringifies with commas and gets quoted', () => {
  const csv = toCsv([{ a: [1, 2, 3] }], ['a']);
  assert.equal(csv, 'a\n"1,2,3"');
});

test('exportCsv: writes a file named whoop-<kind>-<YYYY-MM-DD>.csv and returns path + rows', async () => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whoop-export-test-'));
  try {
    const records = [
      { date: '2026-09-10', score: 55, rhr: 52, hrv: 88, spo2: 97, skinTempC: 33.1, calibrating: false },
    ];
    const result = await exportCsv({ kind: 'recovery', records, outDir });

    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const expectedName = `whoop-recovery-${y}-${m}-${d}.csv`;

    assert.equal(result.path, path.join(outDir, expectedName));
    assert.equal(result.rows, 1);

    const written = await fsp.readFile(result.path, 'utf8');
    assert.match(written, /^date,score,rhr,hrv,spo2,skinTempC,calibrating\n/);
    assert.match(written, /2026-09-10,55,52,88,97,33\.1,false/);
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});

test('exportCsv: flattens sleep stages', async () => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whoop-export-test-'));
  try {
    const records = [
      {
        date: '2026-09-10',
        performancePct: 90,
        durationMin: 420,
        needMin: 450,
        efficiencyPct: 95,
        consistencyPct: 80,
        stages: { deepMin: 80, remMin: 100, lightMin: 220, awakeMin: 20 },
        naps: 0,
      },
    ];
    const result = await exportCsv({ kind: 'sleep', records, outDir });
    const written = await fsp.readFile(result.path, 'utf8');
    assert.match(written, /stages\.deepMin,stages\.remMin,stages\.lightMin,stages\.awakeMin/);
    assert.match(written, /80,100,220,20/);
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});

test('exportCsv: workouts preset uses z1Min..z5Min zone keys (no zone0)', async () => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whoop-export-test-'));
  try {
    const records = [
      {
        date: '2026-09-10',
        sport: 'Running',
        durationMin: 45,
        strain: 12.3,
        avgHr: 140,
        maxHr: 165,
        kilojoules: 500,
        zones: { z1Min: 5, z2Min: 10, z3Min: 15, z4Min: 10, z5Min: 5 },
      },
    ];
    const result = await exportCsv({ kind: 'workouts', records, outDir });
    const written = await fsp.readFile(result.path, 'utf8');
    assert.match(written, /zones\.z1Min,zones\.z2Min,zones\.z3Min,zones\.z4Min,zones\.z5Min/);
    assert.match(written, /5,10,15,10,5$/m);
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});

test('exportCsv: creates outDir if it does not exist', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'whoop-export-test-'));
  const outDir = path.join(base, 'nested', 'dir');
  try {
    const result = await exportCsv({ kind: 'cycles', records: [{ date: '2026-09-10', strain: 10.2 }], outDir });
    const stat = await fsp.stat(result.path);
    assert.ok(stat.isFile());
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('exportCsv: throws on an unknown kind', async () => {
  await assert.rejects(() => exportCsv({ kind: 'bogus', records: [], outDir: os.tmpdir() }), /Unknown export kind/);
});
