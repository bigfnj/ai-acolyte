'use strict';

// The dashboard had no tests at all. It is the extension's whole UI — its message
// cases, a 15-helper work-up run on every one of ~35 refresh() call sites, and a
// hide/show identity check that decides whether the panel keeps working — and
// none of it was reachable from a test, because nothing ever called
// resolveWebviewView.
//
// It does not need a production export to become reachable:
// registerWebviewViewProvider(viewId, dashboard) is handed the live instance and
// every existing mock throws argument 2 away. Capturing it is the whole unlock.
// The view VS Code would pass is seven members wide (below), and _html() never
// touches its `webview` argument, so there is no asWebviewUri/cspSource to fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function disposable() { return { dispose() {} }; }

// The purge below is a STATEMENT, not a guarantee, and deleting it turns nothing red.
// The next harness silently re-uses the previous one's `os` stub and scripted `fs`, a
// precondition stops being reachable, and the assertion behind it passes on an input
// that never arrived. That is not hypothetical: when the rebasing writer moved into
// src/settings-write.js this file's scripted 'corrupt' read stopped reaching it, and the
// assertion after it went vacuous without going red. So the CONDITION is asserted at the
// load site, separately from the purge, where a dropped purge fails instead of going quiet.
function assertFreshProjectCache(extensionPath, rootSrc) {
  const extensionDir = path.dirname(extensionPath) + path.sep;
  const stale = Object.keys(require.cache)
    .filter((key) => key.startsWith(rootSrc + path.sep) || key.startsWith(extensionDir))
    .map((key) => path.basename(key))
    .sort();
  assert.deepEqual(stale, [],
    'project modules are still cached from before this harness installed its mocks, so they '
    + `will resolve an earlier home: ${stale.join(', ')}`);
}

// Longer than DASHBOARD_BOUNCE_MS: refresh() is debounced like every other
// handler in the extension, so a push lands on the next tick, not this one.
function settle(ms = 140) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Copied from test/policy-backup.test.js rather than shared. That is a standing
// decision in this suite (test/extension-activation.test.js:141-143: "Kept as its
// own mock rather than sharing the one above… duplicating a mock is far cheaper
// than breaking the activation test that already works"), and this file needs two
// things that one does not: the provider instance, and a count of how many times
// the quadratic allow-list pass runs.
// `opts.memoryReport` replaces the no-corpus stub below. Without it every test in this
// file runs memoryCardData against `report: null`, so the function returns early and
// nothing it builds is ever asserted — a mutation that emptied a payload field survived
// the whole suite.
function harness(tempHome, opts = {}) {
  const commands = new Map();
  const executed = [];
  const passes = { count: 0 };
  // Every policy-lock acquisition, plus a hook that runs after the lock is held
  // but BEFORE the guarded work — i.e. inside the read-to-write window. Nothing
  // in the suite could observe either before this: no test asserted the
  // extension took the lock, and none counted acquisitions.
  //
  // `contended`, set by a test, makes every acquisition fail the way it fails in
  // production: Auto Learn holds the lock, so createPolicyLock throws with
  // code AUTO_LEARN_LOCKED. That is the only branch that spends the retry budget,
  // and nothing in the suite could reach it.
  const locks = { count: 0, insideLock: null, contended: false, refused: 0 };
  const settingsPath = path.join(tempHome, '.claude', 'settings.json');
  // One directive per read of settings.json, consumed in order, then
  // pass-through. Armed by a test via app.arm(); empty for every other test, so
  // reads go straight to disk.
  const reads = [];
  // Every notification the extension raised, and the queue of answers a test
  // hands back to modal ones. See the window stub below.
  const shown = [];
  const answers = [];
  // Every status-bar message, which used to be thrown away. "already optimal" is
  // only ever said there, so a path that must NOT claim it — an absent or
  // half-written settings.json — was unobservable.
  const statuses = [];
  // Every timer the extension arms, with its delay. The 1500 ms one is
  // runWildcarding's lock-contention backoff and the only observable the retry
  // BUDGET has: `lockedRetries` is module-private and its whole effect is whether
  // a retry gets scheduled at all. Nothing else in this harness arms 1500 ms —
  // schedulePolicyCheck uses the same figure but is reachable only from a watcher
  // event, and the watchers here are inert stubs.
  const timers = [];
  let provider = null;
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class RelativePattern {
      constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      executeCommand(id) { executed.push(id); },
    },
    window: {
      createStatusBarItem() { return { hide() {}, show() {}, dispose() {} }; },
      registerWebviewViewProvider(_viewId, instance) { provider = instance; return disposable(); },
      setStatusBarMessage(message) { statuses.push(String(message)); },
      showErrorMessage(message) { shown.push({ level: 'error', message, options: null, actions: [] }); },
      showInformationMessage(message) {
        shown.push({ level: 'info', message, options: null, actions: [] });
        return Promise.resolve(undefined);
      },
      // Recorded, and answerable. A modal confirmation is a branch like any
      // other, and the old stub could only ever take the "dismissed" side of
      // one — so a command that asks before acting was untestable past the
      // question. `answers` is consumed in order and empty everywhere else, so
      // every existing test still gets the dismiss-everything default.
      showWarningMessage(message, ...rest) {
        const options = rest.length && typeof rest[0] === 'object' ? rest[0] : null;
        shown.push({ level: 'warning', message, options, actions: options ? rest.slice(1) : rest });
        return Promise.resolve(answers.length ? answers.shift() : undefined);
      },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
      createFileSystemWatcher(pattern) {
        return { pattern, onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} };
      },
      getConfiguration() {
        return {
          // Auto Learn off: this is about the panel, not the learner. `opts.settings`
          // overrides by key, for the one test that needs the learner's own card
          // populated; empty for every other, so the default below is unchanged.
          get: (key, fallback) => {
            if (opts.settings && key in opts.settings) return opts.settings[key];
            return key === 'autoLearn.enabled' ? false : fallback;
          },
          inspect: () => ({}),
          update: async () => {},
        };
      },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };

  const extensionPath = require.resolve('../vscode-extension/extension');
  const settingsWritePath = require.resolve('../src/settings-write');
  const scriptedReaders = new Set([extensionPath, settingsWritePath]);
  const memoryReports = { count: 0 };
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => tempHome };
    if (request === 'fs' && scriptedReaders.has(parent?.filename)) {
      // A seam for one specific, routine failure: Claude Code rewrites
      // settings.json in place on every approval, /model and /effort, so two
      // reads taken moments apart do not have to agree, and the second one can
      // land inside a write.
      //
      // Both modules on the write path are scripted, because the path spans two:
      // removeAllowEntry reads in extension.js, then writeAllow re-reads in
      // src/settings-write.js to rebase onto the newest copy. Scripting only the
      // extension's reads left the SECOND one hitting the real disk, so the
      // "write failed" precondition silently could not happen and the test
      // asserted nothing. Only readFileSync is replaced — writeFileAtomicSync
      // keeps the real fs, so the writes under test are genuine.
      const realFs = originalLoad.call(this, 'fs', parent, isMain);
      return {
        ...realFs,
        readFileSync(file, ...rest) {
          if (file === settingsPath && reads.length && reads.shift() === 'corrupt') {
            return '{ not json';
          }
          return realFs.readFileSync(file, ...rest);
        },
      };
    }
    if (parent?.filename === extensionPath && request === './src/permissions') {
      // Counted, not replaced. processAllowList is the expensive half of the
      // dashboard work-up (quadratic; ~57ms on the 423-entry list this was built
      // for) and it used to run twice per settings write — once in
      // runWildcarding, once again in the refresh that immediately followed.
      const real = originalLoad.call(this, path.join(rootSrc, 'permissions.js'), parent, isMain);
      return {
        ...real,
        processAllowList: (list) => { passes.count += 1; return real.processAllowList(list); },
      };
    }
    if (parent?.filename === extensionPath && request === './src/policy-lock') {
      const real = originalLoad.call(this, path.join(rootSrc, 'policy-lock.js'), parent, isMain);
      return {
        ...real,
        createPolicyLock: (...args) => {
          const lock = real.createPolicyLock(...args);
          return {
            ...lock,
            locked: (fn) => {
              // What production does when Auto Learn already holds it: throw with
              // code AUTO_LEARN_LOCKED. That is the only branch that spends the
              // retry budget, and nothing in the suite could reach it.
              if (locks.contended) {
                locks.refused += 1;
                const busy = new Error('Auto Learn is holding the policy lock');
                busy.code = real.POLICY_LOCK_CODE;
                throw busy;
              }
              return lock.locked(() => {
                locks.count += 1;
                // The injection point. A settings.json write landing here is
                // exactly the interleaving writeAllow's delta replay cannot
                // survive unless the guarded work re-reads.
                if (locks.insideLock) locks.insideLock();
                return fn();
              });
            },
          };
        },
      };
    }
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class MemoryLint { activate() {} onReconcile() { return { dispose() {} }; } },
        // COUNTED, not just stubbed. The real memoryReport is 6.99 ms and 25 fs
        // syscalls against a live corpus, and _push used to call it twice for two
        // cards that need disjoint parts of one result. How many times it is
        // called is the whole property, and nothing else in the suite can see it.
        memoryReport: () => {
          memoryReports.count += 1;
          if (opts.memoryReport) return opts.memoryReport();
          return { conf: {}, dir: null, report: null, gateSources: undefined };
        },
        cfg: () => ({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 }),
        discoverDirs: () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // Drop every cached shared module as well as the extension, so each one is
  // re-required under the mocked `os` and the scripted `fs` above. A module that
  // captured either at first load keeps the FIRST test's temp home and the real
  // fs for the rest of the file — which is how the scripted 'corrupt' read
  // silently stopped reaching writeAllow's re-read once that moved into src/,
  // leaving the failure this test exists to check unable to happen.
  // local-drain-extension.test.js already does this, for the same reason.
  //
  // The whole extension DIRECTORY, not just extension.js: autoLearnUi.js and
  // autoLearnWorkerRunner.js are real requires from it (extension.js:10, :47), so
  // leaving them cached leaves a second harness holding the first one's instances.
  const extensionDir = path.dirname(extensionPath) + path.sep;
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(rootSrc + path.sep) || cached.startsWith(extensionDir)) {
      delete require.cache[cached];
    }
  }
  assertFreshProjectCache(extensionPath, rootSrc);
  // Recorded, and unref'd. Unref matters: the contention tests arm 1500 ms
  // retries deliberately and must not keep `node --test` alive waiting for them.
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => {
    const handle = originalSetTimeout(fn, ms, ...rest);
    if (typeof handle?.unref === 'function') handle.unref();
    timers.push({ ms, handle });
    return handle;
  };
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });
  return {
    commands,
    executed,
    extension,
    memoryReports,
    passes,
    locks,
    shown,
    statuses,
    // How many lock-contention retries were scheduled. See `timers` above for
    // why 1500 ms identifies them uniquely under this harness.
    retriesScheduled() { return timers.filter((entry) => entry.ms === 1500).length; },
    answer(...values) { answers.push(...values); },
    arm(plan) { reads.length = 0; reads.push(...plan); },
    // How many armed read directives are still unconsumed. A test that scripts a
    // corrupt read has to prove the read HAPPENED, or it is asserting against an
    // ordinary successful one.
    armsLeft() { return reads.length; },
    get provider() { return provider; },
    async dispose() {
      await extension.deactivate();
      for (const entry of timers) clearTimeout(entry.handle);
      global.setTimeout = originalSetTimeout;
      Module._load = originalLoad;
      // Purge the whole tree, not just the entry. Every src/ module that
      // defaults a home resolves it against its OWN `os` binding, frozen at
      // first require — so leaving them cached hands the next harness this
      // one's stub. Same fix as test/extension-activation.test.js.
      const extensionDir = path.dirname(extensionPath) + path.sep;
      for (const key of Object.keys(require.cache)) {
        if (key.startsWith(rootSrc + path.sep) || key.startsWith(extensionDir)) {
          delete require.cache[key];
        }
      }
    },
  };
}

function setup(t) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-dashboard-'));
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const settingsPath = path.join(tempHome, '.claude', 'settings.json');
  return {
    tempHome,
    settingsPath,
    write: (value) => fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n'),
    read: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
  };
}

// Exactly the seven members resolveWebviewView touches, and nothing else — so a
// new dependency on the real WebviewView API shows up here as a TypeError rather
// than as a silent pass.
function fakeView() {
  const posted = [];
  const on = {};
  const view = {
    visible: true,
    webview: {
      options: null,
      html: null,
      onDidReceiveMessage(cb) { on.message = cb; return disposable(); },
      postMessage(payload) { posted.push(payload); return Promise.resolve(true); },
    },
    onDidDispose(cb) { on.dispose = cb; return disposable(); },
    onDidChangeVisibility(cb) { on.visibility = cb; return disposable(); },
  };
  return { view, posted, on };
}

// Fifteen already-generalized families, so the wildcarding pass leaves them
// alone and the list on disk is the list under test. Three more than the cap.
const NATO = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliett', 'kilo', 'lima', 'mike', 'november', 'oscar',
];
const FIFTEEN = NATO.map((word) => `Bash(${word} *)`);

test('resolveWebviewView wires the webview and pushes one debounced payload', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);

    assert.deepEqual(ui.view.webview.options, { enableScripts: true });
    assert.ok(ui.view.webview.html.startsWith('<!DOCTYPE html>'), 'the panel document is assigned');
    assert.equal(ui.posted.length, 0, 'the push is debounced, not synchronous');

    await settle();
    assert.equal(ui.posted.length, 1);
    const data = ui.posted[0];
    assert.equal(data.type, 'data');
    assert.equal(data.active, true);
    assert.equal(data.total, 1);
    assert.deepEqual(data.wildcards, ['Bash(git status *)']);
    assert.equal(data.wildcardCount, 1);
    assert.equal(data.specificCount, 0);
    assert.equal(data.pendingWildcard, 0, 'an already-optimal list badges no pending work');
    // The two helpers that need real bytes on disk; the other thirteen collapse
    // to null/0 under this harness, which is why it can stay this small.
    assert.equal(data.backupCount, 1, 'activation captured the live list into the backup');
    assert.ok(data.settingsPath.endsWith(path.join('.claude', 'settings.json')));
  } finally {
    await app.dispose();
  }
});

test('every dashboard message reaches its command, and nothing else does', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    // autoLearnApply and autoLearnMode were removed with their switch arms: the webview has
    // no sender for either, so this table was the only thing reaching them. A routing test
    // that posts every type directly cannot tell a live route from a dead one, which is how
    // both arms stayed alive through three audits. The palette commands they targeted still
    // exist and are still covered by extension-activation.test.js.
    const routes = [
      ['runNow', 'permission-wildcarding.runNow'],
      ['restore', 'permission-wildcarding.restoreBackup'],
      ['autoLearnScan', 'permission-wildcarding.autoLearnScan'],
      ['autoLearnReview', 'permission-wildcarding.autoLearnReview'],
      ['autoLearnUndo', 'permission-wildcarding.autoLearnUndo'],
      ['autoLearnWhy', 'permission-wildcarding.autoLearnWhy'],
      ['rebuildRecall', 'permission-wildcarding.rebuildRecall'],
      ['lintMemory', 'permission-wildcarding.lintMemory'],
      ['drainLocal', 'permission-wildcarding.drainLocal'],
      ['toggleGuidance', 'permission-wildcarding.toggleGuidance'],
      ['toggleGates', 'permission-wildcarding.toggleGates'],
      ['showWildcards', 'permission-wildcarding.showWildcards'],
    ];
    for (const [type, command] of routes) {
      app.executed.length = 0;
      ui.on.message({ type });
      assert.deepEqual(app.executed, [command], `${type} routes to ${command}`);
    }

    // The old ids remain unadvertised cleanup aliases for installations that
    // carried MAX state across the upgrade. They must not regain a dashboard
    // route, card, button, or status surface.
    assert.equal(app.commands.has('permission-wildcarding.toggleMax'), true);
    assert.equal(app.commands.has('permission-wildcarding.toggleCodexMax'), true);
    assert.doesNotMatch(ui.view.webview.html, /toggle(?:Codex)?Max|codexMaxBtn|stMax/);

    // A route added to the switch without a row above would otherwise ship
    // untested — the panel's buttons are the only way most of these are reached.
    //
    // The census is over CASE LABELS, not over `case 'x': vscode.commands.executeCommand(`.
    // That older regex asked whether a label and a dispatch sat on one line, which three
    // real shapes sidestep: a braced body (`case 'x': { ... }`), a dispatch through a
    // variable (`executeCommand(COMMANDS[msg.type])`), and any label carrying a digit,
    // which `[A-Za-z]+` cannot match at all. Enumerating the labels inside the switch and
    // reconciling the whole SET against the table above cannot be dodged by how a body is
    // written, and it catches a route being removed as well as one being added.
    const source = fs.readFileSync(require.resolve('../vscode-extension/extension'), 'utf8');
    const switchAt = source.indexOf('switch (msg?.type)');
    assert.ok(switchAt > 0,
      'the dashboard message switch was renamed or restructured, so this census scans nothing');
    const bodyStart = source.indexOf('{', switchAt);
    let depth = 0;
    let bodyEnd = -1;
    for (let i = bodyStart; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    assert.ok(bodyEnd > bodyStart, 'the message switch never closes; the brace scan found no body');
    const body = source.slice(bodyStart, bodyEnd);
    const labels = (body.match(/case\s+'([^']*)'\s*:/g) || [])
      .map((hit) => hit.slice(hit.indexOf("'") + 1, hit.lastIndexOf("'")));
    assert.ok(labels.length > 0, 'precondition: the switch body yielded no case labels at all');
    // The two handled in-process are NAMED rather than skipped: a third in-process case
    // added quietly is the same defect as a third dispatching one.
    assert.deepEqual(
      labels.slice().sort(),
      routes.map(([type]) => type).concat(['refresh', 'remove']).sort(),
      'the dashboard switch handles a message type this test does not exercise, or has '
      + 'stopped handling one it does');

    // The two that are handled in-process rather than dispatched.
    app.executed.length = 0;
    ui.posted.length = 0;
    ui.on.message({ type: 'refresh' });
    await settle();
    assert.deepEqual(app.executed, [], 'refresh is handled here, not dispatched');
    assert.equal(ui.posted.length, 1);

    ui.on.message({ type: 'remove', value: 'Bash(git status *)' });
    await settle();
    assert.deepEqual(env.read().permissions.allow, [], 'remove prunes the entry it was given');

    // Junk and absent types must not dispatch anything.
    app.executed.length = 0;
    ui.on.message({ type: 'notAThing' });
    ui.on.message(undefined);
    assert.deepEqual(app.executed, []);
  } finally {
    await app.dispose();
  }
});

test('a hide/show race disposes the dead view, never the live one', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome);
  try {
    // The view is disposed on every hide (package.json does not declare
    // retainContextWhenHidden) and re-resolved on show, so a quick hide/show can
    // resolve the replacement before the first one's disposal is delivered.
    const first = fakeView();
    const second = fakeView();
    app.provider.resolveWebviewView(first.view);
    app.provider.resolveWebviewView(second.view);
    await settle();

    first.on.dispose();               // late notification for the view already replaced
    second.posted.length = 0;
    app.provider.refresh();
    await settle();
    assert.equal(second.posted.length, 1, 'the live view still receives pushes');

    // And the identity check must still let a real disposal through.
    second.on.dispose();
    app.provider.refresh();
    await settle();
    assert.equal(second.posted.length, 1, 'a disposed view stops receiving pushes');
  } finally {
    await app.dispose();
  }
});

test('with no live view there is no push and no work-up', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    // Never resolved: refresh() must not even reach processAllowList, because
    // ~35 call sites — several of them file-watcher callbacks — fire while the
    // sidebar is collapsed.
    const before = app.passes.count;
    app.provider.refresh();
    await settle();
    assert.equal(app.passes.count, before, 'the whole work-up is skipped, not just the post');

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    assert.equal(ui.posted.length, 1);

    ui.on.dispose();
    const after = app.passes.count;
    app.provider.refresh();
    await settle();
    assert.equal(ui.posted.length, 1, 'postMessage is not called once the view is gone');
    assert.equal(app.passes.count, after);
  } finally {
    await app.dispose();
  }
});

test('one push per burst, and the wildcarding pass is not repeated for it', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    // runWildcarding computes processAllowList and hands the result over; the
    // refresh that follows must not compute the identical value a second time.
    ui.posted.length = 0;
    let before = app.passes.count;
    await app.commands.get('permission-wildcarding.runNow')();
    await settle();
    assert.equal(app.passes.count - before, 1, 'one pass per settings write, not two');
    assert.equal(ui.posted.length, 1);
    assert.equal(ui.posted[0].pendingWildcard, 0);
    assert.equal(ui.posted[0].wildcardCount, FIFTEEN.length);

    // A watcher pair (onDidChange + onDidCreate) fires together, and several
    // call sites refresh twice for one event. One push.
    ui.posted.length = 0;
    for (let i = 0; i < 5; i += 1) app.provider.refresh();
    await settle();
    assert.equal(ui.posted.length, 1, 'the burst coalesces into a single push');

    // A hint is only a shortcut while it still describes the file. If something
    // wrote settings.json in between, the pass runs for real rather than
    // rendering a badge against a list that is no longer there.
    ui.posted.length = 0;
    before = app.passes.count;
    app.provider.refresh({ allow: ['Bash(stale *)'], optimized: ['Bash(stale *)'] });
    await settle();
    assert.equal(app.passes.count - before, 1, 'a stale hint is recomputed, not trusted');
    assert.deepEqual(ui.posted[0].wildcards, [...FIFTEEN].sort());
  } finally {
    await app.dispose();
  }
});

test('a prune whose settings write fails keeps its backup cover', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(rg *)'], deny: [] } });
  const app = harness(env.tempHome);
  const backupPath = path.join(env.tempHome, '.claude', 'backups', 'allow-list.latest.json');
  const backup = () => JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    assert.ok(backup().allow.includes('Bash(rg *)'), 'precondition: the backup holds the entry');

    // removeAllowEntry reads settings.json, then writeAllow reads it again to
    // rebase onto the newest copy — and that second read throws
    // SETTINGS_UNREADABLE whenever it lands inside one of Claude Code's in-place
    // rewrites, which is every approval. Pruning the backup before the write
    // meant the entry stayed live in settings.json with its only copy gone from
    // the high-water mark, so a later wipe could not restore it.
    app.arm(['ok', 'corrupt']);
    ui.on.message({ type: 'remove', value: 'Bash(rg *)' });
    await settle();

    assert.ok(env.read().permissions.allow.includes('Bash(rg *)'),
      'precondition: the write failed, so the entry is still live in settings.json');
    assert.ok(backup().allow.includes('Bash(rg *)'),
      'a prune that never landed must not take the entry out of the backup');

    // And the successful prune still forgets, or the guard reports the user's own
    // instruction as damage forever.
    ui.on.message({ type: 'remove', value: 'Bash(rg *)' });
    await settle();
    assert.ok(!env.read().permissions.allow.includes('Bash(rg *)'));
    assert.ok(!backup().allow.includes('Bash(rg *)'), 'a prune that landed leaves the backup');
  } finally {
    await app.dispose();
  }
});

// ── the webview document ───────────────────────────────────────────────────────

// _html() returns one JS template literal, and a single backtick anywhere inside
// it — in a comment, in a string, anywhere — ends the literal and breaks the
// file. That has happened three times. node --check does not always catch it
// (the result can still parse), so count them.
test('the panel template contains no backtick that would end it early', () => {
  const lines = fs.readFileSync(require.resolve('../vscode-extension/extension'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('return `<!DOCTYPE html>'));
  const end = lines.findIndex((line, index) => index > start && line.trim() === '</html>`;');
  assert.ok(start > 0, 'the template still starts with a tagged <!DOCTYPE html> line');
  assert.ok(end > start, 'the template still ends with a </html> line');
  const offenders = [];
  for (let index = start + 1; index < end; index += 1) {
    if (lines[index].includes('`')) offenders.push(`${index + 1}: ${lines[index].trim()}`);
  }
  assert.deepEqual(offenders, [], 'no backticks between the template delimiters');
});

// The Memory card used two different definitions of "issue": the badge counted
// over + broken + unresolved, the body counted over + broken. With only unresolved
// [[links]] present it read "3 to fix" directly above "index clean, all links
// resolve", over a Rebuild button that cannot clear them -- they are forward-links
// to memories not written yet, which memoryLint's fullReport calls report-only.
// Nothing covered the memory card at all before this.
test('an unresolved [[link]] is reported, not counted as something to fix', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const panel = runPanelScript(ui.view.webview.html);

    const payload = { ...ui.posted[0] };
    payload.memory = { tokens: 1700, fileCount: 120, embedded: 119, indexable: 119,
      over: 0, broken: 0, unresolved: 3 };
    panel.deliver(payload);

    const badge = panel.dom.byId.get('stMemory').textContent;
    assert.ok(!/to fix/.test(badge),
      'a forward-link must not be counted as work: badge said "' + badge + '"');

    const body = panel.dom.byId.get('memIssues');
    const text = body.textContent || (body.children[0] || {}).textContent || '';
    assert.ok(!/all links resolve/.test(text),
      'the card must not claim all links resolve while three do not: "' + text + '"');
    assert.match(text, /3 forward-links not written yet/,
      'the card should say what the three actually are');
  } finally { app.dispose(); }
});

test('a genuinely broken index link is still counted as something to fix', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const panel = runPanelScript(ui.view.webview.html);

    const payload = { ...ui.posted[0] };
    payload.memory = { tokens: 1700, over: 1, broken: 2, unresolved: 3 };
    panel.deliver(payload);

    // 3, not 6: over + broken, with the three forward-links excluded.
    assert.match(panel.dom.byId.get('stMemory').textContent, /3 to fix/,
      'real faults must still reach the badge, and must not be inflated by forward-links');
  } finally { app.dispose(); }
});

// Claude Code loads the first 200 lines of MEMORY.md and drops the rest in silence. The
// card watched bytes only, against a self-imposed 12000-byte budget, so it could read
// green while the tail of the index was already absent from every session. Lines are also
// the axis that grows -- about one per project -- while the byte count barely moves.
async function memoryCard(t, memory) {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome);
  const ui = fakeView();
  app.provider.resolveWebviewView(ui.view);
  await settle();
  const panel = runPanelScript(ui.view.webview.html);
  panel.deliver({ ...ui.posted[0], memory });
  const body = panel.dom.byId.get('memIssues');
  return {
    app,
    state: panel.dom.byId.get('stMemory'),
    lines: panel.dom.byId.get('memLines'),
    label: panel.dom.byId.get('memLinesLabel'),
    issues: body.textContent || (body.children[0] || {}).textContent || '',
  };
}

// The three tests below deliver a hand-built payload, which exercises the webview render
// but never memoryCardData. This one drives the payload builder for real, because the two
// halves fail independently: a render that reads a field nobody sets shows a dash forever
// and every render assertion still passes.
// existsSync cannot separate present-and-parseable from present-and-corrupt, so a corrupt or
// mid-write settings.json showed a green Active pill while every writer was refusing with
// SETTINGS_UNREADABLE. Same shape as the bug already fixed in toggleMax.
test('a corrupt settings.json is not reported as Active', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const healthy = ui.posted[ui.posted.length - 1];
    assert.equal(healthy.active, true, 'precondition: a readable file is Active');
    assert.equal(healthy.settingsState, 'present');

    // Every read of settings.json from here on returns unparseable bytes.
    app.arm(Array(12).fill('corrupt'));
    app.provider.refresh();
    await settle();

    const broken = ui.posted[ui.posted.length - 1];
    assert.equal(broken.settingsState, 'unreadable',
      'a present-but-unparseable file is its own state, not absent and not fine');
    assert.equal(broken.active, false,
      'the green pill must not claim Active while every writer is refusing');
  } finally { app.dispose(); }
});

test('the card payload carries the line count, not just the byte count', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome, {
    memoryReport: () => ({
      conf: { enabled: true, totalBudget: 12000, maxLines: 200 },
      dir: path.join(env.tempHome, '.claude', 'projects', 'p', 'memory'),
      report: {
        tokens: 1662, bytes: 6648, fileCount: 120, lineCount: 84, linesOver: false,
        over: [], broken: [], unresolved: [],
      },
    }),
  });
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const m = ui.posted[0].memory;
    assert.ok(m, 'the memory card was built, so the assertions below mean something');
    assert.equal(m.lines, 84, 'the line count must reach the webview or the stat is a dash');
    assert.equal(m.maxLines, 200, 'the cap travels with the count, or the card invents one');
    assert.equal(m.linesOver, false);
  } finally { await app.dispose(); }
});

test('the line count is on the card before it becomes a problem', async (t) => {
  const card = await memoryCard(t, {
    tokens: 1700, lines: 84, maxLines: 200, linesOver: false,
    over: 0, broken: 0, unresolved: 0,
  });
  try {
    assert.equal(card.lines.textContent, 84, 'the growth axis is shown even when healthy');
    assert.match(card.label.textContent, /of 200 lines/);
    assert.ok(!/warn/.test(card.state.className),
      'an index well inside the cap must not warn: ' + card.state.className);
    assert.equal(card.lines.style.color, '', 'no colour at 42% of the cap');
  } finally { card.app.dispose(); }
});

test('approaching the cap colours the count before it is breached', async (t) => {
  const card = await memoryCard(t, {
    tokens: 1700, lines: 185, maxLines: 200, linesOver: false,
    over: 0, broken: 0, unresolved: 0,
  });
  try {
    assert.equal(card.lines.style.color, 'var(--vscode-charts-yellow, #d29922)',
      'the point of the gauge is the warning arriving before the truncation does');
    assert.ok(!/warn/.test(card.state.className),
      'nothing is being dropped yet, so the row itself stays calm');
  } finally { card.app.dispose(); }
});

test('an index past the line cap warns, with nothing else wrong', async (t) => {
  const card = await memoryCard(t, {
    tokens: 1700, lines: 205, maxLines: 200, linesOver: true,
    over: 0, broken: 0, unresolved: 0,
  });
  try {
    assert.match(card.state.className, /warn/,
      'five lines are missing from every session; the row cannot read clean');
    assert.match(card.state.textContent, /205\/200 lines/);
    assert.ok(!/to fix/.test(card.state.textContent),
      'a whole-file condition has no line to point at, so it must not inflate the count');
    assert.match(card.issues, /past the cap/);
    assert.ok(!/index clean/.test(card.issues),
      'the card must not call a truncated index clean: "' + card.issues + '"');
    assert.equal(card.lines.style.color, 'var(--vscode-charts-red, #f85149)');
  } finally { card.app.dispose(); }
});

// The cap and the "and N more" affordance are the only dashboard logic that
// lives in the webview script rather than in a method, so run the script the way
// the webview would: a DOM thin enough to read in one screen, fed the exact
// payload resolveWebviewView pushed.
function fakeDom() {
  const byId = new Map();
  const make = (tag) => {
    const element = {
      tag,
      children: [],
      listeners: {},
      dataset: {},
      style: {},
      classList: { toggle() {} },
      className: '',
      textContent: '',
      title: '',
      innerHTML: '',
      hidden: false,
      appendChild(child) { element.children.push(child); return child; },
      addEventListener(name, callback) {
        (element.listeners[name] || (element.listeners[name] = [])).push(callback);
      },
      click() {
        for (const callback of element.listeners.click || []) callback({ preventDefault() {} });
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    return element;
  };
  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, make('#' + id));
      return byId.get(id);
    },
    createElement: make,
    querySelectorAll() { return []; },
  };
  return { document, byId };
}

function runPanelScript(html) {
  const opening = html.indexOf('<script nonce=');
  const body = html.slice(html.indexOf('>', opening) + 1, html.indexOf('</script>', opening));
  const dom = fakeDom();
  const posted = [];
  const listeners = {};
  const api = {
    getState: () => ({}),
    setState: () => {},
    postMessage: (payload) => posted.push(payload),
  };
  const win = {
    addEventListener(name, callback) {
      (listeners[name] || (listeners[name] = [])).push(callback);
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('acquireVsCodeApi', 'document', 'window', body)(() => api, dom.document, win);
  return {
    dom,
    posted,
    deliver(data) { for (const callback of listeners.message || []) callback({ data }); },
  };
}

test('the sidebar renders twelve wildcards and defers the rest to the picker', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const panel = runPanelScript(ui.view.webview.html);
    assert.deepEqual(panel.posted, [{ type: 'refresh' }], 'the panel asks for its first payload');
    panel.deliver(ui.posted[0]);

    const rows = panel.dom.byId.get('list').children;
    assert.equal(rows.length, 13, 'twelve entries plus one deferral row');

    const shown = rows.slice(0, 12).map((row) => row.children[0].textContent);
    assert.deepEqual(shown, [...FIFTEEN].sort().slice(0, 12));

    const more = rows[12];
    assert.equal(more.className, 'more');
    assert.equal(more.textContent, 'and 3 more — search all 15 →');

    // The deferral opens the QuickPick, and each row's ✕ prunes that entry.
    panel.posted.length = 0;
    more.click();
    rows[0].children[1].click();
    assert.deepEqual(panel.posted, [
      { type: 'showWildcards' },
      { type: 'remove', value: [...FIFTEEN].sort()[0] },
    ]);
  } finally {
    await app.dispose();
  }
});

// The memory report is the most expensive thing one push does: measured 6.99 ms
// and 25 fs syscalls (12 readFileSync + 11 existsSync + 2 readdirSync) against a
// live corpus. _push called it TWICE — once for the Memory card, once for a
// one-integer `gateSources` lookup in the Gates card that the first call had
// already computed. Two calls measured 9.92 ms, so the duplicate cost 2.93 ms of
// every refresh, and a refresh fires on every settings.json change.
//
// This is the only assertion in the suite that can see it. Every other test stubs
// memoryReport and ignores how often it is called, and no test exercises the real
// one from this path at all — so without a count, reverting the hoist is silent.
test('one push computes the memory report once, not once per card that needs it', async (t) => {
  const { tempHome, write } = setup(t);
  write({ permissions: { allow: ['Bash(git status *)'] } });
  const app = harness(tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    assert.equal(ui.posted.length, 1, 'one debounced push, so the count below is per-push');
    assert.equal(app.memoryReports.count, 1,
      'the Memory card and the Gates card must share one report, not take one each');

    // Both card keys are PRESENT AND NOT NULL. `'memory' in data` was the first
    // version and it is satisfied by `memory: null` — which is what
    // memoryCardData returns whenever its report is unusable, so the assertion
    // passed for the failure it was meant to exclude. And the mutation its
    // comment claimed to catch ("threaded into only one card") is impossible:
    // both builders default to a fresh memoryReport(), so a card that lost its
    // argument pushes the count above to 2 and is killed there instead.
    const data = ui.posted[0];
    assert.notEqual(data.gates, null, 'the gates card was built, not collapsed to null');
    assert.equal(typeof data.gates.count, 'number', 'and carries a real gate count');
    // memory is legitimately null under this harness (memoryReport is stubbed to
    // report no corpus), so assert the KEY exists and the stub shape reached it
    // rather than pretending a value is there.
    assert.ok('memory' in data, 'the memory card key is present');

    // A second push recomputes: the corpus can change between renders, so the
    // report is per-push and must NOT be memoised across pushes.
    app.provider.refresh();
    await settle();
    assert.equal(ui.posted.length, 2);
    assert.equal(app.memoryReports.count, 2,
      'per-push, not cached forever — a corpus edit between renders must be seen');
  } finally {
    await app.dispose();
  }
});

// Two hero-card facts, both of which were wrong or absent in a shipped build.
//
// The gate count read `text.match(/^- \*\*/gm)`, assuming every compiled gate
// opens with a bold lead-in. True of the pre-2026-09-09 corpus and of nothing
// since — so with five gates installed the card rendered "0 active" directly
// beside an ON state. The authoritative count is in the header recall.py writes.
// The identical regex shipped in scripts/verify-release.ps1 and reported
// "0 gate(s)" for the same file, so this is a defect that occurred twice.
//
// The version was not shown at all, which is what makes "is my fix actually
// installed" cost a trip to the Extensions view. That question came up repeatedly
// while this project was being built.
test('the hero card reports the running version and a gate count that does not depend on prose', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });

  // A compiled gates file whose bullets are PLAIN, i.e. the shape the current
  // compiler emits. Under the old regex this counts as zero.
  const gatesFile = path.join(env.tempHome, '.claude', 'gates.generated.md');
  // The header count and the bullet count DISAGREE here, deliberately: two
  // memories, five top-level bullets. recall.py's header is `len(blocks)`, i.e.
  // memories, while each gate body is arbitrary user text between the markers —
  // so a gate written as a multi-item list produces exactly this shape.
  //
  // The first version of this fixture had three bullets under a "(3 memories)"
  // header, so the header parse and the bullet fallback both answered 3 and
  // deleting the header parse — the entire headline fix — still passed. Its
  // comment defended that by claiming a disagreement was output "the compiler
  // cannot produce", which is false: nothing constrains a gate body to one
  // bullet, and the original bug (a regex reading 0 over five real gates) is
  // itself proof that gate bodies vary in shape.
  fs.writeFileSync(gatesFile,
    '<!-- generated by recall.py --gates-compile; sha deadbeefdeadbeef -->\n'
    + '## Standing gates (2 memories, managed)\n\n'
    + '- first standing order, no bold anywhere\n'
    + '  - a nested point under it\n'
    + '- second standing order, itself a list:\n'
    + '- one item\n'
    + '- another item\n');

  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const data = ui.posted[0];
    assert.equal(data.gates.count, 2,
      'counted from the header (2 memories), NOT from the 4 top-level bullets — '
      + 'which is what separates the fix from its own fallback');
    // Mutation-checked three ways: restoring `/^- \*\*/gm` fails with 0,
    // deleting the header parse fails with the bullet count, and dropping the
    // fallback is still covered by the headerless case a legacy file gives.

    // The version comes from the manifest beside extension.js, which resolves both
    // in the repo and inside the packaged VSIX.
    const expected = require('../vscode-extension/package.json').version;
    assert.equal(data.version, expected, 'the payload carries the running version');
    assert.match(data.version, /^\d+\.\d+\.\d+$/, 'and it is a real semver, not a placeholder');
  } finally {
    await app.dispose();
  }
});


test('an already-optimal list takes no policy lock at all', async (t) => {
  // The lock used to be taken BEFORE anything was known: the read, the pass and
  // the no-op comparison were all inside it. So every settings.json change paid
  // a full lock cycle to discover there was nothing to do.
  //
  // The cycle is 3.4-3.7 ms (46% of it one fsyncSync), but the milliseconds are
  // the smaller half. The real cost was CONTENTION: Auto Learn takes this same
  // lock, is on by default, scans every 5 minutes plus a 20-second debounce on
  // the highest-frequency watcher in the extension, and its scan() holds the lock
  // across the entire transcript corpus read. runWildcarding's own 20-deep
  // retry budget with a 1500 ms backoff is the evidence that race was observed.
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });   // already a fixed point
  const app = harness(env.tempHome);
  try {
    const before = app.locks.count;
    await app.commands.get('permission-wildcarding.runNow')();
    await settle();

    assert.equal(app.locks.count - before, 0,
      'the unchanged path still takes the lock, so it can still lose the race with Auto Learn');
    // And the work still happened: the backup is refreshed on this path, which is
    // the only thing that rebuilds a DELETED backup.
    assert.deepEqual(env.read().permissions.allow, FIFTEEN, 'nothing was rewritten');
  } finally {
    await app.dispose();
  }
});

test('a write that is due DOES take the lock', async (t) => {
  // The other half, so the test above cannot pass by the lock never being taken
  // at all. Without this, deleting the entire getPolicyLock().locked(...) call
  // would leave the suite green.
  const env = setup(t);
  // Seed an already-optimal list so ACTIVATION is quiet, then make work due
  // afterwards. Seeding the ungeneralized list instead lets activate()'s own
  // runWildcarding do the generalizing, and runNow then correctly finds nothing
  // to do -- which is how the first version of this test failed.
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    await settle();
    env.write({ permissions: { allow: ['Bash(git status)', 'Bash(git status --short)'], deny: [] } });
    const before = app.locks.count;
    await app.commands.get('permission-wildcarding.runNow')();
    await settle();

    assert.ok(app.locks.count - before >= 1, 'a write must be performed under the lock');
    assert.ok(env.read().permissions.allow.includes('Bash(git status *)'), 'and it generalized');
  } finally {
    await app.dispose();
  }
});

test('a concurrent write inside the lock is not flattened by a stale delta', async (t) => {
  // THE test for this change, and the reason the probe's snapshot must be thrown
  // away rather than handed to writeAllow.
  //
  // writeAllow replays a delta computed against the CALLER's snapshot onto a
  // fresh read. Its own note (src/settings-write.js:166-172) says that is "WRONG
  // for one whose whole output is a function of the list it read", and names the
  // wildcarding pass as exactly that caller. Until the probe moved out of the
  // lock, runWildcarding satisfied that precondition only BY ACCIDENT, because
  // its read happened to sit inside the lock.
  //
  // The shape that actually loses data — my first attempt at this test injected an
  // UNRELATED entry, which survives a stale replay fine, and the mutant lived. The
  // entry has to be one the probe's pass derived from a specific entry while a
  // concurrent writer legitimately changes that specific entry. Replaying the
  // stale delta can otherwise revoke an approval neither writer meant to remove.
  //
  // FIXTURE CORRECTED. My first choice of inputs killed the mutants that revert
  // the in-lock RECOMPUTE, but not the one that reverts only the SNAPSHOT
  // ARGUMENT — `writeAllow(settings, lockedAfter)`, i.e. exactly reinstating the
  // bug this test names. Two independent audits found that hole. With the old
  // inputs the stale and correct replays coincide, so the test was green either
  // way; a search over the interleaving space with the real processAllowList
  // found 4140 inputs where they diverge.
  //
  // What the shape has to satisfy: an entry the IN-LOCK pass derives that was
  // already in the probe's read and is absent from the concurrent write's read.
  // It lands in neither `removed` nor `added`, so the stale replay drops it.
  //
  // Measured against the real functions:
  //   probe    ['Bash(git status *)', 'Bash(git status)']
  //   latest   ['Bash(git status)', 'Bash(git diff)']   (concurrent write)
  //   correct  ['Bash(git status *)', 'Bash(git diff *)']
  //   stale    ['Bash(git diff)', 'Bash(git diff *)']   <-- Bash(git status *)
  //            is dropped, and Bash(git status) ends up neither present nor
  //            covered: an approval silently revoked.
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });   // quiet activation
  const app = harness(env.tempHome);
  try {
    await settle();
    env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(git status)'], deny: [] } });

    let injected = false;
    app.locks.insideLock = () => {
      if (injected) return;
      injected = true;
      // A concurrent write lands while we hold the lock: the wildcard entry is
      // gone and an unrelated one has arrived.
      fs.writeFileSync(env.settingsPath, JSON.stringify(
        { permissions: { allow: ['Bash(git status)', 'Bash(git diff)'], deny: [] } }, null, 2) + '\n');
    };

    await app.commands.get('permission-wildcarding.runNow')();
    await settle();

    assert.ok(injected, 'precondition: the lock was taken, so the injection ran');
    const allow = env.read().permissions.allow;
    assert.ok(allow.includes('Bash(git status *)'),
      'the write replayed the probe\u2019s stale delta onto the fresh read, dropping an '
      + 'entry that was in neither `removed` nor `added` — Bash(git status) is now '
      + 'neither present nor covered, i.e. an approval silently revoked');
    assert.deepEqual(allow.slice().sort(), ['Bash(git diff *)', 'Bash(git status *)'],
      'the guarded work must recompute from the read taken INSIDE the lock');
  } finally {
    await app.dispose();
  }
});

test('a view that is alive but not visible gets no push and no work-up', async (t) => {
  // The gap `!this.view` does not close. A WebviewView is disposed when hidden
  // (the manifest has no retainContextWhenHidden) and onDidDispose nulls
  // `this.view`, so a CLOSED sidebar was already handled. But a view collapsed
  // within a showing container stays alive and merely turns invisible, and there
  // is a window between a hide and its disposal event being delivered. In both,
  // the whole synchronous work-up ran — processAllowList, a MEMORY.md read per
  // discovered store, a dry-run drain per workspace folder — and then posted to a
  // webview whose content was already gone.
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    assert.equal(ui.posted.length, 1, 'precondition: a visible view is pushed to');

    // Collapsed, not disposed: `this.view` still points at it.
    ui.view.visible = false;
    const posts = ui.posted.length;
    const passes = app.passes.count;
    app.provider.refresh();
    await settle();

    assert.equal(ui.posted.length, posts, 'nothing is posted to an invisible webview');
    assert.equal(app.passes.count, passes,
      'the work-up is skipped entirely, not just the post');

    // And becoming visible again re-pushes, via the onDidChangeVisibility handler
    // resolveWebviewView already installs — which is why no dirty flag is needed.
    ui.view.visible = true;
    ui.on.visibility();
    await settle();
    assert.ok(ui.posted.length > posts, 'showing the view again pushes fresh state');
  } finally {
    await app.dispose();
  }
});

// ── runWildcarding: five branches nothing was holding ─────────────────────────
//
// All five are CORRECT at HEAD. Each was found by mutating it and watching the
// whole suite stay green, which is the only way a branch with no test is
// distinguishable from one with a passing test.

const NON_OPTIMAL = ['Bash(git status)', 'Bash(git status --short)'];   // -> Bash(git status *)
const OTHER_NON_OPTIMAL = ['Bash(git diff)', 'Bash(git diff --stat)', 'Bash(git diff --cached)'];

test('a backup deleted under us is rebuilt when someone else generalized the list first',
  async (t) => {
    // The post-lock already-optimal path, reached when another writer generalizes
    // between the unlocked probe and the lock. It calls the same
    // reportAlreadyOptimal as the probe's early return, and that call is the ONLY
    // thing in this extension that rebuilds a DELETED backup — not hypothetical:
    // on 2026-09-09 every directory under ~/.claude was recreated and this is
    // what restored the mirror.
    //
    // Replacing the branch with `if (false)` left the suite green. Nothing wrote
    // to the backup on this path, and nothing looked.
    const env = setup(t);
    env.write({ permissions: { allow: FIFTEEN, deny: [] } });   // quiet activation
    const app = harness(env.tempHome);
    try {
      await settle();
      const backupPath = path.join(env.tempHome, '.claude', 'backups', 'allow-list.latest.json');
      assert.ok(fs.existsSync(backupPath), 'precondition: activation captured a backup');

      // The wipe this path exists to recover from. BOTH copies: the backup is a
      // high-water-mark union and readBackupRaw falls back to the off-tree
      // mirror, so leaving the mirror in place makes the rebuilt file hold
      // yesterday's list too and the assertion below reads the wrong thing.
      fs.rmSync(path.join(env.tempHome, '.claude', 'backups'), { recursive: true, force: true });
      fs.rmSync(path.join(env.tempHome, '.permission-wildcarding'), { recursive: true, force: true });
      env.write({ permissions: { allow: NON_OPTIMAL, deny: [] } });

      // Somebody else generalizes it while we are waiting for the lock, so the
      // in-lock read finds a fixed point and no write is due after all.
      let injected = false;
      app.locks.insideLock = () => {
        if (injected) return;
        injected = true;
        fs.writeFileSync(env.settingsPath, JSON.stringify(
          { permissions: { allow: ['Bash(git status *)'], deny: [] } }, null, 2) + '\n');
      };

      await app.commands.get('permission-wildcarding.runNow')();
      await settle();

      assert.ok(injected, 'precondition: the lock was taken, so the race was actually run');
      assert.ok(fs.existsSync(backupPath),
        'the post-lock already-optimal path did not rebuild the backup, which is the one '
        + 'property it exists for');
      assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, 'utf8')).allow,
        ['Bash(git status *)'],
        'the rebuilt backup must hold what the LOCKED read saw, not the probe’s stale list');
    } finally {
      await app.dispose();
    }
  });

test('the change toast counts what the locked read changed, not what the probe guessed',
  async (t) => {
    // The probe's snapshot is discarded and everything recomputed inside the lock,
    // precisely because another writer can land in between. The report has to come
    // from the same read the write rebased onto, or it describes a change that
    // never happened.
    //
    // Reverting the two filters to the probe's `before`/`after` left the suite
    // green: no test made the two reads differ while both were still non-optimal.
    const env = setup(t);
    env.write({ permissions: { allow: FIFTEEN, deny: [] } });
    const app = harness(env.tempHome);
    try {
      await settle();
      env.write({ permissions: { allow: NON_OPTIMAL, deny: [] } });   // probe: +1 -2

      let injected = false;
      app.locks.insideLock = () => {
        if (injected) return;
        injected = true;
        // A different, also-ungeneralized list: +1 -3 rather than +1 -2.
        fs.writeFileSync(env.settingsPath, JSON.stringify(
          { permissions: { allow: OTHER_NON_OPTIMAL, deny: [] } }, null, 2) + '\n');
      };

      app.shown.length = 0;
      await app.commands.get('permission-wildcarding.runNow')();
      await settle();

      assert.ok(injected, 'precondition: the lock was taken, so the race was actually run');
      assert.deepEqual(env.read().permissions.allow, ['Bash(git diff *)'],
        'precondition: the write rebased onto the concurrent list, not the probe’s');
      const toast = app.shown.find((entry) => /wildcarded/.test(entry.message));
      assert.ok(toast, `no change was announced: ${JSON.stringify(app.shown)}`);
      assert.match(toast.message, /pruned 3/,
        `the toast reported the probe’s delta, describing a change that never happened: `
        + `"${toast.message}"`);
    } finally {
      await app.dispose();
    }
  });

test('a write under the lock records when it happened', async (t) => {
  // `lastRun` is the dashboard's "last wildcarded" line. Deleting the assignment
  // left the suite green, and the panel then said nothing had ever run.
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    assert.equal(ui.posted.at(-1).lastRun, null,
      'precondition: an optimal list writes nothing, so nothing has stamped lastRun yet — '
      + 'without this the assertion below could be satisfied by any earlier write');

    env.write({ permissions: { allow: NON_OPTIMAL, deny: [] } });
    await app.commands.get('permission-wildcarding.runNow')();
    await settle();

    assert.deepEqual(env.read().permissions.allow, ['Bash(git status *)'],
      'precondition: a write really happened');
    assert.equal(typeof ui.posted.at(-1).lastRun, 'number',
      'the panel cannot say when the list was last wildcarded, because the write did not '
      + 'record it');
  } finally {
    await app.dispose();
  }
});

test('an unreadable settings.json is never reported as "already optimal"', async (t) => {
  // The probe's `if (!settings)` guard. Delete it and `before` collapses to `[]`,
  // `after` is `[]` too, the lists compare equal — and a manual run cheerfully
  // tells the user their policy is already optimal when the extension could not
  // read it at all. Claude Code rewrites settings.json in place on every
  // approval, /model and /effort, so landing inside a write is routine.
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    await settle();
    app.statuses.length = 0;
    app.arm(['corrupt']);
    await app.commands.get('permission-wildcarding.runNow')();

    assert.equal(app.armsLeft(), 0,
      'precondition: the scripted half-written read was never taken, so this test is '
      + 'asserting against an ordinary successful read');
    assert.deepEqual(app.statuses.filter((m) => /already optimal/.test(m)), [],
      'a settings.json the extension could not read was reported to the user as an '
      + 'already-optimal policy');
  } finally {
    await app.dispose();
  }
});

// The retry budget. `lockedRetries` is module-private and its only effect is
// whether a contended run schedules another attempt, so the observable is the
// 1500 ms backoff timer. Both early returns reset it, and deleting EITHER left
// the suite green: 20 contended runs in one window then permanently disabled the
// retry, so a settings.json change that lost the race with an Auto Learn scan was
// simply never re-attempted.
async function exhaustRetryBudget(app, env) {
  app.locks.contended = true;
  env.write({ permissions: { allow: NON_OPTIMAL, deny: [] } });
  for (let i = 0; i < 20; i += 1) await app.commands.get('permission-wildcarding.runNow')();
  assert.equal(app.retriesScheduled(), 20,
    `precondition: the budget is 20 and was spent, got ${app.retriesScheduled()}`);
  await app.commands.get('permission-wildcarding.runNow')();
  assert.equal(app.retriesScheduled(), 20,
    'precondition: a 21st contended run must schedule nothing, or the budget is not spent '
    + 'and the resets below prove nothing');
}

test('an already-optimal run gives the lock-contention budget back', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    await settle();
    await exhaustRetryBudget(app, env);

    // The reset under test: the probe finds a fixed point and returns before the
    // lock, so the window of contention it was spending budget on is over.
    env.write({ permissions: { allow: FIFTEEN, deny: [] } });
    await app.commands.get('permission-wildcarding.runNow')();

    env.write({ permissions: { allow: NON_OPTIMAL, deny: [] } });
    await app.commands.get('permission-wildcarding.runNow')();
    assert.equal(app.retriesScheduled(), 21,
      'the budget was never given back, so every later contended write is abandoned for the '
      + 'life of the window');
  } finally {
    app.locks.contended = false;
    await app.dispose();
  }
});

test('an unreadable settings.json gives the lock-contention budget back', async (t) => {
  // The second site, and the one its own commit message got wrong: "the budget is
  // now also reset on the early return" was true for the already-optimal return
  // and not for this one until it was added. An absent or half-written
  // settings.json is the routine case, not the exotic one.
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    await settle();
    await exhaustRetryBudget(app, env);

    app.arm(['corrupt']);
    await app.commands.get('permission-wildcarding.runNow')();
    assert.equal(app.armsLeft(), 0, 'precondition: the half-written read was taken');

    env.write({ permissions: { allow: NON_OPTIMAL, deny: [] } });
    await app.commands.get('permission-wildcarding.runNow')();
    assert.equal(app.retriesScheduled(), 21,
      'a settings.json that was mid-write when we looked left the retry budget spent, so '
      + 'every later contended write is abandoned for the life of the window');
  } finally {
    app.locks.contended = false;
    await app.dispose();
  }
});

// ── what the last scan could not read ─────────────────────────────────────────
//
// autoLearnCardData copied eleven fields out of the manager's status and not one
// of them was `lastScanStats`, so `errors`, `partial`, `unmatchedResults`,
// `blindScan` and the four prune counters existed in the state file, were printed
// in full by `wildcard-perms --learn scan`, and appeared nowhere in the panel
// that is the only UI most users of this extension ever open.
//
// `error` on the card is not the same thing: it is the message of an EXCEPTION
// that escaped. A scan that returns while failing to read half the corpus leaves
// it null, so the card read perfectly healthy. That is exactly the shape of the
// defect src/auto-learn-manager.js:1904-1906 records — a file that failed every
// scan for eight days, invisible because a computed number was not passed on.

// Writes the manager's state file wherever the manager would look for it, which
// depends on a hash of the workspace root. Required lazily and INSIDE the
// harness's Module._load hook rather than at the top of this file, so the copy it
// resolves is the one the extension is already using, bound to the mocked `os`.
function seedAutoLearnState(tempHome, lastScanStats) {
  // eslint-disable-next-line global-require
  const { createAutoLearnManager } = require('../src/auto-learn-manager');
  const statePath = createAutoLearnManager({
    home: tempHome,
    workspaceRoot: path.join(tempHome, 'workspace'),
  }).status().paths.state;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1, sourceVersion: 1, mode: 'recommend', threshold: 3,
    candidates: {}, observationHashes: {}, cursors: {},
    applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, managedHits: {}, managedHitsAt: null,
    derivedGuidance: { accepted: [], declined: [] }, prunedCandidates: {},
    lastScanAt: Date.now(), lastScanStats, lastApplication: null,
  }, null, 2) + '\n');
  return statePath;
}

test('the dashboard reports what the last scan could not read', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, {
      files: 12, observations: 40, errors: 3, partial: 1, unmatchedResults: 7,
      prunedObservations: 2, prunedCursors: 1, prunedCandidates: 0, prunedGrants: 4,
      blindScan: false,
    });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const scan = ui.posted.at(-1).autoLearn.scan;
    assert.ok(scan, 'the payload carries no per-scan health at all, so the panel cannot '
      + 'show a scan that failed to read files');
    assert.equal(scan.errors, 3, 'the unreadable-file count never reached the panel');
    assert.equal(scan.partial, 1, 'the partly-read count never reached the panel');
    assert.equal(scan.unmatchedResults, 7);
    assert.equal(scan.blindScan, false);
    assert.equal(scan.files, 12);
    // Four counters, one number: the card has no room for four tiles and they are
    // one housekeeping fact from its point of view.
    assert.equal(scan.pruned, 7, 'the prune counters were dropped rather than summed');
    // And the thing that made this invisible in the first place: the exception
    // channel says nothing about a scan that RETURNED.
    assert.equal(ui.posted.at(-1).autoLearn.error, null,
      'precondition: no exception escaped, so `error` cannot be the field that carries this');
  } finally {
    await app.dispose();
  }
});

test('a blind scan is reported even though every count reads clean', async (t) => {
  // The nastiest case, and the reason blindScan exists as its own flag: zero
  // errors, zero partials, zero observations — numerically identical to a quiet
  // scan of a corpus with nothing new in it. The only difference is that nothing
  // was enumerated at all.
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, {
      files: 0, observations: 0, errors: 0, partial: 0, unmatchedResults: 0,
      prunedObservations: 0, prunedCursors: 0, prunedCandidates: 0, prunedGrants: 0,
      blindScan: true,
    });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const data = ui.posted.at(-1);
    assert.equal(data.autoLearn.scan.blindScan, true,
      'a scan that enumerated nothing is indistinguishable from a quiet one on the numbers, '
      + 'and the flag that separates them did not reach the panel');

    // The renderer half, run for real rather than assumed: the panel document is
    // the only place the payload becomes something a user can see, and a field
    // that arrives and is never drawn is still invisible.
    const rendered = renderDashboard(app.provider, data);
    assert.match(rendered.alScanHealth, /nothing enumerated/,
      `the card body said "${rendered.alScanHealth}"`);
    assert.equal(rendered.stAutoLearn, 'scan degraded',
      `the collapsed row said "${rendered.stAutoLearn}", so a user who has not expanded the `
      + 'card sees nothing wrong');
  } finally {
    await app.dispose();
  }
});

test('a clean scan says so rather than going quiet', async (t) => {
  // The other side, and the one that keeps the warning meaningful: if the line
  // only ever appears when something is wrong, its absence is ambiguous between
  // "clean" and "never scanned".
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, {
      files: 9, observations: 21, errors: 0, partial: 0, unmatchedResults: 0,
      prunedObservations: 0, prunedCursors: 0, prunedCandidates: 0, prunedGrants: 0,
      blindScan: false,
    });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const data = ui.posted.at(-1);
    const rendered = renderDashboard(app.provider, data);
    assert.match(rendered.alScanHealth, /read 9 files cleanly/,
      `the card body said "${rendered.alScanHealth}"`);
    assert.notEqual(rendered.stAutoLearn, 'scan degraded',
      'a clean scan was badged as degraded');
  } finally {
    await app.dispose();
  }
});

// Runs the panel's OWN script against the payload, in a DOM small enough to be
// read in one screen. Without this the renderer is unreachable: _html() returns a
// string, VS Code evaluates it, and nothing in this suite ever did — so a field
// added to the payload and never drawn would pass every assertion above.
//
// Only the ids the Auto Learn card touches are stubbed. An element the renderer
// reaches for and does not find shows up here as a TypeError naming the id,
// which is the failure mode wanted: silently ignoring unknown ids would let the
// renderer be rewritten out from under the test.
function renderDashboard(provider, data) {
  // The tag carries a per-render nonce, so it is matched rather than searched for
  // literally. One <script> in the document today; the assertion below is what
  // notices if that stops being true.
  const html = provider._html();
  const open = html.match(/<script\b[^>]*>/);
  assert.ok(open, 'the panel document has no script element');
  const start = open.index + open[0].length;
  const script = html.slice(start, html.indexOf('</script>', start));
  assert.ok(script.includes('function renderAutoLearn'),
    'the panel script was not extracted — this test would prove nothing');

  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        id, textContent: '', className: '', title: '', disabled: false,
        innerHTML: '', style: {}, hidden: false, value: '',
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
          contains: (name) => classes.has(name),
        },
        addEventListener() {}, appendChild() {}, removeChild() {},
        querySelector: () => null, querySelectorAll: () => [],
      });
    }
    return nodes.get(id);
  };
  const detached = (tag) => ({
    tag, className: '', textContent: '', innerHTML: '', title: '', style: {},
    dataset: {}, children: [],
    addEventListener() {}, appendChild(child) { this.children.push(child); return child; },
  });
  const document = {
    getElementById: (id) => node(id),
    querySelectorAll: () => [],
    createElement: detached,
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
  };
  const window = { addEventListener() {} };
  const acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });

  // eslint-disable-next-line no-new-func
  const run = new Function('document', 'window', 'acquireVsCodeApi', 'console',
    `${script}\nreturn { render };`);
  const api = run(document, window, acquireVsCodeApi, console);
  api.render(data);
  const text = (id) => node(id).textContent;
  return { alScanHealth: text('alScanHealth'), stAutoLearn: text('stAutoLearn'), node };
}
