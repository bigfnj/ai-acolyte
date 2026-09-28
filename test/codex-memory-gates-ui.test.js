'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { run } = require('../src/auto-learn-worker');
const { createCodexMemoryGatesUi } = require('../vscode-extension/codexMemoryGatesUi');

const native = text => `---\nscope: global\n---\n<!-- gate -->\n${text}\n<!-- /gate -->\n`;
function fixture(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-native-gates-ui-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const codexHome = path.join(home, 'selected'), root = path.join(codexHome, 'memories');
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, 'MEMORY.md'), target = path.join(codexHome, 'AGENTS.md');
  fs.writeFileSync(source, native('Native cobalt witness.'));
  fs.writeFileSync(target, 'Original user instructions.\n');
  const seen = { ops: [], modals: [], messages: [], warnings: [], watchers: [], refresh: 0 };
  const choice = { value: 'Install gates', during: null };
  const vscode = { RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: { createFileSystemWatcher(pattern) {
      const watcher = { pattern, disposed: false, handlers: {}, dispose() { this.disposed = true; } };
      for (const type of ['Create', 'Change', 'Delete']) watcher['onDid' + type] = callback => {
        watcher.handlers[type] = callback; return { dispose() {} };
      };
      seen.watchers.push(watcher); return watcher;
    } },
    window: {
      async showInformationMessage(message, options, ...actions) {
        if (options?.modal) { seen.modals.push({ message, options, actions }); await choice.during?.(); return choice.value; }
        seen.messages.push(message);
      },
      showWarningMessage(message) { seen.warnings.push(message); },
    } };
  const invoke = async (operation, request) => {
    seen.ops.push(operation);
    return run({ operation, options: { home, codexHome }, args: [request] });
  };
  const ui = createCodexMemoryGatesUi(vscode, { codexHome, run: invoke,
    refresh: () => { seen.refresh++; }, debounceMs: 0, ...extra });
  t.after(() => ui.dispose());
  return { home, codexHome, root, source, target, seen, choice, vscode, ui, invoke };
}

test('native gate review shows the entire body and automatic update scope before install or cancel', async t => {
  const f = fixture(t), original = fs.readFileSync(f.target), source = fs.readFileSync(f.source);
  f.choice.value = undefined;
  await f.ui.review();
  assert.deepEqual(fs.readFileSync(f.target), original, 'WITNESS Cancel cannot install instructions');
  assert.equal(f.seen.ops.includes('setCodexNativeGates'), false);
  assert.match(f.seen.modals[0].options.detail, /Native cobalt witness\./);
  assert.match(f.seen.modals[0].options.detail, /automatically update/);
  assert.match(f.seen.modals[0].options.detail, /Start a new Codex session/);
  f.choice.value = 'Install gates';
  await f.ui.review();
  assert.match(fs.readFileSync(f.target, 'utf8'), /Native cobalt witness\./);
  assert.deepEqual(fs.readFileSync(f.source), source);
  assert.equal(f.ui.status().on, true);
  assert.equal(f.ui.status().current, true);
  assert.equal(f.seen.messages.length, 1);
});

test('native gate initial review rejects source edits after the displayed snapshot', async t => {
  const f = fixture(t), original = fs.readFileSync(f.target);
  f.choice.during = () => fs.writeFileSync(f.source, native('Changed after review.'));
  await f.ui.review();
  assert.deepEqual(fs.readFileSync(f.target), original, 'WITNESS stale initial review cannot install unseen content');
  assert.match(f.seen.warnings[0], /stale/);
  assert.equal(f.seen.messages.length, 0);
});

test('native gate removal remains available when source compilation is unreadable and stops later refresh', async t => {
  const f = fixture(t);
  await f.ui.review();
  fs.writeFileSync(f.source, native('Broken source').replace('<!-- /gate -->', ''));
  await f.ui.reconcile();
  assert.match(f.ui.status().error, /retained.*unreadable/);
  assert.match(fs.readFileSync(f.target, 'utf8'), /Native cobalt witness/);
  f.choice.value = 'Remove gates';
  await f.ui.review();
  assert.deepEqual(f.seen.modals.at(-1).actions, ['Remove gates']);
  assert.doesNotMatch(fs.readFileSync(f.target, 'utf8'), /native Codex memory gates/);
  fs.writeFileSync(f.source, native('Later must not reinstall.'));
  await f.ui.reconcile();
  assert.equal(f.ui.status().on, false, 'WITNESS removing the marker ends automatic opt-in');
  assert.doesNotMatch(fs.readFileSync(f.target, 'utf8'), /Later must not reinstall/);
});

test('native gate refresh retains zero-section opt-in and adds later explicitly marked sections', async t => {
  const f = fixture(t);
  await f.ui.review();
  fs.writeFileSync(f.source, '# Ordinary memory without global instructions.\n');
  await f.ui.reconcile();
  assert.equal(f.ui.status().on, true);
  assert.equal(f.ui.status().count, 0);
  assert.equal(f.ui.status().current, true);
  assert.doesNotMatch(fs.readFileSync(f.target, 'utf8'), /Native cobalt witness/);
  fs.writeFileSync(f.source, native('Repopulated gate.'));
  await f.ui.reconcile();
  assert.match(fs.readFileSync(f.target, 'utf8'), /Repopulated gate\./);
  assert.equal(f.ui.status().count, 1);
});

test('native gate watcher refreshes explicit source changes independently of memory lint and ignores staging files', async t => {
  const f = fixture(t);
  await f.ui.review();
  f.ui.activate(); await f.ui.reconcile();
  const watch = f.seen.watchers.find(w => w.pattern.pattern === 'memories{,/**}');
  assert.ok(watch);
  const before = f.seen.ops.length;
  watch.handlers.Change({ fsPath: path.join(f.root, 'raw_memories.md'), scheme: 'file' });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.seen.ops.length, before, 'raw staging changes do not schedule gate refresh');
  fs.writeFileSync(f.source, native('Watcher updated this gate.'));
  watch.handlers.Change({ fsPath: f.source, scheme: 'file' });
  for (let i = 0; i < 100 && !fs.readFileSync(f.target, 'utf8').includes('Watcher updated'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(fs.readFileSync(f.target, 'utf8'), /Watcher updated this gate/, 'WITNESS native source watcher performs the installed update');
});

test('native gate periodic reconciliation catches a missed notification and reports failed watchers', async t => {
  const f = fixture(t, { reconcileMs: 20 });
  await f.ui.review();
  f.vscode.workspace.createFileSystemWatcher = () => { throw new Error('fixture watcher unavailable'); };
  f.ui.activate(); await f.ui.reconcile();
  assert.match(f.ui.status().watchError, /fixture watcher unavailable/);
  fs.writeFileSync(f.source, native('Periodic update with no notification.'));
  for (let i = 0; i < 100 && !fs.readFileSync(f.target, 'utf8').includes('Periodic update'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(fs.readFileSync(f.target, 'utf8'), /Periodic update with no notification/, 'WITNESS periodic refresh survives watcher failure');
});

test('native gate late confirmation after disposal cannot write or notify', async t => {
  const f = fixture(t), original = fs.readFileSync(f.target);
  f.choice.during = () => f.ui.dispose();
  await f.ui.review();
  assert.deepEqual(fs.readFileSync(f.target), original, 'WITNESS late confirmation cannot install after disposal');
  assert.equal(f.seen.ops.includes('setCodexNativeGates'), false);
  assert.equal(f.seen.messages.length, 0);
});

test('native gate UI does not announce a successful install for a no-op writer', async t => {
  const f = fixture(t);
  const ui = createCodexMemoryGatesUi(f.vscode, { codexHome: f.codexHome,
    run: async (operation, request) => operation === 'setCodexNativeGates'
      ? { changed: true, on: true, count: 1 } : f.invoke(operation, request) });
  t.after(() => ui.dispose());
  await ui.review();
  assert.equal(f.seen.messages.length, 0, 'WITNESS instruction inspection detects a no-op result');
  assert.match(f.seen.warnings[0], /could not be confirmed/);
});

test('native gate retained watcher callbacks cannot recreate resources after disposal', async t => {
  const f = fixture(t);
  f.ui.activate(); await f.ui.reconcile();
  const parent = f.seen.watchers.find(w => w.pattern.pattern === '*');
  const count = f.seen.watchers.length;
  f.ui.dispose();
  parent.handlers.Create({ fsPath: f.codexHome, scheme: 'file' });
  assert.equal(f.seen.watchers.length, count, 'WITNESS late home callback cannot create watchers after teardown');
  assert.ok(f.seen.watchers.every(w => w.disposed));
});

test('native gate cancellation preserves a source refresh requested while its modal was open', async t => {
  const f = fixture(t);
  await f.ui.review();
  f.choice.value = undefined;
  f.choice.during = async () => {
    fs.writeFileSync(f.source, native('Edit made during an installed review.'));
    await f.ui.reconcile();
    assert.doesNotMatch(fs.readFileSync(f.target, 'utf8'), /Edit made during/);
  };
  await f.ui.review();
  for (let i = 0; i < 100 && !fs.readFileSync(f.target, 'utf8').includes('Edit made during'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(fs.readFileSync(f.target, 'utf8'), /Edit made during an installed review/, 'WITNESS Cancel does not drop an opted-in source refresh');
});

test('native gate worker operations use the selected profile without learner state or Claude writes', async t => {
  const f = fixture(t);
  const call = (operation, request) => new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve(__dirname, '../src/auto-learn-worker.js'), { workerData: {
      operation, options: { home: f.home, codexHome: f.codexHome }, args: [request],
    } });
    worker.on('message', response => response.ok ? resolve(response.result) : reject(new Error(response.error.message)));
    worker.on('error', reject);
  });
  const report = await call('codexNativeGates');
  assert.equal(report.target.path, f.target);
  await call('setCodexNativeGates', { enabled: true, fingerprint: report.fingerprint });
  assert.match(fs.readFileSync(f.target, 'utf8'), /Native cobalt witness/);
  fs.writeFileSync(f.source, native('Worker refresh witness.'));
  await call('refreshCodexNativeGates');
  assert.match(fs.readFileSync(f.target, 'utf8'), /Worker refresh witness/);
  assert.equal(fs.existsSync(path.join(f.home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.codex')), false);
});
