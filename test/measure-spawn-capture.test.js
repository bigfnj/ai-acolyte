'use strict';
// scripts/measure/spawn-capture.js is the NODE_OPTIONS preload behind the spawn-timing figures
// in docs/engineering-record.md ("Spawn timing under load"), and spawn-capture-summary.js the
// script that turned its files into them. Committed 2026-10-20 so those figures have an
// artefact. This runs one node process that spawns one node child, with the preload loaded the
// way it was used (through NODE_OPTIONS, so the child loads it too) and no load of any kind,
// then checks the records it wrote and what the summary makes of them. On Windows it also runs
// scripts/measure/taskkill-tree-order.js for one round, and once with a leaf that never starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(ROOT, 'scripts', 'measure', 'spawn-capture.js');
const SUMMARY = path.join(ROOT, 'scripts', 'measure', 'spawn-capture-summary.js');
const PARENT = "const c = require('child_process').spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }); c.on('close', () => {});";

function capture(t, extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-spawn-capture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  // cwd is the capture directory too, so a preload that wrote with an empty CAPTURE_DIR (a
  // relative path) would leave its file where the second test looks.
  const run = spawnSync(process.execPath, ['-e', PARENT], {
    cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: `--require "${PRELOAD.split(path.sep).join('/')}"`, ...extraEnv(dir) },
  });
  assert.equal(run.status, 0, run.stderr);
  return { dir, run };
}

const records = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('the preload writes well-formed records for one spawn, in the parent and in the child', (t) => {
  const { dir, run } = capture(t, (d) => ({ CAPTURE_DIR: d }));
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 2, `expected the parent's and the child's file, found ${files.join(', ')}`);
  for (const name of files) assert.match(name, /^p\d+-t0\.jsonl$/);
  const all = files.map((name) => records(path.join(dir, name)));
  for (const lines of all) {
    for (const line of lines) {
      assert.equal(typeof line.at, 'number');
      assert.equal(typeof line.pid, 'number');
      assert.equal(line.tid, 0);
      assert.equal(typeof line.ev, 'string');
    }
  }
  const parent = all.find((lines) => lines.some((line) => line.ev === 'spawned'));
  assert.ok(parent, 'no file holds a spawned record');
  const child = all.find((lines) => lines !== parent);
  const events = parent.map((line) => line.ev);
  assert.deepEqual(events.filter((ev) => ev !== 'child-close' && ev !== 'child-exit'), ['start', 'spawned', 'self-exit']);
  const spawned = parent.find((line) => line.ev === 'spawned');
  assert.equal(spawned.how, 'spawn');
  assert.equal(typeof spawned.child, 'number');
  assert.ok(Number.isInteger(spawned.held) && spawned.held >= 0, `held ${spawned.held}`);
  assert.match(spawned.file, /node(\.exe)?$/i);
  assert.deepEqual(spawned.args, ['-e', '0']);
  const exit = parent.find((line) => line.ev === 'child-exit');
  const close = parent.find((line) => line.ev === 'child-close');
  assert.deepEqual([exit.child, exit.code, close.child], [spawned.child, 0, spawned.child]);
  assert.ok(spawned.at <= exit.at && exit.at <= close.at, 'spawned, exit and close are out of order');
  assert.equal(child[0].ev, 'start');
  assert.equal(child[0].pid, spawned.child, "the child's file is not the spawned child's");
  assert.equal(child[0].ppid, parent[0].pid);
  assert.equal(typeof child[0].origin, 'number');
  assert.equal(run.stdout, '', 'the preload printed something');
});

test('without CAPTURE_DIR the preload writes nothing', (t) => {
  const { dir } = capture(t, () => ({ CAPTURE_DIR: '' }));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the summary counts that one spawn and its child start', (t) => {
  const { dir } = capture(t, (d) => ({ CAPTURE_DIR: d }));
  const summary = spawnSync(process.execPath, [SUMMARY, dir], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /^spawn\(\) held, node child: n=1 min=\d+ p50=\d+ p90=\d+ max=\d+$/m);
  assert.match(summary.stdout, /^spawn\(\) held, cmd\.exe: n=0 /m);
  assert.match(summary.stdout, /^node child JS running after spawn\(\) returned: n=1 min=\d+ /m);
});

// scripts/measure/taskkill-tree-order.js, the tree-kill row's artefact (Windows only). Its
// temporary directory goes under TEMP, pointed into a fixture, so what it leaves can be seen.
const TREE_ORDER = path.join(ROOT, 'scripts', 'measure', 'taskkill-tree-order.js');
function treeOrder(t, args, extraEnv = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-tree-order-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(comspec|temp|tmp)$/i.test(key)));
  Object.assign(env, { ComSpec: process.env.ComSpec, TEMP: temp, TMP: temp }, extraEnv);
  const run = spawnSync(process.execPath, [TREE_ORDER, ...args], { encoding: 'utf8', timeout: 25000, windowsHide: true, env });
  return { run, temp };
}
const windowsOnly = { skip: process.platform !== 'win32' && 'taskkill is Windows only' };

test('taskkill-tree-order: one round reports the order taskkill ended the tree, and cleans up', windowsOnly, (t) => {
  const { run, temp } = treeOrder(t, ['1']);
  assert.equal(run.status, 0, run.stderr);
  // At least root, cmd.exe and leaf; console hosts may add more (5 PIDs on the development box).
  const round = run.stdout.match(/^round 1: root saw its child exit first: (?:true|false); taskkill order: (\d+(?: > \d+)+) \(root (\d+)\)$/m);
  assert.ok(round, run.stdout);
  assert.ok(round[1].split(' > ').length >= 3 && round[1].split(' > ').includes(round[2]), `the root is not among the ended PIDs: ${round[0]}`);
  assert.match(run.stdout, /^root observed the child's death before its own in [01] of 1$/m);
  assert.deepEqual(fs.readdirSync(temp), [], 'its temporary directory was left behind');
});

// A leaf that never starts (here, a ComSpec that does not exist) used to be waited for forever,
// and a round that failed left the temporary directory, which was removed only after the last.
// MUTATION: drop the deadline and this times out; take the rmSync out of the finally and the
// directory is left.
test('taskkill-tree-order: a leaf that never writes its pid fails the round in bounded time and still cleans up', windowsOnly, (t) => {
  const { run, temp } = treeOrder(t, ['3'], { ComSpec: path.join(os.tmpdir(), 'acolyte-no-such-cmd.exe'), TREEORDER_LEAF_WAIT_MS: '1500' });
  assert.notEqual(run.signal, 'SIGTERM', 'the script was still waiting when the test gave up');
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /^taskkill-tree-order\.js: round 1: the leaf wrote no pid within 1500 ms$/m);
  assert.deepEqual(fs.readdirSync(temp), [], 'a failed round left its temporary directory');
});
