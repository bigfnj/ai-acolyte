'use strict';

// CODEX_TESTED_VERSIONS (src/codex-version.js) and the tables in docs/codex-compatibility.md
// describe the same runs, and the code comment says to keep them in step. Nothing checked
// it, and by the v1.6.2 audit they already disagreed: the list dated 0.145.0 2026-09-28,
// the table 2026-09-27/28. This holds the per-version table (version, platform, date, in
// order) and the declared window to the list. A run that extends the window has to land in
// both, or this fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CODEX_TESTED_VERSIONS, CODEX_VERSION_WINDOW } = require('../src/codex-version');

const DOC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'codex-compatibility.md'), 'utf8');
const PLATFORM = { Windows: 'win32', Linux: 'linux', macOS: 'darwin' };

// The rows of the first table whose header starts `| Version | Platform | Date |`.
function versionTable() {
  const lines = DOC.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\|\s*Version\s*\|\s*Platform\s*\|\s*Date\s*\|/.test(line));
  assert.notEqual(header, -1, 'the per-version table moved or was renamed');
  const rows = [];
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const [version, platform, date] = lines[i].split('|').slice(1, 4).map((cell) => cell.trim());
    rows.push({ version, platform, date });
  }
  return rows;
}

const semver = (v) => v.split('.').map(Number);
const byVersion = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let k = 0; k < 3; k += 1) if (x[k] !== y[k]) return x[k] - y[k];
  return 0;
};

test('the per-version table in the compatibility record matches CODEX_TESTED_VERSIONS row for row', () => {
  const rows = versionTable();
  assert.ok(rows.length >= 3, `precondition: only ${rows.length} rows were read`);
  assert.deepEqual(rows.map((row) => row.version), CODEX_TESTED_VERSIONS.map((entry) => entry.version),
    'the same versions, in the same order');
  for (const [index, entry] of CODEX_TESTED_VERSIONS.entries()) {
    const row = rows[index];
    assert.equal(PLATFORM[row.platform], entry.platform, `${entry.version}: platform`);
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/, `${entry.version}: one date, the most recent run`);
    assert.equal(row.date, entry.date, `${entry.version}: date`);
  }
});

test('the declared window in the record is the window the code declares, and it spans the tested list', () => {
  const declared = /\|\s*Declared window\s*\|\s*\*\*(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+), declared (\d{4}-\d{2}-\d{2})\*\*/.exec(DOC);
  assert.ok(declared, 'the "Declared window" row moved or changed shape');
  assert.deepEqual({ min: declared[1], max: declared[2] }, { ...CODEX_VERSION_WINDOW });
  const tested = CODEX_TESTED_VERSIONS.map((entry) => entry.version).sort(byVersion);
  assert.equal(CODEX_VERSION_WINDOW.min, tested[0], 'the window starts at the oldest version exercised');
  assert.equal(CODEX_VERSION_WINDOW.max, tested[tested.length - 1], 'and ends at the newest');
});
