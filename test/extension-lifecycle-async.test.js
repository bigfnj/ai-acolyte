'use strict';

// deactivate() cleared seven timeouts and an interval and then hoped. A cleared
// timer stops work that has not STARTED; it says nothing about work in flight,
// and this extension has four kinds of it:
//
//   - four execFile children (up to 180s), none of them retained, so nothing
//     could be killed. One of those callbacks chains into ensureGates() →
//     setGatesAll(), i.e. it rewrites the user's CLAUDE.md / AGENTS.md from a
//     torn-down host.
//   - a sticky `deactivating` flag inside the Auto Learn worker runner, whose
//     public API has no reset, retained across a same-realm re-activate — so
//     every later Auto Learn operation rejected, permanently.
//   - `autoLearnBusy` left true, which short-circuits every later scan.
//
// Its own mocks, again: this needs to count spawns, kills and watcher callbacks,
// and the standing decision in this suite (test/extension-activation.test.js:141)
// is that duplicating a mock is cheaper than breaking one that works.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const extensionPath = require.resolve('../vscode-extension/extension');

// node:test has NO default per-test timeout (--test-timeout defaults to Infinity), and every
// test below awaits something the extension is supposed to settle. A regression that leaves
// one of those promises pending therefore hangs the runner instead of failing it: no name, no
// assertion, no output, and on CI a job killed at the job limit with nothing to read. Almost
// every test here is a teardown test, which is exactly the class that produces a pending
// promise when it breaks — the drain has no deadline, so a runner that never settles never
// lets deactivate() resolve. 30s is ~17x the slowest test in this file (1.7s), so it cannot
// fire on a slow box; it only converts a hang into one named failure.
const TEST_TIMEOUT = { timeout: 30000 };

function disposable() { return { dispose() {} }; }

function tick(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Resolves like the real worker: one result message, then exit.
class FakeWorker extends EventEmitter {
  constructor() {
    super();
    setImmediate(() => {
      this.emit('message', { ok: true, result: {} });
      this.emit('exit', 0);
    });
  }

  terminate() { return Promise.resolve(0); }
}

// A worker that never answers, so the scan promise never settles and
// runAutoLearnScan's `finally` never runs. That is the only way to leave the
// busy latch set, which is what the re-activate test needs. `release()` lets the
// test settle it at the end so teardown can complete instead of hanging.
class WedgedWorker extends EventEmitter {
  constructor() {
    super();
    // Whether the runner that owns this worker ever tore it down. A runner
    // dropped from the module slot without deactivate() never terminates its
    // worker, and a leaked thread is otherwise invisible from outside.
    this.terminated = false;
  }

  release() {
    this.emit('message', { ok: true, result: {} });
    this.emit('exit', 0);
  }

  terminate() { this.terminated = true; return Promise.resolve(0); }
}

// A stand-in for node:https that starts no socket. Every request is recorded and the test
// drives the response by hand, because the thing under test is WHICH request a cancel
// reaches — and that is decided by how the redirect follower hands requests back, not by
// anything the network does. `destroy` records and then fires the 'error' handler, which
// is what a real destroyed request does and what carries the failure back to the caller.
function fakeHttps(requests) {
  return {
    get(url, _options, onResponse) {
      const req = {
        url,
        destroyed: false,
        destroyedWith: null,
        timeoutMs: 0,
        handlers: {},
        on(event, cb) { req.handlers[event] = cb; return req; },
        setTimeout(ms, cb) { req.timeoutMs = ms; req.handlers.timeout = cb; return req; },
        destroy(err) {
          req.destroyed = true;
          req.destroyedWith = err || null;
          req.handlers.error?.(err || new Error('socket destroyed'));
        },
        // What the server would have said. Synchronous on purpose: the redirect hop the
        // follower takes in response is exactly the step being observed.
        respond(res) { onResponse(res); },
      };
      requests.push(req);
      return req;
    },
  };
}

// A 3xx that points somewhere else, and the 200 that finally carries the body. The body
// response never emits data, so the transfer stays in flight for the test to cancel.
function redirectTo(location) {
  return { statusCode: 302, headers: { location }, resume() {} };
}

function bodyResponse() {
  return {
    statusCode: 200,
    headers: { 'content-length': String(32 * 1024 * 1024) },
    resume() {},
    on() {},
    pipe() {},
  };
}

function harness(tempHome, options = {}) {
  const commands = new Map();
  const watchers = [];
  const spawns = [];
  const configListeners = [];
  // Every setInterval the extension arms, so a test can assert that a torn-down
  // host armed NONE. resetAutoLearnTimer's 5-minute interval is the one that
  // matters: armed after deactivate() cleared the handle, nothing ever clears it.
  const intervals = [];
  // Every worker the extension asks for, so a test can assert that one was NOT
  // built. "Did it refuse" is not observable from the error message alone:
  // the runner's own guard produces the same text.
  const workers = [];
  const statuses = [];
  const errors = [];
  const infos = [];
  const warnings = [];
  // Every https.get the extension made, newest last, and every withProgress run with the
  // cancellation callbacks its task registered. Both exist for the model download: the
  // redirect follower builds one request per hop and only the last is live.
  const httpsRequests = [];
  const progressRuns = [];
  const settings = { ...(options.settings || {}) };
  // The status-bar items the extension asked for, with a disposed flag. VS Code disposes
  // the item through context.subscriptions after deactivate() resolves, and whether
  // anything paints it AFTERWARDS is the only observable for the teardown guard.
  const statusBarItems = [];
  // The stores discoverDirs reports, MUTABLE so a test can make one appear or vanish the
  // way a new project slug does, and the conf each call was handed.
  const memoryDirs = options.memoryDir ? [options.memoryDir] : [];
  const discoverCalls = [];
  // Whatever extension.js registered through MemoryLint.onReconcile, so a test can drive
  // the linter's cadence without running the real linter.
  const reconcilers = [];
  // Everything pushed into context.subscriptions, so a test can do what VS Code does after
  // deactivate() and drain them.
  const subscriptions = [];
  let provider = null;

  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    RelativePattern: class RelativePattern {
      constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      executeCommand() {},
    },
    window: {
      createStatusBarItem() {
        const item = {
          disposed: false, paintsAfterDispose: 0,
          text: '', tooltip: '', backgroundColor: undefined,
          hide() {},
          show() { if (item.disposed) item.paintsAfterDispose += 1; },
          dispose() { item.disposed = true; },
        };
        statusBarItems.push(item);
        return item;
      },
      createOutputChannel() { return { appendLine() {}, clear() {}, show() {}, dispose() {} }; },
      // CAPTURED. Whether a push reaches the webview is the only way to see
      // that `dashboard` still points at the live provider — the other
      // observable effects of a refresh happen with or without it.
      registerWebviewViewProvider(_id, instance) { provider = instance; return disposable(); },
      setStatusBarMessage(message) { statuses.push(String(message)); },
      showErrorMessage(message) { errors.push(String(message)); },
      showInformationMessage(message) { infos.push(String(message)); return Promise.resolve(undefined); },
      showWarningMessage(message) { warnings.push(String(message)); return Promise.resolve(options.warningChoice); },
      // CAPTURED, not stubbed. The model download is the extension's only cancellable
      // progress, and whether Cancel reaches the request that is actually transferring is
      // unobservable unless the token handed to the task is retained.
      withProgress(progressOptions, task) {
        const cancels = [];
        progressRuns.push({ options: progressOptions, cancels });
        return task(
          { report() {} },
          { onCancellationRequested(cb) { cancels.push(cb); return disposable(); } }
        );
      },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
      createFileSystemWatcher(pattern) {
        const handlers = { change: [], create: [], delete: [] };
        const watcher = {
          pattern, disposed: false,
          onDidChange(cb) { handlers.change.push(cb); return disposable(); },
          onDidCreate(cb) { handlers.create.push(cb); return disposable(); },
          onDidDelete(cb) { handlers.delete.push(cb); return disposable(); },
          dispose() { watcher.disposed = true; },
          fire(kind, argument) { for (const cb of handlers[kind]) cb(argument); },
        };
        watchers.push(watcher);
        return watcher;
      },
      getConfiguration() {
        return {
          get: (key, fallback) => (key in settings ? settings[key] : fallback),
          inspect: () => ({}),
          update: async (key, value) => { settings[key] = value; },
        };
      },
      // CAPTURED, not stubbed. A no-op here is why nothing in this file could
      // reach ensureGuidance, scheduleAutoLearn or resetAutoLearnTimer — all
      // three are driven by configuration changes, and all three were missed by
      // the lifecycle guard pass precisely because no test could see them.
      onDidChangeConfiguration(cb) { configListeners.push(cb); return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };

  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => tempHome };
    if (request === 'https' && parent?.filename === extensionPath) return fakeHttps(httpsRequests);
    if (request === 'fs' && parent?.filename === extensionPath) return fsHidingRecallModel(fs);
    if (request === 'child_process' && parent?.filename === extensionPath) {
      // Every spawn is captured with the ChildProcess handle the extension gets
      // back, so a test can assert what deactivate did to it and then deliver
      // the callback the way a real child would on its way out.
      return {
        execFile(file, args, execOptions, callback) {
          const child = {
            kills: 0,
            on() {},
            kill() { child.kills += 1; return true; },
          };
          spawns.push({ file, args, options: execOptions, callback, child });
          return child;
        },
      };
    }
    if (request === './autoLearnWorkerRunner' && parent?.filename === extensionPath) {
      // The real runner — the sticky `deactivating` flag is the thing under test
      // — driven by a fake worker so no thread is started.
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        createAutoLearnWorkerRunner: (runnerOptions) => real.createAutoLearnWorkerRunner({
          ...runnerOptions,
          workerFactory: () => {
            const worker = options.wedgeWorker ? new WedgedWorker() : new FakeWorker();
            workers.push(worker);
            return worker;
          },
        }),
      };
    }
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class MemoryLint {
          activate() {}

          // CAPTURED. extension.js hangs its two memory-store watcher sets off this hook
          // instead of arming a third timer, so this is the only way a test can drive a
          // reconcile without running the real linter.
          onReconcile(fn) {
            reconcilers.push(fn);
            return { dispose: () => { reconcilers.splice(reconcilers.indexOf(fn), 1); } };
          }
        },
        // Load-bearing, unlike the cfg stub in the six harnesses that return
        // `discoverDirs: () => []`: this one really does build watchers, so a missing cfg
        // makes discoverDirs(memoryConf()) throw inside the watcher try/catch and both
        // watchers vanish. The MEMORY.md watcher test below is what catches that.
        //
        // `dir` is the PIN, and it is set whenever the harness has a memory dir, so the
        // conf recorded in discoverCalls below can prove the watchers strip it.
        cfg: () => ({
          enabled: true,
          dir: options.memoryDir || '',
          lineBudget: 300,
          totalBudget: 12000,
          maxLines: 200,
        }),
        memoryReport: () => {
          // One reachable thrower inside autoSyncRecallIfStale's try, so the catch can be
          // made to run on demand. recallIndexStatus is NOT one: it is internally
          // try/caught at every fs call in src/recall-index.js.
          if (options.memoryReportThrows) throw new Error('memory store unreadable');
          return memoryDirs.length
            ? {
              conf: {
                enabled: true, dir: memoryDirs[0], lineBudget: 300, totalBudget: 12000,
                maxLines: 200,
              },
              dir: memoryDirs[0],
              report: {
                tokens: 10, bytes: 40, fileCount: 1, over: [], broken: [], unresolved: [],
              },
            }
            : { conf: {}, dir: null, report: null };
        },
        discoverDirs: (conf) => { discoverCalls.push(conf); return [...memoryDirs]; },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // Not just the extension: the shared src/ modules capture `os` at require
  // time, and their exported helpers default to `os.homedir()` at CALL time — so
  // a second harness in the same file would keep resolving the FIRST harness's
  // mocked home, look for instruction files in a directory that no longer
  // exists, and pass by testing nothing.
  const purge = () => {
    const extensionDir = path.dirname(extensionPath) + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(rootSrc + path.sep) || key.startsWith(extensionDir)) {
        delete require.cache[key];
      }
    }
  };

  const originalSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => {
    const handle = originalSetInterval(fn, ms);
    if (typeof handle?.unref === 'function') handle.unref();
    intervals.push({ fn, ms, handle });
    return handle;
  };

  purge();
  const extension = require(extensionPath);
  extension.activate({ subscriptions });
  return {
    commands,
    discoverCalls,
    errors,
    extension,
    httpsRequests,
    infos,
    progressRuns,
    warnings,
    memoryDirs,
    reconcilers,
    settings,
    statusBarItems,
    subscriptions,
    intervals,
    watchers,
    // Mutable, so a test can change a setting the way the Settings UI does and
    // then fire the configuration listener.
    settings,
    get provider() { return provider; },
    spawns,
    statuses,
    workers,
    // Fire a configuration change the way VS Code does, so the handlers behind
    // it are reachable.
    fireConfigChange(section) {
      const event = { affectsConfiguration: (key) => String(section).startsWith(key) };
      for (const cb of configListeners) cb(event);
    },
    watcherFor(name) {
      const hit = watchers.find((watcher) => watcher.pattern?.pattern === name);
      assert.ok(hit, `no watcher registered for ${name}`);
      return hit;
    },
    // Every watcher ever built over one store dir, disposed ones included. A reconcile is
    // judged on both halves — what it created and what it released — so the list must not
    // forget the dead ones.
    watchersIn(dir) {
      return watchers.filter((watcher) => watcher.pattern?.base?.fsPath === dir);
    },
    watcherIn(dir, name) {
      const hit = watchers.find((watcher) => watcher.pattern?.base?.fsPath === dir
        && watcher.pattern?.pattern === name && !watcher.disposed);
      assert.ok(hit, `no live ${name} watcher for ${dir}`);
      return hit;
    },
    // What the memory linter's 5-minute backstop, and every MEMORY.md event, does.
    fireMemoryReconcile() {
      assert.ok(reconcilers.length > 0, 'nothing subscribed to the memory reconcile');
      for (const fn of reconcilers) fn();
    },
    // What VS Code does after deactivate() resolves.
    disposeSubscriptions() {
      for (const item of subscriptions) {
        if (typeof item?.dispose === 'function') item.dispose();
      }
    },
    reactivate() { extension.activate({ subscriptions: [] }); },
    // Always, even when a test already deactivated to observe the teardown: a
    // second call is a no-op, and an activation left running keeps a
    // reconciliation interval alive and the test process with it.
    async dispose() {
      await extension.deactivate();
      for (const entry of intervals) clearInterval(entry.handle);
      global.setInterval = originalSetInterval;
      Module._load = originalLoad;
      purge();
    },
  };
}

// console.error is the house channel for "this ran degraded". A test that asserts a
// failure was RECORDED has to read it, because a swallowed throw and a logged one are
// otherwise byte-identical from outside.
function captureConsoleError(t) {
  const messages = [];
  const original = console.error;
  console.error = (...args) => { messages.push(args.map((a) => String(a)).join(' ')); };
  t.after(() => { console.error = original; });
  return messages;
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-lifecycle-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(rg *)'], deny: [] } }, null, 2) + '\n');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// A memory dir with something embeddable in it and no cache, which is what makes
// the recall index read as stale and lets the background sync spawn.
function memoryCorpus(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-memory-'));
  fs.writeFileSync(path.join(dir, 'note.md'), '# note\n\nsomething to embed\n');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# index\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The two passive probes recall spawns are gated on, satisfied with empty files
// so the gate opens on any platform and nothing real is ever executed.
// `model: false` leaves the vocab in place and the .onnx out, which is the state that
// makes rebuildRecall offer the download instead of spawning python. recallModelDir()
// requires BOTH files in one dir, so a vocab-only dir reads as model-missing while
// recallVocabSource() still finds something to seed from — the real first-run shape.
// Set while a test has asked for a box with NO bge-small. See fakeRecallEnvironment.
let recallModelHidden = null;

// `recallModelCandidates()` probes SIX directories, and setting RECALL_MODEL_DIR
// neutralises exactly one of them. Two of the rest are resolved from extension.js's own
// __dirname, so on a checkout that has ever run the Python tool, `<repo>/memory/models`
// holds a real 34 MB bge-small and the extension correctly decides no download is needed.
//
// That made the download tests pass on CI and on a fresh clone, and fail on the machine
// this feature was built on, with `reqs: 0` and a progress task that had already started.
// The precondition assert is what caught it rather than the tests quietly proving nothing.
//
// Hiding only the MODEL file, and only outside the test's own dir, is the narrow version:
// the vocab still resolves (fakeRecallEnvironment always writes one, and RECALL_MODEL_DIR
// is probed first), so recallVocabSource() keeps working and only the "is there a usable
// model" answer changes.
// Set by the stub below when the extension unlinks the download's `.tmp`, recording
// whether the write stream's close() had COMPLETED at that moment.
//
// This is the observable, rather than "is the file gone afterwards". The defect is a race:
// unlinking beside an async close() while the handle is open. On Windows that is EPERM into
// a swallowing catch and the partial file survives; on Linux, and on Windows under some node
// versions, the unlink happens to succeed and the bug is invisible. Asserting the leftover
// file therefore passes on the machine you are developing on and fails only on one CI leg,
// which is how this shipped in the first place. Asserting the ORDER fails everywhere.
let tmpUnlinkObserved = null;

function fsHidingRecallModel(realFs) {
  let tmpStreamClosed = false;
  return {
    ...realFs,
    createWriteStream(target, ...rest) {
      const stream = realFs.createWriteStream(target, ...rest);
      if (String(target).endsWith('.tmp')) {
        tmpStreamClosed = false;
        tmpUnlinkObserved = null;
        const realClose = stream.close.bind(stream);
        // Always pass a callback, even when the caller gave none, so the flag flips on the
        // same tick node would have called the caller's own callback on.
        stream.close = (cb) => realClose(() => { tmpStreamClosed = true; if (cb) cb(); });
      }
      return stream;
    },
    unlinkSync(target) {
      if (String(target).endsWith('.tmp')) tmpUnlinkObserved = { closedFirst: tmpStreamClosed };
      return realFs.unlinkSync(target);
    },
    existsSync(target) {
      if (recallModelHidden) {
        const resolved = path.resolve(String(target));
        if (path.basename(resolved) === 'bge-small.onnx'
            && !resolved.startsWith(recallModelHidden)) return false;
      }
      return realFs.existsSync(target);
    },
  };
}

function fakeRecallEnvironment(t, { model = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-toolbox-'));
  const python = path.join(root, 'python', '.venv', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, '');
  const models = path.join(root, 'models');
  fs.mkdirSync(models, { recursive: true });
  if (model) fs.writeFileSync(path.join(models, 'bge-small.onnx'), '');
  fs.writeFileSync(path.join(models, 'bge-small.vocab.txt'), '');
  const previous = { toolbox: process.env.CODEX_TOOLBOX, models: process.env.RECALL_MODEL_DIR };
  process.env.CODEX_TOOLBOX = root;
  process.env.RECALL_MODEL_DIR = models;
  // A model-free box means model-free EVERYWHERE the extension looks, not just here.
  if (!model) recallModelHidden = path.resolve(models);
  t.after(() => {
    recallModelHidden = null;
    if (previous.toolbox === undefined) delete process.env.CODEX_TOOLBOX;
    else process.env.CODEX_TOOLBOX = previous.toolbox;
    if (previous.models === undefined) delete process.env.RECALL_MODEL_DIR;
    else process.env.RECALL_MODEL_DIR = previous.models;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { python };
}

test('a python child that outlives the extension is killed, and says nothing after', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const corpus = memoryCorpus(t);
  fakeRecallEnvironment(t);
  const app = harness(home, { memoryDir: corpus });
  try {
    // A MEMORY.md write is what schedules the background recall sync (memBounce,
    // 350ms), and the sync is the cheapest of the four spawn sites to reach.
    app.watcherFor('MEMORY.md').fire('change', { fsPath: path.join(corpus, 'MEMORY.md') });
    await tick(450);
    assert.equal(app.spawns.length, 1, 'the sync spawned recall.py');
    const spawn = app.spawns[0];
    assert.ok(spawn.args.includes('--list'), 'the background sync is the incremental build');
    assert.equal(spawn.child.kills, 0);

    await app.extension.deactivate();
    assert.equal(spawn.child.kills, 1, 'deactivate kills the child it started');

    // What the kill actually produces: the callback still fires. It must not
    // report, and it must not push to a dashboard that is being torn down.
    app.statuses.length = 0;
    app.errors.length = 0;
    spawn.callback(Object.assign(new Error('Command failed'), { signal: 'SIGTERM' }), '', '');
    spawn.callback(null, '', '');
    assert.deepEqual(app.statuses, [], 'a torn-down extension reports nothing');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.dispose();
  }
});

// The behavioural test above covers one of the four sites. This covers the other
// three cheaply, and fails when a fifth spawn is added without retaining it.
test('every execFile in the extension hands its child over to be killable', () => {
  const source = fs.readFileSync(extensionPath, 'utf8');
  const spawns = source.match(/(?<![\w.])execFile\(/g) || [];
  const tracked = source.match(/trackChild\(execFile\(/g) || [];
  assert.equal(spawns.length, 4, 'the four known spawn sites');
  assert.equal(tracked.length, 4, 'each one retained via trackChild, or deactivate cannot kill it');
});

// memoryLint.cfg() is the single enumeration of the permissionWildcarding.memory.* keys.
// Two hand-built copies used to live at the memory-card and gates watcher sites, and both
// were wrong in the same two ways: they passed `dir: ''` so a pinned memory.dir was ignored,
// and they had already fallen a key behind when `maxLines` was added to cfg().
//
// Both assertions below are NEGATIVES, which is the only source shape worth pinning: that
// no second copy of the configuration exists, and that no second, unreconciled discovery
// site exists. What the surviving site DOES is covered behaviourally by the reconcile tests
// further down, which read the conf each call was handed.
test('extension.js keeps no second copy of the memory configuration', () => {
  const source = fs.readFileSync(extensionPath, 'utf8');
  // `lineBudget` appears nowhere else in extension.js, so its mere presence means a literal
  // is back. `totalBudget` does appear as a property read, hence the `: <digit>` which only
  // matches an object literal assigning it.
  assert.equal(/lineBudget/.test(source), false, 'a hand-built memory conf is back');
  assert.equal(/totalBudget:\s*\d/.test(source), false, 'a hand-built memory conf is back');
  // ONE call site, inside memoryStoreDirs(). It used to be two loops, each enumerating the
  // stores once at activation and never again. A second call site is a second watcher set
  // that no reconcile rebuilds, which is exactly the defect that was fixed.
  assert.equal((source.match(/discoverDirs\(/g) || []).length, 1,
    'a second, unreconciled memory-store discovery is back');
});

// `updateStatusBar` opened with `if (!statusBar) return;`, and that condition could not be
// false after the first activation: the slot is assigned once and nulled nowhere, including
// in deactivate(), which nulls seven other retainers. It is worse than dead. activate()
// pushes the item into context.subscriptions, so VS Code disposes it on teardown while the
// variable stays truthy — the guard passed on precisely the state it looks like it exists
// to catch.
test('a watcher event after teardown does not repaint a disposed status-bar item', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const app = harness(home);
  try {
    const [item] = app.statusBarItems;
    assert.ok(item, 'precondition: activation created the friction indicator');
    assert.equal(item.disposed, false);

    await app.extension.deactivate();
    // What VS Code does next, and what `!statusBar` could never see.
    app.disposeSubscriptions();
    assert.equal(item.disposed, true, 'precondition: the host disposed the item');

    // The Codex config watcher is one of five handlers that call updateStatusBar()
    // unconditionally, and every one of them stays live until the subscriptions drain.
    item.paintsAfterDispose = 0;
    app.watcherFor('config.toml').fire('change', { fsPath: 'config.toml' });

    assert.equal(item.paintsAfterDispose, 0,
      'a torn-down extension repainted a status-bar item VS Code had already disposed');
  } finally {
    await app.dispose();
  }
});

// autoSyncRecallIfStale ended in `} catch { /* auto-sync is best-effort */ }` with no
// logging at all. Three reachable throwers sit inside that try — memoryReport(),
// recallStatus() and cfg() — and it is not a one-shot: the 10 s startup timer is, but
// memBounce re-enters on every MEMORY.md write, so a deterministic throw recurred silently
// on every trigger and a broken run logged identically to a working one.
test('a throw inside the background recall sync is recorded, not swallowed', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const corpus = memoryCorpus(t);
  fakeRecallEnvironment(t);
  const logged = captureConsoleError(t);
  const app = harness(home, { memoryDir: corpus, memoryReportThrows: true });
  try {
    logged.length = 0;
    app.watcherFor('MEMORY.md').fire('change', { fsPath: path.join(corpus, 'MEMORY.md') });
    await tick(450);

    assert.equal(app.spawns.length, 0, 'precondition: the throw came before the spawn');
    assert.ok(
      logged.some((m) => /auto recall sync/.test(m) && /memory store unreadable/.test(m)),
      'the recall index can stop syncing for the life of the window with no trace anywhere; '
      + `saw: ${JSON.stringify(logged)}`,
    );
  } finally {
    await app.dispose();
  }
});

// The two memory-store watcher sets were built once inside activate() and never revisited.
// Claude Code derives the project slug from the working directory, so a session launched
// from a different root mints a new store — unwatched until a window reload, which for the
// *.md set means automatic gate recompilation simply does not see it.
test('a memory store that appears later is watched without a window reload', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const first = memoryCorpus(t);
  const second = memoryCorpus(t);
  fakeRecallEnvironment(t);
  const app = harness(home, { memoryDir: first });
  try {
    assert.equal(app.watchersIn(second).length, 0,
      'precondition: the second store did not exist at activation');

    // This harness PINS memory.dir, and the store discovery must strip it: the pin answers
    // "which store do I lint", not "which stores exist". Passing it through made
    // discoverDirs return [] for a pin with no MEMORY.md, which built zero watchers and
    // silently stopped gate recompilation, since the *.md watcher is one of only two
    // compileGates callers.
    assert.ok(app.discoverCalls.length > 0, 'precondition: the watchers discovered at all');
    assert.ok(app.discoverCalls.every((conf) => conf.dir === ''),
      'a pinned memory.dir reached the store discovery');
    assert.ok(app.discoverCalls.every((conf) => conf.maxLines === 200),
      'the rest of the live configuration must arrive intact, not as a hand-built literal');

    app.memoryDirs.push(second);
    app.fireMemoryReconcile();

    assert.deepEqual(app.watchersIn(second).map((w) => w.pattern.pattern).sort(),
      ['*.md', 'MEMORY.md'],
      'both sets have to follow a new store, not only the Memory card');

    // Wired, not merely created. An edit in the new store has to reach the work the
    // watcher exists to trigger.
    app.watcherIn(second, 'MEMORY.md').fire('change', { fsPath: path.join(second, 'MEMORY.md') });
    await tick(450);
    assert.equal(app.spawns.length, 1, 'the new store’s watcher is connected to nothing');
  } finally {
    await app.dispose();
  }
});

test('a memory store that goes away leaves no watcher behind', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const first = memoryCorpus(t);
  const second = memoryCorpus(t);
  const app = harness(home, { memoryDir: first });
  try {
    app.memoryDirs.push(second);
    app.fireMemoryReconcile();
    const built = app.watchersIn(second);
    assert.equal(built.length, 2, 'precondition: the second store was watched');

    // The store moves to a new slug, or the project is deleted.
    app.memoryDirs.splice(app.memoryDirs.indexOf(second), 1);
    app.fireMemoryReconcile();

    assert.equal(built.filter((w) => !w.disposed).length, 0,
      'a dead watcher was left holding a directory that no longer exists');
    assert.equal(app.watchersIn(second).length, 2,
      'and nothing rebuilt a watcher for a store that is gone');

    // Idempotent. A reconcile every 5 minutes that replaced every watcher each time would
    // churn handles for the life of the window and lose queued events with them.
    const before = app.watchersIn(first).filter((w) => !w.disposed);
    app.fireMemoryReconcile();
    const after = app.watchersIn(first).filter((w) => !w.disposed);
    assert.equal(after.length, before.length);
    assert.ok(after.every((w, i) => w === before[i]),
      'a reconcile that changes nothing must keep the watchers it already has');
  } finally {
    await app.dispose();
  }
});

test('a reconcile after teardown builds nothing, and the disposer drains what is left', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const first = memoryCorpus(t);
  const second = memoryCorpus(t);
  const app = harness(home, { memoryDir: first });
  try {
    await app.extension.deactivate();

    // The real window: the linter's own debounce and its 5-minute interval both survive
    // deactivate() until VS Code drains the subscriptions, so a reconcile can still arrive
    // here — into maps nothing would ever drain again.
    app.memoryDirs.push(second);
    app.fireMemoryReconcile();
    assert.equal(app.watchersIn(second).length, 0,
      'a torn-down host built a watcher per discovered store');

    app.disposeSubscriptions();
    assert.equal(app.watchersIn(first).filter((w) => !w.disposed).length, 0,
      'the single disposer must release whatever the reconcile currently holds');
  } finally {
    await app.dispose();
  }
});

test('a gate refresh cannot rewrite the instruction files after deactivate', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const userText = '# My global instructions\n\nAlways use the toolbox python.\n';
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, userText);
  fs.writeFileSync(
    path.join(home, '.claude', 'gates.generated.md'),
    '## Standing gates (1 memories, managed)\n\n- **File edits.** Apply directly.\n');

  const app = harness(home, { settings: { 'gates.enabled': true } });
  try {
    // Precondition: this is a live gates install, so a post-deactivate write is
    // something the guard prevents rather than something nothing was doing.
    assert.notEqual(fs.readFileSync(claudeMd, 'utf8'), userText,
      'activation installed the managed block');

    fs.writeFileSync(claudeMd, userText);
    await app.extension.deactivate();

    // The compiled-gates watcher is the reachable half of the worst of the four:
    // the compile callback lands here too, and this is what writes.
    app.watcherFor('gates.generated.md').fire('change', { fsPath: 'gates.generated.md' });
    assert.equal(fs.readFileSync(claudeMd, 'utf8'), userText,
      'a torn-down extension must not touch the user\'s instruction file');
  } finally {
    await app.dispose();
  }
});

test('the Auto Learn busy latch does not survive a teardown', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true } });
  try {
    // Deactivate with a scan in flight. The latch is set synchronously and the
    // scan then yields, which is the window a reload lands in.
    const inFlight = app.commands.get('permission-wildcarding.autoLearnScan')();
    await app.extension.deactivate();

    app.reactivate();
    app.statuses.length = 0;

    // Deliberately not awaited before the assertion: "already running" is
    // emitted synchronously, and letting the abandoned scan settle first would
    // clear the latch for us and hide the defect.
    const second = app.commands.get('permission-wildcarding.autoLearnScan')();
    assert.ok(!app.statuses.some((message) => message.includes('already running')),
      'the busy latch did not survive the teardown');

    await second;
    await inFlight;
  } finally {
    await app.dispose();
  }
});

test('a same-realm re-activate gets a fresh Auto Learn worker runner', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true } });
  try {
    // A completed scan, so the runner instance exists and deactivate really
    // drains and flags it — `deactivating` is sticky and {run, deactivate,
    // stats} offers no way back.
    await app.commands.get('permission-wildcarding.autoLearnScan')();
    await app.extension.deactivate();

    app.reactivate();
    app.errors.length = 0;
    app.infos.length = 0;
    await app.commands.get('permission-wildcarding.autoLearnScan')();

    assert.ok(!app.errors.some((message) => /deactivating/.test(message)),
      'a retained runner rejects every later operation, forever');
    assert.ok(app.infos.some((message) => message.startsWith('Auto Learn:')),
      'the scan after re-activation actually ran');
  } finally {
    await app.dispose();
  }
});

test('an Auto Learn operation arriving after deactivate does not start a worker', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true } });
  try {
    await app.extension.deactivate();
    app.errors.length = 0;
    app.workers.length = 0;

    // The late arrival. A bounce timer that had already fired, a watcher
    // callback mid-flight, or a webview message all reach this the same way.
    await app.commands.get('permission-wildcarding.autoLearnScan')();

    // The whole point. deactivate() nulls the runner so a same-realm
    // re-activate can get a working one, which means the runner's own sticky
    // `deactivating` flag is GONE by the time a late call arrives — the empty
    // slot just gets refilled with a fresh runner that has never heard of the
    // teardown. Without a guard at the extension level, this starts a real
    // Worker that writes settings.json, the claims registry and the Codex
    // rules file, against a host that is no longer there.
    assert.equal(app.workers.length, 0,
      'a worker was started after teardown');
    assert.ok(app.errors.some((message) => /deactivating/.test(message)),
      'and the caller is told why, rather than seeing a silent empty result');
  } finally {
    await app.dispose();
  }
});

// A list the pass WOULD rewrite, written AFTER activation. Two points, both
// learned the hard way:
//   - activate() runs the wildcarding pass synchronously and writes, so a
//     fixture placed before it is already a fixed point by the time a watcher
//     event arrives, and the pass then writes nothing whether it ran or not.
//   - `Bash(rg *)`, tempHome's default, is a fixed point to begin with.
// With either of those, "nothing was written" is true for the wrong reason and
// the test passes with the guards removed. It did.
const UNGENERALIZED = JSON.stringify({
  permissions: { allow: ['Bash(git status --short)', 'Bash(git status --long)'], deny: [] },
}, null, 2) + '\n';

test('a settings.json change is acted on while the extension is live', TEST_TIMEOUT, async (t) => {
  // The control. Without it, the teardown test below cannot distinguish "the
  // guard stopped the write" from "there was no write to stop".
  const home = tempHome(t);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const app = harness(home, { settings: { 'autoLearn.enabled': true } });
  try {
    fs.writeFileSync(settingsPath, UNGENERALIZED);
    app.watcherFor('settings.json').fire('change', { fsPath: settingsPath });
    await tick(1200);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(after.permissions.allow, ['Bash(git status *)'],
      'the live extension generalizes on a settings.json event');
  } finally {
    await app.dispose();
  }
});

test('a watcher event during deactivate cannot re-arm a cleared timer', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const app = harness(home, { settings: { 'autoLearn.enabled': true } });
  try {
    // deactivate() sets the flag, clears the timers, and then AWAITS the Auto
    // Learn drain — which by deliberate decision has no deadline. Every watcher
    // is live across that await, and a window reload is exactly when Claude
    // Code is rewriting settings.json.
    const teardown = app.extension.deactivate();
    fs.writeFileSync(settingsPath, UNGENERALIZED);
    app.watcherFor('settings.json').fire('change', { fsPath: settingsPath });
    app.watcherFor('.claude/settings.local.json').fire('change', { fsPath: settingsPath });
    await teardown;

    // Past the 400 ms wildcarding debounce, the 900 ms local drain and the
    // 1500 ms policy check. If any of them armed, it has fired.
    await tick(1700);

    assert.equal(fs.readFileSync(settingsPath, 'utf8'), UNGENERALIZED,
      'a torn-down extension host wrote the user\u2019s settings.json');
  } finally {
    await app.dispose();
  }
});


test('a configuration change after teardown does not rewrite the instruction files', TEST_TIMEOUT, async (t) => {
  // ensureGates was guarded in the lifecycle pass; ensureGuidance, its twin, was
  // not — and it writes ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md. The
  // configuration listener stays live until VS Code disposes the subscriptions,
  // which happens AFTER deactivate() resolves, so a flip landing in that window
  // reached setGuidanceAll from a torn-down host. Measured before the fix:
  // CLAUDE.md went from 1802 bytes to 24, the managed block simply deleted.
  //
  // This is the axis the file could not test at all, because the harness stubbed
  // onDidChangeConfiguration to a no-op.
  //
  // The setting must genuinely CHANGE. My first version fired the event with the
  // value unchanged, which leaves ensureGuidance with nothing to do — so
  // removing the guard was invisible and the mutant survived. Flipping to false
  // is what makes it want to REMOVE the block.
  const home = tempHome(t);
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, '# my own notes\n\nnothing managed here yet\n');

  const app = harness(home, { settings: { 'guidance.enabled': true } });
  try {
    // After activation, which calls ensureGuidance() itself and legitimately
    // installs the block.
    const before = fs.readFileSync(claudeMd, 'utf8');
    assert.match(before, /BEGIN permission-wildcarding/, 'activation installed the block');

    await app.extension.deactivate();
    app.settings['guidance.enabled'] = false;   // the flip a user makes
    app.fireConfigChange('permissionWildcarding.guidance.enabled');
    await tick(300);

    assert.equal(fs.readFileSync(claudeMd, 'utf8'), before,
      'a torn-down host removed the managed block from the user\u2019s instruction file');
  } finally {
    await app.dispose();
  }
});
test('a configuration change after teardown arms no Auto Learn timer', TEST_TIMEOUT, async (t) => {
  // scheduleAutoLearn and resetAutoLearnTimer were the two schedulers the guard
  // pass missed. resetAutoLearnTimer is the worse of the two: it arms a
  // 5-minute setInterval, and one armed after deactivate() has cleared the
  // handle is never cleared by anything. Each tick then bumps
  // autoLearnFailureCount and autoLearnNextRetryAt, driving the retry backoff to
  // its 60-minute ceiling, so a same-realm re-activate inherits an Auto Learn
  // that looks enabled and does nothing.
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true } });
  try {
    await app.extension.deactivate();
    const armedBefore = app.intervals.length;

    app.fireConfigChange('permissionWildcarding.autoLearn.enabled');
    await tick(50);

    assert.equal(app.intervals.length, armedBefore,
      'a torn-down host armed a periodic Auto Learn scan that nothing will clear');
  } finally {
    await app.dispose();
  }
});

test('a re-activate during the drain keeps its own dashboard and memory lint', TEST_TIMEOUT, async (t) => {
  // The drain has no deadline by deliberate decision. If the host's deactivate
  // timeout expires and a same-realm activate() runs during it, the OLD
  // deactivate's continuation resumes — and it used to null `dashboard` and
  // `memoryLint`, slots the SUCCESSOR had already populated.
  //
  // Measured before the fix: 0 pushes reached the successor's live webview
  // through the module slot, while calling refresh() on the instance directly
  // still produced one. The panel rendered and its buttons worked, so nothing
  // looked broken — every one of the ~35 `dashboard?.refresh()` call sites was
  // simply a permanent no-op for the life of the window, and
  // `memoryLint?.reconfigure()` likewise, which is verbatim the defect
  // reconfigure() was added to fix.
  //
  // The observable has to be a PUSH. My first version asserted that a watcher
  // event still generalized settings.json, which runWildcarding does with or
  // without `dashboard` — so the mutant survived. Only the webview can see it.
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true } });
  try {
    // A completed scan, so a runner exists and deactivate really awaits a drain.
    await app.commands.get('permission-wildcarding.autoLearnScan')();

    const teardown = app.extension.deactivate();
    // The overlap: a fresh activation while the drain is still pending.
    app.reactivate();
    await teardown;

    // Attach a webview to the successor's provider and ask for a push.
    const posted = [];
    const view = {
      visible: true,
      webview: {
        options: null, html: '',
        postMessage: (message) => { posted.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: () => ({ dispose() {} }),
      },
      onDidDispose: () => ({ dispose() {} }),
      onDidChangeVisibility: () => ({ dispose() {} }),
    };
    assert.ok(app.provider, 'the successor registered a provider');
    app.provider.resolveWebviewView(view);
    await tick(200);
    const afterAttach = posted.length;
    assert.ok(afterAttach > 0, 'attaching the view pushes once, directly on the instance');

    // Now drive a refresh through the MODULE-LEVEL slot, which is the only thing
    // the nulling breaks. resolveWebviewView above calls _push() on the instance
    // and succeeds even with `dashboard` null — that is exactly why the first
    // version of this assertion let the mutant survive. A watcher event goes via
    // `dashboard?.refresh()`, so it lands only if the slot still points at the
    // successor's provider.
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(rg *)', 'Bash(fd *)'], deny: [] },
    }, null, 2) + '\n');
    app.watcherFor('settings.json').fire('change', { fsPath: settingsPath });
    await tick(1200);

    assert.ok(posted.length > afterAttach,
      'the successor\u2019s dashboard slot was nulled by the old teardown, so every '
      + 'dashboard?.refresh() call site is a permanent no-op');

    // And Auto Learn is not stuck: the runner slot was freed, so a scan works.
    app.errors.length = 0;
    await app.commands.get('permission-wildcarding.autoLearnScan')();
    assert.ok(!app.errors.some((m) => /deactivating/.test(m)),
      'the successor did not inherit the dead worker runner');
  } finally {
    await app.dispose();
  }
});


test('a re-activate releases a busy latch that a wedged scan left set', TEST_TIMEOUT, async (t) => {
  // A regression introduced by the activationGeneration guard added earlier the
  // same day. That guard is right about the case it names — a predecessor's
  // continuation must not clear a latch the SUCCESSOR owns — but it left the
  // mirror image open.
  //
  // autoLearnBusy is released by runAutoLearnScan's `finally`, which never runs
  // if the worker promise never settles. deactivate()'s drain is
  // Promise.allSettled over those same jobs, so a wedged worker hangs the drain
  // too. A same-realm re-activate then bumps the generation, and the
  // predecessor's continuation is permanently forbidden from clearing the latch
  // it set. Every later scan short-circuits as "already running" and returns
  // null — Auto Learn dead for the life of the window, and since the periodic
  // timer says nothing, only a manual click ever surfaces it.
  //
  // An extension upgrade is a re-activate, so this is not exotic.
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true }, wedgeWorker: true });
  try {
    // Wedge a scan: the latch is set and the promise will never settle.
    const wedged = app.commands.get('permission-wildcarding.autoLearnScan')();
    await tick(200);
    assert.equal(app.workers.length, 1, 'precondition: a worker was built and never answered');

    // The drain cannot finish, so deactivate() is deliberately NOT awaited —
    // which is exactly the real situation: the host's deactivate timeout expires
    // and it activates again anyway.
    const teardown = app.extension.deactivate();
    app.reactivate();

    app.errors.length = 0;
    app.statuses.length = 0;
    // Fired, NOT awaited: this harness wedges EVERY worker, so the successor's
    // own scan will not settle either. What is under test is whether the
    // successor is ALLOWED to start one, which is observable immediately.
    const second = app.commands.get('permission-wildcarding.autoLearnScan')();
    await tick(200);

    assert.ok(!app.statuses.some((m) => /already running/i.test(m)),
      'the successor inherited a latch it can never clear, so every scan for the '
      + 'life of the window short-circuits as "already running"');
    // TWO stranded slots, asserted separately because they present as different
    // symptoms and fixing one alone leaves the other. Measured: with only the
    // busy-latch fix, this test failed here with "Auto Learn is deactivating".
    assert.ok(!app.errors.some((m) => /deactivating/i.test(m)),
      'the successor inherited the predecessor’s worker runner, whose '
      + '`deactivating` flag is sticky, so every Auto Learn operation fails');
    assert.ok(app.workers.length > 1, 'the successor actually started a scan of its own');

    // Let every wedged job settle so teardown completes rather than hanging.
    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
    await Promise.allSettled([wedged, teardown, second]);
  } finally {
    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
    await app.dispose();
  }
});


test('a wedged predecessor does not steal the successor\u2019s worker runner', TEST_TIMEOUT, async (t) => {
  // The other side of the re-activate fix, and a hazard that fix introduced.
  //
  // activate() now drops a stranded runner so a wedged drain cannot leave the
  // successor with a dead one. Correct and required — but it means the slot may
  // hold the SUCCESSOR's live runner by the time the predecessor's post-drain
  // continuation resumes. Unguarded, that continuation nulls it.
  //
  // Finding the right observable took two attempts. Termination is NOT it:
  // autoLearnWorkerRunner.deactivate() terminates only "completed workers that
  // failed to exit", so a worker that exits cleanly is never terminated by
  // design, and asserting on it fails against correct code.
  //
  // What actually breaks is that the successor can no longer DRAIN its own
  // runner: with the slot nulled, its deactivate() has nothing to await and
  // returns immediately, abandoning an in-flight worker instead of waiting for
  // it. So the observable is whether the successor's teardown still blocks on
  // its own wedged job.
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true }, wedgeWorker: true });
  try {
    const wedged = app.commands.get('permission-wildcarding.autoLearnScan')();
    await tick(200);
    const predecessorWorker = app.workers[0];

    const teardown = app.extension.deactivate();
    app.reactivate();

    const second = app.commands.get('permission-wildcarding.autoLearnScan')();
    await tick(200);
    assert.ok(app.workers.length > 1, 'precondition: the successor built its own worker');
    const successorWorker = app.workers[app.workers.length - 1];

    // The wedged job finally answers, so the predecessor's drain completes and
    // its continuation resumes — into a realm the successor now owns.
    predecessorWorker.release();
    await Promise.allSettled([wedged, teardown]);
    await tick(200);

    // The successor tears down while ITS worker is still wedged. That must
    // block on the drain; if its runner was stolen there is nothing to await.
    let settled = false;
    const successorTeardown = app.extension.deactivate().then(() => { settled = true; });
    await tick(400);

    assert.equal(settled, false,
      'the predecessor\u2019s post-drain continuation nulled the successor\u2019s live '
      + 'runner, so the successor\u2019s own teardown had nothing to await and '
      + 'abandoned an in-flight worker');

    successorWorker.release();
    await Promise.allSettled([second, successorTeardown]);
  } finally {
    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
    await app.dispose();
  }
});

// Cancel on the 32MB model download was a no-op on every real download, and the shape of
// httpsGetFollow is why. It followed redirects itself and returned the req it had just
// built, so the caller retained the FIRST hop's request. The comment above the function
// records that Hugging Face's /resolve/ URLs always 302 to a CDN host, so by the time the
// body is transferring that first request is finished and destroying it reaches nothing —
// the transfer ran to completion and the file was renamed into place anyway.
//
// These two tests split the fix along its two failure modes: a cancel DURING the body,
// and a cancel in the gap between a 3xx and the hop it triggers, where no request is live
// to destroy at all.
async function startModelDownload(t) {
  const home = tempHome(t);
  const corpus = memoryCorpus(t);
  fakeRecallEnvironment(t, { model: false });
  const app = harness(home, { memoryDir: corpus, warningChoice: 'Download' });
  const rebuild = app.commands.get('permission-wildcarding.rebuildRecall')();
  await tick(50);
  assert.equal(app.httpsRequests.length, 1,
    'precondition: the download started and issued its first request — a box that already '
    + 'holds bge-small takes the spawn path instead and this test would prove nothing');
  const run = app.progressRuns.at(-1);
  assert.equal(run.options.cancellable, true, 'precondition: the progress offers Cancel');
  assert.equal(run.cancels.length, 1, 'precondition: the task registered a cancel handler');
  return { app, home, rebuild, cancel: () => { for (const cb of run.cancels) cb(); } };
}

test('cancelling the model download destroys the request that is actually transferring', TEST_TIMEOUT, async (t) => {
  const { app, home, rebuild, cancel } = await startModelDownload(t);
  try {
    app.httpsRequests[0].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));
    assert.equal(app.httpsRequests.length, 2, 'the 302 was followed onto a second request');
    app.httpsRequests[1].respond(bodyResponse());

    cancel();

    assert.equal(app.httpsRequests[1].destroyed, true,
      'Cancel destroyed the first hop, which finished redirecting long ago, and left the '
      + 'request carrying the 32MB body running');
    assert.equal(app.httpsRequests[0].destroyed, false,
      'the finished first hop was destroyed instead of the live one');
    await rebuild;
    assert.ok(app.errors.some((m) => m.includes('cancelled')),
      'the cancellation was reported as a failed download, not swallowed');

    // The temp file is the whole point of downloading to `.tmp` and renaming on success,
    // and a cancelled download used to leave it behind forever. CI caught that as a
    // CLEANUP failure — rimraf could not remove the directory — rather than as a failed
    // assertion, because the test body had already passed.
    assert.ok(tmpUnlinkObserved, 'precondition: the cancelled download tried to unlink its .tmp');
    assert.equal(tmpUnlinkObserved.closedFirst, true,
      'the .tmp was unlinked while its write handle was still open. On Windows that is an '
      + 'EPERM the catch swallows, so the partial file survives every cancel; elsewhere it '
      + 'happens to succeed, which is why only one CI leg ever saw it');
    const leftovers = fs.readdirSync(path.join(home, '.claude', 'wildcarding', 'models'));
    assert.deepEqual(leftovers.filter((f) => f.endsWith('.tmp')), [],
      `a cancelled download left its partial file behind: ${leftovers.join(', ')}`);
  } finally {
    await app.dispose();
  }
});

test('a cancel between redirect hops stops the next hop instead of starting it', TEST_TIMEOUT, async (t) => {
  const { app, rebuild, cancel } = await startModelDownload(t);
  try {
    // The window the sticky flag exists for: the request is destroyed while its 302 is
    // already queued, so the follower is still about to recurse and there is no live
    // request for destroy() to have reached.
    cancel();
    app.httpsRequests[0].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));

    assert.equal(app.httpsRequests.length, 1,
      'a cancelled download followed its redirect anyway and opened a fresh connection '
      + 'that nothing was holding, so nothing could ever stop it');
    await rebuild;
  } finally {
    await app.dispose();
  }
});
