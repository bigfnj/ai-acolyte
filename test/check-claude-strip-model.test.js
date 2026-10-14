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
const { CLAUDE_SAFE_ENV_VARS, claudeStripsAssignment } = require('../src/permission-match');

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

// M5 (2026-10-14): pin the strip model's case behaviour. wave-f13 read the installed 2.1.296 binary
// and found the membership test case-exact (`IG.has(V)`, no conversion), which is what makes `LANG=C`
// strip and `lang=C` keep its assignment. Nothing pinned that; these do.
test('M5: claudeStripsAssignment is case-exact — LANG=C strips, lang=C does not', () => {
  // MUTATION: make claudeStripsAssignment upper-case the name before the `.has` lookup
  // (src/permission-match.js). The lower- and mixed-case lines fail.
  assert.equal(claudeStripsAssignment('LANG', 'C'), true);
  assert.equal(claudeStripsAssignment('lang', 'C'), false);
  assert.equal(claudeStripsAssignment('Lang', 'C'), false);
});

test('M5: the script reports whether the membership lookup converts case, when it can read it', (t) => {
  // A Set followed by a case-exact `IG.has(e)` reads as 'exact'; one that upper-cases first reads as
  // 'folded'; a binary with no `.has` call near the list says nothing (null), not a guess.
  // The `;` is the delimiter real JavaScript puts before the binding. Without it, DECOYS[0]'s random
  // last byte is an identifier character about one time in four (`xIG`), the detector reads that
  // name, finds no `xIG.has(`, and says null: a flake in the masked suite on 2026-10-14.
  const exact = check(binary(t, DECOYS[0], ';', literal(KNOWN), 'function u(e){return IG.has(e)}', DECOYS[3]));
  assert.equal(exact.lookupCase, 'exact');
  // MUTATION: drop the `.to(Upper|Lower)Case` branch in detectLookupCaseConversion — this reads 'exact'.
  const folded = check(binary(t, literal(KNOWN), 'function u(e){return IG.has(e.toUpperCase())}'));
  assert.equal(folded.lookupCase, 'folded');
  const silent = check(binary(t, DECOYS[0], literal(KNOWN), DECOYS[3]));
  assert.equal(silent.lookupCase, null);
});
