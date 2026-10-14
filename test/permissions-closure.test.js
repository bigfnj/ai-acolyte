'use strict';

// src/permissions.js may require ONLY ./permission-match, and that file nothing local.
//
// This is the soundness rule of the hook's fixed-point cache, and until 2026-10-14 it was
// only written down (the v1.6.2 audit). src/fixed-point-cache.js keys the "these
// settings.json bytes are already a fixed point of processAllowList" verdict on a stamp
// of exactly the files codeFiles() names, permissions.js and permission-match.js, so an
// in-place checkout of the generalizer self-invalidates the cache. If permissions.js ever
// loaded a third local module, a change to that module would alter what
// processAllowList emits without moving the stamp, and the hook would keep answering
// "nothing to do" for bytes the new code would rewrite: a silent stale hit, on the path
// that runs after every tool call.
//
// So the test asks Node, not the source: a fresh process loads permissions.js and
// reports every file under the checkout that ended up in require.cache. A require
// hidden in a function body is not loaded at require time and so is not caught here;
// the static check below covers that half by refusing any require of a path other
// than ./permission-match anywhere in the text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function loadedBy(moduleRel) {
  const script = [
    "const path = require('path');",
    `require(path.join(${JSON.stringify(ROOT)}, ${JSON.stringify(moduleRel)}));`,
    `const root = ${JSON.stringify(ROOT + path.sep)};`,
    'process.stdout.write(JSON.stringify(Object.keys(require.cache).filter((f) => f.startsWith(root))));',
  ].join('\n');
  const run = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout).map(rel).sort();
}

test('loading src/permissions.js loads exactly the two files the fixed-point cache stamps', () => {
  const loaded = loadedBy('src/permissions.js');
  assert.deepEqual(loaded, ['src/permission-match.js', 'src/permissions.js'],
    'permissions.js may require only ./permission-match; anything else changes processAllowList '
    + 'without changing the fixed-point stamp');

  const { codeFiles } = require('../src/fixed-point-cache');
  assert.deepEqual(codeFiles().map(rel).sort(), loaded,
    'the stamp and the require closure must be the same set of files');

  assert.deepEqual(loadedBy('src/permission-match.js'), ['src/permission-match.js'],
    'and permission-match.js requires nothing local at all');
});

test('neither stamped file requires a local module anywhere in its text, not only at load time', () => {
  const requires = (file) => [...fs.readFileSync(path.join(ROOT, file), 'utf8')
    .matchAll(/\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map((match) => match[2]);
  const local = (spec) => spec.startsWith('.') || path.isAbsolute(spec);
  assert.deepEqual(requires('src/permissions.js').filter(local), ['./permission-match']);
  assert.deepEqual(requires('src/permission-match.js').filter(local), []);
  // WITNESS: the scan does read requires, so an empty answer above means something.
  assert.ok(requires('src/permissions.js').includes('fs'), 'the scan found none of the builtins either');
});
