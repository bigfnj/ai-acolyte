'use strict';

// THE EXTENSION RE-READS CLAUDE CODE'S STRIP MODEL ONCE PER BINARY (2026-10-15).
//
// CLAUDE_SAFE_ENV_VARS (src/permission-match.js) was read out of Claude Code 2.1.296, and nothing
// noticed when an update changed it. The extension now runs src/claude-strip-model.js about 30 s
// after activation (vscode-extension/extension.js scheduleStripModelCheck): one stat on a normal
// start, a worker-thread scan when the binary's path, size or mtime changed, one warning per
// binary on drift, and silence otherwise. These drive the real extension over a temporary home
// holding a synthetic Claude Code install (the bytes test/check-claude-strip-model.test.js uses),
// with the 30 s timer captured rather than armed and fired by hand, and a globalState that
// outlives each session the way VS Code's does. The reader itself is tested in
// test/check-claude-strip-model.test.js.
//
// Harness copied, not shared, per the suite's standing decision
// (test/extension-activation.test.js:505#sharing).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { CLAUDE_SAFE_ENV_VARS } = require('../src/permission-match');

const KNOWN = [...CLAUDE_SAFE_ENV_VARS];
const DELAY_MS = 30000;
const OPTIONS = { timeout: 60000 };
// The list the way the 2.1.296 bundle holds it, and the two lookup shapes that follow it.
const literal = (names) => `;IG=new Set([${names.map((name) => `"${name}"`).join(',')}]);`;
const EXACT = 'function u(e){return IG.has(e)}';
const FOLDED = 'function u(e){return IG.has(e.toUpperCase())}';
const DECOY = 'var c=["NO_COLOR","FORCE_COLOR","TERM","COLORTERM","CLICOLOR","CLICOLOR_FORCE"];';

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-strip-check-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }));
  return home;
}

// A Claude Code VS Code extension at `version` in `home`, whose CLI holds `parts` among filler.
function install(home, version, ...parts) {
  const dir = path.join(home, '.vscode', 'extensions', `anthropic.claude-code-${version}-win32-x64`, 'resources', 'native-binary');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude.exe');
  fs.writeFileSync(file, Buffer.concat([crypto.randomBytes(3000), ...parts.map((part) => Buffer.from(part, 'latin1')),
    crypto.randomBytes(3000)]));
  return file;
}

// VS Code's globalState: it outlives a session, and hands out copies.
function memento() {
  const map = new Map();
  return {
    map,
    get: (key, fallback) => (map.has(key) ? structuredClone(map.get(key)) : fallback),
    update: async (key, value) => { map.set(key, structuredClone(value)); },
    keys: () => [...map.keys()],
  };
}

// One VS Code session over `home`. `setting` is claudeStripModelCheck's tiers; `choose` is the
// button a warning is answered with.
function session(t, home, globalState, { setting, choose } = {}) {
  const record = { lines: [], warnings: [], informations: [], errors: [], shown: 0, workers: [], hostChecks: [], logged: [] };
  const timers = [];
  const cleared = new Set();
  const disposable = () => ({ dispose() {} });
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 }, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ThemeColor: class ThemeColor {}, Uri: { file: (p) => ({ fsPath: p }) },
    Range: class Range {}, Diagnostic: class Diagnostic {},
    languages: { createDiagnosticCollection() { return { set() {}, delete() {}, clear() {}, dispose() {} }; } },
    commands: { registerCommand() { return disposable(); }, executeCommand() {} },
    window: {
      onDidChangeActiveTextEditor() { return disposable(); },
      createOutputChannel() {
        return { appendLine(line) { record.lines.push(line); }, append() {}, show() { record.shown += 1; }, clear() {}, dispose() {} };
      },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      registerWebviewViewProvider() { return disposable(); },
      withProgress(options, task) { return task({ report() {} }); },
      setStatusBarMessage() {},
      showErrorMessage(message) { record.errors.push(message); return Promise.resolve(undefined); },
      showWarningMessage(message, ...items) { record.warnings.push({ message, items }); return Promise.resolve(choose); },
      showInformationMessage(message) { record.informations.push(message); return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { fsPath: path.join(home, 'repo') } }],
      createFileSystemWatcher() {
        return { onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} };
      },
      getConfiguration() {
        return {
          // VS Code's merge: folder over workspace over user. The value a machine-scoped read refuses.
          get: (key, fallback) => {
            if (key === 'claudeStripModelCheck' && setting) {
              return setting.workspaceFolderValue ?? setting.workspaceValue ?? setting.globalValue ?? fallback;
            }
            return key === 'autoLearn.enabled' ? false : fallback;
          },
          inspect: (key) => (key === 'claudeStripModelCheck' && setting) || {},
          update: async () => {},
        };
      },
      onDidChangeConfiguration() { return disposable(); }, onDidChangeWorkspaceFolders() { return disposable(); },
      onDidSaveTextDocument() { return disposable(); }, onDidOpenTextDocument() { return disposable(); },
    },
  };

  const extensionPath = require.resolve('../vscode-extension/extension');
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const modelPath = path.join(rootSrc, 'claude-strip-model.js');
  const originalLoad = Module._load;
  const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') });
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => home };
    if (parent?.filename === extensionPath && request === './src/claude-strip-model') {
      // A check() the extension makes on the HOST thread lands here. The worker loads its own copy.
      const real = originalLoad.call(this, modelPath, parent, isMain);
      return { ...real, check: (...args) => { record.hostChecks.push(args[0]); return real.check(...args); } };
    }
    if (parent?.filename === modelPath && (request === 'node:worker_threads' || request === 'worker_threads')) {
      const real = originalLoad.call(this, request, parent, isMain);
      class RecordingWorker extends real.Worker {
        constructor(file, options) { super(file, options); record.workers.push({ file, workerData: options?.workerData }); }
      }
      return { ...real, Worker: RecordingWorker };
    }
    if (parent?.filename === extensionPath && request === './autoLearnWorkerRunner') {
      return { createAutoLearnWorkerRunner: () => ({ async run() { return {}; }, async deactivate() {} }) };
    }
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class MemoryLint { activate() {} onReconcile() { return disposable(); } },
        memoryReport: () => ({ conf: {}, dir: null, report: null }),
        memoryStoreDir: () => null,
        cfg: () => ({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 }),
        discoverDirs: () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  // The deferred check is captured, not armed: a timer of DELAY_MS set while activate() runs.
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let capturing = false;
  global.setTimeout = function setTimeout(fn, ms, ...rest) {
    if (capturing && ms === DELAY_MS) {
      const handle = { fn, unrefed: false, unref() { this.unrefed = true; return this; }, ref() { return this; } };
      timers.push(handle);
      return handle;
    }
    return realSetTimeout(fn, ms, ...rest);
  };
  global.clearTimeout = function clearTimeout(handle) {
    if (timers.includes(handle)) { cleared.add(handle); return undefined; }
    return realClearTimeout(handle);
  };
  const purge = () => {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(rootSrc + path.sep) || key.startsWith(path.dirname(extensionPath) + path.sep)) delete require.cache[key];
    }
  };
  purge();
  const extension = require(extensionPath);
  let down = false;
  let closed = false;
  const deactivate = async () => { if (!down) { down = true; await extension.deactivate(); } };
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await deactivate(); } finally {
      Module._load = originalLoad;
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      purge();
    }
  };
  t.after(close);
  capturing = true;
  try { extension.activate({ subscriptions: [], globalState }); } finally { capturing = false; }
  assert.equal(timers.length, 1, `precondition: activation deferred exactly one ${DELAY_MS} ms check, not ${timers.length}`);
  const [timer] = timers;

  // Fire the deferred check and return what it did: everything recorded while it ran.
  const fire = async () => {
    const marks = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, Array.isArray(value) ? value.length : value]));
    const { error } = console;
    console.error = (...args) => { record.logged.push(args.join(' ')); };
    try {
      await timer.fn();
      // The "Show details" continuation.
      await new Promise((resolve) => setImmediate(resolve));
    } finally { console.error = error; }
    return Object.fromEntries(Object.entries(record).map(([key, value]) =>
      [key, Array.isArray(value) ? value.slice(marks[key]) : value - marks[key]]));
  };
  return { timer, cleared, fire, deactivate, close, record };
}

const stored = (state) => [...state.map.values()];
const quiet = (out) => ({ lines: out.lines, warnings: out.warnings.length, informations: out.informations.length, errors: out.errors.length, logged: out.logged });

test('the manifest declares claudeStripModelCheck: a boolean, on by default, machine-scoped', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'package.json'), 'utf8'));
  const setting = manifest.contributes?.configuration?.properties?.['permissionWildcarding.claudeStripModelCheck'];
  assert.ok(setting, 'precondition: the setting is declared');
  assert.deepEqual([setting.type, setting.default, setting.scope], ['boolean', true, 'machine']);
});

test('a new binary is scanned on a worker thread, never on the host thread, and its key is stored', OPTIONS, async (t) => {
  const home = tempHome(t);
  const file = install(home, '2.1.300', literal(KNOWN), EXACT);
  const state = memento();
  const window = session(t, home, state);
  // MUTATION: in checkClaudeStripModel, replace checkStripModelOffThread(located.path) with
  // { promise: Promise.resolve(require('./src/claude-strip-model').check(located.path)), terminate() {} }.
  // The scan runs on the host thread: no worker, one host check, and this fails. Confirmed 2026-10-15.
  const out = await window.fire();
  assert.equal(out.workers.length, 1, 'the scan did not run on a worker thread');
  assert.equal(out.hostChecks.length, 0, 'check() ran on the extension host thread');
  assert.match(JSON.stringify(out.workers[0].workerData), /claude\.exe/);
  const [summary, ...rest] = stored(state);
  assert.equal(rest.length, 0, 'one entry, not one per check');
  assert.deepEqual([summary.status, summary.version, summary.count], ['same', '2.1.300', KNOWN.length]);
  assert.ok(summary.key.startsWith(file), `the key is built from the binary's path: ${summary.key}`);
});

test('an unchanged key runs no check on the next start; a changed binary does', OPTIONS, async (t) => {
  const home = tempHome(t);
  const file = install(home, '2.1.300', literal(KNOWN), EXACT);
  const state = memento();
  const first = session(t, home, state);
  assert.equal((await first.fire()).workers.length, 1, 'precondition: the first start scans');
  await first.close();

  // MUTATION: drop the `state.get(STRIP_MODEL_STATE)?.key === key` early return. The second start
  // scans again and this fails. Confirmed 2026-10-15.
  const second = session(t, home, state);
  const unchanged = await second.fire();
  assert.equal(unchanged.workers.length, 0, 'an unchanged binary was scanned again');
  assert.deepEqual(quiet(unchanged), { lines: [], warnings: 0, informations: 0, errors: 0, logged: [] });
  await second.close();

  // The same path, rewritten (an in-place update): a new size and mtime, so a new key.
  fs.appendFileSync(file, crypto.randomBytes(512));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const third = session(t, home, state);
  assert.equal((await third.fire()).workers.length, 1, 'a changed binary was not scanned');
});

test('the same list is at most one output line, and never a notification', OPTIONS, async (t) => {
  const home = tempHome(t);
  install(home, '2.1.300', literal(KNOWN), EXACT);
  const window = session(t, home, memento());
  // MUTATION: make reportStripModel treat every list as changed (`const changed = true`). A
  // warning is shown for the same list and this fails. Confirmed 2026-10-15.
  const out = await window.fire();
  assert.deepEqual(quiet(out), {
    lines: [`Claude Code 2.1.300: strip model unchanged (${KNOWN.length} names, case-exact)`],
    warnings: 0, informations: 0, errors: 0, logged: [],
  });
});

test('a changed list warns once per binary, naming the version and the names; Show details opens the log', OPTIONS, async (t) => {
  const home = tempHome(t);
  install(home, '2.1.301', literal([...KNOWN.filter((name) => name !== 'TZ'), 'NEW_SAFE_VAR']), EXACT);
  const state = memento();
  const window = session(t, home, state, { choose: 'Show details' });
  // MUTATION: make reportStripModel treat a changed list as unchanged (`const changed = false`). No
  // warning is shown and this fails. Confirmed 2026-10-15.
  const out = await window.fire();
  assert.equal(out.warnings.length, 1, `one warning, not ${out.warnings.length}`);
  const [{ message, items }] = out.warnings;
  for (const part of ['Claude Code 2.1.301', '+NEW_SAFE_VAR', '−TZ', 'models 2.1.296', 'Update AI Acolyte']) {
    assert.ok(message.includes(part), `the warning does not say ${part}: ${message}`);
  }
  assert.deepEqual(items, ['Show details']);
  assert.equal(out.shown, 1, 'Show details did not open the output channel');
  const log = out.lines.join('\n');
  for (const part of ['2.1.301', 'NEW_SAFE_VAR', 'TZ']) assert.ok(log.includes(part), `the log does not name ${part}:\n${log}`);
  assert.equal(stored(state)[0].status, 'drift');
  await window.close();

  const next = session(t, home, state, { choose: 'Show details' });
  assert.equal((await next.fire()).warnings.length, 0, 'the same binary warned twice');
});

test('a lookup that now converts case warns too, even with the same names', OPTIONS, async (t) => {
  const home = tempHome(t);
  install(home, '2.1.302', literal(KNOWN), FOLDED);
  const window = session(t, home, memento());
  // MUTATION: drop `folded` from reportStripModel's warn condition. The folded lookup reads as
  // unchanged and this fails. Confirmed 2026-10-15.
  const out = await window.fire();
  assert.equal(out.warnings.length, 1, 'a case-converting lookup was not reported');
  assert.match(out.warnings[0].message, /Claude Code 2\.1\.302 now converts case/);
  assert.ok(out.lines.some((line) => /converts case/.test(line)), out.lines.join('\n'));
});

test('no Claude Code installed is silent, and stores nothing', OPTIONS, async (t) => {
  const home = tempHome(t);
  // A version directory with no binary in it is no install either.
  fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.300-win32-x64'), { recursive: true });
  const state = memento();
  const window = session(t, home, state);
  // MUTATION: make the not-found branch report (`if (!located) { sharedChannel()?.appendLine(...);
  // return; }`). The line is recorded and this fails. Confirmed 2026-10-15. Dropping the branch
  // outright is equivalent, not a regression: the stat's catch below it returns silently.
  const out = await window.fire();
  assert.equal(out.workers.length, 0);
  assert.deepEqual(quiet(out), { lines: [], warnings: 0, informations: 0, errors: 0, logged: [] });
  assert.deepEqual(stored(state), []);
});

test('a list the scan cannot locate logs one line, is stored, and is not re-scanned on the next start', OPTIONS, async (t) => {
  const home = tempHome(t);
  install(home, '2.1.303', DECOY);
  const state = memento();
  const first = session(t, home, state);
  const out = await first.fire();
  assert.equal(out.workers.length, 1, 'precondition: the binary was scanned');
  assert.equal(out.lines.length, 1, `one line, not ${out.lines.length}`);
  assert.match(out.lines[0], /Claude Code 2\.1\.303: strip model not checked, .*could not be located/);
  assert.deepEqual([out.warnings.length, out.informations.length, out.errors.length], [0, 0, 0]);
  assert.equal(stored(state)[0].status, 'undecided');
  await first.close();

  // MUTATION: store the key only when the status is 'same' or 'drift'. The second start scans the
  // same binary again and this fails. Confirmed 2026-10-15.
  const second = session(t, home, state);
  const again = await second.fire();
  assert.equal(again.workers.length, 0, 'a binary that failed to parse was scanned again');
  assert.deepEqual(again.lines, []);
});

test('deactivate clears the timer, which is unref\'d, and a timer that fires after it does nothing', OPTIONS, async (t) => {
  const home = tempHome(t);
  install(home, '2.1.300', literal(KNOWN), EXACT);
  const state = memento();
  const window = session(t, home, state);
  assert.equal(window.timer.unrefed, true, 'the deferred check holds the extension host open');
  await window.deactivate();
  // MUTATION: drop clearTimeout(stripModelTimer) from deactivate. This fails. Confirmed 2026-10-15.
  assert.ok(window.cleared.has(window.timer), 'deactivate left the deferred check armed');
  const out = await window.fire();
  assert.equal(out.workers.length, 0, 'a check ran against a torn-down extension');
  assert.deepEqual(stored(state), []);
});

test('claudeStripModelCheck false in user settings disables it; a workspace value cannot', OPTIONS, async (t) => {
  const home = tempHome(t);
  install(home, '2.1.300', literal(KNOWN), EXACT);
  const off = memento();
  // MUTATION: drop the userSetting('claudeStripModelCheck', true) test. The scan runs and this
  // fails. Confirmed 2026-10-15.
  const userOff = session(t, home, off, { setting: { globalValue: false } });
  const out = await userOff.fire();
  assert.equal(out.workers.length, 0, 'the user turned it off and it still scanned');
  assert.deepEqual(stored(off), []);
  await userOff.close();

  // MUTATION: read it with getConfiguration().get() instead of userSetting. The workspace value
  // wins and this fails. Confirmed 2026-10-15.
  const on = memento();
  const workspaceOff = session(t, home, on, { setting: { workspaceValue: false } });
  assert.equal((await workspaceOff.fire()).workers.length, 1, 'a workspace value switched off a machine-scoped check');
});
