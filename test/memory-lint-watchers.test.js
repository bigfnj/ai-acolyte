'use strict';

// The memory store moves whenever the working root is renamed, because Claude Code
// derives the project slug from the working directory. A watcher can only report on a
// directory that existed when it was created, so a move kills every watcher at once and
// leaves nothing able to say so. These tests pin the two halves of the answer: the
// watcher set is rebuilt from discovery, and a periodic reconcile exists as the backstop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function disposable() { return { dispose() {} }; }

function harness(tempHome, overrides = {}) {
  const created = [];
  const statusText = [];
  // Command ids are recorded, not discarded: whether a command is registered
  // at all is the difference between a working palette entry and "command
  // not found", and it depends on config.
  const registered = [];
  const info = [];
  // Separate from `info`, because the two answer different questions. An information
  // message is "the feature is off"; an error is "the file you asked about is there and
  // could not be read", and showReport used to answer the second by throwing.
  const errors = [];
  const vscode = {
    RelativePattern: class RelativePattern {
      constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    Uri: { file: (fsPath) => ({ fsPath }) },
    Range: class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
    Diagnostic: class Diagnostic { constructor(range, message) { Object.assign(this, { range, message }); } },
    DiagnosticSeverity: { Warning: 1, Information: 2 },
    commands: {
      // Throws on a duplicate id, because the real API does. The empty stub that
      // was here let a double registration pass unnoticed while it broke
      // activate() on the default configuration.
      registerCommand: (id) => {
        if (registered.includes(id)) throw new Error(`command '${id}' already exists`);
        registered.push(id);
        return disposable();
      },
    },
    languages: { createDiagnosticCollection: () => ({ set() {}, clear() {}, dispose() {} }) },
    window: {
      createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({
        show() {}, hide() {}, dispose() {},
        set text(value) { statusText.push(value); },
        get text() { return statusText[statusText.length - 1]; },
      }),
      onDidChangeActiveTextEditor: () => disposable(),
      // Recorded, not stubbed empty: with the lint disabled the report has
      // nowhere to write, so what it TELLS the user is the whole behaviour.
      showInformationMessage: (message) => { info.push(message); return Promise.resolve(); },
      showErrorMessage: (message) => { errors.push(message); return Promise.resolve(); },
    },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => (Object.prototype.hasOwnProperty.call(overrides, key)
          ? overrides[key] : fallback),
      }),
      createFileSystemWatcher(pattern) {
        const watcher = {
          pattern, disposed: false,
          onDidChange() {}, onDidCreate() {}, onDidDelete() {},
          dispose() { this.disposed = true; },
        };
        created.push(watcher);
        return watcher;
      },
      onDidSaveTextDocument: () => disposable(),
      onDidOpenTextDocument: () => disposable(),
    },
  };
  const modulePath = require.resolve('../vscode-extension/memoryLint');
  const originalLoad = Module._load;
  const intervals = [];
  const originalSetInterval = global.setInterval;
  // Every fs call memoryLint.js itself makes, by name and by argument. Counted rather
  // than timed, because these are the deterministic half of the duplicate-work
  // properties: "MEMORY.md is read once per refresh" and "the primary dir is listed once
  // per report" are syscall facts, and a timing claim on a sub-millisecond difference is
  // unmeasurable noise. Only memoryLint's own `fs` is wrapped — the tests' own fixture
  // writes go to the real module and are not counted.
  const calls = { readFileSync: [], existsSync: [], readdirSync: [], statSync: [] };
  const countingFs = { ...fs };
  for (const name of Object.keys(calls)) {
    countingFs[name] = (target, ...rest) => {
      calls[name].push(String(target));
      return fs[name](target, ...rest);
    };
  }
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => tempHome };
    if (request === 'fs' && parent?.filename === modulePath) return countingFs;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; };
  delete require.cache[modulePath];
  const loaded = require(modulePath);
  const restore = () => {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    delete require.cache[modulePath];
  };
  // How many of `kind` touched a path ending in `suffix`. Suffix, not equality, so a
  // caller names 'MEMORY.md' rather than rebuilding the join.
  const countsFor = (kind, suffix) => calls[kind].filter((p) => p.endsWith(suffix)).length;
  const resetCalls = () => { for (const k of Object.keys(calls)) calls[k].length = 0; };
  return {
    loaded, created, statusText, intervals, registered, info, errors, restore,
    calls, countsFor, resetCalls,
  };
}

function writeStore(dir, indexBody) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), indexBody, 'utf8');
}

test('the watcher set follows the store when it moves to a new project slug', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-move-'));
  const oldDir = path.join(tempHome, '.claude', 'projects', 'd---old', 'memory');
  const newDir = path.join(tempHome, '.claude', 'projects', 'd---new', 'memory');
  writeStore(oldDir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(oldDir, 'one.md'), 'body\n', 'utf8');

  const h = harness(tempHome);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });

    assert.equal(lint.watchers.size, 1, 'one watcher for the store that exists');
    assert.equal(lint.watchers.has(oldDir), true);
    const first = h.created[0];

    // The move: the whole store relocates to a different slug, exactly as a renamed
    // working root does. Nothing about the old directory survives.
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    fs.rmSync(path.join(tempHome, '.claude', 'projects', 'd---old'), { recursive: true, force: true });

    lint.refresh();

    assert.equal(lint.watchers.has(oldDir), false, 'the dead watcher is dropped');
    assert.equal(first.disposed, true, 'and actually disposed, not just forgotten');
    assert.equal(lint.watchers.has(newDir), true, 'a watcher is created for the new store');
    assert.equal(lint.watchers.size, 1);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The status bar is the surface that is always on screen; the card needs the sidebar
// open. Claude Code drops everything past line 200 of MEMORY.md without reporting it, so
// this gauge is the only thing on the machine that can say it happened.
test('the status bar names the line cap only once the index is past it', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-lines-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---work', 'memory');
  // maxLines is overridden to 10 so the fixture stays readable. 12 short lines: past the
  // cap, and nowhere near the byte budget, which is the case bytes alone cannot see.
  writeStore(dir, 'x\n'.repeat(12));

  const h = harness(tempHome, { 'memory.maxLines': 10 });
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    lint.refresh();

    const text = h.statusText[h.statusText.length - 1];
    assert.match(text, /12\/10 lines/, 'the gauge must say how far past the cap it is');
    assert.equal(lint.status.backgroundColor?.id, 'statusBarItem.warningBackground',
      'two lines are being dropped from every session, so the gauge cannot stay neutral');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('an index inside the line cap says nothing about lines at all', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-lines-ok-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---work', 'memory');
  writeStore(dir, 'x\n'.repeat(8));

  const h = harness(tempHome, { 'memory.maxLines': 10 });
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    lint.refresh();

    const text = h.statusText[h.statusText.length - 1];
    assert.ok(!/lines/.test(text),
      'a healthy index must not spend status-bar width on a number that is fine: ' + text);
    assert.equal(lint.status.backgroundColor, undefined);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// memoryLint.js pickPrimaryDir and recall.py:154 _discover_memory_dir answer the same
// question, and extension.js pins memoryLint's answer into RECALL_MEMORY_DIR at three spawn
// sites -- so a disagreement was resolved in favour of the copy that is NOT the authority.
// Until these two tests existed, every test that reached pickPrimaryDir had at most one
// discoverable store, so the `dirs.length === 1` short-circuit fired first and the rule
// below it was never executed. It could have been anything.
function twoStores(tempHome, bigExtra, smallExtra) {
  const big = path.join(tempHome, '.claude', 'projects', 'd---ai-work', 'memory');
  const small = path.join(tempHome, '.claude', 'projects', 'c--other', 'memory');
  writeStore(big, '# Memory Index\n\n- [a](a.md) — hook\n');
  for (const n of bigExtra) fs.writeFileSync(path.join(big, n), 'body\n', 'utf8');
  writeStore(small, '# Memory Index\n\n- [z](z.md) — hook\n');
  for (const n of smallExtra) fs.writeFileSync(path.join(small, n), 'body\n', 'utf8');
  // The divergence in one line: the SMALL store is the most recently touched, which is
  // exactly what saving one memory from a session launched elsewhere produces.
  const now = Date.now();
  fs.utimesSync(path.join(big, 'MEMORY.md'), new Date(now - 60000), new Date(now - 60000));
  fs.utimesSync(path.join(small, 'MEMORY.md'), new Date(now), new Date(now));
  return { big, small };
}

test('the primary store is the one with the most memories, not the most recently touched', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-primary-'));
  const { big, small } = twoStores(tempHome, ['a.md', 'b.md', 'c.md'], ['z.md']);
  const h = harness(tempHome);
  try {
    assert.equal(h.loaded.discoverDirs(h.loaded.cfg()).length, 2, 'precondition: two stores');
    assert.equal(h.loaded.pickPrimaryDir([small, big]), big);
    assert.equal(h.loaded.pickPrimaryDir([big, small]), big, 'and not merely input order');
    // The product claim: this is the value extension.js pins as RECALL_MEMORY_DIR, and the
    // dir compileGates() installs standing orders from.
    assert.equal(h.loaded.memoryReport().dir, big);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('two stores of equal size fall back to the most recently touched', () => {
  // mtime is the tie-break, not dead weight. A rule nothing can falsify must not ship, so
  // the tie-break gets a case that reaches it.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-tie-'));
  const { big, small } = twoStores(tempHome, ['a.md'], ['z.md']);
  const h = harness(tempHome);
  try {
    assert.equal(h.loaded.pickPrimaryDir([big, small]), small,
      'equal .md counts, so the newer MEMORY.md wins');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('an explicit memory.dir is the only store discovered', () => {
  // Nothing covered memory.dir at all. It matters now because the two watcher sites in
  // extension.js used to pass a hand-built conf with `dir: ''`, so a pinned dir was ignored
  // and both stores got watched anyway.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-pinned-'));
  const { small } = twoStores(tempHome, ['a.md', 'b.md', 'c.md'], ['z.md']);
  const h = harness(tempHome, { 'memory.dir': small });
  try {
    assert.deepEqual(h.loaded.discoverDirs(h.loaded.cfg()), [small],
      'auto-discovery must not run alongside an explicit dir');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('a periodic reconcile is registered, so a move with no live watcher still repaints', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-reconcile-'));
  const oldDir = path.join(tempHome, '.claude', 'projects', 'd---old', 'memory');
  const newDir = path.join(tempHome, '.claude', 'projects', 'd---new', 'memory');
  // 2 lines over a 40-char budget in the old store, none in the new one, so the gauge
  // text alone proves which store the reading came from.
  writeStore(oldDir, '# Memory Index\n\n- [x](x.md) — ' + 'y'.repeat(80) + '\n');

  const h = harness(tempHome);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    const before = lint.status.text;
    assert.match(before, /mem: \d+/);

    assert.equal(h.intervals.length, 1, 'exactly one reconcile timer');
    assert.equal(h.intervals[0].ms, 5 * 60 * 1000);

    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    fs.rmSync(path.join(tempHome, '.claude', 'projects', 'd---old'), { recursive: true, force: true });
    fs.writeFileSync(path.join(newDir, 'MEMORY.md'), '# Memory Index\n\n- [x](x.md) — short\n', 'utf8');

    // No watcher can fire here — the directory it watched is gone. The timer is the
    // only thing left that can notice, which is the whole point of it existing.
    h.intervals[0].fn();

    assert.equal(lint.watchers.has(newDir), true);
    assert.notEqual(lint.status.text, before, 'the gauge repainted instead of freezing');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('disabling the lint releases every watcher it was holding', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-disable-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---only', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');

  const h = harness(tempHome);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    assert.equal(lint.watchers.size, 1);
    lint.disposeWatchers();
    assert.equal(lint.watchers.size, 0);
    assert.equal(h.created.every((w) => w.disposed), true);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The debounce timer used to be armed by schedule() and cleared by nothing. A
// MEMORY.md write within 300 ms of a reload left it live, and it then fired
// refresh() after every subscription had been disposed — clearing a disposed
// DiagnosticCollection, hiding a disposed StatusBarItem, and calling
// syncWatchers(), which creates a watcher per discovered dir into a map nothing
// would ever drain again. Two guards, so this test asserts both.
test('the debounce timer is cleared on teardown, and cannot build watchers after it', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-debounce-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---work', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  const h = harness(tempHome);
  // Stubbed locally rather than in the shared harness: the other tests here do
  // not arm a debounce, and a global timer stub they did not ask for is exactly
  // the kind of shared-fixture coupling that makes one failure look like three.
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const armed = [];
  let cleared = 0;
  global.setTimeout = (fn, ms) => { const handle = { fn, ms }; armed.push(handle); return handle; };
  global.clearTimeout = (handle) => { if (handle) cleared += 1; };
  try {
    const lint = new h.loaded.MemoryLint();
    const subscriptions = [];
    lint.activate({ subscriptions });
    const watchersAfterActivate = h.created.length;
    assert.ok(watchersAfterActivate > 0, 'precondition: activation discovered the store');

    // An external write to MEMORY.md, 300 ms before the user reloads the window.
    lint.schedule();
    assert.equal(armed.length, 1, 'precondition: schedule() armed the debounce');

    // The reload: VS Code disposes every registered subscription.
    for (const subscription of subscriptions) subscription.dispose();
    assert.ok(cleared > 0, 'teardown has to clear the debounce, not only the interval');

    // Belt and brace. Clearing stops a callback being scheduled; it cannot
    // recall one already dispatched, so refresh() must also refuse to run.
    armed[0].fn();
    assert.equal(h.created.length, watchersAfterActivate,
      'a post-teardown refresh must not create another watcher per discovered dir');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// package.json declares permission-wildcarding.lintMemory with no `when` clause
// and a null commandPalette section, so the palette entry exists whatever
// memory.enabled says. Registration used to sit AFTER the enabled check, so
// with the feature off the command's only discoverable entry point raised
// "command not found" — a declared-but-unwired command, not a missing feature.
test('lintMemory stays registered when the lint is disabled, and says so', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-off-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---off', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');

  const h = harness(tempHome, { 'memory.enabled': false });
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });

    assert.ok(h.registered.includes('permission-wildcarding.lintMemory'),
      'the command package.json advertises must exist even with the lint off');
    // ...and the feature really is off, so this is not just "enabled ignored".
    assert.equal(lint.watchers.size, 0, 'no watchers when disabled');
    assert.equal(lint.diags, null, 'no diagnostic collection when disabled');
    // The one thing that IS built on this path besides the command. It used to be armed
    // inside initialize(), below the enabled check, and this assertion read `0`; see
    // 'a window that starts with the lint DISABLED still reconciles on the backstop'.
    assert.equal(h.intervals.length, 1, 'the backstop is armed even with the lint off');

    // Invoking it must report, not throw: activate() never built this.channel
    // on the disabled path, and showReport() used to dereference it.
    assert.doesNotThrow(() => lint.showReport());
    assert.match(h.info.join(' '), /memory lint is off/,
      'it has to name the reason, not fail silently or report an empty index');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The ENABLED path, which is the default and was the one left broken. Moving the
// command registration above the `enabled` check left the original in place, and
// VS Code throws on a duplicate id — so activate() threw partway through, the
// caller logged it to the console, and the reconcile timer, the watcher disposer
// and the initial refresh never ran. The gauge and the diagnostics never
// appeared, in the configuration almost everyone uses.
//
// The sibling test above only drove memory.enabled=false, where the second
// registration is unreachable. That is why it passed while this was broken.
test('activate completes on the default configuration, registering the command once', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-enabled-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  const h = harness(tempHome); // no overrides, so memory.enabled defaults to true
  try {
    const lint = new h.loaded.MemoryLint();
    const subscriptions = [];
    // The whole point: this must not throw.
    assert.doesNotThrow(() => lint.activate({ subscriptions }),
      'a duplicate command registration makes VS Code throw and aborts activate');

    assert.equal(
      h.registered.filter((id) => id === 'permission-wildcarding.lintMemory').length, 1,
      'registered exactly once — twice throws, zero leaves the palette entry dead',
    );
    // Everything after the throw point, which is what silently never ran.
    assert.equal(h.intervals.length, 1, 'the reconcile timer is armed');
    assert.ok(lint.diags, 'the diagnostic collection exists');
    assert.equal(lint.watchers.size, 1, 'the initial refresh ran and built a watcher');
    assert.ok(h.statusText.length > 0, 'and the status-bar gauge was painted');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// `memory.enabled` is a Settings-UI toggle, and everything below activate()'s
// enabled check is built once at activation or never. Flipping it false -> true
// therefore needed a window reload, and the disabled path has no reconcile timer
// to cover for that. extension.js's config listener made this worse rather than
// better for a while: it refreshed the dashboard CARD, whose data is re-read on
// every call, so the card went live while the linter stayed inert — the UI
// asserting the feature was on when it was off.
test('enabling the lint at runtime builds it, without a window reload', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-enable-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — ' + 'y'.repeat(80) + '\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  // Mutable, so the test can flip the setting the way the Settings UI does.
  const overrides = { 'memory.enabled': false };
  const h = harness(tempHome, overrides);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });

    // Disabled: the command exists, and nothing else does.
    assert.equal(h.registered.length, 1, 'the palette entry is always registered');
    assert.equal(lint.diags, null, 'no diagnostic collection yet');
    assert.equal(lint.status, null, 'no gauge yet');
    // The backstop is the exception: it is armed above the enabled check, because it is
    // the only thing that drives a reconcile while the rest of the linter is unbuilt.
    assert.equal(h.intervals.length, 1, 'the backstop is armed on the disabled path');

    overrides['memory.enabled'] = true;
    lint.reconfigure();

    assert.ok(lint.diags, 'the diagnostic collection is built on demand');
    assert.ok(lint.status, 'and the gauge');
    // Not "armed": still ONE. The build must not arm a second interval over the timer
    // activate() already owns, which is what moving setInterval out of initialize() buys.
    assert.equal(h.intervals.length, 1, 'and still exactly one backstop, not a second');
    assert.equal(lint.watchers.size, 1, 'and a watcher exists for the store');
    assert.ok(h.statusText.some((t) => /mem: \d+/.test(t)), 'and the gauge was painted');
    assert.equal(h.registered.length, 1, 'the command is still registered exactly once');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('disabling the lint at runtime releases it, and a second flip does not rebuild twice', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-toggle-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  const overrides = {};   // enabled defaults to true
  const h = harness(tempHome, overrides);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    assert.equal(lint.watchers.size, 1);
    const firstDiags = lint.diags;

    overrides['memory.enabled'] = false;
    lint.reconfigure();
    assert.equal(lint.watchers.size, 0, 'the watchers are released, not just ignored');

    overrides['memory.enabled'] = true;
    lint.reconfigure();
    // initialize() is idempotent: a second build would strand the first
    // collection, gauge and interval with nothing able to dispose them.
    assert.equal(lint.diags, firstDiags, 'the same collection, not a second one');
    assert.equal(h.intervals.length, 1, 'still exactly one reconcile timer');
    assert.equal(lint.watchers.size, 1, 'and the watcher is back');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('reconfigure does nothing once the instance is torn down', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-torndown-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');

  const overrides = {};
  const h = harness(tempHome, overrides);
  try {
    const lint = new h.loaded.MemoryLint();
    const subscriptions = [];
    lint.activate({ subscriptions });
    // What VS Code does at deactivate.
    for (const sub of subscriptions) sub.dispose();
    assert.equal(lint.disposed, true);

    // A configuration event can still arrive here — the listener is disposed,
    // but an already-dispatched callback is not recalled. Rebuilding into a
    // disposed context would leak a watcher per discovered dir into a map
    // nothing will ever drain again.
    lint.reconfigure();

    assert.equal(lint.watchers.size, 0, 'no watcher was created after teardown');
    assert.equal(h.intervals.length, 1, 'and no second reconcile timer');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// showReport() called fullReport(dir, conf) and read r.memPath on the next line. fullReport
// returns null whenever fastLint does, and fastLint returns null on any readFileSync throw.
// refresh() guards this correctly at its own fastLint call, twelve lines away; the palette
// command did not.
test('the report names the file it could not read instead of throwing', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-unreadable-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---eisdir', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  // MEMORY.md as a DIRECTORY. discoverDirs only tests existsSync, so the store is
  // discovered exactly as a healthy one is, and the read then fails EISDIR. A permissions
  // error and a Windows sharing violation arrive at the same null.
  fs.mkdirSync(path.join(dir, 'MEMORY.md'));

  const h = harness(tempHome);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    assert.deepEqual(h.loaded.discoverDirs(h.loaded.cfg()), [dir],
      'precondition: the store is discovered, so the report really does reach fullReport');

    assert.doesNotThrow(() => lint.showReport(),
      'showReport dereferenced a null that its sibling null-checks');
    assert.match(h.errors.join(' '), /could not be read/,
      'a palette command has to say what went wrong, not fail silently');
    assert.match(h.errors.join(' '), /MEMORY\.md/, 'and name the file');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The Gates card offers "Compile gates" only when the corpus has something to compile, and
// it asks this file for the count while recall.py is the thing that actually compiles. The
// two disagreed on the live corpus: 17 here against 16 there. All three divergences below
// are the same class, a test WIDER than the compiler's, so a gate recall.py silently skips
// still lit the button. Under the old rule this fixture counted 4.
test('a gate source is counted only when recall.py would compile it', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-gates-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---gates', 'memory');
  fs.mkdirSync(dir, { recursive: true });

  const fm = (scope) => `---\ntype: feedback\nscope: ${scope}\n---\n\n`;
  const block = '<!-- gate -->\n- **A standing order.** Do the thing.\n<!-- /gate -->\n';

  // The index itself. recall.py:959 skips EXCLUDE before it looks at anything else, so a
  // MEMORY.md carrying frontmatter and a gate block is still not a gate source.
  fs.writeFileSync(path.join(dir, 'MEMORY.md'),
    fm('global') + '# Memory Index\n\n' + block, 'utf8');
  // The only one that counts.
  fs.writeFileSync(path.join(dir, 'compiled.md'), fm('global') + block, 'utf8');
  // The live divergence: opening marker, NO closing marker. recall.py searches for
  // GATE_BEGIN(.*?)GATE_END, so this compiles nothing.
  fs.writeFileSync(path.join(dir, 'unclosed.md'),
    fm('global') + '<!-- gate -->\n- a rule nobody closed\n', 'utf8');
  // A memory that DOCUMENTS gate syntax. `scope: global` appears on its own line in a
  // fenced example, and the frontmatter says project. Testing raw text counted it.
  fs.writeFileSync(path.join(dir, 'documents-gates.md'),
    fm('project') + 'How the pipeline selects:\n\n```\nscope: global\n```\n\n' + block, 'utf8');
  // The divergence in the other direction. recall.py's _fm strips quotes off the value, and
  // the old regex required a bare word, so a quoted scope was a gate this UNDER-counted.
  fs.writeFileSync(path.join(dir, 'quoted-scope.md'), fm('"global"') + block, 'utf8');
  // Controls, so the two surviving conditions are not merely along for the ride.
  fs.writeFileSync(path.join(dir, 'other-scope.md'), fm('project') + block, 'utf8');
  fs.writeFileSync(path.join(dir, 'no-gate.md'), fm('global') + 'resident-eligible, not compiled\n', 'utf8');

  const h = harness(tempHome);
  try {
    assert.equal(h.loaded.memoryReport().report.gateSources, 2,
      'the count has to match what recall.py --gates-compile would lift, file for file');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The two watcher sets in extension.js hang off this hook rather than a third timer of
// their own, so whether refresh() notifies is the whole of their reconcile.
test('every refresh notifies the reconcile subscribers, enabled or not', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-notify-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');

  const overrides = {};
  const h = harness(tempHome, overrides);
  try {
    const lint = new h.loaded.MemoryLint();
    let calls = 0;
    const subscription = lint.onReconcile(() => { calls += 1; });
    lint.activate({ subscriptions: [] });
    assert.ok(calls > 0, 'the initial refresh has to notify');

    const afterActivate = calls;
    assert.equal(h.intervals.length, 1, 'precondition: the backstop timer is armed');
    h.intervals[0].fn();
    assert.equal(calls, afterActivate + 1, 'the 5-minute backstop is what covers a move');

    // Above the enabled check, not below it. A subscriber's watcher set does not honour
    // memory.enabled, so a notify that stopped at the disabled early return would freeze
    // those sets for as long as the lint was off.
    overrides['memory.enabled'] = false;
    const beforeDisable = calls;
    lint.reconfigure();
    assert.ok(calls > beforeDisable, 'a disabled refresh still has to notify');

    subscription.dispose();
    const afterDispose = calls;
    lint.refresh();
    assert.equal(calls, afterDispose, 'a disposed subscription must stop being called');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The sibling above starts ENABLED, so all it can drive is enabled-THEN-disabled: by the
// time it flips memory.enabled off, initialize() has already armed the backstop and its
// `h.intervals.length === 1` precondition holds for that reason alone. This is the other
// order, and it is the one that was broken.
//
// activate() returns before initialize() when memory.enabled is false, and every caller of
// refresh() used to live in initialize() — the save/open/editor listeners and the 5-minute
// backstop alike. refresh() is what runs notifyReconcile(), so a window that OPENED with
// the lint off never notified again for its whole life: extension.js hangs both of its
// memory-store watcher sets off this hook instead of a third timer, so they got their one
// build at activation and nothing rebuilt them. A store that appeared later went unwatched
// — taking automatic gate recompilation with it, since the gates corpus watcher is one of
// only two callers of compileGates — and one that went away left a live watcher on a dead
// directory until deactivate().
test('a window that starts with the lint DISABLED still reconciles on the backstop', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-off-notify-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---off', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  // OFF AT ACTIVATION. Not flipped off afterwards — that is the sibling's fixture.
  const overrides = { 'memory.enabled': false };
  const h = harness(tempHome, overrides);
  try {
    const lint = new h.loaded.MemoryLint();
    let calls = 0;
    lint.onReconcile(() => { calls += 1; });
    lint.activate({ subscriptions: [] });

    assert.equal(lint.diags, null,
      'precondition: the lint really is off, so initialize() was skipped and no listener exists');
    assert.equal(h.intervals.length, 1,
      'the backstop has to be armed above the enabled check, or nothing calls refresh() again');

    h.intervals[0].fn();
    assert.equal(calls, 1, 'the backstop tick is the whole of this path\'s reconcile');
    h.intervals[0].fn();
    assert.equal(calls, 2, 'and it keeps reconciling — one tick is not a cadence');

    // The tick has to be SAFE with nothing built: refresh() takes its disabled early
    // return, where status and diags are optional-chained and the watcher Map is empty.
    assert.equal(lint.watchers.size, 0, 'the lint is still off, so it built no watchers');
    assert.equal(h.statusText.length, 0, 'and painted no gauge');

    // The tick is also what notices a false -> true flip on a host where extension.js's
    // configuration listener does not exist: that listener is guarded by
    // `typeof vscode.workspace.onDidChangeConfiguration === 'function'`. A tick that
    // called refresh() directly would throw here — past the enabled check refresh()
    // dereferences this.diags, which is still null.
    overrides['memory.enabled'] = true;
    h.intervals[0].fn();
    assert.ok(lint.diags, 'the tick builds the half activate() skipped');
    assert.equal(lint.watchers.size, 1, 'and the store is watched from that tick on');
    assert.equal(h.intervals.length, 1, 'building must not arm a second backstop');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The other half of arming the backstop above the enabled check: the disposer that clears
// it has to move up with it. Left behind in initialize(), a window that started with the
// lint off pushed nothing into context.subscriptions, so the interval outlived
// deactivate() and went on calling reconfigure() against a torn-down instance. The
// enabled-path version of this is 'reconfigure does nothing once the instance is torn
// down' above, which cannot see the disabled path for the same reason.
test('a disabled-at-activation window does not leak the backstop past deactivate', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-off-teardown-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---off', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');

  const h = harness(tempHome, { 'memory.enabled': false });
  try {
    const lint = new h.loaded.MemoryLint();
    let calls = 0;
    lint.onReconcile(() => { calls += 1; });
    const subscriptions = [];
    lint.activate({ subscriptions });
    assert.equal(h.intervals.length, 1, 'precondition: the backstop is running');
    // A NONZERO baseline, or the last assertion in this test is `0 === 0` and passes for
    // a reason with nothing to do with teardown.
    h.intervals[0].fn();
    assert.equal(calls, 1, 'precondition: a live tick really does reconcile');

    // What VS Code does at deactivate.
    for (const sub of subscriptions) sub.dispose();
    assert.equal(lint.disposed, true, 'the disposed flag is set from the disabled path too');
    assert.equal(lint.timer, null, 'and the interval handle is cleared, not merely forgotten');

    // An already-dispatched tick is not recalled by clearInterval. Stated for the record:
    // TWO independent early returns stop it on this path, reconfigure()'s and refresh()'s,
    // so deleting either one alone leaves this line green and it takes both to turn it
    // red. It is depth behind the two assertions above, which are what the disposer hoist
    // is actually mutation-tested on — not a substitute for them.
    h.intervals[0].fn();
    assert.equal(calls, 1, 'a tick in flight at teardown must find the instance inert');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// A subscriber is other people's code from this file's point of view, and it runs inside
// the refresh that paints the gauge.
test('a throwing reconcile subscriber is reported, and does not stop the refresh', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-notify-throw-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');

  const h = harness(tempHome);
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.map((a) => String(a)).join(' ')); };
  try {
    const lint = new h.loaded.MemoryLint();
    lint.onReconcile(() => { throw new Error('subscriber exploded'); });
    let second = 0;
    lint.onReconcile(() => { second += 1; });
    lint.activate({ subscriptions: [] });

    assert.ok(second > 0, 'one bad subscriber must not skip the next one');
    assert.ok(h.statusText.length > 0, 'and must not stop the gauge being painted');
    assert.ok(logged.some((m) => /subscriber exploded/.test(m)),
      `the failure has to be recorded, not swallowed; saw: ${JSON.stringify(logged)}`);
  } finally {
    console.error = originalError;
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// ── fullReport ────────────────────────────────────────────────────────────────
//
// fullReport had NO direct test of any kind. Seven test files stub `memoryReport` to a
// zero-arg function returning `{ conf: {}, dir: null, report: null }`, and this file was
// the only one that required the real module at all — for watcher behaviour. So the
// function that reads EVERY file in the memory corpus on every dashboard push, and whose
// `gateSources` decides whether the Gates card offers to compile, was covered by exactly
// one assertion (the gate count above) and nothing else.
//
// Driven through memoryReport() rather than an export, because that IS the production
// path: extension.js calls it once per _push and feeds the result to both the Memory card
// and the Gates card. fullReport is deliberately not exported and this keeps it that way.

// A corpus in a discoverable slug, plus a writer for its files.
function makeCorpus(tempHome, slug) {
  const dir = path.join(tempHome, '.claude', 'projects', slug, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    write(name, body) { fs.writeFileSync(path.join(dir, name), body, 'utf8'); },
  };
}

test('the report counts the .md corpus and carries the fast lint through unchanged', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-full-count-'));
  const c = makeCorpus(tempHome, 'd---full');
  // One over-budget hook line (budget overridden to 40), one link to a file that is
  // there, one to a file that is not.
  c.write('MEMORY.md', '# Memory Index\n\n'
    + '- [present](present.md) — ' + 'y'.repeat(60) + '\n'
    + '- [gone](gone.md) — short\n');
  c.write('present.md', 'body\n');
  c.write('second.md', 'body\n');
  // NOT a memory: the corpus is .md only, and fileCount is what the card prints.
  c.write('notes.txt', 'body\n');
  // Nor is a subdirectory that merely sits in the store.
  fs.mkdirSync(path.join(c.dir, 'archive'));

  const h = harness(tempHome, { 'memory.lineBudget': 40 });
  try {
    const { report } = h.loaded.memoryReport();
    assert.equal(report.fileCount, 3, 'MEMORY.md + present.md + second.md, and nothing else');
    // The fastLint half, spread into the same object. If the spread ever stops happening
    // the Memory card loses every number it prints, so it is asserted here rather than
    // assumed.
    assert.equal(report.lineCount, 4);
    assert.equal(report.bytes, Buffer.byteLength(
      fs.readFileSync(path.join(c.dir, 'MEMORY.md'), 'utf8'), 'utf8'));
    assert.equal(report.tokens, Math.round(report.bytes / 4));
    assert.equal(report.memPath, path.join(c.dir, 'MEMORY.md'));
    assert.equal(report.over.length, 1, 'the 60-y hook line is past the 40-char budget');
    assert.equal(report.over[0].line, 2);
    assert.deepEqual(report.broken.map((b) => b.target), ['gone.md']);
    assert.equal(report.totalOver, false);
    assert.equal(report.linesOver, false);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('an unresolved [[link]] is one no filename and no frontmatter name answers', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-full-links-'));
  const c = makeCorpus(tempHome, 'd---links');
  c.write('MEMORY.md', '# Memory Index\n\n'
    // Resolved by filename, exactly.
    + '- [[plain-hook]]\n'
    // Resolved by filename after norm(): case folded and - mapped to _.
    + '- [[Plain_Hook]]\n'
    // Resolved by the `name:` frontmatter of a file called something else.
    + '- [[the declared name]]\n'
    // Not resolved by anything. Listed twice, to pin the dedupe.
    + '- [[never-written]] and again [[never-written]]\n'
    + '- [[also-missing]]\n');
  c.write('plain-hook.md', 'body\n');
  c.write('renamed-on-disk.md', '---\nname: "the declared name"\n---\n\nbody\n');

  const h = harness(tempHome);
  try {
    const { report } = h.loaded.memoryReport();
    // Sorted and deduped: the card prints this list, and 'never-written' appears twice
    // in the source.
    assert.deepEqual(report.unresolved, ['also-missing', 'never-written']);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('a [[link]] written inside code is an example, not an unresolved link', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-full-code-'));
  const c = makeCorpus(tempHome, 'd---code');
  c.write('MEMORY.md', '# Memory Index\n\n- [one](one.md) — hook\n');
  // All four span forms stripCode blanks, each carrying a link that exists nowhere. A
  // memory that DOCUMENTS the syntax is not a memory with four broken links.
  c.write('one.md', 'Fenced:\n\n```\n[[fenced-example]]\n```\n\n'
    + 'Tilde:\n\n~~~\n[[tilde-example]]\n~~~\n\n'
    + 'Inline: `[[inline-example]]`, and doubled: ``[[doubled-example]]``.\n\n'
    + 'But this one is real prose: [[genuinely-missing]].\n');

  const h = harness(tempHome);
  try {
    const { report } = h.loaded.memoryReport();
    assert.deepEqual(report.unresolved, ['genuinely-missing'],
      'only the link outside every code span counts');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('a .md entry the report cannot read is skipped, and answers no link', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-full-unreadable-'));
  const c = makeCorpus(tempHome, 'd---unreadable');
  c.write('MEMORY.md', '# Memory Index\n\n- [[ghost]] and [[real]]\n');
  c.write('real.md', 'body\n');
  // A DIRECTORY called ghost.md. readdirSync has no withFileTypes here, so it is in the
  // listing and readFileSync then throws EISDIR. The name must NOT resolve [[ghost]]:
  // the loop adds a name to the valid set only after it has read the body, so a `continue`
  // that was moved, or a catch that recorded an empty body, would change this answer.
  fs.mkdirSync(path.join(c.dir, 'ghost.md'));

  const h = harness(tempHome);
  try {
    const { report } = h.loaded.memoryReport();
    assert.deepEqual(report.unresolved, ['ghost'],
      'an entry that could not be read resolves nothing, and does not abort the report');
    assert.equal(report.fileCount, 3, 'it is still in the listing the card counts');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('the report is null, with the dir still named, when MEMORY.md cannot be read', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-full-null-'));
  const c = makeCorpus(tempHome, 'd---null');
  // MEMORY.md as a directory again: discovered by existsSync, unreadable by readFileSync.
  fs.mkdirSync(path.join(c.dir, 'MEMORY.md'));

  const h = harness(tempHome);
  try {
    const out = h.loaded.memoryReport();
    assert.equal(out.dir, c.dir, 'the store was discovered, so the null is the REPORT');
    assert.equal(out.report, null,
      'memoryCardData gates on `dir && report`; a truthy half-report would render a card of undefineds');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// ── discoverDirs and memory.enabled ───────────────────────────────────────────
//
// This was an open question, not a bug: `discoverDirs` reads only `conf.dir` while
// `memoryCardData` honours `conf.enabled`, and the note in BACKLOG.md said teaching
// discoverDirs about `enabled` "would be a behaviour change". Decided, and this test is
// where the decision lives: it STAYS enabled-agnostic.
//
// The reason is its two non-lint callers. extension.js's memoryCardWatchers and
// gatesCorpusWatchers ask "which stores EXIST", and the *.md one is one of only two
// callers of compileGates — so honouring `enabled` here would switch automatic gate
// recompilation off for anyone who hid the status-bar gauge. That exact outcome (zero
// watchers, gates silently never recompiled, nothing logged) already happened once on
// this repo, from the pinned-`memory.dir` bug, and is why `memoryStoreDirs`
// (extension.js:2197) overrides `dir` before calling this.
test('discoverDirs answers which stores EXIST, so memory.enabled cannot switch it off', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-discover-enabled-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---off', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  const h = harness(tempHome, { 'memory.enabled': false });
  try {
    assert.equal(h.loaded.cfg().enabled, false, 'precondition: the lint really is off');
    assert.deepEqual(h.loaded.discoverDirs(h.loaded.cfg()), [dir],
      'the store still has to be discoverable, or the gates corpus watcher is never built');

    // The other half of the contract, so this is not read as "enabled is ignored
    // everywhere". The LINT honours it, in the one place a user can see.
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    assert.equal(lint.watchers.size, 0, 'the linter builds none of its OWN watchers');
    assert.equal(lint.diags, null, 'and no diagnostics');
    assert.equal(h.statusText.length, 0, 'and no gauge');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// ── duplicate work, counted rather than timed ─────────────────────────────────
//
// Every assertion below is a syscall count. These are deterministic, unlike a
// sub-millisecond timing, and they are the property: the cost of this module is what it
// asks the filesystem for, repeated on a function that runs every five minutes, on every
// MEMORY.md save, on every editor activation of one, and 300 ms after every external
// write.

test('one refresh reads each MEMORY.md once and probes each index link once', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-refresh-once-'));
  // TWO stores, so the primary is genuinely one of the dirs the diagnostics loop already
  // walked. With one store the property holds for a weaker reason.
  const { big } = twoStores(tempHome, ['a.md', 'b.md', 'c.md'], ['z.md']);
  const bigIndex = path.join(big, 'MEMORY.md');
  fs.writeFileSync(bigIndex, '# Memory Index\n\n- [a](a.md) — hook\n- [b](b.md) — hook\n', 'utf8');

  const h = harness(tempHome);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    assert.ok(h.statusText.length > 0, 'precondition: activation painted the gauge');

    h.resetCalls();
    lint.refresh();
    assert.ok(h.statusText.length > 0, 'precondition: the refresh under test actually ran');

    assert.equal(h.countsFor('readFileSync', bigIndex), 1,
      'the gauge must reuse the lint the diagnostics loop already took for this dir');
    // The link probes ride on the same duplicated call: two links, probed twice each.
    assert.equal(h.countsFor('existsSync', path.sep + 'a.md'), 1);
    assert.equal(h.countsFor('existsSync', path.sep + 'b.md'), 1);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('a report lists the primary store once, not once to pick it and once to read it', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-scan-once-'));
  // Two stores again, because that is the only shape in which selection lists anything:
  // one store short-circuits before it counts, which is most installs and already free.
  const { big, small } = twoStores(tempHome, ['a.md', 'b.md', 'c.md'], ['z.md']);

  const h = harness(tempHome);
  try {
    h.resetCalls();
    const out = h.loaded.memoryReport();
    assert.equal(out.dir, big, 'precondition: the bigger store won, so its listing is the one reused');
    assert.equal(out.report.fileCount, 4, 'precondition: the report really did read a corpus');

    assert.equal(h.countsFor('readdirSync', big), 1,
      'the listing selection took to count this dir is the listing the report needs');
    // The loser is listed once and never read, which is the whole of what selection costs.
    assert.equal(h.countsFor('readdirSync', small), 1);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The whole syscall budget of one report on the shape most installs have: one project
// slug, one store, two files. A budget rather than a single count on purpose — the
// per-dir assertion above cannot fail for a single store (selection short-circuits
// before it lists, so threading the listing changes nothing there), and a test that
// cannot fail for the thing it names must not ship. Every duplicate this branch removed
// is visible in one of the four numbers below, and so is any new one.
test('a report on a one-store install costs four filesystem calls, and no more', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-scan-single-'));
  const c = makeCorpus(tempHome, 'd---solo');
  c.write('MEMORY.md', '# Memory Index\n\n- [one](one.md) — hook\n');
  c.write('one.md', 'body\n');

  const h = harness(tempHome);
  try {
    h.resetCalls();
    const out = h.loaded.memoryReport();
    assert.equal(out.report.fileCount, 2, 'precondition: the report ran');
    assert.equal(out.report.broken.length, 0, 'precondition: the index link resolves');

    assert.equal(h.calls.readdirSync.length, 2,
      'one scan of ~/.claude/projects to discover, one of the store to read it');
    assert.equal(h.countsFor('readdirSync', c.dir), 1,
      'and the store scan is the one the report needs, not a second one');
    assert.equal(h.calls.readFileSync.length, 2,
      'MEMORY.md once and one.md once — the index is not read twice');
    assert.equal(h.calls.existsSync.length, 1,
      'the one MEMORY.md probe discovery makes; the index link is answered from the listing');
    assert.equal(h.calls.statSync.length, 0,
      'nothing stats anything: the mtime tie-break belongs to multi-store selection');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('the index link probes are answered from the listing the report already has', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-link-probes-'));
  const c = makeCorpus(tempHome, 'd---probes');
  const names = ['one.md', 'two.md', 'three.md', 'four.md', 'five.md'];
  c.write('MEMORY.md', '# Memory Index\n\n'
    + names.map((n) => `- [${n}](${n}) — hook`).join('\n') + '\n');
  for (const n of names) c.write(n, 'body\n');

  const h = harness(tempHome);
  try {
    h.resetCalls();
    const { report } = h.loaded.memoryReport();
    assert.equal(report.broken.length, 0, 'precondition: every link resolves');
    assert.equal(report.fileCount, 6, 'precondition: the listing really was taken');

    for (const n of names) {
      assert.equal(h.countsFor('existsSync', path.sep + n), 0,
        `${n} is in the listing the report just took; probing the filesystem for it is the duplicate`);
    }
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The listing is a HINT. It is flat and case-sensitive; existsSync is neither, and the
// broken-link verdict is a squiggle in the user's editor. Both axes below would flip a
// resolving link to "broken" under a listing-only lookup.
test('a link the listing cannot answer still falls through to the filesystem', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-link-fallback-'));
  const c = makeCorpus(tempHome, 'd---fallback');
  fs.mkdirSync(path.join(c.dir, 'sub'));
  fs.writeFileSync(path.join(c.dir, 'sub', 'nested.md'), 'body\n', 'utf8');
  c.write('one.md', 'body\n');
  c.write('MEMORY.md', '# Memory Index\n\n'
    // A path segment: no flat listing of this dir can ever answer it.
    + '- [nested](sub/nested.md) — hook\n'
    // A case difference against one.md. Whether this resolves is a property of the
    // filesystem, not of this module, and the lint has to give the filesystem's answer.
    + '- [shouty](ONE.md) — hook\n');

  const h = harness(tempHome);
  try {
    const { report } = h.loaded.memoryReport();
    const broken = report.broken.map((b) => b.target);
    assert.equal(broken.includes('sub/nested.md'), false,
      'a link into a subdirectory is not broken merely because this dir listing lacks it');

    const caseInsensitive = fs.existsSync(path.join(c.dir, 'ONE.md'));
    assert.equal(broken.includes('ONE.md'), !caseInsensitive,
      `existsSync('ONE.md') is ${caseInsensitive} on this filesystem, so the lint must say `
      + `${caseInsensitive ? 'resolved' : 'broken'}; a Set lookup always says broken`);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
