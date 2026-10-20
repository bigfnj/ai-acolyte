'use strict';
// No module may define the same top-level name twice. Both languages allow it and keep the LAST
// definition, so a merge that adds a second `_FENCE_OPEN` (or a second `function render`) to a
// file changes the behaviour of every earlier caller with no error anywhere. It happened on
// 2026-10-20: feat/memory-guard and feat/open-threads each defined `_FENCE_OPEN`/`_FENCE_CLOSE` in
// memory/recall.py with different rules, the merge kept both, and the open-threads pair silently
// replaced the comment-defect pair the MEMORY.md guard's parity rests on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Top-level names a Python module binds at column 0: `def name`, `async def name`, `class Name`
// and `NAME = ...` (module constants and compiled patterns). Indented lines are skipped, so a
// nested helper or a local rebinding is not a module-level definition.
function pythonTopLevel(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)|^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/.exec(line);
    if (m) names.push(m[1] || m[2] || m[3]);
  }
  return names;
}

// Top-level JavaScript function declarations: `function name(` or `async function name(` at
// column 0. `const`/`let` redeclarations are already a SyntaxError, so only functions can shadow.
function jsTopLevelFunctions(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

const duplicates = (names) => [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];

// Names a module deliberately rebinds at top level, each with the reason. Empty today.
const ALLOWED = new Map();

test('memory/recall.py binds no top-level name twice', () => {
  const dups = duplicates(pythonTopLevel(read('memory/recall.py'))).filter((n) => !ALLOWED.has(`recall.py:${n}`));
  assert.deepEqual(dups, [], `memory/recall.py defines these twice; the later one silently wins: ${dups.join(', ')}`);
});

test('no JavaScript module declares the same top-level function twice', () => {
  const files = [
    'bin/wildcard-perms',
    ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'vscode-extension')).filter((f) => f.endsWith('.js')).map((f) => `vscode-extension/${f}`),
  ];
  assert.ok(files.length > 30, `expected the source files, found ${files.length}`);
  const offenders = [];
  for (const rel of files) {
    const dups = duplicates(jsTopLevelFunctions(read(rel))).filter((n) => !ALLOWED.has(`${rel}:${n}`));
    if (dups.length) offenders.push(`${rel}: ${dups.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `duplicate top-level functions (the later declaration wins): ${offenders.join('; ')}`);
});

test('the scanners see what they claim to (controls)', () => {
  assert.deepEqual(pythonTopLevel('X = 1\ndef f():\n    Y = 2\nX = 3\nclass C:\n    pass\nZ: int = 4\nif X == 3:\n    pass\n'),
    ['X', 'f', 'X', 'C', 'Z']);
  assert.deepEqual(duplicates(pythonTopLevel('A = 1\nA = 2\n')), ['A']);
  assert.deepEqual(jsTopLevelFunctions('function a() {}\nasync function b() {}\n  function nested() {}\nfunction a() {}\n'),
    ['a', 'b', 'a']);
  assert.deepEqual(duplicates(jsTopLevelFunctions('function a() {}\nfunction a() {}\n')), ['a']);
});
