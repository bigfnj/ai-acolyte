'use strict';

// NO TEST-ONLY PATH IN THE EXTENSION'S IMPORT OF memoryLint (2026-10-20).
//
// extension.js destructured `memoryStoreDir = () => memoryReport().dir` from ./memoryLint. The
// real module always exports memoryStoreDir (vscode-extension/memoryLint.js module.exports), so
// the default ran only under the test harnesses that stub ./memoryLint with the export list they
// were written against, and production carried a path that only those stubs could reach. Worse, a
// stub missing the name borrowed it: memoryStoreDir() became a memoryReport() call, so a harness
// that counts memoryReport() counted reads the real extension never makes.
//
// Now the import has no defaults, and every stub exports memoryStoreDir itself. This census holds
// both halves: a stub without it would fail where the name is used, often inside a try that
// swallows the TypeError, so it is named here instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SELF = path.basename(__filename);

// The text from `start` (an opening brace) to its matching close, skipping strings and comments.
function balanced(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2) + 1; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      for (i += 1; i < source.length && source[i] !== c; i += 1) if (source[i] === '\\') i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces from offset ${start}`);
}

test('extension.js imports memoryLint with no fallback for any name', () => {
  const source = fs.readFileSync(path.join(ROOT, 'vscode-extension', 'extension.js'), 'utf8');
  const imports = [...source.matchAll(/const (\{[^}]*\}) = require\('\.\/memoryLint'\);/g)];
  assert.equal(imports.length, 1, 'precondition: one destructured import of ./memoryLint');
  const names = imports[0][1].slice(1, -1).split(',').map((name) => name.trim()).filter(Boolean);
  const bound = (entry) => entry.split(/[:=]/)[0].trim();
  assert.ok(names.some((entry) => bound(entry) === 'memoryStoreDir'), `precondition: memoryStoreDir is imported: ${names.join(', ')}`);
  const defaulted = names.filter((name) => name.includes('='));
  assert.deepEqual(defaulted, [], 'a destructured default serves only a stub; the real module exports every name');
  // Read, not required: memoryLint.js requires vscode.
  const lint = fs.readFileSync(path.join(ROOT, 'vscode-extension', 'memoryLint.js'), 'utf8');
  const exportsAt = lint.indexOf('module.exports = {');
  assert.ok(exportsAt > 0, 'precondition: memoryLint.js has one export object');
  const exported = new Set(balanced(lint, exportsAt + 'module.exports = '.length).slice(1, -1)
    .split(/[,\s]+/).map((name) => name.split(':')[0].trim()).filter(Boolean));
  for (const name of names.map(bound)) {
    assert.ok(exported.has(name), `memoryLint.js exports ${name}, so no stub-only fallback is needed for it`);
  }
  // MUTATION: put `memoryStoreDir = () => memoryReport().dir` back and `defaulted` names it.
});

test('every stub of ./memoryLint in test/ and scripts/ exports memoryStoreDir', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'test')).filter((name) => name.endsWith('.js') && name !== SELF).map((name) => path.join('test', name)),
    ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((name) => name.endsWith('.js')).map((name) => path.join('scripts', name)),
  ];
  const stubs = [];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const match of source.matchAll(/request === '\.\/memoryLint'/g)) {
      const at = source.indexOf('return {', match.index);
      assert.ok(at > 0 && at - match.index < 300, `${rel}: a stub follows the ./memoryLint condition at ${match.index}`);
      const line = source.slice(0, match.index).split('\n').length;
      stubs.push({ where: `${rel}:${line}`, body: balanced(source, at + 'return '.length) });
    }
  }
  assert.ok(stubs.length >= 20, `precondition: the census found the suite's stubs (${stubs.length})`);
  const missing = stubs.filter((stub) => !/\bmemoryStoreDir\b/.test(stub.body) && !/\.\.\.real\b/.test(stub.body));
  assert.deepEqual(missing.map((stub) => stub.where), [], 'a ./memoryLint stub without memoryStoreDir');
  // MUTATION: delete the memoryStoreDir line from any one stub and its file:line is named.
});
