'use strict';

// Two files carried the raw UTF-8 BOM bytes EF BB BF inside a regex literal
// where every other site in the repo spells the same character as an escape. It
// worked, which is the problem: an invisible character is load-bearing, and any
// re-encode, normalizer, editor or copy-paste can drop or mangle it with no
// error anywhere. This is a source-ENCODING defect, so the condition it asserts
// is about the bytes on disk; the behavioural half is below it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readPolicy } = require('../src/managed-policy');

const ROOT = path.join(__dirname, '..');
const SCANNED_DIRECTORIES = ['src', 'bin', 'scripts', 'test', 'patterns'];
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

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

test('no tracked source file carries the BOM as raw bytes', () => {
  const offenders = [];
  for (const directory of SCANNED_DIRECTORIES) {
    for (const file of sourceFiles(path.join(ROOT, directory))) {
      const buffer = fs.readFileSync(file);
      const at = buffer.indexOf(BOM);
      // Position 0 is a file that IS BOM-encoded, which is a different question
      // and not what broke here. Anywhere else is a character someone meant to
      // write as an escape.
      if (at > 0) offenders.push(`${path.relative(ROOT, file)}:${at}`);
    }
  }
  assert.deepEqual(offenders, [],
    'spell it \\uFEFF; a raw BOM inside a literal cannot be seen in a diff or a review');
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
