'use strict';

// Two files carried the raw UTF-8 BOM bytes EF BB BF inside a regex literal
// where every other site in the repo spells the same character as an escape. It
// worked, which is the problem: an invisible character is load-bearing, and any
// re-encode, normalizer, editor or copy-paste can drop or mangle it with no
// error anywhere. This is a source-ENCODING defect, so the condition it asserts
// is about the bytes on disk; the behavioural half is below it.
//
// THE BOM WAS NOT THE ONLY SPELLING OF THE SAME MISTAKE. A raw NUL sat inside a
// string literal in scripts/check-line-refs.js — in a directory this test already
// scanned, added in the same session as this test — and a check that looked for
// one three-byte sequence walked straight past it. That NUL was worse than
// invisible: rg and grep classify a file containing it as binary and drop every
// content match in it, so it silenced the tools you would use to find it, and
// git's own binary sniff only missed it because the byte sat past the 8000-byte
// window. So the byte half below is about control characters generally.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readPolicy } = require('../src/managed-policy');

const ROOT = path.join(__dirname, '..');
const SCANNED_DIRECTORIES = ['src', 'bin', 'scripts', 'test', 'patterns'];
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

// Tab, LF and CR are the only control characters a source file has business
// holding as raw bytes. LF and CR are line terminators and this tree is CRLF;
// tab is indentation the .sh and .ps1 files are entitled to use, and forbidding
// it would be a style rule, not an encoding one. Everything else under 0x20,
// plus DEL (0x7F), is a character someone meant to spell as an escape: NUL, ESC
// for an ANSI sequence, a vertical tab or form feed from a bad paste, the 0x1A
// a DOS-era tool leaves behind. None of them survive a re-encode reliably and
// none of them are visible in a review.
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0A, 0x0D]);
const isRawControlByte = (byte) => (byte < 0x20 || byte === 0x7F) && !ALLOWED_CONTROL_BYTES.has(byte);

// The floor below is deliberately well under the real population. The filter
// reaches 85 files today — src 20, bin 1, scripts 10, test 53, patterns 1 — so
// 60 leaves room for a quarter of the tree to be deleted or renamed before the
// floor trips. It is picked that low because the failure it exists to catch does
// not land near the floor: a directory that moved, a stem that stopped matching
// the extension filter, or an empty SCANNED_DIRECTORIES takes the count to zero
// or near it, never to 59.
const SCANNED_FILE_FLOOR = 60;

function sourceFiles(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { sourceFiles(target, found); continue; }
    if (/\.(js|mjs|cjs|json|ps1|sh)$/.test(entry.name) || !path.extname(entry.name)) {
      found.push(target);
    }
  }
  return found;
}

function scannedFiles() {
  const found = [];
  for (const directory of SCANNED_DIRECTORIES) sourceFiles(path.join(ROOT, directory), found);
  return found;
}

test('no tracked source file carries an invisible character as raw bytes', () => {
  const files = scannedFiles();

  // The precondition, and it has to be asserted BEFORE the offender lists. Zero
  // files read is zero offenders and a green test, which is the shape this test
  // had until it was audited: SCANNED_DIRECTORIES set to [] left it passing, and
  // so did an extension filter that matched nothing.
  assert.ok(files.length >= SCANNED_FILE_FLOOR,
    `scanned ${files.length} files under ${SCANNED_DIRECTORIES.join(', ')}, expected at least `
    + `${SCANNED_FILE_FLOOR}. Zero files read is zero offenders and a green run, so this test `
    + 'proved nothing: the directory list or the extension filter has drifted.');

  const bomOffenders = [];
  const controlOffenders = [];
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    const at = buffer.indexOf(BOM);
    // Position 0 is a file that IS BOM-encoded, which is a different question
    // and not what broke here. Anywhere else is a character someone meant to
    // write as an escape.
    if (at > 0) bomOffenders.push(`${path.relative(ROOT, file)}:${at}`);
    // First hit per file only. The offset and the byte are what you need to go
    // fix it, and a file that holds one raw control byte usually holds one.
    for (let i = 0; i < buffer.length; i += 1) {
      if (!isRawControlByte(buffer[i])) continue;
      controlOffenders.push(
        `${path.relative(ROOT, file)}:${i} (0x${buffer[i].toString(16).padStart(2, '0')})`);
      break;
    }
  }

  assert.deepEqual(bomOffenders, [],
    'spell it \\uFEFF; a raw BOM inside a literal cannot be seen in a diff or a review');
  assert.deepEqual(controlOffenders, [],
    'spell it as an escape (\\u0000, \\u001B); a raw control byte is invisible in a diff, and a '
    + 'raw NUL additionally makes rg and grep report the file as binary and drop every content '
    + 'match in it');
});

test('a BOM-prefixed managed policy is still read', (t) => {
  // The behavioural half. It passes with either spelling, which is exactly why
  // it is not on its own enough: it stops the strip being DELETED, and the byte
  // test above stops it being written in a form that can vanish.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-bom-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'remote-settings.json');
  const body = JSON.stringify({ permissions: { deny: ['Bash(rm:*)'], ask: [], allow: [] } }, null, 2);
  fs.writeFileSync(file, Buffer.concat([BOM, Buffer.from(body, 'utf8')]));

  const policy = readPolicy({ policyPath: file });
  assert.equal(policy.present, true, 'a BOM must not read as an unparseable policy');
  assert.equal(policy.unreadable, false);
  assert.deepEqual(policy.raw.deny, ['Bash(rm:*)']);
});
