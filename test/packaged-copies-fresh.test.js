'use strict';

// scripts/package.mjs writes two gitignored copies into vscode-extension/: src/ (every repo-root
// src/*.js) and memory/ (recall.py, codex_recall.py and the vocab). The extension's loaders look
// THERE FIRST, because that is the packaged layout: memoryLint.js resolves the guard and
// gates-manage from `<dir>/src` before `<dir>/../src`, extension.js starts the Auto Learn worker
// from `<dir>/src` when it exists, and the recall resolver prefers the bundled recall.py. So a
// checkout that once ran the packager and kept its copies runs this suite against old code.
// Measured 2026-10-20 on both boxes: the release-session box's copy was from 2026-09-29 and failed
// test/extension-codex-archive.test.js 3 of 3 (a clean worktree passed it), and the live-hook box's
// main checkout held a 1.8.1 copy, 44 files, differing from src/. Absent copies are the normal
// state of a clean checkout and CI, and pass; a present copy must equal its source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'vscode-extension');
const text = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// [copy, source] pairs a present copy is held to, and the copy's own names, for the extras.
function expectedPairs() {
  const pairs = [];
  const srcCopy = path.join(EXT, 'src');
  if (fs.existsSync(srcCopy)) {
    const sources = fs.readdirSync(path.join(ROOT, 'src'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js')).map((entry) => entry.name);
    for (const name of sources) pairs.push([path.join(srcCopy, name), path.join(ROOT, 'src', name)]);
    for (const name of fs.readdirSync(srcCopy)) {
      if (!sources.includes(name)) pairs.push([path.join(srcCopy, name), null]);
    }
  }
  const memoryCopy = path.join(EXT, 'memory');
  if (fs.existsSync(memoryCopy)) {
    for (const rel of ['recall.py', 'codex_recall.py', path.join('models', 'bge-small.vocab.txt')]) {
      pairs.push([path.join(memoryCopy, rel), path.join(ROOT, 'memory', rel)]);
    }
  }
  return pairs;
}

// MUTATION: write a line into vscode-extension/src/permissions.js (after a package run), or leave
// an extra file there, and this fails naming it; delete both copies and it passes.
test('a packaged copy left in vscode-extension/ is the same as its source, or the suite tests old code', () => {
  const stale = [];
  for (const [copy, source] of expectedPairs()) {
    const rel = path.relative(ROOT, copy).replace(/\\/g, '/');
    if (source === null) stale.push(`${rel} (no source in src/)`);
    else if (!fs.existsSync(copy)) stale.push(`${rel} (missing)`);
    else if (text(copy) !== text(source)) stale.push(`${rel} (differs)`);
  }
  assert.deepEqual(stale, [], `${stale.length} stale file(s) in a copy scripts/package.mjs wrote: `
    + `${stale.slice(0, 8).join(', ')}${stale.length > 8 ? ', ...' : ''}. The extension loads these `
    + 'before the repo\'s own files. Delete vscode-extension/src and vscode-extension/memory, or run '
    + '`npm run package` to refresh them.');
});
