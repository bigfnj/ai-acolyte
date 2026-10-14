'use strict';

// scripts/check-claude-strip-model.js, against synthetic "binaries": bytes that hold the
// list the way the 2.1.296 bundle does (`new Set(["GOEXPERIMENT",...])`, measured 2026-10-13)
// among filler and decoys. The real installed binary is never read here: the check is a
// maintenance command for a developer's machine, and CI has no Claude Code to read.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-claude-strip-model.js');
const { check, defaultBinary, main } = require(SCRIPT);
const { CLAUDE_SAFE_ENV_VARS } = require('../src/permission-match');

const KNOWN = [...CLAUDE_SAFE_ENV_VARS];
const literal = (names) => `IG=new Set([${names.map((name) => `"${name}"`).join(',')}]);`;
// Filler that is not text, a NUL-separated string table holding the same names (the shape the
// first occurrence in the real binary has), and a short colour list that overlaps the real one.
const DECOYS = [
  crypto.randomBytes(3000),
  Buffer.from(`\0${KNOWN.join('\0')}\0`, 'latin1'),
  Buffer.from('var c=["NO_COLOR","FORCE_COLOR","TERM","COLORTERM","CLICOLOR","CLICOLOR_FORCE"];', 'latin1'),
  crypto.randomBytes(3000),
];

function binary(t, ...parts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-strip-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'claude.exe');
  fs.writeFileSync(file, Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1')))));
  return file;
}
function quietly(fn) {
  const lines = [];
  const { log, error } = console;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try { return { code: fn(), lines }; } finally { Object.assign(console, { log, error }); }
}

test('the list this repo holds is found among decoys, and the binary is only read', (t) => {
  const file = binary(t, DECOYS[0], DECOYS[1], literal(KNOWN), DECOYS[2], DECOYS[3]);
  const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const result = check(file);
  assert.equal(result.status, 'same');
  assert.equal(result.count, KNOWN.length);
  assert.deepEqual([result.added, result.dropped], [[], []]);
  // The string table and the colour list are not candidates: one array, at the literal.
  assert.equal(result.candidates, 1);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before);
  assert.equal(quietly(() => main(['--binary', file])).code, 0);
});

test('a name Claude Code adds or drops is drift, named, with exit 1', (t) => {
  const added = check(binary(t, DECOYS[0], literal([...KNOWN, 'NEW_SAFE_VAR']), DECOYS[3]));
  // MUTATION: compare by size only (status 'same' when the counts agree). Swapping one
  // name for another passes as the same set; the third case below fails. Confirmed 2026-10-13.
  assert.deepEqual([added.status, added.added, added.dropped], ['drift', ['NEW_SAFE_VAR'], []]);
  const dropped = check(binary(t, literal(KNOWN.filter((name) => name !== 'CI'))));
  assert.deepEqual([dropped.status, dropped.added, dropped.dropped], ['drift', [], ['CI']]);
  const swapped = check(binary(t, literal([...KNOWN.filter((name) => name !== 'TZ'), 'TZDIR'])));
  assert.deepEqual([swapped.status, swapped.added, swapped.dropped], ['drift', ['TZDIR'], ['TZ']]);
  const { code, lines } = quietly(() => main(['--binary', binary(t, literal([...KNOWN, 'NEW_SAFE_VAR']))]));
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes('NEW_SAFE_VAR')), lines.join('\n'));
});

test('no list, two different lists, or no binary is no decision, exit 2', (t) => {
  // MUTATION: drop the half-the-names floor (any quoted-name array is a candidate). The
  // colour list becomes a second candidate and the first test fails with 2 candidates;
  // here the decoys-only file finds one and reads as drift. Confirmed 2026-10-13.
  assert.equal(check(binary(t, ...DECOYS)).status, 'undecided');
  const two = check(binary(t, literal(KNOWN), DECOYS[0], literal([...KNOWN, 'OTHER_VAR'])));
  assert.deepEqual([two.status, two.candidates], ['undecided', 2]);
  // The same list twice is one answer, in the same order or another.
  // MUTATION: key the candidates by position instead of by sorted name set. The reordered
  // copy reads as a second list and this fails. Confirmed 2026-10-13.
  assert.equal(check(binary(t, literal(KNOWN), DECOYS[0], literal(KNOWN))).status, 'same');
  assert.equal(check(binary(t, literal(KNOWN), DECOYS[0], literal([...KNOWN].reverse()))).status, 'same');
  // A list that lost more than half of the names is not trusted as drift either.
  assert.equal(check(binary(t, literal(KNOWN.slice(0, 12)))).status, 'undecided');
  assert.equal(quietly(() => main(['--binary', binary(t, ...DECOYS)])).code, 2);
  assert.equal(quietly(() => main(['--binary', path.join(os.tmpdir(), 'acolyte-no-such-claude.exe')])).code, 2);
  assert.equal(quietly(() => main(['--bogus'])).code, 2);
});

test('a list that straddles a read boundary is still read whole', (t) => {
  // MUTATION: set OVERLAP to 0 in the script. The literal is cut in two at the 4096-byte
  // boundary and neither half is found. Confirmed 2026-10-13.
  const file = binary(t, crypto.randomBytes(4096 - 100), literal(KNOWN), crypto.randomBytes(5000));
  assert.equal(check(file, CLAUDE_SAFE_ENV_VARS, 4096).status, 'same');
});

test('without --binary the newest installed extension is read, by version, not by name', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-strip-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const version of ['2.1.9', '2.1.10', '2.0.99']) {
    const dir = path.join(home, '.vscode', 'extensions', `anthropic.claude-code-${version}-win32-x64`,
      'resources', 'native-binary');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude.exe'), '');
  }
  fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-9.9.9-win32-x64'), { recursive: true });
  // MUTATION: sort the directory names as strings. `2.1.9` sorts above `2.1.10` and this
  // fails. Confirmed 2026-10-13. A version with no binary in it is skipped.
  const found = defaultBinary(home);
  assert.match(found.path, /anthropic\.claude-code-2\.1\.10-win32-x64/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-strip-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(defaultBinary(empty), null);
});

test('the command line runs it and reports by exit code', (t) => {
  const file = binary(t, literal(KNOWN));
  const run = spawnSync(process.execPath, [SCRIPT, '--binary', file, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, 'same');
});
