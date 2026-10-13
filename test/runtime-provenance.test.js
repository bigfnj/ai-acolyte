'use strict';

// THE RUNTIME HARNESS'S PROVENANCE COVERS WHAT ITS SUBJECT MODULES LOAD.
//
// scripts/check-codex-runtime.js hashes the subject modules it runs and fails if one
// changes mid-run. It used to hash six hand-picked files; once src/policy-exporters.js
// began requiring src/auto-learn.js (main 5f9775a), which requires src/tool-learn.js, a
// change in either altered what the exporter emitted without altering the recorded
// provenance. The set is now derived (2026-10-13): the local require() closure of the
// modules main() loads. These tests check the derivation against Node itself rather than
// against a list, so the next require added to any of those modules is covered with no
// edit here, and a scan that stopped seeing one fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PROVENANCE_ROOTS, localRequireClosure } = require('../scripts/check-codex-runtime');

const ROOT = path.resolve(__dirname, '..');
// The six files the harness hashed before the closure, kept only as the witness below.
const SEPTEMBER_LIST = ['src/exec-resolve.js', 'src/policy-exporters.js', 'src/agent-guidance.js',
  'src/agent-gates.js', 'src/history-adapters.js', 'src/codex-paths.js'];

// The oracle: what Node actually loads from this checkout's src/ when it requires one
// module, in a fresh process so nothing this test file loaded can leak in.
function loadedBy(entry) {
  const script = `require(${JSON.stringify(path.join(ROOT, entry))});`
    + `const root = ${JSON.stringify(ROOT + path.sep)};`
    + 'process.stdout.write(JSON.stringify(Object.keys(require.cache).filter((f) => f.startsWith(root))'
    + '.map((f) => f.slice(root.length).split(require("path").sep).join("/")).sort()));';
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, cwd: os.tmpdir() });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the derived closure covers every module each harness root actually loads', () => {
  let checked = 0;
  for (const entry of PROVENANCE_ROOTS) {
    const loaded = loadedBy(entry);
    const closure = localRequireClosure(ROOT, [entry]);
    assert.deepEqual(closure.unresolved, [], `${entry}: every local require literal resolves`);
    const missing = loaded.filter((file) => !closure.files.includes(file));
    assert.deepEqual(missing, [], `${entry} loads modules the provenance would not hash`);
    checked += loaded.length;
  }
  assert.ok(checked > PROVENANCE_ROOTS.length, `WITNESS ${checked} loaded modules compared, so the roots load dependencies`);
});

// The defect, as a regression witness: the hand-picked list was not the set that runs.
test('WITNESS: the old six-file list missed modules the exporter actually loads', () => {
  const exporterLoads = loadedBy('src/policy-exporters.js');
  const missed = exporterLoads.filter((file) => !SEPTEMBER_LIST.includes(file));
  assert.ok(missed.length > 0, 'precondition: the exporter loads something outside the old list');
  const closure = localRequireClosure(ROOT, PROVENANCE_ROOTS).files;
  for (const file of missed) assert.ok(closure.includes(file), `${file} is now hashed`);
});

test('the closure is transitive, follows both quote styles and ../, and records what it cannot resolve', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-provenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), text);
  };
  write('src/a.js', "const b = require('./b');\n");
  write('src/b.js', 'const c = require("../lib/c");\n');
  write('lib/c.js', "require( './data.json' );\n// require('./gone') was removed\nrequire('./pkg');\n");
  write('lib/data.json', '{}\n');
  write('lib/pkg/index.js', "require('../../../outside-the-subject');\n");
  const result = localRequireClosure(dir, ['src/a.js']);
  assert.deepEqual(result.files, ['lib/c.js', 'lib/data.json', 'lib/pkg/index.js', 'src/a.js', 'src/b.js'],
    'WITNESS two hops deep, double quotes, ../, .json and a directory index are all followed');
  assert.deepEqual(result.unresolved.map((item) => item.request).sort(), ['../../../outside-the-subject', './gone'],
    'a literal that resolves to nothing is recorded, not silently dropped');
  assert.throws(() => localRequireClosure(path.join(dir, 'src'), ['../lib/c.js']), /escapes the subject/,
    'a root outside the subject is refused rather than hashed from somewhere else');
});
