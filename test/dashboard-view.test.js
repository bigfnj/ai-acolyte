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

// The Codex executable every harness here is configured with unless a test names
// one: a name nothing resolves (2026-10-14). The default `codex` resolved on PATH
// on any machine with Codex installed, so every push with a Codex home spawned the
// real `codex --version`, and since the probe now pushes once when it lands, that
// push would arrive at a moment no test chose.
const NO_CODEX = 'acolyte-no-such-codex-dashboard';

// Captured at module load, BEFORE any harness installs its unref'ing override of
// global.setTimeout. Without this, `settle()` schedules through that override, its
// timer is unref'd, and nothing is left holding the event loop open while a test
// awaits it. Node then drains and node:test reports every test in the file as
// "Promise resolution is still pending but the event loop has already resolved".
//
// It reproduced only on CI. Node 24 kept the loop alive on other pending work and
// the whole file passed locally; node 20 and 22 failed all 30 tests on both
// platforms. Unref is right for the timers the EXTENSION arms and wrong for the
// ones the test arms to wait on, which is the distinction this line draws.
const realSetTimeout = global.setTimeout;

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
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

// Copied from test/policy-backup.test.js rather than shared. That is a standing
// decision in this suite (test/extension-activation.test.js:505#sharing: "Kept as its
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
  const executedArgs = [];
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
      executeCommand(id, ...args) { executed.push(id); executedArgs.push({ id, args }); },
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
      // `opts.isTrusted` and `opts.workspaceFolders` override the one trusted folder
      // every other test runs in. Both were hard-coded, so the Project-local card was
      // only ever rendered for a single trusted folder, which is the one shape whose
      // subtitle named its file and whose counts the drain could act on.
      isTrusted: opts.isTrusted ?? true,
      workspaceFolders: opts.workspaceFolders ?? [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
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
            if (key === 'autoLearn.codexExecutable') return NO_CODEX;
            return key === 'autoLearn.enabled' ? false : fallback;
          },
          // The Codex executable answers on this door too, so the value is the same
          // whichever one the extension reads it through.
          inspect: (key) => (key === 'autoLearn.codexExecutable'
            ? { globalValue: opts.settings && key in opts.settings ? opts.settings[key] : NO_CODEX } : {}),
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
  const originalHomeEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: tempHome, USERPROFILE: tempHome, CODEX_HOME: path.join(tempHome, '.codex') });
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
    // Count only pushes driven by this fixture. The native gate controller's
    // startup refresh and watchers are covered in codex-memory-gates-ui.test.js.
    if (request === './codexMemoryGatesUi' && parent?.filename === extensionPath) {
      return { createCodexMemoryGatesUi: () => ({
        activate() {}, dispose() {}, review() {}, status() { return {}; },
      }) };
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
        // Only when a test supplies it: without it gatesCardData's census throws inside its
        // own try and the card carries `otherStores: null`, as on a census failure.
        ...(opts.otherStoreGates ? { otherStoreGates: opts.otherStoreGates } : {}),
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
  // autoLearnWorkerRunner.js are real requires from it (extension.js:65#autoLearnUi,
  // extension.js:10#createAutoLearnWorkerRunner), so leaving them cached leaves a second
  // harness holding the first one's instances.
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
    executedArgs,
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
      for (const [key, value] of Object.entries(originalHomeEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
    assert.equal(data.settingsState, 'present');
    assert.equal(data.total, 1);
    assert.deepEqual(data.savedPermissions, [
      { agent: 'claude', label: 'Bash(git status *)', value: 'Bash(git status *)' },
    ]);
    assert.equal(data.wildcardCount, 1);
    assert.equal(data.specificCount, 0);
    // The two helpers that need real bytes on disk; the other thirteen collapse
    // to null/0 under this harness, which is why it can stay this small.
    assert.equal(data.backupCount, 1, 'activation captured the live list into the backup');
    assert.ok(data.settingsPath.endsWith(path.join('.claude', 'settings.json')));

    // EVERY TOP-LEVEL FIELD HAS A READER in the webview script (2026-10-14). The
    // payload had grown five that nothing rendered -- `active`, `wildcards` (every
    // wildcard, sorted, each push), `pendingWildcard` (a quadratic processAllowList
    // per push), and inside the cards `memory.canRebuild` (fs probes per push) and
    // `local.folders`/`local.lastRun` -- because a field nobody reads fails nothing.
    // The render reads the payload as `d`, so a top-level key with no `d.<key>` in
    // the script is one no pixel depends on.
    // MUTATION: put `active: settingsState === 'present',` back in the payload. This
    // fails naming `active`. Confirmed 2026-10-14.
    const script = ui.view.webview.html.slice(ui.view.webview.html.indexOf('<script nonce='));
    const unread = Object.keys(data).filter((key) => key !== 'type'
      && !new RegExp(String.raw`\bd\.${key}\b|\bd\?\.${key}\b`).test(script));
    assert.deepEqual(unread, [], `payload fields the webview never reads: ${unread.join(', ')}`);
    // The Auto Learn card under the same rule (renderAutoLearn reads it as `a`):
    // `lastScanAt` and `lastApplyAt` were posted on every push and read by nothing.
    // MUTATION: put `lastScanAt: status.lastScanAt || null,` back in
    // autoLearnCardData. This fails naming it. Confirmed 2026-10-14.
    assert.ok(data.autoLearn && Object.keys(data.autoLearn).length > 5, 'precondition: the card was posted');
    const unreadCard = Object.keys(data.autoLearn).filter((key) => !new RegExp(String.raw`\ba\.${key}\b`).test(script));
    assert.deepEqual(unreadCard, [], `Auto Learn card fields the webview never reads: ${unreadCard.join(', ')}`);
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
      ['optimizePermissions', 'permission-wildcarding.optimizePermissions'],
      ['viewPermissions', 'permission-wildcarding.viewPermissions'],
      ['restorePermissions', 'permission-wildcarding.restorePermissions'],
      ['importPermissions', 'permission-wildcarding.importPermissions'],
      ['autoLearnScan', 'permission-wildcarding.autoLearnScan'],
      ['autoLearnReview', 'permission-wildcarding.autoLearnReview'],
      ['autoLearnUndo', 'permission-wildcarding.autoLearnUndo'],
      ['autoLearnWhy', 'permission-wildcarding.autoLearnWhy'],
      // The Auto Learn card's Turn on / Turn off (2026-10-19).
      ['toggleAutoLearn', 'permission-wildcarding.toggleAutoLearn'],
      ['rebuildRecall', 'permission-wildcarding.rebuildRecall'],
      ['lintMemory', 'permission-wildcarding.lintMemory'],
      ['drainLocal', 'permission-wildcarding.drainLocal'],
      ['toggleGuidance', 'permission-wildcarding.toggleGuidance'],
      ['toggleGates', 'permission-wildcarding.toggleGates'],
      ['manageGates', 'permission-wildcarding.manageGates'],
      // showWildcards left with its switch arm on 2026-10-14 (no sender since c09daab):
      // the reverse census at the bottom of this test is what would have caught it.
      ['codexHook', 'permission-wildcarding.codexHook'],
      ['reviewCodexMcp', 'permission-wildcarding.reviewCodexMcp'],
      ['searchCodexMemory', 'permission-wildcarding.searchCodexMemory'],
      ['rebuildCodexMemory', 'permission-wildcarding.rebuildCodexMemory'],
      ['codexMemoryGates', 'permission-wildcarding.codexMemoryGates'],
      ['inspectCodexMemory', 'permission-wildcarding.inspectCodexMemory'],
      // The rule-use line's click when it has nothing to review (2026-10-16).
      ['countRuleUse', 'permission-wildcarding.countRuleUse'],
      // The Claude memory card's Search and Inspect, matching the Codex card's (2026-10-19).
      ['searchClaudeMemory', 'permission-wildcarding.searchClaudeMemory'],
      ['inspectClaudeMemory', 'permission-wildcarding.inspectClaudeMemory'],
    ];
    for (const [type, command] of routes) {
      app.executed.length = 0;
      ui.on.message({ type });
      assert.deepEqual(app.executed, [command], `${type} routes to ${command}`);
    }

    const selection = { agent: 'codex', path: path.join(env.tempHome, '.codex', 'rules', 'user.rules'),
      pattern: ['git', 'status'], start: 0 };
    ui.on.message({ type: 'viewPermissions', selection });
    assert.deepEqual(app.executedArgs.at(-1), {
      id: 'permission-wildcarding.viewPermissions', args: [selection],
    }, 'a Codex sidebar row reaches the shared picker with its native rule identity');

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

    // THE REVERSE DIRECTION (2026-10-14): every arm needs a SENDER in the webview
    // script. The census above reconciles the switch against this file's own table,
    // and posting each type directly cannot tell a live route from a dead one, so
    // `showWildcards` outlived its button by two weeks (c09daab removed the sender)
    // and autoLearnApply/autoLearnMode before it by three audits. A sender is a
    // `postMessage({ type: '<label>'` in the panel's script; `refresh` is posted by
    // the script itself on load, and `remove` by the per-row prune button.
    // MUTATION: restore `case 'showWildcards': ...` and its row above. This fails
    // naming showWildcards. Confirmed 2026-10-14.
    const panelScript = source.slice(source.indexOf('<script nonce='));
    const senders = new Set((panelScript.match(/postMessage\(\{\s*type:\s*'([^']*)'/g) || [])
      .map((hit) => hit.slice(hit.indexOf("'") + 1, hit.lastIndexOf("'"))));
    assert.ok(senders.size > 10, `precondition: the sender scan found only ${senders.size} senders`);
    const unsent = labels.filter((label) => !senders.has(label));
    assert.deepEqual(unsent, [], `dashboard routes with no sender in the webview: ${unsent.join(', ')}`);

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

test('shared permissions count includes both agents without counting Codex restrictions as approvals', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git *)', 'Edit'], deny: ['Bash(rm *)'] } });
  const rules = path.join(env.tempHome, '.codex', 'rules');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'user.rules'), [
    'prefix_rule(pattern=["git", "status"], decision="allow")',
    'prefix_rule(pattern=["rg"], decision="allow")',
    'prefix_rule(pattern=["git", "push"], decision="prompt")',
    'prefix_rule(pattern=["rm"], decision="forbidden")', '',
  ].join('\n'));
  const app = harness(env.tempHome, { settings: { 'autoLearn.codexScope': 'off' } });
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = ui.posted.at(-1);
    assert.equal(data.total, 2);
    assert.equal(data.codexPermissions.allow, 2, 'inventory remains visible while Codex auto-export is off');
    assert.deepEqual(data.savedPermissions.filter((entry) => entry.agent === 'claude').map((entry) => entry.value).sort(),
      ['Bash(git *)', 'Edit'], 'the shared list includes specific Claude permissions as well as wildcards');
    assert.deepEqual(data.savedPermissions.filter((entry) => entry.agent === 'codex').map((entry) => entry.pattern),
      [['git', 'status'], ['rg']], 'prompt and forbidden rules do not become saved approvals');
    const rendered = renderDashboard(app.provider, data);
    assert.equal(rendered.node('total').textContent, '4', 'WITNESS combined count must include both native stores');
    assert.equal(rendered.node('claudeTotal').textContent, '2');
    assert.equal(rendered.node('codexTotal').textContent, '2');
    assert.equal(rendered.node('permissionCoverage').textContent, '');
    assert.match(rendered.node('codexTotal').title, /1 prompt and 1 forbidden/);
  } finally { await app.dispose(); }
});

test('shared permission count shows incomplete sources instead of treating unreadable data as zero', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Edit'], deny: [] } });
  const rules = path.join(env.tempHome, '.codex', 'rules');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'user.rules'), 'prefix_rule(pattern=["git", "status"], decision="allow")\n');
  fs.writeFileSync(path.join(rules, 'computed.rules'), 'for item in commands:\n    prefix_rule(pattern=item, decision="allow")\n');
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = ui.posted.at(-1);
    const rendered = renderDashboard(app.provider, data);
    assert.equal(rendered.node('total').textContent, '2+');
    assert.equal(rendered.node('codexTotal').textContent, '1+');
    assert.equal(rendered.node('permissionCoverage').textContent, 'Codex count incomplete.',
      'WITNESS unsupported Codex data must remain visible beside the known count');
    const panel = runPanelScript(ui.view.webview.html);
    panel.deliver(data);
    assert.equal(panel.dom.byId.get('wcount').textContent, '2+ known');
    const rows = panel.dom.byId.get('list').children;
    assert.deepEqual(rows.filter((row) => row.children.length).map((row) => row.children[1].textContent).sort(),
      ['Claude', 'Codex'], 'known approvals stay visible when another Codex file is incomplete');
    assert.equal(rows.at(-1).className, 'empty');
    assert.match(rows.at(-1).textContent, /incomplete/i);
    const unknown = structuredClone(data);
    unknown.total = 0;
    unknown.settingsState = 'unreadable';
    unknown.claudePermissionsComplete = false;
    const both = renderDashboard(app.provider, unknown);
    assert.equal(both.node('total').textContent, '1+');
    assert.equal(both.node('claudeTotal').textContent, '?');
    assert.equal(both.node('permissionCoverage').textContent, 'Claude count incomplete. Codex count incomplete.');
  } finally { await app.dispose(); }
});

test('malformed Claude permission containers stay incomplete', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    for (const permissions of [42, [], null, 'invalid']) {
      env.write({ permissions });
      app.provider.refresh();
      await settle();
      const data = ui.posted.at(-1);
      assert.equal(data.claudePermissionsComplete, false,
        'WITNESS malformed permissions container cannot be a complete zero');
      const rendered = renderDashboard(app.provider, data);
      assert.equal(rendered.node('claudeTotal').textContent, '?');
      assert.match(rendered.node('permissionCoverage').textContent, /Claude count incomplete/);
    }
  } finally { await app.dispose(); }
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
    // Never resolved: refresh() must not even reach the work-up, because ~35 call
    // sites — several of them file-watcher callbacks — fire while the sidebar is
    // collapsed. Counted on memoryReport, which every push calls exactly once: the
    // push stopped running processAllowList on 2026-10-14, so the pass counter this
    // used to watch would now stay still whether or not the work-up ran.
    const before = app.memoryReports.count;
    app.provider.refresh();
    await settle();
    assert.equal(app.memoryReports.count, before, 'the whole work-up is skipped, not just the post');

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    assert.equal(ui.posted.length, 1);
    assert.equal(app.memoryReports.count, before + 1, 'precondition: the counter does count a push');

    ui.on.dispose();
    const after = app.memoryReports.count;
    app.provider.refresh();
    await settle();
    assert.equal(ui.posted.length, 1, 'postMessage is not called once the view is gone');
    assert.equal(app.memoryReports.count, after);
  } finally {
    await app.dispose();
  }
});

test('one push per burst, and the push never runs the wildcarding pass', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    // runWildcarding computes processAllowList; the refresh that follows must not
    // compute it again. Until 2026-10-14 the push ran its own pass for the
    // `pendingWildcard` badge and a hint from runWildcarding let it skip that once;
    // the badge had no reader, so the push's pass, the hint and the badge are gone.
    ui.posted.length = 0;
    let before = app.passes.count;
    await app.commands.get('permission-wildcarding.runNow')();
    await settle();
    // FIFTEEN is already fully generalized, so runNow finds a fixed point and NO
    // settings write happens: its one unlocked probe is the only pass. The write path
    // is covered by the test below, which expects a different number for a
    // documented reason.
    assert.equal(app.passes.count - before, 1,
      'one pass on the already-optimal path: the refresh must not recompute it');
    assert.equal(ui.posted.length, 1);
    assert.equal(ui.posted[0].wildcardCount, FIFTEEN.length);

    // A watcher pair (onDidChange + onDidCreate) fires together, and several
    // call sites refresh twice for one event. One push.
    ui.posted.length = 0;
    before = app.passes.count;
    for (let i = 0; i < 5; i += 1) app.provider.refresh();
    await settle();
    assert.equal(ui.posted.length, 1, 'the burst coalesces into a single push');
    // MUTATION: put `processAllowList(allow)` back in _push. This counts 1. Confirmed
    // 2026-10-14.
    assert.equal(app.passes.count - before, 0, 'a push alone runs no wildcarding pass');
  } finally {
    await app.dispose();
  }
});

// THE WRITE PATH. The test above seeds an already-optimal list, so it exercises the
// branch where runWildcarding finds a fixed point and returns without writing. On a list
// that is NOT a fixed point the pass runs TWICE, and the source says so unconditionally at
// vscode-extension/extension.js:3631#twice -- once for the unlocked probe that decides whether
// there is work, and once for the authoritative in-lock recompute the write is built from.
// Handing writeAllow the probe snapshot instead lets another writer land between the two
// and have a stale removal replayed over its state.
//
// THE SEED HAS TO HAPPEN AFTER ACTIVATION, and getting that wrong is what made the first
// version of this test measure 1. activate() schedules its own wildcarding pass, so a list
// seeded before the harness starts is ALREADY collapsed by the time runNow is called;
// runNow then finds a fixed point, takes the early return, and counts one. Worse, the
// precondition asserting a write happened still passed, because activation had written.
test('the write path runs the pass twice, and the second one is the authoritative read', async (t) => {
  const env = setup(t);
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    // Seeded NOW, after activation has had its pass. Two entries that collapse to one.
    const seed = ['Bash(git status *)', 'Bash(git status --short *)'];
    env.write({ permissions: { allow: seed, deny: [] } });
    const settingsPath = path.join(env.tempHome, '.claude', 'settings.json');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions.allow, seed,
      'precondition: the list under test is on disk and has NOT been collapsed yet');

    const before = app.passes.count;
    await app.commands.get('permission-wildcarding.runNow')();
    await settle();

    assert.deepEqual(
      JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions.allow,
      ['Bash(git status *)'],
      'precondition: THIS call is the one that collapsed the list');
    assert.equal(app.passes.count - before, 2,
      'the unlocked probe plus the authoritative in-lock recompute; reusing the probe '
      + 'result is the data-loss shape the lock exists to prevent');
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

// A real store's row read "6 files · 1 issues" (2026-10-13). Every count on the
// Codex memory card is pluralised by its own value; the control keeps the plurals.
test('the Codex memory row says 1 issue, 1 file and 1 section, and keeps plurals otherwise', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const panel = runPanelScript(ui.view.webview.html);
    const render = (files, issues, sections) => {
      panel.deliver({ ...ui.posted[0], codexMemory: { state: 'readable', files, issues,
        gates: { on: true, count: sections, current: true } } });
      return [panel.dom.byId.get('stCodexMemory').textContent, panel.dom.byId.get('codexMemoryGatesStatus').textContent];
    };
    assert.deepEqual(render(1, 1, 1), ['1 file · 1 issue', 'Native memory gates: 1 section; current.'],
      'WITNESS a single count reads singular');
    assert.deepEqual(render(6, 2, 2), ['6 files · 2 issues', 'Native memory gates: 2 sections; current.']);
    assert.deepEqual(render(0, 0, 0), ['0 files', 'Native memory gates: 0 sections; current.']);
  } finally { app.dispose(); }
});

// The Codex CLI version line (2026-10-13) is INFORMATION ONLY: a build outside the tested
// window must never colour the row or the line, or every Codex update becomes an
// always-on false alarm. Both halves are driven: the payload builder for real (an
// unresolvable configured executable, so nothing is spawned and the answer is
// deterministic), then the webview render with in- and out-of-window statuses.
test('the Codex CLI version line informs and never warns, whatever the version', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  fs.mkdirSync(path.join(env.tempHome, '.codex'), { recursive: true });
  const app = harness(env.tempHome, { settings: { 'autoLearn.codexExecutable': 'acolyte-no-such-codex-xyz' } });
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const cli = ui.posted[0].codexMemory.cli;
    assert.equal(cli.version, null, 'the payload builder asked about the configured executable');
    assert.equal(cli.executable, 'acolyte-no-such-codex-xyz');
    assert.match(cli.note, /not found/);
    assert.equal(cli.severity, 'info');
    assert.match(ui.view.webview.html, /<div class="muted sub" id="codexCliVersion"><\/div>/,
      'the line is a muted note in the Codex card');

    const panel = runPanelScript(ui.view.webview.html);
    const show = (status) => {
      panel.deliver({ ...ui.posted[0], codexMemory: { state: 'readable', files: 1, issues: 0, cli: status } });
      const line = panel.dom.byId.get('codexCliVersion');
      return { text: line.textContent, lineClass: line.className, row: panel.dom.byId.get('stCodexMemory').className };
    };
    const outside = { version: '0.170.0', inWindow: false, severity: 'info', tested: ['0.145.0', '0.154.0', '0.161.0'],
      note: 'Codex CLI 0.170.0 is newer than the newest tested version (0.161.0). Information only: nothing is disabled; newer builds have not been exercised here.' };
    const inside = { ...outside, version: '0.161.0', inWindow: true, note: 'Codex CLI 0.161.0: a tested version (window 0.145.0-0.161.0).' };
    for (const status of [outside, inside, cli]) {
      const shown = show(status);
      assert.equal(shown.text, status.note);
      assert.doesNotMatch(shown.lineClass, /warn/, `${status.version}: the line is never styled as a warning`);
      assert.equal(shown.row, 'rowstate', `${status.version}: the version never reaches the row state`);
    }
    assert.equal(panel.dom.byId.get('codexCliVersion').title, 'Tested Codex versions: 0.145.0, 0.154.0, 0.161.0');
    assert.equal(show(null).text, '', 'no status, no line');
  } finally { await app.dispose(); }
});

// The configured executable is unresolvable on purpose: without the Codex-home gate the
// builder would answer "not found" at once, so a null here is the gate and not a probe
// that simply has not finished yet.
test('a machine with no Codex home gets no Codex CLI line and no probe', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.codexExecutable': 'acolyte-no-such-codex-xyz' } });
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    assert.equal(fs.existsSync(path.join(env.tempHome, '.codex')), false, 'precondition: no Codex home');
    assert.equal(ui.posted[0].codexMemory.cli, null);
  } finally { await app.dispose(); }
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

// THE PANEL'S ORDER (1.8.1, the user's layout, 2026-10-19). Permissions stays on top, then three
// labelled groups: what is happening, what the agents read, and the permission detail. Agent
// sessions leads because the user keeps it open.
test('the rows sit in three labelled groups, in the order the user chose', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const html = ui.view.webview.html;
    const sequence = [...html.matchAll(/class="rowgroup">([^<]+)<|data-row="([^"]+)"/g)].map((m) => m[1] ? `[${m[1]}]` : m[2]);
    assert.deepEqual(sequence, ['[Activity]', 'sessions', 'autoLearn',
      '[Memory &amp; instructions]', 'memory', 'codexMemory', 'gates', 'guidance',
      '[Permissions]', 'local', 'permissionTools', 'list'],
    'witness:row-order -- the dashboard rows are not in the order the user chose');
    assert.ok(html.indexOf('class="hero"') < html.indexOf('class="rowgroup"'), 'Permissions stays at the top');
  } finally {
    await app.dispose();
  }
});

// FEATURE PARITY (2026-10-19, the user's request): the Claude memory and Codex memory cards share
// one skeleton, top to bottom: the CPU LLM line, the folder, four stats, an issues line, Search,
// Rebuild and Inspect, a gates line with its Review button, and the agent's version line.
const MEMORY_SKELETON = {
  claude: ['llmText', 'memDir', 'memTok', 'memFiles', 'memEmb', 'memLines', 'memIssues', 'searchClaudeMemory',
    'rebuild', 'inspectClaudeMemory', 'claudeMemoryGatesStatus', 'claudeMemoryGates', 'claudeCodeVersion'],
  codex: ['codexLlmText', 'codexMemoryDir', 'codexMemTok', 'codexMemFiles', 'codexMemEmb', 'codexMemLines', 'codexMemIssues',
    'searchCodexMemory', 'rebuildCodexMemory', 'inspectCodexMemory', 'codexMemoryGatesStatus', 'codexMemoryGates', 'codexCliVersion'],
};

test('the Claude and Codex memory cards have the same parts, in the same order, and the same actions', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const html = ui.view.webview.html;
    // Same parts in the same order: each card's ids appear in its section in skeleton order.
    for (const [agent, ids] of Object.entries(MEMORY_SKELETON)) {
      const at = ids.map((id) => html.indexOf(`id="${id}"`));
      assert.ok(at.every((index) => index > 0), `${agent}: missing ${ids.filter((id, i) => at[i] < 0).join(', ')}`);
      assert.deepEqual([...at].sort((a, b) => a - b), at,
        `witness:memory-parity-order -- the ${agent} memory card's parts are out of the shared order`);
    }
    const panel = runPanelScript(html);
    const data = { ...ui.posted.at(-1),
      memory: { dir: '~/.claude/projects/p/memory', llm: 'ready', tokens: 2600, budgetTokens: 3000, files: 59,
        indexable: 58, embedded: 58, lines: 61, maxLines: 200, over: 0, broken: 0, unresolved: 0 },
      gates: { compiled: true, on: true, current: true, count: 13 },
      claudeCodeVersion: '2.1.301',
      codexMemory: { root: '~/.codex/memories', state: 'present', files: 12, issues: 0, llm: 'ready',
        summaryTokens: 2314, summaryLines: 90, embedded: null, gates: { on: false }, cli: { note: 'Codex CLI 0.161.0.' } } };
    panel.deliver(data);
    const text = (id) => panel.dom.byId.get(id).textContent;
    // The same CPU LLM wording on both, from one helper.
    assert.equal(text('llmText'), 'CPU LLM: ready (bge-small, 384-dim)');
    assert.equal(text('codexLlmText'), text('llmText'), 'witness:memory-parity-llm -- the two cards word the model differently');
    // String(): fakeDom keeps a number assigned to textContent as a number; a real DOM converts it.
    assert.deepEqual(['codexMemTok', 'codexMemFiles', 'codexMemEmb', 'codexMemLines'].map((id) => String(text(id))), ['2.3k', '12', '–', '90']);
    assert.equal(text('codexMemIssues'), '✓ no issues in the native memory files');
    assert.equal(text('claudeMemoryGatesStatus'), 'Memory gates: 13 installed; current.');
    assert.equal(text('claudeCodeVersion'), 'Claude Code 2.1.301.');
    // A Codex issue count opens the Codex report, as the Claude line opens the lint report.
    panel.deliver({ ...data, codexMemory: { ...data.codexMemory, issues: 2 } });
    const link = panel.dom.byId.get('codexMemIssues').children.at(-1);
    assert.equal(link.textContent, '⚠ 2 issues — open report');
    panel.posted.length = 0;
    link.click({ preventDefault() {} });
    assert.deepEqual(panel.posted, [{ type: 'inspectCodexMemory' }]);
    // The Claude card's new buttons reach their commands.
    for (const [id, type] of [['searchClaudeMemory', 'searchClaudeMemory'], ['inspectClaudeMemory', 'inspectClaudeMemory'],
      ['claudeMemoryGates', 'manageGates']]) {
      panel.posted.length = 0;
      panel.dom.byId.get(id).click();
      assert.deepEqual(panel.posted, [{ type }], `${id} posts ${type}`);
    }
  } finally {
    await app.dispose();
  }
});

test('the Codex memory card is given its summary size, lines, index count and model state', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const memories = path.join(env.tempHome, '.codex', 'memories');
  fs.mkdirSync(memories, { recursive: true });
  fs.writeFileSync(path.join(memories, 'memory_summary.md'), `v1\n${'x'.repeat(396)}\nthird\n`);
  fs.writeFileSync(path.join(memories, 'MEMORY.md'), '# Registry\n');
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const codex = ui.posted.at(-1).codexMemory;
    // MUTATION: drop the summary fields from codexFeatureStatus; the card then shows dashes.
    assert.equal(codex.summaryTokens, Math.round(Buffer.byteLength(`v1\n${'x'.repeat(396)}\nthird\n`) / 4));
    assert.equal(codex.summaryLines, 3);
    assert.equal(codex.embedded, null, 'no index built in this home');
    assert.ok(['ready', 'model-missing', 'venv-missing'].includes(codex.llm), `llm state: ${codex.llm}`);
    assert.ok('claudeCodeVersion' in ui.posted.at(-1), 'the version line is fed');
  } finally {
    await app.dispose();
  }
});

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
    assert.equal(healthy.settingsState, 'present');
    // The RENDERED pill, not a payload boolean. This asserted `active` until
    // 2026-10-14, a field the webview never read: the pill is drawn from
    // settingsState and claudePermissionsComplete, so that is what is checked.
    const shown = renderDashboard(app.provider, healthy);
    assert.equal(shown.node('dot').className, 'dot', 'precondition: a readable file draws the live pill');
    assert.equal(shown.node('statusText').textContent, 'Permissions');

    // Every read of settings.json from here on returns unparseable bytes.
    app.arm(Array(12).fill('corrupt'));
    app.provider.refresh();
    await settle();

    const broken = ui.posted[ui.posted.length - 1];
    assert.equal(broken.settingsState, 'unreadable',
      'a present-but-unparseable file is its own state, not absent and not fine');
    const refused = renderDashboard(app.provider, broken);
    assert.equal(refused.node('dot').className, 'dot idle',
      'the green pill must not claim Active while every writer is refusing');
    assert.equal(refused.node('statusText').textContent, 'Permissions · count incomplete');
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
    // Gone 2026-10-14, unread by the webview: `canRebuild` cost recallScriptPath()'s fs
    // probes on every push. MUTATION: restore it; this fails. Confirmed 2026-10-14.
    assert.equal('canRebuild' in m || 'modelDir' in m, false, 'unread recall fields are not built per push');
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

test('the sidebar previews both agents and sends overflow and Codex review to the shared picker', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const rulesFile = path.join(env.tempHome, '.codex', 'rules', 'user.rules');
  fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
  fs.writeFileSync(rulesFile, [
    'prefix_rule(pattern=["git", "status"], decision="allow")',
    'prefix_rule(pattern=["rg"], decision="allow")', '',
  ].join('\n'));
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
    assert.equal(panel.dom.byId.get('wcount').textContent, '17 total');

    const preview = rows.slice(0, 12);
    const claudeRows = preview.filter((row) => row.children[1].textContent === 'Claude');
    const codexRows = preview.filter((row) => row.children[1].textContent === 'Codex');
    assert.equal(claudeRows.length, 10);
    assert.equal(codexRows.length, 2, 'a full Claude list must not crowd Codex out of the preview');
    assert.deepEqual(claudeRows.map((row) => row.children[0].textContent), [...FIFTEEN].sort().slice(0, 10));
    assert.deepEqual(codexRows.map((row) => row.children[0].textContent), ['["git","status"]', '["rg"]'],
      'Codex argv prefixes are displayed without inventing a trailing wildcard');

    const more = rows[12];
    assert.equal(more.className, 'more');
    assert.equal(more.textContent, 'and 5 more - search all 17 →');

    const codexEntry = ui.posted[0].savedPermissions.find((entry) => entry.agent === 'codex');
    panel.posted.length = 0;
    more.click();
    claudeRows[0].children[2].click();
    codexRows[0].children[2].click();
    assert.deepEqual(panel.posted, [
      { type: 'viewPermissions' },
      { type: 'remove', value: [...FIFTEEN].sort()[0] },
      { type: 'viewPermissions', selection: {
        agent: 'codex', path: rulesFile, pattern: ['git', 'status'], start: codexEntry.start,
      } },
    ]);
  } finally {
    await app.dispose();
  }
});

test('a Codex-only saved list is populated while Claude has no permissions', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const rulesFile = path.join(env.tempHome, '.codex', 'rules', 'user.rules');
  fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
  fs.writeFileSync(rulesFile, 'prefix_rule(pattern=["git", "status"], decision="allow")\n');
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const panel = runPanelScript(ui.view.webview.html);
    panel.deliver(ui.posted[0]);
    assert.equal(panel.dom.byId.get('wcount').textContent, '1 total');
    const rows = panel.dom.byId.get('list').children;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].children[0].textContent, '["git","status"]');
    assert.equal(rows[0].children[1].textContent, 'Codex');
    assert.notEqual(rows[0].className, 'empty', 'absence of Claude wildcards must not erase Codex approvals');
  } finally {
    await app.dispose();
  }
});

// One-off shell approvals (2026-10-13): saved exact entries that open with something
// that is not a command, or chain several, counted by deadShellApprovals off the SAME
// allow list the push already read. Synthetic entries only, and every one is a shape
// the wildcarding pass leaves alone, so activation does not rewrite the list under test.
test('the saved-permissions card names one-off shell approvals and links to them, and goes quiet at zero', async (t) => {
  const env = setup(t);
  const oneOffs = ['PowerShell($stamp = Get-Date)', 'PowerShell(1..6 | ForEach-Object { $_ })'];
  env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(./scripts/build.sh --release)', ...oneOffs], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = ui.posted.at(-1);
    assert.deepEqual(env.read().permissions.allow.slice(2), oneOffs, 'precondition: the list was not rewritten');
    // MUTATION: drop `deadApprovals,` from the _push payload. The field is absent and
    // this fails; the panel then renders nothing. Confirmed 2026-10-13.
    assert.deepEqual(data.deadApprovals, {
      count: 2, total: 3,
      byReason: { 'compound-command': 1, 'dynamic-executable': 1, 'missing-command-root': 2, 'script-syntax': 1 },
    }, 'the star rule is not examined; the path executable is examined and not counted');

    const panel = runPanelScript(ui.view.webview.html);
    panel.deliver(data);
    const line = panel.dom.byId.get('deadApprovals');
    // MUTATION: drop the renderDeadApprovals(d) call from render(). The line stays
    // hidden and empty while the badge still counts, which is the disagreement the
    // shared helper exists to prevent. Confirmed 2026-10-13.
    assert.equal(line.hidden, false);
    assert.equal(line.textContent,
      '2 saved shell approvals are one-off scripts that will prompt again on any variation — review');
    assert.match(line.title, /Nothing is removed automatically/);
    // MUTATION: drop the one-off suffix from the wcount badge. Confirmed 2026-10-13.
    assert.equal(panel.dom.byId.get('wcount').textContent, '4 total · 2 one-off');
    assert.equal(panel.dom.byId.get('wcount').className, 'rowstate', 'a note, not a warn tone');

    panel.posted.length = 0;
    line.click();
    // MUTATION: post viewPermissions without the selection. The picker then opens the
    // full mixed list instead of these entries. Confirmed 2026-10-13.
    assert.deepEqual(panel.posted, [{ type: 'viewPermissions', selection: { filter: 'dead' } }]);
    ui.on.message(panel.posted[0]);
    assert.deepEqual(app.executedArgs.at(-1), {
      id: 'permission-wildcarding.viewPermissions', args: [{ filter: 'dead' }],
    }, 'the route carries the filter to the shared picker unchanged');

    // Zero is silence: no line, no badge suffix, and a click does nothing.
    env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(./scripts/build.sh --release)'], deny: [] } });
    app.provider.refresh();
    await settle();
    const quiet = ui.posted.at(-1);
    assert.deepEqual(quiet.deadApprovals, { count: 0, total: 1, byReason: {} });
    panel.deliver(quiet);
    assert.equal(line.hidden, true);
    assert.equal(line.textContent, '');
    assert.equal(panel.dom.byId.get('wcount').textContent, '2 total');
    panel.posted.length = 0;
    line.click();
    assert.deepEqual(panel.posted, [], 'a hidden line has nothing to open');
  } finally {
    await app.dispose();
  }
});

// Over-broad wildcard grants (2026-10-13): saved WILDCARD shell entries keyed on shell
// grammar (`Bash(export *)`, `PowerShell(foreach *)`) rather than a command, counted by
// overBroadShellGrants off the SAME allow list the push already read. Synthetic entries;
// every one is already a wildcard, so activation's wildcarding pass leaves the list alone.
test('the saved-permissions card names over-broad wildcard grants and links to them, and goes quiet at zero', async (t) => {
  const env = setup(t);
  const broad = ['Bash(export *)', 'PowerShell(foreach *)'];
  env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(source *)', ...broad], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = ui.posted.at(-1);
    assert.deepEqual(env.read().permissions.allow.slice(2), broad, 'precondition: the list was not rewritten');
    // MUTATION: drop `overBroadGrants,` from the _push payload. The field is absent and
    // this fails; the panel then renders nothing. Confirmed 2026-10-13.
    assert.deepEqual(data.overBroadGrants, { count: 2, total: 4, byReason: { 'reserved-keyword': 2 } },
      'git status is a command and source is exempt; both wildcards were examined');
    assert.deepEqual(data.deadApprovals, { count: 0, total: 0, byReason: {} }, 'the sibling diagnostic is separate');
    assert.ok(ui.view.webview.html.includes('id="overBroadGrants"'), 'the card carries the line');

    const panel = runPanelScript(ui.view.webview.html);
    panel.deliver(data);
    const line = panel.dom.byId.get('overBroadGrants');
    // MUTATION: drop the renderOverBroadGrants(d) call from render(). The line stays
    // hidden and empty. Confirmed 2026-10-13.
    assert.equal(line.hidden, false);
    assert.equal(line.textContent,
      '2 saved wildcard grants name shell grammar rather than a command and match more than intended — review');
    assert.match(line.title, /Nothing is removed automatically/);
    assert.match(line.title, /reserved-keyword: 2/);
    assert.equal(panel.dom.byId.get('deadApprovals').hidden, true, 'no one-offs, so the sibling line stays hidden');
    assert.equal(panel.dom.byId.get('wcount').textContent, '4 total', 'the badge is unchanged by this line');

    panel.posted.length = 0;
    line.click();
    // MUTATION: post the 'dead' filter from this line. The picker then opens the one-off
    // view instead. Confirmed 2026-10-13.
    assert.deepEqual(panel.posted, [{ type: 'viewPermissions', selection: { filter: 'over-broad' } }]);
    ui.on.message(panel.posted[0]);
    assert.deepEqual(app.executedArgs.at(-1), {
      id: 'permission-wildcarding.viewPermissions', args: [{ filter: 'over-broad' }],
    }, 'the route carries the filter to the shared picker unchanged');

    // One grant reads in the singular.
    env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(export *)'], deny: [] } });
    app.provider.refresh();
    await settle();
    panel.deliver(ui.posted.at(-1));
    assert.equal(line.textContent,
      '1 saved wildcard grant names shell grammar rather than a command and matches more than intended — review');

    // Zero is silence: no line, and a click does nothing.
    env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(source *)'], deny: [] } });
    app.provider.refresh();
    await settle();
    const quiet = ui.posted.at(-1);
    assert.deepEqual(quiet.overBroadGrants, { count: 0, total: 2, byReason: {} });
    panel.deliver(quiet);
    assert.equal(line.hidden, true);
    assert.equal(line.textContent, '');
    panel.posted.length = 0;
    line.click();
    assert.deepEqual(panel.posted, [], 'a hidden line has nothing to open');
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
  // fresh read. Its own note (src/settings-write.js:173-179#reusing) says that is "WRONG
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

test('the change toast counts what the WRITE landed, not what the locked read planned',
  async (t) => {
    // One read further than the test above. `lockedBefore` is taken inside the
    // policy lock, but Claude Code does not take that lock — it writes
    // settings.json on every approval, /model and /effort — so a write can land
    // between our locked read and writeAllow's own re-read, and writeAllow
    // rebases onto the latter.
    //
    // `removedAllow` was added to src/settings-write.js:232#removedAllow for exactly this, with
    // a note saying a caller computing a removal count from its own pre-write
    // snapshot is doing the thing the measurement exists to replace. The caller
    // was never switched over, so the toast kept reporting the plan.
    //
    // THE KILLING MUTATION: put `lockedBefore.filter(p => !lockedAfter.includes(p)).length`
    // back in place of `written.removedAllow`. The toast then says "pruned 2" over
    // a write that pruned nothing, and "1 total" over a four-entry file.
    const env = setup(t);
    env.write({ permissions: { allow: FIFTEEN, deny: [] } });
    const app = harness(env.tempHome);
    const realRead = fs.readFileSync;
    try {
      await settle();
      env.write({ permissions: { allow: NON_OPTIMAL, deny: [] } });

      // Armed when the lock is taken, so the locked read still sees NON_OPTIMAL
      // and only writeAllow's re-read sees the concurrent list.
      let armed = false;
      let injected = false;
      app.locks.insideLock = () => { armed = true; };
      fs.readFileSync = function patchedRead(file, ...rest) {
        const out = realRead.call(this, file, ...rest);
        if (armed && !injected && String(file) === env.settingsPath) {
          injected = true;
          armed = false;
          env.write({ permissions: { allow: OTHER_NON_OPTIMAL, deny: [] } });
        }
        return out;
      };

      app.shown.length = 0;
      await app.commands.get('permission-wildcarding.runNow')();
      await settle();

      assert.ok(injected, 'precondition: the concurrent write never landed');
      assert.deepEqual(env.read().permissions.allow,
        [...OTHER_NON_OPTIMAL, 'Bash(git status *)'],
        'precondition: writeAllow must have rebased the delta onto the concurrent list — '
        + 'without this the two reads never actually differed');

      const toast = app.shown.find((entry) => /wildcarded/.test(entry.message));
      assert.ok(toast, `no change was announced: ${JSON.stringify(app.shown)}`);
      assert.match(toast.message, /pruned 0/,
        'witness:removed-allow -- the toast reported the locked read’s plan (two entries it '
        + `meant to prune) over a write that pruned none of them: "${toast.message}"`);
      assert.match(toast.message, /4 total/,
        `witness:removed-allow -- the total is the caller's intended list, not the file: "${toast.message}"`);
      assert.match(toast.message, /wildcarded 1 permission\b/,
        `witness:removed-allow -- the control: one entry really was added: "${toast.message}"`);
    } finally {
      fs.readFileSync = realRead;
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

test('a completed lock cycle gives the lock-contention budget back', async (t) => {
  // The third site, after the lock is released: the reset every successful
  // contended-then-retried write is supposed to reach. The two tests above only
  // reach the early returns, so removing this one left the whole suite green
  // (mutation tracker, 2026-10-13). Without it the budget counts contended runs
  // per WINDOW rather than per contention episode: 20 lost races spread across a
  // day, each one followed by a retry that wrote successfully, still disable the
  // retry for good.
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    await settle();
    await exhaustRetryBudget(app, env);

    // Uncontended now, and the list is still the non-optimal one the exhausted
    // runs never managed to write, so the probe falls through and the guarded
    // write happens. The harness watchers are inert, so the write cannot re-fire
    // a probe and reach the already-optimal reset instead of this one.
    app.locks.contended = false;
    const acquired = app.locks.count;
    await app.commands.get('permission-wildcarding.runNow')();
    assert.equal(app.locks.count, acquired + 1, 'precondition: the run took the lock');
    assert.deepEqual(env.read().permissions.allow, ['Bash(git status *)'],
      'precondition: and completed the write inside it');

    app.locks.contended = true;
    env.write({ permissions: { allow: NON_OPTIMAL, deny: [] } });
    await app.commands.get('permission-wildcarding.runNow')();
    assert.equal(app.retriesScheduled(), 21,
      'a lock cycle that completed left the retry budget spent, so the next contended '
      + 'write is abandoned even though the last contention ended in a successful write');
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
// defect src/auto-learn-manager.js:2893-2895#errors records — a file that failed every
// scan for eight days, invisible because a computed number was not passed on.

// Writes the manager's state file wherever the manager would look for it, which
// depends on a hash of the workspace root. Required lazily and INSIDE the
// harness's Module._load hook rather than at the top of this file, so the copy it
// resolves is the one the extension is already using, bound to the mocked `os`.
function seedAutoLearnState(tempHome, lastScanStats, extra = {}) {
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
    lastScanAt: Date.now(), lastScanStats, lastApplication: null, ...extra,
  }, null, 2) + '\n');
  return statePath;
}

// `canUndo` drives the Undo button and had no test at all: replacing it with
// `false` left the suite green (2026-10-14, while removing its redundant second
// leg). One recorded application, in the shape the manager's own validator keeps.
test('the Auto Learn Undo button is enabled exactly when an application is recorded', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, null, { lastApplication: { at: new Date().toISOString(), targets: [{
      kind: 'claude', path: path.join(env.tempHome, '.claude', 'settings.json'),
      backupPath: path.join(env.tempHome, '.claude', 'backups', 'auto-learn.json'),
      beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), existed: true,
    }] } });
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const recorded = ui.posted.at(-1).autoLearn;
    // MUTATION: post `canUndo: false`. This fails. Confirmed 2026-10-14.
    assert.equal(recorded.canUndo, true, 'a recorded application can be undone');
    assert.equal(renderDashboard(app.provider, ui.posted.at(-1)).node('alUndo').disabled, false);

    seedAutoLearnState(env.tempHome, null);
    app.provider.refresh();
    await settle();
    const none = ui.posted.at(-1).autoLearn;
    assert.equal(none.canUndo, false, 'nothing recorded, nothing to undo');
    assert.equal(renderDashboard(app.provider, ui.posted.at(-1)).node('alUndo').disabled, true);
  } finally {
    await app.dispose();
  }
});

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

test('an evidence cap that cannot get under its limit says so', async (t) => {
  // The one number that reports a cap running DEGRADED, and it reached nothing.
  //
  // pruneObservationHashes holds every hash belonging to a family below the success
  // threshold, whatever its age, because re-reading a trimmed transcript would inflate
  // the counts that gate an auto-safe apply. That protected set has had a ceiling of its
  // own since 455ab97, but a family carrying a human decision is never evicted to meet
  // it, so the map can still stay over its limit after the prune has done all it can
  // (src/auto-learn-manager.js:1063-1066#evictable, which also says that residue is all
  // `retainedObservations` reports now; before 455ab97 the set had no bound at all).
  //
  // It was reported to the state file and to the CLI. The panel, which is the only UI
  // most users of this extension open, never saw it: autoLearnScanHealth copied eight
  // fields out of lastScanStats and this was not one of them. Same shape as the
  // `errors` gap above, one field along.
  //
  // THE MUTATION: drop `retainedObservations` from autoLearnScanHealth, or drop the
  // `if (s.retainedObservations)` push from scanTrouble. The first fails on the payload
  // assertion, the second on the rendered card and the collapsed badge.
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, {
      // Everything else clean, deliberately: a run that read every file, found nothing
      // it could not parse, and pruned 400 hashes looks perfect on every other number
      // here. 12 is what would not go.
      files: 9, observations: 21, errors: 0, partial: 0, unmatchedResults: 0,
      prunedObservations: 400, prunedCursors: 0, prunedCandidates: 0, prunedGrants: 0,
      retainedObservations: 12, blindScan: false,
    });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const data = ui.posted.at(-1);
    assert.equal(data.autoLearn.scan.retainedObservations, 12,
      'witness:retained-observations -- the overflow count never reached the panel');
    assert.equal(data.autoLearn.scan.pruned, 400,
      'and it is not folded into the prune total: 400 came out, 12 would not, and one '
      + 'number cannot say both');

    const rendered = renderDashboard(app.provider, data);
    assert.match(rendered.alScanHealth, /12 observation hashes held over the cap/,
      `the card body said "${rendered.alScanHealth}"`);
    assert.equal(rendered.stAutoLearn, 'scan degraded',
      `the collapsed row said "${rendered.stAutoLearn}", so a user who has not expanded `
      + 'the card sees a cap that cannot keep its own limit as perfectly healthy');
  } finally {
    await app.dispose();
  }
});

// ── the Codex history probe, through the renderer ─────────────────────────────
//
// THE GAP THAT HID THE WORST DEFECT IN THIS FILE. Every seed above omits
// `codexHistoryInspected`, `scanStats()` defaults an absent value to 'skipped',
// and 'skipped' matches neither arm of scanTrouble's Codex branch — so no test
// in this suite had ever driven that branch at all, in either direction.
//
// What was behind it: `readThreadStoreIds` needs `node:sqlite`, the extension
// hosts in use when this was written could not load it, so the probe reported
// 'partial' on every one of them, scanTrouble turned that into a permanent
// 'scan degraded', and the row badge ranked it ABOVE the review count. The user
// stopped seeing "3 to review" for the life of the install with nothing they
// could do about it. VS Code 1.141.1 (Node 24.21.0) loads it; hosts within the
// ^1.80 engine floor may not, so the `unavailable` tier stays (measured
// 2026-10-13).
const SCAN_SEED = {
  files: 9, observations: 21, errors: 0, partial: 0, unmatchedResults: 0,
  prunedObservations: 0, prunedCursors: 0, prunedCandidates: 0, prunedGrants: 0,
  retainedObservations: 0, blindScan: false, codexHistoryStale: false,
};

test('a Codex probe the runtime cannot host is not a degraded scan', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, { ...SCAN_SEED, codexHistoryInspected: 'partial' });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const degradedData = ui.posted.at(-1);
    // The control first, and it is the assertion that did not exist: a probe that
    // RAN and could not conclude is still trouble, and must still be drawn.
    assert.equal(degradedData.autoLearn.scan.codexHistoryInspected, 'partial',
      'witness:codex-probe -- the field never reached the panel, so neither arm of '
      + 'scanTrouble is reachable from this suite');
    const degraded = renderDashboard(app.provider, degradedData);
    assert.match(degraded.alScanHealth, /Codex history-store check ran degraded/,
      `the card body said "${degraded.alScanHealth}"`);
    assert.match(degraded.stAutoLearn, /scan degraded/,
      `the collapsed row said "${degraded.stAutoLearn}"`);

    // And the state this whole change exists for. Same payload, same renderer,
    // one field different: a probe the interpreter cannot host is inapplicable,
    // not degraded, and it must cost the row nothing.
    const unavailableData = structuredClone(degradedData);
    unavailableData.autoLearn.scan.codexHistoryInspected = 'unavailable';
    const unavailable = renderDashboard(app.provider, unavailableData);
    assert.doesNotMatch(unavailable.alScanHealth, /degraded/,
      'witness:codex-probe -- a check that cannot run on this runtime was reported as a check '
      + `that ran badly. The card said "${unavailable.alScanHealth}"`);
    assert.match(unavailable.alScanHealth, /read 9 files cleanly/,
      `the card said "${unavailable.alScanHealth}" rather than reporting a clean scan`);
    assert.doesNotMatch(unavailable.stAutoLearn, /degraded/,
      `the collapsed row said "${unavailable.stAutoLearn}"`);

    // The half that must NOT be quieted with it: a stale rollout directory is a
    // real finding, it is computed without sqlite, and it still has to shout.
    // This seed carries no `codexHistoryFindings` -- the shape of a state file
    // written before the counts existed -- so it is also the pin on the fallback
    // phrase: a stale verdict with nothing to break it down still says so.
    const staleData = structuredClone(unavailableData);
    staleData.autoLearn.scan.codexHistoryStale = true;
    const stale = renderDashboard(app.provider, staleData);
    assert.match(stale.alScanHealth, /rollout directory is stale/,
      'witness:codex-probe -- the real finding was suppressed along with the false alarm. '
      + `The card said "${stale.alScanHealth}"`);
    assert.match(stale.stAutoLearn, /scan degraded/);
  } finally {
    await app.dispose();
  }
});

// THE SENTENCE THAT WAS WRONG ABOUT WHY. Reproduced on the real box 2026-10-13:
// four archived Codex threads, nothing moved, and the card said "Codex history
// store has moved". The probe now persists what its verdict is made of, and the
// card says that instead.
test('a stale Codex verdict names what diverged instead of claiming the store moved', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, {
      ...SCAN_SEED, codexHistoryStale: true, codexHistoryInspected: 'exact',
      codexHistoryReasons: ['4 Codex thread(s) exist in the history store or session index with no rollout file in sessions/, archived_sessions/.'],
      codexHistoryFindings: { orphans: 4, relocated: 0, projectionAhead: 0, emptyRollouts: 0 },
    });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const data = ui.posted.at(-1);
    assert.deepEqual(data.autoLearn.scan.codexHistoryFindings, { orphans: 4, relocated: 0, projectionAhead: 0, emptyRollouts: 0 },
      'witness:stale-phrase -- the findings never reached the panel');
    const rendered = renderDashboard(app.provider, data);
    assert.match(rendered.alScanHealth, /4 Codex threads with no transcript/,
      `the card body said "${rendered.alScanHealth}"`);
    assert.doesNotMatch(rendered.alScanHealth, /has moved/,
      'witness:stale-phrase -- the card still claims a move nobody made');
    assert.equal(rendered.stAutoLearn, 'scan degraded', 'a real divergence still degrades the row');
    assert.match(rendered.node('alScanHealth').title, /4 Codex thread\(s\) exist/,
      'the persisted reason is the hover title, so the user can find out what to do');

    // Each finding has its own words, joined, and singular is singular.
    const mixed = structuredClone(data);
    mixed.autoLearn.scan.codexHistoryFindings = { orphans: 1, relocated: 2, projectionAhead: 1, emptyRollouts: 1 };
    assert.match(renderDashboard(app.provider, mixed).alScanHealth,
      /1 Codex thread with no transcript · 2 Codex transcripts outside the scanned folders · Codex store ahead of 1 transcript · Codex rollout folders empty beside a populated store/);

    // The control: no reasons, no tooltip left behind from an earlier render.
    const clean = structuredClone(data);
    clean.autoLearn.scan = { ...clean.autoLearn.scan, codexHistoryStale: false, codexHistoryReasons: [], codexHistoryFindings: null };
    const cleared = renderDashboard(app.provider, clean);
    assert.match(cleared.alScanHealth, /read 9 files cleanly/);
    assert.equal(cleared.node('alScanHealth').title, '');
  } finally {
    await app.dispose();
  }
});

// WHY A CODEX REBUILD IS HELD OPEN reaches the scan-health hover (2026-10-14, F3 of the v1.6.3
// confirmation audit). A configured Codex root that is missing holds the evidence rebuild open,
// which keeps every family with Codex evidence from being applied, and until now nothing named
// the folder. The REAL manager writes the reason here (a scripted walk reports `sessions/`
// missing and a pending transcript it did not find), and the real extension reads it back from
// the state file, as it does every persisted Codex reason. By folder name, never the path.
test('a rebuild held open by a missing Codex root names the folder on the scan-health hover', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const pending = `path-sha256:${'a'.repeat(24)}`;
  seedAutoLearnState(env.tempHome, { ...SCAN_SEED }, {
    version: 3, codexEvidenceRevision: 4, codexEvidenceRebuildPending: true, codexEvidencePendingFiles: [pending],
  });
  // eslint-disable-next-line global-require
  const { createAutoLearnManager } = require('../src/auto-learn-manager');
  const codex = path.join(env.tempHome, '.codex');
  const result = createAutoLearnManager({
    home: env.tempHome, workspaceRoot: path.join(env.tempHome, 'workspace'),
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }),
    historyScanner: () => ({
      observations: [], cursors: {},
      files: [{ source: 'codex', mode: 'full', path: path.join(codex, 'archived_sessions', 'other.jsonl') }],
      missingRoots: [{ path: path.join(codex, 'sessions'), source: 'codex', link: false }],
    }),
  }).scan();
  assert.equal(result.codexEvidence.pending, true, 'precondition: the missing root holds the rebuild');

  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = ui.posted.at(-1);
    const rendered = renderDashboard(app.provider, data);
    const title = rendered.node('alScanHealth').title;
    // MUTATION: drop the `rebuildHeldOpen ? [...] :` from the manager's lastScanStats. The hover is
    // empty and this fails. Confirmed 2026-10-14.
    assert.match(title, /^The Codex evidence rebuild is held open: the configured history folder sessions\/ is missing/,
      `the hover said "${title}"`);
    assert.ok(!title.includes(env.tempHome) && !title.includes(codex), `a path reached the hover: ${title}`);
    assert.match(rendered.node('alsub').textContent, /rebuilding older Codex evidence: 1 transcripts still need a complete read/,
      'precondition: the card already said the rebuild is open, only not why');

    // G3 (2026-10-14): and the LINE says it. It read "✓ last scan read 1 file cleanly" while the
    // rebuild it hovers over blocked every family with Codex evidence. It blocks something, so it
    // is trouble, by folder name, with what to do; the hover above says how.
    // MUTATION: drop the codexRebuildWaitingFor branch from the webview's scanTrouble, or the
    // field from autoLearnScanHealth. The line reads "cleanly" and this fails. Confirmed 2026-10-14.
    assert.deepEqual(data.autoLearn.scan.codexRebuildWaitingFor, [{ name: 'sessions', link: false }]);
    assert.match(rendered.alScanHealth,
      /^⚠ last scan: Codex rebuild waiting for a missing history folder \(sessions\) — reconnect or recreate it/,
      `the scan-health line said "${rendered.alScanHealth}"`);
    assert.doesNotMatch(rendered.alScanHealth, /cleanly/);
    assert.match(rendered.stAutoLearn, /scan degraded/, 'the collapsed row agrees with the card');
    assert.ok(!rendered.alScanHealth.includes(env.tempHome) && !rendered.alScanHealth.includes(codex));
    // A link, and more than one folder, each in its own words.
    const linked = structuredClone(data);
    linked.autoLearn.scan.codexRebuildWaitingFor = [{ name: 'sessions', link: false }, { name: 'archived_sessions', link: true }];
    assert.match(renderDashboard(app.provider, linked).alScanHealth,
      /missing history folders \(sessions; archived_sessions, a link to a missing target\) — reconnect or recreate them/);
    // The control: with nothing waited for, the line is clean again.
    const cleared = structuredClone(data);
    cleared.autoLearn.scan.codexRebuildWaitingFor = [];
    assert.match(renderDashboard(app.provider, cleared).alScanHealth, /^✓ last scan read/);
  } finally {
    await app.dispose();
  }
});

// A file the per-scan ingest budget deferred is catch-up, not trouble. The
// largest archived rollout on the box is 170 MB against a 64 MiB budget, so the
// archive root makes it three scans of `partial`, and every one of them used to
// read "scan degraded" over a scan that lost nothing.
test('a budget-deferred transcript reads as catching up, not as a degraded scan', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, { ...SCAN_SEED, partial: 1, deferredBytes: 111 * 1048576 });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const data = ui.posted.at(-1);
    assert.equal(data.autoLearn.scan.deferredBytes, 111 * 1048576, 'the bytes left never reached the panel');
    const rendered = renderDashboard(app.provider, data);
    assert.match(rendered.alScanHealth, /read 9 files cleanly · catching up on 1 large transcript \(111 MB left\)/,
      `the card body said "${rendered.alScanHealth}"`);
    assert.doesNotMatch(rendered.stAutoLearn, /degraded/,
      'witness:partial-not-trouble -- a scan that is catching up was badged as degraded');

    // The control: real trouble beside the catch-up still degrades the row, and
    // the catch-up is still said beside it rather than swallowed.
    const troubled = structuredClone(data);
    troubled.autoLearn.scan.errors = 2;
    const both = renderDashboard(app.provider, troubled);
    assert.match(both.alScanHealth, /2 unreadable files · catching up on 1 large transcript/);
    assert.equal(both.stAutoLearn, 'scan degraded');
  } finally {
    await app.dispose();
  }
});

test('a skipped unreadable stretch is trouble, unlike a deferral', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, { ...SCAN_SEED, unreadable: 1 });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const data = ui.posted.at(-1);
    assert.equal(data.autoLearn.scan.unreadable, 1, 'witness:unreadable -- the count never reached the panel');
    const rendered = renderDashboard(app.provider, data);
    assert.match(rendered.alScanHealth, /1 file with an unreadable stretch skipped/,
      `the card body said "${rendered.alScanHealth}"`);
    assert.equal(rendered.stAutoLearn, 'scan degraded');

    // The control and the plural: two files, and none is clean.
    const two = structuredClone(data);
    two.autoLearn.scan.unreadable = 2;
    assert.match(renderDashboard(app.provider, two).alScanHealth, /2 files with an unreadable stretch skipped/);
    const none = structuredClone(data);
    none.autoLearn.scan.unreadable = 0;
    assert.match(renderDashboard(app.provider, none).alScanHealth, /read 9 files cleanly/);
  } finally {
    await app.dispose();
  }
});

// Codex compresses idle rollouts to .jsonl.zst (2026-10-16). A runtime with no
// zstd, or a file past the decompression ceiling, cannot read one, and gets the
// same answer on every scan: said beside the verdict, never the verdict, or the
// row would read "scan degraded" for good, the false alarm this whole class is.
test('a compressed transcript the scan could not read is said, and is not a degraded scan', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, { ...SCAN_SEED, compressedUnsupported: 2, compressedOversize: 1 });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const data = ui.posted.at(-1);
    assert.equal(data.autoLearn.scan.compressedUnsupported, 2, 'witness:compressed-count -- the count never reached the panel');
    assert.equal(data.autoLearn.scan.compressedOversize, 1);
    const rendered = renderDashboard(app.provider, data);
    assert.match(rendered.alScanHealth,
      /✓ last scan read 9 files cleanly · 2 compressed transcripts not read \(this runtime has no zstd\) · 1 compressed transcript not read \(over 256 MB decompressed\)/,
      `the card body said "${rendered.alScanHealth}"`);
    assert.doesNotMatch(rendered.stAutoLearn, /degraded/,
      'witness:compressed-not-trouble -- a compressed transcript the runtime cannot read badged the row as degraded');

    // The control: real trouble beside it still degrades the row, and the note
    // is still said rather than swallowed.
    const troubled = structuredClone(data);
    troubled.autoLearn.scan.errors = 1;
    const both = renderDashboard(app.provider, troubled);
    assert.match(both.alScanHealth, /1 unreadable file · 2 compressed transcripts not read/);
    assert.equal(both.stAutoLearn, 'scan degraded');
    const clean = structuredClone(data);
    clean.autoLearn.scan.compressedUnsupported = 0;
    clean.autoLearn.scan.compressedOversize = 0;
    assert.doesNotMatch(renderDashboard(app.provider, clean).alScanHealth, /compressed/);
  } finally {
    await app.dispose();
  }
});

// Rule use (src/rule-usage.js, 2026-10-16): the card says how often its rules are used, off the
// result the counting thread saved, and opens the rules with no use found. Synthetic rules, the
// shapes the one-off test above uses, so activation does not rewrite the list under test.
test('the saved-permissions card says how often its rules are used and opens the ones with no use found', async (t) => {
  const { ruleKey, allowFingerprint } = require('../src/rule-usage');
  const env = setup(t);
  const allow = ['Bash(git status *)', 'Bash(./scripts/build.sh --release)', 'Skill(dataviz)'];
  env.write({ permissions: { allow, deny: [] } });
  const file = path.join(env.tempHome, '.claude', 'wildcarding', 'rule-usage.json');
  const save = (rules, list = allow) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, computedAt: new Date().toISOString(),
      since: '2026-08-07T13:34:53.801Z', calls: 1234, files: 3, errors: 0, allowFingerprint: allowFingerprint(list), rules }));
  };
  save({ [ruleKey(allow[0])]: { uses: 42, lastUsedAt: new Date().toISOString() },
    [ruleKey(allow[1])]: { uses: 0, lastUsedAt: null } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    assert.deepEqual(env.read().permissions.allow, allow, 'precondition: the list was not rewritten');
    const data = ui.posted.at(-1);
    // MUTATION: drop `ruleUsage,` from the _push payload. The line then never renders.
    const { counted, used, noUse, untracked, notCounted, current } = data.ruleUsage || {};
    assert.deepEqual({ counted, used, noUse, untracked, notCounted, current },
      { counted: true, used: 1, noUse: 1, untracked: 1, notCounted: 0, current: true },
      'witness:rule-use-payload -- the card was not given the saved count');
    assert.equal(data.ruleUsage.noUseRules, undefined, 'the list stays out of the payload; the picker reads it');
    assert.equal(data.ruleUsage.counting, false, 'a push only reads: no counting thread was started');

    const panel = runPanelScript(ui.view.webview.html);
    panel.deliver(data);
    const line = panel.dom.byId.get('ruleUsage');
    assert.equal(line.hidden, false);
    assert.match(line.textContent, /^Rule use since .+: 1 used · 1 with no use found — review$/);
    assert.match(line.title, /keep no transcript/, 'the hover says what the count cannot see');
    assert.match(line.title, /Most used: Bash\(git status \*\) 42×/);
    assert.match(line.title, /1 not tracked/);
    panel.posted.length = 0;
    line.click();
    assert.deepEqual(panel.posted, [{ type: 'viewPermissions', selection: { filter: 'no-use' } }],
      'witness:rule-use-review -- the line did not open the rules with no use found');

    // Nothing to review: the click asks for a recount instead.
    save({ [ruleKey(allow[0])]: { uses: 42, lastUsedAt: new Date().toISOString() },
      [ruleKey(allow[1])]: { uses: 3, lastUsedAt: new Date().toISOString() } });
    app.provider.refresh();
    await settle();
    panel.deliver(ui.posted.at(-1));
    assert.match(line.textContent, /^Rule use since .+: 2 used$/);
    panel.posted.length = 0;
    line.click();
    assert.deepEqual(panel.posted, [{ type: 'countRuleUse' }]);

    // Never counted: the line is quiet rather than claiming a zero.
    fs.rmSync(file);
    app.provider.refresh();
    await settle();
    const none = ui.posted.at(-1);
    assert.equal(none.ruleUsage.counted, false);
    panel.deliver(none);
    assert.equal(line.hidden, true);
  } finally {
    await app.dispose();
  }
});

// Agent sessions (src/agent-sessions.js, 2026-10-16): the card lists the sessions that wrote a
// transcript in the last fifteen minutes, from a look that lands after the first push. Synthetic
// transcripts in the temp home; folder names only reach the panel.
test('the agent sessions card lists active sessions by folder name and says none when there are none', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const file = path.join(env.tempHome, '.claude', 'projects', 'c--work-alpha', '11111111-aaaa-4aaa-8aaa-000000000001.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: path.join(env.tempHome, 'work', 'alpha'),
    entrypoint: 'claude-vscode', permissionMode: 'auto', message: { role: 'user', content: 'x' } })}\n`);
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    let data;
    for (let i = 0; i < 80 && !(data?.agentSessions?.sessions?.length); i += 1) { await settle(); data = ui.posted.at(-1); }
    // MUTATION: drop `agentSessions: sessionsCard,` from the _push payload, or the look's refresh.
    assert.deepEqual(data?.agentSessions?.sessions?.map((s) => [s.agent, s.id, s.app, s.project, s.mode]),
      [['claude', '11111111', 'VS Code', 'alpha', 'auto']],
      'witness:sessions-card -- the active session never reached the panel');
    assert.ok(!JSON.stringify(data.agentSessions).includes(env.tempHome.replace(/\\/g, '\\\\')), 'no path reached the panel');

    const panel = runPanelScript(ui.view.webview.html);
    panel.deliver(data);
    assert.equal(panel.dom.byId.get('stSessions').textContent, '1 active');
    const rows = panel.dom.byId.get('sessionsList').children;
    assert.equal(rows.length, 1);
    // Two lines: badge and folder name, then the details under the name. As one flex row the
    // details squeezed the name to a character wide in a narrow sidebar (2026-10-19).
    assert.equal(rows[0].className, 'session');
    assert.match(ui.view.webview.html, /li\.session \{ display: grid;[^}]*\}\s*li\.session \.when \{ grid-column: 2;/,
      'witness:sessions-layout -- the session row is no longer the two-line grid');
    assert.equal(rows[0].children[0].textContent, 'Claude');
    assert.equal(rows[0].children[1].textContent, 'alpha');
    assert.match(rows[0].children[2].textContent, /^VS Code · auto · (just now|\d+ min ago)$/);
    assert.match(panel.dom.byId.get('sessionsSub').textContent, /not whether it is waiting on you/);
    // The two memory rows name their agents (2026-10-19). "Memory" dated from when the row could
    // only mean Claude's, before Codex memory got a row of its own beside it.
    assert.match(ui.view.webview.html, /<span class="rowname">Claude memory<\/span>/);
    assert.match(ui.view.webview.html, /<span class="rowname">Codex memory<\/span>/);
    // The header line names the agents, not the settings file, which moves to the hover (2026-10-19).
    panel.deliver({ ...data, codexWatching: true });
    assert.equal(panel.dom.byId.get('watching').textContent, 'watching Claude & Codex history');
    assert.match(panel.dom.byId.get('watching').title, /settings\.json and the Claude and Codex transcripts$/);
    panel.deliver({ ...data, codexWatching: false });
    assert.equal(panel.dom.byId.get('watching').textContent, 'watching Claude history');

    // None active: the badge and the list say so rather than going blank.
    panel.deliver({ ...data, agentSessions: { sessions: [], lookedAt: Date.now(), error: null } });
    assert.equal(panel.dom.byId.get('stSessions').textContent, 'none active');
    // The last child: fakeDom's innerHTML is a plain property, so it keeps earlier rows.
    assert.match(panel.dom.byId.get('sessionsList').children.at(-1).textContent, /No Claude or Codex session/);
  } finally {
    await app.dispose();
  }
});

test('a degraded scan qualifies the review count instead of replacing it', async (t) => {
  // Suppressing the count was the second half of the defect and the expensive
  // one. The old chain put trouble ABOVE the counts, so while a trouble condition
  // was permanent the only actionable thing on the row was permanently gone. The
  // caveat belongs BESIDE the number, not instead of it.
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    seedAutoLearnState(env.tempHome, { ...SCAN_SEED, blindScan: true });

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const base = ui.posted.at(-1);
    assert.ok(renderDashboard(app.provider, base).stAutoLearn.includes('scan degraded'),
      'witness:review-count -- precondition: this payload has to be in trouble, or the test '
      + 'below measures nothing');

    const withReview = structuredClone(base);
    withReview.autoLearn.counts = { ...withReview.autoLearn.counts, review: 3, safe: 0 };
    assert.equal(renderDashboard(app.provider, withReview).stAutoLearn, '3 to review · scan degraded',
      'witness:review-count -- the actionable count was dropped rather than qualified');

    // `safe` had a rank of its own here, "N safe to apply", until 2026-10-14. It is
    // the auto-safe part of what Review shows now, never above `review`, so the
    // rank could no longer fire and was removed; when it could, it fired for
    // covered families Review hides (the counts test below). Safe families are
    // review families, so the same qualified count names them.
    const withSafe = structuredClone(base);
    withSafe.autoLearn.counts = { ...withSafe.autoLearn.counts, review: 2, safe: 2 };
    assert.equal(renderDashboard(app.provider, withSafe).stAutoLearn, '2 to review · scan degraded');

    // The control: with nothing to review and nothing wrong, the row is neither
    // of those and says what mode it is in.
    const clean = structuredClone(base);
    clean.autoLearn.scan = { ...clean.autoLearn.scan, blindScan: false };
    clean.autoLearn.counts = { ...clean.autoLearn.counts, review: 0, safe: 0 };
    assert.equal(renderDashboard(app.provider, clean).stAutoLearn, 'recommend');
  } finally {
    await app.dispose();
  }
});

// The reported card (2026-10-14): "2 safe to apply", SAFE 2, REVIEW 0, "23 already
// covered", and a Review button that opened nothing. Both safe families were auto-safe
// and pending, and an allow rule already in settings.json covered each, so Review hid
// them as covered while the tile and the row counted them. Applying one changes no
// prompt: settings.json is left byte-identical and only the claims registry records
// the covering rule. So the card counts them where Review does, as covered.
//
// Through the real payload, so it is countAutoLearnCandidates that is under test and
// not a hand-written `counts` object. Codex off: `claude` was the only pending target.
function seedReportedFamilies(tempHome, extra = []) {
  const family = (tool, tokens, runs, autoSafe) => ({
    key: `${tool.toLowerCase()}:${tokens.join(' ')}`, tool, kind: 'shell', shell: tool.toLowerCase(),
    root: tokens[0], prefix: tokens, claudePermission: `${tool}(${tokens.join(' ')} *)`,
    risk: 'read-only', baseAutoSafe: autoSafe, complex: false,
    reasons: ['known-read-only-command'], sources: ['claude'],
    counts: { success: runs, failed: 0, unknown: 0, total: runs },
  });
  const families = [
    family('Bash', ['git', 'status'], 9, true), family('PowerShell', ['git', 'status'], 7, true),
    family('Bash', ['git', 'log'], 5, false), family('Bash', ['rg'], 4, false),
    family('Bash', ['jq'], 1, false),
    ...extra.map((tokens) => family('Bash', tokens, 6, true)),
  ];
  seedAutoLearnState(tempHome, { ...SCAN_SEED },
    { candidates: Object.fromEntries(families.map((item) => [item.key, item])) });
}

test('a covered auto-safe family is not counted safe to apply, and an uncovered one still is', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git *)', 'PowerShell(git *)', 'Bash(rg *)'], deny: [] } });
  const app = harness(env.tempHome, {
    settings: { 'autoLearn.enabled': true, 'autoLearn.codexScope': 'off' },
  });
  try {
    seedReportedFamilies(env.tempHome);
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const reported = ui.posted.at(-1);
    // MUTATION: count `safe` from every pending auto-safe family again, as before
    // 2026-10-14. This reads 2, the tile reads 2, and the first assertion fails.
    // Confirmed 2026-10-14.
    assert.deepEqual(
      { safe: reported.autoLearn.counts.safe, review: reported.autoLearn.counts.review,
        covered: reported.autoLearn.counts.covered, observe: reported.autoLearn.counts.observe },
      { safe: 0, review: 0, covered: 4, observe: 1 },
      'the card counts what Review shows: both safe families are covered, so neither is safe to apply');
    const card = renderDashboard(app.provider, reported);
    assert.equal(card.node('alsafe').textContent, 0);
    assert.doesNotMatch(card.stAutoLearn, /safe to apply/);
    assert.equal(card.stAutoLearn, 'recommend', 'nothing for Review to show, so the row names the mode');
    assert.match(card.node('alsub').textContent, /4 already covered/,
      'the covered families are still counted, where they belong');

    // The control: an auto-safe family no rule covers is still safe, and Review has it.
    seedReportedFamilies(env.tempHome, [['ls']]);
    app.provider.refresh();
    await settle();
    const uncovered = ui.posted.at(-1);
    assert.equal(uncovered.autoLearn.counts.safe, 1, 'an uncovered auto-safe family still counts');
    assert.equal(uncovered.autoLearn.counts.review, 1, 'and it is in what Review shows');
    const shown = renderDashboard(app.provider, uncovered);
    assert.equal(shown.node('alsafe').textContent, 1);
    assert.equal(shown.stAutoLearn, '1 to review');
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

test('Codex evidence rebuild and uncertain legacy counts remain visible beside actionable review counts', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = structuredClone(ui.posted.at(-1));
    data.autoLearn.counts.review = 3;
    data.autoLearn.scan = { ...SCAN_SEED, codexHistoryInspected: 'skipped' };
    data.autoLearn.codexEvidence = { pending: true, uncertainCandidates: 2, quarantinedRuns: 17, remainingFiles: 4, untimedFailureRuns: 2 };
    const rendered = renderDashboard(app.provider, data);
    assert.match(rendered.node('alsub').textContent, /rebuilding older Codex evidence/);
    assert.match(rendered.node('alsub').textContent, /4 transcripts still need a complete read/);
    assert.match(rendered.node('alsub').textContent, /17 older runs excluded from new approvals/);
    assert.match(rendered.node('alsub').textContent, /2 failed Codex runs could not be dated during rebuild; existing approvals retained/);
    assert.equal(rendered.stAutoLearn, '3 to review', 'migration notes must not suppress the actionable count');

    data.autoLearn.codexEvidence = { pending: false, uncertainCandidates: 0, quarantinedRuns: 0 };
    const complete = renderDashboard(app.provider, data);
    assert.doesNotMatch(complete.node('alsub').textContent, /rebuilding|older runs excluded|could not be dated/);
    assert.equal(complete.stAutoLearn, '3 to review');
  } finally {
    await app.dispose();
  }
});

// The Auto Learn switch (2026-10-19). The owner asked why the card said "disabled" with nothing to
// turn it on: the button sits in the card's row, its label follows the state, and the collapsed
// row says how to turn it on without tinting a choice as trouble. The command is covered in
// test/auto-learn-toggle.test.js.
test('the Auto Learn card carries a Turn on / Turn off button that posts the toggle', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = ui.posted.at(-1);
    assert.equal(data.autoLearn.enabled, false, 'precondition: this harness has Auto Learn off');
    const panel = runPanelScript(ui.view.webview.html);
    panel.deliver(data);
    const toggle = panel.dom.byId.get('alToggle');
    // MUTATION: render 'Turn off' whatever the state. This fails. Confirmed 2026-10-19.
    assert.equal(toggle.textContent, 'Turn on');
    // MUTATION: put back setState('stAutoLearn', 'disabled'), or tint it 'warn'. Each fails.
    // Confirmed 2026-10-19.
    const row = panel.dom.byId.get('stAutoLearn');
    assert.equal(row.textContent, 'disabled · Turn on');
    assert.equal(row.className, 'rowstate', 'off is a choice, not a warning');

    // MUTATION: drop the alToggle click listener. Nothing is posted and this fails, as does the
    // sender census in "every dashboard message reaches its command". Confirmed 2026-10-19.
    panel.posted.length = 0;
    toggle.click();
    assert.deepEqual(panel.posted, [{ type: 'toggleAutoLearn' }]);
    app.executed.length = 0;
    ui.on.message(panel.posted[0]);
    assert.deepEqual(app.executed, ['permission-wildcarding.toggleAutoLearn']);

    panel.deliver({ ...data, autoLearn: { ...data.autoLearn, enabled: true } });
    assert.equal(toggle.textContent, 'Turn off');
    assert.doesNotMatch(row.textContent, /disabled/);
  } finally {
    await app.dispose();
  }
});

test('the dashboard receives migration status from actual legacy learner state', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const app = harness(env.tempHome, { settings: { 'autoLearn.enabled': true } });
  try {
    const { createAutoLearnManager } = require('../src/auto-learn-manager');
    const workspaceRoot = path.join(env.tempHome, 'workspace');
    const manager = createAutoLearnManager({ home: env.tempHome, workspaceRoot,
      historyScanner: () => ({ cursors: {}, files: [{ source: 'codex', mode: 'full' }],
        observations: ['claude', 'claude', 'codex', 'codex', 'codex'].map((source, index) => ({
          id: `legacy-dashboard-${index}`, source, tool: 'PowerShell', command: 'git status',
          status: 'success', cwd: workspaceRoot,
        })),
      }),
    });
    manager.scan();
    const state = JSON.parse(fs.readFileSync(manager.paths.state, 'utf8'));
    state.version = 1;
    for (const key of ['codexEvidenceRevision', 'codexEvidenceRebuildPending', 'legacyCodexEvidence', 'preservedEvidenceGrants']) delete state[key];
    for (const candidate of Object.values(state.candidates)) delete candidate.sourceCounts;
    for (const source of ['claude', 'codex']) {
      const [id] = Object.entries(state.observationHashes).find(([, entry]) => entry.source === source);
      delete state.observationHashes[id];
    }
    fs.writeFileSync(manager.paths.state, JSON.stringify(state));
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = ui.posted.at(-1);
    assert.equal(data.autoLearn.codexEvidence.pending, true, 'pending rebuild must reach the dashboard');
    assert.equal(data.autoLearn.codexEvidence.uncertainCandidates, 1);
    assert.equal(data.autoLearn.codexEvidence.quarantinedRuns, 2, 'unattributable counts must reach the dashboard');
    assert.match(renderDashboard(app.provider, data).node('alsub').textContent, /2 older runs excluded/);
  } finally {
    await app.dispose();
  }
});

test('unreadable Codex override discovery is visible in both instruction cards', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const codex = path.join(env.tempHome, '.codex');
  fs.mkdirSync(path.join(codex, 'AGENTS.override.md'), { recursive: true });
  fs.writeFileSync(path.join(codex, 'AGENTS.md'), '# Keep the base unchanged\n');
  fs.writeFileSync(path.join(env.tempHome, '.claude', 'gates.generated.md'), '# Fixture compiled gate\n');
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = ui.posted.at(-1);
    assert.ok(data.guidance.errors.some((message) => message.includes('AGENTS.override.md')),
      'discovery failure must reach the guidance payload');
    assert.ok(data.gates.errors.some((message) => message.includes('AGENTS.override.md')),
      'discovery failure must reach the gates payload');
    const rendered = renderDashboard(app.provider, data);
    const guidanceError = data.guidance.errors.find((message) => message.includes('AGENTS.override.md'));
    const gatesError = data.gates.errors.find((message) => message.includes('AGENTS.override.md'));
    assert.ok(rendered.node('gdsub').textContent.includes(guidanceError),
      'the guidance card must explain the error, not merely display the target path');
    assert.ok(rendered.node('mgsub').textContent.includes(gatesError),
      'the gates card must explain the error, not merely display the target path');
    assert.equal(fs.readFileSync(path.join(codex, 'AGENTS.md'), 'utf8'), '# Keep the base unchanged\n');
  } finally {
    await app.dispose();
  }
});

// The maintainer's decision of 2026-10-14: gates in memory stores other than the compile
// store are reported, never compiled. The census runs against the store compileGates pins
// (memoryReport().dir) with that store's gate texts, and the card names folders only.
test('the gates card says how many gates in other memory stores are not installed', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  fs.writeFileSync(path.join(env.tempHome, '.claude', 'gates.generated.md'),
    '## Standing gates (1 memories, managed)\n- Fixture resident instruction.\n');
  const compileStore = path.join(env.tempHome, '.claude', 'projects', 'main-store', 'memory');
  const census = { calls: [], answer: null };
  const app = harness(env.tempHome, {
    memoryReport: () => ({
      conf: { enabled: true, totalBudget: 12000, maxLines: 200 }, dir: compileStore,
      report: { tokens: 10, bytes: 40, fileCount: 2, lineCount: 1, linesOver: false, over: [], broken: [],
        unresolved: [], gateSources: 1, gateBodies: ['- Fixture resident instruction.'] },
    }),
    otherStoreGates: (...args) => { census.calls.push(args); return census.answer; },
  });
  try {
    census.answer = { count: 3, stores: [{ name: 'side-store', count: 2 }, { name: 'bare-store', count: 1 }],
      unreadable: ['locked-store'] };
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    const data = ui.posted.at(-1);
    assert.deepEqual(census.calls.at(-1), [compileStore, ['- Fixture resident instruction.']],
      'the census is asked about the store that compiles, with the gate texts it installs');
    assert.deepEqual(data.gates.otherStores, census.answer);
    const line = renderDashboard(app.provider, data).node('mgother');
    assert.equal(line.hidden, false);
    assert.equal(line.textContent, '3 gates in other memory stores are not installed: side-store (2), bare-store (1)'
      + ' · 1 other memory store could not be read: locked-store');
    assert.doesNotMatch(line.textContent, /projects|[\\/]/, 'folder names only, never a path');

    // One gate reads in the singular; none at all hides the line.
    census.answer = { count: 1, stores: [{ name: 'side-store', count: 1 }], unreadable: [] };
    const one = renderDashboard(app.provider, { ...data, gates: { ...data.gates, otherStores: census.answer } }).node('mgother');
    assert.equal(one.textContent, '1 gate in another memory store is not installed: side-store (1)');
    const none = renderDashboard(app.provider,
      { ...data, gates: { ...data.gates, otherStores: { count: 0, stores: [], unreadable: [] } } }).node('mgother');
    assert.deepEqual([none.hidden, none.textContent], [true, '']);
    const unknown = renderDashboard(app.provider, { ...data, gates: { ...data.gates, otherStores: null } }).node('mgother');
    assert.deepEqual([unknown.hidden, unknown.textContent], [true, '']);
  } finally {
    await app.dispose();
  }

  // MUTATION: drop the `otherStores` field from gatesCardData in vscode-extension/extension.js
  // and data.gates.otherStores is undefined; drop the `mgother` block from renderGates and
  // the line stays empty.
});

// `agents:` (2026-10-14): once a gate names the agents it is for, recall.py writes a section per
// agent and each agent installs its own. The card counts each agent, judges ON by the agents
// that have gates, and names a gate memory left out because its agents: cannot be read.
test('the gates card counts each agent once a gate names its agents, and names a left-out gate', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const crypto = require('node:crypto');
  const render = (bodies) => {
    if (!bodies.length) return '';
    const body = bodies.join('\n');
    const sha = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
    return `<!-- generated by recall.py --gates-compile; sha ${sha} -->\n## Standing gates (${bodies.length} memories, managed)\n\n${body}\n`;
  };
  const compiledFile = path.join(env.tempHome, '.claude', 'gates.generated.md');
  const compile = (claude, codex) => {
    const sections = { claude: render(claude), codex: render(codex) };
    fs.writeFileSync(compiledFile, '<!-- generated by recall.py --gates-compile; per agent: '
      + `claude ${Buffer.byteLength(sections.claude)}, codex ${Buffer.byteLength(sections.codex)} -->\n`
      + sections.claude + sections.codex);
    return sections;
  };
  const claude = path.join(env.tempHome, '.claude', 'CLAUDE.md');
  const codex = path.join(env.tempHome, '.codex', 'AGENTS.md');
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  const own = '# Fixture user instructions\n';
  fs.writeFileSync(claude, own);
  fs.writeFileSync(codex, own);
  const excluded = [{ file: 'typo.md', problem: '`agents:` names an agent this compiler does not know: gemini' }];
  const app = harness(env.tempHome, {
    settings: { 'guidance.enabled': false, 'gates.enabled': false },
    memoryReport: () => ({
      conf: { enabled: true, totalBudget: 12000, maxLines: 200 }, dir: null,
      report: { tokens: 10, bytes: 40, fileCount: 3, lineCount: 1, linesOver: false, over: [], broken: [],
        unresolved: [], gateSources: 2, gateBodies: [], gateExcluded: excluded },
    }),
  });
  try {
    const { makeGatesBlock } = require('../src/agent-gates');
    const install = (file, text) => fs.writeFileSync(file, makeGatesBlock(env.tempHome, text.trim()).apply(own, true).text);
    const first = compile(['- Shared.'], ['- Shared.', '- Codex only.']);
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    install(claude, first.claude);
    install(codex, first.codex);
    app.provider.refresh();
    await settle();
    let data = ui.posted.at(-1);
    assert.deepEqual(data.gates.counts, [{ agent: 'claude', count: 1 }, { agent: 'codex', count: 2 }]);
    assert.deepEqual([data.gates.on, data.gates.partial, data.gates.current], [true, false, true]);
    let rendered = renderDashboard(app.provider, data);
    assert.equal(rendered.node('mgtext').textContent, 'Memory gates: ON — Claude 1 · Codex 2');
    assert.equal(rendered.node('stGates').textContent, 'Claude 1 · Codex 2 active');
    const line = rendered.node('mgexcluded');
    assert.equal(line.hidden, false);
    assert.equal(line.textContent, '1 gate memory is left out for every agent, because agents: cannot be read: typo.md');
    assert.match(line.title, /gemini/);

    // Claude's last gate moves to Codex and its block goes: Codex alone is the whole install.
    compile([], ['- Shared.', '- Codex only.']);
    fs.writeFileSync(claude, own);
    app.provider.refresh();
    await settle();
    data = ui.posted.at(-1);
    assert.deepEqual([data.gates.on, data.gates.partial, data.gates.current], [true, false, true],
      'an agent the compile gives no gates is not a missing install');
    assert.deepEqual(data.gates.targets, ['codex']);
    rendered = renderDashboard(app.provider, data);
    assert.equal(rendered.node('mgtext').textContent, 'Memory gates: ON — Claude 0 · Codex 2');

    // A Claude block left behind by the move is the corpus changing, not ON and current.
    install(claude, first.claude);
    app.provider.refresh();
    await settle();
    assert.equal(ui.posted.at(-1).gates.current, false);

    // A compile with no `agents:` key reads as it always did: one count, no per-agent line.
    fs.writeFileSync(compiledFile, render(['- Shared.']));
    install(claude, render(['- Shared.']));
    install(codex, render(['- Shared.']));
    app.provider.refresh();
    await settle();
    data = ui.posted.at(-1);
    assert.equal(data.gates.counts, null);
    assert.equal(renderDashboard(app.provider, data).node('mgtext').textContent, 'Memory gates: ON — 1 gate');
  } finally {
    await app.dispose();
  }

  // MUTATION: in gatesCardData, judge `on` over every state (drop `wanted`) and the Codex-only
  // install reads OFF/PARTIAL; drop `counts` and the card reads "— 2 gates"; drop the mgexcluded
  // block from renderGates and the line stays hidden.
});

// Retire and restore (2026-10-14, rampage e5c0ee7). The card counts the retired gate memories of
// the store the gates panel edits (memoryLint.js gateEntryOf, in the memory report), as a count
// in its line and never as a tone, names each one with the agents a restore returns it to, and
// offers Manage gates… beside the whole-block button.
test('the gates card counts retired gates in its line, names them, and offers Manage gates', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const compiledFile = path.join(env.tempHome, '.claude', 'gates.generated.md');
  fs.writeFileSync(compiledFile, '## Standing gates (1 memories, managed)\n\n- Shared.\n');
  let retired = [{ file: 'feedback_old.md', agents: ['claude', 'codex'], problem: null },
    { file: 'reference_codex_old.md', agents: ['codex'], problem: null }];
  const app = harness(env.tempHome, {
    settings: { 'guidance.enabled': false, 'gates.enabled': false },
    memoryReport: () => ({
      conf: { enabled: true, totalBudget: 12000, maxLines: 200 }, dir: null,
      report: { tokens: 10, bytes: 40, fileCount: 4, lineCount: 1, linesOver: false, over: [], broken: [],
        unresolved: [], gateSources: 1, gateBodies: [], gateExcluded: [], gateRetired: retired },
    }),
  });
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    let data = ui.posted.at(-1);
    assert.deepEqual(data.gates.retired, [{ file: 'feedback_old.md', agents: ['claude', 'codex'] },
      { file: 'reference_codex_old.md', agents: ['codex'] }]);
    let rendered = renderDashboard(app.provider, data);
    // gates.enabled is at its default (on) in this harness, so activation installed the compile.
    assert.match(rendered.node('mgsub').textContent, /^your standing orders, resident every session · .*CLAUDE\.md · 2 retired$/);
    assert.equal(rendered.node('mgsub').title, 'Retired (scope: retired), kept in the store and left out of the compile: '
      + 'feedback_old.md, reference_codex_old.md (codex only). Manage gates restores one.');
    assert.equal(rendered.node('mgdot').className, 'dot', 'the tone is the install\'s, never the retired count\'s');

    // Nothing compiled because every gate is retired: the card says so rather than "no gate block".
    fs.writeFileSync(compiledFile, '');
    app.provider.refresh();
    await settle();
    rendered = renderDashboard(app.provider, ui.posted.at(-1));
    assert.equal(rendered.node('mgsub').textContent, 'no active gate · 2 retired');

    // None retired: no count, and no title.
    retired = [];
    app.provider.refresh();
    await settle();
    data = ui.posted.at(-1);
    rendered = renderDashboard(app.provider, data);
    assert.equal(rendered.node('mgsub').textContent, 'no memory carries a scope:global gate block yet');
    assert.equal(rendered.node('mgsub').title, '');

    // The button is there and asks for the panel by its own arm.
    assert.match(ui.view.webview.html, /<button class="managed-action" id="manageGatesBtn"[^>]*>Manage gates…<\/button>/);
    app.executed.length = 0;
    ui.on.message({ type: 'manageGates' });
    assert.deepEqual(app.executed, ['permission-wildcarding.manageGates']);
  } finally {
    await app.dispose();
  }
  // MUTATION: drop `retired` from gatesCardData and the deepEqual fails on undefined; drop the
  // retired suffix from renderGates and the line reads without "· 2 retired".
});

test('partial Codex instruction installation is reported consistently in cards and collapsed badges', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const claude = path.join(env.tempHome, '.claude', 'CLAUDE.md');
  const codex = path.join(env.tempHome, '.codex', 'AGENTS.md');
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  const own = '# Fixture user instructions\n';
  fs.writeFileSync(claude, own);
  fs.writeFileSync(codex, own);
  fs.writeFileSync(path.join(env.tempHome, '.claude', 'gates.generated.md'),
    '## Standing gates (1 memories, managed)\n- Fixture resident instruction.\n');
  const app = harness(env.tempHome, { settings: { 'guidance.enabled': false, 'gates.enabled': false } });
  try {
    const { applyGuidance } = require('../src/agent-guidance');
    const { makeGatesBlock } = require('../src/agent-gates');
    const installed = makeGatesBlock(env.tempHome).apply(applyGuidance(own, true).text, true).text;
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    for (const state of [
      { claude: false, codex: false, guidance: 'not installed', gates: '1 waiting', body: 'OFF' },
      { claude: false, codex: true, guidance: 'partially installed', gates: '1 partially installed', body: 'PARTIAL' },
      { claude: true, codex: true, guidance: 'on', gates: '1 active', body: 'ON' },
    ]) {
      fs.writeFileSync(claude, state.claude ? installed : own);
      fs.writeFileSync(codex, state.codex ? installed : own);
      app.provider.refresh();
      await settle();
      const data = ui.posted.at(-1);
      const partial = state.claude !== state.codex;
      assert.equal(data.guidance.partial, partial, 'real file discovery must reach the guidance payload');
      assert.equal(data.gates.partial, partial, 'real file discovery must reach the gates payload');
      assert.equal(data.gates.count, 1);
      if (partial) {
        assert.deepEqual(data.guidance.agents, ['codex']);
        assert.deepEqual(data.gates.agents, ['codex']);
      }
      const rendered = renderDashboard(app.provider, data);
      assert.ok(rendered.node('gdtext').textContent.startsWith('Shell-style guidance: ' + state.body));
      assert.ok(rendered.node('mgtext').textContent.startsWith('Memory gates: ' + state.body));
      assert.equal(rendered.node('stGuidance').textContent, state.guidance,
        'WITNESS guidance badge must distinguish partial installation from fully off and on');
      assert.equal(rendered.node('stGates').textContent, state.gates,
        'WITNESS gates badge must distinguish partial installation from fully off and on');
      if (partial) {
        assert.equal(rendered.node('stGuidance').className, 'rowstate warn',
          'WITNESS partial guidance badge must have warning tone');
        assert.equal(rendered.node('stGates').className, 'rowstate warn',
          'WITNESS partial gates badge must have warning tone');
      }
    }
  } finally {
    await app.dispose();
  }
});

// ── the Project-local card ──────────────────────────────────────────────────────
// BACKLOG "The Project-local card reports on a path it did not watch", fixed
// 2026-10-13. localCardData carried its own copy of the folder filter, without the
// trust gate drainableRoots applies, so an untrusted window showed dry-run numbers
// the drain refused to act on. With two or more folders the payload held only the
// bare LOCAL_RELATIVE constant, so the subtitle named no file. Neither showed here,
// because the harness pinned the one shape where both are invisible: a single
// trusted folder. Nothing in the suite rendered the card at all.

// Every outcome against a user scope holding Bash(rg *): dotnet build promotes as
// a family (and its local entry is then pruned under it), rg needle is already
// covered so it is pruned, and the script blob is kept, since only the project
// that approved it can justify it. So promote 1, prune 2, kept 1.
const LOCAL_MIX = ['Bash(dotnet build src/App.csproj)', 'Bash(rg needle)', 'PowerShell($x = 1; ls)'];

function seedLocal(root, allow = LOCAL_MIX) {
  const file = path.join(root, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow } }, null, 2) + '\n');
  return file;
}

// The display form the extension builds under this harness, whose os.homedir()
// is the temp home.
function tilde(tempHome, file) { return file.replace(tempHome, '~'); }

async function localCard(app) {
  const ui = fakeView();
  app.provider.resolveWebviewView(ui.view);
  await settle();
  const data = ui.posted.at(-1);
  return { local: data.local, rendered: renderDashboard(app.provider, data) };
}

test('with two folders open the Project-local card names both files, not the bare file name', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(rg *)'], deny: [] } });
  const files = ['alpha', 'bravo'].map((name) => seedLocal(path.join(env.tempHome, name)));
  // Auto-drain off, so activation leaves both files for the dry run to count.
  const app = harness(env.tempHome, {
    workspaceFolders: files.map((file) => ({ uri: { fsPath: path.dirname(path.dirname(file)) } })),
    settings: { 'localDrain.enabled': false },
  });
  try {
    const { local, rendered } = await localCard(app);
    const shown = files.map((file) => tilde(env.tempHome, file));
    assert.deepEqual(local.files, shown, 'one home-relative path per folder inspected');
    // No `local.folders` since 2026-10-14: the card counts `files`, and the subtitle
    // below ("2 folders") is the assertion on that count that a reader depends on.
    assert.equal('folders' in local, false, 'the unread folder count is not posted');
    assert.equal(local.promote, 2, 'precondition: both folders were dry-run, trusted');

    const sub = rendered.node('locsub');
    assert.equal(sub.textContent, '2 folders · auto-drain off');
    for (const file of shown) {
      assert.ok(sub.title.includes(file), 'the subtitle tooltip names ' + file);
    }
    assert.equal(sub.title.split(' · ').slice(0, 2).join(' · '), shown.join(' · '),
      'the paths are joined on one line, in folder order');
    assert.match(sub.title, /CLI hook/,
      'the tooltip says the hook drains session folders this card cannot list');
  } finally {
    await app.dispose();
  }
});

test('an untrusted window names its Project-local file but shows no dry-run counts, and the drain stays refused', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(rg *)'], deny: [] } });
  const file = seedLocal(path.join(env.tempHome, 'workspace'));
  const before = fs.readFileSync(file, 'utf8');
  // Auto-drain left ON, so activation's own drain pass is the first refusal tested.
  const app = harness(env.tempHome, { isTrusted: false });
  try {
    const { local, rendered } = await localCard(app);
    assert.equal(local.trusted, false);
    assert.deepEqual(local.files, [tilde(env.tempHome, file)], 'the file left alone is still named');
    assert.deepEqual([local.promote, local.prune, local.kept], [null, null, null],
      'no dry run over a workspace the drain will not touch, so no numbers');

    for (const id of ['locpromote', 'locprune', 'lockept']) {
      assert.equal(rendered.node(id).textContent, '–', id + ' shows the placeholder dash, not a count');
    }
    assert.equal(rendered.node('loctext').textContent, 'Project-local approvals: not counted',
      'the headline neither counts nor claims "drained"');
    assert.equal(rendered.node('locsub').textContent,
      'workspace not trusted — read-only · ' + tilde(env.tempHome, file));
    assert.equal(rendered.node('stLocal').textContent, 'workspace not trusted');
    assert.equal(rendered.node('drainLocal').disabled, true);
    assert.equal(rendered.node('drainLocal').textContent, '⤴  Drain into user scope',
      'an uncounted file is not "Nothing to drain"');

    // The gate on the drain itself is unchanged: activation drained nothing, and
    // the command, reachable from the palette with the button disabled, refuses.
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'activation left the untrusted file alone');
    await app.commands.get('permission-wildcarding.drainLocal')();
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a manual drain left it alone too');
    assert.deepEqual(env.read().permissions.allow, ['Bash(rg *)'], 'nothing reached user scope');
    assert.ok(app.statuses.some((message) => message.includes('workspace is not trusted — local drain skipped')),
      'the refusal is said, not silent');
  } finally {
    await app.dispose();
  }
});

// The control for the test above: the same file in a trusted window is counted,
// the single-folder subtitle is the path itself, and the drain does what the
// counts said it would.
test('a trusted window shows the Project-local dry-run counts, and the drain acts on them', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(rg *)'], deny: [] } });
  const file = seedLocal(path.join(env.tempHome, 'workspace'));
  const app = harness(env.tempHome, { settings: { 'localDrain.enabled': false } });
  try {
    const { local, rendered } = await localCard(app);
    assert.equal(local.trusted, true);
    assert.deepEqual([local.promote, local.prune, local.kept], [1, 2, 1]);
    for (const [id, n] of [['locpromote', '1'], ['locprune', '2'], ['lockept', '1']]) {
      assert.equal(String(rendered.node(id).textContent), n, id + ' shows its count');
    }
    assert.equal(rendered.node('loctext').textContent, 'Project-local approvals: 3 to drain');
    assert.equal(rendered.node('locsub').textContent, tilde(env.tempHome, file) + ' · auto-drain off',
      'one folder keeps the path itself as the subtitle');
    assert.equal(rendered.node('drainLocal').disabled, false);
    assert.equal(rendered.node('drainLocal').textContent, '⤴  Drain 3 into user scope');

    await app.commands.get('permission-wildcarding.drainLocal')();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow, ['PowerShell($x = 1; ls)']);
    assert.ok(env.read().permissions.allow.includes('Bash(dotnet build *)'));
  } finally {
    await app.dispose();
  }
});

// The card and the drain take their folders from one function, localRoots. Two
// copies of the filter is how the card came to show numbers for an untrusted
// workspace, and only a folder one copy keeps and the other drops can tell a
// second copy from the first. A non-file folder whose fsPath happens to exist on
// this disk is that folder: the shared filter drops it, the old copy did not.
test('the Project-local card and the drain read one folder filter, so a folder the drain skips is not listed', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: [] } });
  const realFile = seedLocal(path.join(env.tempHome, 'alpha'), ['Bash(dotnet build src/App.csproj)']);
  const virtualFile = seedLocal(path.join(env.tempHome, 'virtual'), ['Bash(dotnet build src/App.csproj)']);
  const virtualBefore = fs.readFileSync(virtualFile, 'utf8');
  const app = harness(env.tempHome, {
    workspaceFolders: [
      { uri: { scheme: 'file', fsPath: path.join(env.tempHome, 'alpha') } },
      { uri: { scheme: 'vscode-vfs', fsPath: path.join(env.tempHome, 'virtual') } },
    ],
    settings: { 'localDrain.enabled': false },
  });
  try {
    assert.ok(fs.existsSync(virtualFile),
      'precondition: the skipped folder HAS a file, so only the filter can be what drops it');
    const { local } = await localCard(app);
    assert.deepEqual(local.files, [tilde(env.tempHome, realFile)], 'the card lists the file-scheme folder only');
    assert.equal(local.promote, 1, 'and counts only it');

    await app.commands.get('permission-wildcarding.drainLocal')();
    assert.deepEqual(JSON.parse(fs.readFileSync(realFile, 'utf8')).permissions.allow, [],
      'the folder the card listed is the folder the drain drained');
    assert.equal(fs.readFileSync(virtualFile, 'utf8'), virtualBefore,
      'and the folder the card left out is the folder the drain left alone');
  } finally {
    await app.dispose();
  }
});
